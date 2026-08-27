import { DurableObject } from "cloudflare:workers";
import type { Env } from "../lib/env";

/**
 * RateLimiter — atomic fixed-window counter, one instance per identity
 * (API key id, or client IP for anonymous callers).
 *
 * Why a DO and not KV: KV is eventually consistent with a ~1 write/sec/key
 * ceiling, so a KV "counter" silently under-counts exactly when you need it —
 * during a burst. A DO gives single-threaded atomic increments per identity.
 *
 * Note this is defence in depth, not the primary control. The authoritative
 * limit for the demo is the zone-level Rate Limiting rule, which rejects at
 * the edge before a Worker invocation is ever billed. This exists so the API
 * is still protected on paths the zone rule doesn't cover, and so the response
 * can carry accurate X-RateLimit-* headers.
 */
export class RateLimiter extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS window (
        id       INTEGER PRIMARY KEY CHECK (id = 1),
        started  INTEGER NOT NULL,
        count    INTEGER NOT NULL
      );
    `);
  }

  /**
   * @param limit  max requests per window
   * @param windowMs window length in ms
   */
  async take(limit: number, windowMs: number): Promise<{
    allowed: boolean;
    remaining: number;
    resetSeconds: number;
  }> {
    const now = Date.now();
    const rows = this.sql
      .exec<{ started: number; count: number }>("SELECT started, count FROM window WHERE id = 1")
      .toArray();

    let started = rows.length ? rows[0].started : 0;
    let count = rows.length ? rows[0].count : 0;

    if (!rows.length || now - started >= windowMs) {
      started = now;
      count = 0;
    }

    count += 1;
    this.sql.exec(
      `INSERT INTO window (id, started, count) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET started = excluded.started, count = excluded.count`,
      started,
      count
    );

    const resetSeconds = Math.max(0, Math.ceil((started + windowMs - now) / 1000));
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      resetSeconds,
    };
  }
}
