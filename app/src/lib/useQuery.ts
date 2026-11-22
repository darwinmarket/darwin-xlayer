"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * A small stale-while-revalidate cache: one entry per key, shared by every component that reads
 * it, refreshed on an interval while mounted. Enough for a read-mostly chain app, no dependency.
 */
type Entry<T> = { data?: T; error?: unknown; at: number; inflight?: Promise<T>; subs: Set<() => void> };
const cache = new Map<string, Entry<unknown>>();

function entry<T>(key: string): Entry<T> {
  let e = cache.get(key) as Entry<T> | undefined;
  if (!e) {
    e = { at: 0, subs: new Set() };
    cache.set(key, e as Entry<unknown>);
  }
  return e;
}

function notify(e: Entry<unknown>) {
  for (const s of e.subs) s();
}

export function fetchKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const e = entry<T>(key);
  if (e.inflight) return e.inflight;
  const p = fn()
    .then((data) => {
      e.data = data;
      e.error = undefined;
      e.at = Date.now();
      return data;
    })
    .catch((err) => {
      e.error = err;
      e.at = Date.now();
      throw err;
    })
    .finally(() => {
      e.inflight = undefined;
      notify(e as Entry<unknown>);
    });
  e.inflight = p;
  notify(e as Entry<unknown>);
  return p;
}

/** Drop every cached entry whose key starts with `prefix` and refetch the mounted ones. */
export function invalidate(prefix = "") {
  for (const [k, e] of cache) {
    if (k.startsWith(prefix)) {
      e.at = 0;
      notify(e);
    }
  }
}

export type Query<T> = { data: T | undefined; error: unknown; loading: boolean; refresh: () => void };

export function useQuery<T>(key: string | null, fn: () => Promise<T>, opts: { refreshMs?: number; staleMs?: number } = {}): Query<T> {
  const { refreshMs = 0, staleMs = 10_000 } = opts;
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const [, force] = useState(0);

  // the entry object is stable and mutated in place: re-render on notify via a version counter
  useEffect(() => {
    if (!key) return;
    const e = entry<T>(key);
    const cb = () => force((n) => n + 1);
    e.subs.add(cb);
    return () => {
      e.subs.delete(cb);
    };
  }, [key]);
  const snap = key ? entry<T>(key) : null;

  const refresh = useCallback(() => {
    if (!key) return;
    fetchKey(key, () => fnRef.current()).catch(() => {});
  }, [key]);

  const at = snap?.at ?? 0;
  useEffect(() => {
    if (!key) return;
    if (Date.now() - at > staleMs || at === 0) refresh();
  }, [key, at, staleMs, refresh]);

  useEffect(() => {
    if (!key || !refreshMs) return;
    const id = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, refreshMs);
    return () => clearInterval(id);
  }, [key, refreshMs, refresh]);

  return {
    data: snap?.data,
    error: snap?.data === undefined ? snap?.error : undefined,
    loading: !!key && snap?.data === undefined && !snap?.error,
    refresh,
  };
}
