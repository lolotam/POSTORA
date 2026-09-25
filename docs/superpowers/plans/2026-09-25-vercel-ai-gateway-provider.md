# Vercel AI Gateway Provider + Model Catalogue Sync — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> **Required reading before any edit:** `ARCHITECTURE.md`, specifically §12 (Edge Function shape), §13 (never-do list), §14 (auth via `_shared/auth-helper.ts`), §15 (Zod validation), §16 (sanitized errors via `_shared/errorSanitizer.ts`), §24–26 (service role, CORS, external HTTP timeouts), §39 (admin authorization in the function) and §40 (shared-code rule: feature-local unless two features use it). A delegation brief for any task must name these sections.

**Goal:** Add Vercel AI Gateway and DeepSeek as providers on `/admin/settings?tab=ai`, show each Vercel model only in the section it belongs to, and make every section able to call Vercel (chat, agent, embedding, image, video, TTS, STT). Keep the model lists of Vercel, OpenRouter and DeepSeek current with a sync button, and refresh the other providers once.

**Architecture:** The provider and model rows live in `ai_providers`/`ai_models`. A pure mapping module turns each provider's `/models` catalogue into `ai_models` rows, split by `capabilities`. Chat, agent and embeddings reach Vercel and DeepSeek through a new data-driven resolver for OpenAI-compatible endpoints, replacing the hardcoded fall-through to Google. Image, video, TTS and STT go through a single wrapper, `_shared/vercelGateway.ts`, which is the only place that imports `npm:ai` and `npm:@ai-sdk/gateway`.

**Tech Stack:** Deno edge functions (self-hosted Supabase), Postgres migrations, React 18 + TanStack Query + shadcn, Vitest, `deno test`, `npm:ai@7.0.114`, `npm:@ai-sdk/gateway@4.0.92`.

**Spec:** `docs/superpowers/specs/2026-09-25-vercel-ai-gateway-provider-design.md`

## Global Constraints

- Work in the worktree `F:\Postora_vercel_gw` on branch `feat/vercel-ai-gateway-provider`. Never run `git stash -u` in `F:\Postora_new`.
- **The Vercel API key never appears in the repo, a migration, a test fixture, a commit or a delegation brief.** The key pasted into chat must be rotated. Keys are entered through *Save & Test* (`provider_api_keys`) and in the stack `.env`.
- Provider codes are exactly `vercel` and `deepseek`. Existing codes stay as they are: `claude`, `gemini`, `zai`, `xai`, `openai`, `openrouter`.
- Gateway base URL: `https://ai-gateway.vercel.sh/v1`. Key env var: `AI_GATEWAY_API_KEY`.
- DeepSeek base URL: `https://api.deepseek.com`. Key env var: `DEEPSEEK_API_KEY`.
- Pinned packages: `npm:ai@7.0.114` and `npm:@ai-sdk/gateway@4.0.92`, imported only from `supabase/functions/_shared/vercelGateway.ts`.
- Vercel `/v1/models` `type` → `capabilities`: `language`→`chat`, `image`→`image`, `video`→`video`, `embedding`→`embedding`, `speech`→`tts`, `transcription`→`stt`. `realtime`, `reranking` and `evaluation` are skipped; that includes `typesafe-ai/jev`.
- Embedding vectors must be 1024 or 1536 wide (`STORABLE_EMBEDDING_DIMENSIONS`).
- Worker ceiling is 60s. Video must start a job and return; it never waits for the render.
- A sync must never deactivate a model referenced by any `default_ai_model_*` setting.
- Edge deploy goes through `ssh-contabo-mcp` per `docs/runbooks/deploy-edge-function.md`, reading from `git show <ref>:<path>`. **Never** `npx supabase functions deploy`.
- Migrations are applied manually on Contabo **before** the code that needs them, followed by a PostgREST schema reload.
- Commit scoped files only: `git commit -- <files>`. Every commit ends with `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>`.
- Deno test command (from `scripts/local-gates.sh`): `deno test --allow-env --allow-net --allow-read --allow-write --no-check --node-modules-dir=auto <path>`. Also run `deno check <new module>` on every new module, because `--no-check` hides type errors.
- Frontend test command: `bun run test -- <path>` (Vitest).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `supabase/migrations/20260925120000_vercel_deepseek_providers.sql` | create | Adds the provider rows |
| `supabase/functions/_shared/modelCatalogSync.ts` | create | **Pure** catalogue→rows mapping, embedding width table, sync diff planning |
| `supabase/functions/_shared/modelCatalogSync.test.ts` | create | Tests for the mapping and the diff |
| `supabase/functions/_shared/modelCatalogSyncRun.ts` | create | Fetches a catalogue, applies the plan to the DB, returns a report |
| `supabase/functions/_shared/modelCatalogSyncRun.test.ts` | create | Tests with a fake admin client and fake fetch |
| `supabase/functions/_shared/providerErrors.ts` | create | Turns a provider HTTP failure into an admin-readable message |
| `supabase/functions/_shared/providerErrors.test.ts` | create | |
| `supabase/functions/_shared/providerEndpoint.ts` | create | Data-driven base URL for OpenAI-compatible providers, plus key env map |
| `supabase/functions/_shared/providerEndpoint.test.ts` | create | |
| `supabase/functions/_shared/vercelGateway.ts` | create | The only AI-SDK import: image, video start/status, speech, transcription |
| `supabase/functions/_shared/vercelGateway.test.ts` | create | Pure snapshot mapper and key resolution |
| `supabase/functions/ai-config/index.ts` | modify | `sync-models` action; Test uses a real chat model and the new error text |
| `supabase/functions/_shared/ai-fallback.ts` | modify | Chat chain reaches data-driven providers |
| `supabase/functions/ai-agent-reply/logic.ts`, `index.ts` | modify | Agent reaches `vercel` and `deepseek` |
| `supabase/functions/_shared/knowledgeEmbeddings.ts` | modify | `vercel` embedding provider |
| `supabase/functions/generate-image/index.ts` | modify | `vercel` branch; unambiguous requested-model lookup |
| `supabase/functions/generate-video/index.ts` | modify | `vercel` branch (start job) |
| `supabase/functions/ai-generation-status/index.ts` | modify | `vercel` job polling and inline-bytes archive |
| `supabase/functions/generate-speech/index.ts` | create | TTS through the `default_ai_model_tts` chain (Vercel) |
| `supabase/functions/transcribe-media/index.ts` | modify | Provider-aware routing, with a `vercel` branch |
| `scripts/provider-model-refresh.ts` | create | One-off: pulls live `/models` and emits a draft refresh migration |
| `supabase/migrations/20260925130000_refresh_provider_models.sql` | create | Reviewed output of the script |
| `src/hooks/ai-config/useSyncModels.ts` | create | Mutation for `sync-models` |
| `src/components/admin/settings/ai/AiProvidersCard.tsx` | modify | Sync button and last-synced time in the provider dialog |
| `src/components/admin/SearchableModelPicker.tsx` | create | Searchable, vendor-grouped picker for large providers |
| `src/components/admin/settings/ai/SyncModelsButton.tsx` | create | Sync button and last-synced time, shown in the provider dialog |
| `supabase/functions/generate-image/modelChoice.ts` (+ test) | create | Pure: picks the requested model's row when several providers share an id |
| `supabase/functions/ai-generation-status/archiveBody.ts` (+ test) | create | Pure: upload body for a finished job, hosted URL or inline bytes |
| `src/components/admin/DefaultModelSelector.tsx` | modify | Uses the picker when a provider has more than 25 models in the section |
| `src/components/admin/AdminAiAgentSection.tsx` | modify | Adds `vercel` and `deepseek` to `AGENT_PROVIDER_CODES` |
| `src/components/admin/settings/ai/AiCategoryCards.tsx` | modify | "Try voice" on the TTS card |
| `src/components/post/VideoGenerator.tsx` | modify | Sends `provider_code` along with `model_id` |

---

### Task 1: Provider rows migration

**Files:**
- Create: `supabase/migrations/20260925120000_vercel_deepseek_providers.sql`

**Interfaces:**
- Produces: `ai_providers` rows `vercel` and `deepseek`, which every later task reads by `provider_code`.

- [ ] **Step 1: Write the migration**

```sql
-- Vercel AI Gateway and DeepSeek, both OpenAI-compatible. Models are not seeded
-- here: ai-config `sync-models` fills them from each provider's /models.
-- Keys are never stored in a migration; admins enter them through Save & Test.
INSERT INTO public.ai_providers
  (provider_code, name, api_endpoint, api_key_env_var, api_type, supports_streaming, is_active)
VALUES
  ('vercel',   'Vercel AI Gateway', 'https://ai-gateway.vercel.sh/v1', 'AI_GATEWAY_API_KEY', 'openai', true, true),
  ('deepseek', 'DeepSeek',          'https://api.deepseek.com',        'DEEPSEEK_API_KEY',   'openai', true, true)
ON CONFLICT (provider_code) DO UPDATE SET
  name = EXCLUDED.name,
  api_endpoint = EXCLUDED.api_endpoint,
  api_key_env_var = EXCLUDED.api_key_env_var,
  api_type = EXCLUDED.api_type,
  updated_at = now();
```

- [ ] **Step 2: Rehearse on Contabo inside a rolled-back transaction.** This migration has no self-committing statements, so an outer `BEGIN … ROLLBACK` is a valid rehearsal. Use the `/tmp/hgate` CR-stripped copy (memory: harness CRLF).

Run (ssh-contabo-mcp, stays under the 1000-char command cap):
```bash
C=$(docker ps --format '{{.Names}}'|grep -E 'postorasupabase.*db'|head -1); tr -d '\r' < /tmp/hgate/20260925120000_vercel_deepseek_providers.sql > /tmp/hgate/m.sql; docker cp /tmp/hgate/m.sql $C:/tmp/m.sql; docker exec $C psql -U supabase_admin -v ON_ERROR_STOP=1 -c 'BEGIN' -f /tmp/m.sql -c "select provider_code,api_type,api_endpoint from ai_providers where provider_code in ('vercel','deepseek')" -c 'ROLLBACK'
```
Expected: two rows printed, then `ROLLBACK`.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260925120000_vercel_deepseek_providers.sql
git commit -m "feat(ai): add Vercel AI Gateway and DeepSeek provider rows" -- supabase/migrations/20260925120000_vercel_deepseek_providers.sql
```

---

### Task 2: Pure catalogue mapping and sync planning

**Files:**
- Create: `supabase/functions/_shared/modelCatalogSync.ts`
- Test: `supabase/functions/_shared/modelCatalogSync.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type Capability = "chat" | "image" | "video" | "embedding" | "tts" | "stt";
  export interface CatalogModel {
    model_id: string; name: string; description: string | null; capabilities: Capability[];
    context_limit: number | null; cost_per_1m_input_tokens: number | null;
    cost_per_1m_output_tokens: number | null; metadata: Record<string, unknown>;
  }
  export interface MappedCatalog { models: CatalogModel[]; skippedByType: Record<string, number>; managedCapabilities: Capability[] }
  export interface ExistingModelRow { id: string; model_id: string; is_active: boolean; capabilities: string[]; metadata: Record<string, unknown> | null }
  export interface SyncPlan { inserts: CatalogModel[]; updates: Array<CatalogModel & { id: string; reactivate: boolean }>; deactivateIds: string[]; keptInUse: string[] }
  export const EMBEDDING_WIDTHS: Record<string, { native: number; requested?: number }>;
  export function mapVercelCatalog(data: unknown[]): MappedCatalog;
  export function mapOpenRouterCatalog(data: unknown[]): MappedCatalog;
  export function mapDeepSeekCatalog(data: unknown[]): MappedCatalog;
  export function planCatalogSync(existing: ExistingModelRow[], mapped: MappedCatalog, inUseModelIds: Set<string>): SyncPlan;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  mapDeepSeekCatalog, mapOpenRouterCatalog, mapVercelCatalog, planCatalogSync,
} from "./modelCatalogSync.ts";

const vercel = [
  { id: "openai/gpt-5.5", name: "GPT-5.5", description: "d", type: "language", context_window: 400000,
    pricing: { input: "0.00000125", output: "0.00001" } },
  { id: "openai/text-embedding-3-small", name: "Emb", type: "embedding", context_window: 0 },
  { id: "bfl/flux-2-pro", name: "FLUX.2 Pro", type: "image" },
  { id: "alibaba/wan-v2.6-i2v", name: "Wan i2v", type: "video", tags: ["i2v"] },
  { id: "openai/tts-1", name: "TTS", type: "speech" },
  { id: "openai/whisper-1", name: "Whisper", type: "transcription" },
  { id: "openai/gpt-realtime-2", name: "RT", type: "realtime" },
  { id: "cohere/rerank-v3.5", name: "Rerank", type: "reranking" },
  { id: "typesafe-ai/jev", name: "JEV", type: "evaluation" },
];

Deno.test("mapVercelCatalog assigns one capability per gateway type and skips unused types", () => {
  const mapped = mapVercelCatalog(vercel);
  const caps = Object.fromEntries(mapped.models.map((m) => [m.model_id, m.capabilities]));
  assertEquals(caps, {
    "openai/gpt-5.5": ["chat"],
    "openai/text-embedding-3-small": ["embedding"],
    "bfl/flux-2-pro": ["image"],
    "alibaba/wan-v2.6-i2v": ["video"],
    "openai/tts-1": ["tts"],
    "openai/whisper-1": ["stt"],
  });
  assertEquals(mapped.skippedByType, { realtime: 1, reranking: 1, evaluation: 1 });
  assertEquals(mapped.managedCapabilities.sort(), ["chat", "embedding", "image", "stt", "tts", "video"]);
});

