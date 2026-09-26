# Agent Procedures (Spec A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the AI agent run five fixed, multi-turn customer flows. Each account toggles and edits them. They are started by Jev intent or by the model, held as state on the thread, and finished by an end action.

**Architecture:**
- **Pure engine:** state transitions in `_shared/procedures/`, with no I/O, fully unit-tested.
- **Turn adapter:** `ai-agent-reply/procedureRuntime.ts` exposes three tools to the model and runs the end actions through injected ports.
- **Wiring:** `ai-agent-reply/index.ts` loads the state from the thread row, applies lazy expiry and the Jev start, keeps the procedure tools through the smalltalk fast path, and writes the new state together with the delivered turn.
- **Config:** lives in `ai_agent_configs.agent_behavior.procedures`. It is validated strictly on save and leniently on read.

**Tech Stack:**
- Deno edge functions: TypeScript, `deno test`.
- React 18 + TypeScript + Vite frontend: vitest, Testing Library.
- Postgres 17: self-hosted Supabase.

**Spec:** `docs/superpowers/specs/2026-09-26-agent-procedures-a-design.md`

**Required reading for every implementer:** `ARCHITECTURE.md` (layering, dependency direction, Edge Function shape, security rules). It is not auto-loaded; open it.

## Global Constraints

- Every flow defaults to off. With `agent_behavior.procedures` absent, replies behave exactly as today.
- Procedure keys (exact): `order_status`, `lead_capture`, `complaint_return`, `booking`, `product_finder`.
- Intents after this change (exact order): `pricing`, `order_status`, `complaint`, `lead`, `booking`, `greeting`, `other`.
- Jev start mapping: `order_status→order_status`, `lead→lead_capture`, `complaint→complaint_return`, `booking→booking`. `product_finder` is never started by Jev.
- Start threshold: intent confidence ≥ `TRIAGE_CONFIDENCE` (0.8, `_shared/agentTriage.ts:32`).
- Lazy expiry: a state is cleared when `updated_at` is more than 24 h old, or when `version` differs from the template's.
- Off-script limit: 3 consecutive off-script turns end the flow; a valid submit resets the counter to 0.
- Leads and bookings go into `public.leads`:
  - `form_id` null;
  - `meta_lead_id = 'ai:' || run_id`;
  - `status 'new'`;
  - `lead_data` is a flat `Record<string,string>` with `kind` (`lead`|`booking`), `source` (`ai_agent`), `platform`, `social_account_id`, `conversation_id` and the fields.
- Config text limits:
  - each prompt and closing text ≤ 300 characters;
  - `product_finder.questions` holds 2–3 items, each ≤ 300 characters;
  - `booking.services` holds ≤ 20 items, each ≤ 60 characters.
- Platforms and surfaces:
  - DMs only on `whatsapp`, `facebook` and `instagram`;
  - a request with `comment_id` never starts or continues a flow;
  - `threads` is excluded.
- Sandbox (`dryRun`):
  - read-only store tools run for real;
  - the lead/booking insert, the admin notification and the handoff are simulated;
  - the state still advances and clears.
- The state is written only by `persistDelivery` on a fresh send. The redelivery path never writes it.
- Secrets: none are added. No API key or credential is logged, returned, or placed in a migration, fixture or commit.
- The new `Booking` label colour is `#f59e0b`.

## Debate round 1: Codex astra 6 medium (`gpt-6-astra`, reasoning effort medium, read-only sandbox), 2026-09-26. Verdict: REWORK

The rulings are binding. Tasks 2, 3, 5, 6 and 7 above already include the accepted changes.

| # | Finding (severity) | Ruling | Reason / where it landed |
|---|---|---|---|
| 1 | Redelivery loses the procedure transition (Blocking) | **Accept** | The state is now written when the reply is final, **before** the send (Task 6 step 3.8). Redelivery sends text that already matches the stored state and replays no tools. Cost: a failed send leaves the state one step ahead, and the next turn's block re-asks. Spec D4 revised. |
| 2 | `run_id` does not make end actions retry-safe (Important) | **Accept** | `runId = outboxId ?? uuid` (a regenerated turn reuses the id). `saveLead` reports whether it created the row, and only the creating call alerts the admin (Task 5). |
| 3 | Store flows complete before the lookup runs (Important) | **Accept** | The runtime runs the typed capability itself through `storeLookup` (`lookup_orders {order_id}`, `search_products {query}`, via `executeRoutedCustomTool`). It completes only on a result; an error keeps the final step. The lookup is independent of triage's connector filter. |
| 4 | Iteration limits can leave writes followed by silence (Important) | **Accept** | `iterationBudget`: a procedure tool on the last permitted round earns one text-only round. The wall-clock guard still wins. Tested at limits 1 and 3. |
| 5 | Jev's handoff path does not end a flow (Important) | **Accept** | `triagePlan.handoff` calls `endForHandoff()` before the model runs, as does any tool result with `escalated`. Procedure tools are refused after a handoff. |
| 6 | Complaint completion drops the escalation flags (Important) | **Accept** | The handoff end action returns the escalation `ToolResult` whole. |
| 7 | Customer values promoted into system instructions (Important) | **Accept** | The system block names fields but never their values. Values appear only in tool results and in alerts and summaries through `sanitizeFieldValue` (one line, JSON-quoted, ≤ 500 characters). No cross-tenant path was found; ownership comes from server context. |
| 8 | Notification failure treated as success (Important) | **Partial** | The saved lead is the outcome; an alert that reaches nobody is logged to `system_logs` and does **not** block completion or retry, because a retry would risk duplicate alerts. Spec "Error handling" revised. |
| 9 | Disabling one active flow does not stop it (Important) | **Accept** | `createProcedureTurn` drops a stored state whose own flow is disabled or invalid. |
| 10 | Authored guidance missing after a model start; services unused (Important) | **Accept** | `stepGuidance` goes into every tool result and the prompt block, including product finder questions and booking services. |
| 11 | "Photo attached" is not tied to a real image (Important) | **Partial** | The photo field is removed from `complaint_return`. The request has no attachment reference, and the human taking the handoff sees any photo in the chat. Spec D2 revised. |
| 12 | Plan permits an import cycle (Important) | **Accept** | `AgentBehaviorError` moves unconditionally to `_shared/agentBehaviorError.ts`, re-exported from `agentBehavior.ts` (Task 3 step 4). |
| C | i18n: an English locale file would never load | **Accept** | English uses inline `t()` defaults; Arabic goes in `src/i18n/locales/ar/agent.json` (Tasks 4 and 7). |

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `supabase/migrations/20260926120000_agent_procedures.sql` | create | `ai_threads.procedure_state`; replace `ai_agent_test_expected_valid` to admit `booking` |
| `supabase/tests/agent_procedures.sql` | create | SQL assertions for the migration |
| `supabase/functions/_shared/procedures/templates.ts` | create | Template definitions, field validators, `PROCEDURE_KEYS`, `JEV_START` |
| `supabase/functions/_shared/procedures/engine.ts` | create | Pure transitions: start, submit, off-script, expire, cancel |
| `supabase/functions/_shared/procedures/config.ts` | create | `parseProcedureConfig` (strict) and `readProcedureConfig` (lenient) |
| `supabase/functions/_shared/procedures/*.test.ts` | create | Engine and config tests |
| `supabase/functions/_shared/agentBehavior.ts` | modify | Accept the `procedures` key through `parseProcedureConfig` |
| `supabase/functions/_shared/agentTriage.ts` | modify | Add the `booking` intent and criterion; narrow `lead` |
| `supabase/functions/ai-agent-reply/intentLabels.ts` | modify | Add the `Booking` label |
| `supabase/functions/ai-agent-reply/procedureRuntime.ts` | create | Tool definitions, handlers, end actions, turn outcome |
| `supabase/functions/ai-agent-reply/procedureRuntime.test.ts` | create | Runtime tests with fake ports |
| `supabase/functions/ai-agent-reply/logic.ts` | modify | `procedurePromptBlock`, `procedureTurnGate` |
| `supabase/functions/ai-agent-reply/index.ts` | modify | Wiring |
| `src/lib/procedureTemplates.ts` | create | Browser mirror of keys, fields and limits |
| `src/lib/__tests__/procedureTemplates.test.ts` | create | Parity test against the Deno module |
| `src/lib/agentProfile.ts` | modify | `AgentBehavior.procedures` type |
| `src/components/messaging/agent-settings/ProceduresCard.tsx` | create | Authoring UI |
| `src/components/messaging/AiAgentManager.tsx` | modify | Mount the card with the other behavior cards |
| `src/features/agent-tests/domain/types.ts` | modify | `TEST_INTENTS` gains `booking` |
| `src/features/agent-dashboard/ui/AgentDashboardView.tsx` | modify | Booking intent label |
| `src/i18n/locales/ar/agent.json` | modify | Arabic strings (English is the inline `t()` default) |

**Lanes:**
- Task 1 is SQL: Muse Spark (`opencode/muse-spark-1.3-contributor-free`).
- Tasks 2–7 are code: Grok 4.7 medium.
- Tasks 2–4 are disjoint from Task 1 and may run in parallel with it.

---

### Task 1: Migration and SQL test (Muse Spark lane)

**Files:**
- Create: `supabase/migrations/20260926120000_agent_procedures.sql`
- Create: `supabase/tests/agent_procedures.sql`

**Interfaces:**
- Produces: the column `public.ai_threads.procedure_state jsonb NULL`. It also produces `public.ai_agent_test_expected_valid(jsonb)`, which accepts intent `booking` and is otherwise unchanged.

- [ ] **Step 1: Read the function being replaced.** Open `supabase/migrations/20260926110000_ai_agent_test_sets.sql` and copy the whole `CREATE OR REPLACE FUNCTION public.ai_agent_test_expected_valid(...)` definition, including its signature, `LANGUAGE`, volatility, `SET search_path` and grants. The new definition must keep **the same argument list**: `CREATE OR REPLACE` with different arguments adds an overload instead of replacing.

- [ ] **Step 2: Write the migration**

