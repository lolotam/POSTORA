// deno-lint-ignore-file no-import-prefix
import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { RowReader } from "./providerEndpoint.ts";
import { resolveProviderKey } from "./providerKeys.ts";

type Rows = Record<string, { data: unknown; error?: unknown }>;

function fakeDb(rows: Rows): RowReader {
  return {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: rows[table]?.data ?? null, error: rows[table]?.error ?? null }),
        }),
      }),
    }),
  };
}

function withEnv<T>(name: string, value: string | undefined, run: () => Promise<T>): Promise<T> {
  const prior = Deno.env.get(name);
  if (value === undefined) Deno.env.delete(name);
  else Deno.env.set(name, value);
  return run().finally(() => {
    if (prior === undefined) Deno.env.delete(name);
    else Deno.env.set(name, prior);
  });
}

const ENV = "PROVIDER_KEYS_TEST_KEY";

Deno.test("a saved provider_api_keys row wins over the provider's env var", () =>
  withEnv(ENV, "env-key", async () => {
    const db = fakeDb({
      provider_api_keys: { data: { api_key: "db-key" } },
      ai_providers: { data: { api_key_env_var: ENV } },
    });
    assertEquals(await resolveProviderKey(db, "zai"), "db-key");
  }));

Deno.test("without a saved row, the env var named by ai_providers is used", () =>
  withEnv(ENV, "env-key", async () => {
    const db = fakeDb({ provider_api_keys: { data: { api_key: "  " } }, ai_providers: { data: { api_key_env_var: ENV } } });
    assertEquals(await resolveProviderKey(db, "zai"), "env-key");
  }));

Deno.test("no saved row and no env var set, or no env var named, resolves to null", () =>
  withEnv(ENV, undefined, async () => {
    assertEquals(await resolveProviderKey(fakeDb({ ai_providers: { data: { api_key_env_var: ENV } } }), "zai"), null);
    assertEquals(await resolveProviderKey(fakeDb({ ai_providers: { data: { api_key_env_var: null } } }), "zai"), null);
    assertEquals(await resolveProviderKey(fakeDb({}), "zai"), null);
  }));

Deno.test("a failed key read throws instead of reporting a missing key", async () => {
  await assertRejects(
    () => resolveProviderKey(fakeDb({ provider_api_keys: { data: null, error: { message: "down" } } }), "zai"),
    Error,
    "Provider key read failed",
  );
});