Deno.test("mapVercelCatalog converts per-token pricing and keeps video tags", () => {
  const byId = Object.fromEntries(mapVercelCatalog(vercel).models.map((m) => [m.model_id, m]));
  assertEquals(byId["openai/gpt-5.5"].cost_per_1m_input_tokens, 1.25);
  assertEquals(byId["openai/gpt-5.5"].cost_per_1m_output_tokens, 10);
  assertEquals(byId["openai/gpt-5.5"].context_limit, 400000);
  assertEquals(byId["alibaba/wan-v2.6-i2v"].metadata.tags, ["i2v"]);
});

Deno.test("mapVercelCatalog records known embedding widths and leaves unknown ones unset", () => {
  const mapped = mapVercelCatalog([
    ...vercel,
    { id: "perplexity/pplx-embed-v1-4b", name: "pplx", type: "embedding" },
  ]);
  const byId = Object.fromEntries(mapped.models.map((m) => [m.model_id, m]));
  assertEquals(byId["openai/text-embedding-3-small"].metadata.embedding_dimensions, { native: 1536 });
  assertEquals(byId["perplexity/pplx-embed-v1-4b"].metadata.embedding_dimensions, undefined);
});

Deno.test("mapOpenRouterCatalog maps output modalities and manages only chat and image", () => {
  const mapped = mapOpenRouterCatalog([
    { id: "a/text", name: "T", context_length: 1000, pricing: { prompt: "0.000001", completion: "0.000002" },
      architecture: { output_modalities: ["text"] } },
    { id: "g/flash-image", name: "I", pricing: { prompt: "0", completion: "0" },
      architecture: { output_modalities: ["image", "text"] } },
    { id: "a/voice", name: "V", architecture: { output_modalities: ["text", "audio"] } },
  ]);
  const caps = Object.fromEntries(mapped.models.map((m) => [m.model_id, m.capabilities]));
  assertEquals(caps, { "a/text": ["chat"], "g/flash-image": ["image", "chat"], "a/voice": ["chat"] });
  assertEquals(mapped.managedCapabilities.sort(), ["chat", "image"]);
});

Deno.test("mapDeepSeekCatalog marks every id as chat", () => {
  const mapped = mapDeepSeekCatalog([{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }]);
  assertEquals(mapped.models.map((m) => [m.model_id, m.capabilities]), [
    ["deepseek-flash", ["chat"]], ["deepseek-v4-pro", ["chat"]],
  ]);
});

Deno.test("planCatalogSync inserts new, updates existing, and guards in-use and unmanaged rows", () => {
  const mapped = mapVercelCatalog(vercel.slice(0, 2));
  const plan = planCatalogSync([
    { id: "1", model_id: "openai/gpt-5.5", is_active: true, capabilities: ["chat"], metadata: null },
    { id: "2", model_id: "openai/gone", is_active: true, capabilities: ["chat"], metadata: null },
    { id: "3", model_id: "openai/gone-but-default", is_active: true, capabilities: ["chat"], metadata: null },
    { id: "4", model_id: "hand/seeded-embed", is_active: true, capabilities: ["search"], metadata: null },
  ], mapped, new Set(["openai/gone-but-default"]));
  assertEquals(plan.inserts.map((m) => m.model_id), ["openai/text-embedding-3-small"]);
  assertEquals(plan.updates.map((u) => [u.id, u.reactivate]), [["1", false]]);
  assertEquals(plan.deactivateIds, ["2"]);
  assertEquals(plan.keptInUse, ["openai/gone-but-default"]);
});

Deno.test("planCatalogSync reactivates only rows a previous sync switched off", () => {
  const mapped = mapVercelCatalog(vercel.slice(0, 1));
  const bySync = planCatalogSync([{ id: "1", model_id: "openai/gpt-5.5", is_active: false,
    capabilities: ["chat"], metadata: { sync_deactivated: true } }], mapped, new Set());
  const byAdmin = planCatalogSync([{ id: "1", model_id: "openai/gpt-5.5", is_active: false,
    capabilities: ["chat"], metadata: {} }], mapped, new Set());
  assertEquals(bySync.updates[0].reactivate, true);
  assertEquals(byAdmin.updates[0].reactivate, false);
});
```

- [ ] **Step 2: Run the tests and watch them fail**

Run: `deno test --allow-env --allow-read --no-check supabase/functions/_shared/modelCatalogSync.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// Pure: turns a provider's /models catalogue into ai_models rows and plans the
// DB diff. No I/O here — modelCatalogSyncRun.ts owns fetching and writing.

export type Capability = "chat" | "image" | "video" | "embedding" | "tts" | "stt";

export interface CatalogModel {
  model_id: string;
  name: string;
  description: string | null;
  capabilities: Capability[];
  context_limit: number | null;
  cost_per_1m_input_tokens: number | null;
  cost_per_1m_output_tokens: number | null;
  metadata: Record<string, unknown>;
}

export interface MappedCatalog {
  models: CatalogModel[];
  skippedByType: Record<string, number>;
  /** Capabilities this catalogue is authoritative for; rows outside them are never touched. */
  managedCapabilities: Capability[];
}

export interface ExistingModelRow {
  id: string;
  model_id: string;
  is_active: boolean;
  capabilities: string[];
  metadata: Record<string, unknown> | null;
}

export interface SyncPlan {
  inserts: CatalogModel[];
  updates: Array<CatalogModel & { id: string; reactivate: boolean }>;
  deactivateIds: string[];
  keptInUse: string[];
}

const VERCEL_TYPE_CAPABILITY: Record<string, Capability> = {
  language: "chat",
  image: "image",
  video: "video",
  embedding: "embedding",
  speech: "tts",
  transcription: "stt",
};

// The gateway catalogue carries no vector width. Widths below are the vendors'
// published defaults; `requested` is set only where the model accepts a
// `dimensions` parameter that lands it in a storable column. Anything not listed
// stays unselectable in the Embedding card ("unknown vector width") until a live
// call proves its width.
export const EMBEDDING_WIDTHS: Record<string, { native: number; requested?: number }> = {
  "openai/text-embedding-3-small": { native: 1536 },
  "openai/text-embedding-3-large": { native: 3072, requested: 1536 },
  "openai/text-embedding-ada-002": { native: 1536 },
  "google/gemini-embedding-001": { native: 3072, requested: 1536 },
  "cohere/embed-v4.0": { native: 1536 },
  "mistral/mistral-embed": { native: 1024 },
  "amazon/titan-embed-text-v2": { native: 1024 },
  "alibaba/qwen3-embedding-0.6b": { native: 1024 },
  "voyage/voyage-3-large": { native: 1024 },
  "voyage/voyage-3.5": { native: 1024 },
  "voyage/voyage-3.5-lite": { native: 1024 },
  "voyage/voyage-4": { native: 1024 },
  "voyage/voyage-4-large": { native: 1024 },
  "voyage/voyage-4-lite": { native: 1024 },
  "voyage/voyage-code-3": { native: 1024 },
};

type Row = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const positiveInt = (v: unknown): number | null => (typeof v === "number" && v > 0 ? v : null);
const perMillion = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? Math.round(n * 1e6 * 1e6) / 1e6 : null;
};

function baseModel(row: Row, capabilities: Capability[]): CatalogModel {
  const id = String(row.id);
  return {
    model_id: id,
    name: str(row.name) ?? id,
    description: str(row.description),
    capabilities,
    context_limit: positiveInt(row.context_window ?? row.context_length),
    cost_per_1m_input_tokens: null,
    cost_per_1m_output_tokens: null,
    metadata: {},
  };
}

export function mapVercelCatalog(data: unknown[]): MappedCatalog {
  const models: CatalogModel[] = [];
  const skippedByType: Record<string, number> = {};
  for (const raw of data) {
    const row = raw as Row;
    if (!str(row.id)) continue;
    const type = String(row.type ?? "");
    const capability = VERCEL_TYPE_CAPABILITY[type];
    if (!capability) {
      skippedByType[type] = (skippedByType[type] ?? 0) + 1;
      continue;
    }
    const model = baseModel(row, [capability]);
    const pricing = (row.pricing ?? {}) as Row;
    model.cost_per_1m_input_tokens = perMillion(pricing.input);
    model.cost_per_1m_output_tokens = perMillion(pricing.output);
    if (Array.isArray(row.tags) && row.tags.length) model.metadata.tags = row.tags;
    const width = EMBEDDING_WIDTHS[model.model_id];
    if (capability === "embedding" && width) model.metadata.embedding_dimensions = width;
    models.push(model);
  }
  return { models, skippedByType, managedCapabilities: Object.values(VERCEL_TYPE_CAPABILITY) };
}

export function mapOpenRouterCatalog(data: unknown[]): MappedCatalog {
  const models: CatalogModel[] = [];
  for (const raw of data) {
    const row = raw as Row;
    if (!str(row.id)) continue;
    const outputs = ((row.architecture as Row | undefined)?.output_modalities ?? []) as string[];
    const capabilities: Capability[] = [];
    if (outputs.includes("image")) capabilities.push("image");
    if (outputs.includes("text")) capabilities.push("chat");
    if (!capabilities.length) continue;
    const model = baseModel(row, capabilities);
    const pricing = (row.pricing ?? {}) as Row;
    model.cost_per_1m_input_tokens = perMillion(pricing.prompt);
    model.cost_per_1m_output_tokens = perMillion(pricing.completion);
    models.push(model);
  }
  // OpenRouter's /models lists no embedding models, so the embedding rows seeded
  // by hand (each verified live) are outside what this sync may deactivate.
  return { models, skippedByType: {}, managedCapabilities: ["chat", "image"] };
}

export function mapDeepSeekCatalog(data: unknown[]): MappedCatalog {
  const models = data
    .map((raw) => raw as Row)
    .filter((row) => str(row.id))
    .map((row) => baseModel(row, ["chat"]));
  return { models, skippedByType: {}, managedCapabilities: ["chat"] };
}

export function planCatalogSync(
  existing: ExistingModelRow[],
  mapped: MappedCatalog,
  inUseModelIds: Set<string>,
): SyncPlan {
  const found = new Map(mapped.models.map((m) => [m.model_id, m]));
  const known = new Map(existing.map((row) => [row.model_id, row]));
  const managed = new Set<string>(mapped.managedCapabilities);
  const plan: SyncPlan = { inserts: [], updates: [], deactivateIds: [], keptInUse: [] };

  for (const model of mapped.models) {
    const row = known.get(model.model_id);
    if (!row) {
      plan.inserts.push(model);
      continue;
    }
    const reactivate = !row.is_active && row.metadata?.sync_deactivated === true;
    plan.updates.push({ ...model, metadata: { ...(row.metadata ?? {}), ...model.metadata }, id: row.id, reactivate });
  }
  for (const row of existing) {
    if (!row.is_active || found.has(row.model_id)) continue;
    if (!row.capabilities.some((c) => managed.has(c))) continue;
    if (inUseModelIds.has(row.model_id)) plan.keptInUse.push(row.model_id);
    else plan.deactivateIds.push(row.id);
  }
  return plan;
}
```

- [ ] **Step 4: Run the tests and `deno check`**

Run: `deno test --allow-env --allow-read --no-check supabase/functions/_shared/modelCatalogSync.test.ts && deno check supabase/functions/_shared/modelCatalogSync.ts`
Expected: 7 passed, check clean.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ai): pure model catalogue mapping and sync planning" -- supabase/functions/_shared/modelCatalogSync.ts supabase/functions/_shared/modelCatalogSync.test.ts
```

---

### Task 3: Sync runner + `ai-config sync-models` action

**Files:**
- Create: `supabase/functions/_shared/modelCatalogSyncRun.ts`
- Test: `supabase/functions/_shared/modelCatalogSyncRun.test.ts`
- Modify: `supabase/functions/ai-config/index.ts` (POST branch, next to `check-service-key`)

**Interfaces:**
- Consumes: `mapVercelCatalog`, `mapOpenRouterCatalog`, `mapDeepSeekCatalog`, `planCatalogSync` (Task 2).
- Produces:
  ```ts
  export const SYNCABLE_PROVIDERS: readonly ["vercel", "openrouter", "deepseek"];
  export interface SyncReport { added: number; updated: number; deactivated: number; kept_in_use: string[]; skipped_by_type: Record<string, number>; synced_at: string }
  export async function runCatalogSync(db: any, providerCode: string, fetchImpl?: typeof fetch): Promise<SyncReport>;
  ```
  HTTP: `POST ai-config { action: "sync-models", provider_code }` → `SyncReport` (200) | `{ error }` (400/403/502).
  Last-synced time: `system_settings.key = 'model_catalog_synced_at_<provider_code>'`, value `{ "at": ISO }`.

- [ ] **Step 1: Write the failing test.** Use a fake admin that records writes, following the chain style in `aiFallbackSettings.test.ts`.

