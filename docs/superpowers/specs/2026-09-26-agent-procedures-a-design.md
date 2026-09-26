# AI agent Procedures, Spec A: the engine and five customer-started flows

**Status:** approved design, 2026-09-26. **Roadmap item:** Phase 3 #4 (`docs/superpowers/specs/2026-09-25-ai-agent-roadmap.md`).
**Scope decision:** Procedures ships as two specs.

- **Spec A (this document):** the engine and five customer-started flows.
- **Spec B (later):** store-event triggers (a WooCommerce webhook receiver, WhatsApp template sends outside the 24-hour window, scheduling) that start three business-started flows on this same engine:
  - COD order confirmation;
  - back-in-stock alert;
  - post-delivery review.

## Problem

The agent improvises every reply. For tasks that have a known shape, such as order status, the business wants the agent to ask for the same things in the same order and to finish the same way. Today the only levers are:

- prompt text (`agent_behavior`);
- single-shot keyword auto-replies (`_shared/autoReplyRules.ts`).

Neither can hold a multi-turn script.

## Decisions

### D1. Control of a turn is hybrid

Code owns the script:

- which step is current;
- which fields that step needs;
- how each field is validated;
- which action runs at the end.

The chat model still writes every reply and extracts field values from the customer's words.

It reports them through a new tool, `procedure_submit`. Code validates the submitted values and advances the step, or the tool result tells the model what is still missing or invalid.

Two alternatives were rejected:

- **A code-only state machine:** extracting free text (names, dates, a problem description) needs the model, and Jev returns choices, not text.
- **A prompt-only script:** it cannot guarantee the steps or the end action.

### D2. Five templates, defined in code

| Key | Steps (fields) | End action |
|---|---|---|
| `order_status` | 1. `order_number` (digits, 1–12) | Call `lookup_orders` with the number. Found: the model renders the result in the fixed structure (order number, status, date, items, total). Not found: say so and offer a human. |
| `lead_capture` | 1. `name` 2. `contact` (phone or area) 3. `product` (free text) | Save a lead (D7) and notify the admin. |
| `complaint_return` | 1. `order_number` 2. `problem` (free text) 3. `photo` (optional, from an inbound image) | Hand off to a human (`escalateConversation`) with a summary built from the fields. |
| `booking` | 1. `service` 2. `when` (date and time as the customer said it, plus an ISO value when the model can resolve one) | Save a booking (D7), confirm to the customer and notify the admin. |
| `product_finder` | 2–3 business-configured questions (`answer_1`…`answer_3`) | Call `search_products` with a query composed from the answers and show the top 3. |

Each template has a `version` integer. A state saved under an older version is ended (D5), never migrated.

### D3. Starting a flow

Every start is gated by that flow's toggle on the account (D8).

- **Jev start.** When triage runs and reports the intent at ≥ 0.80 confidence (`TRIAGE_CONFIDENCE`), no procedure is active, and the matching flow is enabled:
  - `order_status` starts `order_status`;
  - `lead` starts `lead_capture`;
  - `complaint` starts `complaint_return`;
  - `booking` (a new intent, D9) starts `booking`.
- **Model start.** A new tool, `start_procedure({ key })`, lets the model start any enabled flow.
  - **`product_finder` starts only this way.** `pricing` is mostly "how much is X", and a quiz must not hijack a direct question.
  - Starting while a flow is active is a no-op that returns the active flow's state.
- **Start and submit in one turn.** "Where is order 1234" carries the field already. The model may call `start_procedure` and `procedure_submit` in the same turn. A Jev start happens before the model runs, so the model sees the active step and can submit at once.
- **The seam for Spec B.** The engine entry point is a pure function, `startProcedure(state, key, origin)`, where `origin` is `"jev" | "model" | "event"`. It depends on neither an inbound message nor Jev, so a store webhook can start a flow later without a rewrite.

### D4. State

A new column, `ai_threads.procedure_state jsonb`, nullable. It holds either `null` or:

```json
{
  "run_id": "uuid",
  "key": "order_status",
  "version": 1,
  "step": 0,
  "fields": { "order_number": "1234" },
  "off_script": 0,
  "origin": "jev",
  "started_at": "…",
  "updated_at": "…"
}
```

