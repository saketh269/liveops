import { openSiteStream } from "./client";

class FakeWS {
  static all: FakeWS[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(public url: string) { FakeWS.all.push(this); }
  close() { this.closed = true; this.onclose?.(); }
}

test("closing during a pending reconnect does not open another socket, and pings are ignored", () => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeWS as unknown as typeof WebSocket);
  const got: string[] = [];
  const stop = openSiteStream("s1", (m) => got.push(m.type));
  const first = FakeWS.all[0];
  first.onmessage?.({ data: JSON.stringify({ type: "ping", site_id: "s1", assets: [], event: null, ts: 1 }) });
  first.onmessage?.({ data: JSON.stringify({ type: "snapshot", site_id: "s1", assets: [], event: null, ts: 1 }) });
  expect(got).toEqual(["snapshot"]);
  first.onclose?.(); // server dropped: a reconnect is now scheduled
  stop(); // page closes before the retry fires
  vi.advanceTimersByTime(60_000);
  expect(FakeWS.all.length).toBe(1);
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
