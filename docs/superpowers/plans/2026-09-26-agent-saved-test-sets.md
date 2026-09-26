# AI Agent saved test sets (roadmap #3) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A business saves test messages for an agent, each with expected checks, and presses **Run all** to see, per case, whether the agent still behaves as expected after any change to its persona, model or knowledge. The checks are:
- the expected intent;
- the connector used, or none;
- text the reply must contain or must avoid;
- whether it hands off to a human.

**User decisions (2026-09-26):**
- **Store calls in tests:** read-only store connectors run for real in test runs.
- **Checks:** all four check types.

**Architecture:**
- **Two owner-only tables**, `ai_agent_test_cases` and `ai_agent_test_runs`.
- **The sandbox path of `ai-agent-reply` gains three things:**
  - an isolated thread per test case (no history bleed);
  - the triage intent in its response;
  - real calls for read-only adapter connectors. Everything with side effects stays simulated.
- **The Test tab gains a "Saved tests" panel.** It runs the cases one after another through the existing sandbox call, evaluates them with a pure evaluator, and stores each run.

**Spec:** `docs/superpowers/specs/2026-09-25-ai-agent-roadmap.md`, Phase 3 #3, plus the debate revision note: "saved test sets need isolated sandbox threads per run, and connector fixtures". Real read-only calls replace fixtures, per the user decision.

## Global Constraints

- Required reading: `ARCHITECTURE.md` (layering, the security rules, structural tenancy §24).
- **Migrations go to the Migrations lane** (Task 1). Apply them to production before merging code that uses them.
- **Tenancy:** both tables have RLS `user_id = auth.uid()` for select, insert, update and delete. Grants go to `authenticated` only; revoke from PUBLIC and anon. `social_account_id` references `social_accounts(id) ON DELETE CASCADE`.
- **Test cases:**
  - `message` is 1–2000 chars;
  - `expected` is jsonb with only these optional keys:
    - `intent`: one of `pricing`, `order_status`, `complaint`, `lead`, `greeting`, `other`;
    - `connector`: a connector name, or the literal `"none"`;
    - `contains`: string[], at most 10, each 1–200 chars;
    - `avoids`: string[], same limits;
    - `escalates`: boolean.
  - The server validates the shape with a CHECK on `jsonb_typeof` and the known keys, and the client validates the full shape.
- **Isolated threads:** the sandbox accepts an optional `test_case_key` matching `^[A-Za-z0-9_-]{1,64}$`. Its conversation id becomes `test_${platform}_${account}_${test_case_key}`. Anything else is refused with 400. With no key, behaviour is identical to today.
- **Real read-only connectors in the sandbox:** only when `readOnlyConnector(tool)` holds. That means not Composio, `shouldUseAdapter(tool)`, and (`read_only_mode === true` or `connector_type === "woocommerce"`), which is the predicate already behind `parallelizable` in `ai-agent-reply/logic.ts`. Extract it and reuse it; do not re-implement it.
  - Composio, `custom_rest` webhooks, `escalate_to_human`, `notify_admin` and any send stay simulated exactly as today.
  - Only the sandbox and the user's own agent can reach this, because the sandbox path requires the user's JWT.
- **Response:** the sandbox JSON response adds `intent: { choice, confidence } | null` from triage. It is `null` when triage is off or unsure. That is not a failure, but an `intent` check on such a case fails with the message "triage did not classify (is Reply triage on?)".
- **Evaluation:**
  - text checks are case-insensitive, trimmed, and normalise Arabic alef variants (أ, إ, آ → ا) and taa marbuta (ة → ه) before matching;
  - `connector: "none"` passes when no custom connector was called;
  - `escalates: true` passes when the response's `escalated` flag is true.
- **Run execution:** one case at a time, in order, stopping on nothing: a failed or errored case is recorded and the run continues. At most 50 cases per run.
- **Tests:** Deno `cd supabase/functions && deno test -A --no-check --node-modules-dir=none _shared/ ai-agent-reply/ ai-agent-adapters/`, plus `deno check --node-modules-dir=none ai-agent-reply/index.ts`. Frontend `node_modules/.bin/vitest run` and `node_modules/.bin/tsc --noEmit -p tsconfig.app.json` with 0 errors. Run Deno before vitest. Use `fireEvent`, never `userEvent`, and `t()` with English defaults plus Arabic keys where neighbouring components have them. Add no new `any`.