```sql
-- Procedures (Spec A): per-conversation flow state, and the booking intent for saved tests.
BEGIN;

ALTER TABLE public.ai_threads
  ADD COLUMN IF NOT EXISTS procedure_state jsonb;

COMMENT ON COLUMN public.ai_threads.procedure_state IS
  'Active AI agent procedure for this conversation, or NULL. Written only by ai-agent-reply on a delivered turn.';

-- Same signature as 20260926110000; only the intent list gains 'booking'.
CREATE OR REPLACE FUNCTION public.ai_agent_test_expected_valid(e jsonb)
  -- (body copied verbatim from 20260926110000, with the IN list changed to:)
  -- ('pricing', 'order_status', 'complaint', 'lead', 'booking', 'greeting', 'other')
  ...;

COMMIT;
```

Write the full function body. The `...` above stands for the copied definition, which the implementer pastes in whole; nothing else changes. No new grants are needed, because the column inherits the table's grants and RLS.

- [ ] **Step 3: Write the SQL test**

```sql
-- supabase/tests/agent_procedures.sql
BEGIN;
DO $$
BEGIN
  ASSERT (SELECT data_type FROM information_schema.columns
          WHERE table_schema='public' AND table_name='ai_threads' AND column_name='procedure_state') = 'jsonb',
    'P1 procedure_state is jsonb';
  ASSERT (SELECT is_nullable FROM information_schema.columns
          WHERE table_schema='public' AND table_name='ai_threads' AND column_name='procedure_state') = 'YES',
    'P2 procedure_state is nullable';
  ASSERT public.ai_agent_test_expected_valid('{"intent":"booking"}'::jsonb), 'P3 booking accepted';
  ASSERT public.ai_agent_test_expected_valid('{"intent":"pricing"}'::jsonb), 'P4 existing intent still accepted';
  ASSERT NOT public.ai_agent_test_expected_valid('{"intent":"weather"}'::jsonb), 'P5 unknown intent rejected';
  ASSERT (SELECT count(*) FROM pg_proc WHERE proname='ai_agent_test_expected_valid') = 1, 'P6 no overload added';
END $$;
ROLLBACK;
```

- [ ] **Step 4: Rehearse on Contabo, never locally and never in production.**
  1. `pg_dump --schema-only` the production DB into `rehearsal_proc`.
  2. Apply the migration twice (idempotent).
  3. Run the test file; expect no ASSERT failure.
  4. Drop `rehearsal_proc`.

  Follow the pattern in memory `postora-migration-rehearsal-on-contabo`.

- [ ] **Step 5: Hand back uncommitted.** The orchestrator reviews and commits.

---

### Task 2: Templates and the pure engine (Grok lane)

**Files:**
- Create: `supabase/functions/_shared/procedures/templates.ts`
- Create: `supabase/functions/_shared/procedures/engine.ts`
- Test: `supabase/functions/_shared/procedures/engine.test.ts`

**Interfaces:**
- Produces (exact exports):
  - `templates.ts`: `PROCEDURE_KEYS`, `type ProcedureKey`, `type ProcedureOrigin`, `interface ProcedureField`, `interface ProcedureTemplate`, `TEMPLATES`, `JEV_START`, `productFinderFields(count: number): ProcedureField[]`, `STALE_AFTER_MS`, `OFF_SCRIPT_LIMIT`.
  - `engine.ts`: `interface ProcedureState`, `startProcedure`, `submitFields`, `recordOffScript`, `expireIfStale`, `nextField`.

- [ ] **Step 1: Write `templates.ts`**

```ts
// Procedure templates (Spec A, D2). Pure data plus validators; no I/O.
import type { Intent } from "../agentTriage.ts";

export const PROCEDURE_KEYS = ["order_status", "lead_capture", "complaint_return", "booking", "product_finder"] as const;
export type ProcedureKey = typeof PROCEDURE_KEYS[number];
export type ProcedureOrigin = "jev" | "model" | "event";
export type EndAction = "order_lookup" | "save_lead" | "handoff" | "save_booking" | "product_search";

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
export const OFF_SCRIPT_LIMIT = 3;

export interface ProcedureField {
  name: string;
  /** Normalized value, or null when the input does not satisfy the field. */
  validate: (raw: string) => string | null;
}

export interface ProcedureTemplate {
  key: ProcedureKey;
  version: number;
  fields: ProcedureField[];
  endAction: EndAction;
  /** A store capability the account must have, or the flow cannot start. */
  needsCapability?: "lookup_orders" | "search_products";
}

const text = (max: number) => (raw: string) => {
  const value = raw.trim();
  return value.length >= 1 && value.length <= max ? value : null;
};
const orderNumber = (raw: string) => {
  const value = raw.trim().replace(/^#/, "");
  return /^\d{1,12}$/.test(value) ? value : null;
};
const contact = (raw: string) => {
  const value = raw.trim();
  return value.length >= 3 && value.length <= 120 ? value : null;
};

export function productFinderFields(count: number): ProcedureField[] {
  return Array.from({ length: count }, (_, index) => ({ name: `answer_${index + 1}`, validate: text(300) }));
}

export const TEMPLATES: Record<ProcedureKey, ProcedureTemplate> = {
  order_status: {
    key: "order_status", version: 1, endAction: "order_lookup", needsCapability: "lookup_orders",
    fields: [{ name: "order_number", validate: orderNumber }],
  },
  lead_capture: {
    key: "lead_capture", version: 1, endAction: "save_lead",
    fields: [
      { name: "name", validate: text(120) },
      { name: "contact", validate: contact },
      { name: "product", validate: text(500) },
    ],
  },
  complaint_return: {
    // No photo field (debate verdict 11): the request carries no attachment reference, and the
    // human who takes the handoff sees any photo in the chat itself.
    key: "complaint_return", version: 1, endAction: "handoff",
    fields: [
      { name: "order_number", validate: orderNumber },
      { name: "problem", validate: text(500) },
    ],
  },
  booking: {
    key: "booking", version: 1, endAction: "save_booking",
    fields: [
      { name: "service", validate: text(120) },
      { name: "when", validate: text(120) },
    ],
  },
  product_finder: {
    // Fields come from the business's 2–3 questions: productFinderFields(questions.length).
    key: "product_finder", version: 1, endAction: "product_search", needsCapability: "search_products",
    fields: [],
  },
};

/** Jev intent → procedure. product_finder is deliberately absent (Spec A, D3). */
export const JEV_START: Partial<Record<Intent, ProcedureKey>> = {
  order_status: "order_status",
  lead: "lead_capture",
  complaint: "complaint_return",
  booking: "booking",
};
```

`Intent` gains `booking` in Task 4. Until then, `JEV_START`'s `booking` key fails `deno check`, so Task 4 must land before this file is checked. It is in the same branch, and the orchestrator runs `deno check` only after Tasks 2 and 4.

- [ ] **Step 2: Write the failing engine tests**

```ts
// supabase/functions/_shared/procedures/engine.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { expireIfStale, nextField, recordOffScript, startProcedure, submitFields } from "./engine.ts";
import { TEMPLATES } from "./templates.ts";

const T0 = new Date("2026-09-26T10:00:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const lead = TEMPLATES.lead_capture.fields;

Deno.test("starting with no active flow creates state at the first field", () => {
  const result = startProcedure(null, "lead_capture", "jev", T0, "run-1");
  assertEquals(result.started, true);
  assertEquals(result.state, {
    run_id: "run-1", key: "lead_capture", version: 1, step: 0, fields: {}, off_script: 0,
    origin: "jev", started_at: T0.toISOString(), updated_at: T0.toISOString(),
  });
});

Deno.test("starting while a flow is active keeps the active flow", () => {
  const active = startProcedure(null, "order_status", "model", T0, "run-1").state;
  const result = startProcedure(active, "lead_capture", "jev", later(1000), "run-2");
  assertEquals(result.started, false);
  assertEquals(result.state, active);
});

Deno.test("a valid partial submit advances to the next missing field and resets off-script", () => {
  const started = { ...startProcedure(null, "lead_capture", "jev", T0, "run-1").state, off_script: 2 };
  const result = submitFields(started, lead, { name: " Sara " }, later(1000));
  assertEquals(result.accepted, ["name"]);
  assertEquals(result.rejected, []);
  assertEquals(result.complete, false);
  assertEquals(result.state.fields, { name: "Sara" });
  assertEquals(result.state.step, 1);
  assertEquals(result.state.off_script, 0);
  assertEquals(nextField(result.state, lead)?.name, "contact");
});

Deno.test("invalid values are rejected with the field name and do not advance", () => {
  const started = startProcedure(null, "order_status", "jev", T0, "run-1").state;
  const result = submitFields(started, TEMPLATES.order_status.fields, { order_number: "abc" }, later(1));
  assertEquals(result.accepted, []);
  assertEquals(result.rejected, [{ field: "order_number", reason: "invalid" }]);
  assertEquals(result.state.step, 0);
});

Deno.test("unknown field names are rejected, not stored", () => {
  const started = startProcedure(null, "booking", "jev", T0, "run-1").state;
  const result = submitFields(started, TEMPLATES.booking.fields, { colour: "red" }, later(1));
  assertEquals(result.rejected, [{ field: "colour", reason: "unknown" }]);
  assertEquals(result.state.fields, {});
});

Deno.test("submitting every field in one call completes the flow", () => {
  const started = startProcedure(null, "order_status", "model", T0, "run-1").state;
  const result = submitFields(started, TEMPLATES.order_status.fields, { order_number: "#1234" }, later(1));
  assertEquals(result.complete, true);
  assertEquals(result.state.fields, { order_number: "1234" });
});

Deno.test("a partly invalid submit keeps the valid field and reports the invalid one", () => {
  const fields = TEMPLATES.complaint_return.fields;
  const started = startProcedure(null, "complaint_return", "jev", T0, "run-1").state;
  const result = submitFields(started, fields, { order_number: "x7", problem: "broken" }, later(1));
  assertEquals(result.accepted, ["problem"]);
  assertEquals(result.rejected, [{ field: "order_number", reason: "invalid" }]);
  assertEquals(result.complete, false);
  assertEquals(result.state.step, 0);
});

Deno.test("the third consecutive off-script turn ends the flow", () => {
  let state = startProcedure(null, "booking", "jev", T0, "run-1").state;
  state = recordOffScript(state, later(1))!;
  state = recordOffScript(state, later(2))!;
  assertEquals(state.off_script, 2);
  assertEquals(recordOffScript(state, later(3)), null);
});

for (const [label, ageMs, version, expected] of [
  ["fresh state is kept", 60_000, 1, "kept"],
  ["state older than 24 h expires", 24 * 60 * 60 * 1000 + 1, 1, "expired"],
  ["state from an older template version expires", 60_000, 0, "expired"],
] as const) {
  Deno.test(`expireIfStale: ${label}`, () => {
    const state = { ...startProcedure(null, "booking", "jev", T0, "run-1").state, version };
    const result = expireIfStale(state, later(ageMs));
    assertEquals(result === null ? "expired" : "kept", expected);
  });
}
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd supabase/functions && deno test -A --no-check --node-modules-dir=none _shared/procedures/`
Expected: FAIL, "Module not found … engine.ts".

