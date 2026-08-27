import { animate, inView, scroll, stagger } from "motion";
import type { Offer, Snapshot } from "../lib/types";

/**
 * Frontend for the live board.
 *
 * Animation policy (this matters — the site doubles as a Core Web Vitals demo):
 *   - transform + opacity only. Never width/height/top/left.
 *   - the LCP element (.hero-title) is never animated in.
 *   - offscreen work is gated behind inView() so it never runs unseen.
 *   - everything is a no-op under prefers-reduced-motion.
 */

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = <T extends Element = Element>(sel: string, root: ParentNode = document) =>
  root.querySelector<T>(sel);
const $$ = <T extends Element = Element>(sel: string, root: ParentNode = document) =>
  Array.from(root.querySelectorAll<T>(sel));

// ---------------------------------------------------------------------------
// chrome animation
// ---------------------------------------------------------------------------

function initChrome(): void {
  if (REDUCED) {
    $$("[data-reveal]").forEach((el) => ((el as HTMLElement).style.opacity = "1"));
    return;
  }

  // Scroll progress rail, driven directly by scroll position.
  const rail = $<HTMLElement>("[data-scroll-progress]");
  if (rail) {
    scroll(animate(rail, { scaleX: [0, 1] }, { ease: "linear" }));
  }

  // Reveal-on-enter for secondary blocks. Small translate only — a large
  // travel distance reads as sluggish and can cause layout shift perception.
  $$("[data-reveal]").forEach((el) => {
    (el as HTMLElement).style.opacity = "0";
    inView(
      el,
      () => {
        animate(
          el,
          { opacity: [0, 1], transform: ["translateY(10px)", "translateY(0px)"] },
          { duration: 0.5, ease: [0.16, 1, 0.3, 1] }
        );
        return undefined;
      },
      { amount: 0.25 }
    );
  });
}

// ---------------------------------------------------------------------------
// board rendering
// ---------------------------------------------------------------------------

let lastPrices = new Map<string, number>();
let currentFilter = "all";
let latest: Snapshot | null = null;

const offerKey = (o: Offer) => `${o.providerId}|${o.modelId}|${o.region ?? ""}`;

function cardHtml(o: Offer): string {
  const price =
    o.priceUsdHr === null
      ? `<div class="card-price is-none">no spot price</div>`
      : `<div class="card-price">$${o.priceUsdHr.toFixed(2)}<small>/gpu/hr</small></div>`;

  const tag =
    o.sourceKind === "sim"
      ? `<span class="tag tag-sim">SIM</span>`
      : `<span class="tag tag-api">API</span>`;

  return `
    <div class="card-top">
      <span class="card-model">${esc(o.modelName)}</span>
    </div>
    ${price}
    <div class="card-bottom">
      <span class="badge badge-${o.availability}">${o.availability.replace(/_/g, " ")}</span>
      <span class="card-prov">${esc(o.providerName)}</span>
      ${o.region ? `<span class="card-region">${esc(o.region)}</span>` : ""}
      ${tag}
    </div>`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch] as string)
  );
}

function render(snap: Snapshot): void {
  const board = $<HTMLElement>("[data-board]");
  if (!board) return;

  const offers = snap.offers
    .filter((o) => currentFilter === "all" || o.availability === currentFilter)
    .sort((a, b) => {
      // Available first, then cheapest.
      const rank = (x: Offer) => (x.availability === "available" ? 0 : x.availability === "limited" ? 1 : 2);
      const r = rank(a) - rank(b);
      if (r !== 0) return r;
      return (a.priceUsdHr ?? Infinity) - (b.priceUsdHr ?? Infinity);
    });

  const firstPaint =
    board.querySelector(".board-skeleton") !== null && board.dataset.ssr !== "1";
  board.dataset.ssr = "0";
  board.innerHTML = "";

  const nodes: HTMLElement[] = offers.map((o) => {
    const el = document.createElement("article");
    el.className = "card";
    el.dataset.key = offerKey(o);
    el.innerHTML = cardHtml(o);
    board.appendChild(el);

    // Flash on price movement between ticks.
    const prev = lastPrices.get(offerKey(o));
    if (!firstPaint && prev !== undefined && o.priceUsdHr !== null && prev !== o.priceUsdHr) {
      el.classList.add(o.priceUsdHr > prev ? "flash-up" : "flash-down");
      setTimeout(() => el.classList.remove("flash-up", "flash-down"), 950);
    }
    return el;
  });

  // Remember prices for next tick's diff.
  lastPrices = new Map(
    snap.offers.filter((o) => o.priceUsdHr !== null).map((o) => [offerKey(o), o.priceUsdHr as number])
  );

  if (REDUCED || nodes.length === 0) return;

  // Staggered entry, but only on first paint or filter change — re-staggering
  // every 10-minute tick would be noise, not polish.
  if (firstPaint) {
    animate(
      nodes,
      { opacity: [0, 1], transform: ["translateY(14px) scale(.985)", "translateY(0) scale(1)"] },
      { duration: 0.45, delay: stagger(0.022), ease: [0.16, 1, 0.3, 1] }
    );
  }

  attachHover(nodes);
}

