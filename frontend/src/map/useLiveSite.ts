import { useCallback, useEffect, useRef, useState } from "react";
import { openSiteStream } from "../api/client";
import type { StreamMessage } from "../api/types";
import { initialMapState, reduceAll, type MapState } from "./reducer";

export type LinkStatus = "connecting" | "live" | "reconnecting";
export type FlushListener = (s: MapState) => void;

const UI_INTERVAL_MS = 250;

/**
 * Subscribes to /ws/sites/{id}. Messages are batched once per animation frame
 * (with a timer fallback for hidden tabs) and pushed to `listen`ers right away;
 * React state for panels is refreshed at most every 250 ms so 2,000 live
 * assets don't re-render the page on every message.
 */
export function useLiveSite(siteId: string) {
  const [ui, setUi] = useState<MapState>(initialMapState);
  const [status, setStatus] = useState<LinkStatus>("connecting");
  const [receivedAt, setReceivedAt] = useState<number | null>(null);
  const stateRef = useRef<MapState>(ui);
  const listeners = useRef(new Set<FlushListener>());

  useEffect(() => {
    stateRef.current = initialMapState();
    setUi(stateRef.current);
    setStatus("connecting");
    let queue: StreamMessage[] = [];
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let uiTimer: ReturnType<typeof setTimeout> | undefined;
    let lastUi = 0;
    let stopped = false;

    const pushUi = () => {
      uiTimer = undefined;
      lastUi = performance.now();
      setUi(stateRef.current);
      setReceivedAt(Date.now());
    };
    const flush = () => {
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      raf = 0;
      timer = undefined;
      if (stopped || !queue.length) return;
      const batch = queue;
      queue = [];
      stateRef.current = reduceAll(stateRef.current, batch);
      for (const l of listeners.current) l(stateRef.current);
      const wait = UI_INTERVAL_MS - (performance.now() - lastUi);
      if (wait <= 0) pushUi();
      else uiTimer ??= setTimeout(pushUi, wait);
    };
    const close = openSiteStream(
      siteId,
      (m) => {
        queue.push(m);
        if (queue.length > 5000) return flush();
        if (!raf) raf = requestAnimationFrame(flush);
        timer ??= setTimeout(flush, 100);
      },
      (s) => setStatus(s === "open" ? "live" : "reconnecting"),
    );
    return () => {
      stopped = true;
      close();
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      clearTimeout(uiTimer);
    };
  }, [siteId]);

  /** Called with the full state after every batch. Returns an unsubscribe function. */
  const listen = useCallback((fn: FlushListener) => {
    const set = listeners.current;
    set.add(fn);
    return () => { set.delete(fn); };
  }, []);

  return { ui, status, receivedAt, stateRef, listen };
}
