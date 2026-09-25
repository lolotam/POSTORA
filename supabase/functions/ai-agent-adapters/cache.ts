/**
 * Short-lived cache of read-only connector answers (WooCommerce category ids
 * and product searches), backed by the service-role-only
 * `connector_response_cache` table. Keys are SHA-256 hashes and values carry
 * no credentials, so the table is unreachable for anon/authenticated roles
 * and holds nothing worth stealing if it leaks.
 */

export interface ConnectorCache {
  get(key: string): Promise<unknown | null>;
  set(key: string, toolId: string, value: unknown, ttlSeconds: number): Promise<void>;
}

/**
 * The slice of the service-role client `tableCache` needs. Structural on
 * purpose: the admin client is created by handler.ts, and the test fake only
 * has to answer this chain, not restate supabase-js's builder types.
 */
export interface CacheDb {
  from(table: "connector_response_cache"): {
    select(columns: string): {
      eq(column: string, value: string): {
        gt(column: string, value: string): {
          maybeSingle(): PromiseLike<{ data: { value: unknown } | null; error: { message: string } | null }>;
        };
      };
    };
    upsert(row: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
  };
}

/**
 * Canonical form of the key parts: object keys sorted, strings trimmed and
 * lower-cased, applied recursively. Two callers that differ only in key order,
 * whitespace or letter case describe the same request and must share a row.
 */
function canonical(value: unknown): unknown {
  if (typeof value === "string") return value.trim().toLowerCase();
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** SHA-256 hex of the canonical JSON of the key parts. */
export async function cacheKey(parts: unknown[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical(parts))),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A cache failure never fails the connector call, so only the error CLASS is
 * logged — supabase error objects can quote keys and row fragments.
 */
function logCacheError(operation: "get" | "set", error: unknown): void {
  const errorClass = error instanceof Error ? error.name : typeof error;
  console.warn(JSON.stringify({ event: "connector_cache_error", operation, error_class: errorClass }));
}

export function tableCache(db: CacheDb, now: () => number = () => Date.now()): ConnectorCache {
  return {
    async get(key) {
      try {
        const { data, error } = await db.from("connector_response_cache")
          .select("value")
          .eq("cache_key", key)
          .gt("expires_at", new Date(now()).toISOString())
          .maybeSingle();
        if (error) {
          logCacheError("get", error);
          return null;
        }
        return data === null ? null : data.value;
      } catch (error) {
        logCacheError("get", error);
        return null;
      }
    },
    async set(key, toolId, value, ttlSeconds) {
      try {
        const { error } = await db.from("connector_response_cache").upsert({
          cache_key: key,
          tool_id: toolId,
          value,
          expires_at: new Date(now() + ttlSeconds * 1000).toISOString(),
        });
        if (error) logCacheError("set", error);
      } catch (error) {
        logCacheError("set", error);
      }
    },
  };
}
