import type {
  AppHealth, AssetHistory, ConnectorSpec, Dataset, LayoutImportRequest, LayoutImportResult, Mapping, MappingConfig, MappingHealth, Site, SiteLayout, Source,
  PlanUpload, SourceRecord, StreamMessage, Suggestion, TestReport, UploadResult,
} from "./types";

export class ApiError extends Error {
  status: number;
  hint?: string;
  problems?: string[];
  retryAfter?: number; // --- auth-ui --- seconds, from Retry-After (423 locked, 429)
  constructor(status: number, message: string, hint?: string, problems?: string[]) {
    super(message);
    this.status = status;
    this.hint = hint;
    this.problems = problems;
  }
}

// --- auth-ui --- Session cookie + CSRF double-submit + 401 handling (ADR 0008).
const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const AUTH_PAGES = ["/signin", "/signup", "/setup", "/forgot", "/reset", "/verify", "/invite"];

export function readCookie(name: string): string | null {
  for (const part of document.cookie ? document.cookie.split(";") : []) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

/** Headers every request needs: X-CSRF-Token (from the liveops_csrf cookie) on unsafe methods. */
export function authHeaders(method: string, extra?: Record<string, string>): Record<string, string> {
  const h: Record<string, string> = { ...extra };
  const csrf = UNSAFE.has(method.toUpperCase()) ? readCookie("liveops_csrf") : null;
  if (csrf) h["X-CSRF-Token"] = csrf;
  return h;
}

export function isAuthPage(pathname: string): boolean {
  return AUTH_PAGES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

let onUnauthorized: () => void = () => {
  const here = location.pathname + location.search;
  location.assign(`/signin?next=${encodeURIComponent(here)}`);
};
/** The AuthProvider swaps in a router-aware handler; the default does a full-page redirect. */
export function setUnauthorizedHandler(fn: () => void): () => void {
  const prev = onUnauthorized;
  onUnauthorized = fn;
  return () => { onUnauthorized = prev; };
}

/** A 401 outside /api/auth/* means the session ended: send the user to sign in (not from the auth pages themselves). */
function checkSignedOut(status: number, path: string) {
  if (status === 401 && !path.startsWith("/api/auth/") && !isAuthPage(location.pathname)) onUnauthorized();
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: authHeaders(method, body === undefined ? undefined : { "Content-Type": "application/json" }),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  checkSignedOut(res.status, path);
  // --- end auth-ui ---
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const d = data?.detail ?? {};
    if (Array.isArray(d)) {
      // FastAPI request validation: [{loc: [...], msg: "..."}]
      const problems = d.map((p: { loc?: unknown[]; msg?: string }) =>
        `${(p.loc ?? []).filter((l) => l !== "body").join(".")}: ${p.msg ?? "invalid value"}`);
      throw new ApiError(res.status, "Some values aren't valid", undefined, problems);
    }
    const msg = typeof d === "string" ? d : d.message ?? `Request failed (${res.status})`;
    // --- auth-ui ---
    const err = new ApiError(res.status, msg, d.hint, d.problems ?? d.fields);
    const wait = Number(res.headers?.get?.("Retry-After") ?? d.retry_after);
    if (Number.isFinite(wait) && wait > 0) err.retryAfter = wait;
    throw err;
    // --- end auth-ui ---
  }
  return data as T;
}
export { req as request }; // --- auth-ui --- used by auth/authApi.ts

export const api = {
  connectors: () => req<ConnectorSpec[]>("GET", "/api/connectors"),

  sources: () => req<Source[]>("GET", "/api/sources"),
  source: (id: string) => req<Source>("GET", `/api/sources/${id}`),
  createSource: (b: { name: string; type: string; settings: Record<string, unknown>; secrets: Record<string, unknown> }) =>
    req<Source>("POST", "/api/sources", b),
  updateSource: (id: string, b: { name?: string; settings?: Record<string, unknown>; secrets?: Record<string, unknown> }) =>
    req<Source>("PUT", `/api/sources/${id}`, b),
  deleteSource: (id: string) => req<void>("DELETE", `/api/sources/${id}`),
  uploadFile: async (id: string, file: File): Promise<UploadResult> => {
    const body = new FormData();
    body.append("file", file, file.name);
    const res = await fetch(`/api/sources/${id}/upload`, { method: "POST", body, credentials: "same-origin", headers: authHeaders("POST") }); // auth-ui
    checkSignedOut(res.status, `/api/sources/${id}/upload`); // auth-ui
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const d = data?.detail ?? {};
      const msg = typeof d === "string" ? d : d.message ?? (res.status === 413 ? "The file is too large" : `Upload failed (${res.status})`);
      throw new ApiError(res.status, msg, d.hint);
    }
    return data as UploadResult;
  },
  testSource: (id: string) => req<TestReport>("POST", `/api/sources/${id}/test`),
  datasets: (id: string) => req<Dataset[]>("GET", `/api/sources/${id}/datasets`),
  preview: (id: string, dataset: string, limit = 20) =>
    req<SourceRecord[]>("GET", `/api/sources/${id}/preview?dataset=${encodeURIComponent(dataset)}&limit=${limit}`),
  suggestions: (id: string, siteId?: string) =>
    req<Suggestion[]>("GET", `/api/sources/${id}/suggestions${siteId ? `?site_id=${encodeURIComponent(siteId)}` : ""}`),

  sites: () => req<Site[]>("GET", "/api/sites"),
  site: (id: string) => req<Site>("GET", `/api/sites/${id}`),
  createSite: (b: { name: string; template: string; layout?: SiteLayout }) => req<Site>("POST", "/api/sites", b),
  updateSite: (id: string, b: { name?: string; template?: string; layout?: SiteLayout }) =>
    req<Site>("PUT", `/api/sites/${id}`, b),
  deleteSite: (id: string) => req<void>("DELETE", `/api/sites/${id}`),
  uploadPlan: async (siteId: string, file: File): Promise<PlanUpload> => {
    const body = new FormData();
    body.append("file", file, file.name);
    const res = await fetch(`/api/sites/${encodeURIComponent(siteId)}/plans`, { method: "POST", body, credentials: "same-origin", headers: authHeaders("POST") }); // auth-ui
    checkSignedOut(res.status, `/api/sites/${encodeURIComponent(siteId)}/plans`); // auth-ui
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const d = data?.detail ?? {};
      const msg = typeof d === "string" ? d : d.message ?? (res.status === 413 ? "The file is too large" : `Upload failed (${res.status})`);
      throw new ApiError(res.status, msg, d.hint);
    }
    return data as PlanUpload;
  },
  deletePlan: (siteId: string, assetId: string) =>
    req<void>("DELETE", `/api/sites/${encodeURIComponent(siteId)}/plans/${encodeURIComponent(assetId)}`),
  importLayout: (siteId: string, b: LayoutImportRequest) =>
    req<LayoutImportResult>("POST", `/api/sites/${encodeURIComponent(siteId)}/layout/import`, b),
  assetHistory: (siteId: string, assetId: string, q: { since?: number; until?: number; limit?: number } = {}) => {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)])).toString();
    return req<AssetHistory>("GET", `/api/sites/${encodeURIComponent(siteId)}/assets/${encodeURIComponent(assetId)}/history${qs ? `?${qs}` : ""}`);
  },

  mappings: (siteId?: string) => req<Mapping[]>("GET", `/api/mappings${siteId ? `?site_id=${siteId}` : ""}`),
  createMapping: (b: { site_id: string; source_id: string; dataset: string; config: MappingConfig; options?: Record<string, unknown>; active?: boolean }) =>
    req<Mapping>("POST", "/api/mappings", b),
  updateMapping: (id: string, b: Partial<Pick<Mapping, "dataset" | "config" | "options" | "active">>) =>
    req<Mapping>("PUT", `/api/mappings/${id}`, b),
  deleteMapping: (id: string) => req<void>("DELETE", `/api/mappings/${id}`),

  health: () => req<AppHealth>("GET", "/api/health"),
  mappingHealth: () => req<MappingHealth[]>("GET", "/api/health/mappings"),
};

/** Live site stream with automatic reconnect. Returns a close function. */
export function openSiteStream(siteId: string, onMessage: (m: StreamMessage) => void, onStatus?: (s: "open" | "closed") => void): () => void {
  let ws: WebSocket | null = null;
  let stopped = false;
  let delay = 1000;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const connect = () => {
    retry = null;
    if (stopped) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = new WebSocket(`${proto}://${location.host}/ws/sites/${siteId}`);
    ws = sock;
    sock.onopen = () => { delay = 1000; onStatus?.("open"); };
    sock.onmessage = (e) => {
      const msg = JSON.parse(e.data) as StreamMessage;
      if (msg.type === "ping") return; // keepalive only; not a data update
      onMessage(msg);
    };
    sock.onclose = () => {
      if (ws !== sock) return;
      onStatus?.("closed");
      if (!stopped) retry = setTimeout(connect, (delay = Math.min(delay * 2, 15000)));
    };
  };
  connect();
  // Closing while a reconnect is pending must cancel it, or a socket leaks (LIVEOPS-30).
  return () => {
    stopped = true;
    if (retry !== null) clearTimeout(retry);
    ws?.close();
    ws = null;
  };
}
