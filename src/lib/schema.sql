-- gpustock.io — availability + price index for cloud GPU capacity.
--
-- Design note: this is an append-only observation log plus a small catalog.
-- We never UPDATE observations, so the table doubles as the price-history
-- source for charts and as the archive feed pushed to R2 daily.

CREATE TABLE IF NOT EXISTS providers (
  id            TEXT PRIMARY KEY,          -- 'runpod', 'lambda', 'vastai', ...
  name          TEXT NOT NULL,
  homepage      TEXT,
  -- 'api'  = provider exposes a documented public API
  -- 'page' = public pricing page, parsed
  -- 'sim'  = clearly-labelled simulated feed (never presented as real)
  source_kind   TEXT NOT NULL CHECK (source_kind IN ('api', 'page', 'sim')),
  source_url    TEXT,
  enabled       INTEGER NOT NULL DEFAULT 1,
  added_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS gpu_models (
  id            TEXT PRIMARY KEY,          -- 'h100-sxm-80', 'a100-pcie-40'
  vendor        TEXT NOT NULL,             -- 'NVIDIA', 'AMD'
  family        TEXT NOT NULL,             -- 'Hopper', 'Ampere'
  display_name  TEXT NOT NULL,
  vram_gb       INTEGER,
  interconnect  TEXT,                      -- 'SXM', 'PCIe', 'NVLink'
  fp16_tflops   REAL
);

-- One row per (provider, model) observation. Append-only.
CREATE TABLE IF NOT EXISTS observations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_id   TEXT NOT NULL REFERENCES providers(id),
  model_id      TEXT NOT NULL REFERENCES gpu_models(id),
  region        TEXT,
  -- available | limited | out_of_stock | unknown
  availability  TEXT NOT NULL,
  price_usd_hr  REAL,
  observed_at   TEXT NOT NULL DEFAULT (datetime('now')),
  -- Provenance so the UI can label simulated rows honestly.
  source_kind   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_obs_recent   ON observations (observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_model    ON observations (model_id, observed_at DESC);
CREATE INDEX IF NOT EXISTS idx_obs_provider ON observations (provider_id, observed_at DESC);

-- API keys live in KV for hot-path lookups; this mirrors them for admin views
-- and quota reporting. KV is authoritative for auth.
CREATE TABLE IF NOT EXISTS api_keys (
  key_id        TEXT PRIMARY KEY,
  label         TEXT,
  email         TEXT,
  tier          TEXT NOT NULL DEFAULT 'beta',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at    TEXT
);

-- Seed catalog. Deliberately small; ingest widens it.
INSERT OR IGNORE INTO gpu_models (id, vendor, family, display_name, vram_gb, interconnect, fp16_tflops) VALUES
  ('h100-sxm-80',  'NVIDIA', 'Hopper',  'H100 SXM 80GB',   80,  'SXM',  1979.0),
  ('h100-pcie-80', 'NVIDIA', 'Hopper',  'H100 PCIe 80GB',  80,  'PCIe', 1513.0),
  ('h200-sxm-141', 'NVIDIA', 'Hopper',  'H200 SXM 141GB',  141, 'SXM',  1979.0),
  ('a100-sxm-80',  'NVIDIA', 'Ampere',  'A100 SXM 80GB',   80,  'SXM',   624.0),
  ('a100-pcie-40', 'NVIDIA', 'Ampere',  'A100 PCIe 40GB',  40,  'PCIe',  312.0),
  ('l40s-48',      'NVIDIA', 'Ada',     'L40S 48GB',       48,  'PCIe',  733.0),
  ('rtx4090-24',   'NVIDIA', 'Ada',     'RTX 4090 24GB',   24,  'PCIe',  330.0),
  ('mi300x-192',   'AMD',    'CDNA3',   'MI300X 192GB',    192, 'OAM',  1307.0);

INSERT OR IGNORE INTO providers (id, name, homepage, source_kind, source_url) VALUES
  ('runpod',    'RunPod',    'https://runpod.io',    'sim', NULL),
  ('lambda',    'Lambda',    'https://lambdalabs.com','sim', NULL),
  ('vastai',    'Vast.ai',   'https://vast.ai',      'sim', NULL),
  ('coreweave', 'CoreWeave', 'https://coreweave.com','sim', NULL);
