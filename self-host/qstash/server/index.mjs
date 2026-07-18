// Self-hosted QStash-compatible server: message queue + FIFO queues + cron
// scheduler + delivery worker, matching the @upstash/qstash Client REST API so
// the Dub app's lib/cron and @upstash/workflow serve() work unchanged.
//
//   POST /v2/publish/{destination}            -> enqueue single message
//   POST /v2/batch                            -> enqueue array of messages
//   POST /v2/enqueue/{queue}/{destination}    -> FIFO queue enqueue
//   POST /v2/queues                           -> upsert queue (parallelism)
//   DELETE /v2/messages/{id}                  -> cancel a pending message
//   POST /v2/schedules/{destination}          -> create cron schedule
//   DELETE /v2/schedules/{id}                 -> delete schedule
//
// Delivery: POST body to destination with a signed Upstash-Signature JWT +
// Upstash-Message-Id + forwarded headers; retries with backoff; callback /
// failureCallback delivery.
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { signQstashJwt } from "./jwt.mjs";

const PORT = parseInt(process.env.QSTASH_PORT || "8080", 10);
const TOKEN = process.env.QSTASH_TOKEN || "dev_qstash_token";
const SIGNING_KEY = process.env.QSTASH_CURRENT_SIGNING_KEY || "sig_dev_current";
const TICK_MS = 500;

const nowSec = () => Math.floor(Date.now() / 1000);

// ── in-memory state ──────────────────────────────────────────────────────────
const messages = new Map(); // id -> { id, url, body, method, headers, notBefore, retries, attempts, callback, failureCallback, queue, flowKey, status }
const queues = new Map(); // name -> { parallelism, active }
const schedules = new Map(); // id -> { id, url, cron, body, method, headers }
const dedup = new Set();

// ── helpers ──────────────────────────────────────────────────────────────────
function forwardedHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    const lk = k.toLowerCase();
    if (lk.startsWith("upstash-forward-")) out[k.slice("upstash-forward-".length)] = v;
  }
  return out;
}

function parseDelaySeconds(h) {
  const delay = h["upstash-delay"];
  const notBefore = h["upstash-not-before"];
  if (notBefore) return Math.max(0, parseInt(notBefore, 10) - nowSec());
  if (delay) {
    const m = String(delay).match(/^(\d+)\s*(s|m|h|d)?$/);
    if (m) {
      const n = parseInt(m[1], 10);
      const mult = { s: 1, m: 60, h: 3600, d: 86400 }[m[2] || "s"];
      return n * mult;
    }
  }
  return 0;
}

function enqueueMessage({ url, body, headers, queue, flowKey }) {
  const dedupId = headers["upstash-deduplication-id"] ||
    (headers["upstash-content-based-deduplication"] === "true" ? `${url}:${body}` : null);
  if (dedupId) {
    if (dedup.has(dedupId)) return { messageId: `dedup_${dedupId.slice(0, 24)}`, deduplicated: true };
    dedup.add(dedupId);
  }
  const id = `msg_${randomUUID().replace(/-/g, "")}`;
  const delaySec = parseDelaySeconds(headers);
  messages.set(id, {
    id, url, body,
    method: headers["upstash-method"] || "POST",
    headers: forwardedHeaders(headers),
    notBefore: nowSec() + delaySec,
    retries: headers["upstash-retries"] ? parseInt(headers["upstash-retries"], 10) : 3,
    attempts: 0,
    callback: headers["upstash-callback"] || null,
    failureCallback: headers["upstash-failure-callback"] || null,
    queue: queue || null,
    flowKey: flowKey || headers["upstash-flow-control-key"] || null,
    status: "pending",
  });
  return { messageId: id };
}

// ── delivery worker ──────────────────────────────────────────────────────────
const inflightFlowKeys = new Set();
const queueActive = new Map();

async function deliver(msg) {
  const bodyStr = typeof msg.body === "string" ? msg.body : JSON.stringify(msg.body ?? "");
  const sig = signQstashJwt({ url: msg.url, body: bodyStr, key: SIGNING_KEY, nowSec: nowSec() });
  const headers = {
    "Content-Type": "application/json",
    "Upstash-Signature": sig,
    "Upstash-Message-Id": msg.id,
    "upstash-region": "us-east-1",
    ...msg.headers,
  };
  let response;
  try {
    response = await fetch(msg.url, { method: msg.method, headers, body: msg.method === "GET" ? undefined : bodyStr });
  } catch (e) {
    return { ok: false, status: 0, body: String(e.message) };
  }
  const text = await response.text().catch(() => "");
  return { ok: response.ok, status: response.status, body: text };
}

