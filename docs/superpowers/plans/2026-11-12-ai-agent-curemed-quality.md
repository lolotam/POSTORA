# AI agent quality for curemedkw — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the curemedkw WhatsApp agent answer Arabic product questions correctly. That means:

- Correct Arabic knowledge.
- Live catalog with real product links.
- A fixed greeting.
- Replies in the customer's language.
- Sane behaviour around human handoff.

**Architecture:**

- **Pure helpers** in `ai-agent-reply/logic.ts`. Each one has its own Deno unit test:
  - `greetingFor`
  - `replyLanguageText`
  - `humanModeAck`
  - `escalationApology`
  - `staffTurnsSince`
- **Wiring** at the existing single points in `ai-agent-reply/index.ts`:
  - The gate return.
  - The language call.
  - The `replyText` birth site.
- **CSV fix:** a UTF-8 decode before SheetJS.
- **Catalog:**
  - The Supabase adapter gains an allow-listed, read-only RPC mode.
  - A new `ai_agent_tools` row points the curemedkw account at `agent_search_products`.
- **Model choice:** a dry-run probe replays the real conversation against candidate models. It sends nothing.

**Tech Stack:** Deno edge functions, Supabase Postgres (self-hosted), `npm:xlsx@0.18.5`, PostgREST.

**Spec:** `docs/superpowers/specs/2026-11-12-ai-agent-curemed-quality-design.md`

## Global Constraints

- Read `ARCHITECTURE.md` before touching `supabase/functions/**`. It covers §12–16 (function shape, sanitized errors), §23 (RLS/grants/types) and §26–28 (idempotency, atomic claim).
- **Greeting text, verbatim.**
  - Arabic: `وعليكم السلام ورحمة الله، أهلاً بك في كيور ميد 🌿 كيف نقدر نساعدك؟`
  - English mirror: `Welcome to CureMed 🌿 How can we help you?`
- The greeting is sent only on the first message of a conversation. Any question in that same message is still answered after it.
- **Reply language** = the language of the customer's own latest words. Text added by the media envelope (image description, OCR) never decides it.
- **Human mode:** exactly one fixed acknowledgement per escalation. After it, silence until staff replies or the escalation expires.
- **Product links:** copied verbatim from the catalog's `product_url`. Never invented.
- **Not found:** retry with a looser query. Then ask for the product name or a photo. Escalate only on an explicit request or after two failed searches.
- **RPC:** only named functions in `settings.rpc_allow_list`, only POST with a JSON object body, and always with the tool's anon key. `read_only_mode` stays true.
- No customer-visible string is produced by the model where the spec fixes the wording.
- **Test command:**
  `deno test --allow-env --allow-read --allow-write --allow-net --no-check --node-modules-dir=none supabase/functions/<dir>`
