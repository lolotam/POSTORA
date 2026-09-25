# Sync All Providers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the model-catalogue sync from Vercel, OpenRouter and DeepSeek to Anthropic (`claude`), Gemini (`gemini`), OpenAI (`openai`), Z.ai (`zai`), MiniMax (`minimax`) and xAI (`xai`), and add one **Sync all** button to the admin Providers card.

**Architecture:**
- The pure mappers in `_shared/modelCatalogSync.ts` turn each provider's `/models` answer into catalogue models.
- A per-provider request spec in `_shared/modelCatalogSyncRun.ts` covers:
  - the URL;
  - how the key is sent (Bearer, `x-api-key`, or a query parameter);
  - where the list lives in the response.
- The planner gains two safety rules for the direct providers:
  - a catalogue that has no name, price, context or description never erases the stored value;
  - "additive" catalogues never remove a capability an admin gave a row.
- The frontend loops over the syncable providers one call at a time.

**Tech Stack:** Deno edge functions (`deno test`), React + TanStack Query + shadcn (Vitest).

**Spec:** approved in chat on 2026-09-25 (no separate spec file). The design:
- a syncer for each of claude, gemini, openai, zai, minimax and xai;
- OpenAI dated snapshots and non-reply models are skipped;
- each syncer manages only the capability types its list covers;
- unlisted models are switched off (reversible), except any model set as a default or fallback;
- Perplexity and ElevenLabs are out of scope (no usable list);
- a Sync All button runs in the browser, sequentially, with a per-provider result.

## Global Constraints

- Required reading before editing `supabase/functions/**` or `src/**`: `ARCHITECTURE.md`.
- Keys come only from `resolveProviderKey(db, code)`. Never log or return a key. A sync error message may name the env var, never the value.
- Live API shapes, verified 2026-09-25:
  - **Anthropic:** `GET https://api.anthropic.com/v1/models?limit=1000` with headers `x-api-key: <key>` and `anthropic-version: 2023-06-01`. Response `{ data: [{ id, display_name, type, max_input_tokens, max_tokens, capabilities, created_at }] }`.
  - **Gemini:** `GET https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=<key>`. Response `{ models: [{ name: "models/<id>", displayName, description, inputTokenLimit, outputTokenLimit, supportedGenerationMethods: string[] }] }`.
  - **OpenAI:** `GET https://api.openai.com/v1/models`, Bearer. Response `{ data: [{ id, created, owned_by }] }` (ids only).
  - **Z.ai:** `GET https://api.z.ai/api/paas/v4/models`, Bearer. Response `{ data: [{ id }] }`, all chat.
  - **MiniMax:** `GET https://api.minimax.io/v1/models`, Bearer. Response `{ data: [{ id }] }`, all chat.
  - **xAI:** `GET https://api.x.ai/v1/models`, Bearer. Response `{ data: [{ id }] }`. This could not be verified live: the team is out of credits.
- The stored `model_id`s have no `models/` prefix (Gemini ids are stored as `gemini-2.5-flash`).
- No database migration.
- Deno tests: `cd supabase/functions && deno test -A --no-check <paths>`, plus `deno check <file>`. Run Deno before vitest, never after it in the same session, because Deno can corrupt `node_modules`. If vitest then fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`, run `bun install --frozen-lockfile` and retry.
- Frontend: `node_modules/.bin/vitest run <paths>`, and `node_modules/.bin/tsc --noEmit -p tsconfig.app.json` with 0 errors. Tests use `fireEvent`, not `userEvent`.
- Add no new `any`, and match the neighbouring style.

---

### Task 1: The planner preserves curated data for sparse and additive catalogues

**Files:**
- Modify: `supabase/functions/_shared/modelCatalogSync.ts` (the `MappedCatalog` interface and `planCatalogSync`)
- Test: `supabase/functions/_shared/modelCatalogSync.test.ts`

**Interfaces:**
- Produces:
  - `MappedCatalog` gains an optional `additiveCapabilities?: true`.
  - `planCatalogSync` behaviour when updating a row:
    1. When the catalogue's `description`, `context_limit`, `cost_per_1m_input_tokens` or `cost_per_1m_output_tokens` is `null`, the row keeps its stored value.
    2. When the catalogue's `name` equals its `model_id` (the catalogue has no display name) and the row has a name, the row keeps its name.
    3. When `mapped.additiveCapabilities` is set, capabilities become the union of the row's existing capabilities and the catalogue's. Nothing is removed.

- [ ] **Step 1: Write the failing tests** (append to `modelCatalogSync.test.ts`; `existingRow` and `planCatalogSync` are already imported or defined there):

```ts
Deno.test("an id-only catalogue never erases a curated name, price, context or description", () => {
  const mapped = { models: [{ model_id: "gpt-5", name: "gpt-5", description: null, capabilities: ["chat" as const],
    context_limit: null, cost_per_1m_input_tokens: null, cost_per_1m_output_tokens: null, metadata: {} }],
    skippedByType: {}, managedCapabilities: ["chat" as const] };
  const row = { ...existingRow({ id: "1", model_id: "gpt-5", is_active: true, capabilities: ["chat"], metadata: null }),
    name: "GPT-5", description: "Flagship", context_limit: 400000, cost_per_1m_input_tokens: "5.0000", cost_per_1m_output_tokens: 15 };
  const plan = planCatalogSync([row], mapped, new Set());
  assertEquals(plan.updates, []);
});