- [ ] **Step 4: Write `engine.ts`**

```ts
// Pure procedure state transitions (Spec A, D3–D5). Callers pass time and ids in.
import { OFF_SCRIPT_LIMIT, type ProcedureField, type ProcedureKey, type ProcedureOrigin, STALE_AFTER_MS, TEMPLATES } from "./templates.ts";

export interface ProcedureState {
  run_id: string;
  key: ProcedureKey;
  version: number;
  step: number;
  fields: Record<string, string>;
  off_script: number;
  origin: ProcedureOrigin;
  started_at: string;
  updated_at: string;
}

export interface SubmitResult {
  state: ProcedureState;
  accepted: string[];
  rejected: Array<{ field: string; reason: "invalid" | "unknown" }>;
  complete: boolean;
}

export function startProcedure(
  state: ProcedureState | null,
  key: ProcedureKey,
  origin: ProcedureOrigin,
  now: Date,
  runId: string,
): { state: ProcedureState; started: boolean } {
  if (state) return { state, started: false };
  const at = now.toISOString();
  return {
    started: true,
    state: {
      run_id: runId, key, version: TEMPLATES[key].version, step: 0, fields: {}, off_script: 0,
      origin, started_at: at, updated_at: at,
    },
  };
}

export function nextField(state: ProcedureState, fields: ProcedureField[]): ProcedureField | null {
  return fields.find((field) => !(field.name in state.fields)) ?? null;
}

export function submitFields(
  state: ProcedureState,
  fields: ProcedureField[],
  input: Record<string, unknown>,
  now: Date,
): SubmitResult {
  const byName = new Map(fields.map((field) => [field.name, field]));
  const collected = { ...state.fields };
  const accepted: string[] = [];
  const rejected: SubmitResult["rejected"] = [];
  for (const [name, raw] of Object.entries(input)) {
    const field = byName.get(name);
    if (!field) {
      rejected.push({ field: name, reason: "unknown" });
      continue;
    }
    const value = typeof raw === "string" ? field.validate(raw) : null;
    if (value === null) {
      rejected.push({ field: name, reason: "invalid" });
      continue;
    }
    collected[name] = value;
    accepted.push(name);
  }
  const step = fields.findIndex((field) => !(field.name in collected));
  const next: ProcedureState = {
    ...state,
    fields: collected,
    step: step === -1 ? fields.length : step,
    off_script: accepted.length ? 0 : state.off_script,
    updated_at: now.toISOString(),
  };
  return { state: next, accepted, rejected, complete: step === -1 };
}

/** One more consecutive off-script turn; null once the limit is reached. */
export function recordOffScript(state: ProcedureState, now: Date): ProcedureState | null {
  const offScript = state.off_script + 1;
  if (offScript >= OFF_SCRIPT_LIMIT) return null;
  return { ...state, off_script: offScript, updated_at: now.toISOString() };
}

/** Lazy expiry: evaluated at the start of a turn, never by a cron job. */
export function expireIfStale(state: ProcedureState | null, now: Date): ProcedureState | null {
  if (!state) return null;
  const template = TEMPLATES[state.key];
  if (!template || state.version !== template.version) return null;
  return now.getTime() - Date.parse(state.updated_at) > STALE_AFTER_MS ? null : state;
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd supabase/functions && deno test -A --no-check --node-modules-dir=none _shared/procedures/`
Expected: PASS, 11 tests.

- [ ] **Step 6: Hand back uncommitted.**

---

### Task 3: Procedure config, strict on save and lenient on read (Grok lane)

**Files:**
- Create: `supabase/functions/_shared/procedures/config.ts`
- Modify: `supabase/functions/_shared/agentBehavior.ts` (the `AgentBehavior` interface, `BEHAVIOR_KEYS`, `parseAgentBehavior`)
- Test: `supabase/functions/_shared/procedures/config.test.ts`; add cases to `supabase/functions/_shared/agentBehavior.test.ts`

**Interfaces:**
- Consumes: `PROCEDURE_KEYS` and `ProcedureKey` from Task 2.
- Produces:
  - `interface ProcedureSettings { enabled: boolean; prompts: Record<string,string>; closing: string; questions?: string[]; services?: string[] }`;
  - `type ProcedureConfig = Partial<Record<ProcedureKey, ProcedureSettings>>`;
  - `parseProcedureConfig(input: unknown): ProcedureConfig`, which throws `AgentBehaviorError`;
  - `readProcedureConfig(input: unknown): ProcedureConfig`, which never throws and drops invalid flows;
  - `enabledProcedures(config: ProcedureConfig): ProcedureKey[]`.

- [ ] **Step 1: Write the failing tests**

```ts
// supabase/functions/_shared/procedures/config.test.ts
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { enabledProcedures, parseProcedureConfig, readProcedureConfig } from "./config.ts";
import { AgentBehaviorError } from "../agentBehaviorError.ts";

const valid = {
  order_status: { enabled: true, prompts: { order_number: "Ask for the order number" }, closing: "" },
  product_finder: { enabled: true, prompts: {}, closing: "", questions: ["Budget?", "For whom?"] },
};

Deno.test("a valid config round-trips and lists enabled flows in key order", () => {
  const parsed = parseProcedureConfig(valid);
  assertEquals(parsed.order_status?.prompts, { order_number: "Ask for the order number" });
  assertEquals(enabledProcedures(parsed), ["order_status", "product_finder"]);
});

for (const [label, input] of [
  ["unknown procedure key", { weather: { enabled: true, prompts: {}, closing: "" } }],
  ["prompt longer than 300 characters", { lead_capture: { enabled: true, prompts: { name: "x".repeat(301) }, closing: "" } }],
  ["product finder with one question", { product_finder: { enabled: true, prompts: {}, closing: "", questions: ["only"] } }],
  ["product finder with four questions", { product_finder: { enabled: true, prompts: {}, closing: "", questions: ["a", "b", "c", "d"] } }],
  ["21 booking services", { booking: { enabled: true, prompts: {}, closing: "", services: Array(21).fill("s") } }],
  ["prompt for a field the template lacks", { booking: { enabled: true, prompts: { colour: "x" }, closing: "" } }],
] as const) {
  Deno.test(`parseProcedureConfig rejects ${label}`, () => {
    assertThrows(() => parseProcedureConfig(input), AgentBehaviorError);
  });
}

Deno.test("readProcedureConfig drops only the invalid flow and never throws", () => {
  const read = readProcedureConfig({
    ...valid,
    product_finder: { enabled: true, prompts: {}, closing: "", questions: ["only"] },
  });
  assertEquals(enabledProcedures(read), ["order_status"]);
  assertEquals(readProcedureConfig("garbage"), {});
  assertEquals(readProcedureConfig(undefined), {});
});
```

In `agentBehavior.test.ts`, add one test showing that `parseAgentBehavior({ procedures: valid })` keeps `procedures`, and one showing that `parseAgentBehavior({ procedures: { weather: {} } })` throws `AgentBehaviorError`.

- [ ] **Step 2: Run the tests to verify they fail.** Run `deno test -A --no-check --node-modules-dir=none _shared/procedures/config.test.ts _shared/agentBehavior.test.ts`. Expected: FAIL, the module is missing.

- [ ] **Step 3: Write `config.ts`**

