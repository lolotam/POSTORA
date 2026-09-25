import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { type CacheDb, cacheKey, tableCache } from "./cache.ts";

// ---------------------------------------------------------------------------
// Task 9 (plan 2026-09-25): the connector response cache. Keys are SHA-256
// hashes of a canonical JSON, values never carry credentials, and a database
// failure is a miss, never a failed connector call.
// ---------------------------------------------------------------------------

Deno.test("cacheKey is stable under key order, string case and whitespace", async () => {
  const one = await cacheKey([
    "search",
    "00000000-0000-0000-0000-000000000001",
    " https://Store.Example.com ",
    { category: " Men's Perfumes ", query: "Hat" },
  ]);
  const two = await cacheKey([
    "search",
    "00000000-0000-0000-0000-000000000001",
    "https://store.example.com",
    { query: "hat", category: "men's perfumes" },
  ]);
  assertEquals(one, two);
  assertEquals(one.length, 64);
});

Deno.test("cacheKey differs by tool id and by store url", async () => {
  const base = await cacheKey([
    "search",
    "00000000-0000-0000-0000-000000000001",
    "https://store.example.com",
    { query: "hat" },
  ]);
  assertEquals(
    await cacheKey(["search", "00000000-0000-0000-0000-000000000002", "https://store.example.com", { query: "hat" }]) !==
      base,
    true,
  );
  assertEquals(
    await cacheKey(["search", "00000000-0000-0000-0000-000000000001", "https://other.example.com", { query: "hat" }]) !==
      base,
    true,
  );
});

interface FakeRow {
  cache_key: string;
  tool_id: string;
  value: unknown;
  expires_at: string;
}

function fakeCacheDb(
  opts: { rows?: FakeRow[]; failGet?: boolean; failSet?: boolean } = {},
): { db: CacheDb; upserts: FakeRow[] } {
  const rows = new Map(opts.rows?.map((row) => [row.cache_key, row]));
  const upserts: FakeRow[] = [];
  const db: CacheDb = {
    from(_table: "connector_response_cache") {
      return {
        select(_columns: string) {
          return {
            eq(_column: string, key: string) {
              return {
                gt(_column: string, nowIso: string) {
                  return {
                    maybeSingle() {
                      if (opts.failGet) {
                        return Promise.resolve({ data: null, error: { message: "connection refused" } });
                      }
                      const row = rows.get(key);
                      // toISOString() output is UTC and compares lexicographically.
                      if (!row || row.expires_at <= nowIso) {
                        return Promise.resolve({ data: null, error: null });
                      }
                      return Promise.resolve({ data: { value: row.value }, error: null });
                    },
                  };
                },
              };
            },
          };
        },
        upsert(row: Record<string, unknown>) {
          if (opts.failSet) {
            return Promise.resolve({ error: { message: "connection refused" } });
          }
          const typed: FakeRow = {
            cache_key: String(row.cache_key),
            tool_id: String(row.tool_id),
            value: row.value,
            expires_at: String(row.expires_at),
          };
          upserts.push(typed);
          rows.set(typed.cache_key, typed);
          return Promise.resolve({ error: null });
        },
      };
    },
  };
  return { db, upserts };
}

const NOW = 1_700_000_000_000;

Deno.test("tableCache.get returns null when the row is missing or expired", async () => {
  const { db } = fakeCacheDb({
    rows: [
      { cache_key: "expired", tool_id: "t", value: { stale: true }, expires_at: new Date(NOW - 1_000).toISOString() },
    ],
  });
  const cache = tableCache(db, () => NOW);
  assertEquals(await cache.get("missing"), null);
  assertEquals(await cache.get("expired"), null);
});

Deno.test("tableCache.get returns the value when the row is fresh", async () => {
  const { db } = fakeCacheDb({
    rows: [
      { cache_key: "fresh", tool_id: "t", value: [{ id: 1 }], expires_at: new Date(NOW + 60_000).toISOString() },
    ],
  });
  assertEquals(await tableCache(db, () => NOW).get("fresh"), [{ id: 1 }]);
});

Deno.test("tableCache.set upserts expires_at = now + ttl", async () => {
  const { db, upserts } = fakeCacheDb();
  await tableCache(db, () => NOW).set("k", "00000000-0000-0000-0000-000000000009", [1, 2], 120);
  assertEquals(upserts, [{
    cache_key: "k",
    tool_id: "00000000-0000-0000-0000-000000000009",
    value: [1, 2],
    expires_at: new Date(NOW + 120_000).toISOString(),
  }]);
});

Deno.test("a db error on get is a miss and on set resolves without throwing", async () => {
  const { db } = fakeCacheDb({ failGet: true, failSet: true });
  const cache = tableCache(db, () => NOW);
  assertEquals(await cache.get("k"), null);
  let threw = false;
  try {
    await cache.set("k", "t", 1, 10);
  } catch {
    threw = true;
  }
  assertEquals(threw, false);
});