Deno.test("an additive catalogue keeps capabilities an admin gave a row", () => {
  const mapped = { models: [{ model_id: "gemini-2.5-flash", name: "Gemini 2.5 Flash", description: null,
    capabilities: ["chat" as const], context_limit: null, cost_per_1m_input_tokens: null, cost_per_1m_output_tokens: null,
    metadata: {} }], skippedByType: {}, managedCapabilities: ["chat" as const, "image" as const], additiveCapabilities: true as const };
  const row = { ...existingRow({ id: "1", model_id: "gemini-2.5-flash", is_active: true, capabilities: ["stt", "image", "chat"], metadata: null }),
    name: "Gemini 2.5 Flash" };
  const plan = planCatalogSync([row], mapped, new Set());
  assertEquals(plan.updates, []);
  const replacing = planCatalogSync([row], { ...mapped, additiveCapabilities: undefined }, new Set());
  assertEquals(replacing.updates[0].capabilities, ["chat", "stt"]);
});
```

- [ ] **Step 2: Run and see it fail**

Run: `deno test -A --no-check _shared/modelCatalogSync.test.ts`
Expected: the two new tests FAIL.

- [ ] **Step 3: Implement** in `planCatalogSync`, inside the loop over `mapped.models`, where an existing `row` is found:

```ts
    const kept = (next: number | string | null, stored: number | string | null) => next ?? stored;
    const capabilities = mapped.additiveCapabilities
      ? [...new Set([...row.capabilities, ...model.capabilities])].sort()
      : [...new Set([...adminCapabilities, ...model.capabilities])].sort();
    const update: ModelUpdate = {
      ...model,
      // A catalogue that lists bare ids has no display name, price or context: keep the curated ones.
      name: model.name === model.model_id && row.name ? row.name : model.name,
      description: model.description ?? row.description ?? null,
      context_limit: model.context_limit ?? row.context_limit ?? null,
      cost_per_1m_input_tokens: kept(model.cost_per_1m_input_tokens, row.cost_per_1m_input_tokens) as number | null,
      cost_per_1m_output_tokens: kept(model.cost_per_1m_output_tokens, row.cost_per_1m_output_tokens) as number | null,
      capabilities, metadata, id: row.id, is_active: reactivate || row.is_active, reactivate,
    };
```

Keep `adminCapabilities` as it is today. The cost columns may come back as strings, and `isUnchanged` already compares them at 4 decimal places, so pass the stored value through unchanged. If `ModelUpdate`'s cost fields are typed `number | null`, widen them to `number | string | null`, and make sure the upsert row builder in `modelCatalogSyncRun.ts` still type-checks. Add a one-line comment on `additiveCapabilities` in `MappedCatalog`: "Direct providers: never remove a capability an admin gave a row."

Also update the `MappedCatalog.managedCapabilities` doc comment, if needed, so it stays accurate.

- [ ] **Step 4: Run and see it pass**

Run: `deno test -A --no-check _shared/modelCatalogSync.test.ts _shared/modelCatalogSyncRun.test.ts && deno check _shared/modelCatalogSync.ts _shared/modelCatalogSyncRun.ts`
Expected: all PASS. Existing tests must still pass. If an existing test asserted that a `null` erased a value, report it rather than weakening the test.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ai): catalogue sync keeps curated names, prices and admin capabilities" -- supabase/functions/_shared/modelCatalogSync.ts supabase/functions/_shared/modelCatalogSync.test.ts supabase/functions/_shared/modelCatalogSyncRun.ts
```