---

### Task 1 (Migrations lane): the tables

**File:** `supabase/migrations/20260926110000_ai_agent_test_sets.sql`

- `ai_agent_test_cases`: `id uuid pk default gen_random_uuid()`, `user_id uuid not null references auth.users(id) on delete cascade`, `social_account_id uuid not null references public.social_accounts(id) on delete cascade`, `platform text not null`, `message text not null check (char_length(message) between 1 and 2000)`, `expected jsonb not null default '{}'` with a check that it is an object whose keys are a subset of `{intent, connector, contains, avoids, escalates}`, `position integer not null default 0`, `created_at` and `updated_at timestamptz default now()`.
- `ai_agent_test_runs`: `id uuid pk`, `user_id`, `social_account_id` (same FKs), `platform`, `started_at timestamptz not null default now()`, `finished_at timestamptz`, `summary jsonb not null default '{}'` (passed, failed, errored), `results jsonb not null default '[]'` (array).
- Indexes: `(user_id, social_account_id, position)` on cases; `(user_id, social_account_id, started_at desc)` on runs.
- RLS enabled on both tables, with four owner policies each (`user_id = auth.uid()`).
- Grants: SELECT, INSERT, UPDATE and DELETE to `authenticated`; revoke all from PUBLIC and anon.
- Reuse the project's existing `updated_at` trigger function on cases; find its name in the migrations.
- Idempotent (`IF NOT EXISTS`, drop and recreate the policies), ending with `NOTIFY pgrst, 'reload schema'`.
- Commit: `feat(db): ai agent saved test cases and runs`.

---

### Task 2: The sandbox supports test runs

**Files:**
- `supabase/functions/ai-agent-reply/index.ts` (the sandbox branch at ~line 500–560, and the final `jsonResponse`);
- `supabase/functions/ai-agent-reply/connectorExecution.ts` (`executeAdapterTool`, ~line 231);
- `supabase/functions/ai-agent-reply/logic.ts`: extract `readOnlyConnector` and make `parallelizable` use it;
- tests: `connectorExecution.test.ts` or `connectorRouting.test.ts`, and `parallelizable.test.ts`.

- [ ] **Step 1: Extract the predicate.** `export function readOnlyConnector(tool: { connector_type?: string | null; read_only_mode?: boolean | null; auth_strategy?: string | null; ...fields shouldUseAdapter needs }): boolean`, containing the existing predicate from `parallelizable`, which now calls it. Keep the existing `parallelizable` tests green, and add direct tests for `readOnlyConnector`.
- [ ] **Step 2: Real read-only calls in dry run.**
   - In `executeAdapterTool`, the `if (context.dryRun)` early return now applies only when `!readOnlyConnector(tool)`. A read-only adapter tool proceeds to the real adapter call in dry run.
   - Keep `executeCustomTool` (custom_rest) and the Composio path simulated in dry run, unchanged.
   - Test: a dry-run WooCommerce adapter call reaches the stubbed adapter fetch; a dry-run custom_rest call and a Composio call still return their placeholders.
   - Also check that the connector metering and ledger write (`meterNativeExecution` / `recordConnectorCall`) behave correctly for a sandbox call. If it records `source`, mark sandbox calls with the existing test source value, if one exists; say what you found in the report.
- [ ] **Step 3: Isolated thread.**
   - Read an optional `test_case_key` from the sandbox body.
   - When it is present and matches `^[A-Za-z0-9_-]{1,64}$`, use it: `conversation_id: \`test_${platform}_${sandboxAccountId ?? user.id}_${test_case_key}\``.
   - When it is present and invalid, return `badRequestResponse("Invalid test_case_key")`.
   - When it is absent, keep the conversation id unchanged.
   - Put the key validation in a small pure helper in `logic.ts`, with tests.
