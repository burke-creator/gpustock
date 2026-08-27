import { Hono } from "hono";
import { cf } from "@astrojs/cloudflare/hono";
import { handle } from "@astrojs/cloudflare/handler";

import type { Env, IngestMessage } from "./lib/env";
import { api } from "./routes/api";
import { runScheduled, runQueue } from "./routes/jobs";

// Durable Objects must be exported from the Worker entry, which is exactly why
// this file exists rather than letting the Astro adapter own the entry.
export { LiveBoard } from "./do/board";
export { RateLimiter } from "./do/ratelimiter";

const app = new Hono<{ Bindings: Env }>();

/**
 * Cloudflare/Astro setup middleware. Serves static assets via the ASSETS
 * binding and populates Astro's locals (cfContext, clientAddress, waitUntil).
 * Returns early on a static-asset hit, so this must come first.
 */
app.use("*", cf());

// Our own surfaces, mounted ahead of Astro so page routing never shadows them.
app.route("/api/v1", api);

app.get("/ws", async (c) => {
  const id = c.env.BOARD.idFromName("global");
  return c.env.BOARD.get(id).fetch(new Request("https://board/ws", c.req.raw));
});

// Everything else is an Astro page.
//
// The cast is a types-only reconciliation: Hono ships its own
// `ExecutionContext` declaration that predates the `tracing`/`abort` members
// now present in @cloudflare/workers-types, which is what Astro's `handle`
// signature refers to. The object the runtime actually passes has both, so
// this is a declaration skew rather than a real mismatch.
app.all("*", (c) =>
  handle(c.req.raw, c.env, c.executionCtx as unknown as ExecutionContext)
);

export default {
  fetch: app.fetch,

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runScheduled(controller, env));
  },

  async queue(batch: MessageBatch<IngestMessage>, env: Env) {
    await runQueue(batch, env);
  },
};