---

### Task 2: Mappers for Anthropic, Gemini, OpenAI, Z.ai, MiniMax and xAI

**Files:**
- Modify: `supabase/functions/_shared/modelCatalogSync.ts` (append the mappers)
- Test: `supabase/functions/_shared/modelCatalogSync.test.ts`

**Interfaces:**
- Consumes (Task 1): `MappedCatalog.additiveCapabilities`.
- Produces: `mapAnthropicCatalog`, `mapGeminiCatalog`, `mapOpenAICatalog`, `mapIdOnlyChatCatalog` and `mapXaiCatalog`, each `(data: unknown[]) => MappedCatalog`. Every one sets `additiveCapabilities: true`.

- [ ] **Step 1: Write the failing tests**

```ts
import { mapAnthropicCatalog, mapGeminiCatalog, mapIdOnlyChatCatalog, mapOpenAICatalog, mapXaiCatalog } from "./modelCatalogSync.ts";

const byId = (m: { models: Array<{ model_id: string; capabilities: string[] }> }) =>
  Object.fromEntries(m.models.map((x) => [x.model_id, x.capabilities]));

Deno.test("Anthropic models are chat, with their display name and context window", () => {
  const mapped = mapAnthropicCatalog([{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5", type: "model", max_input_tokens: 1000000 }]);
  assertEquals(mapped.models[0].name, "Claude Opus 5.5");
  assertEquals(mapped.models[0].capabilities, ["chat"]);
  assertEquals(mapped.models[0].context_limit, 1000000);
  assertEquals(mapped.managedCapabilities, ["chat"]);
  assertEquals(mapped.additiveCapabilities, true);
});

Deno.test("Gemini models map by generation method, with the models/ prefix stripped", () => {
  const mapped = mapGeminiCatalog([
    { name: "models/gemini-2.5-flash", displayName: "Gemini 2.5 Flash", inputTokenLimit: 1048576, supportedGenerationMethods: ["generateContent", "countTokens"] },
    { name: "models/gemini-2.5-flash-preview-tts", displayName: "TTS", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-2.5-flash-image", displayName: "Image", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-embedding-001", displayName: "Emb", supportedGenerationMethods: ["embedContent"] },
    { name: "models/imagen-4.0-generate-001", displayName: "Imagen", supportedGenerationMethods: ["predict"] },
    { name: "models/veo-3.0-generate-001", displayName: "Veo", supportedGenerationMethods: ["predictLongRunning"] },
    { name: "models/aqa", displayName: "AQA", supportedGenerationMethods: ["generateAnswer"] },
  ]);
  assertEquals(byId(mapped), {
    "gemini-2.5-flash": ["chat"], "gemini-2.5-flash-preview-tts": ["tts"], "gemini-2.5-flash-image": ["image"],
    "gemini-embedding-001": ["embedding"], "imagen-4.0-generate-001": ["image"], "veo-3.0-generate-001": ["video"],
  });
  assertEquals(mapped.skippedByType, { generateAnswer: 1 });
  assertEquals(mapped.managedCapabilities.sort(), ["chat", "embedding", "image", "tts", "video"]);
});

Deno.test("OpenAI ids are classified by name; dated snapshots and non-reply models are skipped", () => {
  const mapped = mapOpenAICatalog([
    "gpt-5.5", "gpt-5-nano-2025-08-07", "o4-mini", "chatgpt-4o-latest", "gpt-image-2", "dall-e-3", "gpt-4o-mini-tts",
    "tts-1-hd", "whisper-1", "gpt-4o-transcribe", "text-embedding-3-small", "sora-2", "omni-moderation-latest",
    "gpt-4o-realtime-preview", "gpt-4o-audio-preview", "gpt-4o-search-preview", "computer-use-preview", "babbage-002",
  ].map((id) => ({ id })));
  assertEquals(byId(mapped), {
    "gpt-5.5": ["chat"], "o4-mini": ["chat"], "chatgpt-4o-latest": ["chat"], "gpt-image-2": ["image"], "dall-e-3": ["image"],
    "gpt-4o-mini-tts": ["tts"], "tts-1-hd": ["tts"], "whisper-1": ["stt"], "gpt-4o-transcribe": ["stt"],
    "text-embedding-3-small": ["embedding"], "sora-2": ["video"],
  });
  assertEquals(mapped.skippedByType, { snapshot: 1, other: 6 });
});

Deno.test("Z.ai and MiniMax list chat ids only, so only chat rows are managed", () => {
  const mapped = mapIdOnlyChatCatalog([{ id: "glm-5" }, { id: "MiniMax-M3" }]);
  assertEquals(byId(mapped), { "glm-5": ["chat"], "MiniMax-M3": ["chat"] });
  assertEquals(mapped.managedCapabilities, ["chat"]);
});

Deno.test("xAI ids split into chat, image and video by name", () => {
  const mapped = mapXaiCatalog([{ id: "grok-4.3" }, { id: "grok-imagine-image-pro" }, { id: "grok-imagine-video-1.5" }, { id: "grok-2-image-1212" }]);
  assertEquals(byId(mapped), { "grok-4.3": ["chat"], "grok-imagine-image-pro": ["image"], "grok-imagine-video-1.5": ["video"], "grok-2-image-1212": ["image"] });
  assertEquals(mapped.managedCapabilities.sort(), ["chat", "image", "video"]);
});
```