```ts
// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runCatalogSync } from "./modelCatalogSyncRun.ts";

function fakeDb(state: { models: any[]; settings: any[]; keys?: any[] }) {
  const writes: Array<{ table: string; op: string; payload: unknown }> = [];
  const from = (table: string) => {
    const q: any = { _filters: {} as Record<string, unknown> };
    q.select = () => q;
    q.eq = (c: string, v: unknown) => { q._filters[c] = v; return q; };
    q.like = () => q;
    q.in = (c: string, v: unknown) => { q._filters[c] = v; return q; };
    q.maybeSingle = async () => {
      if (table === "ai_providers") return { data: { id: "prov", provider_code: q._filters.provider_code, api_endpoint: "https://x", api_key_env_var: "NONE" }, error: null };
      if (table === "provider_api_keys") return { data: (state.keys ?? [])[0] ?? null, error: null };
      return { data: null, error: null };
    };
    q.then = (resolve: any) => resolve({ data: table === "ai_models" ? state.models : state.settings, error: null });
    q.insert = async (p: unknown) => { writes.push({ table, op: "insert", payload: p }); return { error: null }; };
    q.update = (p: unknown) => { writes.push({ table, op: "update", payload: p }); return q; };
    q.upsert = async (p: unknown) => { writes.push({ table, op: "upsert", payload: p }); return { error: null }; };
    return q;
  };
  return { db: { from }, writes };
}

const vercelFetch = (async () =>
  new Response(JSON.stringify({ data: [
    { id: "openai/gpt-5.5", name: "GPT-5.5", type: "language" },
    { id: "typesafe-ai/jev", name: "JEV", type: "evaluation" },
  ] }), { status: 200 })) as typeof fetch;

Deno.test("runCatalogSync reports added, skipped and in-use models", async () => {
  const { db, writes } = fakeDb({
    models: [{ id: "9", model_id: "openai/old-default", is_active: true, capabilities: ["chat"], metadata: null }],
    settings: [{ key: "default_ai_model_chat", value: { provider_code: "vercel", model_id: "openai/old-default" } }],
  });
  const report = await runCatalogSync(db, "vercel", vercelFetch);
  assertEquals([report.added, report.updated, report.deactivated], [1, 0, 0]);
  assertEquals(report.kept_in_use, ["openai/old-default"]);
  assertEquals(report.skipped_by_type, { evaluation: 1 });
  assertEquals(writes.some((w) => w.table === "system_settings" && w.op === "upsert"), true);
});

Deno.test("runCatalogSync refuses unknown providers and empty catalogues", async () => {
  const { db } = fakeDb({ models: [], settings: [] });
  await assertRejects(() => runCatalogSync(db, "claude", vercelFetch), Error, "not syncable");
  const empty = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as typeof fetch;
  await assertRejects(() => runCatalogSync(db, "vercel", empty), Error, "empty model catalogue");
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `deno test --allow-env --allow-read --no-check supabase/functions/_shared/modelCatalogSyncRun.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the runner**

```ts
// deno-lint-ignore-file no-explicit-any
import {
  type MappedCatalog, mapDeepSeekCatalog, mapOpenRouterCatalog, mapVercelCatalog, planCatalogSync,
} from "./modelCatalogSync.ts";

export const SYNCABLE_PROVIDERS = ["vercel", "openrouter", "deepseek"] as const;

export interface SyncReport {
  added: number;
  updated: number;
  deactivated: number;
  kept_in_use: string[];
  skipped_by_type: Record<string, number>;
  synced_at: string;
}

const CATALOGUE: Record<string, { url: string; needsKey: boolean; map: (d: unknown[]) => MappedCatalog }> = {
  vercel: { url: "https://ai-gateway.vercel.sh/v1/models", needsKey: false, map: mapVercelCatalog },
  openrouter: { url: "https://openrouter.ai/api/v1/models", needsKey: false, map: mapOpenRouterCatalog },
  deepseek: { url: "https://api.deepseek.com/models", needsKey: true, map: mapDeepSeekCatalog },
};

async function providerKey(db: any, provider: { provider_code: string; api_key_env_var: string }) {
  const fromEnv = Deno.env.get(provider.api_key_env_var);
  if (fromEnv) return fromEnv;
  const { data } = await db.from("provider_api_keys").select("api_key")
    .eq("provider_code", provider.provider_code).maybeSingle();
  return data?.api_key ?? null;
}

export async function runCatalogSync(db: any, providerCode: string, fetchImpl: typeof fetch = fetch): Promise<SyncReport> {
  const source = CATALOGUE[providerCode];
  if (!source) throw new Error(`Provider ${providerCode} is not syncable`);
  const { data: provider } = await db.from("ai_providers")
    .select("id, provider_code, api_key_env_var").eq("provider_code", providerCode).maybeSingle();
  if (!provider) throw new Error(`Provider ${providerCode} is missing`);

  const headers: Record<string, string> = {};
  if (source.needsKey) {
    const key = await providerKey(db, provider);
    if (!key) throw new Error(`API key ${provider.api_key_env_var} not configured`);
    headers.Authorization = `Bearer ${key}`;
  }
  const res = await fetchImpl(source.url, { headers, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`${providerCode} /models returned HTTP ${res.status}`);
  const body = await res.json();
  const mapped = source.map(Array.isArray(body?.data) ? body.data : []);
  if (!mapped.models.length) throw new Error(`${providerCode} returned an empty model catalogue`);

  const { data: existing, error: existingError } = await db.from("ai_models")
    .select("id, model_id, is_active, capabilities, metadata").eq("provider_id", provider.id);
  if (existingError) throw new Error("ai_models read failed");
  const { data: settings, error: settingsError } = await db.from("system_settings")
    .select("key, value").like("key", "default_ai_model%");
  if (settingsError) throw new Error("system_settings read failed");
  const inUse = new Set<string>();
  for (const s of settings ?? []) {
    const v = typeof s.value === "string" ? JSON.parse(s.value) : s.value;
    if (v?.provider_code === providerCode && v?.model_id) inUse.add(v.model_id);
  }

  const plan = planCatalogSync(existing ?? [], mapped, inUse);
  const row = (m: typeof plan.inserts[number]) => ({
    provider_id: provider.id, model_id: m.model_id, name: m.name, description: m.description,
    capabilities: m.capabilities, context_limit: m.context_limit,
    cost_per_1m_input_tokens: m.cost_per_1m_input_tokens, cost_per_1m_output_tokens: m.cost_per_1m_output_tokens,
    metadata: m.metadata,
  });
  if (plan.inserts.length) {
    const { error } = await db.from("ai_models").insert(plan.inserts.map((m) => ({ ...row(m), is_active: true })));
    if (error) throw new Error(`ai_models insert failed: ${error.message}`);
  }
  for (const u of plan.updates) {
    const patch: Record<string, unknown> = { ...row(u), updated_at: new Date().toISOString() };
    if (u.reactivate) {
      patch.is_active = true;
      patch.metadata = { ...u.metadata, sync_deactivated: false };
    }
    const { error } = await db.from("ai_models").update(patch).eq("id", u.id);
    if (error) throw new Error(`ai_models update failed: ${error.message}`);
  }
  for (const id of plan.deactivateIds) {
    const current = (existing ?? []).find((r: any) => r.id === id);
    const { error } = await db.from("ai_models")
      .update({ is_active: false, metadata: { ...(current?.metadata ?? {}), sync_deactivated: true } }).eq("id", id);
    if (error) throw new Error(`ai_models deactivate failed: ${error.message}`);
  }
  const synced_at = new Date().toISOString();
  await db.from("system_settings").upsert(
    { key: `model_catalog_synced_at_${providerCode}`, value: { at: synced_at } }, { onConflict: "key" },
  );
  return {
    added: plan.inserts.length, updated: plan.updates.length, deactivated: plan.deactivateIds.length,
    kept_in_use: plan.keptInUse, skipped_by_type: mapped.skippedByType, synced_at,
  };
}
```

The spec asks for a sync that writes nothing if it fails partway. Postgres batch semantics give that for the insert; per-row updates are not atomic. **Accepted trade-off:** the updates are idempotent, so rerunning the sync converges. Record this in the PR description.

- [ ] **Step 4: Wire the action** in `ai-config/index.ts` (add the import at the top; put the branch before the final `Unknown action`):

```ts
import { runCatalogSync, SYNCABLE_PROVIDERS } from '../_shared/modelCatalogSyncRun.ts';
```
```ts
      if (resolvedAction === 'sync-models') {
        if (!isAdmin) return new Response(JSON.stringify({ error: 'Admin required' }), { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        const { provider_code } = body;
        if (!(SYNCABLE_PROVIDERS as readonly string[]).includes(provider_code)) {
          return new Response(JSON.stringify({ error: 'Provider does not support model sync' }), { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
        try {
          const report = await runCatalogSync(supabase, provider_code);
          return new Response(JSON.stringify(report), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (e: any) {
          // Upstream catalogue failure, not an app error: 502 would be masked by Cloudflare,
          // so answer 200 with an error body the UI shows as a toast.
          return new Response(JSON.stringify({ error: e.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
      }
```

- [ ] **Step 5: Run the tests and `deno check`**

Run: `deno test --allow-env --allow-read --no-check supabase/functions/_shared/modelCatalogSyncRun.test.ts && deno check supabase/functions/_shared/modelCatalogSyncRun.ts supabase/functions/ai-config/index.ts`
Expected: 2 passed, check clean.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(ai): sync-models action for Vercel, OpenRouter and DeepSeek catalogues" -- supabase/functions/_shared/modelCatalogSyncRun.ts supabase/functions/_shared/modelCatalogSyncRun.test.ts supabase/functions/ai-config/index.ts
```

---

### Task 4: Test card that uses a real model and explains gateway billing errors

**Files:**
- Create: `supabase/functions/_shared/providerErrors.ts`, `supabase/functions/_shared/providerErrors.test.ts`
- Modify: `supabase/functions/ai-config/index.ts`: `handleRes`, `testOpenAI`, plus the three call sites in `test-connection`, `set-service-key` and `test-service`

**Why `set-service-key` changes too:** it saves the key only after the test passes. The gateway answers 403 `customer_verification_required` until a card is on file, so without this change the Vercel key could never be saved, and *Test* would have no key to use. A billing-blocked answer proves the key authenticates, so the key is saved and the response carries a warning.

**Interfaces:**
- Produces: `export function describeProviderFailure(name: string, status: number, bodyText: string): string`
- Produces: `export function isBillingBlocked(status: number, bodyText: string): boolean`
- Produces: `export class ProviderTestError extends Error { status: number; body: string }`, thrown by `handleRes`
- `set-service-key` response: `{ success: true, latency, warning?: string }`. `warning` is set when the key was saved but the account is billing-blocked.
- Produces: `testOpenAI(key: string, ep: string, model: string)`, where the model now comes from `defaultTestModel(db, provider)`

- [ ] **Step 1: Failing test**

```ts
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { describeProviderFailure, isBillingBlocked } from "./providerErrors.ts";

Deno.test("gateway billing block reads as a valid key that needs a card", () => {
  const body = JSON.stringify({ error: { type: "customer_verification_required", message: "AI Gateway requires a valid credit card" } });
  assertEquals(describeProviderFailure("Vercel AI Gateway", 403, body),
    "Key is valid — add a credit card to your Vercel team (AI Gateway) to enable requests");
});

Deno.test("isBillingBlocked recognises only the gateway verification 403", () => {
  assertEquals(isBillingBlocked(403, '{"error":{"type":"customer_verification_required"}}'), true);
  assertEquals(isBillingBlocked(403, '{"error":{"type":"forbidden"}}'), false);
  assertEquals(isBillingBlocked(401, "customer_verification_required"), false);
});

Deno.test("401 and generic 403 keep their existing messages", () => {
  assertEquals(describeProviderFailure("X", 401, "{}"), "Invalid API key");
  assertEquals(describeProviderFailure("X", 403, "{}"), "API key lacks required permissions");
});

Deno.test("429 balance errors and JSON messages are surfaced", () => {
  assertEquals(describeProviderFailure("X", 429, "insufficient_balance"),
    "API key is valid, but the account has insufficient balance. Please top up your account.");
  assertEquals(describeProviderFailure("X", 429, "{}"), "Rate limit exceeded");
  assertEquals(describeProviderFailure("X", 400, JSON.stringify({ error: { message: "bad model" } })), "X: bad model");
  assertEquals(describeProviderFailure("X", 500, "<html>"), "X API error: 500");
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `deno test --allow-env --allow-read --no-check supabase/functions/_shared/providerErrors.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement.** This moves the logic out of `handleRes` unchanged and adds the gateway case:

```ts
// The gateway authenticated the key but refuses inference until billing is set up.
export function isBillingBlocked(status: number, bodyText: string): boolean {
  return status === 403 && bodyText.includes("customer_verification_required");
}

export class ProviderTestError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) {
    super(message);
  }
}

// Maps a provider's failed HTTP response to the message the admin Test card shows.
export function describeProviderFailure(name: string, status: number, bodyText: string): string {
  if (isBillingBlocked(status, bodyText)) {
    return "Key is valid — add a credit card to your Vercel team (AI Gateway) to enable requests";
  }
  if (status === 401) return "Invalid API key";
  if (status === 403) return "API key lacks required permissions";
  if (status === 429) {
    if (bodyText.includes("insufficient_balance") || bodyText.includes("1008")) {
      return "API key is valid, but the account has insufficient balance. Please top up your account.";
    }
    return "Rate limit exceeded";
  }
  try {
    const parsed = JSON.parse(bodyText);
    const message = parsed?.error?.message || parsed?.message || parsed?.error;
    if (typeof message === "string" && message) return `${name}: ${message}`;
  } catch { /* not JSON */ }
  return `${name} API error: ${status}`;
}
```

In `ai-config/index.ts`, replace the body of `handleRes`:

```ts
import { describeProviderFailure, isBillingBlocked, ProviderTestError } from '../_shared/providerErrors.ts';

