# Agent Phase 1: intent tags and handoff summaries implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- When the agent escalates to a human, it leaves a two-line summary. The human sees it in the conversation header on every platform and in the Human Agent queue, whether or not an agent was online.
- Jev's triage also classifies intent, and the agent tags WhatsApp conversations with it.

**Architecture:**
- **Handoff summary:**
  - `escalate_to_human` gains an optional `summary` argument;
  - `escalateConversation` normalises it at its single boundary, with a fallback to `reason`, and stores it in a new `ai_conversation_modes.handoff_summary` column;
  - the same row the escalation already writes is keyed by user, platform and conversation, so it exists even when no agent is online;
  - it also goes into the assignment `notes` and the admin alert;
  - the UI reads it through `useAiConversationMode`.
- **Intent:**
  - one extra `intent` choice question in the existing Jev request;
  - the agent-specific label policy lives beside ai-agent-reply (ARCHITECTURE §§5/40);
  - labels are applied after a fresh delivery on WhatsApp.

**Tech Stack:** Deno edge functions, Postgres migration, React + TanStack Query (Vitest).

**Spec:** `docs/superpowers/specs/2026-09-25-ai-agent-roadmap.md`, Phase 1.

## Global Constraints

- Required reading before editing `supabase/functions/**` or `src/**`: `ARCHITECTURE.md`.
- **Migrations go to the Migrations lane** (Task 1). Apply them to production **before** merging any code that reads the new columns.
- **Intent:**
  - the choice keys are exactly `pricing`, `order_status`, `complaint`, `lead`, `greeting`, `other`;
  - the confidence must be a finite number in `[0, 1]`, otherwise the intent is `null`;
  - the threshold is `TRIAGE_CONFIDENCE` (0.8) from `_shared/agentTriage.ts`, with no second constant.
- **Labels** (name, colour):
  - Pricing `#3b82f6`
  - Order status `#8b5cf6`
  - Complaint `#ef4444`
  - Lead `#22c55e`
  - Greeting `#94a3b8`

  `other` is never labelled.
- **When a label is applied:** only when all of these hold:
  - `request.platform === "whatsapp"`;
  - not a dry run;
  - triage produced an outcome;
  - the reply was **freshly** delivered on this invocation.

  Redelivered replies are not labelled. Labels are advisory, and losing one on a crash-and-redeliver is accepted.