- [ ] **Step 2: Run and see it fail**

Run: `deno test -A --no-check _shared/modelCatalogSync.test.ts`
Expected: FAIL, the exports are missing.

- [ ] **Step 3: Implement** (append to `modelCatalogSync.ts`; `baseModel`, `str`, `positiveInt`, `Row` and `Capability` already exist):

```ts
// Direct providers (below) list only what they serve today, often as bare ids. Their rows were
// curated by hand first, so these catalogues add, refresh and retire models but never strip a
// capability an admin gave a row (see planCatalogSync).

function idOnly(data: unknown[], classify: (id: string) => Capability | string): MappedCatalog & { models: CatalogModel[] } {
  const models: CatalogModel[] = [];
  const skippedByType: Record<string, number> = {};
  for (const raw of data) {
    const id = str((raw as Row).id);
    if (!id) continue;
    const kind = classify(id);
    if (!CAPABILITY_SET.has(kind)) {
      skippedByType[kind] = (skippedByType[kind] ?? 0) + 1;
      continue;
    }
    models.push(baseModel(raw as Row, [kind as Capability]));
  }
  return { models, skippedByType, managedCapabilities: [], additiveCapabilities: true };
}
const CAPABILITY_SET = new Set<string>(["chat", "image", "video", "embedding", "tts", "stt"]);

export function mapAnthropicCatalog(data: unknown[]): MappedCatalog {
  const models = data.map((raw) => raw as Row).filter((row) => str(row.id)).map((row) => {
    const model = baseModel(row, ["chat"]);
    model.name = str(row.display_name) ?? model.name;
    model.context_limit = positiveInt(row.max_input_tokens);
    return model;
  });
  return { models, skippedByType: {}, managedCapabilities: ["chat"], additiveCapabilities: true };
}

function geminiCapability(id: string, methods: string[]): Capability | string {
  if (methods.includes("predictLongRunning")) return "video";
  if (methods.includes("predict")) return "image";
  if (methods.includes("embedContent")) return "embedding";
  if (methods.includes("generateContent")) {
    if (/tts/i.test(id)) return "tts";
    if (/image/i.test(id)) return "image";
    return "chat";
  }
  return methods[0] ?? "unknown";
}

export function mapGeminiCatalog(data: unknown[]): MappedCatalog {
  const models: CatalogModel[] = [];
  const skippedByType: Record<string, number> = {};
  for (const raw of data) {
    const row = raw as Row;
    const id = str(row.name)?.replace(/^models\//, "");
    if (!id) continue;
    const kind = geminiCapability(id, (row.supportedGenerationMethods ?? []) as string[]);
    if (!CAPABILITY_SET.has(kind)) {
      skippedByType[kind] = (skippedByType[kind] ?? 0) + 1;
      continue;
    }
    const model = baseModel({ ...row, id }, [kind as Capability]);
    model.name = str(row.displayName) ?? id;
    model.context_limit = positiveInt(row.inputTokenLimit);
    models.push(model);
  }
  return { models, skippedByType, managedCapabilities: ["chat", "image", "video", "embedding", "tts"], additiveCapabilities: true };
}

const DATED_SNAPSHOT = /-\d{4}-\d{2}-\d{2}$/;
function openAICapability(id: string): Capability | string {
  if (DATED_SNAPSHOT.test(id)) return "snapshot";
  if (/moderation|realtime|audio-preview|search|computer-use|^babbage|^davinci|^ft:/.test(id)) return "other";
  if (/^(gpt-image|dall-e|chatgpt-image)/.test(id)) return "image";
  if (/tts/.test(id)) return "tts";
  if (/whisper|transcribe/.test(id)) return "stt";
  if (/embedding/.test(id)) return "embedding";
  if (/^sora/.test(id)) return "video";
  if (/^(gpt-|o\d|chatgpt-)/.test(id)) return "chat";
  return "other";
}

export function mapOpenAICatalog(data: unknown[]): MappedCatalog {
  const mapped = idOnly(data, openAICapability);
  return { ...mapped, managedCapabilities: ["chat", "image", "tts", "stt", "embedding", "video"] };
}

// Z.ai and MiniMax: /models lists their chat models only; image, video and speech rows stay hand-managed.
export function mapIdOnlyChatCatalog(data: unknown[]): MappedCatalog {
  return { ...idOnly(data, () => "chat"), managedCapabilities: ["chat"] };
}

function xaiCapability(id: string): Capability {
  if (/video/.test(id)) return "video";
  if (/image/.test(id)) return "image";
  return "chat";
}

export function mapXaiCatalog(data: unknown[]): MappedCatalog {
  return { ...idOnly(data, xaiCapability), managedCapabilities: ["chat", "image", "video"] };
}
```