- **Commits:** scoped with `git commit -- <paths>`. Never commit graphify-out, logs, `.env*` or secrets.
- **Commit trailer:** `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **Prod changes:**
  - Migrations are applied before merge.
  - Edge functions reach prod via the Dokploy "Edge Functions Sync" after merge.
  - Merge and the curemedkw anon key are Waleed's decisions.

## File map

| File | Change |
|---|---|
| `supabase/functions/ai-knowledge-ingest/parsing.ts` | Decode CSV as UTF-8 (BOM-aware) before `XLSX.read` |
| `supabase/functions/ai-knowledge-ingest/parsing.test.ts` | Arabic CSV fixture test |
| `supabase/functions/ai-agent-reply/logic.ts` | New pure helpers listed above |
| `supabase/functions/ai-agent-reply/agentQuality.test.ts` | New: tests for those helpers |
| `supabase/functions/ai-agent-reply/index.ts` | Wiring (gate, language, reply birth, history merge) |
| `supabase/migrations/20261112130000_ai_conversation_modes_ack.sql` | `customer_ack_sent_at`, `apology_sent_at` + claim RPCs |
| `supabase/functions/ai-agent-adapters/supabase.ts` (+ test) | Allow-listed RPC mode |
| `supabase/functions/_shared/connectorRegistry.ts` | `rpc_allow_list` setting, `query`/`max_results` parameters |
| `supabase/functions/ai-agent-reply/logic.ts` `buildSystemPrompt` | Not-found / escalation rule |
| `scripts/probes/agent-model-dryrun.ts` | Model comparison probe |
| `.github/workflows/ci.yml` | Run the `ai-agent-reply` + `ai-agent-adapters` Deno tests (today CI runs neither) |

---

### Task 1: CSV UTF-8 decode and re-ingest

**Root cause:** `parsing.ts:91` calls `XLSX.read(await file.arrayBuffer(), { type: "array" })`. With no codepage set, SheetJS reads CSV bytes as Latin-1. That is why the knowledge chunks are stored as `Ø§Ù„Ø¹...`.

**Files:**
- Modify: `supabase/functions/ai-knowledge-ingest/parsing.ts:~85-95`
- Test: `supabase/functions/ai-knowledge-ingest/parsing.test.ts`

- [ ] **Step 1: Failing test.** Build a `Blob` from UTF-8 bytes of `name,price\nكريم الكعب,6\n`, with and without a leading BOM `﻿`. Parse it as `csv` through the same exported entry `parsing.test.ts` already uses for xlsx. Assert:
  - The produced text contains `كريم الكعب`.
  - It does not contain `Ø`.

  Use `test.each` style: one `for` over the two byte variants inside a single `Deno.test`.
- [ ] **Step 2:** Run the test. It is expected to FAIL with mojibake.
- [ ] **Step 3: Implement.** For `csv` sources only, decode first:
  ```ts
  // SheetJS reads CSV bytes as Latin-1 unless told otherwise; the stores' exports are UTF-8.
  const text = new TextDecoder("utf-8").decode(await file.arrayBuffer()); // strips a BOM by default
  const workbook = XLSX.read(text, { type: "string" });
  ```
  Keep `{ type: "array" }` for xlsx/xls.
- [ ] **Step 4:** Run the test. It is expected to PASS. Also run the full `ai-knowledge-ingest` suite.
- [ ] **Step 5:** Commit `fix(knowledge): read CSV sources as UTF-8`.
- [ ] **Step 6 (prod, after merge + sync):**
  1. Find the two curemedkw sources:
     ```sql
     select id,file_name,status from ai_knowledge_sources
     where user_id='146a9939-e54e-4077-932b-03806d30b6d6'
       and file_name in ('products_rows.csv','categories_rows.csv');
     ```
  2. Re-run ingest for each one through the existing re-ingest path (Admin knowledge page "re-process", or the `ai-knowledge-ingest` invoke the page uses).
  3. Verify:
     ```sql
     select count(*) filter (where content like '%Ø%') bad, count(*) total
     from ai_knowledge_chunks where source_id in (...);
     ```
     Expect `bad = 0`.

### Task 2: Reply language from the customer's own words

**Root cause:**
- The image reply in English came from `threadReplyLanguage({ inboundText: request.inbound_text, ... })` at `index.ts:1065`.
- For media, `inbound_text` is the `composeAgentText` envelope. Its description/OCR body is English.
- `withoutAgentTextEnvelope` strips only the header and fence lines, not that body.

**Step 0 (proof):** Before writing code, read the `ai_agent_logs.inbound_text` of the English image reply in conversation `wa_96560003759_96555683677`. Confirm it carries the envelope. If it does not, stop and re-diagnose.

**Interfaces — Produces:**
```ts
/** The customer's own words in an inbound text: the caption/typed text, never a media description. */
export function replyLanguageText(inboundText: string): string;
```

- [ ] **Step 1: Failing tests** in `agentQuality.test.ts`, table-driven:
  - Plain Arabic text → unchanged.
  - Envelope with an English OCR body and no caption → `""`, so letterless and the thread decides.
  - Envelope plus an Arabic caption line outside the fence → the caption.
- [ ] **Step 2:** Run them. They are expected to FAIL (function missing).
- [ ] **Step 3: Implement** in `logic.ts`.
  - Drop everything between `AGENT_TEXT_FENCE` lines, and drop the header lines. Reuse `AGENT_TEXT_FENCE` and `agentTextHeader`'s notice from `_shared/agentTextEnvelope.ts`; do not re-type the literals.
  - Wire it in at `index.ts:1065`:
    ```ts
    inboundText: replyLanguageText(request.inbound_text),
    ```
  - Make the same substitution wherever `customerLanguageSignal(request.inbound_text, ...)` stores `ai_threads.customer_language` (grep the call sites).
- [ ] **Step 4:** Run the tests. They are expected to PASS. Then run the full `ai-agent-reply` suite.
- [ ] **Step 5:** Commit `fix(ai-agent): judge reply language by the customer's words, not the image description`.

