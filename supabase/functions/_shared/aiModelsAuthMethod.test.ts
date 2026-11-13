// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { fetchCategoryAiSettings } from "./ai-fallback.ts";

// The catalogue is keyed by credential kind: UNIQUE (provider_id, model_id,
// auth_method). An OAuth sync therefore writes a second row for a model_id the
// API-key catalogue already has, and a reader that does not pin the kind sees
// both. `.maybeSingle()` then throws "multiple rows returned" and takes the
// whole category lookup down.
//
// This test drives the real reader with a catalogue that holds both rows.

type Row = Record<string, unknown>;

function readPath(row: Row, path: string): unknown {
  return path.split(".").reduce<unknown>((value, key) => {
    if (value === null || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[key];
  }, row);
}

type ModelFilter = [string, unknown];

function fakeAdmin(models: Row[], settings: Row[]) {
  const filters: ModelFilter[] = [];
  const modelChain = {
    select(_columns: string) {
      return modelChain;
    },
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return modelChain;
    },
    async maybeSingle() {
      const matched = models.filter((row) =>
        filters.every(([column, value]) => readPath(row, column) === value)
      );
      // supabase-js .maybeSingle() throws when more than one row comes back.
      if (matched.length > 1) {
        throw new Error("JSON object requested, multiple rows returned");
      }
      return { data: matched[0] ?? null, error: null };
    },
  };

  return {
    filters,
    client: {
      from(table: string) {
        if (table === "ai_models") return modelChain;
        return {
          select(_columns: string) {
            return {
              in(_column: string, _values: unknown[]) {
                return Promise.resolve({ data: settings, error: null });
              },
            };
          },
        };
      },
    },
  };
}

const API_KEY_MODEL: Row = {
  id: "row-api-key",
  model_id: "claude-sonnet-4-5",
  auth_method: "api_key",
  is_active: true,
  ai_providers: { provider_code: "claude" },
};

const OAUTH_MODEL: Row = {
  id: "row-oauth",
  model_id: "claude-sonnet-4-5",
  auth_method: "oauth",
  is_active: true,
  ai_providers: { provider_code: "claude" },
};

const SETTINGS = [
  { key: "default_ai_model_chat", value: { provider_code: "google", model_id: "google/gemini-3.1-flash-lite" } },
  { key: "default_ai_model_chat_fallback", value: { provider_code: "openai", model_id: "gpt-4o-mini" } },
  // The third tier names an API-key model, so the reader takes the api_key branch.
  { key: "default_ai_model_chat_fallback_2", value: { provider_code: "claude", model_id: "claude-sonnet-4-5" } },
];

Deno.test("the last-resort reader pins the credential kind", async () => {
  const { client, filters } = fakeAdmin([API_KEY_MODEL, OAUTH_MODEL], SETTINGS);

  const settings = await fetchCategoryAiSettings(client, "chat");

  assertEquals(
    filters.some(([column, value]) => column === "auth_method" && value === "api_key"),
    true,
    "the ai_models read must pin auth_method = 'api_key'",
  );
  // Two rows share this model_id; only the api_key one may be read.
  assertEquals(settings.lastResortProvider, "claude");
  assertEquals(settings.lastResortModel, "claude-sonnet-4-5");
});

Deno.test("the last-resort reader ignores the OAuth row of the same model", async () => {
  const { client } = fakeAdmin([OAUTH_MODEL], SETTINGS);

  // Only the OAuth row exists: the API-key reader must not accept it, so the
  // hardcoded floor answers instead.
  const settings = await fetchCategoryAiSettings(client, "chat");

  assertEquals(settings.lastResortProvider, "google");
  assertEquals(settings.lastResortModel, "gemini-3-flash-preview");
});
