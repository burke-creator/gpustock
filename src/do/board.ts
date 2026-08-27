import { DurableObject } from "cloudflare:workers";
import type { Snapshot } from "../lib/types";
import type { Env } from "../lib/env";

/**
 * LiveBoard — fan-out point for the realtime availability board.
 *
 * One instance (id: "global") holds the current snapshot and pushes deltas to
 * every connected browser. Uses the WebSocket Hibernation API rather than
 * holding sockets in memory: an idle board with 500 viewers costs nothing
 * until the next ingest tick, which matters because most viewers idle on the
 * tab. `ctx.acceptWebSocket()` lets the DO evict from memory while keeping
 * sockets alive; handlers below are re-entered on wake.
 */
export class LiveBoard extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS snapshot (
        id         INTEGER PRIMARY KEY CHECK (id = 1),
        payload    TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.endsWith("/ws")) {
      if (request.headers.get("Upgrade") !== "websocket") {
        return new Response("expected websocket upgrade", { status: 426 });
      }
      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];

      // Hibernatable accept — no in-memory socket registry needed.
      this.ctx.acceptWebSocket(server);

      // Send current state immediately so the board never renders empty.
      const snap = this.current();
      if (snap) {
        server.send(JSON.stringify({ type: "snapshot", data: snap }));
      }

      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith("/publish") && request.method === "POST") {
      const snap = (await request.json()) as Snapshot;
      this.publish(snap);
      return Response.json({ ok: true, viewers: this.ctx.getWebSockets().length });
    }

    if (url.pathname.endsWith("/state")) {
      return Response.json({
        snapshot: this.current(),
        viewers: this.ctx.getWebSockets().length,
      });
    }

    return new Response("not found", { status: 404 });
  }

  /** Persist + fan out to every live socket. */
  private publish(snap: Snapshot): void {
    this.sql.exec(
      `INSERT INTO snapshot (id, payload, updated_at) VALUES (1, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
      JSON.stringify(snap),
      Date.now()
    );

    const frame = JSON.stringify({ type: "snapshot", data: snap });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(frame);
      } catch {
        // Socket died between getWebSockets() and send(); the runtime will
        // surface it via webSocketClose. Nothing useful to do here.
      }
    }
  }

  private current(): Snapshot | null {
    const rows = this.sql.exec<{ payload: string }>(
      "SELECT payload FROM snapshot WHERE id = 1"
    ).toArray();
    if (rows.length === 0) return null;
    try {
      return JSON.parse(rows[0].payload) as Snapshot;
    } catch {
      return null;
    }
  }

  // --- Hibernation handlers -------------------------------------------------

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // The client only ever needs to heartbeat; all data flows server -> client.
    if (typeof message === "string" && message === "ping") {
      ws.send(JSON.stringify({ type: "pong", t: Date.now() }));
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    // 1006 is an abnormal close (tab killed, network drop) and is expected
    // often enough that we don't treat it as an error.
    try {
      ws.close(code === 1006 ? 1000 : code, reason);
    } catch {
      /* already closed */
    }
  }

  async webSocketError(): Promise<void> {
    /* nothing actionable; runtime closes the socket */
  }
}
