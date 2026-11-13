# AI agent quality for curemedkw — Implementation Plan

> **Tracking:** the steps use checkbox (`- [ ]`) syntax. How the work is carried out is the implementer's own choice; this document states what has to be true at the end of each step, not which tool to reach for.

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

## Operator placeholders

All tenant/account identifiers in this plan are placeholders, never live identifiers. Before any operational SQL, obtain and verify the CureMed user UUID and its social-account UUID through the app. Supply `curemed_user_id` as a psql variable with `-v curemed_user_id=<VERIFIED_USER_UUID>`; replace `<CUREMED_SOCIAL_ACCOUNT_ID>` with the separately verified account UUID. Do not execute examples with an unset variable, a sentinel UUID, or an unverified account relationship. The connector INSERT remains illustrative only; save it through the app as instructed below.

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
- **RPC:** only named functions in `settings.rpc_allow_list`, called with GET so PostgREST runs them in a read-only transaction, and always with the tool's anon key. `read_only_mode` stays true, and the CALL enforces it: a GET is READ ONLY for every volatility class, so Postgres refuses a write inside it and nothing can be committed.
- No customer-visible string is produced by the model where the spec fixes the wording.
- **Test command:**
  `deno test --allow-env --allow-read --allow-write --allow-net=127.0.0.1 --node-modules-dir=none supabase/functions/<dir>`
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
| `supabase/functions/_shared/conversationModeOverride.ts` | Expiry through `expire_conversation_mode` |
| `supabase/migrations/20261112170000_agent_handoff_messages.sql` | escalation/ack columns, thread marker, 3 RPCs |
| `supabase/migrations/20261113120000_agent_handoff_messages_followup.sql` | the claim-release RPCs (`release_human_mode_ack`, `restore_unanswered_escalation`) |
| `supabase/migrations/20261113210000_agent_handoff_claim_lease.sql` | consolidated handoff leases, tenant/conversation binding, atomic persistence/replacement and expired-window claim receipts |
| `supabase/functions/ai-agent-adapters/supabase.ts` (+ test) | Allow-listed RPC mode |
| `supabase/functions/_shared/connectorRegistry.ts` | `rpc_allow_list` setting, `query`/`max_results` parameters |
| `supabase/functions/ai-agent-reply/logic.ts` `buildSystemPrompt` | Not-found / escalation rule |
| `scripts/probes/agent-model-dryrun.ts` | Model comparison probe |
| `.github/workflows/ci.yml` | Run the `ai-agent-reply` + `ai-agent-adapters` Deno tests (today CI runs neither) |

---

### Task 0: Pre-flight probes (before Tasks 4–7)

The review on 2026-11-12 found four assumptions that need live evidence first.

- [ ] **Catalog RPC is live.**
  1. Get the curemedkw anon key through `request_secret`.
  2. Curl `agent_search_products` once with `{"q":"كريم الكعب","max_results":3}`. Save the response, keys only and with no customer data, as `ai-agent-adapters/fixtures/curemed_search.json` for the Task 5 tests.
  3. Read the function's volatility with T3-Curemedkw-Manager. It must be STABLE so that GET `/rpc/` also works. If it is not live, Tasks 5–6 wait and the rest proceeds.
- [ ] **Why `curemedkw_supabase_catalog` disappeared after 2026-11-10.**
  1. Check `ai_agent_config_archive`.
  2. Check `system_logs` for tool deletes on user `146a9939-…`.
  3. Ask the owner if nothing shows.

  Re-create the tool through the app's own connector save path (Agent settings → Connectors). Do not use a raw INSERT, so the credential lands where the app stores it.
- [ ] **Model chain availability.** Before Tasks 1–6, run one dry-run turn per allowed model (Task 7 probe, synthetic conversation). The customer-facing chain is broken today (gemini fails, nemotron times out, jev returns 403), and fixing it does not depend on any other task.
- [ ] **Language diagnosis.** Turn Task 2 Step 0 into a test: feed the logged `inbound_text` of the English image reply and that thread's `customer_language` into `threadReplyLanguage`.
  - If it returns `en`, Task 2 as written is the fix.
  - If it returns `ar`, the model ignored the instruction. Task 2 then also adds a post-check: an `ar` turn whose reply has more Latin than Arabic letters (`letterLanguage`) gets one corrective regeneration.

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
  Keep `{ type: "array" }` for xlsx/xls. `ai-knowledge-excel-worker/index.ts:88` has its own `XLSX.read(bytes, { type: "array" })`.
  - Move the decision into one exported `readWorkbook(bytes, fileName)` in `parsing.ts`.
  - Have the worker call it, so there is one CSV rule.