- [ ] **Step 4: Intent in the response.** In the final `jsonResponse`, add `intent: triage?.outcome?.answers.intent ?? null`. That response goes to webhook and service-role callers too. It is an added field only, so existing callers ignore it; say so in the report.
- [ ] **Step 5: Gates**, then commit `feat(agent): sandbox test runs — isolated threads, intent, real read-only connectors`.

---

### Task 3: The Saved tests panel

**Files (all new unless noted):**
- `src/features/agent-tests/domain/evaluateTestCase.ts`: pure. `evaluateTestCase(expected, result)` returns `{ passed: boolean; failures: string[] }`, with the normalisation from Global Constraints. It also exports `normaliseForMatch`.
- `src/features/agent-tests/domain/types.ts`: `TestExpectation` and `TestCase`, with a zod schema matching Global Constraints.
- `src/features/agent-tests/infrastructure/testCasesApi.ts`: the case CRUD and the run insert and update through the Supabase client (RLS-scoped). `runTestCase` calls `callEdgeApi("ai-agent-reply", "test", { platform, social_account_id, inbound_text, test_case_key })`, following how `AiAgentTestChat` calls it.
- `src/features/agent-tests/application/useAgentTestSets.ts`: TanStack Query hooks, plus `useRunAllTests`, which runs the cases one after another, sets a progress state, persists the run, and invalidates.
- `src/features/agent-tests/ui/SavedTestsPanel.tsx`:
  - a list of cases with their checks as badges;
  - add, edit and delete through a dialog form (the message plus each optional check);
  - **Run all**, with a progress label ("Running 3/12…");
  - a results table: per case, pass or fail with each failure reason, the reply excerpt, the intent, tools and handoff;
  - the change against the previous run (newly failing and newly passing).
- Modify `src/components/messaging/AiAgentTestChat.tsx`: add a "Save as test" button on each agent reply turn, which opens the add dialog prefilled with the customer message. Render `SavedTestsPanel` below the chat on the Test tab. Find where the Test tab composes `AiAgentTestChat`, and render it there if that fits better.
- `test_case_key`: `${runId}-${caseIndex}`, where `runId` is the created run row id with the hyphens removed and truncated, so the key stays at or under 64 characters and matches the pattern.

- [ ] **Step 1: Failing tests first.**
   - `evaluateTestCase`:
     - each check type passing and failing;
     - Arabic normalisation (أسعار matches اسعار; ة vs ه);
     - `connector: "none"`;
     - an intent check with a null intent, which gives the specific message;
     - an empty expectation always passes.
   - zod schema limits.
   - `SavedTestsPanel`:
     - Run all calls the API once per case, in order, and renders pass/fail;
     - a failing case does not stop the run;
     - "Save as test" prefills the message.
- [ ] **Steps 2–4:** implement, then the gates (the full vitest suite, and tsc at 0).
- [ ] **Step 5: Commit** `feat(agent): saved test sets on the agent Test tab`.

---

## Release and acceptance (controller)

1. Rehearse the Task 1 migration on a schema copy (twice), apply it to production as `supabase_admin`, and reload PostgREST.
2. Merge. Dokploy deploys the functions and the frontend; verify both.
3. Live, on the xsellpoint WhatsApp agent's Test tab, with 4 cases:
   - "كم سعر عطر ديور سوفاج؟" expects intent pricing, connector woocommerce_store, and the reply contains "د.ك" or a price digit;
   - "ابغى اكلم موظف" expects a handoff;
   - "السلام عليكم" expects intent greeting and connector none;
   - "وين طلبي؟" expects intent order_status.

   Run all: every case passes or fails for a reason shown in the table, and no case's history leaks into another.

---

## Debate round 1: Codex astra 6 medium (`gpt-6-astra`, medium effort, `--sandbox read-only`). Verdict: REWORK

**The table below is binding. Where it differs from the task text above, the table wins.**

