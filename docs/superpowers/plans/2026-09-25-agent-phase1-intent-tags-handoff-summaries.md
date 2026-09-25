# Agent Phase 1: intent tags and handoff summaries implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Jev's per-message triage also classifies intent, and the agent tags WhatsApp conversations with it (Pricing, Order status, Complaint, Lead, Greeting).
- When the agent escalates to a human, it leaves a two-line summary that the human sees.

**Architecture:**
- **Intent:** one extra `intent` choice question in the existing Jev request (`_shared/agentTriage.ts`); there is no second call.
- **Labels:** a new `_shared/agentIntentLabels.ts` maps an intent to a label and applies it to the existing `whatsapp_conversation_labels` and `whatsapp_conversation_label_assignments` tables, after the reply is delivered.
- **Handoff:** `escalate_to_human` gains an optional `summary` argument. `escalateConversation` stores it in the assignment `notes` and in the admin alert. The Human Agent UI shows the notes.

**Tech Stack:** Deno edge functions (`deno test`), React + TanStack Query (Vitest).

**Spec:** `docs/superpowers/specs/2026-09-25-ai-agent-roadmap.md`, Phase 1.

## Global Constraints

- Required reading before editing `supabase/functions/**` or `src/**`: `ARCHITECTURE.md`.
- The intent choice keys are exactly `pricing`, `order_status`, `complaint`, `lead`, `greeting` and `other`.
- The label names and colours are exactly:
  - Pricing `#3b82f6`
  - Order status `#8b5cf6`
  - Complaint `#ef4444`
  - Lead `#22c55e`
  - Greeting `#94a3b8`

  `other` is never labelled.
- Confidence threshold: `TRIAGE_CONFIDENCE` (0.8) from `_shared/agentTriage.ts`. Do not add a second constant.
- A label is applied only when all of these hold:
  - `request.platform === "whatsapp"`;
  - it is not a dry run;
  - triage produced an outcome;
  - the reply was delivered.

  It is written with the service-role client, scoped by `user_id` (ARCHITECTURE §24, structural tenancy).