- [ ] **Step 4:** Run the test. It is expected to PASS. Also run the full `ai-knowledge-ingest` suite.
- [ ] **Step 5:** Commit `fix(knowledge): read CSV sources as UTF-8`.
- [ ] **Step 6 (prod, after merge + sync):**
  1. Find the two curemedkw sources:
     ```sql
     select id,file_name,status from ai_knowledge_sources
     where user_id=:'curemed_user_id'::uuid
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

**Step 0 (proof):** Before writing code, read the `ai_agent_logs.inbound_text` of the English image reply in the curemedkw conversation whose id is `wa_<owner-number>_<customer-number>`. Confirm it carries the envelope. If it does not, stop and re-diagnose.

**Interfaces — Produces:**
```ts
/** The customer's own words in an inbound text: the caption/typed text, never a media description. */
export function replyLanguageText(inboundText: string): string;
```

- [ ] **Step 1: Failing tests** in `agentQuality.test.ts`, table-driven:
  - Plain Arabic text → unchanged.
  - Envelope with an English OCR body and no caption → `""`, so letterless and the thread decides.
  - Envelope plus an Arabic caption line outside the fence → the caption.
  - Voice-transcript envelope (Arabic transcript) → the transcript. A transcript is the customer's own words. Key the drop on the image/OCR label `composeAgentText` writes (`inboundMediaPipeline.ts:375`), not on every fence.
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

### Task 3: Fixed greeting on the first message — DONE `4368f843`

**Owner (card, 2026-11-12):**
- Every agent respects its "Opening message" field (`agent_behavior.greeting`).
- When that field is empty, the agent follows "Additional instructions" (`persona_instructions`).

**Implemented:**
- `fixedGreeting(greeting, language)`: returns the field text when its script matches the reply language.
- `withGreeting(reply, greeting)`: prepends it once.
- Applied at the reply birth site, only when the conversation has no stored turn and the history read succeeded. Never on comments or store-event flows.
- The prompt tells the model not to greet when code already did (`greetingSent`).
- An empty field changes nothing; when the language does not match, the old prompt instruction stays.
- No new columns.

### Task 4: Human-mode acknowledgement and post-escalation apology

**Facts that shape this task (verified 2026-11-12):**
- An expired override row is DELETED on read.
  - `resolveConversationOverride` (`_shared/conversationModeOverride.ts:104`) deletes it.
  - It is called from both `ai-agent-reply/index.ts:708` and `process-pending-replies/index.ts:208`.
  - So the AI's next turn cannot "find the expired row". Expiry has to leave a durable marker at the moment of deletion.
- The gate at `index.ts:759` runs before the sender (`:770`), history (`:894`) and `language` (`:1065`) exist. The ack path must build what it needs itself, and own the outbox row that is cancelled there today.
- `escalationOverride` writes `mode='human_then_ai'` when no human is assigned. In that mode the AI never went silent, so it gets no ack and no apology. Only `mode='human_first'` rows count.

**Migration:** `supabase/migrations/20261112170000_agent_handoff_messages.sql`, then
`supabase/migrations/20261113120000_agent_handoff_messages_followup.sql` (the claim-release RPCs), then
`supabase/migrations/20261113210000_agent_handoff_claim_lease.sql` (the claim LEASES and the outbox's
`generated_kind`). All three land before the edge functions: a migration always lands before the code that
depends on it, and the edge build calls the lease RPCs.

```sql
ALTER TABLE public.ai_conversation_modes
  ADD COLUMN IF NOT EXISTS escalated_at timestamptz,
  ADD COLUMN IF NOT EXISTS customer_ack_sent_at timestamptz;
-- Set when a silent (human_first) escalation expires; consumed by the AI's first reply after it.
ALTER TABLE public.ai_threads
  ADD COLUMN IF NOT EXISTS unanswered_escalation_since timestamptz;
