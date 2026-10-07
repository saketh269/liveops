import { useCallback, useEffect, useState } from "react";

export type Loaded<T> = { data: T | undefined; error: unknown; loading: boolean; reload: () => void };

/** Loads data once (and again on `reload()` or when `deps` change). Keeps the last data while reloading. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[] = []): Loaded<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stable = useCallback(fn, deps);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    stable().then(
      (d) => { if (!cancelled) { setData(d); setError(null); setLoading(false); } },
      (e) => { if (!cancelled) { setError(e); setLoading(false); } },
    );
    return () => { cancelled = true; };
  }, [stable, tick]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  return { data, error, loading, reload };
}
