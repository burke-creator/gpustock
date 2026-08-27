import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../lib/env";
import { classify, hasBotScore } from "../lib/botclass";
import { buildSnapshot } from "../lib/snapshot";

type Ctx = {
  Bindings: Env;
  Variables: { classified: ReturnType<typeof classify>; keyId: string | null };
};

const WINDOW_MS = 60_000;

export const api = new Hono<Ctx>();

/**
 * Resolve an API key if presented, classify the traffic, and record it.
 *
 * Every API request lands in Analytics Engine so the public traffic page is
 * backed by real observed data. writeDataPoint is fire-and-forget.
 */
api.use("*", async (c, next) => {
  const presented =
    c.req.header("x-api-key") ??
    (c.req.header("authorization")?.replace(/^Bearer\s+/i, "") || null);

  let keyId: string | null = null;
  if (presented) {
    const found = await c.env.APIKEYS.get(`key:${presented}`);
    if (found) keyId = found;
  }

  const classified = classify(c.req.raw, keyId);
  c.set("classified", classified);
  c.set("keyId", keyId);

  try {
    c.env.METRICS.writeDataPoint({
      blobs: [
        classified.class,
        classified.path.slice(0, 96),
        classified.country ?? "??",
        classified.userAgent.slice(0, 96),
        classified.reason.slice(0, 96),
      ],
      doubles: [classified.botScore ?? -1, classified.asn ?? -1],
      indexes: [classified.class],
    });
  } catch {
    // Telemetry must never fail a request.
  }

  await next();
});

/** Atomic per-identity rate limiting. Returns a 429 response, or null to continue. */
async function enforceLimit(c: Context<Ctx>): Promise<Response | null> {
  const keyId = c.get("keyId");
  const limit = Number(keyId ? c.env.KEYED_RATE_LIMIT : c.env.ANON_RATE_LIMIT);

  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  const identity = keyId ? `key:${keyId}` : `ip:${ip}`;

  // Direct RPC — RateLimiter extends DurableObject, so no fetch() round trip.
  const limiter = c.env.RATE_LIMITER.get(c.env.RATE_LIMITER.idFromName(identity));
  const verdict = await limiter.take(limit, WINDOW_MS);

  c.header("X-RateLimit-Limit", String(limit));
  c.header("X-RateLimit-Remaining", String(verdict.remaining));
  c.header("X-RateLimit-Reset", String(verdict.resetSeconds));

  if (!verdict.allowed) {
    return c.json(
      {
        error: "rate_limited",
        message: keyId
          ? `Keyed limit of ${limit} req/min exceeded.`
          : `Anonymous limit of ${limit} req/min exceeded. Request an API key for a higher quota.`,
        retryAfterSeconds: verdict.resetSeconds,
      },
      429,
      { "Retry-After": String(verdict.resetSeconds) }
    );
  }
  return null;
}

api.get("/availability", async (c) => {
  const limited = await enforceLimit(c);
  if (limited) return limited;

  const cached = await c.env.CACHE.get("snapshot:current", "json");
  if (cached) {
    c.header("X-Snapshot-Source", "kv");
    return c.json(cached);
  }
  c.header("X-Snapshot-Source", "d1");
  return c.json(await buildSnapshot(c.env));
});

api.get("/models", async (c) => {
  const limited = await enforceLimit(c);
  if (limited) return limited;
  const { results } = await c.env.DB.prepare(
    `SELECT id, vendor, family, display_name, vram_gb, interconnect, fp16_tflops
       FROM gpu_models ORDER BY fp16_tflops DESC`
  ).all();
  return c.json({ models: results });
});

api.get("/providers", async (c) => {
  const limited = await enforceLimit(c);
  if (limited) return limited;
  const { results } = await c.env.DB.prepare(
    `SELECT id, name, homepage, source_kind, enabled
       FROM providers WHERE enabled = 1 ORDER BY name`
  ).all();
  return c.json({ providers: results });
});

api.get("/history/:modelId", async (c) => {
  const limited = await enforceLimit(c);
  if (limited) return limited;
  const { results } = await c.env.DB.prepare(
    `SELECT provider_id, price_usd_hr, availability, observed_at, source_kind
       FROM observations WHERE model_id = ?
      ORDER BY observed_at DESC LIMIT 500`
  )
    .bind(c.req.param("modelId"))
    .all();
  return c.json({ modelId: c.req.param("modelId"), observations: results });
});

/** How the edge classified this request. Genuinely useful, and the live demo. */
api.get("/whoami", (c) => {
  const cls = c.get("classified");
  return c.json({
    classification: cls.class,
    reason: cls.reason,
    botScore: cls.botScore,
    botManagementActive: hasBotScore(c.req.raw),
    verifiedBotCategory: cls.verifiedBotCategory,
    country: cls.country,
    asn: cls.asn,
    authenticated: cls.keyId !== null,
  });
});

api.post("/keys", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    email?: string;
    label?: string;
    turnstileToken?: string;
  };

  if (!body.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(body.email)) {
    return c.json({ error: "invalid_email" }, 400);
  }

  // Refuse rather than issue unprotected keys if Turnstile isn't configured.
  if (!c.env.TURNSTILE_SECRET) {
    return c.json({ error: "not_configured", message: "Key issuance is not open yet." }, 503);
  }
  if (!(await verifyTurnstile(c.env.TURNSTILE_SECRET, body.turnstileToken ?? "", c.req.header("cf-connecting-ip")))) {
    return c.json({ error: "challenge_failed" }, 403);
  }

  const secret = crypto.randomUUID().replace(/-/g, "");
  const keyId = `gsk_${secret.slice(0, 12)}`;

  await c.env.APIKEYS.put(`key:${secret}`, keyId);
  await c.env.DB.prepare(
    "INSERT INTO api_keys (key_id, label, email, tier) VALUES (?, ?, ?, 'beta')"
  )
    .bind(keyId, body.label ?? null, body.email)
    .run();

  return c.json({
    keyId,
    apiKey: secret,
    rateLimitPerMinute: Number(c.env.KEYED_RATE_LIMIT),
    note: "Store this now — it is not retrievable later.",
  });
});

async function verifyTurnstile(secret: string, token: string, ip?: string): Promise<boolean> {
  if (!token) return false;
  const form = new FormData();
  form.append("secret", secret);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  try {
    const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      body: form,
    });
    return ((await res.json()) as { success?: boolean }).success === true;
  } catch {
    return false;
  }
}
