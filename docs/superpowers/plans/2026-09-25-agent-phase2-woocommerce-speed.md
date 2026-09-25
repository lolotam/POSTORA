# Agent Phase 2: faster WooCommerce replies implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut the time of store-question replies, which are 12–13 s today on xsellpoint, by:
1. measuring where the time goes;
2. caching the WooCommerce category-id lookups and short-lived product searches;
3. running independent read-only store calls in parallel.

The target is set from the measurement, not assumed. The roadmap's "under about 6 s" is a hypothesis.

**Architecture:**
- **Timing:** `ai-agent-reply` records per-phase timings in its log metadata.
- **Cache:** the `ai-agent-adapters` function gains an injected `ConnectorCache` dependency, backed by a new service-role-only table, `connector_response_cache`. The WooCommerce adapter uses it for category ids (24 h) and `search_products` (120 s).
- **Parallel calls:** when a model round asks for several calls that are all read-only connector calls, `ai-agent-reply` runs them concurrently (at most 3) and keeps the message order.
- **Not built:** Jev cannot produce a search query (it returns choices, not text), so "Jev routes the search query" is out. Keyword prefetch is dropped: the debate showed poor reuse and duplicate work.

**Spec:** `docs/superpowers/specs/2026-09-25-ai-agent-roadmap.md`, Phase 2 (revised by debate round 1).

## Global Constraints

- Required reading: `ARCHITECTURE.md` (§12 dependencies-then-invoke, §24 structural tenancy, the security rules).
- **The migration goes to the Migrations lane** (Task 8). Apply it to production before merging code that uses the table.
- **The cache table is service-role only:**
  - `REVOKE ALL ... FROM PUBLIC, anon, authenticated` (all three; REVOKE FROM PUBLIC alone leaves anon and authenticated with access);
  - RLS enabled with no policies.