async function handleRes(res: Response, name: string) {
  if (res.ok) return;
  const t = await res.text();
  console.error(`${name} test failed: ${res.status} - ${t.slice(0, 300)}`);
  throw new ProviderTestError(describeProviderFailure(name, res.status, t), res.status, t);
}
```

In `set-service-key`, wrap the provider test so a billing-blocked key is still saved. Replace `const latency = Date.now() - startTime;` and the upsert/return that follow with:

```ts
          const latency = Date.now() - startTime;
          await saveKey();
          return new Response(JSON.stringify({ success: true, latency }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        } catch (e: any) {
          if (e instanceof ProviderTestError && isBillingBlocked(e.status, e.body)) {
            await saveKey();
            return new Response(JSON.stringify({ success: true, latency: Date.now() - startTime, warning: e.message }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
          }
          return new Response(JSON.stringify({ success: false, error: e.message, latency: Date.now() - startTime }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
        }
```
with `saveKey` declared before the `try`:
```ts
        const saveKey = async () => {
          const { error: upsertErr } = await supabase.from('provider_api_keys').upsert(
            { provider_code, api_key, created_by: user.id, updated_at: new Date().toISOString() },
            { onConflict: 'provider_code' },
          );
          if (upsertErr) throw new Error(upsertErr.message);
        };
```

In `AiProvidersCard.tsx` `handleSaveProviderKey`, show the warning:
```ts
      if (r.success) {
        if (r.warning) toast.warning(`API key saved. ${r.warning}`);
        else toast.success(`API key saved & validated (${r.latency}ms)`);
```
and add `warning?: string` to the `setServiceKey` result type in `useAIConfiguration.ts`.

Make `testOpenAI` take the model to test with, and add a lookup that picks it:

```ts
async function testOpenAI(key: string, ep: string, model: string) {
  const url = ep.replace(/\/$/, '') + '/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
  });
  await handleRes(res, 'OpenAI');
}

// The gateway and OpenRouter namespace ids by vendor; a bare "gpt-4o-mini" is
// rejected there, so test with a chat model the provider actually lists.
const TEST_MODEL_OVERRIDE: Record<string, string> = { vercel: 'openai/gpt-4o-mini', openrouter: 'openai/gpt-4o-mini', deepseek: 'deepseek-flash' };
async function defaultTestModel(db: any, provider: { id: string; provider_code: string }): Promise<string> {
  if (TEST_MODEL_OVERRIDE[provider.provider_code]) return TEST_MODEL_OVERRIDE[provider.provider_code];
  const { data } = await db.from('ai_models').select('model_id').eq('provider_id', provider.id)
    .eq('is_active', true).contains('capabilities', ['chat']).order('name').limit(1).maybeSingle();
  return data?.model_id ?? 'gpt-4o-mini';
}
```

Update all three `else await testOpenAI(...)` call sites. `test-service` and `set-service-key` have the full `provider` row; `test-connection` has it too:
```ts
await testOpenAI(apiKey, provider.api_endpoint, await defaultTestModel(supabase, provider));
```

- [ ] **Step 4: Run the tests and `deno check`**

Run: `deno test --allow-env --allow-read --no-check supabase/functions/_shared/providerErrors.test.ts && deno check supabase/functions/ai-config/index.ts`
Expected: 4 passed, check clean. Then run `npx tsc -b --noEmit`.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ai): provider test uses a listed model; save billing-blocked gateway keys with a warning" -- supabase/functions/_shared/providerErrors.ts supabase/functions/_shared/providerErrors.test.ts supabase/functions/ai-config/index.ts src/components/admin/settings/ai/AiProvidersCard.tsx src/hooks/useAIConfiguration.ts
```

---

### Task 5: Data-driven endpoint for OpenAI-compatible chat providers

**Files:**
- Create: `supabase/functions/_shared/providerEndpoint.ts`, `supabase/functions/_shared/providerEndpoint.test.ts`
- Modify: `supabase/functions/_shared/ai-fallback.ts` (`getAiEndpoint`, `resolvePlatformApiKey`, `callAiChain`)
- Test: add a case to `supabase/functions/_shared/ai-fallback-chain.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const BUILTIN_CHAT_PROVIDERS: ReadonlySet<string>; // claude, openai, openrouter, xai, google, gemini, lovable
  export const PROVIDER_KEY_ENV: Readonly<Record<string, string>>; // vercel→AI_GATEWAY_API_KEY, deepseek→DEEPSEEK_API_KEY
  export async function loadOpenAiCompatibleBase(admin: any, providerCode: string): Promise<string | null>;
  export function clearProviderEndpointCache(): void; // tests only
  ```
- Changes: `getAiEndpoint(provider: string, suppliedKey?: string, baseUrl?: string): AiEndpoint`

- [ ] **Step 1: Failing tests**

`providerEndpoint.test.ts`:
```ts
// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { clearProviderEndpointCache, loadOpenAiCompatibleBase } from "./providerEndpoint.ts";

const adminReturning = (row: any, calls: string[] = []) => ({
  from: (t: string) => {
    calls.push(t);
    const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: row, error: null }) };
    return q;
  },
});

Deno.test("returns the trimmed base for an active openai-type provider and caches it", async () => {
  clearProviderEndpointCache();
  const calls: string[] = [];
  const admin = adminReturning({ api_endpoint: "https://ai-gateway.vercel.sh/v1/", api_type: "openai", is_active: true }, calls);
  assertEquals(await loadOpenAiCompatibleBase(admin, "vercel"), "https://ai-gateway.vercel.sh/v1");
  assertEquals(await loadOpenAiCompatibleBase(admin, "vercel"), "https://ai-gateway.vercel.sh/v1");
  assertEquals(calls.length, 1);
});

Deno.test("returns null for inactive, non-openai or missing providers", async () => {
  clearProviderEndpointCache();
  assertEquals(await loadOpenAiCompatibleBase(adminReturning({ api_endpoint: "x", api_type: "openai", is_active: false }), "a"), null);
  assertEquals(await loadOpenAiCompatibleBase(adminReturning({ api_endpoint: "x", api_type: "anthropic", is_active: true }), "b"), null);
  assertEquals(await loadOpenAiCompatibleBase(adminReturning(null), "c"), null);
});
```

In `ai-fallback-chain.test.ts`, add a test that follows that file's existing fake-fetch pattern. The case: `callAiChain` with a `vercel` tier, an admin whose `ai_providers` row is `https://ai-gateway.vercel.sh/v1`, and a `provider_api_keys` key `k`. The fake fetch must receive `https://ai-gateway.vercel.sh/v1/chat/completions` with `Authorization: Bearer k`, and the result's `providerUsed` is `'vercel'`. Assert on the URL the fake fetch captured.

- [ ] **Step 2: Run the tests and confirm they fail**

Run: `deno test --allow-env --allow-net --allow-read --no-check supabase/functions/_shared/providerEndpoint.test.ts supabase/functions/_shared/ai-fallback-chain.test.ts`
Expected: FAIL (module missing; the vercel tier goes to Google).

- [ ] **Step 3: Implement `providerEndpoint.ts`**

```ts
// deno-lint-ignore-file no-explicit-any
// Providers whose chat URL is hardcoded in getAiEndpoint. Everything else with
// api_type='openai' is reached through its ai_providers.api_endpoint.
export const BUILTIN_CHAT_PROVIDERS: ReadonlySet<string> = new Set([
  "claude", "openai", "openrouter", "xai", "google", "gemini", "lovable",
]);

// Env fallbacks for data-driven providers (provider_api_keys is checked first).
export const PROVIDER_KEY_ENV: Readonly<Record<string, string>> = {
  vercel: "AI_GATEWAY_API_KEY",
  deepseek: "DEEPSEEK_API_KEY",
};

const cache = new Map<string, string | null>();

export function clearProviderEndpointCache(): void {
  cache.clear();
}

// callAiWithFallback (ai-email-assistant, analyze-log, suggest-best-times) calls
// callAiChain without a client. Rather than skipping data-driven providers there,
// read the provider row with a service-role client of our own. ai_providers holds
// no secrets.
async function serviceClient(): Promise<any> {
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  return createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
}

export async function loadOpenAiCompatibleBase(admin: any | undefined, providerCode: string): Promise<string | null> {
  if (cache.has(providerCode)) return cache.get(providerCode)!;
  const db = admin ?? await serviceClient();
  const { data, error } = await db.from("ai_providers")
    .select("api_endpoint, api_type, is_active").eq("provider_code", providerCode).maybeSingle();
  if (error) throw new Error("AI provider read failed");
  const base = data && data.is_active && data.api_type === "openai" && typeof data.api_endpoint === "string"
    ? data.api_endpoint.replace(/\/+$/, "")
    : null;
  cache.set(providerCode, base);
  return base;
}
```

In `ai-fallback.ts`:
1. Import `BUILTIN_CHAT_PROVIDERS, PROVIDER_KEY_ENV, loadOpenAiCompatibleBase` from `./providerEndpoint.ts`.
2. Change the signature to `getAiEndpoint(provider: string, suppliedKey?: string, baseUrl?: string)` and insert this before the `// Default: Google AI Studio direct` block:
```ts
  if (baseUrl && !BUILTIN_CHAT_PROVIDERS.has(provider)) {
    const apiKey = suppliedKey ?? Deno.env.get(PROVIDER_KEY_ENV[provider] ?? '') ?? '';
    return { apiUrl: `${baseUrl}/chat/completions`, apiKey,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' } };
  }
```
3. In `resolvePlatformApiKey`, replace the last line with:
```ts
  if (PROVIDER_KEY_ENV[provider]) return Deno.env.get(PROVIDER_KEY_ENV[provider]) ?? '';
  return getAiEndpoint(provider).apiKey;
```
4. In `callAiChain`, just before `const endpoint = getAiEndpoint(...)`:
```ts
      let baseUrl: string | undefined;
      if (!BUILTIN_CHAT_PROVIDERS.has(tier.provider)) {
        const base = await loadOpenAiCompatibleBase(admin, tier.provider);
        if (!base) { attempt.error = 'Provider endpoint not configured'; continue; }
        baseUrl = base;
      }
      const endpoint = getAiEndpoint(tier.provider, apiKey, baseUrl);
```
This goes inside the existing `try`, so a DB error is caught per tier.

**Behaviour change to put in the PR body:** `perplexity`, `zai` and `minimax` chat tiers currently fall through to the Google URL. After this task they reach their own `api_endpoint`, which fixes them.

**Keys for callers without a client:** `resolvePlatformApiKey(undefined, 'vercel')` finds only the env var (`AI_GATEWAY_API_KEY`). That is why Task 15 sets the env var as well as the DB key.

- [ ] **Step 4: Run the tests (the whole `_shared` folder, to catch regressions) and `deno check`**

Run: `deno test --allow-env --allow-net --allow-read --allow-write --no-check --node-modules-dir=auto supabase/functions/_shared/ && deno check supabase/functions/_shared/providerEndpoint.ts supabase/functions/_shared/ai-fallback.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ai): route OpenAI-compatible providers through ai_providers.api_endpoint" -- supabase/functions/_shared/providerEndpoint.ts supabase/functions/_shared/providerEndpoint.test.ts supabase/functions/_shared/ai-fallback.ts supabase/functions/_shared/ai-fallback-chain.test.ts
```

---

### Task 6: AI Agent can use `vercel` and `deepseek`

**Files:**
- Modify: `supabase/functions/ai-agent-reply/logic.ts:55`, `supabase/functions/ai-agent-reply/index.ts:137-140`
- Modify: `src/components/admin/AdminAiAgentSection.tsx:18`
- Test: `supabase/functions/ai-agent-reply/providerChain.test.ts`

**Interfaces:**
- Consumes: `loadOpenAiCompatibleBase` (Task 5).

- [ ] **Step 1: Failing test** (append to `providerChain.test.ts`):

```ts
Deno.test("parseModelRef keeps vendor-prefixed gateway ids intact", () => {
  assertEquals(parseModelRef("vercel/openai/gpt-5.5"), { provider: "vercel", model: "openai/gpt-5.5" });
  assertEquals(parseModelRef("deepseek/deepseek-flash"), { provider: "deepseek", model: "deepseek-flash" });
});
```

- [ ] **Step 2: Run it and confirm it fails.** `deno test --allow-env --allow-read --no-check supabase/functions/ai-agent-reply/providerChain.test.ts`. Expected: FAIL, provider parsed as `openai`.

- [ ] **Step 3: Implement**

`logic.ts`:
```ts
export const KNOWN_MODEL_PROVIDERS = ["openai", "openrouter", "google", "gemini", "claude", "vercel", "deepseek"] as const;
```
`index.ts` in `chatCompletion`: import `loadOpenAiCompatibleBase` from `../_shared/providerEndpoint.ts`, then replace the endpoint line:
```ts
  let endpoint = PROVIDER_ENDPOINTS[provider];
  if (!endpoint) {
    const base = await loadOpenAiCompatibleBase(admin, provider);
    // Only the legacy bare-id case ("gpt-4o" parsed as openai) may fall back to OpenAI;
    // a named provider without a usable row must fail, not send its key to OpenAI.
    if (!base) throw new Error(`${provider}: provider endpoint not configured`);
    endpoint = { url: `${base}/chat/completions`, keyEnv: "" };
  }
```
Update the comment above `PROVIDER_ENDPOINTS`: providers not listed there resolve through `ai_providers` (`providerEndpoint.ts`).
`AdminAiAgentSection.tsx:18`: add `'vercel', 'deepseek'` to `AGENT_PROVIDER_CODES`.

- [ ] **Step 4: Run the tests.** `deno test --allow-env --allow-net --allow-read --no-check supabase/functions/ai-agent-reply/ && deno check supabase/functions/ai-agent-reply/index.ts`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(agent): allow Vercel AI Gateway and DeepSeek in the agent model chain" -- supabase/functions/ai-agent-reply/logic.ts supabase/functions/ai-agent-reply/index.ts supabase/functions/ai-agent-reply/providerChain.test.ts src/components/admin/AdminAiAgentSection.tsx
```

---

### Task 7: Vercel embeddings

**Files:**
- Modify: `supabase/functions/_shared/knowledgeEmbeddings.ts` (lines 7-20 constants, `EmbeddingProvider` at 37, `selectionConfig` at 278, `embedKnowledge` at 665)
- Test: `supabase/functions/_shared/knowledgeEmbeddings.test.ts`

**Interfaces:**
- Produces: `EmbeddingProvider` now includes `"vercel"`, and `resolveAdminEmbeddingLadder` accepts `provider_code: 'vercel'`.

- [ ] **Step 1: Failing test.** Add a case to the existing ladder tests: a primary selection `{ provider_code: "vercel", model_id: "openai/text-embedding-3-small" }` with a catalogue row whose `metadata.embedding_dimensions = { native: 1536 }` resolves to `{ provider: "vercel", column: <the 1536 column name used by the neighbouring tests>, dimensions: 1536, model: "openai/text-embedding-3-small" }`. Copy the fixture shape from the neighbouring `openrouter` test in the same file.

- [ ] **Step 2: Run it and confirm it fails.** Expected: throws `No embedding caller for provider vercel`.

- [ ] **Step 3: Implement**

```ts
// Vercel AI Gateway speaks the OpenAI embeddings dialect; model ids carry the
// vendor ("openai/text-embedding-3-small"). Its key is read from the env like
// every other embedding provider: set AI_GATEWAY_API_KEY in the stack .env.
const VERCEL_ENDPOINT = "https://ai-gateway.vercel.sh/v1/embeddings";
```
```ts
export type EmbeddingProvider = "gemini" | "ollama" | "openai" | "openrouter" | "jina" | "vercel";
```
In `selectionConfig`:
```ts
  if (selection.provider_code === "openrouter" || selection.provider_code === "jina" || selection.provider_code === "vercel") {
```
Add:
```ts
function embedWithVercel(texts: string[], config: EmbeddingConfig): Promise<number[][]> {
  return embedWithOpenAiCompatible(texts, config, {
    endpoint: VERCEL_ENDPOINT,
    keyEnvVar: "AI_GATEWAY_API_KEY",
    label: "Vercel AI Gateway",
  });
}
```
In `embedKnowledge`: `if (config.provider === "vercel") return embedWithVercel(texts, config);`

- [ ] **Step 4: Run the tests.** `deno test --allow-env --allow-read --no-check supabase/functions/_shared/ && deno check supabase/functions/_shared/knowledgeEmbeddings.ts`. Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(knowledge): embed through Vercel AI Gateway" -- supabase/functions/_shared/knowledgeEmbeddings.ts supabase/functions/_shared/knowledgeEmbeddings.test.ts
```

---

### Task 8: `_shared/vercelGateway.ts` — the single AI SDK boundary

**Files:**
- Create: `supabase/functions/_shared/vercelGateway.ts`, `supabase/functions/_shared/vercelGateway.test.ts`

**Interfaces:**
- Consumes: `JobSnapshot` from `./higgsfield-job-payload.ts` (`{ state, status, outputUrl, error, pollAfterSeconds }`).
- Produces:
  ```ts
  export interface VercelVideoSnapshot extends JobSnapshot { outputBase64: string | null; outputMediaType: string | null }
  export type VideoStatusLike =
    | { status: "pending" }
    | { status: "completed"; videos: Array<{ type: "url"; url: string; mediaType: string } | { type: "base64"; data: string; mediaType: string } | { type: "binary"; data: Uint8Array; mediaType?: string }> }
    | { status: "error"; error: string };
  export function toVideoSnapshot(status: VideoStatusLike): VercelVideoSnapshot;       // pure
  export async function resolveVercelKey(db: any): Promise<string | null>;
  export async function vercelGenerateImage(apiKey: string, modelId: string, prompt: string, aspectRatio: string): Promise<{ imageUrl: string; description: string }>;
  export async function vercelStartVideo(apiKey: string, modelId: string, input: { prompt: string; duration?: number; aspectRatio?: string; imageUrl?: string }): Promise<{ operation: unknown; gatewayJobId: string | null }>;
  export async function vercelVideoStatus(apiKey: string, modelId: string, operation: unknown): Promise<VercelVideoSnapshot>;
  export async function vercelGenerateSpeech(apiKey: string, modelId: string, text: string, voice?: string, outputFormat?: string): Promise<{ base64: string; mediaType: string }>;
  export async function vercelTranscribe(apiKey: string, modelId: string, audio: Uint8Array): Promise<{ transcript: string; language: string; duration: number }>;
  ```

- [ ] **Step 1: Failing test for the pure mapper and the key resolver**

```ts
// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { resolveVercelKey, toVideoSnapshot } from "./vercelGateway.ts";

Deno.test("pending maps to running with a poll delay", () => {
  const s = toVideoSnapshot({ status: "pending" });
  assertEquals([s.state, s.pollAfterSeconds, s.outputUrl], ["running", 10, null]);
});

Deno.test("completed with a hosted url maps to succeeded with that url", () => {
  const s = toVideoSnapshot({ status: "completed", videos: [{ type: "url", url: "https://cdn/x.mp4", mediaType: "video/mp4" }] });
  assertEquals([s.state, s.outputUrl, s.outputBase64], ["succeeded", "https://cdn/x.mp4", null]);
});

Deno.test("completed with inline bytes carries base64 for archiving", () => {
  const b64 = toVideoSnapshot({ status: "completed", videos: [{ type: "base64", data: "AAAA", mediaType: "video/mp4" }] });
  assertEquals([b64.state, b64.outputBase64, b64.outputMediaType], ["succeeded", "AAAA", "video/mp4"]);
  const bin = toVideoSnapshot({ status: "completed", videos: [{ type: "binary", data: new Uint8Array([0, 0, 0]) }] });
  assertEquals([bin.outputBase64, bin.outputMediaType], ["AAAA", "video/mp4"]);
});

Deno.test("error and empty completions map to failed", () => {
  assertEquals(toVideoSnapshot({ status: "error", error: "boom" }).error, "boom");
  assertEquals(toVideoSnapshot({ status: "completed", videos: [] }).state, "failed");
});

Deno.test("resolveVercelKey prefers env, then provider_api_keys", async () => {
  const db = { from: () => { const q: any = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { api_key: "db-key" } }) }; return q; } };
  Deno.env.delete("AI_GATEWAY_API_KEY");
  assertEquals(await resolveVercelKey(db), "db-key");
  Deno.env.set("AI_GATEWAY_API_KEY", "env-key");
  assertEquals(await resolveVercelKey(db), "env-key");
  Deno.env.delete("AI_GATEWAY_API_KEY");
});
```

- [ ] **Step 2: Run it and confirm it fails.** `deno test --allow-env --allow-net --allow-read --no-check --node-modules-dir=auto supabase/functions/_shared/vercelGateway.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

```ts
// deno-lint-ignore-file no-import-prefix no-explicit-any
// The only module that imports the AI SDK. Image, video, speech and transcription
// on the gateway are not plain OpenAI endpoints; the SDK owns their wire format.
import { createGateway } from "npm:@ai-sdk/gateway@4.0.92";
import {
  experimental_getVideoStatus, experimental_startVideo, generateImage, generateSpeech, transcribe,
} from "npm:ai@7.0.114";
import { encodeBase64 } from "https://deno.land/std@0.208.0/encoding/base64.ts";
import type { JobSnapshot } from "./higgsfield-job-payload.ts";

export interface VercelVideoSnapshot extends JobSnapshot {
  outputBase64: string | null;
  outputMediaType: string | null;
}

export type VideoStatusLike =
  | { status: "pending" }
  | { status: "completed"; videos: Array<
      | { type: "url"; url: string; mediaType: string }
      | { type: "base64"; data: string; mediaType: string }
      | { type: "binary"; data: Uint8Array; mediaType?: string }> }
  | { status: "error"; error: string };

const gatewayFor = (apiKey: string) => createGateway({ apiKey });

export async function resolveVercelKey(db: any): Promise<string | null> {
  const fromEnv = Deno.env.get("AI_GATEWAY_API_KEY");
  if (fromEnv) return fromEnv;
  const { data } = await db.from("provider_api_keys").select("api_key").eq("provider_code", "vercel").maybeSingle();
  return data?.api_key ?? null;
}

export function toVideoSnapshot(status: VideoStatusLike): VercelVideoSnapshot {
  const base = { outputUrl: null, outputBase64: null, outputMediaType: null, error: null, pollAfterSeconds: 10 };
  if (status.status === "pending") return { ...base, state: "running", status: "pending" } as VercelVideoSnapshot;
  if (status.status === "error") return { ...base, state: "failed", status: "error", error: status.error } as VercelVideoSnapshot;
  const video = status.videos[0];
  if (!video) return { ...base, state: "failed", status: "completed", error: "Gateway returned no video" } as VercelVideoSnapshot;
  if (video.type === "url") return { ...base, state: "succeeded", status: "completed", outputUrl: video.url, outputMediaType: video.mediaType } as VercelVideoSnapshot;
  const b64 = video.type === "base64" ? video.data : encodeBase64(video.data);
  return { ...base, state: "succeeded", status: "completed", outputBase64: b64, outputMediaType: video.mediaType ?? "video/mp4" } as VercelVideoSnapshot;
}

export async function vercelGenerateImage(apiKey: string, modelId: string, prompt: string, aspectRatio: string) {
  const ratio = /^\d+:\d+$/.test(aspectRatio) ? aspectRatio as `${number}:${number}` : undefined;
  const { image } = await generateImage({
    model: gatewayFor(apiKey).imageModel(modelId), prompt, aspectRatio: ratio,
    abortSignal: AbortSignal.timeout(50_000),
  });
  return { imageUrl: `data:${image.mediaType};base64,${image.base64}`, description: "Image generated successfully" };
}

export async function vercelStartVideo(
  apiKey: string, modelId: string,
  input: { prompt: string; duration?: number; aspectRatio?: string; imageUrl?: string },
) {
  const result = await experimental_startVideo({
    model: gatewayFor(apiKey).videoModel(modelId),
    // Image-to-video takes a hosted URL: the gateway caps a persisted start request at 300 KiB.
    prompt: input.imageUrl ? { image: input.imageUrl, text: input.prompt } : input.prompt,
    duration: input.duration,
    aspectRatio: input.aspectRatio as `${number}:${number}` | undefined,
    abortSignal: AbortSignal.timeout(30_000),
  });
  const job = (result.providerMetadata as any)?.gateway?.asyncJob;
  return { operation: result.operation, gatewayJobId: typeof job?.jobId === "string" ? job.jobId : null };
}

export async function vercelVideoStatus(apiKey: string, modelId: string, operation: unknown) {
  const status = await experimental_getVideoStatus(gatewayFor(apiKey).videoModel(modelId), {
    operation: operation as any, abortSignal: AbortSignal.timeout(20_000),
  });
  return toVideoSnapshot(status as VideoStatusLike);
}

export async function vercelGenerateSpeech(apiKey: string, modelId: string, text: string, voice?: string, outputFormat = "mp3") {
  const result = await generateSpeech({
    model: gatewayFor(apiKey).speechModel(modelId), text, voice, outputFormat,
    abortSignal: AbortSignal.timeout(45_000),
  });
  return { base64: result.audio.base64, mediaType: result.audio.mediaType };
}

export async function vercelTranscribe(apiKey: string, modelId: string, audio: Uint8Array) {
  const result = await transcribe({
    model: gatewayFor(apiKey).transcriptionModel(modelId), audio,
    abortSignal: AbortSignal.timeout(50_000),
  });
  return { transcript: result.text, language: result.language ?? "unknown", duration: result.durationInSeconds ?? 0 };
}
```

- [ ] **Step 4: Run the tests and `deno check`.** This is the first time the npm packages resolve, and `deno check` will catch any SDK signature drift.

Run: `deno test --allow-env --allow-net --allow-read --allow-write --no-check --node-modules-dir=auto supabase/functions/_shared/vercelGateway.test.ts && deno check --node-modules-dir=auto supabase/functions/_shared/vercelGateway.ts`
Expected: 5 passed; check clean. If `deno check` reports a changed option name (`aspectRatio`, `outputFormat`, `durationInSeconds`), fix it to match the pinned `.d.ts`. Never unpin the packages.

- [ ] **Step 5: Boot probe on the real runtime.** Memory: a worker boot error can hide behind `--no-check`. Run `deno eval --node-modules-dir=auto "await import('./supabase/functions/_shared/vercelGateway.ts'); console.log('ok')"`. Expected: `ok`. After deploy (Task 15), also probe the deployed `generate-speech` unauthenticated and expect 401, not 500; that proves the edge runtime itself resolves the `npm:` imports.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(ai): Vercel AI Gateway wrapper for image, video, speech and transcription" -- supabase/functions/_shared/vercelGateway.ts supabase/functions/_shared/vercelGateway.test.ts
```

---

### Task 9: Image generation through Vercel

**Files:**
- Modify: `supabase/functions/generate-image/index.ts` (requested-model lookup at ~120-140; `generateWithModel` at ~449; key resolution at ~154)

**Interfaces:**
- Consumes: `vercelGenerateImage` (Task 8).

- [ ] **Step 1: Failing test for a pure chooser** at `supabase/functions/generate-image/modelChoice.test.ts`. Vercel and OpenRouter both use ids like `openai/gpt-image-2`, so the current `.eq('model_id', id).maybeSingle()` errors when two rows match, and the requested model is silently dropped.

```ts
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { pickRequestedModelRow } from "./modelChoice.ts";

const row = (provider_code: string, is_active = true) => ({ model_id: "openai/gpt-image-2", ai_providers: { provider_code, is_active } });

Deno.test("prefers the admin's default image provider when several share an id", () => {
  assertEquals(pickRequestedModelRow([row("openrouter"), row("vercel")], "vercel")?.ai_providers.provider_code, "vercel");
});
Deno.test("skips inactive providers and returns null when nothing is usable", () => {
  assertEquals(pickRequestedModelRow([row("vercel", false), row("openrouter")], "vercel")?.ai_providers.provider_code, "openrouter");
  assertEquals(pickRequestedModelRow([row("vercel", false)], "vercel"), null);
});
```
Run: `deno test --allow-env --allow-read --no-check supabase/functions/generate-image/modelChoice.test.ts`. Expected: FAIL.

`supabase/functions/generate-image/modelChoice.ts`:
```ts
export interface RequestedModelRow { model_id: string; ai_providers: { provider_code: string; is_active: boolean } | null }

export function pickRequestedModelRow<T extends RequestedModelRow>(rows: T[], defaultProviderCode: string | undefined): T | null {
  const usable = rows.filter((r) => r.ai_providers?.is_active);
  return usable.find((r) => r.ai_providers!.provider_code === defaultProviderCode) ?? usable[0] ?? null;
}
```
Replace the step-1 query in `resolveModelChain` with a list query plus the chooser:

```ts
  if (requestedModelId) {
    const { data: rows } = await supabaseAdmin
      .from('ai_models')
      .select('model_id, admin_params, ai_providers!inner(provider_code, api_endpoint, api_key_env_var, api_type, is_active)')
      .eq('model_id', requestedModelId)
      .eq('is_active', true)
      .contains('capabilities', ['image']);
    const { data: def } = await supabaseAdmin.from('system_settings').select('value').eq('key', 'default_ai_model_image').maybeSingle();
    const preferred: any = pickRequestedModelRow(rows ?? [], def?.value?.provider_code);
    if (preferred) {
      push({
        provider_code: preferred.ai_providers.provider_code,
        model_id: preferred.model_id,
        api_endpoint: preferred.ai_providers.api_endpoint,
        api_key_env_var: preferred.ai_providers.api_key_env_var,
        api_type: preferred.ai_providers.api_type,
        source: 'requested',
        admin_params: (preferred.admin_params ?? {}) as Record<string, string | number | boolean>,
      });
    }
  }
```

- [ ] **Step 2: Route Vercel.** In `generateWithModel`, add this before the `api_type === 'openai'` branch; otherwise Vercel would fall into `/images/generations`:

```ts
  if (m.provider_code === 'vercel') {
    if (references.length > 0) throw new Error('cannot take a reference image');
    return vercelGenerateImage(apiKey, m.model_id, prompt, aspectRatio);
  }
```
Import `vercelGenerateImage` from `../_shared/vercelGateway.ts`. The key resolution at ~154 already reads env `api_key_env_var` (`AI_GATEWAY_API_KEY`) and then `provider_api_keys`, so no change is needed there.

- [ ] **Step 3: Check.** Run `deno test --allow-env --allow-read --no-check supabase/functions/generate-image/ && deno check --node-modules-dir=auto supabase/functions/generate-image/index.ts`. Expected: pass.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(image): generate images through Vercel AI Gateway; disambiguate requested model ids" -- supabase/functions/generate-image/index.ts supabase/functions/generate-image/modelChoice.ts supabase/functions/generate-image/modelChoice.test.ts
```

---

### Task 10: Video generation through Vercel (start + poll)

**Files:**
- Modify: `supabase/functions/generate-video/index.ts`
- Modify: `supabase/functions/ai-generation-status/index.ts` (snapshot read at ~50-61; archive body at ~130)
- Modify: `src/components/post/VideoGenerator.tsx` (model query at 69, invoke at 102)

**Interfaces:**
- Consumes: `vercelStartVideo`, `vercelVideoStatus`, `resolveVercelKey` (Task 8).
- Job row contract: `provider='vercel'`, `provider_job_id = gatewayJobId ?? 'vercel-op'`, `params.operation = <operation JSON>`, `credential_source='platform'`.
- Request contract: `generate-video` body gains an optional `provider_code`; omitted means `'higgsfield'`, so older clients are unaffected.

- [ ] **Step 1: `generate-video`.** Right after `prompt` validation, branch before any Higgsfield code runs:

```ts
    const providerCode = String(body.provider_code || "higgsfield");
    if (providerCode === "vercel") {
      const { data: vModel } = await supabase.from("ai_models")
        .select("model_id, is_active, capabilities, ai_providers!inner(provider_code, is_active)")
        .eq("model_id", modelId).eq("ai_providers.provider_code", "vercel").maybeSingle();
      if (!vModel?.is_active || !vModel.ai_providers?.is_active || !(vModel.capabilities || []).includes("video"))
        return json({ error: "Invalid Vercel video model" }, 400);
      const apiKey = await resolveVercelKey(supabase);
      if (!apiKey) return json({ error: "Vercel AI Gateway key not configured" }, 409);
      const { data: q } = await supabase.rpc("reserve_ai_generation_quota", { p_user_id: user.id });
      const quota = Array.isArray(q) ? q[0] : q;
      if (!quota?.allowed) return json({ error: "Daily AI generation limit reached", limit: quota?.daily_limit ?? null }, 402);
      reserved = true;
      const started = await vercelStartVideo(apiKey, modelId, {
        prompt,
        duration: typeof body.duration === "number" ? body.duration : undefined,
        aspectRatio: body.aspect_ratio ?? body.aspectRatio,
        imageUrl: typeof body.image_url === "string" ? body.image_url : undefined,
      });
      const { data: job, error: insertError } = await supabase.from("ai_generation_jobs").insert({
        user_id: user.id, provider: "vercel", model_id: modelId, modality: "video",
        credential_source: "platform", status: "running",
        provider_job_id: started.gatewayJobId ?? "vercel-op",
        params: { prompt, operation: started.operation, reservation: true },
      }).select("id").single();
      if (insertError) throw insertError;
      return json({ success: true, jobId: job.id, status: "running", pollAfterSeconds: 10 });
    }
```
Move `const modelId = ...` above this block. The existing `catch` already releases the reservation when `reserved` is true.

- [ ] **Step 2: `ai-generation-status`.** Wrap the Higgsfield credential and snapshot lines in a provider branch, so the claim, archive and transition code below stays shared:

```ts
    let snap: { state: string; status: string; outputUrl: string | null; error: string | null; pollAfterSeconds: number; outputBase64?: string | null; outputMediaType?: string | null };
    if (job.provider === "vercel") {
      const apiKey = await resolveVercelKey(supabase);
      if (!apiKey) return json({ success: true, status: "running", pollAfterSeconds: 30 });
      snap = await vercelVideoStatus(apiKey, job.model_id, job.params?.operation);
    } else {
      // existing Higgsfield credential check + job_status call, assigning to snap
    }
```
The archive body becomes a pure, tested function. Create `supabase/functions/ai-generation-status/archiveBody.test.ts` first:
```ts
// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { archiveBody } from "./archiveBody.ts";

const job = { id: "j1", provider: "vercel", modality: "video" };
Deno.test("hosted result uploads by URL", () => {
  assertEquals(archiveBody(job, { outputUrl: "https://cdn/x.mp4", outputBase64: null }),
    { externalUrl: "https://cdn/x.mp4", fileName: "vercel-j1.mp4", fileType: "video" });
});
Deno.test("inline result uploads the bytes", () => {
  assertEquals(archiveBody(job, { outputUrl: null, outputBase64: "AAAA" }),
    { fileData: "AAAA", fileName: "vercel-j1.mp4", fileType: "video" });
});
Deno.test("higgsfield images keep their png name", () => {
  assertEquals(archiveBody({ id: "j2", provider: "higgsfield", modality: "image" }, { outputUrl: "u" }).fileName, "higgsfield-j2.png");
});
```
Then `supabase/functions/ai-generation-status/archiveBody.ts`:
```ts
export function archiveBody(
  job: { id: string; provider: string; modality: string },
  snap: { outputUrl: string | null; outputBase64?: string | null },
): Record<string, string> {
  const source: Record<string, string> = snap.outputBase64 ? { fileData: snap.outputBase64 } : { externalUrl: snap.outputUrl ?? "" };
  return { ...source, fileName: `${job.provider}-${job.id}.${job.modality === "video" ? "mp4" : "png"}`, fileType: job.modality };
}
```
In `index.ts`, the upload call uses `body: JSON.stringify(archiveBody(job, snap))`. For Higgsfield the file name is the same as before (`higgsfield-<id>`).
and `const resultUrl = archiveBody.url || snap.outputUrl;` is unchanged. Hosted gateway URLs expire (`expiresAt`), so archiving on the first succeeded poll is required, and this flow already does it.

**Size check:** memory note *Edge isolate OOM blanks a media batch* says anything over about 10 MB can kill an isolate. Before relying on inline base64 for long videos, confirm that `cloudinary-upload`'s `fileData` path handles an 8-second clip. If it doesn't, restrict Vercel video to models that return hosted URLs. Record the result in the PR.

- [ ] **Step 3: `VideoGenerator.tsx`.** Select the provider and send it:
```ts
      .select("model_id,name,metadata,capabilities,is_active,ai_providers!inner(provider_code)")
      .in("ai_providers.provider_code", ["higgsfield", "vercel"])
```
and in the invoke body add `provider_code: selected?.ai_providers?.provider_code ?? "higgsfield",`. Extend the local row type with `ai_providers: { provider_code: string } | null`. The `.in` filter also stops xAI and MiniMax video rows showing up; `generate-video` has always rejected them.

- [ ] **Step 4: Checks.** Run `deno test --allow-env --allow-read --no-check supabase/functions/ai-generation-status/`, then `deno check --node-modules-dir=auto supabase/functions/generate-video/index.ts supabase/functions/ai-generation-status/index.ts`, then `npx tsc -b --noEmit`, then `bun run test -- src/components/post` if tests exist there. All pass.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(video): start and poll Vercel AI Gateway video jobs" -- supabase/functions/generate-video/index.ts supabase/functions/ai-generation-status/index.ts supabase/functions/ai-generation-status/archiveBody.ts supabase/functions/ai-generation-status/archiveBody.test.ts src/components/post/VideoGenerator.tsx
```

---

### Task 11: Text to speech (`generate-speech` + "Try voice")

**Files:**
- Create: `supabase/functions/generate-speech/index.ts`
- Modify: `src/components/admin/settings/ai/AiCategoryCards.tsx` (`TextToSpeechCard`)
- Test: `src/components/admin/settings/ai/__tests__/TryVoice.test.tsx`

**Interfaces:**
- Consumes: `fetchCategoryAiSettings(admin, 'tts')` (ai-fallback), `vercelGenerateSpeech`, `resolveVercelKey`.
- HTTP: `POST generate-speech { text: string (1..1000 chars), voice?: string }` returns `{ audio: base64, mediaType, provider, model }` (200), or `{ error }` with 400 for bad input, 403 for non-admins, and 200 with an error body when every tier fails.
- Scope: **admin-only** preview. It does not store to the media library (spec §4 is narrowed accordingly; the spec is updated in Step 5).

- [ ] **Step 1: Write the function**

This follows ARCHITECTURE §12–16: shared CORS, `authenticateCaller`, a Zod schema, the admin check inside the function, and sanitized unexpected errors.

```ts
// deno-lint-ignore-file no-explicit-any no-import-prefix
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "npm:zod@3.23.8";
import { restrictedCorsHeaders } from "../_shared/cors.ts";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import { sanitizeErrorMessage } from "../_shared/errorSanitizer.ts";
import { fetchCategoryAiSettings } from "../_shared/ai-fallback.ts";
import { resolveVercelKey, vercelGenerateSpeech } from "../_shared/vercelGateway.ts";

const RequestSchema = z.object({
  text: z.string().trim().min(1).max(1000),
  voice: z.string().max(64).optional(),
});

serve(async (req) => {
  const cors = restrictedCorsHeaders(req);
  const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  let userId: string;
  try {
    userId = (await authenticateCaller(req)).userId;
  } catch {
    return json({ error: "Unauthorized" }, 401);
  }
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: role } = await admin.from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle();
  if (!role) return json({ error: "Admin required" }, 403);

  const parsed = RequestSchema.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return json({ error: "text must be 1-1000 characters" }, 400);
  const { text, voice } = parsed.data;

  try {
  const s = await fetchCategoryAiSettings(admin, "tts");
  const tiers = [[s.primaryProvider, s.primaryModel], [s.fallbackProvider, s.fallbackModel], [s.lastResortProvider, s.lastResortModel]]
    .filter(([p, m]) => p === "vercel" && m);
  if (!tiers.length) return json({ error: "No Vercel TTS model selected in Text to Speech settings" });
  const apiKey = await resolveVercelKey(admin);
  if (!apiKey) return json({ error: "Vercel AI Gateway key not configured" });
  const errors: string[] = [];
  for (const [, model] of tiers) {
    try {
      const out = await vercelGenerateSpeech(apiKey, model, text, voice);
      return json({ audio: out.base64, mediaType: out.mediaType, provider: "vercel", model });
    } catch (e) {
      console.error("[generate-speech] tier failed", model, e);
      errors.push(`${model}: ${sanitizeErrorMessage(e)}`);
    }
  }
  return json({ error: errors.join("; ") });
  } catch (e) {
    console.error("[generate-speech]", e);
    return json({ error: sanitizeErrorMessage(e) }, 500);
  }
});
```
`sanitizeErrorMessage(error): string` (`_shared/errorSanitizer.ts:151`) is used instead of `logAndSanitize`. `logAndSanitize` returns a whole Response with wildcard CORS headers, which ARCHITECTURE §25 rules out for an authenticated endpoint.
The function only runs Vercel tiers. Gemini and ElevenLabs TTS still have no runtime, and that stays out of scope (spec). The error message says so when no Vercel tier is selected.

- [ ] **Step 2: Failing UI test.** This follows `postora-frontend-test-conventions`: use `fireEvent`, not `userEvent`, and mock `supabase.functions.invoke`.

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { TryVoice } from '../AiCategoryCards';

const invoke = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } } }));

