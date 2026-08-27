import type { Availability, Offer } from "../lib/types";

/**
 * Simulated provider feed.
 *
 * This exists so the board is never empty and so demos are reproducible. Every
 * row it produces is tagged `sourceKind: "sim"` and the UI labels it as
 * simulated — it is never presented as real market data.
 *
 * Real providers get added as `source_kind = 'api'` adapters alongside this.
 * The shape is identical so the frontend needs no changes when they land.
 */

const MODELS: Array<{ id: string; name: string; base: number }> = [
  { id: "h200-sxm-141", name: "H200 SXM 141GB", base: 4.25 },
  { id: "h100-sxm-80", name: "H100 SXM 80GB", base: 2.99 },
  { id: "h100-pcie-80", name: "H100 PCIe 80GB", base: 2.45 },
  { id: "a100-sxm-80", name: "A100 SXM 80GB", base: 1.69 },
  { id: "a100-pcie-40", name: "A100 PCIe 40GB", base: 1.1 },
  { id: "l40s-48", name: "L40S 48GB", base: 0.99 },
  { id: "rtx4090-24", name: "RTX 4090 24GB", base: 0.44 },
  { id: "mi300x-192", name: "MI300X 192GB", base: 2.1 },
];

const PROVIDERS: Array<{ id: string; name: string; skew: number; regions: string[] }> = [
  { id: "runpod", name: "RunPod", skew: 0.94, regions: ["us-east", "eu-central"] },
  { id: "lambda", name: "Lambda", skew: 1.06, regions: ["us-west", "us-east"] },
  { id: "vastai", name: "Vast.ai", skew: 0.82, regions: ["us-central", "eu-west"] },
  { id: "coreweave", name: "CoreWeave", skew: 1.14, regions: ["us-east", "eu-west"] },
];

/**
 * Deterministic-but-drifting pseudo-random, seeded from a bucket of wall-clock
 * time so successive ingests move prices smoothly instead of jittering wildly.
 */
function seeded(seed: number): number {
  const x = Math.sin(seed) * 10000;
  return x - Math.floor(x);
}

function availabilityFor(r: number): Availability {
  if (r > 0.82) return "out_of_stock";
  if (r > 0.62) return "limited";
  return "available";
}

export function simulate(providerId: string, now = Date.now()): Offer[] {
  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) return [];

  // 10-minute buckets: matches the ingest cron so each run shifts the market.
  const bucket = Math.floor(now / (10 * 60 * 1000));
  const observedAt = new Date(now).toISOString();
  const offers: Offer[] = [];

  MODELS.forEach((model, mi) => {
    provider.regions.forEach((region, ri) => {
      const seed = bucket + mi * 31 + ri * 7 + providerId.length * 13;
      const rPrice = seeded(seed);
      const rAvail = seeded(seed * 1.7);

      // +/-18% drift around the skewed base price.
      const price = model.base * provider.skew * (0.82 + rPrice * 0.36);
      const availability = availabilityFor(rAvail);

      offers.push({
        providerId: provider.id,
        providerName: provider.name,
        modelId: model.id,
        modelName: model.name,
        region,
        availability,
        // Out-of-stock capacity has no meaningful spot price.
        priceUsdHr: availability === "out_of_stock" ? null : Math.round(price * 100) / 100,
        sourceKind: "sim",
        observedAt,
      });
    });
  });

  return offers;
}

export const SIM_PROVIDER_IDS = PROVIDERS.map((p) => p.id);