-- Texts are code constants (owner card 2026-11-12), not per-account columns.

-- Single-flight: two deliveries of one message must not both send the ack.
CREATE OR REPLACE FUNCTION public.claim_human_mode_ack(p_user_id uuid, p_platform text, p_conversation_id text) RETURNS boolean ...
  -- UPDATE ... SET customer_ack_sent_at = now()
  --   WHERE (user_id, platform, conversation_id) match AND customer_ack_sent_at IS NULL AND mode = 'human_first'
  --   AND expires_at > now() RETURNING 1

-- Replaces the client-side delete: deletes the expired row and, for a human_first row, stamps
-- the thread in the same statement, so whichever function observes the expiry leaves the marker.
CREATE OR REPLACE FUNCTION public.expire_conversation_mode(p_mode_id uuid, p_user_id uuid, p_expires_at timestamptz)
RETURNS boolean ...

-- Returns and clears the marker atomically (NULL when there is none).
CREATE OR REPLACE FUNCTION public.take_unanswered_escalation(p_thread_id uuid, p_user_id uuid)
RETURNS timestamptz ...
-- Each: SECURITY DEFINER, SET search_path = public, pg_temp; REVOKE from PUBLIC, anon,
-- authenticated; GRANT EXECUTE to service_role. NOTIFY pgrst, 'reload schema'.
```

The function bodies are written in full in the migration. Each one is proved in `supabase/tests/agent_handoff_messages.sql`, registered in `scripts/db-harness.sh` SUITES. The proof covers:
- `claim_human_mode_ack` true then false.
- It is false for `human_then_ai` and for expired rows.
- `expire_conversation_mode` deletes once.
- It stamps the thread only for `human_first`.
- It keeps the original `escalated_at`.
- `take_unanswered_escalation` returns the stamp once, then NULL.
- `anon`/`authenticated` cannot execute any of the three.

**Code changes:**
- `escalateConversation` (`tools.ts:286`) writes `escalated_at: now` and `customer_ack_sent_at: null` in its upsert, which re-arms the ack for a new escalation.
- `resolveConversationOverride` calls `expire_conversation_mode` instead of `.delete()`. Its existing tests keep their contract (returns null after expiry).
- **Gate closed (`index.ts:759`):**
  - Applies when the reason is `mode_human_first`, the platform is `whatsapp`, the dry run is off, and an active `human_first` row exists with `expires_at` not null. Manual overrides get no ack.
  - Then `language` = `customerLanguageSignal(replyLanguageText(inbound))`, falling back to `thread.customer_language`, then `ar`.
  - `claim_human_mode_ack` must return true.
  - On success: build the sender, send the ack, insert the customer turn and the ack into `ai_thread_messages`, log `status: "human_mode_ack"`, and complete (not cancel) the outbox row through the same helper `persistDelivery` uses.
  - Otherwise, today's skip.
- **AI answering:** when `platform === "whatsapp"` and not a dry run, call `take_unanswered_escalation(thread.id)`.
  - With a timestamp `since` and zero staff turns after it, prepend `ESCALATION_APOLOGY[language]` to `replyText`, after the greeting step.
  - With staff turns, merge them into history instead (below).
- **Staff turns:** `whatsapp_messages` with `direction='outbound'` and `from_name='You'`, `created_at > since`. `from_name='You'` is the marker the staff send path writes, and it is the ONLY one: the agent writes `AI Agent` (`ai-agent-reply/index.ts:944`), the auto-reply rules write `Auto-Reply` (`whatsapp-webhook/index.ts:1099`), the store openers write `Store` (`ecommerce-whatsapp-api/handler.ts:332`), and a broadcast writes no `from_name` at all (`whatsapp-broadcast/chunk.ts:224`). So a positive match on `You` is a person, never an automation -- the other outbound rows are not staff turns and must not be counted as the answer to a silent window. They are merged into the history window by `created_at`, as `assistant` turns prefixed `"(staff) "`.
- **Step 0 (proof):**
  - Confirm the staff marker on prod:
    ```sql
    select from_name, count(*) from whatsapp_messages where conversation_id like 'wa_<owner-number>%' and direction='outbound' group by 1;
    ```
  - Confirm customer messages skipped at the gate are stored in `ai_thread_messages`. If not, also load the inbound `whatsapp_messages` after `since`, so staff answers keep their questions.

**Interfaces — Produces:**
```ts
export function staffTurnsSince(rows: MessageRow[], sinceIso: string): StoredTurn[];
// MessageRow = { direction, from_name, message_text, created_at } (whatsapp_messages columns)
export function escalationApologyText(
  since: string | null, staffTurns: number, language: ReplyLanguage,
): string | null; // ESCALATION_APOLOGY[language] only when since is set and staffTurns === 0
```

- [ ] **Step 1:** Failing Deno tests, table-driven, for `staffTurnsSince` and `escalationApologyText`. Also the updated `conversationModeOverride` test, which asserts the RPC is called with `(id, expires_at)`.
- [ ] **Step 2:** Run them. They are expected to FAIL.
- [ ] **Step 3:** Migration, SQL proof and code wiring.
- [ ] **Step 4:** Run the Deno suites and the DB harness. Expected: PASS.
- [ ] **Step 5:** Commit `feat(ai-agent): one human-mode acknowledgement and an apology after an unanswered escalation`.
- [ ] **Step 6 (prod, before merge):**
  1. Apply the migration.
  2. Texts are fixed in code (`logic.ts` `HUMAN_MODE_ACK`, `ESCALATION_APOLOGY`). The owner approved them by card on 2026-11-12:
     - Ack AR: `تم تحويل محادثتك لفريقنا، وراح يرد عليك أحد الموظفين بأقرب وقت 🌿`
     - Ack EN: `Your conversation is now with our team; a staff member will reply as soon as possible.`
     - Apology AR: `نعتذر عن التأخير في الرد 🙏`
     - Apology EN: `Sorry for the delay in getting back to you.`

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
  - GET `${project_url}/rest/v1/rpc/${fn}?${q}=<query.trim()>&${limit}=<clamp(max_results,1,25)>` with the tool's anon key headers. The arguments ride in the query string, where PostgREST matches them to the function's parameter names.
  - `fn` is the first allow-listed name.
  - Empty `query` → validation error `supabase_query_required`. Never call with an empty query; this is the 2026-11-10 failure.
  - The response is the same row array the table path returns, so `column_map` and `max_rows` handling are reused.
  - The call is a GET, and that is what makes the read-only promise true. PostgREST gives a GET a READ ONLY transaction for every volatility class -- VOLATILE, STABLE and IMMUTABLE alike -- so Postgres refuses a write inside it (SQLSTATE 25006) and nothing can be committed. A function runs with the rights of its owner, so a SECURITY DEFINER one can write even when the anon role cannot: the only thing that makes the read-only promise true is the call being unable to leave a write behind. The boundary is the server's own, not a preference the target may ignore, and it does not depend on how the project ends its transactions -- so the connector works on a stock Supabase project with no `db-tx-end` setting. The price is that a function that writes now fails instead of answering (PostgREST answers 405, which the adapter reports as `supabase_search_function_writes`); a reader that cannot write is better than a write it made by accident.
  - `rpc_query_param` and `rpc_limit_param` may not be the same name: the query string is one place, so two arguments with one name are one argument, and the query would be dropped.
  - `rpc_query_param` and `rpc_limit_param` may not be `select`, `order`, `limit` or `offset`: PostgREST reads those for itself on a GET, so an argument named after one of them would never reach the function. The configuration is refused rather than guessed at, and the connector card's help text says so.
- Model-supplied `table` containing `rpc/` stays refused. Only settings can name a function.

- [ ] **Step 1: Failing tests** in `ai-agent-adapters/supabase.test.ts`, with a fetch stub at the HTTP boundary asserting the request the adapter makes:
  - The allow-listed RPC sends `POST /rest/v1/rpc/agent_search_products` with `{"q":"كريم الكعب","max_results":8}`.
  - An empty query → `supabase_query_required` and no fetch.
  - A model-supplied `table: "rpc/x"` → still `supabase_rpc_refused`.
  - `max_results: 99` → `25`.
  - No allow list → today's table GET (regression).
  - The fixture `fixtures/curemed_search.json` (Task 0) passes through the output mapping with `product_url`, `price_hidden` and `shopping_enabled` intact.
  - Zero rows for a multi-word query → exactly one retry with the query's longest word, and the result says `retried_with`. Spec §3 puts the loosened retry in the tool, not in the prompt, because the model already ignored a prompt rule. The prompt asks for NO second catalog search, so the retry count is one and it is the tool's.
- [ ] **Step 2:** Run them. They are expected to FAIL.
- [ ] **Step 3:** Implement in `supabase.ts` and the registry. Update `connectorUsageGuide("supabase")` so the model knows `query` is the product words in the customer's language.
- [ ] **Step 4:** Run both suites (`ai-agent-adapters`, `ai-agent-reply` `connectorRouting`/`tools`). Expected: PASS.
- [ ] **Step 5:** Commit `feat(connectors): allow-listed read-only Supabase RPC for catalog search`.

### Task 6: curemedkw catalog tool and the not-found rule

- [ ] **Step 1: Prompt rule.** The tool makes the ONE loosened search itself (Task 5), so the prompt asks for no second catalog search. In `buildSystemPrompt` (`logic.ts:529`), when a catalog tool is present, add one fixed paragraph:
  - Search with the product words, exactly as the customer wrote them.
  - If the search finds nothing, call the catalog again with an Arabic/English synonym, transliteration or brand variant, including for one-word queries. Then search the knowledge base for the product before you ask the customer for anything: the catalog can be stale or incomplete, and the re-ingested product sheet still knows the product. Only when the knowledge base has nothing either, ask the customer for the product name as printed on the pack, or for a photo. Do not say the store does not sell it.
  - Escalate only when the customer asks for a person or after the searches found nothing.
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
  4. Create the tool through the app (Agent settings → Connectors → Supabase), with project URL `https://supabase.curemedkw.com`, anon key, and RPC allow list `agent_search_products`. That way the credential lands where the app stores it. The SQL below is only a reference for the expected row, never run as-is:
     ```sql
     insert into ai_agent_tools (user_id, name, description, connector_type, tool_type, url,
       is_enabled, read_only_mode, auth_strategy, permissions, settings)
     values (:'curemed_user_id'::uuid, 'curemedkw_product_catalog',
       'CureMed product catalog: names (Arabic and English), price, stock and the product page link.',
       'supabase', 'n8n_webhook', 'https://supabase.curemedkw.com', true, true, 'manual_credentials',
       '{"search_products": true, "check_stock": false, "lookup_orders": false}',
       jsonb_build_object('project_url','https://supabase.curemedkw.com','schema','public',
         'rpc_allow_list','agent_search_products','max_rows',8));
     ```
  6. Link the account in `ai_agent_tool_accounts` (social account `<CUREMED_SOCIAL_ACCOUNT_ID>`).