### Task 3: Fixed greeting on the first message

**First message:**
- `historyRows.length === 0` on the raw query result (`index.ts:~924`).
- Not on `history`, which `historyWindow` also empties after seven quiet days.

**Interfaces — Produces:**
```ts
export const GREETING = {
  ar: "وعليكم السلام ورحمة الله، أهلاً بك في كيور ميد 🌿 كيف نقدر نساعدك؟",
  en: "Welcome to CureMed 🌿 How can we help you?",
} as const;
/** reply with the greeting prepended unless the model already opened with it. */
export function withGreeting(reply: string, language: ReplyLanguage): string;
```

The greeting text is per account, so read it from `config.greeting_text_ar` / `config.greeting_text_en`. When a column is absent, do not greet.

- Check `ai_agent_configs` first. Add the columns (nullable text) in the Task 4 migration file.
- Set them only for the curemedkw config row. The constant above is the seed value, not a global default.

- [ ] **Step 1: Failing tests:**
  - Arabic → `GREETING.ar + "\n\n" + reply`.
  - Reply already starting with the greeting → unchanged.
  - Empty reply → greeting alone.
  - English case.
- [ ] **Step 2:** Run them. They are expected to FAIL.
- [ ] **Step 3: Implement** `withGreeting(reply, greetingText)`, taking the text, not the language.
  - In `index.ts`, after `repairChatReply` (`:1493`):
    ```ts
    if (isFirstMessage && greetingText) replyText = withGreeting(replyText, greetingText);
    ```
  - `greetingText` comes from `language === "ar" ? config.greeting_text_ar : config.greeting_text_en`.
  - Remove the greeting instruction from `buildSystemPrompt` when the account has a fixed greeting, so the model does not greet twice.
- [ ] **Step 4:** Run the tests. They are expected to PASS. Then run the suite.
- [ ] **Step 5:** Commit `feat(ai-agent): send the account's fixed greeting on a conversation's first message`.

### Task 4: Human-mode acknowledgement and post-escalation apology

**Migration:** `supabase/migrations/20261112130000_ai_conversation_modes_ack.sql`

```sql
ALTER TABLE public.ai_conversation_modes
  ADD COLUMN IF NOT EXISTS customer_ack_sent_at timestamptz,
  ADD COLUMN IF NOT EXISTS apology_sent_at timestamptz;
ALTER TABLE public.ai_agent_configs
  ADD COLUMN IF NOT EXISTS greeting_text_ar text,
  ADD COLUMN IF NOT EXISTS greeting_text_en text,
  ADD COLUMN IF NOT EXISTS human_mode_ack_ar text,
  ADD COLUMN IF NOT EXISTS human_mode_ack_en text,
  ADD COLUMN IF NOT EXISTS escalation_apology_ar text,
  ADD COLUMN IF NOT EXISTS escalation_apology_en text;

-- Claims are single-flight: two webhook deliveries for one message must not both send.
CREATE OR REPLACE FUNCTION public.claim_human_mode_ack(p_mode_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH c AS (
    UPDATE public.ai_conversation_modes SET customer_ack_sent_at = now()
    WHERE id = p_mode_id AND customer_ack_sent_at IS NULL RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM c);
$$;
CREATE OR REPLACE FUNCTION public.claim_escalation_apology(p_mode_id uuid)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  WITH c AS (
    UPDATE public.ai_conversation_modes SET apology_sent_at = now()
    WHERE id = p_mode_id AND apology_sent_at IS NULL RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM c);
$$;
REVOKE ALL ON FUNCTION public.claim_human_mode_ack(uuid), public.claim_escalation_apology(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_human_mode_ack(uuid), public.claim_escalation_apology(uuid)
  TO service_role;
-- A new escalation re-arms both: escalateConversation upserts the row, so it must reset them.
NOTIFY pgrst, 'reload schema';
```

