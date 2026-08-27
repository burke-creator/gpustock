import type { ClassifiedRequest, TrafficClass } from "./types";

/**
 * Classify an inbound request into the traffic buckets the bot-report page and
 * the WAF demo both use.
 *
 * IMPORTANT: `request.cf.botManagement` is only populated when Bot Management
 * is entitled on the zone. On a Free zone it may be absent entirely. Rather
 * than silently pretending every request is human, we fall back to explicit
 * User-Agent heuristics and record *which* signal produced the verdict in
 * `reason`, so the public page can be honest about confidence.
 */

const VERIFIED_UA_HINTS: Array<[RegExp, string]> = [
  [/googlebot/i, "search"],
  [/bingbot/i, "search"],
  [/duckduckbot/i, "search"],
  [/applebot/i, "search"],
  [/slackbot|discordbot|twitterbot|facebookexternalhit/i, "social preview"],
  [/uptimerobot|pingdom|betteruptime|statuscake/i, "monitoring"],
  [/gptbot|claudebot|anthropic-ai|ccbot|perplexitybot|google-extended/i, "ai crawler"],
];

// Cheap, obvious automation signatures. These are not a substitute for Bot
// Management — they exist so the site still classifies something useful if the
// zone has no bot score.
const AUTOMATION_UA_HINTS =
  /\b(curl|wget|python-requests|httpx|aiohttp|go-http-client|java|okhttp|scrapy|puppeteer|playwright|headlesschrome|phantomjs|axios|node-fetch|libwww|winhttp)\b/i;

export function classify(request: Request, keyId: string | null): ClassifiedRequest {
  const cf = (request as { cf?: IncomingRequestCfProperties }).cf;
  const bm = (cf as unknown as { botManagement?: {
    score?: number;
    verifiedBot?: boolean;
    corporateProxy?: boolean;
    staticResource?: boolean;
  } })?.botManagement;

  const ua = request.headers.get("User-Agent") ?? "";
  const path = new URL(request.url).pathname;
  const score = typeof bm?.score === "number" ? bm.score : null;
  const asn = typeof cf?.asn === "number" ? cf.asn : null;
  const country = typeof cf?.country === "string" ? cf.country : null;

  let verifiedBotCategory: string | null = null;
  for (const [re, cat] of VERIFIED_UA_HINTS) {
    if (re.test(ua)) {
      verifiedBotCategory = cat;
      break;
    }
  }

  let cls: TrafficClass;
  let reason: string;

  if (keyId) {
    // An authenticated API consumer is legitimate automation by definition.
    cls = "keyed_client";
    reason = `authenticated api key ${keyId}`;
  } else if (bm?.verifiedBot) {
    cls = "verified_bot";
    reason = `cloudflare verified bot${verifiedBotCategory ? ` (${verifiedBotCategory})` : ""}`;
  } else if (verifiedBotCategory && score === null) {
    // No bot score available — UA claims to be a known crawler. We cannot
    // cryptographically verify that claim, so say so.
    cls = "verified_bot";
    reason = `ua claims ${verifiedBotCategory}; unverified (no bot score on zone)`;
  } else if (score !== null) {
    // Cloudflare bot score: 1 = definitely automated, 99 = definitely human.
    if (score <= 3) {
      cls = "abusive";
      reason = `bot score ${score} (automated, high confidence)`;
    } else if (score <= 30) {
      cls = "likely_automated";
      reason = `bot score ${score}`;
    } else {
      cls = "human";
      reason = `bot score ${score}`;
    }
  } else if (AUTOMATION_UA_HINTS.test(ua)) {
    cls = "likely_automated";
    reason = "automation user-agent signature (no bot score on zone)";
  } else if (ua === "") {
    cls = "likely_automated";
    reason = "empty user-agent (no bot score on zone)";
  } else {
    cls = "human";
    reason = "no automation signal (no bot score on zone — low confidence)";
  }

  return {
    class: cls,
    botScore: score,
    verifiedBotCategory,
    asn,
    country,
    userAgent: ua.slice(0, 200),
    path,
    keyId,
    reason,
  };
}

/** True when Bot Management actually populated a score for this request. */
export function hasBotScore(request: Request): boolean {
  const cf = (request as { cf?: unknown }).cf as
    | { botManagement?: { score?: number } }
    | undefined;
  return typeof cf?.botManagement?.score === "number";
}