### Task 7: Model dry-run table

**Files:** Create `scripts/probes/agent-model-dryrun.ts`. Modify the sandbox body in `index.ts:552-631`.

- [ ] **Step 1: Sandbox override.**
  - Accept `model_override: string` only when `dryRun` is true. It must be a model id present in `ai_agent_allowed_models`.
  - When it is set, the chain is that one model with no fallback.
  - Test: an override outside a dry run is ignored; an override not in the allowed list → 400.
- [ ] **Step 2: Probe script.** Arguments: `--conversation wa_<owner-number>_<customer-number> --models a,b,c,...`.
  - Reads the conversation's customer turns from `ai_thread_messages` with the service role.
  - Replays under a synthetic conversation id `dryrun_<model>_<timestamp>`, never the real one. The sandbox still upserts `ai_threads` (`index.ts:713`) and resolves (and may expire) the conversation's override.
  - Asserts `dryRun` skips the Task 4 claims and `take_unanswered_escalation`.
  - For each model, replays each turn through the sandbox with `dryRun`, carrying the same history.
  - Writes `docs/superpowers/reports/2026-11-12-curemed-model-dryrun.md` with columns: model, turn, latency ms, reply language correct (`dominantReplyLanguage` vs expected), catalog tool called with non-empty query, any URL present, catalog grounded (identity match), reply excerpt (120 chars), status. Sandbox-only `catalog_evidence` includes bounded product identifiers, names and URLs from the actual tool result. The probe records yes/no identity matches and not measured for an older sandbox response. This is not a check of every price or medical claim.
  - The tracked report carries no customer data: the conversation id is redacted and the reply text is never written, only its length. The unredacted detail goes to the same path with a `.local` suffix, which `.gitignore` already ignores -- it must never be committed.
  - Nothing is sent: the sandbox path never calls a sender.