describe('TryVoice', () => {
  it('sends the text and renders an audio player on success', async () => {
    invoke.mockResolvedValue({ data: { audio: 'AAAA', mediaType: 'audio/mpeg' }, error: null });
    render(<TryVoice />);
    fireEvent.change(screen.getByLabelText('Preview text'), { target: { value: 'hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Try voice' }));
    await waitFor(() => expect(screen.getByTestId('tts-preview')).toHaveAttribute('src', 'data:audio/mpeg;base64,AAAA'));
    expect(invoke).toHaveBeenCalledWith('generate-speech', { body: { text: 'hello' } });
  });

  it('shows the server error', async () => {
    invoke.mockResolvedValue({ data: { error: 'No Vercel TTS model selected in Text to Speech settings' }, error: null });
    render(<TryVoice />);
    fireEvent.change(screen.getByLabelText('Preview text'), { target: { value: 'hi' } });
    fireEvent.click(screen.getByRole('button', { name: 'Try voice' }));
    expect(await screen.findByText(/No Vercel TTS model selected/)).toBeInTheDocument();
  });
});
```

Run `bun run test -- src/components/admin/settings/ai/__tests__/TryVoice.test.tsx`. Expected: FAIL, because `TryVoice` is not exported yet.

- [ ] **Step 3: Implement `TryVoice`** in `AiCategoryCards.tsx`, and render it inside `TextToSpeechCard` below the selector:

```tsx
export function TryVoice() {
  const [text, setText] = useState('Hello from Postora.');
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    setBusy(true); setError(null); setSrc(null);
    const { data, error: invokeError } = await supabase.functions.invoke('generate-speech', { body: { text } });
    setBusy(false);
    if (invokeError || data?.error) { setError(data?.error ?? 'Speech generation failed'); return; }
    setSrc(`data:${data.mediaType};base64,${data.audio}`);
  };
  return (
    <div className="space-y-2 pt-3">
      <Label htmlFor="tts-preview-text" className="text-xs">Preview text</Label>
      <div className="flex gap-2">
        <Input id="tts-preview-text" value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} className="h-8 text-xs" />
        <Button size="sm" onClick={run} disabled={busy || !text.trim()}>{busy ? <Loader2 className="w-3 h-3 animate-spin" /> : null}Try voice</Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}
      {src && <audio data-testid="tts-preview" controls src={src} className="w-full" />}
    </div>
  );
}
```
Add any missing imports (`useState`, `Input`, `Button`, `Label`, `Loader2`, `supabase`) and match the file's existing import style.

- [ ] **Step 4: Tests pass.** Run `bun run test -- src/components/admin/settings/ai/__tests__/TryVoice.test.tsx && deno check --node-modules-dir=auto supabase/functions/generate-speech/index.ts`. Expected: 2 passed.

- [ ] **Step 5: Update spec §4 TTS bullet.** Change it to read "admin-only preview; returns base64 audio, not stored". Then commit.

```bash
git commit -m "feat(tts): generate-speech via Vercel AI Gateway with admin Try voice preview" -- supabase/functions/generate-speech/index.ts src/components/admin/settings/ai/AiCategoryCards.tsx src/components/admin/settings/ai/__tests__/TryVoice.test.tsx docs/superpowers/specs/2026-09-25-vercel-ai-gateway-provider-design.md
```

---

### Task 12: Speech to text through Vercel

**Files:**
- Modify: `supabase/functions/transcribe-media/index.ts` (`runTranscription`, and the three tier call sites)

**Interfaces:**
- Consumes: `vercelTranscribe`, `resolveVercelKey`. `sttSettings` already carries `primaryProvider`, `fallbackProvider` and `lastResortProvider`.

- [ ] **Step 1: Make routing provider-aware.** Today `runTranscription` routes on the model name only. Add a `provider` parameter, handled first:

```ts
async function runTranscription(audioBlob: Blob, model: string, supabaseAdmin?: any, provider?: string): Promise<TranscriptionResult> {
  if (provider === "vercel") {
    const apiKey = supabaseAdmin ? await resolveVercelKey(supabaseAdmin) : Deno.env.get("AI_GATEWAY_API_KEY");
    if (!apiKey) throw new TranscriptionApiError("Vercel AI Gateway key not configured", "https://ai-gateway.vercel.sh", 0);
    return vercelTranscribe(apiKey, model, new Uint8Array(await audioBlob.arrayBuffer()));
  }
  // …existing model-name routing unchanged…
}
```
Tier 1 passes `sttSettings.primaryProvider`. Tier 2 passes `sttSettings.fallbackProvider`. Tier 3 keeps no provider, because it is hardcoded `whisper-1`. The `app_settings` model override stays as it is, and a `requestedModel` override also passes no provider, so today's behaviour is unchanged. Check `TranscriptionApiError`'s constructor arity at its definition and match it.

- [ ] **Step 2: Check.** `deno check --node-modules-dir=auto supabase/functions/transcribe-media/index.ts`, and run the existing `transcribe-media` tests if any. Expected: pass.

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(stt): route Vercel transcription models through the gateway" -- supabase/functions/transcribe-media/index.ts
```