- `escalateConversation` (`tools.ts:286`) must write `customer_ack_sent_at: null, apology_sent_at: null` in its upsert.
- Seed curemedkw's six text columns in a separate data step (Step 7), not in the migration.

**Interfaces — Produces:**
```ts
/** Staff replies sent from the inbox after `sinceIso`, as assistant turns the model can read. */
export function staffTurnsSince(
  rows: Array<{ direction: string; from_name: string | null; body: string | null; created_at: string }>,
  sinceIso: string,
): Array<{ role: "assistant"; content: string }>;
/** True when the escalation expired and no staff reply exists after it began. */
export function needsEscalationApology(
  mode: { expires_at: string | null; updated_at: string; apology_sent_at: string | null } | null,
  staffTurns: number,
  nowMs: number,
): boolean;
```

**Behaviour:**

1. **Gate closed (`index.ts:759`):**
   - Applies when the reason is `mode_human_first` or `human_agent_active`, an escalation row is active (`expires_at > now`), and the account has `human_mode_ack_<lang>`.
   - Call `claim_human_mode_ack(row.id)`. On `true`, send the ack through the same `buildReplySender` path. Store it in `ai_thread_messages` as `assistant` and log `status: "human_mode_ack"`.
   - On `false`, keep today's skip.
   - Manual overrides (`expires_at IS NULL`) and plain `human_first` accounts get no ack.
2. **AI answering again:**
   - Read the newest `ai_conversation_modes` row for the conversation. If `needsEscalationApology(...)` holds and `claim_escalation_apology` returns `true`, prepend `escalation_apology_<lang>` to `replyText`, after the greeting step.
   - Staff turns = `whatsapp_messages` with `direction='outbound'`, `from_name` not `'AI Agent'` (`index.ts:797`), and `created_at` after the row's `updated_at`.
3. **History:**
   - Merge `staffTurnsSince(...)` into the window, ordered by `created_at`, so the AI continues from what staff said.
   - Label each one `"(staff) "` in content so the model can tell it from its own words.

**Step 0 (proof):** Confirm the staff-sender marker on prod before relying on it:
```sql
select from_name, count(*) from whatsapp_messages
where conversation_id like 'wa_96560003759%' and direction='outbound' group by 1;
```
Expect `AI Agent` and `You`. If staff rows use another marker, use that and note it here.

- [ ] **Step 1: Failing tests:**
  - `staffTurnsSince`: filters AI rows, inbound rows and rows before `since`.
  - `needsEscalationApology`, table-driven:
    - Active row → false.
    - Expired with staff turns → false.
    - Expired, none, not sent → true.
    - Already sent → false.
    - Null row → false.
- [ ] **Step 2:** Run them. They are expected to FAIL.
- [ ] **Step 3:** Implement the helpers, the migration, the `escalateConversation` reset and the wiring.
- [ ] **Step 4:** SQL proof `supabase/tests/conversation_mode_claims.sql`, registered in `scripts/db-harness.sh` SUITES:
  - Two claims on one row → `true`, then `false`.
  - The escalate upsert re-arms the claim.
  - `anon`/`authenticated` cannot execute either function.
- [ ] **Step 5:** Run the Deno suite and the DB harness.
- [ ] **Step 6:** Commit `feat(ai-agent): one human-mode acknowledgement and an apology after an unanswered escalation`.
- [ ] **Step 7 (prod, before merge):**
  1. Apply the migration.
  2. Set curemedkw's text columns. The owner wording for the ack and apology comes from a card. The greeting is already fixed by the spec.

