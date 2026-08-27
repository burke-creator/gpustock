import { animate, inView, scroll, stagger } from "motion";

/**
 * Shared chrome for the secondary pages (/bots, /api).
 *
 * Same animation policy as the board: transform + opacity only, LCP untouched,
 * no-op under prefers-reduced-motion.
 */

const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = <T extends Element = Element>(s: string) => document.querySelector<T>(s);
const $$ = <T extends Element = Element>(s: string) =>
  Array.from(document.querySelectorAll<T>(s));

function initChrome(): void {
  if (REDUCED) {
    $$("[data-reveal]").forEach((el) => ((el as HTMLElement).style.opacity = "1"));
    return;
  }

  const rail = $<HTMLElement>("[data-scroll-progress]");
  if (rail) scroll(animate(rail, { scaleX: [0, 1] }, { ease: "linear" }));

  // Group reveals by section so cards stagger together rather than one by one
  // as the user scrolls past each individually.
  const groups = new Map<Element, HTMLElement[]>();
  $$("[data-reveal]").forEach((el) => {
    const parent = el.closest("section") ?? document.body;
    if (!groups.has(parent)) groups.set(parent, []);
    groups.get(parent)!.push(el as HTMLElement);
    (el as HTMLElement).style.opacity = "0";
  });

  for (const [, els] of groups) {
    inView(
      els[0],
      () => {
        animate(
          els,
          { opacity: [0, 1], transform: ["translateY(10px)", "translateY(0px)"] },
          { duration: 0.45, delay: stagger(0.04), ease: [0.16, 1, 0.3, 1] }
        );
        return undefined;
      },
      { amount: 0.2 }
    );
  }

  // Spring lift on cards.
  $$<HTMLElement>(".card").forEach((el) => {
    el.addEventListener("pointerenter", () =>
      animate(el, { transform: "translateY(-3px)" }, { type: "spring", stiffness: 400, damping: 26 })
    );
    el.addEventListener("pointerleave", () =>
      animate(el, { transform: "translateY(0px)" }, { type: "spring", stiffness: 400, damping: 30 })
    );
  });
}

async function loadWhoami(): Promise<void> {
  const box = $<HTMLElement>("[data-whoami]");
  if (!box || !box.querySelector('[data-w="classification"]')) return;
  try {
    const res = await fetch("/api/v1/whoami");
    if (!res.ok) return;
    const d = (await res.json()) as Record<string, unknown>;
    box.dataset.class = String(d.classification ?? "");
    const set = (k: string, v: string) => {
      const el = document.querySelector<HTMLElement>(`[data-w="${k}"]`);
      if (el) el.textContent = v;
    };
    set("classification", String(d.classification ?? "—"));
    set("reason", String(d.reason ?? "—"));
    set(
      "botScore",
      d.botManagementActive ? String(d.botScore) : "unavailable (Bot Management not active on zone)"
    );
    set("country", String(d.country ?? "—"));
    set("asn", d.asn && d.asn !== -1 ? `AS${d.asn}` : "—");
  } catch {
    /* non-critical */
  }
}

initChrome();
void loadWhoami();