async function deliverCallback(url, msg, result) {
  try {
    const payload = JSON.stringify({
      status: result.status,
      body: Buffer.from(result.body || "").toString("base64"),
      sourceMessageId: msg.id,
      url: msg.url,
    });
    const sig = signQstashJwt({ url, body: payload, key: SIGNING_KEY, nowSec: nowSec() });
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Upstash-Signature": sig, "Upstash-Message-Id": `cb_${msg.id}` },
      body: payload,
    });
  } catch { /* best effort */ }
}

async function processMessage(msg) {
  msg.status = "processing";
  msg.attempts += 1;
  const result = await deliver(msg);
  if (result.ok) {
    messages.delete(msg.id);
    if (msg.callback) await deliverCallback(msg.callback, msg, result);
    return;
  }
  if (msg.attempts > msg.retries) {
    messages.delete(msg.id);
    if (msg.failureCallback) await deliverCallback(msg.failureCallback, msg, result);
    else console.error(`[qstash] message ${msg.id} -> ${msg.url} failed permanently (status ${result.status})`);
    return;
  }
  // exponential backoff retry
  msg.status = "pending";
  msg.notBefore = nowSec() + Math.min(60, 2 ** msg.attempts);
}

async function tick() {
  const due = [...messages.values()].filter((m) => m.status === "pending" && m.notBefore <= nowSec());
  for (const msg of due) {
    // FIFO queue parallelism
    if (msg.queue) {
      const cfg = queues.get(msg.queue) || { parallelism: 1 };
      const active = queueActive.get(msg.queue) || 0;
      if (active >= cfg.parallelism) continue;
      queueActive.set(msg.queue, active + 1);
      msg.status = "processing";
      processMessage(msg).finally(() => queueActive.set(msg.queue, (queueActive.get(msg.queue) || 1) - 1));
      continue;
    }
    // flow-control key serialization (parallelism 1 per key)
    if (msg.flowKey) {
      if (inflightFlowKeys.has(msg.flowKey)) continue;
      inflightFlowKeys.add(msg.flowKey);
      msg.status = "processing";
      processMessage(msg).finally(() => inflightFlowKeys.delete(msg.flowKey));
      continue;
    }
    msg.status = "processing";
    processMessage(msg);
  }
}
setInterval(tick, TICK_MS);

// ── cron scheduler ───────────────────────────────────────────────────────────
function cronMatches(expr, d) {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const fields = [d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCDay()];
  return parts.every((p, i) => {
    if (p === "*") return true;
    const val = fields[i];
    for (const seg of p.split(",")) {
      if (seg.includes("/")) {
        const [range, stepS] = seg.split("/");
        const step = parseInt(stepS, 10);
        const [lo, hi] = range === "*" ? [i === 2 || i === 3 ? 1 : 0, [59, 23, 31, 12, 6][i]] : range.split("-").map(Number);
        for (let v = lo; v <= (hi ?? lo); v++) if (v % step === 0 && v === val) return true;
      } else if (seg.includes("-")) {
        const [lo, hi] = seg.split("-").map(Number);
        if (val >= lo && val <= hi) return true;
      } else if (parseInt(seg, 10) === val) return true;
    }
    return false;
  });
}

let lastCronMinute = -1;
setInterval(() => {
  const d = new Date();
  const minute = d.getUTCMinutes() + d.getUTCHours() * 60 + d.getUTCDate() * 1440;
  if (minute === lastCronMinute) return;
  lastCronMinute = minute;
  for (const s of schedules.values()) {
    if (cronMatches(s.cron, d)) {
      enqueueMessage({ url: s.url, body: s.body || "", headers: { "upstash-method": s.method || "POST", ...s.headers } });
    }
  }
}, 15000);