/** Spring lift on pointer. Cheap, and only bound to visible cards. */
function attachHover(nodes: HTMLElement[]): void {
  if (REDUCED) return;
  for (const el of nodes) {
    el.addEventListener("pointerenter", () => {
      animate(el, { transform: "translateY(-3px)" }, { type: "spring", stiffness: 400, damping: 26 });
    });
    el.addEventListener("pointerleave", () => {
      animate(el, { transform: "translateY(0px)" }, { type: "spring", stiffness: 400, damping: 30 });
    });
  }
}

// ---------------------------------------------------------------------------
// ticker
// ---------------------------------------------------------------------------

let tickerRunning = false;

function renderTicker(snap: Snapshot): void {
  const track = $<HTMLElement>("[data-ticker]");
  if (!track) return;

  const byModel = new Map(snap.offers.map((o) => [o.modelId, o]));
  const entries = Object.entries(snap.bestByModel)
    .filter(([, v]) => v !== null)
    .map(([modelId, v]) => {
      const o = byModel.get(modelId);
      return `<span class="tick">
        <span class="tick-model">${esc(o?.modelName ?? modelId)}</span>
        <span class="tick-price">$${v!.priceUsdHr.toFixed(2)}</span>
        <span class="tick-prov">${esc(v!.providerId)}</span>
      </span>`;
    });

  if (entries.length === 0) {
    track.innerHTML = `<span class="ticker-empty">no available capacity this tick</span>`;
    return;
  }

  // Duplicate the strip so the marquee loop has no visible seam.
  track.innerHTML = entries.join("") + entries.join("");

  if (REDUCED || tickerRunning) return;
  tickerRunning = true;
  animate(
    track,
    { transform: ["translateX(0%)", "translateX(-50%)"] },
    { duration: Math.max(18, entries.length * 2.4), ease: "linear", repeat: Infinity }
  );
}

// ---------------------------------------------------------------------------
// stats + whoami
// ---------------------------------------------------------------------------

