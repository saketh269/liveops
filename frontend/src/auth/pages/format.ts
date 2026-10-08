import type { Role, UserStatus } from "../../api/types";

/** ISO string or epoch seconds → Date (null when missing or unreadable). */
export function toDate(ts: string | number | null | undefined): Date | null {
  if (ts === null || ts === undefined || ts === "") return null;
  const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "just now", "5 min ago", "3 h ago", else a short date. */
export function when(ts: string | number | null | undefined, now = Date.now()): string {
  const d = toDate(ts);
  if (!d) return "never";
  const s = Math.round((now - d.getTime()) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** "Chrome on macOS" from a user agent; the raw string is never shown. */
export function deviceName(ua: string | null | undefined): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : /python|curl|httpx|requests/i.test(ua) ? "Script" : "Browser";
  const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Windows/.test(ua) ? "Windows"
    : /Mac OS X|Macintosh/.test(ua) ? "macOS" : /CrOS/.test(ua) ? "ChromeOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

export const ROLES: { value: Role; label: string; help: string }[] = [
  { value: "admin", label: "Admin", help: "Everything, including users and organisation settings." },
  { value: "manager", label: "Manager", help: "Sources, sites, mappings and layouts; not users." },
  { value: "viewer", label: "Viewer", help: "Read-only: live map, history and health." },
  { value: "wallboard", label: "Wallboard", help: "Live map only, for a screen on the wall." },
];

export function roleLabel(r: Role): string {
  return ROLES.find((x) => x.value === r)?.label ?? r;
}

export function statusLabel(s: UserStatus): { text: string; tone: string } {
  return { invited: { text: "Invited", tone: "info" }, active: { text: "Active", tone: "ok" }, disabled: { text: "Deactivated", tone: "" } }[s]
    ?? { text: s, tone: "" };
}