- The label key is `request.conversation_id`, the same `wa_<account>_<customer>` string the inbox uses (verified 2026-09-25 against `ai_agent_logs`, `whatsapp_conversation_label_assignments` and `messaging_cache`).
- Label names are not unique per user, so look the label up by `(user_id, name)` and create it only if absent. Assignment inserts ignore the duplicate from `UNIQUE(conversation_id, label_id)`.
- A labelling or summary failure never changes or delays what the customer receives; log it and continue.
- The summary is plain text, at most 300 characters after trimming, with markdown (`*`, `_`, `` ` ``, `#`) stripped. It falls back to `reason` when missing or empty.
- Deno: `cd supabase/functions && deno test -A --no-check --node-modules-dir=none <paths>`, plus `deno check <file>`. Frontend: `node_modules/.bin/vitest run <paths>`, and `node_modules/.bin/tsc --noEmit -p tsconfig.app.json` with 0 errors. Run Deno before vitest. If vitest fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`, run `bun install --frozen-lockfile`.
- Add no new `any`; match the neighbouring style; tests use `fireEvent`.

---

### Task 1: Jev also answers `intent`

**Files:**
- Modify: `supabase/functions/_shared/agentTriage.ts` (`TriageAnswers`, `triageRequestBody`, `parseTriageAnswers`)
- Test: `supabase/functions/_shared/agentTriage.test.ts`

**Interfaces:**
- Produces:
  - `export const INTENTS = ["pricing", "order_status", "complaint", "lead", "greeting", "other"] as const;`
  - `export type Intent = typeof INTENTS[number];`
  - `TriageAnswers.intent: { choice: Intent; confidence: number } | null`, which is `null` when the answer is missing or not one of `INTENTS`.

`planFromAnswers` does not change.

- [ ] **Step 1: Failing tests** (append):

```ts
Deno.test("triage asks one intent question with the six fixed choices", () => {
  const body = triageRequestBody({ provider: "vercel", model: "m" }, input);
  const intent = (body.questions as Record<string, { type: string; criteria: Record<string, string> }>).intent;
  assertEquals(intent.type, "choice");
  assertEquals(Object.keys(intent.criteria).sort(), ["complaint", "greeting", "lead", "order_status", "other", "pricing"]);
});

Deno.test("the intent answer is parsed, and an unknown choice is dropped", () => {
  const ok = parseTriageAnswers("openrouter", { answers: { intent: { type: "choice", choice: "pricing", confidence: 0.91 } } });
  assertEquals(ok.intent, { choice: "pricing", confidence: 0.91 });
  const bad = parseTriageAnswers("openrouter", { answers: { intent: { type: "choice", choice: "refund", confidence: 0.99 } } });
  assertEquals(bad.intent, null);
});
```

Also update the existing test that asserts the full question-key list (`["needs_knowledge", "smalltalk"]` for the bare input) to include `"intent"`, and the `parseTriageAnswers` expected objects to carry `intent: null`.

- [ ] **Step 2: Run and see it FAIL.**

- [ ] **Step 3: Implement.** In `triageRequestBody`, always add:

```ts
    intent: {
      type: "choice",
      instructions: "What does the customer want in the new message?",
      criteria: {
        pricing: "Asks about a price, cost, offer or discount",
        order_status: "Asks where an order is, about delivery status or tracking",
        complaint: "Unhappy, reports a problem, or wants a refund or return",
        lead: "Shows buying interest: wants to order, book, subscribe or be contacted",
        greeting: "Only greets, thanks or acknowledges",
        other: "Anything else",
      },
    },
```

In `parseTriageAnswers`, read `answers.intent` like `connector`, and accept it only when `choice` is in `INTENTS` and `confidence` is a number.

- [ ] **Step 4: Run and see it PASS** (`_shared/agentTriage.test.ts`, then `deno check _shared/agentTriage.ts`).

- [ ] **Step 5: Commit** `feat(agent): Jev triage also classifies intent`.

---

### Task 2: The intent-label module

**Files:**
- Create: `supabase/functions/_shared/agentIntentLabels.ts`
- Test: `supabase/functions/_shared/agentIntentLabels.test.ts`

**Interfaces:**
- Consumes: `TRIAGE_CONFIDENCE`, `Intent`, `TriageAnswers` from `./agentTriage.ts`.
- Produces:
  - `export const INTENT_LABELS: Record<Exclude<Intent, "other">, { name: string; color: string }>`
  - `export function intentLabelFor(answers: TriageAnswers | null): { name: string; color: string } | null`
  - `export interface LabelDb { from(table: string): any }`. Use the narrow structural type the tests' fake implements. Mirror `CatalogDb` in `_shared/modelCatalogSyncRun.ts`, with no `any`.
  - `export async function applyIntentLabel(db: LabelDb, userId: string, conversationId: string, label: { name: string; color: string }): Promise<void>`. It throws on a DB error; the caller catches.

- [ ] **Step 1: Failing tests**

```ts
// deno-lint-ignore-file no-import-prefix
import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { applyIntentLabel, INTENT_LABELS, intentLabelFor } from "./agentIntentLabels.ts";

const answers = (choice: string, confidence: number) =>
  ({ needsKnowledge: null, smalltalk: null, handoff: null, connector: null, intent: { choice, confidence } }) as never;

Deno.test("only a confident, labelled intent maps to a label", () => {
  assertEquals(intentLabelFor(answers("pricing", 0.9)), { name: "Pricing", color: "#3b82f6" });
  assertEquals(intentLabelFor(answers("pricing", 0.5)), null);
  assertEquals(intentLabelFor(answers("other", 0.99)), null);
  assertEquals(intentLabelFor(null), null);
  assertEquals(Object.keys(INTENT_LABELS).sort(), ["complaint", "greeting", "lead", "order_status", "pricing"]);
});
```

Build the fake db. It keeps `labels` and `assignments` arrays and supports exactly these chains:
- `from("whatsapp_conversation_labels").select("id").eq("user_id", u).eq("name", n).limit(1)` → `{ data, error }`
- `.insert({...}).select("id").single()`
- `from("whatsapp_conversation_label_assignments").upsert(row, { onConflict: "conversation_id,label_id", ignoreDuplicates: true })` → `{ error }`

Test cases:
- a first call creates the label and one assignment;
- a second call for the same conversation creates nothing new;
- a second conversation reuses the same label id;
- a label with that name owned by ANOTHER user is not reused;
- an `error` on the label select makes `applyIntentLabel` reject (`assertRejects`).

- [ ] **Step 2: Run and see it FAIL.**

- [ ] **Step 3: Implement.**

```ts
// Labels Jev's intent onto a WhatsApp conversation, reusing the inbox's own label tables so
// the tags appear in its existing filter. Service-role writes: every query is scoped by user_id.
import { type Intent, TRIAGE_CONFIDENCE, type TriageAnswers } from "./agentTriage.ts";

export const INTENT_LABELS: Record<Exclude<Intent, "other">, { name: string; color: string }> = {
  pricing: { name: "Pricing", color: "#3b82f6" },
  order_status: { name: "Order status", color: "#8b5cf6" },
  complaint: { name: "Complaint", color: "#ef4444" },
  lead: { name: "Lead", color: "#22c55e" },
  greeting: { name: "Greeting", color: "#94a3b8" },
};

export function intentLabelFor(answers: TriageAnswers | null): { name: string; color: string } | null {
  const intent = answers?.intent;
  if (!intent || intent.confidence < TRIAGE_CONFIDENCE || intent.choice === "other") return null;
  return INTENT_LABELS[intent.choice];
}
```

`applyIntentLabel`:
1. Select `id` from `whatsapp_conversation_labels` where `user_id = userId` and `name = label.name`, limit 1. If `error`, throw `new Error("intent label read failed")`.
2. If there is no row, insert `{ user_id, name, color }`, select `id`, `.single()`. On error, throw.
3. Upsert the assignment `{ user_id, conversation_id, label_id }` with `onConflict: "conversation_id,label_id", ignoreDuplicates: true`. On error, throw.

The error messages must not include row data.

- [ ] **Step 4: Run and see it PASS**, and `deno check _shared/agentIntentLabels.ts`.

- [ ] **Step 5: Commit** `feat(agent): label WhatsApp conversations with Jev's intent`.

---

### Task 3: Wire intent labels into `ai-agent-reply`

**Files:**
- Modify: `supabase/functions/ai-agent-reply/index.ts`
- Test: extend the nearest existing ai-agent-reply test only if a pure helper is added. The labelling decision is already covered by Task 2, so this task needs no new logic test.

**Interfaces:**
- Consumes: `intentLabelFor`, `applyIntentLabel`, `LabelDb` (Task 2); the hoisted `triage: TriageRun | null`, which already exists in index.ts.

- [ ] **Step 1: Implement.**
   - **Where:** immediately after the successful-delivery `logOutcome(...)` call (the one with `status: dryRun ? "test" : "sent"`), before `return jsonResponse(...)`, add a block.
   - **Condition:** it runs only when `!dryRun && request.platform === "whatsapp"`.
   - **What it does:**
     - compute `const intentLabel = intentLabelFor(triage?.outcome?.answers ?? null);`
     - when it is non-null, `await applyIntentLabel(admin as unknown as LabelDb, request.user_id, request.conversation_id, intentLabel)`;
     - wrap the await in try/catch. On catch, `console.warn("[ai-agent-reply] intent label failed:", error instanceof Error ? error.name : "error")`.
   - **Log:** add `intent: triage?.outcome?.answers.intent ?? null` to that success `logOutcome` meta, so `/admin/logs` shows it even when no label applies.

- [ ] **Step 2: Verify.** Run `deno test -A --no-check --node-modules-dir=none _shared/ ai-agent-reply/` and `deno check ai-agent-reply/index.ts`. Expected: all pass, clean.

- [ ] **Step 3: Commit** `feat(agent): apply intent labels after a WhatsApp reply is delivered`.

---

### Task 4: `escalate_to_human` carries a handoff summary

**Files:**
- Modify: `supabase/functions/ai-agent-reply/tools.ts`:
  - the `escalate_to_human` definition (~line 80);
  - `escalateConversation` (~245–517);
  - the tool dispatch (~571).
- Test: `supabase/functions/ai-agent-reply/tools.test.ts`

**Interfaces:**
- Produces:
  - `export function handoffSummary(summary: unknown, reason: string): string`, which trims, strips markdown `* _ \` #`, caps at 300 characters, and falls back to `reason`;
  - the tool schema property `summary`.

- [ ] **Step 1: Failing tests** (in `tools.test.ts`):
   - `handoffSummary(" *Wants* the 100ml price; I checked stock.\n", "r")` returns `"Wants the 100ml price; I checked stock."`.
   - A 500-character summary returns 300 characters.
   - `handoffSummary(undefined, "customer asked")` and `handoffSummary("  ", "customer asked")` both return `"customer asked"`.
   - Find the existing test that exercises `escalateConversation` with a fake db and target (search `tools.test.ts` for `escalate`). Extend it, or add a sibling, so that calling the `escalate_to_human` tool with `{ reason: "r", summary: "Wants a refund for order 42. I confirmed the order exists." }` results in:
     - the inserted `whatsapp_conversation_assignments.notes` equal to `"AI handoff: Wants a refund for order 42. I confirmed the order exists."`;
     - the admin WhatsApp text containing `"Summary: Wants a refund for order 42. I confirmed the order exists."`.

- [ ] **Step 2: Run and see it FAIL.**

- [ ] **Step 3: Implement.**
   - **Schema:** in the `escalate_to_human` schema, add

     ```ts
     summary: { type: "string", description: "Two short lines for the human agent: what the customer wants, and what you already checked or told them. Plain text." }
     ```

     Keep `required: ["reason"]`.
   - **Thread the summary through:** pass `handoffSummary(args.summary, reason)` into `escalateConversation`. Add a parameter, or extend its existing input object; follow the current signature style.
   - **Where it is used:**
     - the assignment `notes` becomes `` `AI handoff: ${summary}` `` (was `` `AI escalation: ${reason}` ``);
     - in the admin alert, replace the `Reason: …` line with `Summary: <summary>`;
     - keep every other line of the alert unchanged.
   - **Other callers:** the model-outage floor path must still work. It passes no summary, so `handoffSummary` falls back to its reason.

- [ ] **Step 4: Run and see it PASS** (`ai-agent-reply/tools.test.ts`, then the whole `ai-agent-reply/`), plus `deno check ai-agent-reply/index.ts`.

- [ ] **Step 5: Commit** `feat(agent): escalations carry a two-line handoff summary`.

---

### Task 5: Show the handoff summary to the human agent

**Files:**
- Modify: `src/pages/HumanAgentMode.tsx` (queue items), and the component that shows a conversation's current assignment in the WhatsApp inbox. Find it with `grep -rn "useConversationAssignments\|assigned to" src/components src/features`.
- Test: `src/pages/__tests__/HumanAgentMode.test.tsx`, or the existing test file for the component you change. Create one if none exists.

**Interfaces:**
- Consumes: the assignment rows from `useConversationAssignments`, which already `select` the columns. Confirm that `notes` is selected; if the select is hand-picked, add `notes` (see the memory note on hand-picked selects hiding new columns).

- [ ] **Step 1: Failing test.** Render the queue with one assignment whose `notes` is `"AI handoff: Wants a refund for order 42."`, and assert the text `Wants a refund for order 42.` is visible, labelled "AI summary". Also assert that an assignment with `notes: null` renders no "AI summary" element.

- [ ] **Step 2: Run and see it FAIL.**

- [ ] **Step 3: Implement.** When `notes` starts with `AI handoff: ` or `AI escalation: `:
   - show the text after the prefix;
   - use a small muted block with the label "AI summary", under the conversation name in the queue item and in the inbox assignment badge's tooltip or area;
   - render it as plain text, never as HTML.

- [ ] **Step 4: Run and see it PASS**, and `tsc` is at 0 errors.

- [ ] **Step 5: Commit** `feat(inbox): show the AI handoff summary to the human agent`.

---

## After all tasks (controller)

1. Final whole-branch review, then the guards; merge; Dokploy deploys.
2. Live check on the xsellpoint WhatsApp agent. Triage is already on. Send "كم سعر…", then "وين طلبي", then "ابغى اكلم موظف". Confirm:
   - the Pricing and Order status labels appear in the inbox filter;
   - the handoff notes read `AI handoff: …` and show in the Human Agent queue;
   - the admin alert shows `Summary:`.
3. mem0 plus the final report.