- **One writer.** The thread row is already upserted on every turn and returned with `.select().single()` (`ai-agent-reply/index.ts:665-686`). The engine reads state from it and returns the new state as a value; `persistDelivery` writes it with the delivered turn.
  - A turn whose reply is not delivered does not advance the flow.
  - A redelivery (`outbox_id`, which stores its text and runs no tool loop) never touches the state.
- **Idempotent end actions.** Each end action is keyed by `run_id`:
  - a lead or booking is written with `meta_lead_id = 'ai:' || run_id` and upserted on that unique column;
  - the handoff reuses `escalateConversation`, which is already idempotent per conversation.

  A retried turn that repeats the end action therefore writes nothing twice.

### D5. Leaving a flow (the user's rule: answer, then resume)

- **Off-script.** A turn with no valid submit and no exit is off-script. The model answers the side question, then re-asks the current step (the prompt block tells it to).
  - `off_script` counts consecutive off-script turns.
  - A valid submit resets it to 0.
  - At 3, the flow ends quietly.
- **Stop.** A new tool, `procedure_cancel({ reason })`, lets the model end the flow when the customer asks to stop or clearly changes topic.
- **Expiry is lazy.** At the start of a turn, a state whose `updated_at` is more than 24 hours old, or whose `version` differs from the template's, is cleared before anything else runs. No cron job.
- **Handoff.** Any escalation, whether from the tool or from Jev's handoff fast path, ends the active flow.
- **Completion.** The end action runs and the state clears.

### D6. Fast paths while a flow is active

`triagePlan.smalltalk` and `triagePlan.handoff` strip tools today (`index.ts:1117`, `:1212`).

- **Handoff:** unchanged. It exits the flow (D5).
- **Smalltalk:** when a flow is active, the smalltalk fast path is not taken. The turn runs the normal path with the procedure tools, so "ok thanks" mid-flow does not lose `procedure_submit` and the step is re-asked.

### D7. Where results go

Leads and bookings go into the existing `leads` table. It has no status CHECK; `form_id` is nullable; the Leads CRM lists all leads when no form is selected. Each row is written as:

- `user_id`: the account owner;
- `form_id`: null;
- `meta_lead_id`: `ai:<run_id>`;
- `status`: `new`;
- `lead_data`: a flat string map, the same shape Meta leads use, so the existing card renders it. It contains `kind` (`lead` or `booking`), `source` (`ai_agent`), `platform`, `social_account_id`, `conversation_id`, and the fields.

The admin is notified through the existing `admin_phone_numbers` WhatsApp alert (`buildAdminNotifier`, `index.ts:414`), with one line per field.

### D8. Authoring: templates the business turns on and edits

`agent_behavior` gains a `procedures` object, validated by `parseAgentBehavior` (`_shared/agentBehavior.ts:150`):

```json
{
  "order_status":     { "enabled": true,  "prompts": { "order_number": "…" }, "closing": "…" },
  "lead_capture":     { "enabled": false, "prompts": {}, "closing": "" },
  "complaint_return": { "enabled": false, "prompts": {}, "closing": "" },
  "booking":          { "enabled": false, "prompts": {}, "closing": "", "services": ["…"] },
  "product_finder":   { "enabled": false, "questions": ["…", "…"], "closing": "" }
}
```

- **Wording is guidance, not a literal.** The editable text is guidance the model renders in the configured `language_mode`, so an English template still answers an Arabic customer in Arabic.
- **Order status structure is fixed in code.** The model fills that structure; the business edits only the lead-in text.
- **Limits:** each text is ≤ 300 characters; `product_finder.questions` holds 2–3 items; `services` holds ≤ 20 items of ≤ 60 characters each.
- **UI:** a new "Procedures" card among the agent settings cards (`src/components/messaging/agent-settings/`). It has one row per flow: a toggle, the editable texts, the product finder questions, and the booking services.
- **Default:** every flow is off, so nothing changes for existing accounts.

### D9. The new `booking` intent, at every site that lists intents

Adding `booking` touches every hard-coded intent list:

