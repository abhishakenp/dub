// Self-hosted Tinybird-compatible API on ClickHouse.
//   POST /v0/events?name=<datasource>[&wait=true]   -> ingest (JSON or NDJSON)
//   GET  /v0/pipes/<pipe>.json?<params>              -> query, returns {meta,data,rows,statistics}
// Auth: Authorization: Bearer <TINYBIRD_TOKEN>
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { queryJSON, command, insertRows } from "./clickhouse.mjs";
import { PIPES } from "./pipes.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.PORT || "7181", 10);
const TOKEN = process.env.TINYBIRD_TOKEN || "dev_tinybird_token";

const INGEST_TABLES = new Set([
  "dub_click_events", "dub_lead_events", "dub_sale_events", "dub_links_metadata",
  "dub_webhook_events", "dub_postback_events", "dub_api_logs", "dub_audit_logs",
  "dub_import_error_logs", "dub_conversion_events_log",
]);

async function applySchema() {
  const sql = readFileSync(join(__dirname, "..", "schema.sql"), "utf8");
  const statements = sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.replace(/^\s*--.*$/gm, "").trim())
    .filter((s) => s.length > 0);
  for (const stmt of statements) await command(stmt);
  console.log(`[tinybird] schema applied (${statements.length} statements)`);
}

function bearerOk(req) {
  const h = req.headers["authorization"] || "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m && m[1].trim() === TOKEN;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function json(res, status, body) {
  const s = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(s) });
  res.end(s);
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === "/health" || url.pathname === "/") return json(res, 200, { ok: true, service: "tinybird-selfhost" });

    if (!bearerOk(req)) return json(res, 403, { error: "Unauthorized" });

    // ── ingest ──
    if (req.method === "POST" && url.pathname === "/v0/events") {
      const name = url.searchParams.get("name");
      if (!name || !INGEST_TABLES.has(name)) return json(res, 400, { error: `Unknown datasource: ${name}` });
      const raw = await readBody(req);
      let rows = [];
      const trimmed = raw.trim();
      if (trimmed.startsWith("[")) {
        rows = JSON.parse(trimmed);
      } else {
        rows = trimmed.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => JSON.parse(l));
      }
      const result = await insertRows(name, rows);
      return json(res, 200, result);
    }

    // ── pipe query ──
    const pipeMatch = url.pathname.match(/^\/v0\/pipes\/([a-zA-Z0-9_]+)\.json$/);
    if (req.method === "GET" && pipeMatch) {
      const name = pipeMatch[1];
      const builder = PIPES[name];
      if (!builder) return json(res, 404, { error: `Pipe not found: ${name}` });
      const sql = builder(url.searchParams);
      try {
        const result = await queryJSON(sql);
        return json(res, 200, result);
      } catch (e) {
        console.error(`[tinybird] pipe ${name} error:`, e.message, "\nSQL:", sql);
        return json(res, 500, { error: e.message });
      }
    }

    return json(res, 404, { error: "Not found" });
  } catch (e) {
    console.error("[tinybird] request error:", e.message);
    return json(res, 500, { error: e.message });
  }
});

applySchema()
  .then(() => server.listen(PORT, () => console.log(`[tinybird] listening on :${PORT} (token ${TOKEN.slice(0, 6)}…)`)))
  .catch((e) => { console.error("[tinybird] schema apply failed:", e.message); process.exit(1); });
