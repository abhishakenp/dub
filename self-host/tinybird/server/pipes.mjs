// Endpoint pipe implementations — each translates Dub's Tinybird pipe into a
// parameterized ClickHouse query. Params come from the request query string
// (URLSearchParams). Arrays arrive comma-joined (zod-bird serialization).

import { q, arrayLiteral } from "./clickhouse.mjs";

// ── param helpers ────────────────────────────────────────────────────────────
const P = (params) => ({
  has: (k) => params.get(k) !== null && params.get(k) !== "",
  str: (k, d = undefined) => (params.get(k) ?? d),
  int: (k, d = 0) => {
    const v = params.get(k);
    return v === null || v === "" ? d : parseInt(v, 10);
  },
  bool: (k) => params.get(k) === "true" || params.get(k) === "1",
  arr: (k) => {
    const v = params.get(k);
    if (v === null || v === "") return [];
    return v.split(",").map((s) => s.trim()).filter(Boolean);
  },
});

const opIn = (params, opKey) =>
  (params.get(opKey) || "IN").toUpperCase() === "NOT IN" ? "NOT IN" : "IN";

// ── workspace_links CTE ──────────────────────────────────────────────────────
// SELECT link_id FROM dub_links_metadata_latest FINAL WHERE workspace_id=... AND deleted==0 + *Id filters
function workspaceLinksSql(params) {
  const p = P(params);
  const conds = [
    `workspace_id = ${q(p.str("workspaceId"))}`,
    `deleted = 0`,
  ];
  if (p.has("programId")) conds.push(`program_id = ${q(p.str("programId"))}`);
  for (const [key, col, opKey] of [
    ["partnerId", "partner_id", "partnerIdOperator"],
    ["tenantId", "tenant_id", "tenantIdOperator"],
    ["domain", "domain", "domainOperator"],
    ["folderId", "folder_id", "folderIdOperator"],
    ["groupId", "partner_group_id", "groupIdOperator"],
  ]) {
    if (p.has(key)) conds.push(`${col} ${opIn(params, opKey)} ${arrayLiteral(p.arr(key))}`);
  }
  if (p.has("tagId")) {
    const op = opIn(params, "tagIdOperator");
    conds.push(op === "IN"
      ? `arrayIntersect(tag_ids, ${arrayLiteral(p.arr("tagId"))}) != []`
      : `arrayIntersect(tag_ids, ${arrayLiteral(p.arr("tagId"))}) = []`);
  }
  if (p.has("partnerTagId")) {
    const op = opIn(params, "partnerTagIdOperator");
    conds.push(op === "IN"
      ? `arrayIntersect(partner_tag_ids, ${arrayLiteral(p.arr("partnerTagId"))}) != []`
      : `arrayIntersect(partner_tag_ids, ${arrayLiteral(p.arr("partnerTagId"))}) = []`);
  }
  if (p.has("root")) conds.push(p.bool("root") ? `key = '_root'` : `key != '_root'`);
  return `SELECT link_id FROM dub_links_metadata_latest FINAL WHERE ${conds.join(" AND ")}`;
}

// ── canonical filter block (scalar equals + filters JSON loop) ───────────────
const UTM_FIELDS = {
  utm_source: "utm_source", utm_medium: "utm_medium", utm_campaign: "utm_campaign",
  utm_term: "utm_term", utm_content: "utm_content",
};
const SCALAR_FIELDS = ["continent", "country", "region", "city", "device", "browser", "os", "trigger", "referer"];