Place `CAPABILITY_SET` above `idOnly`, so the constant is declared before the functions that read it.

- [ ] **Step 4: Run and see it pass**

Run: `deno test -A --no-check _shared/modelCatalogSync.test.ts && deno check _shared/modelCatalogSync.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ai): catalogue mappers for Anthropic, Gemini, OpenAI, Z.ai, MiniMax and xAI" -- supabase/functions/_shared/modelCatalogSync.ts supabase/functions/_shared/modelCatalogSync.test.ts
```

---

### Task 3: Per-provider requests, new syncable providers, and a dry run

**Files:**
- Modify: `supabase/functions/_shared/modelCatalogSyncRun.ts` (`CATALOGUE`, `SYNCABLE_PROVIDERS`, `runCatalogSync`)
- Modify: `supabase/functions/ai-config/index.ts` (the `sync-models` action passes `dry_run`)
- Test: `supabase/functions/_shared/modelCatalogSyncRun.test.ts`

**Interfaces:**
- Consumes (Task 2): the five mappers.
- Produces:
  - `SYNCABLE_PROVIDERS = ["vercel", "openrouter", "deepseek", "claude", "gemini", "openai", "zai", "minimax", "xai"] as const`;
  - `runCatalogSync(db, providerCode, fetchImpl = fetch, options: { dryRun?: boolean } = {})`. With `dryRun` it returns the same `SyncReport` but writes nothing: no upsert and no timestamp.
  - `SyncReport` gains `dry_run: boolean`.