```ts
// agent_behavior.procedures (Spec A, D8). Strict on save, lenient on read.
import { AgentBehaviorError } from "../agentBehaviorError.ts";
import { PROCEDURE_KEYS, type ProcedureKey, TEMPLATES } from "./templates.ts";

export interface ProcedureSettings {
  enabled: boolean;
  prompts: Record<string, string>;
  closing: string;
  questions?: string[];
  services?: string[];
}
export type ProcedureConfig = Partial<Record<ProcedureKey, ProcedureSettings>>;

const MAX_TEXT = 300;
const MAX_SERVICES = 20;
const MAX_SERVICE = 60;

function fail(message: string): never {
  throw new AgentBehaviorError(message);
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length > max) fail(`${field} must be text of at most ${max} characters`);
  return value;
}

function parseSettings(key: ProcedureKey, value: unknown): ProcedureSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`procedures.${key} must be an object`);
  const source = value as Record<string, unknown>;
  if (typeof source.enabled !== "boolean") fail(`procedures.${key}.enabled must be true or false`);
  const fieldNames = new Set(TEMPLATES[key].fields.map((field) => field.name));
  const promptsIn = (source.prompts ?? {}) as Record<string, unknown>;
  if (typeof promptsIn !== "object" || Array.isArray(promptsIn)) fail(`procedures.${key}.prompts must be an object`);
  const prompts: Record<string, string> = {};
  for (const [name, text] of Object.entries(promptsIn)) {
    if (!fieldNames.has(name)) fail(`procedures.${key}.prompts.${name} is not a field of this procedure`);
    prompts[name] = boundedText(text, `procedures.${key}.prompts.${name}`, MAX_TEXT);
  }
  const settings: ProcedureSettings = {
    enabled: source.enabled,
    prompts,
    closing: boundedText(source.closing ?? "", `procedures.${key}.closing`, MAX_TEXT),
  };
  if (key === "product_finder") {
    const questions = source.questions;
    if (!Array.isArray(questions) || questions.length < 2 || questions.length > 3) {
      fail("procedures.product_finder.questions must hold 2 or 3 questions");
    }
    settings.questions = questions.map((q, i) => boundedText(q, `procedures.product_finder.questions[${i}]`, MAX_TEXT));
  }
  if (key === "booking" && source.services !== undefined) {
    if (!Array.isArray(source.services) || source.services.length > MAX_SERVICES) {
      fail(`procedures.booking.services must hold at most ${MAX_SERVICES} items`);
    }
    settings.services = source.services.map((s, i) => boundedText(s, `procedures.booking.services[${i}]`, MAX_SERVICE));
  }
  return settings;
}

export function parseProcedureConfig(input: unknown): ProcedureConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail("procedures must be an object");
  const config: ProcedureConfig = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(PROCEDURE_KEYS as readonly string[]).includes(key)) fail(`Unknown procedure: ${key}`);
    config[key as ProcedureKey] = parseSettings(key as ProcedureKey, value);
  }
  return config;
}

/** The reply path must never fail on stored config: an invalid flow counts as disabled. */
export function readProcedureConfig(input: unknown): ProcedureConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const config: ProcedureConfig = {};
  for (const key of PROCEDURE_KEYS) {
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined) continue;
    try {
      config[key] = parseSettings(key, value);
    } catch (error) {
      if (!(error instanceof AgentBehaviorError)) throw error;
      console.warn(`[procedures] ignoring invalid ${key} config: ${error.message}`);
    }
  }
  return config;
}

export function enabledProcedures(config: ProcedureConfig): ProcedureKey[] {
  return PROCEDURE_KEYS.filter((key) => config[key]?.enabled === true);
}
```

- [ ] **Step 4: Wire the new key into `agentBehavior.ts`, with no import cycle (debate verdict 12, ARCHITECTURE.md import-cycle rule).**
  1. Move `class AgentBehaviorError` from `agentBehavior.ts` into a new dependency-free module, `supabase/functions/_shared/agentBehaviorError.ts`.
  2. In `agentBehavior.ts`, import it from there and re-export it (`export { AgentBehaviorError } from "./agentBehaviorError.ts";`), so every existing importer keeps working unchanged.
  3. `procedures/config.ts` imports `AgentBehaviorError` from `../agentBehaviorError.ts`, never from `agentBehavior.ts`.
  4. Add `procedures?: ProcedureConfig;` to `AgentBehavior`, `"procedures"` to `BEHAVIOR_KEYS`, and in `parseAgentBehavior` the line `if (source.procedures !== undefined) behavior.procedures = parseProcedureConfig(source.procedures);`.

- [ ] **Step 5: Run the tests to verify they pass.** Same command. Expected: PASS.

- [ ] **Step 6: Hand back uncommitted.**

---

### Task 4: The `booking` intent at every site (Grok lane)

**Files:**
- Modify: `supabase/functions/_shared/agentTriage.ts:16` (`INTENTS`) and `:79-86` (criteria)
- Modify: `supabase/functions/ai-agent-reply/intentLabels.ts:8-14`
- Modify: `src/features/agent-tests/domain/types.ts:3`
- Modify: `src/features/agent-dashboard/ui/AgentDashboardView.tsx:49-60`, plus its i18n keys
- Test: the existing `supabase/functions/_shared/agentTriage.test.ts` and `supabase/functions/ai-agent-reply/intentLabels.test.ts` (add cases)

**Interfaces:**
- Produces: `Intent` now includes `"booking"`; `INTENT_LABELS.booking = { name: "Booking", color: "#f59e0b" }`.

- [ ] **Step 1: Write the failing tests.** Add to `agentTriage.test.ts`:

```ts
Deno.test("triage accepts a confident booking intent", () => {
  // Use the file's existing helper that turns raw provider answers into an outcome
  // (the function tested around line 110 of agentTriage.ts); feed { intent: { choice: "booking", confidence: 0.9 } }.
});
```

The implementer writes the body with the helper that the file's existing intent tests already use; read those tests first and copy their call shape. Assert that the outcome's `intent` equals `{ choice: "booking", confidence: 0.9 }`.

Add to `intentLabels.test.ts`: a confident `booking` answer yields `{ name: "Booking", color: "#f59e0b" }`.

- [ ] **Step 2: Run to fail.** Run `deno test -A --no-check --node-modules-dir=none _shared/agentTriage.test.ts ai-agent-reply/intentLabels.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
// agentTriage.ts:16
export const INTENTS = ["pricing", "order_status", "complaint", "lead", "booking", "greeting", "other"] as const;
```

```ts
// agentTriage.ts criteria (lead no longer mentions booking, so the two stay distinct)
      lead: "Shows buying interest: wants to order, subscribe or be contacted",
      booking: "Wants to book, reserve or schedule an appointment or service",
```

```ts
// intentLabels.ts
  booking: { name: "Booking", color: "#f59e0b" },
```

```ts
// src/features/agent-tests/domain/types.ts:3
export const TEST_INTENTS = ["pricing", "order_status", "complaint", "lead", "booking", "greeting", "other"] as const;
```

In `AgentDashboardView.tsx`, add `case "booking": return t("dashboard.intent.booking", "Booking");` next to the `lead` case. English comes from the inline `t(key, default)` fallback; Arabic goes into `src/i18n/locales/ar/agent.json` (registered in `src/i18n/index.ts:59-97`). Do not create an English locale file: nothing would load it. Add `dashboard.intent.booking`: "حجز".

- [ ] **Step 4: Run the tests to pass.** Run the Deno command, then `npx vitest run src/features/agent-tests src/features/agent-dashboard`. Expected: PASS.

- [ ] **Step 5: Hand back uncommitted.**

---

### Task 5: The procedure runtime: tools, handlers, end actions, prompt block (Grok lane)

**Files:**
- Create: `supabase/functions/ai-agent-reply/procedureRuntime.ts`
- Modify: `supabase/functions/ai-agent-reply/logic.ts`, adding `procedurePromptBlock`, `procedureTurnGate`, `jevStartKey` and `sanitizeFieldValue`
- Test: `supabase/functions/ai-agent-reply/procedureRuntime.test.ts`; `supabase/functions/ai-agent-reply/procedureLogic.test.ts`

**Interfaces:**
- Consumes: Tasks 2 and 3.
- Produces:

```ts
export const PROCEDURE_TOOL_NAMES: ReadonlySet<string>; // start_procedure, procedure_submit, procedure_cancel
export function procedureToolDefinitions(enabled: ProcedureKey[]): ToolDefinition[]; // [] when enabled is empty
export function fieldsFor(key: ProcedureKey, config: ProcedureConfig): ProcedureField[];
export function stepGuidance(state: ProcedureState, config: ProcedureConfig): string;

export interface ProcedurePorts {
  /** Upserts on meta_lead_id; true only when this call created the row. */
  saveLead(row: { meta_lead_id: string; lead_data: Record<string, string> }): Promise<boolean>;
  /** Number of admins the alert reached (0 = none configured or all sends failed). */
  notifyAdmin(message: string): Promise<number>;
  escalate(reason: string, summary: string): Promise<ToolResult>;
  /** Runs a typed store capability on the account's store connector; null when none is connected. */
  storeLookup(capability: "lookup_orders" | "search_products", parameters: Record<string, string>): Promise<ToolResult | null>;
  hasStoreCapability(capability: "lookup_orders" | "search_products"): boolean;
  logFailure(message: string, metadata: Record<string, string>): Promise<void>;
}
export interface ProcedureTurnInput {
  state: ProcedureState | null;
  config: ProcedureConfig;
  ports: ProcedurePorts;
  dryRun: boolean;
  now: () => Date;
  /** Deterministic per inbound message when an outbox row exists (debate verdict 2). */
  runId: string;
  leadContext: { platform: string; socialAccountId: string | null; conversationId: string };
}
export interface ProcedureTurn {
  handle(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  start(key: ProcedureKey, origin: ProcedureOrigin): boolean;
  /** Ends the flow for a handoff; later procedure tool calls in the turn are refused. */
  endForHandoff(): void;
  readonly state: ProcedureState | null;
  readonly progressed: boolean;
  readonly completed: ProcedureKey | null;
}
export function createProcedureTurn(input: ProcedureTurnInput): ProcedureTurn;
```

Five rules carry the debate verdicts; the code and tests below implement each one.

- **Active state is re-checked.** A state whose own flow is disabled or unparseable is dropped at construction (verdict 9).
- **Store flows run their lookup inside the runtime.** They call it through `storeLookup` with typed parameters (`lookup_orders {order_id}`, `search_products {query}`), and complete only when the lookup returns a result, a legitimate "not found" included. A connector error keeps the flow on its final step (verdicts 3 and 4).
- **Every transition returns the next step's full guidance.** That guidance includes the business wording, the product finder question and the booking services (verdict 10).
- **Customer values are data, never instructions.** They appear only in tool results and in quoted, single-line admin alerts; the system block names collected fields but not their values (verdict 7).
- **A handoff result is returned whole**, with `escalated` and `humanNotified` intact (verdict 6).

- [ ] **Step 1: Write the failing runtime tests with fake ports**