- **Label lookup:** by `(user_id, name)`, ordered by `created_at` then `id` ascending (the oldest label wins, so duplicate names converge). Create the label only if absent. Assignment inserts ignore the duplicate from `UNIQUE(conversation_id, label_id)`.
- **Label key:** `request.conversation_id`, the same `wa_<account>_<customer>` string the inbox uses (verified 2026-09-25).
- **Summary sanitising:**
  1. strip markdown (`*`, `_`, `` ` ``, `#`) and trim first;
  2. if it is then empty, fall back to `reason`, sanitised the same way;
  3. cap at 300 characters.
- **Failure handling:** a labelling or summary-storage failure never changes or delays what the customer receives. Log only the error class.
- **Tests:** Deno `cd supabase/functions && deno test -A --no-check --node-modules-dir=none <paths>` plus `deno check`. Frontend `node_modules/.bin/vitest run <paths>`, and `tsc --noEmit -p tsconfig.app.json` with 0 errors. Run Deno before vitest. If vitest fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`, run `bun install --frozen-lockfile`.
- **Style:** add no new `any`, match the neighbouring style, use `fireEvent` in tests, and put UI strings through `t()` with an English default, like the neighbouring messaging components.

---

### Task 1 (Migrations lane): the handoff summary column

**Files:** Create `supabase/migrations/20260926090000_ai_conversation_modes_handoff_summary.sql`.

```sql
-- The AI's two-line handoff note for the human, kept on the per-conversation mode row that
-- every escalation already writes, so it exists even when no agent was online to assign.
ALTER TABLE public.ai_conversation_modes
  ADD COLUMN IF NOT EXISTS handoff_summary text,
  ADD COLUMN IF NOT EXISTS handoff_summary_at timestamptz;

ALTER TABLE public.ai_conversation_modes
  DROP CONSTRAINT IF EXISTS ai_conversation_modes_handoff_summary_len;
ALTER TABLE public.ai_conversation_modes
  ADD CONSTRAINT ai_conversation_modes_handoff_summary_len CHECK (char_length(handoff_summary) <= 300);
```

- The change is additive and idempotent. Existing RLS policies already cover the table, so no new grants are needed.
- Verify it on the Contabo rehearsal DB first, per `docs/runbooks`. Then the controller applies it to production as `supabase_admin` and runs `NOTIFY pgrst, 'reload schema'` **before** the merge.
- Commit: `feat(db): ai_conversation_modes.handoff_summary`.

---

### Task 2: One escalation boundary normalises and stores the summary

**Files:**
- Modify: `supabase/functions/ai-agent-reply/tools.ts`:
  - the `escalate_to_human` schema (~line 80);
  - `escalateConversation` (~245–517);
  - the tool dispatch (~571);
  - `outage-floor.ts` (~60), only if its call must change.
- Test: `supabase/functions/ai-agent-reply/tools.test.ts` and `outage-floor.test.ts`.

**Interfaces:**
- Produces:
  - `export function handoffSummary(summary: unknown, reason: string): string`, implementing the sanitising rules above.
  - `escalateConversation` takes the summary through an **options object** added as a new trailing parameter, `options: { summary?: string } = {}`, so the existing positional `deadline` argument keeps its meaning. Inside, it computes `const summary = handoffSummary(options.summary, reason)` exactly once.

- [ ] **Step 1: Failing tests**
   - `handoffSummary`:
     - `" *Wants* the 100ml price; I checked stock.\n"` → `"Wants the 100ml price; I checked stock."`;
     - a 500-character input → 300 characters;
     - `undefined` / `"  "` / `"***"` with reason `"customer asked"` → `"customer asked"`;
     - a 400-character reason as the fallback → 300 characters.
   - **Tool path** (extend the existing `escalate` test and its fake db). Calling `escalate_to_human` with `{ reason: "r", summary: "Wants a refund for order 42. I confirmed the order exists." }`:
     - writes that text to `ai_conversation_modes.handoff_summary`, with `handoff_summary_at` set;
     - writes the assignment `notes` as `"AI handoff: Wants a refund…"` when an agent is online;
     - puts `"Summary: Wants a refund…"` in the admin text.
   - **No agent online:** the same call with no online agents still writes `handoff_summary` to the mode row.
   - **Outage floor:** `outage-floor.ts`'s escalation (no summary) stores the floor's reason as the summary. Its deadline behaviour and the existing repeat-notification suppression are unchanged. Assert the suppression test in the existing suite still passes, and add one that asserts the stored summary.
- [ ] **Step 2: Run and see it FAIL.**
- [ ] **Step 3: Implement.**
   - **Schema:** add `summary: { type: "string", description: "Two short lines for the human agent: what the customer wants, and what you already checked or told them. Plain text." }` to the tool schema. Keep `required: ["reason"]`.
   - **Tool dispatch:** passes `{ summary: args.summary }`.
   - **Mode row:** in `escalateConversation`, write `handoff_summary` and `handoff_summary_at: new Date().toISOString()` into the same `ai_conversation_modes` write the function already performs (the compare-and-set at ~262–335).
     - If that write is a conditional update, include the columns in it.
     - Do not add a separate write that could race with it.
     - If an existing mode row is left unchanged by design (for example, already escalated), update only `handoff_summary` and `handoff_summary_at` with a follow-up update scoped by `user_id`, `platform` and `conversation_id`. Its failure is logged and ignored.
   - **Notes:** assignment notes become `` `AI handoff: ${summary}` ``.
   - **Admin alert:** replace the `Reason:` line with `Summary: ${summary}`.
- [ ] **Step 4: Run and see it PASS.** Run the whole `ai-agent-reply/` suite, plus `deno check ai-agent-reply/index.ts`.
- [ ] **Step 5: Commit** `feat(agent): escalations store a two-line handoff summary`.

---

### Task 3: The human sees the summary

**Files:**
- Modify:
  - the hook behind `useAiConversationMode` (find it with `grep -rn "export function useAiConversationMode" src`). Make sure its select includes `handoff_summary` and `handoff_summary_at`; if the select is hand-picked, add them. Also add both fields to its row type and to `src/integrations/supabase/types.ts` for `ai_conversation_modes`;
  - `src/components/messaging/AiConversationModeSelect.tsx`: when `mode.handoff_summary` is set, render a small muted block under the select, labelled `t("mode.aiSummary", "AI summary")`, showing the text as plain text (never HTML). This one component is used by `WhatsAppConversationPane` (WhatsApp) and `ConversationDetail` (FB/IG), so both get it;
  - `src/pages/HumanAgentMode.tsx`: for every conversation in **both** the waiting queue and the assigned queue, show the same summary. Read it with one query on `ai_conversation_modes`, filtered by the current user and the listed conversation ids, **not** one query per row. Put that query in a small hook, `useHandoffSummaries(conversationIds)`, beside the existing hooks.
- Test:
  - `src/components/messaging/__tests__/AiConversationModeSelect.test.tsx` (extend): the summary renders when present and is absent when null;
  - `src/pages/__tests__/HumanAgentMode.test.tsx` (create or extend): a waiting (unassigned) conversation whose mode row has a summary shows it.
- [ ] **Steps:** failing tests, then implement, then pass. `tsc` stays at 0 errors.
- [ ] **Commit:** `feat(inbox): show the AI handoff summary on every platform and in the agent queue`.

---

### Task 4: Jev also answers `intent`

**Files:** `supabase/functions/_shared/agentTriage.ts` and its test.

**Interfaces:**
- Produces:
  - `export const INTENTS = ["pricing", "order_status", "complaint", "lead", "greeting", "other"] as const;`
  - `export type Intent = typeof INTENTS[number];`
  - `TriageAnswers.intent: { choice: Intent; confidence: number } | null`.

`planFromAnswers` is unchanged.

- [ ] **Step 1: Failing tests.**
   - The request carries `intent`: `type` is `choice`, and its criteria keys are exactly the six intents.
   - Parsing accepts `{ choice: "pricing", confidence: 0.91 }`.
   - Parsing returns `null` for:
     - an unknown choice;
     - a confidence of `NaN`, `1.5` or `-0.1`;
     - a missing answer.
   - Update the existing tests that assert the full question-key list or the parsed shape, so they include `intent`.
- [ ] **Step 2: Run and see it FAIL.**
- [ ] **Step 3: Implement.** Add the question:

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

Parse it with `Number.isFinite(c) && c >= 0 && c <= 1`, and with the choice in `INTENTS`.
- [ ] **Step 4: Run and see it PASS**, plus `deno check`.
- [ ] **Step 5: Commit** `feat(agent): Jev triage also classifies intent`.

---

### Task 5: The intent-label policy and writer

**Files:** Create `supabase/functions/ai-agent-reply/intentLabels.ts`, with tests in `intentLabels.test.ts`.

**Interfaces:**
- Consumes: `TRIAGE_CONFIDENCE`, `Intent`, `TriageAnswers`.
- Produces:
  - `INTENT_LABELS`;
  - `intentLabelFor(answers: TriageAnswers | null): { name: string; color: string } | null`;
  - `shouldLabel(input: { platform: string; dryRun: boolean; freshDelivery: boolean }): boolean`;
  - a narrow structural `LabelDb` type with no `any` (mirror `CatalogDb` in `_shared/modelCatalogSyncRun.ts`);
  - `applyIntentLabel(db: LabelDb, userId: string, conversationId: string, label): Promise<void>`, which throws on a DB error with no row data in the message.
- [ ] **Step 1: Failing tests.**
   - `intentLabelFor`: confident pricing → Pricing; 0.5 → null; `other` → null; null → null.
   - `shouldLabel`: true only for WhatsApp, not dry run, fresh delivery. Cover all three false cases.
   - `applyIntentLabel`, with a fake db that records calls:
     - creates the label on first use;
     - reuses it on a second conversation;
     - picks the **oldest** of two same-name labels: the query orders by `created_at` then `id`, and the test asserts the order call;
     - never reuses another user's label;
     - rejects on a select error.
- [ ] **Step 2: Run and see it FAIL.**
- [ ] **Step 3: Implement.**
   - Select `id` from `whatsapp_conversation_labels`, filtered by `user_id` and `name`, ordered by `created_at` then `id` ascending, `limit(1)`.
   - If there is no row, insert `{ user_id, name, color }`, select `id`, `.single()`.
   - Upsert the assignment `{ user_id, conversation_id, label_id }` with `onConflict: "conversation_id,label_id", ignoreDuplicates: true`.
- [ ] **Step 4: Run and see it PASS**, plus `deno check`.
- [ ] **Step 5: Commit** `feat(agent): intent label policy and writer`.

---

### Task 6: Wire labels into the reply path, and refresh the inbox

**Files:**
- Modify: `supabase/functions/ai-agent-reply/index.ts` and `src/hooks/useWhatsAppLabels.ts`.

- [ ] **Step 1: Implement the backend wiring.**
   - Immediately after the fresh-delivery success `logOutcome(...)` (the `status: dryRun ? "test" : "sent"` one), and only when `shouldLabel({ platform: request.platform, dryRun, freshDelivery: true })` holds:
     - compute `intentLabelFor(triage?.outcome?.answers ?? null)`;
     - when that is non-null, await `applyIntentLabel(...)` inside try/catch, and on catch log `console.warn("[ai-agent-reply] intent label failed:", e instanceof Error ? e.name : "error")`.
   - The redelivery branch does not label (per Global Constraints).
   - Add `intent: triage?.outcome?.answers.intent ?? null` to the success `logOutcome` meta.
- [ ] **Step 2: Implement the frontend refresh.** In `useWhatsAppLabels.ts`, give the labels and assignments queries `refetchInterval: 30_000` and `refetchOnWindowFocus: true`, so server-created labels appear in an open inbox.
   - Extend its test if one exists; otherwise assert the options in a small test.
- [ ] **Step 3: Verify.**
   - Deno: `_shared/` + `ai-agent-reply/` suites, plus `deno check ai-agent-reply/index.ts`.
   - Then vitest on `src/hooks`, plus `tsc`.
- [ ] **Step 4: Commit** `feat(agent): label WhatsApp conversations after delivery; inbox refreshes labels`.

---

## Release and acceptance (controller)

1. Apply the Task 1 migration to production, then reload the PostgREST schema cache. Confirm the columns exist.
2. Merge the PR. `main` auto-deploys the frontend (Dokploy) **and** the edge functions: a Dokploy schedule syncs `origin/main` into the functions volume every 2 minutes and restarts the functions. That was verified on every merge on 2026-09-25. Confirm by file content and the container restart time.
3. Live acceptance on xsellpoint's WhatsApp, with triage on. Send:
   - "كم سعر …" → a Pricing label appears within 30 s in an open inbox;
   - "وين طلبي" → Order status;
   - "ابغى اكلم موظف" → the summary appears in the conversation header and the Human Agent queue, `handoff_summary` is set on the mode row, and the admin alert shows `Summary:`.

   Repeat the handoff with no agent online.
4. mem0 plus the final report.

---

## Debate round 1: Codex astra 6 medium (`gpt-6-astra`, reasoning medium, `--sandbox read-only`), verdict REWORK

| # | Finding | Ruling | Reason |
|---|---|---|---|
| A | Put instrumentation first, summaries before tags, and verify media now | **partial** | Summaries are now Tasks 1–3 and tags Tasks 4–6. Instrumentation opens Phase 2 (its first task) because it measures Phase 2's work. Media verification is added to the roadmap as an immediate acceptance check. |
| B1 | Label creation isn't idempotent (no name uniqueness; race; arbitrary `limit(1)`) | **partial** | Adopted a deterministic oldest-first lookup, so duplicates converge. The first-use race needs two messages for the same user in the same instant with no label yet, which is rare and harmless: one extra label, and later writes converge. A unique index would require resolving existing duplicate user labels in production, which is out of scope. |
| B2 | Tenant scoping is overstated; composite FK | **reject** | `user_id` and `conversation_id` come from the service-role webhook request, and the label is read and written filtered by that same `user_id`. Codex itself calls this an existing schema weakness, not a new exploit. Hardening the label schema is out of this feature's scope. |
| B3 | Redelivery loses the intent | **partial** | Accepted as documented behaviour: labels are advisory. Redelivery occurs only after a crash between generation and send. Persisting intent in the outbox adds schema and code for a cosmetic loss. |
| B4 | The integration-test exemption is unjustified | **partial** | Added the pure `shouldLabel` gate with dry-run, platform and redelivery cases, plus the oldest-first ordering assertion. Real PostgREST conflict behaviour is covered by the live acceptance step rather than a fake. |
| B5 | Notes can't cover the waiting queue | **accept** | Summaries now live on `ai_conversation_modes` (Task 1 migration), which is written on every escalation regardless of agent availability. |
| B6 | UI target unspecified | **accept** | Named the components: `AiConversationModeSelect` (shared by the WhatsApp pane and FB/IG `ConversationDetail`) and `HumanAgentMode` for both queues, via `useHandoffSummaries`. |
| B7 | Escalation coverage contract | **accept** | Normalised once inside `escalateConversation` through a trailing options object that preserves `deadline`. Tool, no-agent and outage-floor tests added, with repeat-notification suppression asserted. |
| B8 | Labels don't refresh in an open inbox | **accept** | Added a 30 s refetch plus refetch on focus in Task 6. Owner-scoped visibility is today's label semantics, unchanged. |
| B9 | Boundary contracts (NaN, empty after stripping, long fallback, manual removal) | **partial** | Adopted: finite confidence in [0,1], sanitise before the emptiness check, sanitise and cap the fallback, and the policy module lives beside ai-agent-reply. Manual removal: a later message with the same confident intent may re-add the label. That is documented; tracking removals is out of scope. |
| B10 | "Merge; Dokploy deploys" is wrong for edge functions | **reject** | Outdated. A Dokploy schedule syncs `origin/main` into the functions volume and restarts the functions every 2 minutes. Verified on PRs #195–#203 on 2026-09-25 by file content and container restart time. The migration-first step was added. |
| C | Phase 2: 6 s is a hypothesis; cache categories first; product-search cache TTL and stock; bounded read-only parallelism; drop prefetch; "one round" is mislabelled | **accept** | Phase 2 plan written to match: measurement first, the category-id cache, a short search cache with stock staleness defined, parallel only for read-only WooCommerce capabilities, prefetch dropped, extra-round cap deferred to the measurement. |
| C | Dashboard: "sent" ≠ "resolved"; saved tests need isolated threads and fixtures | **accept** | Recorded in the roadmap for Phase 3 scoping. |
