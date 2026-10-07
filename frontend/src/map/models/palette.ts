// The one place model colors live (ADR 0007 "models"). Every model part is
// painted either with a palette key below or with the record's state color.
// The scene's style module may override any key per theme with
// `setModelPalette`; the figure layer repaints on the next frame.
import { readToken } from "../stateColors";

export type ModelTheme = "light" | "dark";

/** Named colors (sRGB hex). `skin` is a list: each person gets one, picked from a hash of the record id. */
export type ModelPalette = {
  skin: string[];
  hair: string;
  // people
  scrubs: string; scrubsPants: string; nurseCap: string;
  coat: string; doctorPants: string; stethoscope: string;
  evs: string; evsPants: string; evsCart: string; evsBucket: string;
  transporter: string; transporterPants: string; wheelchair: string; wheelchairSeat: string;
  medic: string; medicPants: string; reflective: string;
  blazer: string; blazerPants: string; shirt: string;
  staff: string; staffPants: string;
  gown: string; gownPants: string;
  // bed
  bedFrame: string; mattress: string; sheet: string; pillow: string; blanket: string; monitor: string; monitorScreen: string;
  // vehicles
  vanBody: string; vanStripe: string; glass: string; tire: string; lightRed: string; lightBlue: string;
  vehicleBody: string;
  // equipment and unknown kinds
  equipment: string; equipmentScreen: string; other: string;
};

export type PaletteKey = Exclude<keyof ModelPalette, "skin"> | "skin";

/** Prototype colors (docs/design/hospital-view-prototype.html). */
export const MODEL_PALETTE_LIGHT: ModelPalette = {
  skin: ["#f1c8a8", "#d9a57f", "#a8714e", "#7a4b31", "#f5d7bd"],
  hair: "#3b2a20",
  scrubs: "#2aa3a6", scrubsPants: "#1f8487", nurseCap: "#ffffff",
  coat: "#f3f5f8", doctorPants: "#34507a", stethoscope: "#24384c",
  evs: "#e6a636", evsPants: "#4a5a6c", evsCart: "#f2b84b", evsBucket: "#3b7bbf",
  transporter: "#5b7fb0", transporterPants: "#2f3e52", wheelchair: "#3d4652", wheelchairSeat: "#6f86a8",
  medic: "#d7463f", medicPants: "#2c3442", reflective: "#f4e66b",
  blazer: "#2b3646", blazerPants: "#222a35", shirt: "#f3f5f8",
  staff: "#7d93ad", staffPants: "#3a4757",
  gown: "#a9c6e8", gownPants: "#a9c6e8",
  bedFrame: "#b8c4d1", mattress: "#ffffff", sheet: "#dbe7f5", pillow: "#ffffff", blanket: "#a9c6e8", monitor: "#24384c", monitorScreen: "#3fd0c9",
  vanBody: "#ffffff", vanStripe: "#d7463f", glass: "#2b3f55", tire: "#222a33", lightRed: "#ff3b3b", lightBlue: "#3b7bff",
  vehicleBody: "#c9d3dd",
  equipment: "#9fb3c6", equipmentScreen: "#24384c", other: "#9fb3c6",
};

/**
 * Dark theme: the same identities, with whites pulled down a little so they do
 * not glare on the dark ground and darks lifted so they do not vanish into it.
 */
export const MODEL_PALETTE_DARK: ModelPalette = {
  ...MODEL_PALETTE_LIGHT,
  coat: "#dfe5ec", nurseCap: "#e6ebf0", shirt: "#dfe5ec",
  blazer: "#46566c", blazerPants: "#3a4658", medicPants: "#46505f", evsPants: "#5d6e82", transporterPants: "#47586f",
  staffPants: "#56657a", doctorPants: "#4c6a98", stethoscope: "#8fa5bd",
  bedFrame: "#8f9dad", mattress: "#e3e8ee", sheet: "#c3d3e6", pillow: "#e3e8ee",
  monitor: "#56687d", vanBody: "#e3e8ee", glass: "#4a6380", tire: "#4b5562", wheelchair: "#6a7584",
  equipmentScreen: "#56687d",
};

const overrides: Record<ModelTheme, Partial<ModelPalette>> = { light: {}, dark: {} };
const listeners = new Set<() => void>();

/** Palette for a theme, with any overrides applied. */
export function getModelPalette(theme: ModelTheme): ModelPalette {
  return { ...(theme === "dark" ? MODEL_PALETTE_DARK : MODEL_PALETTE_LIGHT), ...overrides[theme] };
}

/** Override palette keys for a theme (the scene style module's hook). Pass `{}` to clear. */
export function setModelPalette(theme: ModelTheme, patch: Partial<ModelPalette>) {
  overrides[theme] = { ...patch };
  for (const l of listeners) l();
}

/** Called after `setModelPalette`; returns an unsubscribe function. */
export function onModelPaletteChange(cb: () => void): () => void {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
}

/** Theme from the page's `--bg` token (dark when its luminance is low). Light when unknown. */
export function currentModelTheme(): ModelTheme {
  if (typeof document === "undefined") return "light";
  const m = /^#?([0-9a-f]{6})$/i.exec(readToken("--bg"));
  if (!m) return "light";
  const n = parseInt(m[1], 16);
  const lum = 0.2126 * ((n >> 16) & 255) + 0.7152 * ((n >> 8) & 255) + 0.0722 * (n & 255);
  return lum < 96 ? "dark" : "light";
}

/** Stable small hash of a record id, used to pick a skin tone and walk phase. */
export function idHash(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