function filterConditions(params, { scopeByWorkspaceLinks = true } = {}) {
  const p = P(params);
  const conds = [];
  if (scopeByWorkspaceLinks) {
    // link scoping: explicit linkId, else via workspace_links subquery when any link filter is set
    if (p.has("linkId")) {
      conds.push(`link_id ${opIn(params, "linkIdOperator")} ${arrayLiteral(p.arr("linkId"))}`);
    } else if (["programId", "partnerId", "groupId", "tenantId", "folderId", "domain", "tagId", "partnerTagId", "root"].some((k) => p.has(k))) {
      conds.push(`link_id IN (${workspaceLinksSql(params)})`);
    }
  }
  if (p.has("customerId")) conds.push(`customer_id = ${q(p.str("customerId"))}`);
  for (const f of SCALAR_FIELDS) if (p.has(f)) conds.push(`${f} = ${q(p.str(f))}`);
  if (p.has("refererUrl")) conds.push(`splitByString('?', referer_url)[1] = ${q(p.str("refererUrl"))}`);
  if (p.has("url")) conds.push(`splitByString('?', url)[1] = ${q(p.str("url"))}`);
  for (const [key, utm] of Object.entries(UTM_FIELDS)) {
    if (p.has(key)) conds.push(`url LIKE ${q(`%${utm}=${encodeURIComponent(p.str(key))}%`)}`);
  }
  if (p.has("start")) conds.push(`timestamp >= ${q(p.str("start"))}`);
  if (p.has("end")) conds.push(`timestamp <= ${q(p.str("end"))}`);

  // filters JSON loop
  const rawFilters = params.get("filters");
  if (rawFilters) {
    let parsed = [];
    try { parsed = JSON.parse(rawFilters); } catch { parsed = []; }
    for (const item of parsed) {
      if (item.operand && String(item.operand).startsWith("metadata.")) {
        const key = String(item.operand).split(".").slice(1).join(".");
        const extract = `JSONExtractString(metadata, ${q(key)})`;
        const opMap = { equals: "=", notEquals: "!=" };
        if (opMap[item.operator]) {
          conds.push(`${extract} ${opMap[item.operator]} ${q(item.value)}`);
        } else {
          const numOp = { greaterThan: ">", lessThan: "<", greaterThanOrEqual: ">=", lessThanOrEqual: "<=" }[item.operator];
          if (numOp) conds.push(`toFloat64OrNull(${extract}) ${numOp} toFloat64OrNull(${q(String(item.value))})`);
        }
      } else if (item.field) {
        const vals = Array.isArray(item.values) ? item.values : [];
        const op = (item.operator || "IN").toUpperCase() === "NOT IN" ? "NOT IN" : "IN";
        if (UTM_FIELDS[item.field]) {
          const likes = vals.map((v) => `url LIKE ${q(`%${UTM_FIELDS[item.field]}=${encodeURIComponent(v)}%`)}`);
          const chain = likes.length ? `(${likes.join(" OR ")})` : "(0)";
          conds.push(op === "IN" ? chain : `NOT ${chain}`);
        } else if (["domain", "tagId", "folderId"].includes(item.field)) {
          // scoped at workspace_links already in v4_events / group_by_link_metadata; apply as link subquery otherwise
          const col = item.field === "tagId" ? "tag_ids" : item.field === "folderId" ? "folder_id" : "domain";
          if (item.field === "tagId") {
            conds.push(`link_id IN (SELECT link_id FROM dub_links_metadata_latest FINAL WHERE arrayIntersect(tag_ids, ${arrayLiteral(vals)}) ${op === "IN" ? "!=" : "="} [])`);
          } else {
            conds.push(`link_id IN (SELECT link_id FROM dub_links_metadata_latest FINAL WHERE ${col} ${op} ${arrayLiteral(vals)})`);
          }
        } else if (item.field === "refererUrl") {
          conds.push(`splitByString('?', referer_url)[1] ${op} ${arrayLiteral(vals)}`);
        } else if (item.field === "url") {
          conds.push(`splitByString('?', url)[1] ${op} ${arrayLiteral(vals)}`);
        } else {
          conds.push(`${item.field} ${op} ${arrayLiteral(vals)}`);
        }
      }
    }
  }
  return conds.length ? conds.join(" AND ") : "1";
}

// first_sale classification join fragment
function firstSaleCte(params) {
  const p = P(params);
  return `first_sale_by_link_customer AS (
    SELECT workspace_id, link_id, customer_id, minMerge(first_sale_state) AS first_sale_ts
    FROM dub_first_sale_mv WHERE workspace_id = ${q(p.str("workspaceId"))}
    GROUP BY workspace_id, link_id, customer_id)`;
}

const saleTypeExpr = `if(isNull(fs.first_sale_ts), 'new', if(toUnixTimestamp64Milli(se.timestamp) = toUnixTimestamp64Milli(fs.first_sale_ts), 'new', 'recurring'))`;

function saleTypeFilter(params) {
  const p = P(params);
  if (!p.has("saleType")) return "";
  return ` AND sale_type = ${q(p.str("saleType"))}`;
}