- [ ] **Step 1: Write the failing tests** (append; reuse the file's existing fake-db helpers, and read the file first to learn their names):

For each new provider, one test asserts:
- the fetched URL;
- the auth shape;
- that `runCatalogSync` succeeds against a one-model body.

The expected requests:
- `claude`: URL `https://api.anthropic.com/v1/models?limit=1000`, headers `x-api-key: <key>` and `anthropic-version: 2023-06-01`, no `Authorization`.
- `gemini`: URL `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=<key>` with no auth header, and the list read from `body.models`.
- `openai`, `zai`, `minimax`, `xai`: Bearer. URLs `https://api.openai.com/v1/models`, `https://api.z.ai/api/paas/v4/models`, `https://api.minimax.io/v1/models` and `https://api.x.ai/v1/models`.

Add one more test: a dry run against the claude fixture returns `added: 1, dry_run: true`, and the fake db recorded **no** upsert on `ai_models` and **no** `model_catalog_synced_at_` write.

Add one more test for error messages: a Gemini 400 must not put the key in the error message. The message is `gemini /models returned HTTP 400`. Assert the thrown `CatalogSyncError` message does not contain the key string.

- [ ] **Step 2: Run and see it fail.**

- [ ] **Step 3: Implement**

Replace the `CATALOGUE` entry type with a request spec:

```ts
interface CatalogueSource {
  /** Builds the request; `key` is null for public catalogues. */
  request(key: string | null): { url: string; headers: Record<string, string> };
  needsKey: boolean;
  list(body: unknown): unknown[];
  map(data: unknown[]): MappedCatalog;
}
const dataList = (body: unknown) => {
  const data = (body as { data?: unknown } | null)?.data;
  return Array.isArray(data) ? data : [];
};
const bearer = (url: string): CatalogueSource["request"] => (key) => ({ url, headers: key ? { Authorization: `Bearer ${key}` } : {} });

const CATALOGUE: Record<string, CatalogueSource> = {
  vercel: { request: bearer("https://ai-gateway.vercel.sh/v1/models"), needsKey: false, list: dataList, map: mapVercelCatalog },
  openrouter: { request: bearer("https://openrouter.ai/api/v1/models?output_modalities=all"), needsKey: false, list: dataList, map: mapOpenRouterCatalog },
  deepseek: { request: bearer("https://api.deepseek.com/models"), needsKey: true, list: dataList, map: mapDeepSeekCatalog },
  claude: {
    request: (key) => ({ url: "https://api.anthropic.com/v1/models?limit=1000", headers: { "x-api-key": key ?? "", "anthropic-version": "2023-06-01" } }),
    needsKey: true, list: dataList, map: mapAnthropicCatalog,
  },
  gemini: {
    request: (key) => ({ url: `https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(key ?? "")}`, headers: {} }),
    needsKey: true,
    list: (body) => { const models = (body as { models?: unknown } | null)?.models; return Array.isArray(models) ? models : []; },
    map: mapGeminiCatalog,
  },
  openai: { request: bearer("https://api.openai.com/v1/models"), needsKey: true, list: dataList, map: mapOpenAICatalog },
  zai: { request: bearer("https://api.z.ai/api/paas/v4/models"), needsKey: true, list: dataList, map: mapIdOnlyChatCatalog },
  minimax: { request: bearer("https://api.minimax.io/v1/models"), needsKey: true, list: dataList, map: mapIdOnlyChatCatalog },
  xai: { request: bearer("https://api.x.ai/v1/models"), needsKey: true, list: dataList, map: mapXaiCatalog },
};
```

In `runCatalogSync`:
- resolve the key only when `needsKey`;
- call `source.request(key)` and fetch with its URL and headers (keep the 20s timeout);
- replace the `body.data` extraction with `source.list(body)`.

The error for a non-OK response stays `${providerCode} /models returned HTTP ${res.status}`. It must never include the URL, because the Gemini URL carries the key.

With `options.dryRun`, skip the `ai_models` upsert and the timestamp upsert, and return the report with `dry_run: true`; otherwise `dry_run: false`. The `synced_at` value is still the current time.

In `ai-config/index.ts`'s `sync-models` action, read `const dryRun = body.dry_run === true;` and pass `{ dryRun }`.

- [ ] **Step 4: Run and see it pass**

