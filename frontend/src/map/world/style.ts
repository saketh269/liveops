// Every color and material setting of the 3D world (and the 2D room tint) in one place.
// Two palettes: a soft daylight one (the approved prototype) and a dark wallboard one.
// The app theme picks between them: data-theme="dark", or the OS preference when no
// data-theme="light" overrides it (same rule as styles/tokens.css).
import type { StateKey } from "../stateColors";

export type ThemeName = "light" | "dark";

/** How a room tile shows the state of its bed: color and how strongly it covers the floor (0..1). */
export type TintStyle = { color: string; strength: number };

export type ScenePalette = {
  theme: ThemeName;
  /** Canvas clear color behind the world. */
  sky: string;
  ground: string;
  road: string;
  roadLine: string;
  slab: string;
  /** Painted floor: base, 1 m tile lines, corridor fill, corridor centre line. */
  floor: string;
  floorLine: string;
  corridor: string;
  corridorLine: string;
  /** Soft fill for zones that are neither rooms nor corridors (units, bays, waiting areas). */
  zoneFill: string;
  /** Text printed on the floor: room names, and area names. */
  roomLabel: string;
  areaLabel: string;
  wall: string;
  wallTop: string;
  /** Top of the outer (building) walls. */
  outerWallTop: string;
  desk: string;
  deskTop: string;
  screen: string;
  chair: string;
  tree: string;
  trunk: string;
  /** Room tile color per bed state. */
  tint: Record<StateKey, TintStyle>;
  /** Extra strength added at the peak of the "room is free again" glow. */
  glow: number;
  hemiSky: string;
  hemiGround: string;
  hemiIntensity: number;
  sunColor: string;
  sunIntensity: number;
  exposure: number;
  roughness: number;
};

const LIGHT: ScenePalette = {
  theme: "light",
  sky: "#e9eef3",
  ground: "#c9d6cf",
  road: "#5b6672",
  roadLine: "#f4f6f8",
  slab: "#ffffff",
  floor: "#eef2f6",
  floorLine: "rgba(20,34,49,0.06)",
  corridor: "#dcebee",
  corridorLine: "rgba(11,122,131,0.35)",
  zoneFill: "rgba(111,134,168,0.10)",
  roomLabel: "rgba(20,34,49,0.62)",
  areaLabel: "rgba(11,122,131,0.70)",
  wall: "#fbfcfd",
  wallTop: "#9fb4c8",
  outerWallTop: "#0b7a83",
  desk: "#e8eef4",
  deskTop: "#0b7a83",
  screen: "#24384c",
  chair: "#9bb3c9",
  tree: "#6bb38a",
  trunk: "#9a7b5f",
  tint: {
    free: { color: "#1f9d68", strength: 0.55 },
    "in-use": { color: "#8fa3c2", strength: 0.3 },
    cleaning: { color: "#d98b1c", strength: 0.7 },
    alert: { color: "#e0444b", strength: 0.75 },
    unknown: { color: "#b9c3cc", strength: 0.18 },
  },
  glow: 0.35,
  hemiSky: "#ffffff",
  hemiGround: "#aab7c4",
  hemiIntensity: 1.25,
  sunColor: "#fff1df",
  sunIntensity: 3.2,
  exposure: 0.92,
  roughness: 0.75,
};

const DARK: ScenePalette = {
  theme: "dark",
  sky: "#0c1418",
  ground: "#1b2b25",
  road: "#2b3640",
  roadLine: "#4b5a66",
  slab: "#2a3b44",
  floor: "#24343c",
  floorLine: "rgba(227,236,239,0.05)",
  corridor: "#1f4148",
  corridorLine: "rgba(63,182,193,0.45)",
  zoneFill: "rgba(122,166,240,0.08)",
  roomLabel: "rgba(227,236,239,0.70)",
  areaLabel: "rgba(63,182,193,0.85)",
  wall: "#4a5f6b",
  wallTop: "#7d97ab",
  outerWallTop: "#3fb6c1",
  desk: "#465965",
  deskTop: "#3fb6c1",
  screen: "#0b1216",
  chair: "#56708a",
  tree: "#3b7d5a",
  trunk: "#5a4838",
  tint: {
    free: { color: "#4cc584", strength: 0.5 },
    "in-use": { color: "#7a8fb5", strength: 0.28 },
    cleaning: { color: "#e4ad4f", strength: 0.7 },
    alert: { color: "#f0605a", strength: 0.78 },
    unknown: { color: "#6b7d85", strength: 0.15 },
  },
  glow: 0.35,
  hemiSky: "#c9d8e6",
  hemiGround: "#1a2630",
  hemiIntensity: 1.5,
  sunColor: "#ffe7c7",
  sunIntensity: 2.4,
  exposure: 1.0,
  roughness: 0.8,
};

export const PALETTES: Record<ThemeName, ScenePalette> = { light: LIGHT, dark: DARK };

/** Theme from the document's data-theme value and the OS dark preference (styles/tokens.css rule). */
export function themeFrom(dataTheme: string | null | undefined, prefersDark: boolean): ThemeName {
  if (dataTheme === "dark") return "dark";
  if (dataTheme === "light") return "light";
  return prefersDark ? "dark" : "light";
}

export function paletteFor(theme: ThemeName): ScenePalette {
  return PALETTES[theme];
}

/** Palette for the app's current theme. */
export function currentPalette(): ScenePalette {
  const dataTheme = typeof document !== "undefined" ? document.documentElement.getAttribute("data-theme") : null;
  const prefersDark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  return paletteFor(themeFrom(dataTheme, prefersDark));
}

/** Wall and furniture sizes (metres). */
export const WORLD = {
  wallHeight: 1.55,
  wallThickness: 0.2,
  outerWallHeight: 1.7,
  doorWidth: 1.4,
  slabThickness: 0.35,
  slabMargin: 0.6,
  floorY: 0.012,
  tileY: 0.02,
} as const;