- [ ] **Step 3:** Run against 5–6 models from `ai_agent_allowed_models`, after Tasks 1–6 are live. Commit the report.
- [ ] **Step 4:** Owner card: pick the primary and the fallback. Then set `system_settings` `default_ai_model_agent*`, or the account's own tier, as chosen.

### Task 8: CI, guard, PR, rollout

- [ ] Run all hermetic `ai-agent-reply`, `ai-agent-adapters`, shared handoff and dry-run probe suites in CI with type checking enabled. Keep live provider tests excluded from this credential-free gate.
- [ ] Run `clean-code-guard` on production changes and `test-guard` on the tests. Run `graphify update .`.
- [ ] Push the branch with `--no-track` semantics already set and open the PR.
- [ ] Resolve review findings and verify CI on the final head.
- [ ] Apply the handoff migrations on prod before merge, in this order:
  - Already applied: `20261112170000_agent_handoff_messages.sql` and `20261113120000_agent_handoff_messages_followup.sql`. Do not edit or reapply them.
  - Before merge, apply only `20261113210000_agent_handoff_claim_lease.sql`. It consolidates all ten previously unapplied handoff deltas: leases with an explicit legacy-claim discriminator, tenant/conversation binding, atomic notice persistence/replacement, payload-checked delivery and durable receipts for expired windows. Arbitrary, superseded and consumed tokens are refused even after the mode row is deleted. A live notice claim carries its fixed text and scoped outbox row; if the worker dies, expiry makes that notice ready for normal outbox recovery. Legacy callers without an outbox retain the existing best-effort delivery limitation.
  - The migration preserves current main's `advance_agent_reply` signature and grants. The two newer tenant-less helpers are inaccessible to service_role. The new edge build uses only `*_for_owner` transitions. The existing legacy function is a temporary compatibility surface, not a tenant boundary.
  - Before deployment, run `bash scripts/db-harness.sh` against a disposable Supabase Postgres instance. The suites prove current main's legacy transition remains callable before retirement, the new owner-bound transitions reject cross-tenant/cross-conversation writes, and the guarded retirement script removes legacy access.