```ts
// supabase/functions/ai-agent-reply/procedureRuntime.test.ts
import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { createProcedureTurn, procedureToolDefinitions, type ProcedurePorts, type ProcedureTurnInput } from "./procedureRuntime.ts";

function fakePorts(overrides: Partial<ProcedurePorts> = {}) {
  const calls = {
    leads: [] as Array<{ meta_lead_id: string; lead_data: Record<string, string> }>,
    notified: [] as string[], escalated: [] as string[], lookups: [] as string[], failures: [] as string[],
  };
  const seen = new Set<string>();
  const ports: ProcedurePorts = {
    saveLead: async (row) => { calls.leads.push(row); const fresh = !seen.has(row.meta_lead_id); seen.add(row.meta_lead_id); return fresh; },
    notifyAdmin: async (message) => { calls.notified.push(message); return 1; },
    escalate: async (reason, summary) => { calls.escalated.push(`${reason}|${summary}`); return { output: "Escalated.", escalated: true, humanNotified: true }; },
    storeLookup: async (capability, parameters) => { calls.lookups.push(`${capability}:${JSON.stringify(parameters)}`); return { output: "Order 1234: shipped" }; },
    hasStoreCapability: () => true,
    logFailure: async (message) => { calls.failures.push(message); },
    ...overrides,
  };
  return { ports, calls };
}

const T = new Date("2026-09-26T10:00:00Z");
const input = (ports: ProcedurePorts, extra: Partial<ProcedureTurnInput> = {}): ProcedureTurnInput => ({
  state: null,
  config: {
    lead_capture: { enabled: true, prompts: { contact: "Your phone or area?" }, closing: "" },
    order_status: { enabled: true, prompts: {}, closing: "" },
    complaint_return: { enabled: true, prompts: {}, closing: "" },
    booking: { enabled: true, prompts: {}, closing: "", services: ["Haircut", "Beard trim"] },
  },
  ports, dryRun: false, now: () => T, runId: "run-1",
  leadContext: { platform: "whatsapp", socialAccountId: "acc-1", conversationId: "conv-1" },
  ...extra,
});
const leadFields = { name: "Sara", contact: "Salmiya", product: "oud" };

Deno.test("no tools are offered when no flow is enabled", () => {
  assertEquals(procedureToolDefinitions([]), []);
});

Deno.test("start and submit in one turn saves the lead once, keyed by run id, and alerts the admin", async () => {
  const { ports, calls } = fakePorts();
  const turn = createProcedureTurn(input(ports));
  await turn.handle("start_procedure", { key: "lead_capture" });
  const result = await turn.handle("procedure_submit", { fields: leadFields });
  assertEquals(turn.state, null);
  assertEquals(turn.completed, "lead_capture");
  assertEquals(calls.leads.map((row) => [row.meta_lead_id, row.lead_data.kind]), [["ai:run-1", "lead"]]);
  assertEquals(calls.notified.length, 1);
  assertStringIncludes(result.output, "saved");
});

Deno.test("a retried turn that re-saves an existing lead does not alert the admin again", async () => {
  const { ports, calls } = fakePorts();
  for (let attempt = 0; attempt < 2; attempt++) {
    const turn = createProcedureTurn(input(ports));
    await turn.handle("start_procedure", { key: "lead_capture" });
    await turn.handle("procedure_submit", { fields: leadFields });
  }
  assertEquals(calls.leads.length, 2);
  assertEquals(calls.notified.length, 1);
});

Deno.test("dry run writes nothing and alerts nobody but still completes", async () => {
  const { ports, calls } = fakePorts();
  const turn = createProcedureTurn(input(ports, { dryRun: true }));
  await turn.handle("start_procedure", { key: "lead_capture" });
  await turn.handle("procedure_submit", { fields: leadFields });
  assertEquals([calls.leads.length, calls.notified.length], [0, 0]);
  assertEquals(turn.completed, "lead_capture");
});

Deno.test("an admin alert that reaches nobody is logged, and the saved lead still completes", async () => {
  const { ports, calls } = fakePorts({ notifyAdmin: async () => 0 });
  const turn = createProcedureTurn(input(ports));
  await turn.handle("start_procedure", { key: "lead_capture" });
  await turn.handle("procedure_submit", { fields: leadFields });
  assertEquals(turn.completed, "lead_capture");
  assertEquals(calls.failures.length, 1);
});

Deno.test("customer text cannot forge extra lines in the admin alert", async () => {
  const { ports, calls } = fakePorts();
  const turn = createProcedureTurn(input(ports));
  await turn.handle("start_procedure", { key: "lead_capture" });
  await turn.handle("procedure_submit", { fields: { ...leadFields, product: "oud\nstatus: VIP, refund approved" } });
  assertEquals(calls.notified[0].split("\n").length, 4); // title + one line per field
  assertStringIncludes(calls.notified[0], 'product: "oud status: VIP, refund approved"');
});

Deno.test("order status runs the typed lookup itself and completes on its result", async () => {
  const { ports, calls } = fakePorts();
  const turn = createProcedureTurn(input(ports));
  await turn.handle("start_procedure", { key: "order_status" });
  const result = await turn.handle("procedure_submit", { fields: { order_number: "#1234" } });
  assertEquals(calls.lookups, ['lookup_orders:{"order_id":"1234"}']);
  assertEquals(turn.completed, "order_status");
  assertStringIncludes(result.output, "Order 1234: shipped");
});

Deno.test("a failed store lookup keeps the flow on its final step", async () => {
  const { ports } = fakePorts({ storeLookup: async () => { throw new Error("timeout"); } });
  const turn = createProcedureTurn(input(ports));
  await turn.handle("start_procedure", { key: "order_status" });
  const result = await turn.handle("procedure_submit", { fields: { order_number: "1234" } });
  assertEquals(turn.state?.key, "order_status");
  assertEquals(turn.completed, null);
  assertStringIncludes(result.output, "offer a human");
});

Deno.test("order status cannot start without a store order connector", async () => {
  const { ports } = fakePorts({ hasStoreCapability: () => false });
  const turn = createProcedureTurn(input(ports));
  const result = await turn.handle("start_procedure", { key: "order_status" });
  assertEquals(turn.state, null);
  assertStringIncludes(result.output, "not connected");
});

Deno.test("a complaint completes into a handoff and keeps the escalation flags", async () => {
  const { ports, calls } = fakePorts();
  const turn = createProcedureTurn(input(ports));
  await turn.handle("start_procedure", { key: "complaint_return" });
  const result = await turn.handle("procedure_submit", { fields: { order_number: "88", problem: "arrived broken" } });
  assertEquals(calls.escalated, ['Complaint or return|Order 88. Problem: "arrived broken".']);
  assertEquals([result.escalated, result.humanNotified], [true, true]);
  assertEquals(turn.state, null);
});

Deno.test("each transition returns the next step's guidance, including configured services", async () => {
  const { ports } = fakePorts();
  const turn = createProcedureTurn(input(ports));
  const started = await turn.handle("start_procedure", { key: "booking" });
  assertStringIncludes(started.output, "Haircut, Beard trim");
  const lead = createProcedureTurn(input(ports));
  await lead.handle("start_procedure", { key: "lead_capture" });
  const next = await lead.handle("procedure_submit", { fields: { name: "Sara" } });
  assertStringIncludes(next.output, "Your phone or area?");
});

Deno.test("a stored flow whose toggle is now off is dropped even when other flows stay on", () => {
  const { ports } = fakePorts();
  const stale = {
    run_id: "run-0", key: "product_finder" as const, version: 1, step: 0, fields: {}, off_script: 0,
    origin: "model" as const, started_at: T.toISOString(), updated_at: T.toISOString(),
  };
  const turn = createProcedureTurn(input(ports, { state: stale }));
  assertEquals(turn.state, null);
});

Deno.test("after a handoff, later procedure calls in the same turn are refused", async () => {
  const { ports, calls } = fakePorts();
  const turn = createProcedureTurn(input(ports));
  await turn.handle("start_procedure", { key: "lead_capture" });
  turn.endForHandoff();
  const result = await turn.handle("procedure_submit", { fields: leadFields });
  assertEquals(calls.leads, []);
  assertEquals(turn.state, null);
  assertStringIncludes(result.output, "handed to a human");
});

Deno.test("an invalid submit names the field and does not count as progress", async () => {
  const { ports } = fakePorts();
  const first = createProcedureTurn(input(ports));
  await first.handle("start_procedure", { key: "order_status" });
  const again = createProcedureTurn(input(ports, { state: first.state }));
  const result = await again.handle("procedure_submit", { fields: { order_number: "abc" } });
  assertEquals(again.progressed, false);
  assertStringIncludes(result.output, "order_number");
});

Deno.test("cancel ends the flow and counts as progress", async () => {
  const { ports } = fakePorts();
  const turn = createProcedureTurn(input(ports));
  await turn.handle("start_procedure", { key: "lead_capture" });
  await turn.handle("procedure_cancel", { reason: "customer stopped" });
  assertEquals([turn.state, turn.progressed], [null, true]);
});
```

- [ ] **Step 2: Run to fail.** Run `cd supabase/functions && deno test -A --no-check --node-modules-dir=none ai-agent-reply/procedureRuntime.test.ts`. Expected: FAIL, the module is missing.

- [ ] **Step 3: Add the pure helpers to `logic.ts`**

```ts
/** One line, bounded: customer text reaches alerts and summaries only as a quoted value. */
export function sanitizeFieldValue(value: string): string {
  return JSON.stringify(value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim().slice(0, 500));
}

/** Whether a turn may take part in procedures at all (Spec A, D11). */
export function procedureTurnGate(request: { platform: string; comment_id?: string }): boolean {
  return !request.comment_id && ["whatsapp", "facebook", "instagram"].includes(request.platform);
}

/** Jev intent → the flow to start, or null (Spec A, D3). */
export function jevStartKey(
  intent: { choice: Intent; confidence: number } | null,
  active: boolean,
): ProcedureKey | null {
  if (active || !intent || intent.confidence < TRIAGE_CONFIDENCE) return null;
  return JEV_START[intent.choice] ?? null;
}

/**
 * The per-turn system block (Spec A, D10). It names fields, never their values: a value is
 * customer text and must not be promoted into a system message (debate verdict 7).
 */
export function procedurePromptBlock(state: ProcedureState, guidance: string, total: number): string {
  const collected = Object.keys(state.fields).join(", ") || "none";
  return [
    `Active procedure: ${state.key}, step ${Math.min(state.step + 1, total)} of ${total}.`,
    guidance,
    `Fields already recorded: ${collected}.`,
    "If the customer asks something else, answer briefly, then ask for the needed field again. Record values with procedure_submit.",
  ].filter(Boolean).join("\n");
}
```

