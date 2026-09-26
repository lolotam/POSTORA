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

**Files:** create `supabase/migrations/20260927120000_store_events.sql`, `supabase/tests/agent_procedures_b.sql`; modify `scripts/db-harness.sh` (SUITES). Read first: `20260831140000_connector_secret_reclaim.sql`, `20260831150000_connector_credential_read.sql` (vault helpers), `20260926091000_connector_response_cache.sql` (grants and cron style).

**Produces:**
- `store_webhook_bindings (id uuid pk, user_id uuid not null → auth.users on delete cascade, social_account_id uuid not null, connector_id uuid not null, secret_id uuid not null, previous_secret_id uuid, rotated_at timestamptz, created_at timestamptz default now())`; unique `(connector_id)`; composite FKs so the account and the connector both belong to `user_id` (`social_accounts (id, user_id)` and `ai_agent_tools (id, user_id)`; add the needed unique keys on those tables with IF NOT EXISTS). Owner SELECT only; writes service-role.
- `store_events` as spec §3.2 plus `binding_id uuid not null → store_webhook_bindings on delete cascade`, `claim_token uuid`, `send_attempt_id uuid`; the status check adds `'sending'`; unique `(binding_id, flow, external_id)` (replaces the connector-based unique). Service-role only.
- `stock_waitlist (id, user_id, social_account_id, connector_id, conversation_id, phone, product_id bigint, parent_id bigint, product_name, consent_source text not null default 'chat_optin', consented_at timestamptz not null default now(), created_at, expires_at default now() + 60 days)`; unique `(connector_id, phone, product_id)`. Owner SELECT/DELETE.
- `messaging_opt_outs (user_id, phone, source, created_at)`, unique `(user_id, phone)`. Owner SELECT/DELETE.
- `create_store_webhook_secret(p_secret text) returns uuid` (creates a vault secret, returns its id) and `get_store_webhook_secret(p_binding_id uuid) returns jsonb` (`{"current": text, "previous": text|null, "rotated_at": timestamptz|null}`), both SECURITY DEFINER with `search_path = public, pg_temp`, following the vault pattern of `get_connector_credential`; `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO service_role`.
- Every new table: RLS on; `REVOKE ALL FROM PUBLIC, anon, authenticated`; explicit grants. Idempotent; ends with `NOTIFY pgrst, 'reload schema';`.

- [ ] Suite first, labelled B1..Bn: objects exist; uniques raise `unique_violation`; checks raise `check_violation`; a binding whose account belongs to another user fails the FK; `SET ROLE authenticated` with `request.jwt.claims` for user A reads 0 of user B's waitlist/opt-out/binding rows and gets `insufficient_privilege` on `store_events`; `authenticated` and `anon` cannot EXECUTE the two functions; a secret created by `create_store_webhook_secret` round-trips through `get_store_webhook_secret`. Sentinel last. Register in `SUITES`.
- [ ] Orchestrator: rehearse (scratch DB, apply twice, suite, mutation check), apply to production before merge.

### Task 2: Strict phone parser and conversation id

**Files:** create `_shared/phone.ts`, `_shared/phone.test.ts`. `ecommerce-whatsapp-api` is **not** changed.

**Produces:**
```ts
export function parseCustomerPhone(raw: string, country: string | null): string | null; // digits with country code, or null
export type WhatsAppAddressing = { mode: "cloud_api" | "coexistence" | "evolution_qr"; phoneNumberId: string | null; platformUserId: string };
export function whatsappConversationId(addressing: WhatsAppAddressing, phone: string): string; // cloud/coexistence wa_<phoneNumberId>_<phone>; QR wa_<platformUserId>_<phone>
```
Rules: strip spaces, dashes, dots and parentheses. A `+` or `00` prefix means international digits. Otherwise, with a known country (KW 965/8, SA 966/9, AE 971/9, QA 974/8, BH 973/8, OM 968/8, EG 20/10, JO 962/9, IQ 964/10, LB 961/8, US 1/10, GB 44/10 — dialing code / national length after dropping one leading trunk 0): digits that already start with the dialing code at length code+national are kept; length equal to the national length is prefixed; anything else is null. Unknown country and no prefix → null. Final length must be 8–15, else null.
- [ ] Table test with at least 15 rows, including: `+965 5551 2345` → `96555512345`; `96555512345` with KW → `96555512345` (no double prefix); `55512345` with KW → `96555512345`; `0555123456` with SA → `966555123456`; `5551234` with KW → null; `55512345` with no country → null; 16 digits → null. `whatsappConversationId` for both modes.

### Task 3: `store-webhook` receiver

**Files:** create `_shared/wooWebhook.ts` (+ test), `store-webhook/index.ts` (+ test).

**Consumes:** Task 1 tables and `get_store_webhook_secret`; Task 2 `parseCustomerPhone`; `_shared/rate-limiter.ts`.