Run: `deno test -A --no-check _shared/modelCatalogSyncRun.test.ts _shared/modelCatalogSync.test.ts && deno check _shared/modelCatalogSyncRun.ts ai-config/index.ts`

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ai): sync Anthropic, Gemini, OpenAI, Z.ai, MiniMax and xAI catalogues, with a dry run" -- supabase/functions/_shared/modelCatalogSyncRun.ts supabase/functions/_shared/modelCatalogSyncRun.test.ts supabase/functions/ai-config/index.ts
```

---

### Task 4: Sync all button

**Files:**
- Modify: `src/hooks/ai-config/useSyncModels.ts` (`SYNCABLE_PROVIDER_CODES`; add `syncAllProviders`)
- Create: `src/components/admin/settings/ai/SyncAllButton.tsx`
- Modify: `src/components/admin/settings/ai/AiProvidersCard.tsx` (render `<SyncAllButton />` in the "AI Providers" `CardHeader`, aligned right beside the title)
- Test: `src/components/admin/settings/ai/__tests__/SyncAllButton.test.tsx`

**Interfaces:**
- Consumes: the `ai-config` action `sync-models` returning `SyncReport | { error }` (unchanged contract).
- Produces:
  - `SYNCABLE_PROVIDER_CODES = ['vercel', 'openrouter', 'deepseek', 'claude', 'gemini', 'openai', 'zai', 'minimax', 'xai'] as const`;
  - `syncAllProviders(codes: readonly string[], syncOne: (code: string) => Promise<SyncReport>): Promise<Array<{ code: string; report?: SyncReport; error?: string }>>`. It runs strictly one after another, and one failure never stops the rest.

- [ ] **Step 1: Write the failing tests** (`SyncAllButton.test.tsx`; follow `SyncModelsButton.test.tsx` for the supabase and sonner mocks):

```tsx
it('syncs every provider in turn and keeps going after a failure', async () => {
  invoke.mockImplementation((_fn: string, { body }: { body: { provider_code: string } }) =>
    Promise.resolve(body.provider_code === 'xai'
      ? { data: { error: 'xai /models returned HTTP 403' }, error: null }
      : { data: { added: 1, updated: 0, deactivated: 0, kept_in_use: [], skipped_by_type: {}, synced_at: 't', dry_run: false }, error: null }));
  render(wrap(<SyncAllButton providerCodes={['openai', 'xai', 'zai']} />));
  fireEvent.click(screen.getByRole('button', { name: /Sync all/ }));
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
  expect(invoke.mock.calls.map((c) => c[1].body.provider_code)).toEqual(['openai', 'xai', 'zai']);
  await waitFor(() => expect(toast.warning).toHaveBeenCalled());
  expect(String(toast.warning.mock.calls[0][0])).toMatch(/2 of 3/);
});
```

Add a second test: when every sync succeeds, `toast.success` is called with a message that includes the total number added.

- [ ] **Step 2: Run and see it fail.**

- [ ] **Step 3: Implement**

- `syncAllProviders` in `useSyncModels.ts`: a plain `for … of` loop that awaits `syncOne(code)`, catches the error per provider, and pushes `{ code, report }` or `{ code, error: message }`.
- `SyncAllButton`:
  - props `{ providerCodes: readonly string[] }`;
  - a `Button` labelled **Sync all** with the `RefreshCw` icon, showing `Loader2` while running, and disabled while running;
  - the progress label "Syncing <code> (n/N)…";
  - `syncOne` calls `supabase.functions.invoke('ai-config', { body: { action: 'sync-models', provider_code } })` and throws on `error` or `data.error`, exactly like `useSyncModels`;
  - after the run, invalidate `['ai-config']`;
  - if all succeeded: `toast.success(\`Synced ${N} providers: ${added} added, ${updated} updated, ${deactivated} switched off\`)`;
  - otherwise: `toast.warning(\`Synced ${ok} of ${N}. Failed: ${list of "code: error"}\`)`.
- In `AiProvidersCard`, pass the syncable providers that exist and are active: `providers.filter(p => p.is_active && SYNCABLE_PROVIDER_CODES.includes(p.provider_code)).map(p => p.provider_code)`.

- [ ] **Step 4: Run and see it pass, then type-check**

Run: `node_modules/.bin/vitest run src/components/admin/settings/ai && node_modules/.bin/tsc --noEmit -p tsconfig.app.json`

- [ ] **Step 5: Commit**

```bash
git add src/components/admin/settings/ai/SyncAllButton.tsx src/components/admin/settings/ai/__tests__/SyncAllButton.test.tsx
git commit -m "feat(admin): Sync all providers button" -- src/hooks/ai-config/useSyncModels.ts src/components/admin/settings/ai/SyncAllButton.tsx src/components/admin/settings/ai/AiProvidersCard.tsx src/components/admin/settings/ai/__tests__/SyncAllButton.test.tsx
```

---

## After all tasks (controller)

1. Final whole-branch review, then the guards.
2. Before merging, run a live **dry run** per provider with the new code. Deploy happens only on merge, so use a local `deno run` with the fetch plus mapper plus planner against a read-only DB snapshot, or merge and then call `sync-models` with `dry_run: true` first. Review each provider's add, update and switch-off counts, and the in-use guard, before running the real sync.
3. Merge. Dokploy deploys automatically.
4. Run a dry run for each provider, then the real syncs. Report the counts to the user.
