import { useCallback, useEffect, useRef, useState } from "react";
import type { AsyncLoadingCache } from "../types.js";

/** State returned by {@link useCachedValue}. */
export interface CachedValueState<V> {
  /** The resolved value, or undefined while loading or on error. */
  data: V | undefined;
  /** True while a load for the current key is in flight. */
  isLoading: boolean;
  /** The load error, if the most recent load rejected. */
  error: unknown;
  /** Force a background reload of the current key. */
  refresh: () => void;
}

/**
 * Subscribe a React component to a value in an {@link AsyncLoadingCache}.
 *
 * Loads are coalesced by the cache, so many components asking for the same key
 * share one loader call. State updates after unmount are suppressed, and stale
 * responses (from a key that changed mid-flight) are ignored.
 *
 * @example
 * const { data, isLoading, error } = useCachedValue(userCache, userId);
 */
export function useCachedValue<K, V>(
  cache: AsyncLoadingCache<K, V>,
  key: K,
): CachedValueState<V> {
  const cached = cache.getIfPresent(key);
  const [data, setData] = useState<V | undefined>(cached);
  const [isLoading, setIsLoading] = useState<boolean>(cached === undefined);
  const [error, setError] = useState<unknown>(undefined);

  // Bumped on every load request so only the newest one may commit state.
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);

  const load = useCallback(
    (loader: () => Promise<V>) => {
      const requestId = ++requestIdRef.current;
      const isCurrent = () =>
        mountedRef.current && requestIdRef.current === requestId;

      const present = cache.getIfPresent(key);
      setData(present);
      setError(undefined);
      setIsLoading(present === undefined);

      loader().then(
        (value) => {
          if (!isCurrent()) return;
          setData(value);
          setError(undefined);
          setIsLoading(false);
        },
        (err) => {
          if (!isCurrent()) return;
          setError(err);
          setIsLoading(false);
        },
      );
    },
    [cache, key],
  );

  useEffect(() => {
    mountedRef.current = true;
    load(() => cache.get(key));
    return () => {
      mountedRef.current = false;
    };
  }, [cache, key, load]);

  const refresh = useCallback(() => {
    load(() => cache.refresh(key));
  }, [cache, key, load]);

  return { data, isLoading, error, refresh };
}
