import type { Env } from "./env";

/**
 * Report a run to the registry at burkeruder.net.
 *
 * This is deliberately best-effort. The registry is observability, not a
 * dependency: if it is down, unreachable, or misconfigured, gpustock must
 * still ingest data. Failures are logged and swallowed.
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
  if (!env.REGISTRY_URL || !env.REPORT_SECRET) return;

  try {
    const res = await fetch(`${env.REGISTRY_URL}/api/v1/report`, {
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
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      console.warn(`registry report rejected: ${res.status}`);
    }
  } catch (err) {
    console.warn(
      `registry report failed: ${err instanceof Error ? err.message : String(err)}`
    );
  }
}