- **Cache keys** are the SHA-256 of a canonical JSON of `[tool_id, sha256(store_url), capability, canonical params]`, where canonical params means the keys sorted and the strings trimmed and lower-cased. Never store credentials in keys or values.
- **TTLs:**
  - category id: 86 400 s;
  - `search_products`: 120 s (stock and price may be up to 2 minutes stale, and that is documented in the tool's description to the model);
  - `check_stock` and `lookup_orders`: **never cached**.
- **Failure handling:** a cache read or write failure never fails the call; it falls through to the live request. Log only the error class.
- **Parallel execution** applies only when every tool call in the round targets a custom connector tool that is read-only (see Task 10). Agent tools (`escalate_to_human`, `notify_admin`, `search_knowledge`), admin tools and any write-capable connector keep running one after another.
- **Tests:** Deno `cd supabase/functions && deno test -A --no-check --node-modules-dir=none <paths>` plus `deno check`. `ai-agent-adapters` needs `--node-modules-dir=none` (see the project notes). Add no new `any`.

---

### Task 7: Measure where the time goes

**Files:** Modify `supabase/functions/ai-agent-reply/index.ts`, with a pure helper in `logic.ts` and its test.

**Interfaces:** Produces `export function phaseTimings()` in `logic.ts`, returning a small recorder:
- `{ mark(name: string): void; span<T>(name: string, fn: () => Promise<T>): Promise<T>; toJSON(): Record<string, number | number[]> }`
- repeated spans of the same name accumulate into arrays;
- it takes an injectable clock for tests.

- [ ] **Step 1: Failing test.** With a fake clock, the recorder:
   - records `triage: 300`;
   - records two `model_round` spans as an array `[1200, 900]`;
   - records `tool:woocommerce_store` spans as an array;
   - `toJSON()` returns exactly those.
- [ ] **Step 2: Run and see it FAIL.**
- [ ] **Step 3: Implement** the helper, then wrap in `index.ts`:
   - the triage await;
   - the knowledge await (when it is awaited);
   - each `chatCompletion` call (`model_round`);
   - each tool execution (`tool:<name>`).
   - Add `timings: timings.toJSON()` to the meta of the success and `no_reply_generated` `logOutcome` calls.
   - Reuse the existing connector `latencyMs` rather than timing it twice where it is already recorded.
- [ ] **Step 4: Run and see it PASS**: the `ai-agent-reply/` suite, plus `deno check`.
- [ ] **Step 5: Commit** `feat(agent): per-phase reply timings in the log metadata`.

---

### Task 8 (Migrations lane): the `connector_response_cache` table

**Files:** Create `supabase/migrations/20260926091000_connector_response_cache.sql`.

```sql
-- Short-lived cache of read-only connector answers (WooCommerce category ids and product
-- searches). Service role only: keys are hashes and values hold no credentials.
CREATE TABLE IF NOT EXISTS public.connector_response_cache (
  cache_key text PRIMARY KEY,
  tool_id uuid NOT NULL,
  value jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS connector_response_cache_expires_idx ON public.connector_response_cache (expires_at);
ALTER TABLE public.connector_response_cache ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.connector_response_cache FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.connector_response_cache TO service_role;
```

- If `pg_cron` is installed (check `pg_extension` on the rehearsal DB), also schedule a daily purge:

  ```sql
  SELECT cron.schedule('purge-connector-response-cache', '17 3 * * *', $$DELETE FROM public.connector_response_cache WHERE expires_at < now()$$);
  ```

  Make it idempotent: unschedule the job by name first if it exists.
- Rehearse on the Contabo rehearsal DB. The controller applies it to production **before** the merge, then reloads the PostgREST schema cache.
- Commit: `feat(db): connector_response_cache`.

---

### Task 9: The cache dependency and the WooCommerce adapter using it

**Files:**
- Modify:
  - `supabase/functions/ai-agent-adapters/types.ts` (`AdapterDependencies`);
  - `dependencies.ts`;
  - `handler.ts` (build the cache from the admin client it already creates);
  - `woocommerce.ts`.
- Create: `supabase/functions/ai-agent-adapters/cache.ts`.
- Test: `supabase/functions/ai-agent-adapters/cache.test.ts` and `adapters.test.ts`.

**Interfaces:**
- Produces:
  - `export interface ConnectorCache { get(key: string): Promise<unknown | null>; set(key: string, toolId: string, value: unknown, ttlSeconds: number): Promise<void>; }`;
  - `export async function cacheKey(parts: unknown[]): Promise<string>` (SHA-256 hex of the canonical JSON);
  - `export function tableCache(db: CacheDb, now = () => Date.now()): ConnectorCache`, which reads rows whose `expires_at > now` and upserts on `cache_key`;
  - `AdapterDependencies.cache?: ConnectorCache` (optional, so every existing test and caller keeps working).

- [ ] **Step 1: Failing tests.**
   - **`cacheKey`:**
     - is stable under parameter key order and string case and whitespace;
     - differs by tool_id and by store URL.
   - **`tableCache`:**
     - returns null when the row is missing or expired;
     - returns the value when it is fresh;
     - `set` upserts `expires_at = now + ttl`;
     - a db error on `get` returns null, and on `set` resolves without throwing.
   - **The WooCommerce adapter**, with an in-memory fake cache and a counting fake `fetch`:
     - two identical `search_products` calls with a category make one category request and one search request in total (the second is fully cached);
     - the same search after the 120 s TTL refetches the search but not the category;
     - `check_stock` and `lookup_orders` never touch the cache;
     - a throwing cache still returns the live result;
     - `testConnection` never touches the cache.
- [ ] **Step 2: Run and see it FAIL.**
- [ ] **Step 3: Implement.**
   - `callWooCommerce` wraps `resolveCategoryId` with `cache.get`/`cache.set` (key parts `["cat", tool.id, storeUrl, name]`, TTL 86 400).
   - For `search_products` it caches the **projected** success result (key parts `["search", tool.id, storeUrl, parameters]`, TTL 120). It never caches failures.
   - `handler.ts` passes `tableCache(adminClient)` in the dependencies.
   - Also append " Stock and prices may be up to 2 minutes old." to the `search_products` capability description given to the model, so answers can hedge. Find where WooCommerce capability descriptions are defined for the tool schema.
- [ ] **Step 4: Run and see it PASS.** Run `deno test -A --no-check --node-modules-dir=none ai-agent-adapters/` and `deno check ai-agent-adapters/index.ts`.
- [ ] **Step 5: Commit** `feat(connectors): cache WooCommerce category ids and short-lived product searches`.

---

### Task 10: Read-only connector calls in one round run in parallel

**Files:**
- Modify: `supabase/functions/ai-agent-reply/index.ts` (the tool loop, ~1168–1200 at 3a24f33c; locate the `for (const toolCall of choice.tool_calls)` loop).
- Test: a pure helper in `logic.ts` or `connectorExecution.ts`, with its test.

**Interfaces:** Produces `export function parallelizable(calls: Array<{ function: { name: string } }>, toolByName: Map<string, { connector_type?: string | null; read_only_mode?: boolean | null }>): boolean`. It is true only when:
- there are at least 2 calls;
- **every** call names a custom connector tool (present in `toolByName`);
- every such tool is read-only (`read_only_mode === true`, or `connector_type === "woocommerce"`, whose adapter is read-only by construction; confirm this in `ai-agent-adapters/woocommerce.ts`, where the adapter reports `read_only: true`).

Find what `CustomTool` actually carries: if `read_only_mode` is not on the resolved tool, select it in the `ai_agent_tools` query, adding it to the select list.

- [ ] **Step 1: Failing tests** for `parallelizable`:
   - two WooCommerce calls → true;
   - a single call → false;
   - WooCommerce plus `escalate_to_human` → false;
   - a WooCommerce call plus a write-capable connector → false;
   - an unknown tool name → false.
- [ ] **Step 2: Run and see it FAIL.**
- [ ] **Step 3: Implement.** When `parallelizable(...)` is true:
   - execute the calls with `Promise.all` over chunks of at most 3;
   - push the tool messages in the **original** `tool_calls` order;
   - keep the existing per-call bookkeeping identical (`executedToolCalls`, `sideEffectsHappened`, `retrievedChunkIds`, escalation flags).

  Otherwise keep the existing serial loop exactly as it is. Avoid duplicating the per-call body: extract it to a local async function used by both paths.
- [ ] **Step 4: Run and see it PASS**: the `ai-agent-reply/` suite, plus `deno check ai-agent-reply/index.ts`.
- [ ] **Step 5: Commit** `feat(agent): run read-only connector calls in one round in parallel`.

---

## Release and acceptance (controller)

1. **Before merging anything in Phase 2:** deploy Task 7 (timings) with Phase 1 so a baseline exists. Collect at least 5 store-question replies on xsellpoint with timings.
2. Apply the Task 8 migration to production, then reload the PostgREST schema cache.
3. Merge. The Dokploy schedule deploys the edge functions (both `ai-agent-reply` and `ai-agent-adapters`). Confirm by file content and restart time.
4. Send the same 5 store questions twice (cold, then warm within 2 minutes). Report p50 and p95 for cold and warm, taken from `metadata.timings`, against the baseline.
5. Decide from the data whether an extra-round cap (the debate's "cap unnecessary additional calls") is worth a Phase 2b.

## Debate round 1 carry-over

This plan was written after Codex's round-1 critique of the Phase 2 sketch. That critique was accepted: measurement first, the category cache first, stock staleness defined, bounded read-only parallelism, prefetch dropped, and "one round" re-scoped. See the verdict table in the Phase 1 plan.
