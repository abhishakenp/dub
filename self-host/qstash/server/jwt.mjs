// QStash-compatible signature signing (what @upstash/qstash Receiver.verify expects):
// a JWT (HS256) with issuer "Upstash", sub = destination URL, and body = base64url
// sha256 of the request body. Signed with the current signing key.
import { createHmac, createHash } from "node:crypto";

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function bodyHash(body) {
  return b64url(createHash("sha256").update(body || "").digest());
}

// nowSec is passed in (no Date.now() ambient dependence in callers that need determinism)
export function signQstashJwt({ url, body, key, nowSec, ttlSec = 300 }) {
  const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const claims = {
    iss: "Upstash",
    sub: url,
    iat: nowSec,
    nbf: nowSec,
    exp: nowSec + ttlSec,
    jti: `${nowSec}-${Math.floor(nowSec % 100000)}`,
    body: bodyHash(body),
  };
  const payload = b64url(JSON.stringify(claims));
  const data = `${header}.${payload}`;
  const sig = b64url(createHmac("sha256", key).update(data).digest());
  return `${data}.${sig}`;
}