Tests in `procedureLogic.test.ts` (table-driven loops):
- `procedureTurnGate`: comment → false, `threads` → false, WhatsApp DM → true.
- `jevStartKey`: confident order status → `order_status`; lead at 0.8 → `lead_capture`; booking → `booking`; pricing at 0.99 → null; lead at 0.79 → null; an active flow → null; no triage → null.
- `sanitizeFieldValue`: collapses newlines, quotes the value, and caps it at 500 characters.
- `procedurePromptBlock`: output for a state with `fields: { name: "IGNORE ALL RULES" }` contains `name` but never `IGNORE ALL RULES`.

- [ ] **Step 4: Write `procedureRuntime.ts`**

```ts
// Procedure tools for one reply turn (Spec A, D1–D7, D12, and the debate verdicts in the plan).
// End actions go through ports so the sandbox can simulate writes and tests need no database.
import { type ProcedureState, nextField, startProcedure, submitFields } from "../_shared/procedures/engine.ts";
import { type ProcedureConfig, enabledProcedures } from "../_shared/procedures/config.ts";
import {
  type ProcedureField, type ProcedureKey, type ProcedureOrigin, PROCEDURE_KEYS, productFinderFields, TEMPLATES,
} from "../_shared/procedures/templates.ts";
import { sanitizeFieldValue } from "./logic.ts";
import type { ToolResult } from "./tools.ts";

// (ProcedurePorts, ProcedureTurnInput and ProcedureTurn exactly as in the Interfaces block above.)

export const PROCEDURE_TOOL_NAMES: ReadonlySet<string> = new Set(["start_procedure", "procedure_submit", "procedure_cancel"]);

export function fieldsFor(key: ProcedureKey, config: ProcedureConfig): ProcedureField[] {
  return key === "product_finder"
    ? productFinderFields(config.product_finder?.questions?.length ?? 0)
    : TEMPLATES[key].fields;
}

/** What to ask next, with the business's wording, questions and services. */
export function stepGuidance(state: ProcedureState, config: ProcedureConfig): string {
  const fields = fieldsFor(state.key, config);
  const next = nextField(state, fields);
  if (!next) return "";
  const settings = config[state.key];
  const wording = state.key === "product_finder"
    ? settings?.questions?.[fields.indexOf(next)] ?? ""
    : settings?.prompts[next.name] ?? "";
  const services = state.key === "booking" && next.name === "service" && settings?.services?.length
    ? ` Offer only these services: ${settings.services.join(", ")}.`
    : "";
  return `Needed now: ${next.name}.${wording ? ` Ask it this way, in the customer's language: ${wording}` : ""}${services}`;
}

export function procedureToolDefinitions(enabled: ProcedureKey[]) {
  if (!enabled.length) return [];
  return [
    {
      type: "function",
      function: {
        name: "start_procedure",
        description:
          "Start a guided procedure when the customer's request matches one. Only one runs at a time. You may call procedure_submit in the same response if the message already contains a field.",
        parameters: { type: "object", properties: { key: { type: "string", enum: enabled } }, required: ["key"] },
      },
    },
    {
      type: "function",
      function: {
        name: "procedure_submit",
        description: "Record field values the customer actually stated for the active procedure.",
        parameters: {
          type: "object",
          properties: { fields: { type: "object", additionalProperties: { type: "string" } } },
          required: ["fields"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "procedure_cancel",
        description: "End the active procedure when the customer asks to stop or clearly changes topic.",
        parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
      },
    },
  ];
}

export function createProcedureTurn(input: ProcedureTurnInput): ProcedureTurn {
  const enabled = new Set(enabledProcedures(input.config));
  // Verdict 9: the stored flow is judged by its own toggle, not by "some flow is on".
  let state = input.state && enabled.has(input.state.key) && fieldsFor(input.state.key, input.config).length
    ? input.state
    : null;
  let progressed = false;
  let handedOff = false;
  let completed: ProcedureKey | null = null;

  const canStart = (key: ProcedureKey): boolean => {
    const capability = TEMPLATES[key].needsCapability;
    return enabled.has(key) && (!capability || input.ports.hasStoreCapability(capability));
  };

  const start = (key: ProcedureKey, origin: ProcedureOrigin): boolean => {
    if (state || handedOff || !canStart(key)) return false;
    state = startProcedure(null, key, origin, input.now(), input.runId).state;
    progressed = true;
    return true;
  };

  const alertLines = (fields: Record<string, string>) =>
    Object.entries(fields).map(([name, value]) => `${name}: ${sanitizeFieldValue(value)}`);

  const saveAndAlert = async (done: ProcedureState, kind: "lead" | "booking"): Promise<ToolResult> => {
    if (input.dryRun) return { output: `Procedure complete: the ${kind} would be saved (test mode, nothing written). Confirm to the customer.` };
    const created = await input.ports.saveLead({
      meta_lead_id: `ai:${done.run_id}`,
      lead_data: {
        kind, source: "ai_agent", platform: input.leadContext.platform,
        social_account_id: input.leadContext.socialAccountId ?? "",
        conversation_id: input.leadContext.conversationId, ...done.fields,
      },
    });
    // Verdict 2: only the call that created the row alerts, so a retried turn never alerts twice.
    if (created) {
      const reached = await input.ports.notifyAdmin([`New ${kind} from the AI agent`, ...alertLines(done.fields)].join("\n"));
      if (reached === 0) {
        await input.ports.logFailure(`Procedure ${kind} saved but no admin alert was delivered`, { run_id: done.run_id });
      }
    }
    return { output: `Procedure complete: the ${kind} is saved. Confirm to the customer.` };
  };

  const finish = async (done: ProcedureState): Promise<ToolResult> => {
    const closing = input.config[done.key]?.closing;
    const withClosing = (result: ToolResult): ToolResult =>
      closing ? { ...result, output: `${result.output}\nClose with this message, in the customer's language: ${closing}` } : result;
    switch (TEMPLATES[done.key].endAction) {
      case "order_lookup": {
        const found = await input.ports.storeLookup("lookup_orders", { order_id: done.fields.order_number });
        if (!found) throw new Error("store connector missing");
        return withClosing({ output: `Store result:\n${found.output}\nReply with order number, status, date, items and total. If no order matched, say so and offer a human.` });
      }
      case "product_search": {
        const found = await input.ports.storeLookup("search_products", { query: Object.values(done.fields).join(" ") });
        if (!found) throw new Error("store connector missing");
        return withClosing({ output: `Store result:\n${found.output}\nShow the top 3 products.` });
      }
      case "save_lead":
        return withClosing(await saveAndAlert(done, "lead"));
      case "save_booking":
        return withClosing(await saveAndAlert(done, "booking"));
      case "handoff": {
        const summary = `Order ${done.fields.order_number}. Problem: ${sanitizeFieldValue(done.fields.problem)}.`;
        handedOff = true;
        return await input.ports.escalate("Complaint or return", summary); // verdict 6: flags kept
      }
    }
  };

  const submit = async (args: Record<string, unknown>): Promise<ToolResult> => {
    if (!state) return { output: "No procedure is active; start one first." };
    const fields = fieldsFor(state.key, input.config);
    const raw = (typeof args.fields === "object" && args.fields !== null ? args.fields : {}) as Record<string, unknown>;
    const result = submitFields(state, fields, raw, input.now());
    const rejected = result.rejected.map((r) => `${r.field} (${r.reason})`).join(", ");
    if (!result.accepted.length) {
      return { output: `Nothing recorded. Rejected: ${rejected || "no fields"}. ${stepGuidance(state, input.config)}` };
    }
    progressed = true;
    state = result.state;
    if (!result.complete) {
      return { output: `Recorded ${result.accepted.join(", ")}.${rejected ? ` Rejected: ${rejected}.` : ""} ${stepGuidance(state, input.config)}` };
    }
    try {
      const output = await finish(state);
      completed = state.key;
      state = null;
      return output;
    } catch (error) {
      await input.ports.logFailure("Procedure end action failed", {
        procedure: state.key, run_id: state.run_id, error: error instanceof Error ? error.name : "Error",
      });
      return { output: "The last step could not be completed. Apologise and offer a human; the details are kept for a retry." };
    }
  };

  const handle = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    if (handedOff) return { output: "The conversation was handed to a human; the procedure has ended." };
    if (name === "start_procedure") {
      const key = String(args.key ?? "") as ProcedureKey;
      if (!(PROCEDURE_KEYS as readonly string[]).includes(key) || !enabled.has(key)) {
        return { output: `Procedure ${key} is not enabled for this account.` };
      }
      if (state) return { output: `Procedure ${state.key} is already active. ${stepGuidance(state, input.config)}` };
      if (!start(key, "model")) return { output: `Procedure ${key} cannot start: the store connector it needs is not connected.` };
      return { output: `Procedure ${key} started. ${stepGuidance(state!, input.config)}` };
    }
    if (name === "procedure_cancel") {
      if (!state) return { output: "No procedure is active." };
      state = null;
      progressed = true;
      return { output: "Procedure ended. Continue the conversation normally." };
    }
    if (name === "procedure_submit") return await submit(args);
    return { output: `Unknown tool: ${name}` };
  };

  return {
    handle,
    start,
    endForHandoff() {
      handedOff = true;
      state = null;
    },
    get state() { return state; },
    get progressed() { return progressed; },
    get completed() { return completed; },
  };
}
```

- [ ] **Step 5: Run to pass.** Run `deno test -A --no-check --node-modules-dir=none ai-agent-reply/ _shared/procedures/` and `deno check --node-modules-dir=none ai-agent-reply/procedureRuntime.ts`. Expected: PASS, and the type check exits 0.

- [ ] **Step 6: Hand back uncommitted.**

---

### Task 6: Wire procedures into `ai-agent-reply/index.ts` (Grok lane)

**Files:**
- Modify: `supabase/functions/ai-agent-reply/index.ts` at these points:
  - the thread upsert (`:665-686`);
  - the triage plan (`:1110-1117`);
  - the messages and hint (`:1180-1185`);
  - the iteration loop (`:1190` onward);
  - the tool list (`:1212-1216`);
  - the tool dispatch (`:1305-1321`);
  - the send block (`:1392-1415`);
  - the sandbox response.
- Test: `supabase/functions/ai-agent-reply/procedureWiring.test.ts`, which tests the extracted pure helpers `procedureStateAfterTurn` and `iterationBudget`.

**Interfaces:**
- Consumes: Tasks 2, 3 and 5.
- Produces, in `logic.ts`:

```ts
/** What the turn leaves in ai_threads.procedure_state; undefined = do not write. */
export function procedureStateAfterTurn(input: {
  hadTurn: boolean; storedState: unknown; initialState: ProcedureState | null;
  turnState: ProcedureState | null; progressed: boolean; escalated: boolean; now: Date;
}): ProcedureState | null | undefined;
/** Rounds available to the tool loop: one extra text-only round when a procedure tool ran on the last one. */
export function iterationBudget(configured: number, procedureToolRanOnLastRound: boolean, iteration: number): "tools" | "text_only" | "stop";
```

The sandbox response also gains `procedure: { key: string; step: number; completed: boolean } | null`.

**The state write moves to before the send (debate verdict 1).** It is committed when the reply is final, before `deliverGeneratedReply` or the plain send. Redelivery and reconciliation then send text that already matches the stored state, and never need to replay tools.
- **Cost:** a send that later fails leaves the state one step ahead of what the customer saw.
- **Recovery:** the next turn's block names the field still needed and the model asks for it, so the flow recovers. The spec is revised to match.

**Run ids are deterministic (verdict 2).** `runId = outboxId ?? crypto.randomUUID()`. A regenerated turn for the same inbound message reuses its outbox row, so its lead upsert finds the row and sends no second alert.

- [ ] **Step 1: Write the failing tests**

```ts
// supabase/functions/ai-agent-reply/procedureWiring.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { iterationBudget, procedureStateAfterTurn } from "./logic.ts";