1. `_shared/agentTriage.ts:16` `INTENTS`, plus the choice criteria text;
2. `src/features/agent-tests/domain/types.ts:3` `TEST_INTENTS`;
3. the `ai_agent_test_expected_valid` CHECK in `20260926110000_ai_agent_test_sets.sql:43`, which needs a new migration that replaces that function;
4. `ai-agent-reply/intentLabels.ts:8` `INTENT_LABELS`. Its type forces an entry, so a `Booking` label is added with colour `#f59e0b`;
5. any dashboard or UI intent list, found by grepping for `"order_status"` during planning.

### D10. The prompt block

When a flow is active, one block follows the triage hint:

- "Active procedure: `<name>`, step `<n>` of `<total>`";
- the field needed now, with the business's wording as guidance;
- the fields collected so far;
- the off-script rule: answer briefly, then re-ask.

Once `order_status` has looked up the order, the block also carries the fixed structure the model must fill.

### D11. Platforms and surfaces

- **Direct messages** on WhatsApp, Facebook and Instagram. The config is already per `social_account_id`, so the toggle is per account.
- **Not comments.** A request with `comment_id` never starts or continues a flow.
- **Not Threads.** Threads has no DM path in this codebase.

### D12. Sandbox (the PR #207 contract)

- **Isolated state.** Each sandbox thread has its own `procedure_state`, so saved tests can drive and check a flow.
- **Real reads, simulated writes.** Read-only lookups (`lookup_orders`, `search_products`) are real. End-action writes are simulated: the lead or booking insert, the admin notification, and the handoff. The state still advances and clears, so a test can check that the flow completed.
- **Test response fields.** The sandbox response gains `procedure: { key, step, completed }` for test assertions.

## Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `_shared/procedures/templates.ts` | The five template definitions: steps, fields, validators, version | nothing |
| `_shared/procedures/engine.ts` | Pure state transitions: `startProcedure`, `submitFields`, `cancel`, `expire`, `recordOffScript` | templates |
| `_shared/procedures/config.ts` | Parse and validate `agent_behavior.procedures`, with defaults | templates |
| `ai-agent-reply/procedureTools.ts` | Tool definitions and handlers for `start_procedure`, `procedure_submit` and `procedure_cancel`, plus end actions through injected ports | engine, `tools.ts` escalation, `leads` |
| `ai-agent-reply/logic.ts` | `procedurePromptBlock(state, config)` | engine |
| `ai-agent-reply/index.ts` | Wiring: lazy expiry, Jev start, the smalltalk rule, state persistence in `persistDelivery` | the above |
| Migration | `ai_threads.procedure_state jsonb`; replace `ai_agent_test_expected_valid` to admit `booking` | — |
| `src/components/messaging/agent-settings/ProceduresCard.tsx` | The authoring UI | `useAiAgentConfig` |

## Error handling

- **End action fails** (the lead insert, the lookup or the notify):
  - the tool result tells the model to apologise and offer a human;
  - the state stays on the final step so the next turn can retry;
  - the failure is logged to `system_logs` (source `ai-agent-reply`, category `ai`).
- **Invalid config** on read: `parseAgentBehavior` drops the bad flow, which then counts as disabled, and logs once. A reply never fails because of procedure config.
- **Engine exceptions** are bugs. They are not swallowed; the turn fails the way any tool bug does today, and tests cover the transitions.

## Testing

- **Engine (pure):** every transition. Covered cases:
  - start while active;
  - valid, invalid and partial submits;
  - an off-script counter of 3;
  - expiry by age and by version;
  - cancel;
  - completion.
- **Config:** defaults, limits, and dropping an invalid flow.
- **Tool handlers:** start and submit in one turn; idempotent end actions keyed by `run_id`; the sandbox simulating writes.
- **Wiring:** Jev start per intent; `product_finder` never started by Jev; the smalltalk path skipped while a flow is active; comment requests ignored; state persisted only on delivery.
- **One end-to-end run per template** through the sandbox harness.
- **SQL:** the migration applied twice (idempotent), plus the CHECK accepting `booking` and still rejecting unknown intents.

## Out of scope (Spec B or later)

- Store-event triggers: the WooCommerce webhook, back-in-stock and delivery events.
- WhatsApp template sends, and the 24-hour window policy for business-started messages.
- The three business-started flows.
- Custom procedures built from scratch (a visual builder). Only the templates are editable.
- Calendar availability for bookings. A booking is a request the admin confirms.
