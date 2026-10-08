import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "../../api/client";
import type { AssetHistory } from "../../api/types";

/** Changes reach the history in batches about once a second; wait a little longer before re-reading. */
const REFRESH_DELAY_MS = 1500;

export type HistoryState = { data: AssetHistory | null; error: string | null; loading: boolean };

/**
 * History of one record. Re-read whenever `stamp` changes (e.g. the record's
 * updated time), so the timeline follows live changes.
 */
export function useAssetHistory(siteId: string, assetId: string | null, stamp: unknown): HistoryState {
  const [state, setState] = useState<HistoryState>({ data: null, error: null, loading: false });
  const seq = useRef(0);
  const shown = useRef<string | null>(null);

  useEffect(() => {
    if (!assetId) {
      shown.current = null;
      setState({ data: null, error: null, loading: false });
      return;
    }
    const mine = ++seq.current;
    const first = shown.current !== assetId;
    if (first) setState({ data: null, error: null, loading: true });
    const t = setTimeout(() => {
      Promise.resolve().then(() => api.assetHistory(siteId, assetId)).then(
        (data) => { if (mine === seq.current) { shown.current = assetId; setState({ data, error: null, loading: false }); } },
        (e) => {
          if (mine !== seq.current) return;
          const msg = e instanceof ApiError
            ? e.status === 404 ? "Live Ops has no history for this record yet." : `History could not be loaded: ${e.message}.`
            : "History could not be loaded. Check that the Live Ops backend is running.";
          setState((s) => ({ data: s.data, error: msg, loading: false }));
        },
      );
    }, first ? 0 : REFRESH_DELAY_MS);
    return () => clearTimeout(t);
  }, [siteId, assetId, stamp]);

  return assetId && state.data && state.data.asset_id !== assetId ? { data: null, error: null, loading: true } : state;
}