const now = new Date("2026-09-26T10:00:00Z");
const active = {
  run_id: "r", key: "booking" as const, version: 1, step: 1, fields: { service: "cut" }, off_script: 0,
  origin: "jev" as const, started_at: now.toISOString(), updated_at: now.toISOString(),
};
const base = { hadTurn: true, storedState: active, initialState: active, turnState: active, progressed: false, escalated: false, now };

for (const [label, overrides, expected] of [
  ["no procedure turn and nothing stored writes nothing", { hadTurn: false, storedState: null, initialState: null, turnState: null }, undefined],
  ["no procedure turn with a stored state clears it", { hadTurn: false, turnState: null }, null],
  ["an escalation clears the flow", { escalated: true }, null],
  ["progress keeps the new state", { progressed: true }, active],
  ["a completed flow clears", { progressed: true, turnState: null }, null],
] as const) {
  Deno.test(`procedureStateAfterTurn: ${label}`, () => {
    assertEquals(procedureStateAfterTurn({ ...base, ...overrides } as never), expected);
  });
}

Deno.test("procedureStateAfterTurn: a turn without progress counts as off-script", () => {
  assertEquals((procedureStateAfterTurn(base) as { off_script: number }).off_script, 1);
});

for (const [configured, ranOnLast, iteration, expected] of [
  [3, false, 2, "tools"],
  [3, false, 3, "stop"],
  [1, true, 1, "text_only"],
  [3, true, 3, "text_only"],
  [3, true, 4, "stop"],
] as const) {
  Deno.test(`iterationBudget(${configured}, ${ranOnLast}, ${iteration}) is ${expected}`, () => {
    assertEquals(iterationBudget(configured, ranOnLast, iteration), expected);
  });
}
```

- [ ] **Step 2: Implement both helpers in `logic.ts`**

```ts
export function procedureStateAfterTurn(input: {
  hadTurn: boolean; storedState: unknown; initialState: ProcedureState | null;
  turnState: ProcedureState | null; progressed: boolean; escalated: boolean; now: Date;
}): ProcedureState | null | undefined {
  if (!input.hadTurn) return input.storedState ? null : undefined;
  if (input.escalated) return null;
  if (input.initialState && input.turnState && !input.progressed) return recordOffScript(input.turnState, input.now);
  return input.turnState;
}