### Task 5: Allow-listed RPC in the Supabase adapter

**Why:** `agent_search_products(q, max_results)` does the Arabic normalisation and trigram ranking. Exact-match `eq` filters on a table cannot find "كريم الكعب". The adapter refuses `rpc/` on purpose (`supabase.ts:277`), so the opening has to be narrow.

**Settings (connectorRegistry.ts Supabase entry):**
- `rpc_allow_list`: comma list of function names, each matching `^[a-z_][a-z0-9_]*$`.
- `rpc_query_param` (default `q`).
- `rpc_limit_param` (default `max_results`).

**Model parameters for `search_products`** gain:
- `query` (string): required when the tool has an RPC.
- `max_results` (int 1..25, default 8).

**Execution:**
- When `settings.rpc_allow_list` is non-empty and the capability is `search_products`:
  - POST `${project_url}/rest/v1/rpc/${fn}` with body `{ [q]: query.trim(), [limit]: clamp(max_results,1,25) }` and the tool's anon key headers.
  - `fn` is the first allow-listed name.
  - Empty `query` → validation error `supabase_query_required`. Never call with an empty query; this is the 2026-11-10 failure.
  - The response is the same row array the table path returns, so `column_map` and `max_rows` handling are reused.
- Model-supplied `table` containing `rpc/` stays refused. Only settings can name a function.

- [ ] **Step 1: Failing tests** in `ai-agent-adapters/supabase.test.ts`, with a fetch stub at the HTTP boundary asserting the request the adapter makes:
  - The allow-listed RPC sends `POST /rest/v1/rpc/agent_search_products` with `{"q":"كريم الكعب","max_results":8}`.
  - An empty query → `supabase_query_required` and no fetch.
  - A model-supplied `table: "rpc/x"` → still `supabase_rpc_refused`.
  - `max_results: 99` → `25`.
  - No allow list → today's table GET (regression).
- [ ] **Step 2:** Run them. They are expected to FAIL.
- [ ] **Step 3:** Implement in `supabase.ts` and the registry. Update `connectorUsageGuide("supabase")` so the model knows `query` is the product words in the customer's language.
- [ ] **Step 4:** Run both suites (`ai-agent-adapters`, `ai-agent-reply` `connectorRouting`/`tools`). Expected: PASS.
- [ ] **Step 5:** Commit `feat(connectors): allow-listed read-only Supabase RPC for catalog search`.

### Task 6: curemedkw catalog tool and the not-found rule

- [ ] **Step 1: Prompt rule.** In `buildSystemPrompt` (`logic.ts:529`), when a catalog tool is present, add one fixed paragraph:
  - Search with the product words.
  - On no result, search once more with a looser query (brand only, or the English/Arabic name).
  - Then ask the customer for the product name or a photo.
  - Escalate only when the customer asks for a person or after two searches found nothing.
  - Always give the `product_url` from the result, as is.
  - `price_hidden` → say the price is on request.
  - `shopping_enabled=false` → browse only.

  Test: the prompt contains the paragraph only when a catalog tool is in the list.