| # | Finding | Ruling | Binding change |
|---|---|---|---|
| A | Live data and model variation make results non-deterministic | **accept** | Each run stores a snapshot: per case, the expectation as it ran, plus the run's `used_model` and triage state. Results distinguish **passed**, **failed** (an assertion), **errored** (infrastructure: HTTP error, skipped or error body, timeout) and **indeterminate** (see #3). The UI labels this as live smoke testing. |
| 1 | Real sandbox calls go unmetered | **accept** | Task 2: a real read-only call in dry run goes through the existing metering path (`meterNativeExecution` / `recordConnectorCall`) with `source: "test"`, which `_shared/connectorTelemetry.ts` already supports. The per-run cap is lowered to **25 cases**. |
| 2 | "Dry run" now uses production credentials; a fetch stub can't prove safety | **partial** | This is intended; the user chose real read-only calls. The safety boundary is the dispatcher's refusal of non-GET operations (`ai-agent-adapters/dispatcher.ts`). Task 2 adds adapter tests: a write capability is refused in execute; missing credentials give a clean failure; the failure output carries no secrets. Full vendor 429 simulation is out of scope. |
| 3 | Automatic retries defeat isolation | **accept** | Task 3 adds `callEdgeApi(fn, action, body, { retry: false })`, an options arg whose default is unchanged. Test runs use `retry: false`. A gateway 502/503/504 or a network error on a case is recorded as **indeterminate** and never retried. |
| 4 | Test threads accumulate forever | **accept** | Task 3: when a run ends (completed or interrupted), delete that run's `ai_threads` rows by their **exact** conversation ids, built from the run's case keys. Existing RLS "Users manage own ai threads" allows this, and messages cascade. There is never a prefix delete. |
| 5 | No durable lifecycle for browser-run tests | **partial** | The run row gets `status` (`running`, `completed`, `interrupted`), added in Task 1. Each case result is appended to the run row as soon as it finishes (a checkpoint). Each request has a 70 s browser timeout (AbortController). On load, a `running` run older than 30 minutes is shown as interrupted. Comparison uses completed runs only, by stable case id. Server-side durable execution is out of scope. |
| 6 | Owner RLS does not validate account ownership; client-only zod | **accept** | Task 1: a composite FK `(social_account_id, user_id, platform)` → `social_accounts (id, user_id, platform)` on both tables, the same pattern as `20260828190000_account_configs_prepare.sql`, using the existing `social_accounts_id_user_id_platform_key`. `expected` gets server-side CHECKs on value types and limits (intent enum, connector string ≤100, contains/avoids arrays ≤10 items of strings 1–200, escalates boolean) through an `IMMUTABLE` validation function used in the CHECK. |
| 7 | False passes: skip/error bodies at HTTP 200; `tool_calls` counts attempts | **accept** | The evaluator validates the response contract first: only `ok === true` with a `reply` string is evaluated, and anything else is **errored**. The "connector used" check reads **"connector called"** in the UI (attempted, not proven successful); proving success is deferred to the `resultCount` work in Phase 2b Slice 2. A case with an empty expectation shows **"no assertions"**, not "passed". |
| 8 | "Null when unsure" is not implemented; triage off | **accept** | Task 2: the response carries `intent` only when confidence ≥ `TRIAGE_CONFIDENCE`, plus `intent_status: "off" \| "uncertain" \| "classified"`. On an intent check, `off` and `uncertain` count as **errored** with that reason, not as failed. Triage is never enabled for tests. |
| 9 | Saved chat turns lose the `act_as_admin` and conversation context | **partial** | Saved cases are standalone customer messages. "Save as test" saves only the customer message and says so in the dialog ("runs as a new customer, without earlier messages"). The chat state resets when the account changes. |
| 10 | Deploy claim; types; ports | **partial** | **Rejected** that edge functions need a manual deploy: the Dokploy schedule syncs and restarts on merge, verified on every merge PR #195–#206. **Accepted** updating `src/integrations/supabase/types.ts` for the two tables. **Accepted** following the `src/features/agent-dashboard` feature structure (domain, infrastructure, application, ui) for composition. |
| C | Things that must not change | **accept** | Preserve the JWT, account and platform ownership checks; the field-by-field sandbox request; simulated sends, webhooks, Composio and handoffs; admin-only filtering; deadlines; and chat behaviour with no key. Reuse `public.update_updated_at_column()` and the existing parallelizable predicate without broadening it. |
