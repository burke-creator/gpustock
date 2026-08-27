import type { Env, IngestMessage } from "../lib/env";
import { persistOffers, publishSnapshot } from "../lib/snapshot";
import { simulate, SIM_PROVIDER_IDS } from "../ingest/sim";

/**
 * Cron entry.
 *
 * The ten-minute tick fans out one queue message per provider so a single slow
 * or failing provider can't stall the whole run. The daily 06:05 UTC tick
 * archives the last day of observations to R2 as newline-delimited JSON.
 */
export async function runScheduled(controller: ScheduledController, env: Env): Promise<void> {
  if (controller.cron === "5 6 * * *") {
    const { results } = await env.DB.prepare(
      `SELECT * FROM observations WHERE observed_at >= datetime('now','-1 day')`
    ).all();
    const key = `observations/${new Date().toISOString().slice(0, 10)}.ndjson`;
    await env.ARCHIVE.put(key, (results ?? []).map((r) => JSON.stringify(r)).join("\n"), {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
    return;
  }

  await env.INGEST.sendBatch(
    SIM_PROVIDER_IDS.map((providerId) => ({
      body: { providerId, reason: "cron" as const },
    }))
  );
}

/**
 * Queue consumer. Each message is one provider's fetch+normalise. Publishing
 * happens once per batch rather than per message, so a 4-provider tick results
 * in one snapshot broadcast, not four.
 */
export async function runQueue(batch: MessageBatch<IngestMessage>, env: Env): Promise<void> {
  let anySucceeded = false;

  for (const msg of batch.messages) {
    try {
      await persistOffers(env, simulate(msg.body.providerId));
      msg.ack();
      anySucceeded = true;
    } catch (err) {
      console.error(`ingest failed for ${msg.body.providerId}:`, err);
      msg.retry();
    }
  }

  // Don't broadcast a snapshot if nothing landed — it would just be the
  // previous state re-sent, waking every hibernating socket for no reason.
  if (anySucceeded) await publishSnapshot(env);
}