// ── v4_events ────────────────────────────────────────────────────────────────
function v4_events(params) {
  const p = P(params);
  const eventType = p.str("eventType", "clicks");
  const order = (p.str("order", "desc") || "desc").toUpperCase() === "ASC" ? "ASC" : "DESC";
  const limit = p.int("limit", 100);
  const offset = p.int("offset", 0);
  const flt = filterConditions(params);

  if (eventType === "leads") {
    return `SELECT *, splitByString('?', referer_url)[1] AS referer_url_processed, CONCAT(country,'-',region) AS region_processed, 'lead' AS event
      FROM dub_lead_events_mv WHERE ${flt} ORDER BY timestamp ${order} LIMIT ${limit} OFFSET ${offset} FORMAT JSON`;
  }
  if (eventType === "sales") {
    return `WITH ${firstSaleCte(params)}
      SELECT se.*, splitByString('?', se.referer_url)[1] AS referer_url_processed, CONCAT(se.country,'-',se.region) AS region_processed,
        se.amount AS saleAmount, ${saleTypeExpr} AS sale_type, 'sale' AS event
      FROM dub_sale_events_mv se LEFT JOIN first_sale_by_link_customer fs USING (workspace_id, link_id, customer_id)
      WHERE ${flt.replace(/\bcustomer_id\b/g, "se.customer_id").replace(/\blink_id\b/g, "se.link_id").replace(/\btimestamp\b/g, "se.timestamp")}${saleTypeFilter(params)}
      ORDER BY se.timestamp ${order} LIMIT ${limit} OFFSET ${offset} FORMAT JSON`;
  }
  const table = p.has("customerId") ? "dub_click_events_id" : "dub_click_events_mv";
  const pre = p.has("customerId")
    ? `PREWHERE click_id IN (SELECT DISTINCT click_id FROM dub_lead_events_mv WHERE customer_id = ${q(p.str("customerId"))}) `
    : "";
  return `SELECT *, splitByString('?', referer_url)[1] AS referer_url_processed, CONCAT(country,'-',region) AS region_processed, 'click' AS event
    FROM ${table} ${pre}WHERE ${filterConditions(params).replace(/\bAND customer_id = [^ ]+/g, "")} ORDER BY timestamp ${order} LIMIT ${limit} OFFSET ${offset} FORMAT JSON`;
}

// ── v4_count ─────────────────────────────────────────────────────────────────
function v4_count(params) {
  const p = P(params);
  const eventType = p.str("eventType", "composite");
  const flt = filterConditions(params);
  const clicks = `(SELECT COUNT(*) AS clicks FROM dub_click_events_mv WHERE ${flt})`;
  const leads = `(SELECT COUNT(*) AS leads FROM dub_lead_events_mv WHERE ${flt})`;
  const salesInner = `SELECT se.amount AS amount FROM dub_sale_events_mv se LEFT JOIN first_sale_by_link_customer fs USING (workspace_id, link_id, customer_id) WHERE ${flt.replace(/\bcustomer_id\b/g,"se.customer_id").replace(/\blink_id\b/g,"se.link_id").replace(/\btimestamp\b/g,"se.timestamp")}`;
  const sales = `(SELECT COUNT(*) AS sales, SUM(amount) AS amount FROM (${salesInner}))`;
  if (eventType === "clicks") return `SELECT 'count' AS groupByField, ${clicks} AS clicks FORMAT JSON`;
  if (eventType === "leads") return `SELECT 'count' AS groupByField, ${leads} AS leads FORMAT JSON`;
  if (eventType === "sales") return `WITH ${firstSaleCte(params)} SELECT 'count' AS groupByField, s.sales AS sales, s.amount AS saleAmount FROM ${sales} s FORMAT JSON`;
  return `WITH ${firstSaleCte(params)}
    SELECT 'count' AS groupByField, ${clicks} AS clicks, ${leads} AS leads, s.sales AS sales, s.amount AS saleAmount
    FROM ${sales} s FORMAT JSON`;
}

// ── v4_timeseries ────────────────────────────────────────────────────────────
const startOfGranularity = (g, tz) => {
  const m = { minute: "toStartOfMinute", hour: "toStartOfHour", day: "toStartOfDay", month: "toStartOfMonth" };
  const fn = m[g] || "toStartOfDay";
  return (col) => (g === "month" || g === "day" || g === "hour" || g === "minute")
    ? `${fn}(${col}${g === "day" || g === "month" || g === "hour" ? `, ${q(tz)}` : ""})`
    : `${fn}(${col})`;
};

