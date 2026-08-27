export type Availability = "available" | "limited" | "out_of_stock" | "unknown";
export type SourceKind = "api" | "page" | "sim";

export interface Offer {
  providerId: string;
  providerName: string;
  modelId: string;
  modelName: string;
  region: string | null;
  availability: Availability;
  priceUsdHr: number | null;
  sourceKind: SourceKind;
  observedAt: string;
}

export interface Snapshot {
  generatedAt: string;
  offers: Offer[];
  /** Cheapest available price per model, for the ticker strip. */
  bestByModel: Record<string, { providerId: string; priceUsdHr: number } | null>;
}

/**
 * Traffic classification used by both the WAF-facing logic and the public
 * bot-report page. Deliberately mirrors how Cloudflare itself reasons about
 * traffic so the demo maps 1:1 onto the dashboard.
 */
export type TrafficClass =
  | "human"           // no bot score signal, or high score
  | "verified_bot"    // Googlebot, Bingbot, uptime monitors — allow
  | "keyed_client"    // authenticated API consumer — allow, quota by key
  | "likely_automated" // low bot score, no key — challenge
  | "abusive";        // rate-limit breach or known-bad signature — block

export interface ClassifiedRequest {
  class: TrafficClass;
  botScore: number | null;
  verifiedBotCategory: string | null;
  asn: number | null;
  country: string | null;
  userAgent: string;
  path: string;
  keyId: string | null;
  reason: string;
}
