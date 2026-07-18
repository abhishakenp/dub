// Minimal ClickHouse HTTP client (no deps) for the self-hosted Tinybird server.

const CH_URL = process.env.CLICKHOUSE_URL || "http://localhost:8123";
const CH_USER = process.env.CLICKHOUSE_USER || "dub";
const CH_PASSWORD = process.env.CLICKHOUSE_PASSWORD || "dub";
const CH_DB = process.env.CLICKHOUSE_DB || "dub";

function authQs(extra = {}) {
  const p = new URLSearchParams({
    user: CH_USER,
    password: CH_PASSWORD,
    database: CH_DB,
    ...extra,
  });
  return p.toString();
}

// Run a read query and return ClickHouse's native JSON envelope
// ({ meta, data, rows, rows_before_limit_at_least, statistics }).
export async function queryJSON(sql, settings = {}) {
  const res = await fetch(`${CH_URL}/?${authQs(settings)}`, {
    method: "POST",
    body: sql,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`ClickHouse query error (${res.status}): ${text}`);
    err.status = res.status;
    throw err;
  }
  return JSON.parse(text);
}

// Execute a statement with no JSON parsing (DDL / INSERT ... VALUES).
export async function command(sql, settings = {}) {
  const res = await fetch(`${CH_URL}/?${authQs(settings)}`, {
    method: "POST",
    body: sql,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`ClickHouse command error (${res.status}): ${text}`);
    err.status = res.status;
    throw err;
  }
  return text;
}

// Insert rows (array of objects) into a table using JSONEachRow. ClickHouse's
// HTTP interface is synchronous, so inserts are durable on 200 regardless of
// the caller's wait flag.
export async function insertRows(table, rows) {
  const ndjson = rows.map((r) => JSON.stringify(r)).join("\n");
  const settings = {
    query: `INSERT INTO ${CH_DB}.${table} FORMAT JSONEachRow`,
    input_format_skip_unknown_fields: "1",
    input_format_null_as_default: "1",
    date_time_input_format: "best_effort",
  };
  // wait=false still inserts synchronously over HTTP; ClickHouse has no async
  // ack semantics here, so both paths are durable on 200.
  const res = await fetch(`${CH_URL}/?${authQs(settings)}`, {
    method: "POST",
    body: ndjson,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`ClickHouse insert error (${res.status}): ${text}`);
    err.status = res.status;
    throw err;
  }
  return { successful_rows: rows.length, quarantined_rows: 0 };
}

// SQL string literal escaping for safe interpolation of param values.
export function q(value) {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return value ? "1" : "0";
  return `'${String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

// Build a ClickHouse array literal from a JS array of strings.
export function arrayLiteral(values) {
  return `[${values.map((v) => q(v)).join(", ")}]`;
}

export { CH_DB };
