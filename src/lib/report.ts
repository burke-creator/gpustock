import type { Env } from "./env";

/**
 * Report a run to the registry behind burkeruder.net.
 *
 * This goes over a service binding rather than a public fetch. The first
 * implementation used `fetch("https://burkeruder.net/...")` and every report
 * was rejected with a 403: that zone has Browser Integrity Check enabled, which
 * blocks requests without normal browser headers, and a Worker subrequest sends
 * no User-Agent. Faking a User-Agent would have worked but left the pipeline
 * hostage to the zone's security settings.
 *
 * A service binding avoids the public edge entirely — no DNS, no WAF, no
 * Browser Integrity Check, no internet round trip — so telemetry cannot be
 * broken by a future change to the site's security posture.
 *
 * Still best-effort: the registry is observability, not a dependency. If it is
 * unavailable, gpustock must keep ingesting. Failures are logged and swallowed.
 */
export async function reportRun(
  env: Env,
  run: {
    ok: boolean;
    trigger?: string;
    startedAt: number;
    detail?: string;
    error?: string;
    metrics?: Record<string, unknown>;
  }
): Promise<void> {
  if (!env.REGISTRY || !env.REPORT_SECRET) return;

  try {
    // The hostname is arbitrary over a service binding; only the path is used
    // for routing inside the registry Worker.
    const res = await env.REGISTRY.fetch(
      new Request("https://registry.internal/api/v1/report", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.REPORT_SECRET}`,
        },
        body: JSON.stringify({
          entry_id: "gpustock",
          ok: run.ok,
          trigger: run.trigger ?? "cron",
          started_at: new Date(run.startedAt).toISOString(),
          duration_ms: Date.now() - run.startedAt,
          detail: run.detail,
          error: run.error,
          metrics: run.metrics,
        }),
      })
    );

    if (!res.ok) {
      console.warn(
        `registry report rejected: ${res.status} ${(await res.text()).slice(0, 120)}`
      );
    }
  } catch (err) {
    console.warn(
      `registry report failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