**Produces (pure):**
```ts
export function isWooPing(contentType: string | null, rawBody: string): boolean; // form body exactly webhook_id=<digits>
export async function verifyWooSignature(rawBody: string, signature: string | null, secrets: { current: string; previous: string | null; rotatedAt: Date | null }, now: Date): Promise<boolean>; // base64 HMAC-SHA256; previous accepted for 24 h after rotatedAt; constant-time
export type EventDraft = { flow: "cod_confirm" | "review_request" | "back_in_stock"; external_id: string; due_at: Date; payload: Record<string, string> };
export function classifyWooDelivery(input: { topic: string | null; body: unknown; now: Date; enabled: ReadonlySet<string>; reviewDelayDays: number; country: string | null; waitlist?: Array<{ id: string; product_id: number; parent_id: number | null }> }): EventDraft[];
```
Payload whitelist: `order_id, order_number, phone, first_name, total, currency, status, payment_method, date_completed, product_id, parent_id, product_name, consent_basis`. COD eligible statuses: pending, on-hold, processing. Review `due_at = date_completed + delay`, dropped when that is more than 48 h in the past. Back-in-stock drafts are only candidates; the worker re-reads stock.

**Handler order:** POST only → IP rate limit (`store-webhook:ip:<CF-Connecting-IP>`, 120/min) **before reading the body** → `Content-Length` > 262144 → 413, then read with a streaming cap → ping → 200 → path `/store-webhook/<binding uuid>` → load the binding (404, no detail) → secrets → signature (401) → connector rate limit (600/min, only after the signature) → parse JSON (400) → classify (flows enabled from the account's procedure config; in PR 1 event flows are never enabled, so nothing is stored) → insert with `ignoreDuplicates` → an insert error returns **500**, otherwise 200 `{ok:true, stored:n}`. Never store or log the raw body; never echo input.
- [ ] Tests: ping; good, wrong and missing signature; previous secret inside and outside 24 h; **mutation check** of the compare; oversized by header and by stream; rate limit happens before the body read (a fake limiter asserts it); each classifier branch incl. `on-hold` COD, non-COD, stale completion, whitelist keys only; insert failure → 500; duplicate delivery stores once.

### Task 4: Bindings, rotation route, card section (flow toggles hidden)

**Files:** the authenticated agent-config function that owns connector saves (`_shared/agentConfigOps.ts` plus its route) gains `create_store_webhook_binding {social_account_id, connector_id}` and `rotate_store_webhook_secret {binding_id}`. Both require the caller to own the account and the connector with the same checks as existing connector operations (workspace scope included), the account on `whatsapp`, and the connector `woocommerce`. Creation also creates the first secret. Rotation: 32 random bytes → base64url → `create_store_webhook_secret` → update the binding (`previous_secret_id = secret_id`, `secret_id = new`, `rotated_at = now()`) → return the secret once. Frontend: `src/components/messaging/agent-settings/ProceduresCard.tsx` gets a store-events section (WhatsApp account with a WooCommerce connector): the URL, the three topics (Order created, Order updated, Product updated), a Generate/Rotate button that shows the secret once with a copy button, and the text "If WooCommerce shows the webhook as disabled, re-enable it." i18n in en and ar.
- [ ] Tests: ownership and workspace refusals; non-woocommerce refused; the secret is 43 characters; the previous id moves; vitest for the section and the one-time secret display.

### Task 5: Opt-out and template-button ingest

**Files:** create `_shared/optOut.ts` (+ test); modify `whatsapp-webhook/index.ts` (after the inbound row is stored and **before** the n8n dispatch near line 551 and before auto-replies; add the `type: "button"` branch near line 296 with text = `button.text`, keeping `button.payload` in metadata) and `whatsapp-evolution-webhook/index.ts` (after the row is stored, before dispatch).

**Produces:**
```ts
export function isOptOutMessage(text: string): boolean;
export async function recordOptOut(db: OptOutDb, input: { userId: string; socialAccountId: string; phone: string; conversationId: string }): Promise<boolean>; // upsert the opt-out; set that account+phone's pending/claimed store_events to skipped('opted_out'); clear an event-origin procedure_state with a CAS; on error write a system_logs warning and return false
```
Phrases (whole trimmed message, case-insensitive, Arabic alef/hamza normalised): stop, unsubscribe, stop messaging, don't message me, dont message me, توقف, إلغاء الاشتراك, الغاء الاشتراك, لا ترسل.
- [ ] Tests: phrase table (`please stop sending` → false); side effects through a fake db; the error path logs and returns false; webhook tests: a `button` message yields text "Confirm"; the opt-out is recorded before dispatch (ordering asserted with a fake).

### Task 6: Engine additions (no sending)

**Files:** `_shared/procedures/templates.ts`, `engine.ts`, `config.ts` and tests; `ai-agent-reply/logic.ts` (`jevStartKey`), `procedureRuntime.ts`; `src/lib/procedureTemplates.ts`; `src/components/messaging/agent-settings/ProceduresCard.tsx`.

**Produces:**
- `PROCEDURE_KEYS` gains `cod_confirm`, `review_request`, `back_in_stock`; `EVENT_PROCEDURE_KEYS` lists them. `ProcedureField.when?: (fields: Record<string, string>) => boolean`. Fields: `cod_confirm.decision` (confirm|cancel from confirm/yes/نعم/تأكيد and cancel/no/لا/إلغاء); `review_request.rating` (1–5, Arabic-Indic digits accepted) and `review_request.problem` (`when: f => Number(f.rating) <= 3`, text up to 500); `back_in_stock.interest` (yes|no incl. Arabic). End actions `cod_update`, `review_route`, `stock_offer` throw `not_available` in PR 1.
- `ProcedureState.phase?: "pending_opener" | "active"`; `isStoredState` accepts it; `createProcedureTurn` treats a `pending_opener` state as no state (no tools, no submit, never overwritten).
- `staleAfterMs(origin)`: event 72 h, others 24 h; `expireIfStale` uses it.
- `jevStartKey` never returns, and `start_procedure` never accepts, an event key.
- Strict `parseProcedureConfig` rejects event keys in PR 1; the lenient read drops them. The card filters `EVENT_PROCEDURE_KEYS`; `FLOW_NAMES` stays exhaustive.
- [ ] Tests: rating 4 completes without `problem`, rating 2 requires it; validator table incl. Arabic; 71 h event state kept, 73 h dropped, 25 h model state dropped; `start_procedure` with `cod_confirm` refused; a `pending_opener` state is inert; the strict parser rejects event keys; vitest mirror parity and the card shows no event toggles.

**PR 1 Deno gate paths:** `_shared/ ai-agent-reply/ ai-agent-adapters/ store-webhook/ whatsapp-webhook/ whatsapp-evolution-webhook/`.

**PR 1 exit:** guards (clean-code, test, and a security pass on `store-webhook`), gates, PR, CI and Codex bot, migration live, merge, deploy verified (ping → 200, unsigned JSON → 401, unknown binding → 404).

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


## Codex debate verdicts (astra 6 medium, 23 findings, REWORK)

PR 2 tasks are amended by spec §8 items 2–5, 9–10 and 12–16 (fenced claim, `sending` intent, `pending_opener` → `active`, re-read before opener, `get_product`, `reserve_qr_opener`, `eventFor(runId)` port, QR and consent acknowledgements in the card, COD note-first order, Graph name-filtered templates, signed live test). Wiring to enumerate in PR 2: `config.ts` fields (delay, link, attestation, QR acknowledgement), `connectorRegistry.ts` capabilities (`update_order` write, `get_product` read), `dispatcher.ts` allowing non-GET only for `update_order` when not read-only.

| # | Finding | Ruling |
|---|---|---|
| 1 | Event toggles leak through the real card path | Accepted — card filter and strict parser rejects in PR 1 |
| 2 | Same owner is insufficient | Accepted — `store_webhook_bindings` with composite FKs |
| 3 | No trusted order binding | Accepted — `eventFor(runId)` port; nothing taken from state or model |
| 4 | Replay after purge; headers unsigned | Accepted — tombstones; re-read before opener |
| 5 | DoS bypasses | Reduced — IP limit before body, length and stream cap, connector quota after signature; limiter fail-open kept (repo convention) |
| 6 | WooCommerce does not retry | Accepted — 200 only after insert; monitoring deferred |
| 7 | Phone normalization | Accepted — strict new parser; legacy API untouched |
| 8 | Secret rotation race | Accepted — separate vault row per binding, previous secret for 24 h |
| 9 | Consent | Reduced — owner attestation and waitlist chat opt-in record |
| 10 | Opt-out gaps | Reduced — before n8n dispatch, fixed phrases, logged failures, pending events skipped |
| 11 | QR proactive messaging | **Kept (user decision C)** with owner risk acknowledgement and an atomic cap |
| 12 | Duplicate send after a crash | Accepted — `sending` intent; indeterminate outcomes never resent |
| 13 | Lease and cap concurrency | Accepted — claim token, 40 s budget, `reserve_qr_opener`; competing-worker integration test deferred |
| 14 | State before opener | Accepted — `phase: pending_opener` |
| 15 | COD cancel race | **Kept (user decision A)** — note first, re-read, stated window |
| 16 | Timing and eligibility | Accepted — re-read, `date_completed` anchor, statuses incl. on-hold |
| 17 | Variation stock | Accepted — exact `get_product` re-read |
| 18 | Waitlist identity | Accepted — `connector_id`, delete on notify |
| 19 | Button replies | Ingest accepted (PR 1); stale-button correlation deferred |
| 20 | Template reuse | Reduced — Graph name filter; match name, language and category |
| 21 | Missing wiring | Accepted — enumerated above for PR 2 |
| 22 | Dry run could send | Accepted — signed test body to the admin's own phone |
| 23 | Validation gaps | Reduced — real RLS SQL tests; corrected gate paths |

Deferred to an issue: competing-worker integration test (#13), stale-button correlation (#19), disabled-webhook monitoring (#6).