function v4_timeseries(params) {
  const p = P(params);
  const eventType = p.str("eventType", "composite");
  const g = p.str("granularity", "day");
  const tz = p.str("timezone", "UTC");
  const bucket = startOfGranularity(g, tz);
  const flt = filterConditions(params);
  const fmt = `formatDateTime(interval, '%FT%T.000%z')`;
  const mk = (table, agg, alias) =>
    `SELECT ${bucket("timestamp")} AS interval, ${agg} AS ${alias} FROM ${table} WHERE ${flt} GROUP BY interval`;
  const clicks = mk("dub_click_events_mv", "uniq(click_id)", "clicks");
  const leads = mk("dub_lead_events_mv", "COUNT(*)", "leads");
  const salesInner = `SELECT ${bucket("se.timestamp")} AS interval, se.amount AS amount FROM dub_sale_events_mv se LEFT JOIN first_sale_by_link_customer fs USING (workspace_id, link_id, customer_id) WHERE ${flt.replace(/\bcustomer_id\b/g,"se.customer_id").replace(/\blink_id\b/g,"se.link_id").replace(/\btimestamp\b/g,"se.timestamp")}`;
  const sales = `SELECT interval, COUNT(*) AS sales, SUM(amount) AS amount FROM (${salesInner}) GROUP BY interval`;
  if (eventType === "clicks") return `SELECT ${fmt} AS groupByField, clicks FROM (${clicks}) ORDER BY interval FORMAT JSON`;
  if (eventType === "leads") return `SELECT ${fmt} AS groupByField, leads FROM (${leads}) ORDER BY interval FORMAT JSON`;
  if (eventType === "sales") return `WITH ${firstSaleCte(params)} SELECT ${fmt} AS groupByField, sales, amount AS saleAmount FROM (${sales}) ORDER BY interval FORMAT JSON`;
  return `WITH ${firstSaleCte(params)}
    SELECT ${fmt} AS groupByField, c.clicks AS clicks, l.leads AS leads, s.sales AS sales, s.amount AS saleAmount
    FROM (${clicks}) c
    LEFT JOIN (${leads}) l USING (interval)
    LEFT JOIN (${sales}) s USING (interval)
    ORDER BY interval FORMAT JSON`;
}

// ── v4_group_by ──────────────────────────────────────────────────────────────
const GROUP_BY_EXPR = {
  top_links: "link_id", top_urls: "url", top_base_urls: "splitByString('?', url)[1]",
  referers: "referer", referer_urls: "splitByString('?', referer_url)[1]",
  utm_sources: "decodeURLFormComponent(extractURLParameter(url, 'utm_source'))",
  utm_mediums: "decodeURLFormComponent(extractURLParameter(url, 'utm_medium'))",
  utm_campaigns: "decodeURLFormComponent(extractURLParameter(url, 'utm_campaign'))",
  utm_terms: "decodeURLFormComponent(extractURLParameter(url, 'utm_term'))",
  utm_contents: "decodeURLFormComponent(extractURLParameter(url, 'utm_content'))",
  countries: "country", regions: "CONCAT(country,'-',region)", cities: "city",
  continents: "continent", devices: "device", browsers: "browser", oses: "os", os: "os",
  triggers: "trigger",
};

