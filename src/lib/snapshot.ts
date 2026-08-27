import type { Env } from "./env";
import type { Offer, Snapshot } from "./types";

/**
 * Read the most recent observation per (provider, model, region).
 *
 * `observations` is append-only, so "current state" is a group-wise maximum
 * rather than a lookup. Indexed on (provider_id, observed_at) and
 * (model_id, observed_at) to keep this cheap as history grows.
 */
export async function buildSnapshot(env: Env): Promise<Snapshot> {
  const { results } = await env.DB.prepare(
    `SELECT o.provider_id, p.name AS provider_name, o.model_id, m.display_name AS model_name,
            o.region, o.availability, o.price_usd_hr, o.source_kind, o.observed_at
       FROM observations o
       JOIN providers  p ON p.id = o.provider_id
       JOIN gpu_models m ON m.id = o.model_id
       JOIN (
         SELECT provider_id, model_id, region, MAX(observed_at) AS latest
           FROM observations
          GROUP BY provider_id, model_id, region
       ) x
         ON x.provider_id = o.provider_id
        AND x.model_id    = o.model_id
        AND IFNULL(x.region,'') = IFNULL(o.region,'')
        AND x.latest      = o.observed_at`
  ).all<{
    provider_id: string;
    provider_name: string;
    model_id: string;
    model_name: string;
    region: string | null;
    availability: string;
    price_usd_hr: number | null;
    source_kind: string;
    observed_at: string;
  }>();

  const offers: Offer[] = (results ?? []).map((r) => ({
    providerId: r.provider_id,
    providerName: r.provider_name,
    modelId: r.model_id,
    modelName: r.model_name,
    region: r.region,
    availability: r.availability as Offer["availability"],
    priceUsdHr: r.price_usd_hr,
    sourceKind: r.source_kind as Offer["sourceKind"],
    observedAt: r.observed_at,
  }));

  const bestByModel: Snapshot["bestByModel"] = {};
  for (const o of offers) {
    if (o.availability === "out_of_stock" || o.priceUsdHr === null) continue;
    const cur = bestByModel[o.modelId];
    if (!cur || o.priceUsdHr < cur.priceUsdHr) {
      bestByModel[o.modelId] = { providerId: o.providerId, priceUsdHr: o.priceUsdHr };
    }
  }

  return { generatedAt: new Date().toISOString(), offers, bestByModel };
}

export async function persistOffers(env: Env, offers: Offer[]): Promise<void> {
  if (offers.length === 0) return;
  const stmt = env.DB.prepare(
    `INSERT INTO observations
       (provider_id, model_id, region, availability, price_usd_hr, observed_at, source_kind)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  await env.DB.batch(
    offers.map((o) =>
      stmt.bind(
        o.providerId,
        o.modelId,
        o.region,
        o.availability,
        o.priceUsdHr,
        o.observedAt,
        o.sourceKind
      )
    )
  );
}

/** Rebuild, cache, and push to every connected board client. */
export async function publishSnapshot(env: Env): Promise<Snapshot> {
  const snap = await buildSnapshot(env);
  await env.CACHE.put("snapshot:current", JSON.stringify(snap), { expirationTtl: 900 });
  const id = env.BOARD.idFromName("global");
  await env.BOARD.get(id).fetch("https://board/publish", {
    method: "POST",
    body: JSON.stringify(snap),
    headers: { "Content-Type": "application/json" },
  });
  return snap;
}
