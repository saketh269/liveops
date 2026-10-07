// Maps raw asset states (whatever the source calls them) onto the five
// `--state-*` design tokens. Colors are read from CSS at runtime so dark mode
// and theme switches work without hard-coding any value here.

export type StateKey = "free" | "in-use" | "cleaning" | "alert" | "unknown";

export const STATE_KEYS: readonly StateKey[] = ["free", "in-use", "cleaning", "alert", "unknown"];

export const STATE_LABELS: Record<StateKey, string> = {
  free: "Free",
  "in-use": "In use",
  cleaning: "Cleaning / maintenance",
  alert: "Alert",
  unknown: "Other / unknown",
};

/** Raw values shown in the legend so people can see why a color was chosen. */
export const STATE_EXAMPLES: Record<StateKey, string[]> = {
  free: ["free", "available", "vacant", "idle"],
  "in-use": ["occupied", "in_use", "busy"],
  cleaning: ["cleaning", "maintenance"],
  alert: ["alert", "error", "blocked"],
  unknown: ["anything else"],
};

const RAW: Record<string, StateKey> = {
  free: "free",
  available: "free",
  vacant: "free",
  idle: "free",
  ready: "free",
  occupied: "in-use",
  in_use: "in-use",
  inuse: "in-use",
  busy: "in-use",
  active: "in-use",
  cleaning: "cleaning",
  maintenance: "cleaning",
  dirty: "cleaning",
  alert: "alert",
  error: "alert",
  blocked: "alert",
  alarm: "alert",
  fault: "alert",
};

/** Normalise a raw state ("In Use", "in-use", "OCCUPIED") to a token key. */
export function stateKey(state: unknown): StateKey {
  if (typeof state !== "string") return "unknown";
  const s = state.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return RAW[s] ?? "unknown";
}

export function stateVar(key: StateKey): string {
  return `--state-${key}`;
}

/** Read one CSS custom property from the document (trimmed, "" if unset). */
export function readToken(name: string, el: Element = document.documentElement): string {
  return getComputedStyle(el).getPropertyValue(name).trim();
}

/** Current state colors from the `--state-*` tokens. */
export function readStateColors(el: Element = document.documentElement): Record<StateKey, string> {
  const cs = getComputedStyle(el);
  const out = {} as Record<StateKey, string>;
  for (const k of STATE_KEYS) out[k] = cs.getPropertyValue(stateVar(k)).trim();
  return out;
}

/** Call `cb` whenever the active theme may have changed (OS scheme or data-theme). */
export function onThemeChange(cb: () => void): () => void {
  const mq = typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;
  mq?.addEventListener("change", cb);
  const mo = typeof MutationObserver === "function" ? new MutationObserver(cb) : null;
  mo?.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
  return () => {
    mq?.removeEventListener("change", cb);
    mo?.disconnect();
  };
}