function v4_group_by(params) {
  const p = P(params);
  const eventType = p.str("eventType", "composite");
  const groupBy = p.str("groupBy", "top_links");
  const expr = GROUP_BY_EXPR[groupBy] || "link_id";
  const flt = filterConditions(params);
  const guard = `groupByField != '' AND groupByField != 'Unknown'`;
  const clicks = `SELECT ${expr} AS groupByField, COUNT(*) AS clicks FROM dub_click_events_mv WHERE ${flt} GROUP BY groupByField HAVING ${guard} ORDER BY clicks DESC LIMIT 5000`;
  const leads = `SELECT ${expr} AS groupByField, COUNT(*) AS leads FROM dub_lead_events_mv WHERE ${flt} GROUP BY groupByField HAVING ${guard} ORDER BY leads DESC LIMIT 5000`;
  const salesInner = `SELECT ${expr.replace(/\b(country|region|city|url|referer|referer_url|continent|device|browser|os|trigger|link_id)\b/g,"se.$1")} AS groupByField, se.amount AS amount FROM dub_sale_events_mv se LEFT JOIN first_sale_by_link_customer fs USING (workspace_id, link_id, customer_id) WHERE ${flt.replace(/\bcustomer_id\b/g,"se.customer_id").replace(/\blink_id\b/g,"se.link_id").replace(/\btimestamp\b/g,"se.timestamp")}`;
  const sales = `SELECT groupByField, COUNT(*) AS sales, SUM(amount) AS saleAmount FROM (${salesInner}) GROUP BY groupByField HAVING ${guard} ORDER BY saleAmount DESC LIMIT 5000`;
  if (eventType === "clicks") return `${clicks} FORMAT JSON`;
  if (eventType === "leads") return `${leads} FORMAT JSON`;
  if (eventType === "sales") return `WITH ${firstSaleCte(params)} ${sales} FORMAT JSON`;
  return `WITH ${firstSaleCte(params)}
    SELECT groupByField, COALESCE(c.clicks,0) AS clicks, COALESCE(l.leads,0) AS leads, COALESCE(s.sales,0) AS sales, COALESCE(s.saleAmount,0) AS saleAmount
    FROM (${clicks}) c
    FULL OUTER JOIN (${leads}) l USING (groupByField)
    FULL OUTER JOIN (${sales}) s USING (groupByField)
    WHERE groupByField != '' AND groupByField != 'Unknown'
    ORDER BY clicks DESC LIMIT 5000 FORMAT JSON`;
}

// ── v4_group_by_link_metadata ────────────────────────────────────────────────
const LINK_META_GROUP = {
  top_link_tags: "tag_ids", top_partner_tags: "partner_tag_ids",
  top_folders: "array(folder_id)", top_domains: "array(domain)",
  top_partners: "array(partner_id)", top_groups: "array(partner_group_id)",
};

function v4_group_by_link_metadata(params) {
  const p = P(params);
  const eventType = p.str("eventType", "composite");
  const groupBy = p.str("groupBy", "top_partners");
  const arrExpr = LINK_META_GROUP[groupBy] || "array(partner_id)";
  const wlConds = [`workspace_id = ${q(p.str("workspaceId"))}`, `deleted = 0`];
  if (p.has("programId")) wlConds.push(`program_id = ${q(p.str("programId"))}`);
  const wl = `SELECT link_id, arrayJoin(${arrExpr}) AS groupByField FROM dub_links_metadata_latest FINAL WHERE ${wlConds.join(" AND ")}`;
  const join = (table, agg, alias) =>
    `SELECT wl.groupByField AS groupByField, ${agg} AS ${alias} FROM ${table} ev INNER JOIN (${wl}) wl ON ev.link_id = wl.link_id GROUP BY wl.groupByField HAVING groupByField != ''`;
  const clicks = join("dub_click_events_mv", "COUNT(*)", "clicks");
  const leads = join("dub_lead_events_mv", "COUNT(*)", "leads");
  const sales = `SELECT wl.groupByField AS groupByField, COUNT(*) AS sales, SUM(ev.amount) AS saleAmount FROM dub_sale_events_mv ev INNER JOIN (${wl}) wl ON ev.link_id = wl.link_id GROUP BY wl.groupByField HAVING groupByField != ''`;
  if (eventType === "clicks") return `${clicks} FORMAT JSON`;
  if (eventType === "leads") return `${leads} FORMAT JSON`;
  if (eventType === "sales") return `${sales} FORMAT JSON`;
  return `SELECT groupByField, COALESCE(c.clicks,0) AS clicks, COALESCE(l.leads,0) AS leads, COALESCE(s.sales,0) AS sales, COALESCE(s.saleAmount,0) AS saleAmount
    FROM (${clicks}) c FULL OUTER JOIN (${leads}) l USING (groupByField) FULL OUTER JOIN (${sales}) s USING (groupByField)
    WHERE groupByField != '' ORDER BY clicks DESC LIMIT 5000 FORMAT JSON`;
}

