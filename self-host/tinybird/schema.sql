-- Self-hosted ClickHouse schema mirroring Dub's Tinybird datasources.
-- Build order matters: landing tables -> latest -> event MVs -> first_sale -> api_logs_id.
-- Applied by tinybird-server on boot (idempotent: IF NOT EXISTS).

-- ─────────────────────────── Landing (ingest) tables ───────────────────────────

CREATE TABLE IF NOT EXISTS dub_click_events
(
  timestamp DateTime64(3),
  click_id String,
  link_id String,
  alias_link_id Nullable(String),
  url String,
  country LowCardinality(String),
  city String,
  region String,
  latitude String,
  longitude String,
  device LowCardinality(String),
  device_model LowCardinality(String),
  device_vendor LowCardinality(String),
  browser LowCardinality(String),
  browser_version String,
  os LowCardinality(String),
  os_version String,
  engine LowCardinality(String),
  engine_version String,
  cpu_architecture LowCardinality(String),
  ua String,
  bot UInt8,
  referer String,
  referer_url String,
  user_id Nullable(Int64),
  identity_hash Nullable(String),
  ip String,
  qr UInt8,
  continent LowCardinality(String),
  vercel_region Nullable(String),
  trigger String,
  workspace_id Nullable(String),
  domain Nullable(String),
  key Nullable(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (timestamp, link_id, click_id);

CREATE TABLE IF NOT EXISTS dub_lead_events
(
  timestamp DateTime64(3) DEFAULT now(),
  event_id String,
  event_name String,
  customer_id String,
  click_id String,
  link_id String,
  url String,
  continent LowCardinality(String),
  country LowCardinality(String),
  city String,
  region String,
  latitude String,
  longitude String,
  device LowCardinality(String),
  device_model LowCardinality(String),
  device_vendor LowCardinality(String),
  browser LowCardinality(String),
  browser_version String,
  os LowCardinality(String),
  os_version String,
  engine LowCardinality(String),
  engine_version String,
  cpu_architecture LowCardinality(String),
  ua String,
  bot UInt8,
  referer String,
  referer_url String,
  ip String,
  qr UInt8,
  metadata String,
  trigger String,
  domain Nullable(String),
  key Nullable(String),
  workspace_id Nullable(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (timestamp, link_id, customer_id);

CREATE TABLE IF NOT EXISTS dub_sale_events
(
  timestamp DateTime64(3) DEFAULT now(),
  event_id String,
  event_name String,
  customer_id String,
  payment_processor LowCardinality(String),
  invoice_id String,
  amount UInt32,
  currency LowCardinality(String),
  click_id String,
  link_id String,
  url String,
  continent LowCardinality(String),
  country LowCardinality(String),
  city String,
  region String,
  latitude String,
  longitude String,
  device LowCardinality(String),
  device_model LowCardinality(String),
  device_vendor LowCardinality(String),
  browser LowCardinality(String),
  browser_version String,
  os LowCardinality(String),
  os_version String,
  engine LowCardinality(String),
  engine_version String,
  cpu_architecture LowCardinality(String),
  ua String,
  bot UInt8,
  referer String,
  referer_url String,
  ip String,
  qr UInt8,
  metadata String,
  trigger String,
  domain Nullable(String),
  key Nullable(String),
  workspace_id Nullable(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (timestamp, link_id);

CREATE TABLE IF NOT EXISTS dub_links_metadata
(
  timestamp DateTime DEFAULT now(),
  link_id String,
  domain String,
  key String,
  url String,
  tag_ids Array(String),
  workspace_id String,
  created_at DateTime64(3),
  deleted UInt8,
  program_id String,
  tenant_id String,
  partner_id String,
  folder_id String,
  partner_group_id String,
  partner_tag_ids Array(String) DEFAULT []
)
ENGINE = MergeTree
PARTITION BY toYear(timestamp)
ORDER BY (timestamp, link_id, workspace_id);

CREATE TABLE IF NOT EXISTS dub_webhook_events
(
  timestamp DateTime64(3) DEFAULT now(),
  event_id String,
  webhook_id String,
  url String,
  event LowCardinality(String),
  http_status UInt16,
  request_body String,
  response_body String,
  message_id String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (timestamp, webhook_id, event_id);

CREATE TABLE IF NOT EXISTS dub_postback_events
(
  timestamp DateTime64(3) DEFAULT now(),
  event_id String,
  postback_id String,
  url String,
  event LowCardinality(String),
  response_status UInt16,
  request_body String,
  response_body String,
  message_id String,
  retry_attempt UInt8
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (postback_id, event_id, timestamp);

CREATE TABLE IF NOT EXISTS dub_api_logs
(
  id String,
  timestamp DateTime64(3),
  workspace_id String,
  method LowCardinality(String),
  path String,
  route_pattern LowCardinality(String),
  status_code UInt16,
  duration UInt32,
  user_agent String,
  request_body String,
  response_body String,
  token_id String,
  user_id String,
  request_type LowCardinality(String)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (workspace_id, timestamp)
TTL toDateTime(timestamp) + toIntervalDay(90);

CREATE TABLE IF NOT EXISTS dub_audit_logs
(
  id String,
  timestamp DateTime64(3),
  workspace_id String,
  program_id String,
  action LowCardinality(String),
  actor_id String,
  actor_type LowCardinality(String),
  actor_name String,
  targets String,
  description String,
  ip_address String,
  user_agent String,
  metadata String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (workspace_id, program_id, timestamp)
TTL toDateTime(timestamp) + toIntervalYear(1);

CREATE TABLE IF NOT EXISTS dub_import_error_logs
(
  timestamp DateTime64(3) DEFAULT now(),
  workspace_id String,
  import_id String,
  source String,
  entity String,
  entity_id String,
  code String,
  message String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (timestamp, workspace_id, import_id)
TTL toDateTime(timestamp) + toIntervalDay(180);

CREATE TABLE IF NOT EXISTS dub_conversion_events_log
(
  timestamp DateTime64(3) DEFAULT now(),
  workspace_id String,
  link_id String,
  path String,
  body String,
  error String
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (timestamp, workspace_id)
TTL toDateTime(timestamp) + toIntervalDay(90);

-- ─────────────────────── Derived: links metadata latest ───────────────────────

CREATE TABLE IF NOT EXISTS dub_links_metadata_latest
(
  timestamp DateTime,
  workspace_id LowCardinality(String),
  link_id String,
  domain String,
  key String,
  url String,
  program_id LowCardinality(String),
  partner_id String,
  partner_group_id String,
  folder_id String,
  tag_ids Array(String),
  partner_tag_ids Array(String) DEFAULT [],
  tenant_id String,
  created_at DateTime64(3),
  deleted UInt8
)
ENGINE = ReplacingMergeTree(timestamp, deleted)
ORDER BY (workspace_id, link_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS dub_links_metadata_pipe_mv
TO dub_links_metadata_latest
AS
SELECT
  timestamp,
  toLowCardinality(CASE WHEN startsWith(workspace_id, 'ws_c') THEN replace(workspace_id, 'ws_', '') ELSE workspace_id END) AS workspace_id,
  link_id, domain, key, url,
  toLowCardinality(program_id) AS program_id,
  partner_id, partner_group_id, folder_id, tag_ids, tenant_id, created_at, deleted
FROM dub_links_metadata;

-- ─────────────────────── Derived: enriched event MVs ───────────────────────

CREATE TABLE IF NOT EXISTS dub_click_events_mv
(
  timestamp DateTime64(3), click_id String, workspace_id LowCardinality(String), link_id String,
  domain String, key String, url String,
  continent LowCardinality(String), country LowCardinality(String), city LowCardinality(String),
  region LowCardinality(String), latitude String, longitude String,
  device LowCardinality(String), browser LowCardinality(String), os LowCardinality(String),
  trigger String, ua String, referer String, referer_url String, ip String, identity_hash String,
  device_model LowCardinality(String), device_vendor LowCardinality(String),
  browser_version String, os_version String, engine LowCardinality(String), engine_version String,
  cpu_architecture LowCardinality(String), qr UInt8, bot UInt8
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (workspace_id, link_id, timestamp);

CREATE MATERIALIZED VIEW IF NOT EXISTS dub_click_events_pipe_mv
TO dub_click_events_mv
AS
SELECT
  ce.timestamp AS timestamp, ce.click_id AS click_id,
  toLowCardinality(coalesce(nullIf(ce.workspace_id, ''), lm.workspace_id, '')) AS workspace_id,
  ce.link_id AS link_id,
  coalesce(nullIf(ce.domain, ''), lm.domain, '') AS domain,
  coalesce(nullIf(ce.key, ''), lm.key, '') AS key,
  ce.url AS url,
  toLowCardinality(ce.continent) AS continent, toLowCardinality(ce.country) AS country,
  toLowCardinality(ce.city) AS city, toLowCardinality(ce.region) AS region,
  ce.latitude AS latitude, ce.longitude AS longitude,
  toLowCardinality(ce.device) AS device, toLowCardinality(ce.browser) AS browser,
  toLowCardinality(ce.os) AS os,
  CASE WHEN ce.trigger = '' THEN (CASE WHEN ce.qr = 1 THEN 'qr' ELSE 'link' END) ELSE ce.trigger END AS trigger,
  ce.ua AS ua, ce.referer AS referer, ce.referer_url AS referer_url, ce.ip AS ip,
  coalesce(ce.identity_hash, '') AS identity_hash,
  toLowCardinality(ce.device_model) AS device_model, toLowCardinality(ce.device_vendor) AS device_vendor,
  ce.browser_version AS browser_version, ce.os_version AS os_version,
  toLowCardinality(ce.engine) AS engine, ce.engine_version AS engine_version,
  toLowCardinality(ce.cpu_architecture) AS cpu_architecture, ce.qr AS qr, ce.bot AS bot
FROM dub_click_events AS ce
LEFT JOIN (SELECT link_id, workspace_id, domain, key FROM dub_links_metadata_latest FINAL) AS lm
  USING (link_id);

CREATE TABLE IF NOT EXISTS dub_click_events_id
(
  timestamp DateTime64(3), click_id String, workspace_id LowCardinality(String), link_id String,
  domain String, key String, url String,
  continent LowCardinality(String), country LowCardinality(String), city LowCardinality(String),
  region LowCardinality(String), latitude String, longitude String,
  device LowCardinality(String), browser LowCardinality(String), os LowCardinality(String),
  trigger String, ua String, referer String, referer_url String, ip String, identity_hash String,
  device_model LowCardinality(String), device_vendor LowCardinality(String),
  browser_version String, os_version String, engine LowCardinality(String), engine_version String,
  cpu_architecture LowCardinality(String), qr UInt8, bot UInt8
)
ENGINE = MergeTree
PARTITION BY tuple()
ORDER BY (click_id)
SETTINGS index_granularity = 256;

CREATE MATERIALIZED VIEW IF NOT EXISTS dub_click_events_id_pipe_mv
TO dub_click_events_id
AS SELECT * FROM dub_click_events_mv;

CREATE TABLE IF NOT EXISTS dub_lead_events_mv
(
  timestamp DateTime64(3), click_id String, workspace_id LowCardinality(String), link_id String,
  domain String, key String, url String,
  event_id String, event_name String, customer_id String, metadata String,
  continent LowCardinality(String), country LowCardinality(String), city LowCardinality(String),
  region LowCardinality(String), latitude String, longitude String,
  device LowCardinality(String), browser LowCardinality(String), os LowCardinality(String),
  trigger String, ua String, referer String, referer_url String, ip String,
  device_model LowCardinality(String), device_vendor LowCardinality(String),
  browser_version String, os_version String, engine LowCardinality(String), engine_version String,
  cpu_architecture LowCardinality(String), qr UInt8, bot UInt8
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (workspace_id, link_id, timestamp);

CREATE MATERIALIZED VIEW IF NOT EXISTS dub_lead_events_pipe_mv
TO dub_lead_events_mv
AS
SELECT
  le.timestamp AS timestamp, le.click_id AS click_id,
  toLowCardinality(coalesce(nullIf(le.workspace_id, ''), lm.workspace_id, '')) AS workspace_id,
  le.link_id AS link_id,
  coalesce(nullIf(le.domain, ''), lm.domain, '') AS domain,
  coalesce(nullIf(le.key, ''), lm.key, '') AS key,
  le.url AS url,
  le.event_id AS event_id, le.event_name AS event_name, le.customer_id AS customer_id, le.metadata AS metadata,
  toLowCardinality(le.continent) AS continent, toLowCardinality(le.country) AS country,
  toLowCardinality(le.city) AS city, toLowCardinality(le.region) AS region,
  le.latitude AS latitude, le.longitude AS longitude,
  toLowCardinality(le.device) AS device, toLowCardinality(le.browser) AS browser,
  toLowCardinality(le.os) AS os,
  CASE WHEN le.trigger = '' THEN (CASE WHEN le.qr = 1 THEN 'qr' ELSE 'link' END) ELSE le.trigger END AS trigger,
  le.ua AS ua, le.referer AS referer, le.referer_url AS referer_url, le.ip AS ip,
  toLowCardinality(le.device_model) AS device_model, toLowCardinality(le.device_vendor) AS device_vendor,
  le.browser_version AS browser_version, le.os_version AS os_version,
  toLowCardinality(le.engine) AS engine, le.engine_version AS engine_version,
  toLowCardinality(le.cpu_architecture) AS cpu_architecture, le.qr AS qr, le.bot AS bot
FROM dub_lead_events AS le
LEFT JOIN (SELECT link_id, workspace_id, domain, key FROM dub_links_metadata_latest FINAL) AS lm
  USING (link_id);

CREATE TABLE IF NOT EXISTS dub_sale_events_mv
(
  timestamp DateTime64(3), click_id String, workspace_id LowCardinality(String), link_id String,
  domain String, key String, url String,
  event_id String, event_name String, customer_id String,
  payment_processor LowCardinality(String), invoice_id String, amount UInt32, metadata String,
  continent LowCardinality(String), country LowCardinality(String), city LowCardinality(String),
  region LowCardinality(String), latitude String, longitude String,
  device LowCardinality(String), browser LowCardinality(String), os LowCardinality(String),
  trigger String, ua String, referer String, referer_url String, ip String,
  device_model LowCardinality(String), device_vendor LowCardinality(String),
  browser_version String, os_version String, engine LowCardinality(String), engine_version String,
  cpu_architecture LowCardinality(String), qr UInt8, bot UInt8
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(timestamp)
ORDER BY (workspace_id, link_id, timestamp);

CREATE MATERIALIZED VIEW IF NOT EXISTS dub_sale_events_pipe_mv
TO dub_sale_events_mv
AS
SELECT
  se.timestamp AS timestamp, se.click_id AS click_id,
  toLowCardinality(coalesce(nullIf(se.workspace_id, ''), lm.workspace_id, '')) AS workspace_id,
  se.link_id AS link_id,
  coalesce(nullIf(se.domain, ''), lm.domain, '') AS domain,
  coalesce(nullIf(se.key, ''), lm.key, '') AS key,
  se.url AS url,
  se.event_id AS event_id, se.event_name AS event_name, se.customer_id AS customer_id,
  se.payment_processor AS payment_processor, se.invoice_id AS invoice_id, se.amount AS amount, se.metadata AS metadata,
  toLowCardinality(se.continent) AS continent, toLowCardinality(se.country) AS country,
  toLowCardinality(se.city) AS city, toLowCardinality(se.region) AS region,
  se.latitude AS latitude, se.longitude AS longitude,
  toLowCardinality(se.device) AS device, toLowCardinality(se.browser) AS browser,
  toLowCardinality(se.os) AS os,
  CASE WHEN se.trigger = '' THEN (CASE WHEN se.qr = 1 THEN 'qr' ELSE 'link' END) ELSE se.trigger END AS trigger,
  se.ua AS ua, se.referer AS referer, se.referer_url AS referer_url, se.ip AS ip,
  toLowCardinality(se.device_model) AS device_model, toLowCardinality(se.device_vendor) AS device_vendor,
  se.browser_version AS browser_version, se.os_version AS os_version,
  toLowCardinality(se.engine) AS engine, se.engine_version AS engine_version,
  toLowCardinality(se.cpu_architecture) AS cpu_architecture, se.qr AS qr, se.bot AS bot
FROM dub_sale_events AS se
LEFT JOIN (SELECT link_id, workspace_id, domain, key FROM dub_links_metadata_latest FINAL) AS lm
  USING (link_id);

-- ─────────────────────── Derived: first sale (aggregating) ───────────────────────

CREATE TABLE IF NOT EXISTS dub_first_sale_mv
(
  workspace_id LowCardinality(String),
  link_id String,
  customer_id String,
  first_sale_state AggregateFunction(min, DateTime64(3))
)
ENGINE = AggregatingMergeTree
ORDER BY (workspace_id, link_id, customer_id);

CREATE MATERIALIZED VIEW IF NOT EXISTS dub_first_sale_pipe_mv
TO dub_first_sale_mv
AS
SELECT workspace_id, link_id, customer_id, minState(timestamp) AS first_sale_state
FROM dub_sale_events_mv
GROUP BY workspace_id, link_id, customer_id;

-- ─────────────────────── Derived: api logs by id ───────────────────────

CREATE TABLE IF NOT EXISTS dub_api_logs_id
(
  id String, timestamp DateTime64(3), workspace_id String, method LowCardinality(String),
  path String, route_pattern LowCardinality(String), status_code UInt16, duration UInt32,
  user_agent String, request_body String, response_body String, token_id String,
  user_id String, request_type LowCardinality(String)
)
ENGINE = MergeTree
PARTITION BY tuple()
ORDER BY (id)
TTL toDateTime(timestamp) + toIntervalDay(90)
SETTINGS index_granularity = 256;

CREATE MATERIALIZED VIEW IF NOT EXISTS dub_api_logs_id_pipe_mv
TO dub_api_logs_id
AS SELECT * FROM dub_api_logs;