// ── HTTP API ─────────────────────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => resolve(d)); });
}
function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(s);
}
function lowerHeaders(h) { const o = {}; for (const [k, v] of Object.entries(h)) o[k.toLowerCase()] = v; return o; }

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  if (path === "/health" || path === "/") return json(res, 200, { ok: true, service: "qstash-selfhost", pending: messages.size, schedules: schedules.size });

  const auth = (req.headers["authorization"] || "").match(/^Bearer\s+(.+)$/i);
  if (!auth || auth[1].trim() !== TOKEN) return json(res, 401, { error: "Unauthorized" });
  const h = lowerHeaders(req.headers);
  const body = await readBody(req);

  // publish: /v2/publish/{destination...}
  if (req.method === "POST" && path.startsWith("/v2/publish/")) {
    const destination = decodeURIComponent(path.slice("/v2/publish/".length));
    return json(res, 200, enqueueMessage({ url: destination, body, headers: h }));
  }
  // batch
  if (req.method === "POST" && path === "/v2/batch") {
    let items = [];
    try { items = JSON.parse(body); } catch { return json(res, 400, { error: "invalid batch body" }); }
    const out = items.map((it) => {
      const dh = { ...h };
      for (const [k, v] of Object.entries(it.headers || {})) dh[k.toLowerCase()] = v;
      if (it.delay) dh["upstash-delay"] = String(it.delay);
      if (it.notBefore) dh["upstash-not-before"] = String(it.notBefore);
      if (it.method) dh["upstash-method"] = it.method;
      if (it.callback) dh["upstash-callback"] = it.callback;
      if (it.failureCallback) dh["upstash-failure-callback"] = it.failureCallback;
      if (it.deduplicationId) dh["upstash-deduplication-id"] = it.deduplicationId;
      const b = typeof it.body === "string" ? it.body : JSON.stringify(it.body ?? "");
      return enqueueMessage({ url: it.destination || it.url, body: b, headers: dh, queue: it.queue, flowKey: it.flowControl?.key });
    });
    return json(res, 200, out);
  }
  // enqueue: /v2/enqueue/{queue}/{destination...}
  if (req.method === "POST" && path.startsWith("/v2/enqueue/")) {
    const rest = path.slice("/v2/enqueue/".length);
    const slash = rest.indexOf("/");
    const queue = decodeURIComponent(rest.slice(0, slash));
    const destination = decodeURIComponent(rest.slice(slash + 1));
    if (!queues.has(queue)) queues.set(queue, { parallelism: 1 });
    return json(res, 200, enqueueMessage({ url: destination, body, headers: h, queue }));
  }
  // upsert queue
  if (req.method === "POST" && path === "/v2/queues") {
    let cfg = {};
    try { cfg = JSON.parse(body); } catch { /* */ }
    if (cfg.queueName) queues.set(cfg.queueName, { parallelism: cfg.parallelism || 1 });
    return json(res, 200, { ok: true });
  }
  // delete message (cancel)
  if (req.method === "DELETE" && path.startsWith("/v2/messages/")) {
    const id = decodeURIComponent(path.slice("/v2/messages/".length));
    messages.delete(id);
    return json(res, 200, { ok: true });
  }
  // create schedule: /v2/schedules/{destination}
  if (req.method === "POST" && path.startsWith("/v2/schedules/")) {
    const destination = decodeURIComponent(path.slice("/v2/schedules/".length));
    const id = h["upstash-schedule-id"] || `scd_${randomUUID().replace(/-/g, "")}`;
    schedules.set(id, {
      id, url: destination, cron: h["upstash-cron"], body,
      method: h["upstash-method"] || "POST", headers: forwardedHeaders(h),
    });
    return json(res, 200, { scheduleId: id });
  }
  if (req.method === "DELETE" && path.startsWith("/v2/schedules/")) {
    const id = decodeURIComponent(path.slice("/v2/schedules/".length));
    schedules.delete(id);
    return json(res, 200, { ok: true });
  }
  // queues pause/resume/get, flowControl, dlq — acknowledge as no-ops
  if (path.startsWith("/v2/queues/") || path.startsWith("/v2/flowControl/") || path.startsWith("/v2/dlq")) {
    return json(res, 200, {});
  }
  return json(res, 404, { error: `Not found: ${req.method} ${path}` });
});

server.listen(PORT, () => console.log(`[qstash] listening on :${PORT} (token ${TOKEN.slice(0, 6)}…)`));
