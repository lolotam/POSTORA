# AI Agent roadmap: seven competitor-inspired features

**Status:** draft for debate · **Date:** 2026-09-25 · **Scope:** the Postora AI agent that replies to WhatsApp, Facebook, Instagram and Threads

Ordered by value for effort. Each phase ships on its own and is independently useful. Phase 1 has a full implementation plan: `docs/superpowers/plans/2026-09-25-agent-phase1-intent-tags-handoff-summaries.md`. Later phases get their own plan when they start.

## What exists today (mapped from origin/main, 2026-09-25)

| Area | Today |
|---|---|
| Triage | Jev runs before the chat model and returns needs_knowledge, connector, handoff and smalltalk (`_shared/agentTriage.ts`). It is live on xsellpoint: 281–512 ms per call, and a greeting turn uses 295 prompt tokens against about 2,900. |
| Labels | WhatsApp only: `whatsapp_conversation_labels` (user_id, name, color; name not unique) and `whatsapp_conversation_label_assignments` (UNIQUE(conversation_id, label_id)). Picker and filter live in `ConversationLabels.tsx`, used by `WhatsAppInboxScreen`. FB/IG have no labels. |
| Handoff | `escalateConversation` (`ai-agent-reply/tools.ts:245-517`) flips `ai_conversation_modes`, assigns an online `whatsapp_agents` row, writes `whatsapp_conversation_assignments.notes = "AI escalation: <reason>"` and history, and WhatsApps the admins "Reason: …". The `escalate_to_human` tool takes only `reason`. No UI shows the assignment `notes`. |
| WooCommerce | tool call → `ai-agent-adapters` → WooCommerce REST. `search_products` with a category name makes an extra categories lookup. No cache. 6 s adapter ceiling. Tool calls run one after another. |
| Testing | `AiAgentTestChat.tsx` sends one message at a time. Nothing is saved or replayed. |
| Analytics | `AiAgentLogsView` is a per-row feed (50 rows, polled). It has no totals, rates or cost. |
| Media | Already live on WhatsApp Cloud API, WhatsApp QR (Evolution) and FB/IG, through `_shared/inboundMediaPipeline.ts`. |
| Procedures | None. Only prompt-level `agent_behavior` and single-shot auto-reply rules. |

## Phase 1: build now (small, reuses Jev and existing tables)

### #2 Automatic intent tags

- **Jev question:** triage gains one choice question, `intent`, with criteria pricing, order_status, complaint, lead, greeting and other. It shares the call Jev already makes, so it adds no cost or latency.
- **When a label is applied:** after the reply is delivered (never before it), the agent applies a label when all of these hold:
  - intent confidence ≥ 0.80;
  - intent ≠ other;
  - platform = whatsapp;
  - the run is not a sandbox test.