export function iterationBudget(
  configured: number,
  procedureToolRanOnLastRound: boolean,
  iteration: number,
): "tools" | "text_only" | "stop" {
  const limit = Math.max(1, configured);
  if (iteration < limit) return "tools";
  // Verdict 4: a procedure tool on the last permitted round earns one text-only round,
  // so an end action is never followed by silence.
  return iteration === limit && procedureToolRanOnLastRound ? "text_only" : "stop";
}
```

`procedureStateAfterTurn` returns `null` when there is no procedure turn but a state is stored: every flow was switched off, or the turn is not a DM. When a turn has a procedure turn object, the active state's own toggle was already checked by `createProcedureTurn` (verdict 9).

- [ ] **Step 3: Wire `index.ts`.** Make the following edits, keeping the surrounding code intact.
  1. **Load.** After `const { data: thread … } = threadResult;`:

     ```ts
     const procedureConfig = readProcedureConfig(config.agent_behavior?.procedures);
     const proceduresOn = procedureTurnGate(request) && enabledProcedures(procedureConfig).length > 0;
     const initialProcedureState = proceduresOn ? expireIfStale(thread.procedure_state ?? null, new Date()) : null;
     ```
  2. **Turn object.** Build it once `toolContext` and `customTools` exist:

     ```ts
     const storeTool = (capability: string) =>
       customTools.find((tool) => connectorCapabilities(tool.connector_type)?.some((c) => c.name === capability)) ?? null;
     const procedureTurn = proceduresOn ? createProcedureTurn({
       state: initialProcedureState, config: procedureConfig, dryRun, now: () => new Date(),
       runId: outboxId ?? crypto.randomUUID(),
       leadContext: { platform: request.platform, socialAccountId: toolContext.socialAccountId, conversationId: request.conversation_id },
       ports: {
         saveLead: async (row) => {
           const { data, error } = await admin.from("leads").upsert(
             { user_id: request.user_id, form_id: null, status: "new", ...row },
             { onConflict: "meta_lead_id", ignoreDuplicates: true },
           ).select("id");
           if (error) throw new Error(error.message);
           return (data ?? []).length > 0;
         },
         notifyAdmin: (message) => notifyAdmins(toolContext, message),
         escalate: (reason, summary) => executeTool(toolContext, "escalate_to_human", { reason, summary }),
         hasStoreCapability: (capability) => storeTool(capability) !== null,
         storeLookup: async (capability, parameters) => {
           const tool = storeTool(capability);
           return tool
             ? await executeRoutedCustomTool(toolContext, tool, { capability, parameters }, {}, modelBudgetRemaining(startedAt, Date.now()))
             : null;
         },
         logFailure: async (message, metadata) => {
           const { error } = await admin.from("system_logs").insert({
             source: "ai-agent-reply", category: "ai", level: "warn", message, user_id: request.user_id,
             metadata: { platform: request.platform, ...metadata },
           });
           if (error) console.error("[ai-agent-reply] Procedure failure log rejected:", error.message);
         },
       },
     }) : null;
     ```

     - **Export `notifyAdmins`:** it is module-private in `tools.ts:180`, so add `export`. It already returns the number of admins reached.
     - **Store lookups:** `executeRoutedCustomTool` keeps the adapter's read-only boundary and the sandbox's real-read rule.
  3. **Jev start and the handoff rule (verdict 5).** Right after `const triagePlan = …`:

     ```ts
     if (procedureTurn && triagePlan?.handoff) procedureTurn.endForHandoff();
     const jevKey = procedureTurn ? jevStartKey(/* the intent accessor index.ts:1443 already uses */, procedureTurn.state !== null) : null;
     if (jevKey) procedureTurn!.start(jevKey, "jev");
     const procedureActive = procedureTurn?.state != null;
     ```

     Jev's handoff decision ends the flow deterministically, whether or not the model then calls the escalation tool.
  4. **The smalltalk rule (D6).**
     - Change `:1117` to `const offeredTools = (triagePlan?.smalltalk && !procedureActive) || triagePlan?.handoff ? [] : selectConnectorTools(customTools, triagePlan);`. Store lookups no longer depend on offered tools, because the runtime calls the store itself.
     - Change `:1212` to `const toolDefinitions = triagePlan?.smalltalk && !procedureActive ? [] : [ …existing…, ...procedureToolDefinitions(procedureTurn && !triagePlan?.handoff ? enabledProcedures(procedureConfig) : []) ];`.
  5. **Prompt block.** After the hint splice:

     ```ts
     if (procedureTurn?.state) {
       const fields = fieldsFor(procedureTurn.state.key, procedureConfig);
       messages.splice(1, 0, { role: "system", content:
         procedurePromptBlock(procedureTurn.state, stepGuidance(procedureTurn.state, procedureConfig), fields.length) });
     }
     ```
  6. **Dispatch.** In the tool-call executor, route procedure tools first:

     ```ts
     const isProcedureTool = procedureTurn !== null && PROCEDURE_TOOL_NAMES.has(toolCall.function.name);
     if (isProcedureTool) procedureToolRanThisRound = true;
     const result: ToolResult = isProcedureTool
       ? await timings.span(`tool:${toolCall.function.name}`, () => procedureTurn!.handle(toolCall.function.name, args))
       : /* existing expression unchanged */;
     if (result.escalated) procedureTurn?.endForHandoff();
     ```

     Declare `let procedureToolRanThisRound = false;` before the loop. Reset it at the start of each iteration after reading it into `procedureToolRanOnLastRound`.
  7. **Iteration budget (verdict 4).**
     - Replace the loop bound `for (let iteration = 0; iteration < maxIterations; iteration++)` with `for (let iteration = 0; ; iteration++)`.
     - At the top of the body, compute `const budget = iterationBudget(maxIterations, procedureToolRanOnLastRound, iteration);`, then `break` on `"stop"`.
     - On `"text_only"`, send the request without `tools` (the same shape the smalltalk path already uses).
     - The existing wall-clock guard (`modelBudgetRemaining`) is unchanged and still wins.
  8. **Write the state before the send (verdict 1).** Immediately before `let outboundMessageId: string | null = null;` at `:1392`:

     ```ts
     const procedureStateToWrite = procedureStateAfterTurn({
       hadTurn: procedureTurn !== null, storedState: thread.procedure_state ?? null,
       initialState: initialProcedureState, turnState: procedureTurn?.state ?? null,
       progressed: procedureTurn?.progressed ?? false, escalated, now: new Date(),
     });
     if (procedureStateToWrite !== undefined) {
       const { error } = await admin.from("ai_threads").update({ procedure_state: procedureStateToWrite }).eq("id", thread.id);
       if (error) console.error("[ai-agent-reply] Procedure state write failed:", error.message);
     }
     ```

     `persistDelivery` and the redelivery path are **not** changed.
  9. **Sandbox response.** Where the sandbox JSON is built (search for `replyIntentFields(`), add:

     ```ts
     procedure: procedureTurn?.completed
       ? { key: procedureTurn.completed, step: -1, completed: true }
       : procedureTurn?.state ? { key: procedureTurn.state.key, step: procedureTurn.state.step, completed: false } : null,
     ```

- [ ] **Step 4: Run all the edge gates.** Run `deno test -A --no-check --node-modules-dir=none _shared/ ai-agent-reply/ ai-agent-adapters/` and `deno check --node-modules-dir=none ai-agent-reply/index.ts`. Expected: all pass, and the type check exits 0.

- [ ] **Step 5: Hand back uncommitted.**

---

### Task 7: Procedures card, browser mirror and parity test (Grok lane)

**Files:**
- Create: `src/lib/procedureTemplates.ts`
- Test: `src/lib/__tests__/procedureTemplates.test.ts`
- Modify: `src/lib/agentProfile.ts` (`AgentBehavior`)
- Create: `src/components/messaging/agent-settings/ProceduresCard.tsx`
- Test: `src/components/messaging/agent-settings/__tests__/ProceduresCard.test.tsx`
- Modify: `src/components/messaging/AiAgentManager.tsx` (mount next to `InstructionBlocksCard`), plus `src/i18n/locales/ar/agent.json`

**Interfaces:**
- Produces: `PROCEDURE_KEYS`, `PROCEDURE_FIELDS: Record<ProcedureKey, string[]>` (product finder: `[]`) and `PROCEDURE_LIMITS = { text: 300, questionsMin: 2, questionsMax: 3, services: 20, service: 60 }` in `src/lib/procedureTemplates.ts`.

- [ ] **Step 1: Write the mirror and a failing parity test**

```ts
// src/lib/procedureTemplates.ts
// Deliberate browser mirror of supabase/functions/_shared/procedures/templates.ts.
// Deno and the browser cannot share that runtime module; the contract test keeps both copies aligned.
export const PROCEDURE_KEYS = ["order_status", "lead_capture", "complaint_return", "booking", "product_finder"] as const;
export type ProcedureKey = typeof PROCEDURE_KEYS[number];
export const PROCEDURE_FIELDS: Record<ProcedureKey, string[]> = {
  order_status: ["order_number"],
  lead_capture: ["name", "contact", "product"],
  complaint_return: ["order_number", "problem"],
  booking: ["service", "when"],
  product_finder: [],
};
export const PROCEDURE_LIMITS = { text: 300, questionsMin: 2, questionsMax: 3, services: 20, service: 60 } as const;
export interface ProcedureSettings {
  enabled: boolean;
  prompts: Record<string, string>;
  closing: string;
  questions?: string[];
  services?: string[];
}
```

```ts
// src/lib/__tests__/procedureTemplates.test.ts
import { describe, expect, it } from "vitest";
import { PROCEDURE_FIELDS, PROCEDURE_KEYS } from "../procedureTemplates";
import { PROCEDURE_KEYS as EDGE_KEYS, TEMPLATES } from "../../../supabase/functions/_shared/procedures/templates.ts";

describe("procedure template mirror", () => {
  it("lists the same procedures as the edge module", () => {
    expect([...PROCEDURE_KEYS]).toEqual([...EDGE_KEYS]);
  });
  it.each([...PROCEDURE_KEYS])("%s has the same fields as the edge template", (key) => {
    expect(PROCEDURE_FIELDS[key]).toEqual(TEMPLATES[key].fields.map((field) => field.name));
  });
});
```

`templates.ts` imports `type { Intent }` only, which erases at compile time, so vitest can load it like `connectorRegistry.ts`. If vitest trips on the `.ts` import, mirror what `src/lib/__tests__/connectorRegistry.test.ts:14-22` does.

- [ ] **Step 2: Add the type.** Add `procedures?: Partial<Record<ProcedureKey, ProcedureSettings>>;` to `AgentBehavior` in `src/lib/agentProfile.ts`.

- [ ] **Step 3: Write the failing card test**

```tsx
// src/components/messaging/agent-settings/__tests__/ProceduresCard.test.tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ProceduresCard } from "../ProceduresCard";

const setup = (procedures = {}) => {
  const updateBehavior = vi.fn();
  render(<ProceduresCard form={{} as never} update={vi.fn()} behavior={{ procedures }} updateBehavior={updateBehavior} />);
  return updateBehavior;
};

describe("ProceduresCard", () => {
  it("turning a flow on merges only that flow into procedures", () => {
    const updateBehavior = setup({ booking: { enabled: true, prompts: {}, closing: "" } });
    fireEvent.click(screen.getByRole("switch", { name: /lead capture/i }));
    expect(updateBehavior).toHaveBeenCalledWith("procedures", {
      booking: { enabled: true, prompts: {}, closing: "" },
      lead_capture: { enabled: true, prompts: {}, closing: "" },
    });
  });

  it("enabling the product finder seeds two empty questions so the saved config is valid", () => {
    const updateBehavior = setup();
    fireEvent.click(screen.getByRole("switch", { name: /product finder/i }));
    expect(updateBehavior).toHaveBeenCalledWith("procedures", {
      product_finder: { enabled: true, prompts: {}, closing: "", questions: ["", ""] },
    });
  });

  it("editing a field prompt writes it under that field's name", () => {
    const updateBehavior = setup({ order_status: { enabled: true, prompts: {}, closing: "" } });
    fireEvent.change(screen.getByLabelText(/order_number/i), { target: { value: "Your order number please" } });
    expect(updateBehavior).toHaveBeenLastCalledWith("procedures", {
      order_status: { enabled: true, prompts: { order_number: "Your order number please" }, closing: "" },
    });
  });
});
```

Radix `Switch` renders `role="switch"`, and `fireEvent.click` toggles it. This is unlike Radix Tabs; see memory `radix-tabs-need-mousedown-in-tests`.

- [ ] **Step 4: Write `ProceduresCard.tsx`.**
  - Follow `InstructionBlocksCard.tsx` for structure, `useTranslation`, and the `BehaviorCardProps` contract. `updateBehavior` merges; the card never holds its own copy of the config.
  - Render one row per key in `PROCEDURE_KEYS`:
    - a `Switch` whose accessible name is the translated flow name (for example "Lead capture");
    - when enabled: one `Input` per field in `PROCEDURE_FIELDS[key]`, with a `Label` naming the field (the label text includes the raw field name, for example "order_number", so the test's `getByLabelText` works);
    - a `Textarea` for `closing`;
    - for `product_finder`, 2–3 question inputs with add and remove buttons, clamped to `PROCEDURE_LIMITS`;
    - for `booking`, a comma-separated services input, split into ≤ 20 trimmed items.
  - Each input has `maxLength={PROCEDURE_LIMITS.text}` (services: `PROCEDURE_LIMITS.service`).
  - Every write goes through one helper: `const write = (key, settings) => updateBehavior("procedures", { ...(behavior.procedures ?? {}), [key]: settings });`.
  - The i18n keys live under `procedures.*`. English comes from the inline `t(key, default)` fallback; Arabic goes into `src/i18n/locales/ar/agent.json` (registered in `src/i18n/index.ts:59-97`). Do not create an English locale file: nothing would load it.
  - **The saved empty questions are acceptable:** the server rejects a product finder with empty text only if the text exceeds 300 characters (Task 3). Empty questions are then valid but useless, so the card shows a hint, "Fill in 2–3 questions", while any question is empty.

- [ ] **Step 5: Mount the card.** In `AiAgentManager.tsx`, render `<ProceduresCard … />` with the same props as `InstructionBlocksCard`, directly after it.

- [ ] **Step 6: Run the frontend gates.** Run `npx vitest run src/lib src/components/messaging src/features/agent-tests src/features/agent-dashboard`, `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json`, and `npx eslint src/components/messaging/agent-settings src/lib/procedureTemplates.ts`. Expected: all pass.

- [ ] **Step 7: Hand back uncommitted.**

---

## Release order (orchestrator)

1. Run all gates on the assembled branch, in this order:
   - Deno tests;
   - `deno check` on `ai-agent-reply/index.ts`;
   - `bun install --frozen-lockfile`;
   - vitest;
   - tsc;
   - eslint.
2. Run `clean-code-guard` on the production code and `test-guard` on the tests.
3. Open the PR, run one Codex bot round, and confirm CI is green on the head.
4. Apply `20260926120000_agent_procedures.sql` to production as `supabase_admin` from `refs/heads/<branch>`, then `NOTIFY pgrst, 'reload schema'`, **before** merging. It is additive: nullable column and a function replacement.
5. Merge. The edge functions deploy through the Dokploy schedule; check that the schedule log's Target commit matches the merge.
6. Live check in the sandbox on an admin-owned account with `lead_capture` enabled:
   - "I want to order oud, I'm Sara from Salmiya" completes the flow, with `procedure.completed` true;
   - no `leads` row is written, because the sandbox is dry run.
   - Then delete the sandbox thread.
