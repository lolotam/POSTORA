# Agent Phase 2b: reply latency implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- Cut the AI agent's reply time: about 1 s off every reply, and store-question replies from 8–13 s down to about 4–5 s.
- Do it by running independent setup reads in parallel, stopping unnecessary extra store rounds, and keeping product answers short.
- Measure before and after with honest per-phase timings.

**Evidence (2026-09-26):**
- **The answer-writing round is not the bottleneck.** In a spike on the server, `gemini-2.5-flash` answered a 5-product store result in 1.3–1.8 s with a small prompt, and 1.5–2.2 s with a production-size (~6k-token) prompt. Thinking on or off made no difference.
- **The earlier 4.8 s came from a sandbox run.** In the sandbox, connectors return a placeholder, so it is not representative.
- **Setup is a big share of a real reply.** The first real WhatsApp message after PR #204 took `latency_ms` 4182, of which `timings.triage` was 1618. The "triage" mark covers everything from request start, and Jev itself takes 0.3–0.5 s, so about 1.2 s is the sequential setup reads before the model starts.
- **Extra store rounds make the slow replies.** The slow replies (12.8 s, 13.5 s on 2026-09-25) made one and two store calls respectively, each followed by another model round.

**Architecture:** all changes are in `supabase/functions/ai-agent-reply/`: `index.ts` for orchestration, and `logic.ts` for pure helpers plus their tests. There is no schema change, no new dependency and no frontend change.

**Spec:** `docs/superpowers/specs/2026-09-25-ai-agent-roadmap.md`, Phase 2, extended by this evidence.

## Global Constraints

- Required reading: `ARCHITECTURE.md` (Edge Function shape, the security rules).
- **Behaviour must not change except where a task says so.**
  - Same gates, same skip reasons, and the same log rows and statuses.
  - The same outbox semantics: `takeOutboxRow` still runs before any external-provider call, and the redelivery branch is unchanged.
  - The same reply text path.
- **Parallelism is only for independent reads.**
  - A read whose input comes from another read's result (for example, the cooldown check needs `thread.id`) waits for that result.
  - Writes keep their current order. The `ai_threads` upsert is a write, and it may run in parallel only with reads that do not depend on it.