---

### Task 13: Admin UI — Sync button and searchable picker

**Files:**
- Create: `src/hooks/ai-config/useSyncModels.ts`, `src/components/admin/SearchableModelPicker.tsx`
- Modify: `src/components/admin/settings/ai/AiProvidersCard.tsx` (the dialog for the selected provider, ~208-260), `src/components/admin/DefaultModelSelector.tsx` (plain `Select` branch, ~345)
- Test: `src/components/admin/__tests__/SearchableModelPicker.test.tsx`, `src/components/admin/settings/ai/__tests__/SyncModelsButton.test.tsx`

**Interfaces:**
- Consumes: `POST ai-config { action: 'sync-models', provider_code }` returns `SyncReport` or `{ error }` (Task 3); `system_settings` `model_catalog_synced_at_<code>`.
- Produces:
  ```ts
  export function useSyncModels(): UseMutationResult<SyncReport, Error, { provider_code: string }>;
  export const SYNCABLE_PROVIDER_CODES: readonly string[]; // ['vercel','openrouter','deepseek']
  export function SearchableModelPicker(props: { models: AIModel[]; value: string; onSelect: (modelId: string) => void; disabled?: boolean; modelNote?: (m: AIModel) => string | null }): JSX.Element;
  export const LARGE_PROVIDER_THRESHOLD = 25;
  ```