- [ ] Owner approves merge only after CI and rollout review. No deployment is performed by this implementation task.
- [ ] After the Edge Functions Sync deploys the new build, verify the deployed head and SHA256 hashes, then wait for every old edge worker to drain. Run the mandatory contract step:
  ```sh
  psql "$DB_URL" --single-transaction -v ON_ERROR_STOP=1 -v old_edge_workers_drained=true -f scripts/sql/retire-agent-reply-legacy.sql
  ```
  This revokes service_role/PUBLIC/browser execution on `advance_agent_reply`, `advance_agent_reply_kind` and `claim_agent_reply_for_delivery`. It is deliberately outside `supabase/migrations/` so a migration-first rollout cannot break current main. Do not run it before the deployment/drain verification. After retirement, an old edge build cannot be rolled back into service without an explicit compatibility decision.
- [ ] After the sync:
  - Verify hashes.
  - Run Task 1 Step 6 and Task 6 Step 3.
  - Ping T3-Curemedkw-Manager to re-test from the customer's number: greeting, Arabic product with link, image in Arabic, escalation ack.
  - Prove the handoff wiring live. A sandbox run bypasses the gate, so only a real WhatsApp message exercises it:
    1. Escalate, then send two messages. Expect exactly one ack, `ai_agent_logs.status = 'human_mode_ack'` once, and one held `user` row in `ai_thread_messages` for the second message.
    2. Move `ai_conversation_modes.expires_at` into the past with psql and send a message. Expect a reply opening with the apology, and `ai_threads.unanswered_escalation_since` NULL afterwards.
    3. Repeat with a staff reply (from the inbox) inside the window. Expect no apology, and the staff text as a `(staff)` assistant row in `ai_thread_messages`, visible to the following turn.
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
  - The curemedkw anon key (secret card).
  - Primary and fallback model (card after Task 7).
  - Merge.