function renderStats(snap: Snapshot): void {
  const providers = new Set(snap.offers.map((o) => o.providerId)).size;
  const models = new Set(snap.offers.map((o) => o.modelId)).size;
  setText("[data-stat-providers]", String(providers));
  setText("[data-stat-models]", String(models));
  setText(
    "[data-stat-updated]",
    new Date(snap.generatedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
  );
}

function setText(sel: string, v: string): void {
  const el = $<HTMLElement>(sel);
  if (el) el.textContent = v;
}

async function loadWhoami(): Promise<void> {
  try {
    const res = await fetch("/api/v1/whoami");
    if (!res.ok) return;
    const d = (await res.json()) as Record<string, unknown>;
    const box = $<HTMLElement>("[data-whoami]");
    if (box) box.dataset.class = String(d.classification ?? "");
    setText('[data-w="classification"]', String(d.classification ?? "—"));
    setText('[data-w="reason"]', String(d.reason ?? "—"));
    setText(
      '[data-w="botScore"]',
      d.botManagementActive ? String(d.botScore) : "unavailable (Bot Management not active on zone)"
    );
    setText('[data-w="country"]', String(d.country ?? "—"));
    setText('[data-w="asn"]', d.asn && d.asn !== -1 ? `AS${d.asn}` : "—");
  } catch {
    /* non-critical */
  }
}

// ---------------------------------------------------------------------------
// realtime
// ---------------------------------------------------------------------------

function setConn(state: "connecting" | "live" | "down"): void {
  const pill = $<HTMLElement>(".status-pill");
  if (pill) pill.dataset.conn = state;
  setText("[data-conn-label]", state);
}

function connect(): void {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  let ws: WebSocket;
  let retry = 0;
  let heartbeat: number | undefined;

  const open = () => {
    setConn(retry === 0 ? "connecting" : "connecting");
    ws = new WebSocket(`${proto}//${location.host}/ws`);

    ws.addEventListener("open", () => {
      retry = 0;
      setConn("live");
      heartbeat = window.setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("ping");
      }, 30_000);
    });

    ws.addEventListener("message", (ev) => {
      try {
        const msg = JSON.parse(ev.data as string) as { type: string; data?: Snapshot };
        if (msg.type === "snapshot" && msg.data) {
          latest = msg.data;
          render(msg.data);
          renderTicker(msg.data);
          renderStats(msg.data);
        }
      } catch {
        /* ignore malformed frame */
      }
    });

    const down = () => {
      if (heartbeat) clearInterval(heartbeat);
      setConn("down");
      // Exponential backoff, capped — a flapping board is worse than a stale one.
      retry = Math.min(retry + 1, 6);
      setTimeout(open, 1000 * 2 ** retry);
    };

    ws.addEventListener("close", down);
    ws.addEventListener("error", down);
  };

  open();
}

/**
 * Seed from the REST endpoint only when the server didn't already render rows.
 *
 * The page is SSR'd from D1, so in the normal case the board is already
 * populated in the initial HTML and re-fetching would throw away good markup
 * and cause a visible reflow. We only fetch when SSR produced nothing (cold
 * cache, or a D1 hiccup).
 */
async function seed(): Promise<void> {
  const board = $<HTMLElement>("[data-board]");
  if (board?.dataset.ssr === "1") {
    // Adopt the server-rendered cards: bind hover, and record prices so the
    // next tick can diff against them and flash correctly.
    attachHover($$<HTMLElement>(".card"));
    return;
  }

  try {
    const res = await fetch("/api/v1/availability");
    if (!res.ok) return;
    const snap = (await res.json()) as Snapshot;
    if (!snap.offers?.length) return;
    latest = snap;
    render(snap);
    renderTicker(snap);
    renderStats(snap);
  } catch {
    /* socket will fill it in */
  }
}

// ---------------------------------------------------------------------------
// filters
// ---------------------------------------------------------------------------

function initFilters(): void {
  $$<HTMLButtonElement>("[data-filter]").forEach((btn) => {
    btn.addEventListener("click", () => {
      $$("[data-filter]").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
      currentFilter = btn.dataset.filter ?? "all";
      if (latest) {
        // Force a staggered re-entry on filter change by clearing the diff map.
        lastPrices = new Map();
        const board = $<HTMLElement>("[data-board]");
        if (board) board.innerHTML = '<div class="board-skeleton"></div>';
        render(latest);
        if (!REDUCED) {
          animate(
            $$(".card"),
            { opacity: [0, 1], transform: ["translateY(10px)", "translateY(0)"] },
            { duration: 0.35, delay: stagger(0.015) }
          );
        }
      }
    });
  });
}

// ---------------------------------------------------------------------------

initChrome();
initFilters();
void seed();
void loadWhoami();
connect();

// The ticker is server-rendered, so kick off its marquee immediately rather
// than waiting for the first websocket tick (up to 10 minutes away).
(() => {
  if (REDUCED) return;
  const track = $<HTMLElement>("[data-ticker]");
  if (!track || track.querySelector(".ticker-empty")) return;
  const count = track.querySelectorAll(".tick").length / 2;
  tickerRunning = true;
  animate(
    track,
    { transform: ["translateX(0%)", "translateX(-50%)"] },
    { duration: Math.max(18, count * 2.4), ease: "linear", repeat: Infinity }
  );
})();