- [ ] **Step 2:** Commit `feat(ai-agent): retry, ask, then escalate when a product is not found`.
- [ ] **Step 3 (prod data, after merge + sync):**
  1. Confirm with T3-Curemedkw-Manager that `agent_catalog_products` and `agent_search_products` are live on `https://supabase.curemedkw.com`.
  2. Get the curemedkw anon key through `request_secret`. It is the owner's; never paste it in chat.
  3. Probe:
     ```bash
     curl -s -X POST .../rest/v1/rpc/agent_search_products \
       -H "apikey: $K" -H "Authorization: Bearer $K" -H 'Content-Type: application/json' \
       -d '{"q":"كريم الكعب","max_results":3}'
     ```
     Expect rows that carry `product_url`.
  4. Insert the tool row:
     ```sql
     insert into ai_agent_tools (user_id, name, description, connector_type, tool_type, url,
       is_enabled, read_only_mode, auth_strategy, permissions, settings)
     values ('146a9939-e54e-4077-932b-03806d30b6d6', 'curemedkw_product_catalog',
       'CureMed product catalog: names (Arabic and English), price, stock and the product page link.',
       'supabase', 'n8n_webhook', 'https://supabase.curemedkw.com', true, true, 'manual_credentials',
       '{"search_products": true, "check_stock": false, "lookup_orders": false}',
       jsonb_build_object('project_url','https://supabase.curemedkw.com','schema','public',
         'rpc_allow_list','agent_search_products','max_rows',8));
     ```
  5. Store the anon key the same way the existing Supabase tools store it (`credentials_secret_id` / `configured_secret_fields`; copy the shape of tool `9aed0acc-…`).
  6. Link the account in `ai_agent_tool_accounts` (social account `7cf1b120-5172-4377-aca2-1abe85ab1c7f`).

### Task 7: Model dry-run table

**Files:** Create `scripts/probes/agent-model-dryrun.ts`. Modify the sandbox body in `index.ts:552-631`.

- [ ] **Step 1: Sandbox override.**
  - Accept `model_override: string` only when `dryRun` is true. It must be a model id present in `ai_agent_allowed_models`.
  - When it is set, the chain is that one model with no fallback.
  - Test: an override outside a dry run is ignored; an override not in the allowed list → 400.
- [ ] **Step 2: Probe script.** Arguments: `--conversation wa_96560003759_96555683677 --models a,b,c,...`.
  - Reads the conversation's customer turns from `ai_thread_messages` with the service role.
  - For each model, replays each turn through the sandbox with `dryRun`, carrying the same history.
  - Writes `docs/superpowers/reports/2026-11-12-curemed-model-dryrun.md` with columns: model, turn, latency ms, reply language correct (`detectReplyLanguage` vs expected), catalog tool called with non-empty query, product link present, reply excerpt (120 chars).
  - Nothing is sent: the sandbox path never calls a sender.
- [ ] **Step 3:** Run against 5–6 models from `ai_agent_allowed_models`, after Tasks 1–6 are live. Commit the report.
- [ ] **Step 4:** Owner card: pick the primary and the fallback. Then set `system_settings` `default_ai_model_agent*`, or the account's own tier, as chosen.

### Task 8: CI, guard, PR, rollout

- [ ] Add `ai-agent-reply` and `ai-agent-adapters` to the Deno test step in `.github/workflows/ci.yml` with the flags above. Check first that the suites pass on `main` unchanged; if one is already red there, record it and add only the green ones.
- [ ] Run `clean-code-guard` on production changes and `test-guard` on the tests. Run `graphify update .`.
- [ ] Push the branch with `--no-track` semantics already set and open the PR.
- [ ] Babysit the bot rounds.
- [ ] Apply migration `20261112130000` on prod before merge.
- [ ] Merge only after the owner card.
- [ ] After the sync:
  - Verify hashes.
  - Run Task 1 Step 6 and Task 6 Step 3.
  - Ping T3-Curemedkw-Manager to re-test from +96555683677: greeting, Arabic product with link, image in Arabic, escalation ack.
- [ ] Save to mem0 and write the final report.

## Self-review

- **Spec coverage:**

  | Spec item | Covered by |
  |---|---|
  | CSV | Task 1 |
  | Links / catalog | Tasks 5, 6 |
  | Greeting | Task 3 |
  | Models | Task 7 |
  | Empty-filter catalog call | Task 5 (`supabase_query_required`) |
  | Human-mode silence | Task 4 |
  | Image language | Task 2 |
  | Apology + staff in history | Task 4 |
  | Not-found rule | Task 6 |
  | Timeout field, history window | Done earlier on this branch (`dbdb44d4`, `6663fb3f`) |

- **Owner input still needed:**
  - Ack and apology wording (card).
  - The curemedkw anon key (secret card).
  - Primary and fallback model (card after Task 7).
  - Merge.