- **Failure semantics:** for every group that becomes parallel, a read that threw before still throws, and the reply fails the same way it did. Use `Promise.all`, not `Promise.allSettled`, where a failure used to abort. Keep every existing try/catch.
- **The extra-round cap** (Task 3) applies only when all of these hold:
  - triage produced a confident intent (`TRIAGE_CONFIDENCE`) of `pricing` or `order_status`;
  - the previous round executed only read-only connector calls (reuse `parallelizable`'s eligibility: non-Composio, `shouldUseAdapter`, read-only). This includes a single call;
  - two store rounds have already run, and every call in the last round succeeded with `resultCount > 0` (see Task 3, revised by debate B2/B4).

  Then the next model call sends `tool_choice: "none"`, keeping `tools` in the payload so the prior tool messages stay valid. Every provider in the chain supports `"none"` (the Anthropic adapter maps it to `{ type: "none" }`).
- **The short-answer rule** (Task 4) is a system hint only for a confident `pricing` intent: "List at most 3 products, one line each: name, price, link. If more match, say how many more there are and offer to send them." No `max_tokens` cap, because GPT-5 and o-series reject it.
- **Tests:** Deno `cd supabase/functions && deno test -A --no-check --node-modules-dir=none _shared/ ai-agent-reply/ ai-agent-adapters/ process-pending-replies/` plus `deno check --node-modules-dir=none ai-agent-reply/index.ts`. Add no new `any`, and log only error classes.

---

### Task 1: Honest timings

**Files:** `supabase/functions/ai-agent-reply/index.ts`, `logic.ts`, and `phaseTimings.test.ts`.

- [ ] **Step 0.** Add `timings.mark("sent")` immediately after the customer send completes (after `deliverGeneratedReply` or the direct `sender(...)` call; also in dry run, at the same point). Acceptance compares `sent` (customer-perceived), not `latency_ms`, which also counts the bookkeeping after the send.
- [ ] **Step 1.** In `index.ts`, add `timings.mark("setup")` immediately before the triage block starts, where the `system_settings` triage-keys read is awaited or the triage run begins. The existing `mark("triage")` then measures only triage, and `mark("setup")` measures request start through setup.
- [ ] **Step 2.** Record per-round token counts. In the model loop, after a successful `chatCompletion`, push `completion.usage?.prompt_tokens ?? 0` and `completion.usage?.completion_tokens ?? 0` into two arrays, and add them to `timings.toJSON()` output as `prompt_tokens_per_round` and `completion_tokens_per_round`. Extend `PhaseTimingsRecorder` with `note(name: string, value: number): void`, which appends to a numeric array with the same accumulation rule as spans.
- [ ] **Step 3: Test.** `note` accumulates; `toJSON` contains the marks, spans and notes, and a mark named `setup` precedes `triage`.
- [ ] **Step 4: Commit** `feat(agent): split setup from triage in reply timings; per-round tokens`.

---

### Task 2: Run the independent setup reads in parallel

**Files:** `supabase/functions/ai-agent-reply/index.ts`, from `resolveAgentAccountId` (~line 598) through the tool-link reads (~line 960 at 9178f14f).

Read the whole region first and draw the dependency graph in your report before editing. The expected groups follow; adjust them only where the real code shows a dependency the plan missed, and say so.

- **Group A** (after `config` is known, because it needs `config`): `resolveConversationOverride(...)` and the `ai_threads` upsert, run with `Promise.all`. **`buildReplySender` stays exactly where it is today, after the gates.** A gate-closed turn must still skip cleanly without building a sender (debate B1).
- **Group B** (the gates; only when `!dryRun`): `isWithinServiceWindow` (WhatsApp only), `isHumanAssignedAndOnline`, `isCooldownActive` (needs `thread.id` from Group A) and `isDailyCapReached`, run with `Promise.all` and then passed to `shouldAiReply` exactly as today.
  - This is safe because today all four are already evaluated before `shouldAiReply` runs; they are awaited inline as arguments. So running them together changes timing, not results.
- **The outbox** (`takeOutboxRow`) stays exactly where it is, after the sender and gates and before anything else.
- **Group C** (after the outbox): the history read, `resolveDualEmbeddingConfigFromDb`, the `messaging_cache` conversation read, the `ai_agent_tools` rows read and (when `scopedAccountId`) the `ai_agent_tool_accounts` links read, run with `Promise.all`. Keep each result's existing error handling:
  - `cachedConversationError` still throws;
  - `linkError` still sets `toolLinksDegraded` and logs.
- **Unchanged:** the knowledge-retrieval promise start, `attachComposioTools` and everything after.

- [ ] **Step 1: Extract the gate evaluation into a pure-testable helper** in `logic.ts`: `export async function evaluateGates(checks: { withinServiceWindow: () => Promise<boolean>; humanAssignedAndOnline: () => Promise<boolean>; cooldownActive: () => Promise<boolean>; dailyCapReached: () => Promise<boolean> }): Promise<{ withinServiceWindow: boolean; humanAssignedAndOnline: boolean; cooldownActive: boolean; dailyCapReached: boolean }>`. It runs all four concurrently.
   - Test: all four start before any resolves (use deferred promises and assert the start order); a rejection propagates.
- [ ] **Step 2: Apply Groups A, B and C** in `index.ts`, with `evaluateGates` for Group B.
- [ ] **Step 3: Run the whole ai-agent-reply suite.** If an existing test depends on call order across these reads, fix the test's fake so it is order-independent, and say why in the report. Never weaken an assertion about what is written or returned.
- [ ] **Step 4: Commit** `perf(agent): run independent setup reads in parallel`.

---

### Task 3: Stop extra store rounds once a store result answered

**Files:** `logic.ts` (helper plus test) and `index.ts` (the model loop).

- [ ] **Step 0: Structured result count.** In `connectorExecution.ts`, have `executeRoutedCustomTool` set an optional `resultCount?: number` on `ToolResult` when the adapter envelope's `data` is an array (`data.length`). Leave it undefined otherwise. Add `resultCount?: number` to `ToolResult` in `tools.ts`. Read the real serialisation path in `connectorExecution.ts`. Do not sniff output strings.
- [ ] **Step 1: Helper with its test.** `export function nextToolChoice(input: { intent: { choice: string; confidence: number } | null; toolRoundsSoFar: number; lastRound: Array<{ tool: { connector_type?: string | null; read_only_mode?: boolean | null; auth_strategy?: string | null } | undefined; resultCount?: number; failed: boolean }> }): "auto" | "none"`. It returns `"none"` only when:
   - **`toolRoundsSoFar >= 2`**: two store rounds have already run. The first two rounds are always free, so a request that needs two searches still gets them (debate B4);
   - the intent is `pricing` or `order_status` with `confidence >= TRIAGE_CONFIDENCE`;
   - `lastRound.length >= 1`;
   - every entry's tool is defined and read-only-eligible, using the same predicate as `parallelizable`. Extract that predicate as `readOnlyConnector(tool)` and reuse it in both functions;
   - every entry has `failed === false` and `resultCount > 0`.

   Tests: two prior store rounds with results for pricing give `"none"`. Each failing condition gives `"auto"`: only one prior round, low confidence, the `complaint` intent, a Composio tool, `resultCount` 0 or undefined, a failed call, no tools in the last round.
   - Known limit, to be documented in the code comment: a capped round cannot call `escalate_to_human` or `search_knowledge`. It happens only after two store rounds have already produced results.
- [ ] **Step 2: Wire it in.** Keep the last round's `{tool, output}` list (`customToolByName.get(name)` plus `result.output`) from the tool loop. On the next iteration's `chatCompletion`, when `toolDefinitions.length` is non-zero, send `tool_choice: nextToolChoice({ intent: triage?.outcome?.answers.intent ?? null, lastRound })`. The first round is always `"auto"`.
- [ ] **Step 3: Log.** Add `tool_choice_capped: true` to the success `logOutcome` meta when a cap was applied.
- [ ] **Step 4: Commit** `perf(agent): answer from a sufficient store result instead of searching again`.

---

### Task 4: Short product answers for pricing

**Files:** `logic.ts` (`triageSystemHint`) and its test.

- [ ] **Step 1.** Extend `triageSystemHint(plan, intent?)` with an optional second argument. When there is no handoff or small-talk hint and the intent is a confident `pricing`, return the Global Constraints short-answer sentence. Update the call site in `index.ts` to pass `triage?.outcome?.answers.intent ?? null`.
- [ ] **Step 2: Tests.**
   - A confident `pricing` intent gets the hint.
   - A low-confidence intent gets none.
   - Handoff and small talk still win: their existing hints are unchanged.
- [ ] **Step 3: Commit** `feat(agent): keep pricing answers to three products`.

---

### Task 5: Make WooCommerce build only the fields we use

**Files:** `supabase/functions/ai-agent-adapters/woocommerce.ts` (`buildUrl`) and `adapters.test.ts`.

**Evidence:** the `connector_call_logs` WooCommerce `search_products` calls take 2.5–3.0 s, and up to 5.7 s. WordPress builds the full product objects (descriptions, images, variations) and we then throw most of it away in `PRODUCT_FIELDS`.

- [ ] **Step 1: Test.** The `search_products` and `check_stock` URLs include `_fields=` followed by exactly the `PRODUCT_FIELDS` names joined by commas. The `lookup_orders` URLs include `_fields=` with the `ORDER_FIELDS` names. The categories lookup includes `_fields=id,name`.
- [ ] **Step 2: Implement** by adding the `_fields` query parameter in `buildUrl` and `resolveCategoryId`. The `projectPayload` projection stays as a second guard.
- [ ] **Step 3: Commit** `perf(connectors): ask WooCommerce to build only the fields we use`.

## Delivery order

- **Slice 1** (Grok): Tasks 1, 2 and 5. Merge, deploy, then measure one real store question.
- **Slice 2** (Grok): Tasks 3 and 4, only after that measurement confirms extra rounds still cost time.

## Release and acceptance (controller)

1. There is no migration. Merge; the Dokploy schedule deploys the edge functions. Confirm by file content and restart time.
2. Live: over at least 10 real xsellpoint WhatsApp store questions, compare these against the 2026-09-25/26 baseline:
   - `timings.setup`, `timings.triage` and `model_round`;
   - `tool_choice_capped`;
   - `latency_ms` (p50 and max).

## Debate round 1: the advisor (substituted for Codex astra 6 medium, which failed with a 401 auth error; GLM 5.3 is quota-dry until 09:38; Cursor Grok hangs on this repo). Verdict: APPROVE WITH CHANGES

| # | Finding | Ruling | Reason |
|---|---|---|---|
| A1 | No real timed store question; don't design blind | **accept** | Queried `connector_call_logs`: WooCommerce searches take 2.5–3.0 s (max 5.7 s), so the store call itself is a lever. Delivery is split: Slice 1, measure, then Slice 2. |
| A2 | Missing lever: WooCommerce `_fields` | **accept** | Added as Task 5. |
| A3 | Measure time-to-send, not `latency_ms` | **accept** | Added a `sent` mark; acceptance compares it. |
| B1 | Group A moves `buildReplySender` ahead of the gates | **accept** | The sender stays after the gates; Group A is override plus thread upsert only. |
| B2 | "Sufficient result" string sniffing is brittle | **accept** | Replaced with `ToolResult.resultCount` from the adapter envelope. |
| B3 | Verify `tool_choice: "none"` live on Gemini | **accept** | Verified 2026-09-26: Gemini's OpenAI-compatible endpoint accepts `tools` plus `tool_choice: "none"` after tool messages (1.55 s vs 2.31 s with `auto`). The Anthropic adapter maps it; the OpenAI tiers support it natively. |
| B4 | The cap blocks escalation and knowledge search, and can truncate two-item requests | **accept** | The cap applies only after 2 store rounds (the first two are free); the limit is documented in the code. |
| B5 | Pricing hint vs persona or format rules | **partial** | The implementer must check `buildSystemPrompt` for a conflicting length or format rule and report it; the hint stays. |
| B6 | Batch Tasks 1–2 before 3–4 | **accept** | See Delivery order. |
