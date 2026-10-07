import type {
  AppHealth, ConnectorSpec, Dataset, Mapping, MappingConfig, MappingHealth, Site, SiteLayout, Source,
  SourceRecord, StreamMessage, TestReport,
} from "./types";

export class ApiError extends Error {
  status: number;
  hint?: string;
  problems?: string[];
  constructor(status: number, message: string, hint?: string, problems?: string[]) {
    super(message);
    this.status = status;
    this.hint = hint;
    this.problems = problems;
  }
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
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
    throw new ApiError(res.status, msg, d.hint, d.problems ?? d.fields);
  }
  return data as T;
}

export const api = {
  connectors: () => req<ConnectorSpec[]>("GET", "/api/connectors"),

  sources: () => req<Source[]>("GET", "/api/sources"),
  source: (id: string) => req<Source>("GET", `/api/sources/${id}`),
  createSource: (b: { name: string; type: string; settings: Record<string, unknown>; secrets: Record<string, unknown> }) =>
    req<Source>("POST", "/api/sources", b),
  updateSource: (id: string, b: { name?: string; settings?: Record<string, unknown>; secrets?: Record<string, unknown> }) =>
    req<Source>("PUT", `/api/sources/${id}`, b),
  deleteSource: (id: string) => req<void>("DELETE", `/api/sources/${id}`),
  testSource: (id: string) => req<TestReport>("POST", `/api/sources/${id}/test`),
  datasets: (id: string) => req<Dataset[]>("GET", `/api/sources/${id}/datasets`),
  preview: (id: string, dataset: string, limit = 20) =>
    req<SourceRecord[]>("GET", `/api/sources/${id}/preview?dataset=${encodeURIComponent(dataset)}&limit=${limit}`),

  sites: () => req<Site[]>("GET", "/api/sites"),
  site: (id: string) => req<Site>("GET", `/api/sites/${id}`),
  createSite: (b: { name: string; template: string; layout?: SiteLayout }) => req<Site>("POST", "/api/sites", b),
  updateSite: (id: string, b: { name?: string; template?: string; layout?: SiteLayout }) =>
    req<Site>("PUT", `/api/sites/${id}`, b),
  deleteSite: (id: string) => req<void>("DELETE", `/api/sites/${id}`),

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
  const connect = () => {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/sites/${siteId}`);
    ws.onopen = () => { delay = 1000; onStatus?.("open"); };
    ws.onmessage = (e) => onMessage(JSON.parse(e.data) as StreamMessage);
    ws.onclose = () => {
      onStatus?.("closed");
      if (!stopped) setTimeout(connect, (delay = Math.min(delay * 2, 15000)));
    };
  };
  connect();
  return () => { stopped = true; ws?.close(); };
}