// ── simple single-node endpoint pipes ────────────────────────────────────────
function get_click_event(params) {
  const p = P(params);
  return `SELECT * FROM dub_click_events_id WHERE click_id = ${q(p.str("clickId"))} ORDER BY timestamp DESC LIMIT 1 FORMAT JSON`;
}
function get_lead_event(params) {
  const p = P(params);
  let sql = `SELECT * FROM dub_lead_events_mv WHERE customer_id = ${q(p.str("customerId"))}`;
  if (p.has("eventName")) sql += ` AND event_name = ${q(p.str("eventName"))}`;
  return sql + ` ORDER BY timestamp DESC FORMAT JSON`;
}
function get_lead_events(params) {
  const p = P(params);
  let sql = `SELECT * FROM dub_lead_events_mv WHERE true`;
  if (p.has("customerIds")) sql += ` AND customer_id IN ${arrayLiteral(p.arr("customerIds"))}`;
  return sql + ` ORDER BY timestamp DESC FORMAT JSON`;
}
function get_webhook_events(params) {
  const p = P(params);
  return `SELECT * FROM dub_webhook_events WHERE webhook_id = ${q(p.str("webhookId"))} ORDER BY timestamp DESC LIMIT 100 FORMAT JSON`;
}
function get_postback_events(params) {
  const p = P(params);
  return `SELECT event_id, timestamp, url, event, response_status, request_body, response_body, retry_attempt FROM dub_postback_events WHERE postback_id = ${q(p.str("postbackId"))} ORDER BY timestamp DESC LIMIT 100 FORMAT JSON`;
}
function get_import_error_logs(params) {
  const p = P(params);
  return `SELECT * FROM dub_import_error_logs WHERE workspace_id = ${q(p.str("workspaceId"))} AND import_id = ${q(p.str("importId"))} ORDER BY timestamp DESC LIMIT 5000 FORMAT JSON`;
}
const API_LOG_COLS = "id,timestamp,method,path,route_pattern,status_code,duration,user_agent,request_body,response_body,token_id,user_id,request_type";
function get_api_log_by_id(params) {
  const p = P(params);
  return `SELECT ${API_LOG_COLS} FROM dub_api_logs_id WHERE id = ${q(p.str("id"))} AND workspace_id = ${q(p.str("workspaceId"))} LIMIT 1 FORMAT JSON`;
}
function get_api_logs(params) {
  const p = P(params);
  const conds = [`workspace_id = ${q(p.str("workspaceId"))}`];
  if (p.has("start")) conds.push(`timestamp >= ${q(p.str("start"))}`);
  if (p.has("end")) conds.push(`timestamp <= ${q(p.str("end"))}`);
  if (p.has("routePattern")) conds.push(`route_pattern = ${q(p.str("routePattern"))}`);
  if (p.has("method")) conds.push(`method = ${q(p.str("method"))}`);
  if (p.has("statusCode")) conds.push(`status_code = ${p.int("statusCode")}`);
  if (p.has("tokenId")) conds.push(`token_id = ${q(p.str("tokenId"))}`);
  if (p.has("requestId")) conds.push(`id = ${q(p.str("requestId"))}`);
  if (p.has("requestType")) conds.push(`request_type = ${q(p.str("requestType"))}`);
  return `SELECT ${API_LOG_COLS} FROM dub_api_logs WHERE ${conds.join(" AND ")} ORDER BY timestamp DESC LIMIT ${p.int("limit", 100)} OFFSET ${p.int("offset", 0)} FORMAT JSON`;
}
function get_api_logs_count(params) {
  const p = P(params);
  const conds = [`workspace_id = ${q(p.str("workspaceId"))}`];
  if (p.has("start")) conds.push(`timestamp >= ${q(p.str("start"))}`);
  if (p.has("end")) conds.push(`timestamp <= ${q(p.str("end"))}`);
  if (p.has("method")) conds.push(`method = ${q(p.str("method"))}`);
  if (p.has("statusCode")) conds.push(`status_code = ${p.int("statusCode")}`);
  const where = conds.join(" AND ");
  if (p.str("groupBy") === "routePattern") {
    return `SELECT route_pattern AS routePattern, count() AS count FROM dub_api_logs WHERE ${where} AND route_pattern != '' GROUP BY route_pattern ORDER BY count DESC LIMIT 100 FORMAT JSON`;
  }
  return `SELECT count() AS count FROM dub_api_logs WHERE ${where} FORMAT JSON`;
}
function get_audit_logs(params) {
  const p = P(params);
  const conds = ["true"];
  if (p.has("start") && p.has("end")) { conds.push(`timestamp >= ${q(p.str("start"))}`); conds.push(`timestamp < ${q(p.str("end"))}`); }
  if (p.has("workspaceId")) conds.push(`workspace_id = ${q(p.str("workspaceId"))}`);
  if (p.has("programId")) conds.push(`program_id = ${q(p.str("programId"))}`);
  return `SELECT id,timestamp,action,actor_id,actor_type,actor_name,targets,description,ip_address,user_agent,metadata FROM dub_audit_logs WHERE ${conds.join(" AND ")} ORDER BY timestamp DESC FORMAT JSON`;
}
function v3_group_by_link_country(params) {
  const p = P(params);
  return `SELECT link_id, country, COUNT(*) AS clicks FROM dub_click_events_mv WHERE link_id IN ${arrayLiteral(p.arr("linkIds"))} AND timestamp >= ${q(p.str("start"))} AND timestamp <= ${q(p.str("end"))} GROUP BY link_id, country ORDER BY link_id ASC, clicks DESC FORMAT JSON`;
}
function v2_customer_events(params) {
  const p = P(params);
  const cid = q(p.str("customerId"));
  const linkFilter = p.has("linkIds") ? ` AND link_id IN ${arrayLiteral(p.arr("linkIds"))}` : "";
  return `
    WITH lead_events AS (
      SELECT timestamp, event_id, event_name, link_id, click_id, customer_id, url, country, region, device, browser, os, referer, referer_url, metadata,
        splitByString('?', referer_url)[1] AS referer_url_processed, CONCAT(country,'-',region) AS region_processed, 'lead' AS event
      FROM dub_lead_events_mv WHERE customer_id = ${cid}${linkFilter})
    SELECT timestamp, event_id, event_name, event, link_id, click_id, customer_id, url, country, region, device, browser, os, referer, referer_url, metadata, region_processed, referer_url_processed,
      CAST(NULL AS Nullable(UInt32)) AS saleAmount, '' AS invoice_id, '' AS payment_processor FROM lead_events
    UNION ALL
    SELECT timestamp, '' AS event_id, '' AS event_name, 'click' AS event, link_id, click_id, '' AS customer_id, url, country, region, device, browser, os, referer, referer_url, '' AS metadata,
      CONCAT(country,'-',region) AS region_processed, splitByString('?', referer_url)[1] AS referer_url_processed,
      CAST(NULL AS Nullable(UInt32)) AS saleAmount, '' AS invoice_id, '' AS payment_processor
    FROM dub_click_events_id WHERE click_id IN (SELECT DISTINCT click_id FROM lead_events)
    UNION ALL
    SELECT timestamp, event_id, event_name, 'sale' AS event, link_id, click_id, customer_id, url, country, region, device, browser, os, referer, referer_url, metadata,
      CONCAT(country,'-',region) AS region_processed, splitByString('?', referer_url)[1] AS referer_url_processed,
      amount AS saleAmount, invoice_id, payment_processor
    FROM dub_sale_events_mv WHERE customer_id = ${cid}${linkFilter}
    ORDER BY timestamp DESC FORMAT JSON`;
}
function v2_top_programs(params) {
  const p = P(params);
  const conds = [`program_id != ''`];
  if (p.has("start")) conds.push(`timestamp >= ${q(p.str("start"))}`);
  if (p.has("end")) conds.push(`timestamp <= ${q(p.str("end"))}`);
  return `WITH program_links AS (SELECT link_id, program_id FROM dub_links_metadata_latest FINAL WHERE deleted = 0 AND program_id != '')
    SELECT pl.program_id AS program_id, COUNT(*) AS sales, SUM(se.amount) AS saleAmount
    FROM dub_sale_events_mv se INNER JOIN program_links pl ON se.link_id = pl.link_id
    WHERE ${conds.join(" AND ").replace(/\btimestamp\b/g, "se.timestamp")} GROUP BY pl.program_id ORDER BY saleAmount DESC LIMIT 100 FORMAT JSON`;
}
function all_stats() {
  return `SELECT (SELECT COUNT(timestamp) FROM dub_click_events_mv) AS clicks, (SELECT COUNT(timestamp)+42036155 FROM dub_links_metadata) AS links, (SELECT COALESCE(SUM(amount),0) FROM dub_sale_events_mv) AS sales FORMAT JSON`;
}

export const PIPES = {
  v4_events, v4_count, v4_timeseries, v4_group_by, v4_group_by_link_metadata,
  get_click_event, get_lead_event, get_lead_events, get_webhook_events, get_postback_events,
  get_import_error_logs, get_api_log_by_id, get_api_logs, get_api_logs_count, get_audit_logs,
  v3_group_by_link_country, v2_customer_events, v2_top_programs, all_stats,
};
