# Agent Procedures Spec B Implementation Plan

> **For agentic workers:** Execute task by task. Every task: read `ARCHITECTURE.md` first, write the failing tests, implement, run the gates, report. Do not commit; the orchestrator commits scoped files.

**Goal:** Business-started WhatsApp flows (COD confirmation, review request, back-in-stock) triggered by signed WooCommerce webhooks, run on the Spec A procedure engine.

**Architecture:** `store-webhook` verifies and filters WooCommerce deliveries into `store_events`; a cron worker (`process-store-events`, PR 2) sends the opener and starts the procedure; the existing `ai-agent-reply` path finishes it.

**Tech stack:** Deno edge functions (self-hosted Supabase), Postgres 17 + pg_cron, React/Vite/vitest.

**Spec:** `docs/superpowers/specs/2026-09-27-agent-procedures-b-design.md`

## Global constraints
- `ARCHITECTURE.md` is required reading for every task.
- Never store or log a raw webhook payload, a webhook secret, a Woo key, or a phone number in `system_logs`/console.
- Connector writes only through the new `update_order` capability, refused while `read_only_mode` is true (PR #204 invariant).
- New tables: RLS on; `REVOKE ALL ... FROM PUBLIC, anon, authenticated` then grant exactly what is needed (memory: revoking PUBLIC alone is not enough).
- Deno gate: from `supabase/functions`: `deno test -A --no-check --node-modules-dir=none _shared/ ai-agent-reply/ ai-agent-adapters/ store-webhook/ process-store-events/` then `deno check --node-modules-dir=none <every new or changed entry file>`. Run Deno before `bun install --frozen-lockfile`.
- Frontend gate: `npx vitest run`, `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.app.json`, `npx eslint <changed paths>`.
- SQL suites are registered in `scripts/db-harness.sh` `SUITES` and end with `\echo '=== <name>: ALL CHECKS PASSED ==='`.

---

# PR 1 — receive and store (nothing is sent)

### Task 1: Migration `20260927120000_store_events.sql` (Muse Spark)

**Files:** create `supabase/migrations/20260927120000_store_events.sql`, `supabase/tests/agent_procedures_b.sql`; modify `scripts/db-harness.sh` (SUITES).

**Produces:**
- `public.store_events` — columns exactly as spec §3.2 (`id uuid pk default gen_random_uuid()`, `user_id uuid not null references auth.users on delete cascade`, `social_account_id uuid not null references social_accounts on delete cascade`, `connector_id uuid not null references ai_agent_tools on delete cascade`, `flow text not null check (flow in ('cod_confirm','review_request','back_in_stock'))`, `external_id text not null`, `delivery_id text`, `payload jsonb not null default '{}'`, `status text not null default 'pending' check (status in ('pending','claimed','sent','skipped','failed'))`, `outbound_message_id text`, `skip_reason text`, `due_at timestamptz not null default now()`, `claimed_at timestamptz`, `attempts int not null default 0`, `created_at timestamptz not null default now()`, `processed_at timestamptz`), `unique (connector_id, flow, external_id)`, index `(status, due_at)`. Service-role only.
- `public.stock_waitlist` — `id`, `user_id`, `social_account_id`, `conversation_id text not null`, `phone text not null`, `product_id bigint not null`, `parent_id bigint`, `product_name text not null`, `created_at`, `expires_at timestamptz not null default now() + interval '60 days'`; **plain** `unique (social_account_id, phone, product_id)` (a notified row is deleted, so no partial index is needed and PostgREST `onConflict` works). Owner SELECT/DELETE policies by `user_id`; writes service-role.
- `public.messaging_opt_outs` — `user_id`, `phone`, `source text not null default 'keyword'`, `created_at`; `unique (user_id, phone)`. Owner SELECT/DELETE; writes service-role.
- Idempotent (IF NOT EXISTS / DROP ... IF EXISTS), ends with `NOTIFY pgrst, 'reload schema';`.

- [ ] Write the suite first (labelled asserts B1..Bn): tables and uniques exist; duplicate `(connector_id, flow, external_id)` raises `unique_violation`; bad `flow`/`status` raise `check_violation`; `has_table_privilege('anon','public.store_events','SELECT')` and `('authenticated', ...)` are false; `authenticated` has SELECT on `stock_waitlist` and `messaging_opt_outs` but not INSERT; RLS enabled on all three. End with the sentinel.
- [ ] Register `agent_procedures_b.sql` in `SUITES`.
- [ ] Orchestrator rehearses on Contabo (scratch DB from `pg_dump --schema-only`, apply twice, run suite, mutation-check one assert), then applies to production before PR 1 merges.

### Task 2: Shared phone and conversation-id helpers

**Files:** create `supabase/functions/_shared/phone.ts`, `_shared/phone.test.ts`; modify `ecommerce-whatsapp-api/index.ts` (replace its private `normalizePhone` with the shared one, behaviour-preserving for its callers).

**Produces:**
```ts
/** Digits only, country code included. `defaultCountry` is an ISO-3166 alpha-2 used when the raw number has no + or 00 prefix. Returns null when fewer than 8 digits remain. */
export function normalizePhone(raw: string, defaultCountry?: string | null): string | null;
export type WhatsAppAddressing = { mode: "cloud_api" | "coexistence" | "evolution_qr"; phoneNumberId: string | null; platformUserId: string };
/** Cloud API and coexistence: wa_<phoneNumberId>_<phone>; QR: wa_<platformUserId>_<phone>. Matches messaging-api:121 and evolutionMessage.ts conversationIdFor. */
export function whatsappConversationId(addressing: WhatsAppAddressing, phone: string): string;
```
- [ ] Table test: `+965 5551 2345`→`96555512345`; `0096555512345`→`96555512345`; `55512345` with `KW`→`96555512345`; `055512345` with `SA`→`96655512345` (leading trunk 0 dropped); `12`→null; with no country and no prefix → the digits unchanged. Country dialing codes: a small map of GCC + EG, JO, LB, IQ, US, GB (extendable); unknown country → digits unchanged.
- [ ] Test `whatsappConversationId` for both modes against the literal formats above.
- [ ] Run the existing `ecommerce-whatsapp-api` tests (if any) unchanged.

### Task 3: `store-webhook` receiver

**Files:** create `_shared/wooWebhook.ts`, `_shared/wooWebhook.test.ts`, `store-webhook/index.ts`, `store-webhook/index.test.ts`.

**Consumes:** `normalizePhone` (Task 2), tables (Task 1), `check_rate_limit` via `_shared/rate-limiter.ts`, `get_connector_credential(p_user_id, p_tool_id)` returning the connector blob (the webhook secret lives in it as `webhook_secret`, Task 4).

**Produces (pure, in `_shared/wooWebhook.ts`):**
```ts
export function isWooPing(contentType: string | null, rawBody: string): boolean; // form body exactly webhook_id=<digits>
export async function verifyWooSignature(rawBody: string, signature: string | null, secret: string): Promise<boolean>; // base64 HMAC-SHA256, constant-time
export function sourceMatchesStore(source: string | null, storeUrl: string): boolean; // host equality, ignore scheme/trailing slash/www
export type EventDraft = { flow: "cod_confirm" | "review_request" | "back_in_stock"; external_id: string; due_at: Date; payload: Record<string, string> };
export function classifyWooDelivery(input: {
  topic: string | null; body: unknown; now: Date; enabled: ReadonlySet<string>; reviewDelayDays: number;
  defaultCountry: string | null; waitlist?: Array<{ id: string; product_id: number; parent_id: number | null }>;
}): EventDraft[];
```
- Payload whitelist: `order_id, order_number, phone, first_name, total, currency, status, payment_method, product_id, product_name`. No address, email, line items.
- COD: topic `order.created`, `payment_method === "cod"`, status ∉ {cancelled, refunded, failed, completed}, phone normalizes → one draft, `external_id = String(order.id)`, due now. Review: topic `order.updated`, status `completed` → due `now + reviewDelayDays`. Back-in-stock: topic `product.updated`, `stock_status === "instock"` → one draft per waitlist row whose `product_id` or `parent_id` equals the product id, `external_id = "<product id>:<waitlist id>"`. Flow not in `enabled` → no draft. In PR 1 `enabled` is always empty (toggles hidden), so the receiver stores nothing yet; the classifier is fully tested.

**Handler (`store-webhook/index.ts`):** POST only; path `/store-webhook/<social_account_id>/<connector_id>` (both uuids); body read as text with a 256 KB cap (413); ping → 200 `{ok:true}`; rate limit `store-webhook:ip:<ip>` 120/min and `store-webhook:connector:<id>` 600/min → 429; load the account (platform `whatsapp`) and the tool (`connector_type = 'woocommerce'`, same `user_id`) else 404 with no detail; secret missing or signature bad or source mismatch → 401; parse JSON (bad → 400); classify; insert drafts with `upsert(..., { onConflict: "connector_id,flow,external_id", ignoreDuplicates: true })`, `delivery_id` from `X-WC-Webhook-Delivery-ID`; answer 200 `{ok:true, stored:n}`. Errors never echo input.

- [ ] Tests (Deno, no network; fake db ports): ping accepted without a secret; valid signature accepted; wrong secret, missing header, tampered body rejected; **mutation check**: replace the compare with `true` and confirm a test fails; source host mismatch rejected; 256 KB+1 rejected; each classifier branch incl. COD in `processing`, non-COD ignored, `order.updated` not completed ignored, `product.updated` outofstock ignored, disabled flow ignored, waitlist parent match; payload has only whitelisted keys; duplicate delivery stores once.

### Task 4: Webhook secret + card section (toggles hidden)

**Files:** modify the connector save path in `_shared/agentConfigOps.ts` (new operation `rotate_store_webhook_secret` for a `woocommerce` tool the caller owns: 32 random bytes → base64url, merged into the credential blob via `upsert_connector_credential_secret`, returned once); tests in the existing agentConfigOps test file; frontend: `src/components/ai-agent/ProceduresCard.tsx` gains a "Store events (WooCommerce)" section for WhatsApp accounts showing the webhook URL `https://api.postora.cloud/functions/v1/store-webhook/<account>/<connector>`, the three topics to add (Order created, Order updated, Product updated), and a Generate/Rotate button that shows the secret once with a copy button. i18n keys in `src/i18n/locales/{en,ar}/agent.json`.

- [ ] Tests: rotate refuses a tool of another user and a non-woocommerce tool; returned secret is 43 chars base64url; the blob merge keeps existing keys (fake vault asserts the RPC receives only `webhook_secret`); vitest: section shows only for WhatsApp + a Woo connector; the secret disappears after close.

### Task 5: Opt-out at ingest

**Files:** create `_shared/optOut.ts`, `_shared/optOut.test.ts`; modify `whatsapp-webhook/index.ts` (before `processAutoReplies`, ~line 585) and `whatsapp-evolution-webhook/index.ts` (same point before auto-reply/agent dispatch).

**Produces:**
```ts
export function isOptOutMessage(text: string): boolean; // whole trimmed message, case-insensitive: stop, unsubscribe, توقف, إلغاء الاشتراك, الغاء الاشتراك
export async function recordOptOut(db, input: { userId: string; phone: string; threadConversationId: string }): Promise<void>; // upsert messaging_opt_outs; clear an active event-origin procedure_state on that thread with a CAS; never throws (logs a sanitized warning)
```
- [ ] Tests: table of matching/non-matching texts ("stop" yes, "please stop sending" no, "STOP " yes, Arabic forms yes); recordOptOut clears only `origin === "event"` states; a DB error does not throw. The message still flows to rules/agent as before (behaviour unchanged except the record).

### Task 6: Engine additions (no sending)

**Files:** modify `_shared/procedures/templates.ts`, `engine.ts`, their tests; `ai-agent-reply/logic.ts` (`jevStartKey`), `procedureRuntime.ts` (`start_procedure` enum excludes event flows); `src/lib/procedureTemplates.ts` mirror.

**Produces:**
- `PROCEDURE_KEYS` gains `cod_confirm`, `review_request`, `back_in_stock`; `EVENT_PROCEDURE_KEYS` = those three. `ProcedureField` gains `when?: (fields: Record<string,string>) => boolean` (field is required only when `when` is absent or true). Fields: `cod_confirm.decision` (validate → `confirm`|`cancel` from confirm/yes/نعم/تأكيد/cancel/no/لا/إلغاء, hint "confirm or cancel"); `review_request.rating` (1–5, Arabic-Indic digits accepted), `review_request.problem` (`when: f => Number(f.rating) <= 3`, text 500); `back_in_stock.interest` (yes/no, Arabic). End actions `cod_update`, `review_route`, `stock_offer` (implemented in PR 2; in PR 1 `finish` throws `not_available` for them and they can never start).
- `nextField` and `submitFields` honour `when`.
- `staleAfterMs(origin)`: `event` → 72h, else 24h; `expireIfStale` uses it.
- `jevStartKey` and the model's `start_procedure` never return/accept an event key.
- [ ] Tests: conditional field (rating 4 completes without problem; rating 2 requires problem); validators table incl. Arabic; expiry 71h event state kept, 73h dropped, 25h model state dropped; `start_procedure` with `cod_confirm` refused; mirror parity test in vitest for keys.

**PR 1 exit:** guards (clean-code, test, security pass on `store-webhook`), gates, PR, CI + Codex bot rounds, migration live, merge, deploy verified (probe `store-webhook` ping → 200, unsigned JSON → 401).

---

# PR 2 — send and finish

### Task 7: Migration `20260928120000_store_events_worker.sql` (Muse Spark)
- `claim_store_events(p_limit int, p_lease interval)` SECURITY DEFINER, `search_path=public, pg_temp`, service-role EXECUTE only: `UPDATE store_events SET status='claimed', claimed_at=now(), attempts=attempts+1 WHERE id IN (SELECT id FROM store_events WHERE ((status='pending' AND due_at<=now()) OR (status='claimed' AND claimed_at < now()-p_lease)) AND attempts < 3 ORDER BY due_at LIMIT p_limit FOR UPDATE SKIP LOCKED) RETURNING *`. Rows at attempts ≥ 3 still `claimed` past the lease are set `failed` by the same call.
- Cron `process-store-events` every minute with the `cron.unschedule`-then-`cron.schedule` guard from `20260926091000_connector_response_cache.sql`, command calling the function with `'Authorization','Bearer ' || get_cron_secret()`.
- Suite additions: claim returns at most p_limit, skips locked/future rows, reclaims an expired lease, marks the 4th attempt failed; cron job row exists.

### Task 8: Adapter — `parent_id` + `update_order`
- `PRODUCT_FIELDS` += `parent_id`. New capability `update_order` (`order_id`, `status?` ∈ {cancelled}, `note`): GET the order first and return `{status}`; PUT `/orders/<id>` with `{status}` when given, POST `/orders/<id>/notes` with `{note, customer_note:false}`. Refused (no fetch) while `read_only_mode` is true; every other write stays refused. 401/403 → typed `store_write_denied`.
- Tests: refused while read-only with zero fetches; note-only call does one GET + one POST; cancel does GET + PUT + POST; 401 maps to `store_write_denied`; existing "writes refused" tests unchanged.

### Task 9: Worker `process-store-events`
- Cron-authed like `process-partner-webhooks`. Calls `claim_store_events(20, '2 minutes')`. Per row, spec §3.3 steps 1–6, with ports so tests need no network: `loadAccount`, `agentCanReply` (reuses `resolveEngagementMode` + agent enabled), `isOptedOut`, `qrOpenersToday`, `reReadOrder` (review only), `ensureThread`, `persistProcedureState`, `templateStatus`, `sendOpener`, `recordOpener`, `markEvent`. Opener text builders in `_shared/procedures/openers.ts` (ar/en, same wording as the templates).
- Resume rule: existing state with `origin==="event" && run_id===event.id` → continue at send; `outbound_message_id` present → skip send, go to record/mark.
- Purge: processed rows older than 30 days; waitlist rows past `expires_at`.
- Tests: each skip reason; own-attempt resume; idempotent send; QR cap 50; template not approved clears state; send failure clears state and marks failed; purge queries.

### Task 10: Templates submission and status
- `_shared/procedures/eventTemplates.ts`: the three definitions (name `postora_<flow>_v1`, category, ar/en bodies with `{{1}}…` and example values, COD quick replies Confirm/Cancel — Arabic تأكيد/إلغاء). Enabling a flow on a Cloud API account lists templates, reuses a same-name template, else creates it; a `REJECTED` `_v1` falls back to `_v2`. Status read on card load and by the worker.
- Tests: definitions carry examples for every variable; reuse path makes no create call; rejected v1 → create v2.

### Task 11: End actions and waitlist join
- Runtime `finish` implements `cod_update` (re-read guard, confirm → note, cancel → cancel + note, `store_write_denied` → admin alert + follow-up text), `review_route`, `stock_offer`; all after the PR #211 claim.
- Tool `stock_waitlist_join` offered only when `back_in_stock` is enabled and this turn's `check_stock` result contains the product with `stock_status !== "instock"`; the runtime copies id/parent/name from that result; upsert on `(social_account_id, phone, product_id)`; dry run writes nothing.
- Tests: every branch above incl. status-changed guard, read-only denial, join refused without a stock result, join from a stale turn refused.

### Task 12: Card toggles
- Show the three toggles; refuse enabling when the agent is disabled or `human_first`; refuse `cod_confirm` while the connector is read-only (explain); review delay 0–14 and https review link validated; template status badges.
- vitest for each refusal and validation.

### Task 13: Live verification (orchestrator)
- Replay a captured Woo `order.created` COD payload with a valid HMAC against production for the admin connector, with a test-only `dry_run` marker in `store_events.payload` that the worker honours by logging instead of sending; then one real send to the admin's own test number only. Restore any setting changed; delete test rows.

**PR 2 exit:** same as PR 1, plus the cron job verified in `cron.job` and one worker run observed in logs.