- [ ] **Step 1: Failing picker test**

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchableModelPicker } from '../SearchableModelPicker';

const m = (model_id: string, name = model_id, metadata: Record<string, unknown> = {}) =>
  ({ id: model_id, model_id, name, metadata, is_active: true, capabilities: ['chat'], provider_id: 'p' }) as never;

describe('SearchableModelPicker', () => {
  const models = [m('openai/gpt-5.5', 'GPT-5.5'), m('anthropic/claude-sonnet-5', 'Claude Sonnet 5'), m('bad/embed', 'Bad', {})];
  it('groups by vendor prefix and filters by search', () => {
    render(<SearchableModelPicker models={models} value="" onSelect={() => {}} />);
    fireEvent.click(screen.getByRole('combobox'));
    expect(screen.getByText('openai')).toBeInTheDocument();
    expect(screen.getByText('anthropic')).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText('Search models...'), { target: { value: 'sonnet' } });
    expect(screen.queryByText('GPT-5.5')).not.toBeInTheDocument();
    expect(screen.getByText('Claude Sonnet 5')).toBeInTheDocument();
  });
  it('does not select a model that has a disable note', () => {
    const onSelect = vi.fn();
    render(<SearchableModelPicker models={models} value="" onSelect={onSelect} modelNote={(x) => (x.model_id === 'bad/embed' ? 'unknown vector width' : null)} />);
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByText('Bad'));
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getByText('unknown vector width')).toBeInTheDocument();
  });
});
```

Run `bun run test -- src/components/admin/__tests__/SearchableModelPicker.test.tsx`. Expected: FAIL, module not found.

- [ ] **Step 2: Implement the picker.** It reuses the `Popover` + `Command` pattern that `DefaultModelSelector` already uses for OpenRouter.

```tsx
import { useMemo, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import type { AIModel } from '@/hooks/useAIConfiguration';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command';

export const LARGE_PROVIDER_THRESHOLD = 25;

const vendorOf = (modelId: string) => (modelId.includes('/') ? modelId.split('/')[0] : 'other');

export function SearchableModelPicker({ models, value, onSelect, disabled, modelNote }: {
  models: AIModel[]; value: string; onSelect: (modelId: string) => void; disabled?: boolean;
  modelNote?: (m: AIModel) => string | null;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const groups = useMemo(() => {
    const q = search.toLowerCase();
    const byVendor = new Map<string, AIModel[]>();
    for (const m of models) {
      if (q && !m.model_id.toLowerCase().includes(q) && !m.name.toLowerCase().includes(q)) continue;
      const v = vendorOf(m.model_id);
      byVendor.set(v, [...(byVendor.get(v) ?? []), m]);
    }
    return [...byVendor.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [models, search]);
  const current = models.find((m) => m.model_id === value);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" role="combobox" aria-expanded={open} disabled={disabled}
          className="w-full justify-between font-normal text-xs h-8">
          <span className="truncate text-xs">{current?.name ?? (value || 'Model...')}</span>
          <ChevronsUpDown className="ms-1 h-3 w-3 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[400px] p-0" align="start">
        <Command shouldFilter={false}>
          <CommandInput placeholder="Search models..." value={search} onValueChange={setSearch} />
          <CommandList className="max-h-[300px]">
            <CommandEmpty>No models found.</CommandEmpty>
            {groups.map(([vendor, items]) => (
              <CommandGroup key={vendor} heading={vendor}>
                {items.map((m) => {
                  const note = modelNote ? modelNote(m) : null;
                  return (
                    <CommandItem key={m.id} value={m.model_id} disabled={note !== null}
                      onSelect={() => { if (note) return; onSelect(m.model_id); setOpen(false); setSearch(''); }}>
                      <Check className={`w-3 h-3 shrink-0 ${value === m.model_id ? 'opacity-100' : 'opacity-0'}`} />
                      <span className="truncate flex-1">{m.name}</span>
                      {note && <span className="text-[10px] text-muted-foreground ms-1.5">{note}</span>}
                    </CommandItem>
                  );
                })}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 3: Use it in `DefaultModelSelector`.** In the `selectedProviderId ?` branch, render the picker when the provider has a large list:

```tsx
        ) : selectedProviderId && providerModels.length > LARGE_PROVIDER_THRESHOLD ? (
          <SearchableModelPicker
            models={providerModels}
            value={currentModel?.provider_code === selectedProvider?.provider_code ? currentModel?.model_id || '' : ''}
            onSelect={handleModelChange} disabled={isSaving} modelNote={modelNote} />
        ) : selectedProviderId ? (
```
`providerModels` is already filtered to the section's capability (line ~105), so the Vercel list in each section contains only that section's models.

- [ ] **Step 4: Failing Sync button test**, then implement.

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SyncModelsButton } from '../SyncModelsButton';

const invoke = vi.fn();
vi.mock('@/integrations/supabase/client', () => ({ supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } } }));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('sonner', () => ({ toast }));
const wrap = (ui: React.ReactNode) => <QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>;

describe('SyncModelsButton', () => {
  it('reports added, deactivated and in-use counts', async () => {
    invoke.mockResolvedValue({ data: { added: 12, updated: 3, deactivated: 1, kept_in_use: ['x'], skipped_by_type: { evaluation: 1 }, synced_at: '2026-09-25T00:00:00Z' }, error: null });
    render(wrap(<SyncModelsButton providerCode="vercel" />));
    fireEvent.click(screen.getByRole('button', { name: /Sync models/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Synced: 12 added, 3 updated, 1 deactivated, 1 kept (in use)'));
    expect(invoke).toHaveBeenCalledWith('ai-config', { body: { action: 'sync-models', provider_code: 'vercel' } });
  });
  it('shows the server error', async () => {
    invoke.mockResolvedValue({ data: { error: 'vercel /models returned HTTP 503' }, error: null });
    render(wrap(<SyncModelsButton providerCode="vercel" />));
    fireEvent.click(screen.getByRole('button', { name: /Sync models/ }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('vercel /models returned HTTP 503'));
  });
});
```

`src/hooks/ai-config/useSyncModels.ts`:
```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export const SYNCABLE_PROVIDER_CODES = ['vercel', 'openrouter', 'deepseek'] as const;

export interface SyncReport {
  added: number; updated: number; deactivated: number;
  kept_in_use: string[]; skipped_by_type: Record<string, number>; synced_at: string;
}

export function useSyncModels() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ provider_code }: { provider_code: string }): Promise<SyncReport> => {
      const { data, error } = await supabase.functions.invoke('ai-config', { body: { action: 'sync-models', provider_code } });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data as SyncReport;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai-config'] }),
  });
}
```
`['ai-config']` is the query key `useAIConfiguration.ts:68` uses.

`src/components/admin/settings/ai/SyncModelsButton.tsx`:
```tsx
import { RefreshCw, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { useSyncModels } from '@/hooks/ai-config/useSyncModels';

// lastSyncedAt comes from the `model_catalog_synced_at_<code>` row that the
// ai-config `list` action already returns in `settings` (it selects system_settings
// LIKE 'default_ai_model%'). Widen that filter so this row is included too:
// `.or('key.like.default_ai_model%,key.like.model_catalog_synced_at_%')`.
export function SyncModelsButton({ providerCode, lastSyncedAt }: { providerCode: string; lastSyncedAt?: string | null }) {
  const sync = useSyncModels();
  const run = () => sync.mutate({ provider_code: providerCode }, {
    onSuccess: (r) => toast.success(`Synced: ${r.added} added, ${r.updated} updated, ${r.deactivated} deactivated, ${r.kept_in_use.length} kept (in use)`),
    onError: (e) => toast.error(e.message),
  });
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-muted-foreground">
        {lastSyncedAt ? `Last synced ${new Date(lastSyncedAt).toLocaleString()}` : 'Never synced'}
      </span>
      <Button size="sm" variant="outline" onClick={run} disabled={sync.isPending} className="gap-1">
        {sync.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
        Sync models
      </Button>
    </div>
  );
}
```
`AiProvidersCard.tsx` already imports `toast` from `sonner`, so the component and the test mock use it too.

In the `AiProvidersCard.tsx` dialog, under the API-key block for non-OAuth providers, add:
```tsx
{selectedProvider && (SYNCABLE_PROVIDER_CODES as readonly string[]).includes(selectedProvider.provider_code) && (
  <div className="flex items-center justify-between pt-2">
    <span className="text-xs text-muted-foreground">Pull the provider's current model list</span>
    <SyncModelsButton providerCode={selectedProvider.provider_code}
      lastSyncedAt={(aiConfig?.settings ?? []).find((s) => s.key === `model_catalog_synced_at_${selectedProvider.provider_code}`)?.value?.at ?? null} />
  </div>
)}
```

- [ ] **Step 5: Tests pass and types are clean.** Run `bun run test -- src/components/admin && npx tsc -b --noEmit && bun run lint`. Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(admin): Sync models button and searchable vendor-grouped model picker" -- supabase/functions/ai-config/index.ts src/hooks/ai-config/useSyncModels.ts src/components/admin/SearchableModelPicker.tsx src/components/admin/settings/ai/SyncModelsButton.tsx src/components/admin/settings/ai/AiProvidersCard.tsx src/components/admin/DefaultModelSelector.tsx src/components/admin/__tests__/SearchableModelPicker.test.tsx src/components/admin/settings/ai/__tests__/SyncModelsButton.test.tsx
```

---

### Task 14: One-off refresh for OpenAI, Anthropic, xAI, z.ai

These providers' `/models` endpoints return bare ids with no type, so they cannot be synced live. The script drafts a migration, and a person decides which section each new model belongs to. **Ids must come from each provider's own API**, not from Vercel: Vercel writes `claude-opus-5.5`, while Anthropic's native id may be dashed.

**Files:**
- Create: `scripts/provider-model-refresh.ts`
- Create: `supabase/migrations/20260925130000_refresh_provider_models.sql` (the reviewed output)

- [ ] **Step 1: Write the script.** Run it on Contabo, where the keys are. It reads the keys from `provider_api_keys` over `psql` stdin, so no key is ever printed or written to disk.

```ts
// One-off: diff each provider's live /models against ai_models and print a
// DRAFT migration. Capabilities are guessed by id pattern; a human reviews them.
// Usage: deno run --allow-net --allow-env scripts/provider-model-refresh.ts < keys.json > draft.sql
// keys.json: {"openai":"…","claude":"…","xai":"…","zai":"…","existing":{"openai":["gpt-4o",…],…}}
const SOURCES: Record<string, { url: string; headers: (k: string) => Record<string, string> }> = {
  openai: { url: "https://api.openai.com/v1/models", headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  claude: { url: "https://api.anthropic.com/v1/models?limit=1000", headers: (k) => ({ "x-api-key": k, "anthropic-version": "2023-06-01" }) },
  xai: { url: "https://api.x.ai/v1/models", headers: (k) => ({ Authorization: `Bearer ${k}` }) },
  zai: { url: "https://api.z.ai/api/paas/v4/models", headers: (k) => ({ Authorization: `Bearer ${k}` }) },
};

export function guessCapability(id: string): string {
  if (/embed/i.test(id)) return "embedding";
  if (/tts|speech/i.test(id)) return "tts";
  if (/whisper|transcribe|stt/i.test(id)) return "stt";
  if (/image|dall-e|imagine-image|cogview/i.test(id)) return "image";
  if (/video|sora|imagine-video|cogvideo/i.test(id)) return "video";
  return "chat";
}

const input = JSON.parse(await new Response(Deno.stdin.readable).text());
const sql = (s: string) => s.replace(/'/g, "''");
console.log("-- DRAFT: review every capability before committing. Generated", new Date().toISOString());
for (const [code, src] of Object.entries(SOURCES)) {
  if (!input[code]) { console.log(`-- ${code}: no key, skipped`); continue; }
  const res = await fetch(src.url, { headers: src.headers(input[code]) });
  if (!res.ok) { console.log(`-- ${code}: HTTP ${res.status}, skipped`); continue; }
  const ids: string[] = ((await res.json()).data ?? []).map((m: { id: string }) => m.id);
  const existing = new Set<string>(input.existing?.[code] ?? []);
  for (const id of ids.filter((i) => !existing.has(i)).sort()) {
    console.log(`INSERT INTO public.ai_models (provider_id, model_id, name, capabilities, is_active)
SELECT id, '${sql(id)}', '${sql(id)}', ARRAY['${guessCapability(id)}'], true FROM public.ai_providers WHERE provider_code = '${code}'
ON CONFLICT (provider_id, model_id) DO NOTHING;`);
  }
  for (const gone of [...existing].filter((i) => !ids.includes(i)).sort()) {
    console.log(`-- ${code}: '${gone}' no longer listed; deactivate only if no default_ai_model_* uses it`);
  }
}
```

- [ ] **Step 2: The user runs it locally.** It was not possible to confirm the Contabo host has `deno` (the SSH MCP timed out during planning), and the keys must not enter the agent transcript. So the **user** runs this in their own terminal with the `!` prefix. First they export `keys.json` from the DB: a `jsonb_object_agg` over `provider_api_keys` plus the existing `ai_models` ids per provider, through their own psql or Studio session. Then they run `deno run --allow-net scripts/provider-model-refresh.ts < keys.json > draft.sql` and delete `keys.json`. Only `draft.sql`, which holds model ids and no keys, is shared with the agent.

- [ ] **Step 3: Human review.** Walk the draft with the user. Fix every capability `guessCapability` got wrong. Keep only current flagship and still-useful ids; drop dated snapshots, fine-tunes and deprecated preview ids. For each "no longer listed" line, add `UPDATE … SET is_active=false` only after checking `system_settings` shows no `default_ai_model_*` referencing it. Save the result as `supabase/migrations/20260925130000_refresh_provider_models.sql`.

- [ ] **Step 4: Rehearse (BEGIN/ROLLBACK, as in Task 1), then commit**

```bash
git commit -m "chore(ai): refresh OpenAI, Anthropic, xAI and z.ai model catalogues" -- scripts/provider-model-refresh.ts supabase/migrations/20260925130000_refresh_provider_models.sql
```

---

### Task 15: Gates, guards, deploy, live verification

- [ ] **Step 1: Full gates** in the worktree. Deno runs first because it can clobber `node_modules` (see memory).

```bash
bash scripts/local-gates.sh edge
bun install --frozen-lockfile && npx tsc -b --noEmit && bun run lint && bun run test && bun run build
```
Expected: all green. `bun.lock` does not change, because no npm dependency was added to the frontend.

- [ ] **Step 2: Guard passes.** Run `clean-code-guard` over the changed production files and `test-guard` over the new tests. Fix what they find, then re-run Step 1.

- [ ] **Step 3: `graphify update .`** and commit only if the user wants graph files tracked; otherwise leave them.

- [ ] **Step 4: PR.** Push the branch and open a PR. The body lists the migration-before-code order, the non-atomic update trade-off from Task 3, and the Task 10 size-check result. Merge follows the usual bot-review round (memory: one round, then merge).

- [ ] **Step 5: Deploy in order.**
  1. Apply `20260925120000_vercel_deepseek_providers.sql` on Contabo as `supabase_admin`, then run `NOTIFY pgrst, 'reload schema'`.
  2. Add `AI_GATEWAY_API_KEY=<new rotated key>` (and `DEEPSEEK_API_KEY`) to the stack `.env` on disk, then force-recreate `functions`. Do it by hand; **never paste the key into a tool call that gets logged**. Ask the user to type it via `! <command>` or edit the file themselves.
  3. Deploy the edge functions from `git show origin/main:<path>` per the runbook, with SHA256 verification. Deploy `ai-config`, `ai-agent-reply`, `generate-image`, `generate-video`, `ai-generation-status`, `generate-speech` (new), `transcribe-media`, `ai-knowledge-*` workers (via `_shared/knowledgeEmbeddings.ts`), `generate-caption`, `generate-hashtags`, and every other `ai-fallback.ts` importer (`grep -rl "ai-fallback.ts" supabase/functions`). Then `restart` (memory: `up -d` serves old code).
  4. Probe each function unauthenticated and expect 401, not a boot error.
  5. The frontend auto-deploys on merge to `main`.
  6. Apply the refresh migration (Task 14).

- [ ] **Step 6: Live verification** after the user adds the Vercel card.
  1. **Providers → Vercel → Save & Test** with the new key: shows success. Before the card is added it shows the "add a credit card" message.
  2. **Sync models** on Vercel, OpenRouter and DeepSeek, and check the counts:
     ```sql
     SELECT p.provider_code, c, count(*)
     FROM ai_models m
     JOIN ai_providers p ON p.id = m.provider_id,
       unnest(m.capabilities) c
     WHERE p.provider_code IN ('vercel','openrouter','deepseek') AND m.is_active
     GROUP BY 1, 2 ORDER BY 1, 2;
     ```
     Expected: Vercel chat around 264, video 35, image 34, embedding 26, tts 8, stt 8. No row for `typesafe-ai/jev`.
  3. Each sub-tab lists only its own Vercel models.
  4. Set a Vercel chat model as the chat fallback, then generate a caption and check `api_logs` or the tier log shows `vercel`.
  5. Set a Vercel model in the AI Agent chain, then run a test reply.
  6. **Embedding:** select `openai/text-embedding-3-small` via Vercel, re-embed one knowledge item, and confirm a 1536 vector.
  7. **Image:** generate one image with `bfl/flux-2-pro`.
  8. **Video:** start one `alibaba/wan-v2.6-t2v` job, poll it to `succeeded`, and confirm a `media_files` row.
  9. **TTS:** select `openai/tts-1` via Vercel and use Try voice.
  10. **STT:** select `openai/whisper-1` via Vercel and transcribe one clip.
  11. Playwright snapshot of `/admin/settings?tab=ai&sub=Providers`.

- [ ] **Step 7: Wrap-up.** Add a mem0 `add_memory` task summary (issue, cause, fix, files), then give the final report to the user.
