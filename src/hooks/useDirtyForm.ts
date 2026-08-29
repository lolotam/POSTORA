import { useMemo } from "react";

/**
 * Whether `current` has diverged from the last saved `baseline`.
 *
 * Compared by value, not reference: the form is replaced with a freshly built object
 * every time a config loads, so a reference check would report dirty immediately and
 * never recover. A null baseline means "not loaded yet" — nothing the user typed can
 * be at risk, so it reads clean.
 */
export function useDirtyForm<T>(current: T, baseline: T | null): boolean {
  return useMemo(() => {
    if (baseline === null) return false;
    return JSON.stringify(current) !== JSON.stringify(baseline);
  }, [current, baseline]);
}
