export interface Env {
  /** Service binding to the burkeruder.net registry Worker. Optional. */
  REGISTRY?: Fetcher;
  /** Shared secret for posting run records to the registry. Optional. */
  REPORT_SECRET?: string;

  ASSETS: Fetcher;
  BOARD: DurableObjectNamespace;
  RATE_LIMITER: DurableObjectNamespace<import("../do/ratelimiter").RateLimiter>;
  CACHE: KVNamespace;
  APIKEYS: KVNamespace;
  DB: D1Database;
  ARCHIVE: R2Bucket;
  INGEST: Queue<IngestMessage>;
  METRICS: AnalyticsEngineDataset;
  AI: Ai;

  SITE_NAME: string;
  API_VERSION: string;
  ANON_RATE_LIMIT: string;
  KEYED_RATE_LIMIT: string;

  /** Set via `wrangler secret put TURNSTILE_SECRET` once the widget exists. */
  TURNSTILE_SECRET?: string;
}

export interface IngestMessage {
  providerId: string;
  reason: "cron" | "manual";
}