- **Which label:** the label is looked up by name for that user and created on first use, with fixed names and colours: Pricing, Order status, Complaint, Lead, Greeting. Assignments are idempotent through the existing UNIQUE constraint. Labels accumulate over a conversation (a chat can be both Pricing and Complaint).
- **Visibility:** labels appear in the existing WhatsApp inbox label filter with no UI work.
- **Failure:** a labelling failure is logged and never affects the reply.
- **Gating:** runs only when triage is on (it needs Jev's answer). No new switch.
- **Out of scope:** FB/IG labels (no tables).

### #1 Handoff summaries

- **The summary comes from the chat model.** `escalate_to_human` gains an optional `summary` parameter: "Two short lines for the human: what the customer wants, and what you already checked or told them." The model writes it while it is already escalating, so there is no extra model call.
- **Where it goes:**
  - it replaces the "Reason" line in the admin WhatsApp alert;
  - it is stored in `whatsapp_conversation_assignments.notes` as `AI handoff: <summary>`;
  - it falls back to `reason` when missing, so behaviour never regresses.
- **UI:** the Human Agent queue (`HumanAgentMode.tsx`) and the conversation's assignment badge show the notes, which is the missing UI today.
- **Limits:** the summary is capped at 300 characters, plain text with markdown stripped.

## Phase 2: next

### #6 Faster WooCommerce replies

**Target:** a store-question reply in under about 6 s at p50, down from 12–13 s. A 3 s target is not credible while each reply needs at least two chat-model rounds plus one store call.

**Measure first.** Per-phase timing goes into the log metadata: triage, retrieval, each model round, and each tool call. Every later change is judged against it.

1. **Cache.** Store the normalised `search_products`, `check_stock` and category-id lookups in a small Postgres cache table (`connector_response_cache`) keyed by (tool_id, capability, params hash), TTL 5 min. Stock and orders get a short or zero TTL.
2. **Run independent tool calls in parallel** when the model asks for several in one round.
3. **Prefetch** — only if the measurement says it still matters. When Jev picks the store connector at ≥ 0.9 and intent is pricing, start one `search_products` from the message's keywords while the first model round runs.
   - Jev cannot write a search query; it returns choices, not text. So the prefetch uses a cheap keyword extraction, and the result is only offered if the model asks for the same search.
4. **Answer from one round** where possible: after a tool result, send the result back with a short "answer now" instruction instead of allowing further tool rounds for pricing questions.

## Phase 3: then

- **#5 Agent dashboard (fast).** Aggregate `ai_agent_logs` and the triage metadata into cards for the last 7 and 30 days:
  - replies;
  - resolved by AI vs handed off;
  - median latency;
  - tokens and estimated cost;
  - triage fast-path share and tokens saved;
  - top intents, which come from #2.

  A SQL view or RPC plus one page. No new pipeline.
- **#3 Saved test sets (medium).** Admins save test messages per account, each with an optional expected intent, connector or phrase. "Run all" replays them through the sandbox path (dry run, no side effects) and shows a pass/fail table and diffs against the previous run. This builds on `AiAgentTestChat` and the dry-run mode.
- **#4 Procedures (large, needs its own spec).** A named, step-based script per intent: for example order status asks for the order number, calls `lookup_orders`, then answers in a fixed format. It is started by the triage intent from #2 and runs as a small state machine stored on the thread. Design questions: authoring UI, state storage, how a free-text reply leaves the script, and failure paths.
- **#7 Media on WhatsApp.** Already live. The remaining work is one live verification per kind (a voice note, an image and a PDF over the QR channel) and closing the item.

## Risks and open questions

- Intent labels can be wrong at 0.80 confidence. Labels are advisory and easy to remove; re-evaluate the threshold with log data after a week.
- Label clutter: five fixed labels per user. Nothing is created unless the intent occurs.
- The handoff summary depends on the model filling `summary`. The fallback is today's `reason`.
- The cache risks stale prices or stock, which a short TTL and never caching orders mitigate.
- Procedures overlap with the agent's free-form tool use, so they need a clear rule for who is in control of a turn.

## Revisions after debate round 1 (Codex astra 6 medium, 2026-09-25)

The full verdict table is in the Phase 1 plan. Changes to this roadmap:

- **Phase 1 order:** handoff summaries first (Tasks 1–3), then intent tags (Tasks 4–6).
- **Where handoff summaries are stored:** `ai_conversation_modes.handoff_summary`, a new column, instead of only the assignment notes.
  - That row exists on every escalation, on every platform, even with no agent online.
  - It is shown through `AiConversationModeSelect` (WhatsApp and FB/IG) and in both Human Agent queues.
- **Label handling:**
  - labels refresh in an open inbox (30 s refetch plus refetch on focus);
  - the oldest same-name label wins;
  - redelivered replies are not labelled;
  - a manually removed label may be re-added by a later confident message.
- **Phase 2:** re-scoped in `docs/superpowers/plans/2026-09-25-agent-phase2-woocommerce-speed.md`:
  - measurement first;
  - a category-id cache (24 h) and a `search_products` cache (120 s), with stock staleness stated to the model;
  - no cache for stock or orders;
  - bounded parallelism for read-only connector calls.

  Dropped: keyword prefetch, and the "Jev routes the search query" idea (Jev returns choices, not text). The latency target is set from the measured baseline.
- **#7 media:** verified live as an immediate acceptance check, not a Phase 3 item.
- **Phase 3 notes:**
  - the dashboard must define "resolved" separately from "sent without escalation", with retry de-duplication and an explicit baseline for token savings;
  - saved test sets need isolated sandbox threads per run, and connector fixtures, because dry-run connectors return placeholders.
