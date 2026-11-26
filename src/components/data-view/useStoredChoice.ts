import { useEffect, useState } from "react";

export function useStoredChoice<Value extends string | number>(
  storageKey: string,
  allowedValues: readonly Value[],
  fallback: Value,
): [Value, (value: Value) => void] {
  const [value, setValue] = useState<Value>(() => {
    try {
      const stored = globalThis.localStorage?.getItem(storageKey);
      if (stored === null || stored === undefined) return fallback;
      const parsed = typeof fallback === "number" ? Number(stored) : stored;
      return allowedValues.includes(parsed as Value) ? parsed as Value : fallback;
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(storageKey, String(value));
    } catch {
      return;
    }
  }, [storageKey, value]);

  return [value, setValue];
}
