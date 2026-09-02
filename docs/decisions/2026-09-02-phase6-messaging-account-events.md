# Phase 6 — messaging and account events: what was certified, and how

**Date:** 2026-09-02 · **Owner:** Partner API programme · **Deliverable:** Phase 6 (6.1–6.6)
**Status:** shipped for five event families; **account.connected / .disconnected deliberately not certified** — see §5

**Builds on** `2026-09-02-d5-webhook-substrate.md` (the substrate) and
`2026-09-02-webhook-producer-ledger.md` (the inventory). **Migration:**
`20260902130000_partner_webhook_phase6_events.sql`. **SQL proof:**
`supabase/tests/partner_webhook_phase6_events.sql`.

---

## 0. The mechanism, once

D5(R1) requires every producer to **enqueue in the same transaction as the state
change it reports**. supabase-js cannot express that as two client calls — the
crash gap between them is the gap the outbox exists to close — so Phase 6's
producers are `SECURITY DEFINER` SQL functions that perform the state change
*and* the fan-out in **one statement**:

```
partner_emit_webhook_event(...)          -- the fan-out, written ONCE in SQL
  ├─ partner_upsert_whatsapp_message     -- 6.1  message.received (single row)
  ├─ partner_import_whatsapp_message_batch -- 6.1  message.received (history bulk)
  ├─ partner_apply_whatsapp_message_status -- 6.3  message.delivered/.read/.failed
  ├─ partner_settle_dispatch_intent_sent   -- 6.2  message.accepted (the settle)
  ├─ partner_reconcile_dispatch_intent_sent-- 6.2  message.accepted (the echo)
  └─ partner_record_refresh_failure        -- 6.4  account.reauthorization_required
```

`partner_emit_webhook_event` mirrors the TypeScript fan-out
(`enqueuePartnerWebhookEvent`) rule for rule: same workspace, `is_active`,
`events` contains the type, a NULL platform/account filter matches everything
while a set one must equal, one row per matching subscription with
`ON CONFLICT (webhook_id, event_occurrence_id) DO NOTHING`, and
`secret_version` captured **at enqueue**. The two implementations must not
drift; the SQL suite asserts the matching rules against real rows, and the Deno
suite against the stub.

A Postgres function call is atomic, which is the whole argument: it commits or
rolls back as a unit, so "the process died between the write and the enqueue"
is **unrepresentable**, not merely unlikely. The crash test in the SQL suite
proves **both** directions per event — a committed state change carries its
delivery row, and a rolled-back state change leaves no delivery row — using
plpgsql subtransaction rollbacks.

The allowlist was widened in the **two** places that must always agree, as two
deliberate acts: the `partner_webhooks.events` CHECK constraint (now
`partner_webhooks_events_certified`) and `CERTIFIED_EVENT_TYPES` in
`_shared/partnerWebhookEvents.ts`.

---

## 1. `message.received` (6.1)

| | |
|---|---|
| Occurrence id | `message.received:<provider message id>` |
| Producers | `partner_upsert_whatsapp_message` (called by `whatsapp-webhook`'s live inbound persist, formerly :451, and by `whatsapp-evolution-webhook`'s persist, formerly :123) · `partner_import_whatsapp_message_batch` (the history bulk upsert, formerly :765) |
| Transition | a `whatsapp_messages` row with `direction='inbound'` **actually inserted** |
| Transaction | the insert (with the `(user_id, message_id)` conflict absorbing Meta redeliveries) and the fan-out are one statement; a duplicate inserts nothing and emits nothing |

**The :765 trap, handled structurally.** The history bulk upsert commits rows
of *either* direction depending on a per-row boolean, and the Evolution persist
writes owner-sent echoes through the same statement as inbound messages. Both
functions therefore gate the emit on `was inserted AND direction = 'inbound'`,
not on "the statement ran" — an outbound row through the same producer emits
ZERO events, and the SQL suite asserts exactly that (a hook on "the file" or
"the webhook" would have reported outbound traffic as received).

**Payload** (`data` of the delivery envelope): `account_id` (`acc_`-prefixed),
`platform`, and a `message` object (`id`, `direction`, `from_phone`,
`from_name`, `to_phone`, `type`, `text`, `media_url`, `media_type`,
`timestamp`). The raw `wa_<business>_<msisdn>` conversation key is deliberately
**absent**: `/v1`'s id policy (see `partner-api/v1/ids.ts`) keeps that text key
server-side because it embeds a customer MSISDN. Partners correlate by
`(account_id, from_phone)`, which the payload carries.

**Latency:** near-real-time — webhook-sourced, enqueued at ingest.

---

## 2. `message.accepted` (6.2)

| | |
|---|---|
| Occurrence id | `message.accepted:<wamid>` |
| Producers | `partner_settle_dispatch_intent_sent` (`intended → sent`, the handler settle — this is what `markIntentSent` calls now) · `partner_reconcile_dispatch_intent_sent` (the `biz_opaque_callback_data` echo reconcile) |
| Transition | the D13 dispatch intent recording a **proven provider acceptance** |
| Transaction | the intent CAS and the fan-out are one statement |

**The D13 seam is the correct single seam for partner-originated sends**, and
Phase 6 uses it rather than any of the twelve `whatsapp_messages` outbound
writers. Two properties make it right: the intent row is the one record that
exists *before* the provider call (D13's whole point), and its state machine
has exactly two writes that prove acceptance — the settle and the echo
reconcile. Both emit the **same occurrence id**, so:

- a send that settled and was later echo-reconciled emits once (the anchor
  absorbs the second insert — asserted in the SQL suite);
- a send whose attempt **crashed after the provider call** (row left
  `intended`, partner answered 409 indeterminate) gets its `message.accepted`
  from the echo — the D13 escalation path resolving itself into an event.

**Scope, stated honestly: Partner-API-originated sends only.** D6's producer
table names "the Partner API send path" and that is what is certified. The
other eleven outbound writers (the UI send path via `_shared/messageSend.ts`,
`whatsapp-broadcast`, `whatsapp-scheduled-sender`, `ecommerce-whatsapp-api`,
`ai-agent-reply`, `messaging-api`, the auto-reply insert, the echo mirror, the
voice path, `whatsappPartnerOps.persistOutbound` when called outside dispatch)
do **not** produce this event. Wiring each with a bespoke transactional enqueue
is the same shape of problem as the activation inventory (§5) and is not
attempted here; if partners need accepted-events for UI-originated sends, the
answer is the same trigger discussion, not eleven hand-wired functions. The
OpenAPI document says this in the event's description.

**Latency:** near-real-time at the settle; an echo-reconciled event arrives
when the provider's first status callback for the message does.

---

## 3. `message.delivered` / `.read` / `.failed` (6.3)

| | |
|---|---|
| Occurrence id | `message.<status>:<wamid>` — **the event type is part of the key** |
| Producers | `partner_apply_whatsapp_message_status` (the status UPDATE in `whatsapp-webhook`'s handler, formerly :665) |
| Transition | a provider status callback moving a `whatsapp_messages` row |
| Transaction | the status UPDATE and the fan-out are one statement; the handler's failed-preview write to `messaging_cache` stays in TypeScript (UI polish, not the transition) |

The occurrence-id shape is the one design point the substrate record
singled out: `delivered`, `read` and `failed` for ONE message share one wamid,
and keyed on the resource alone the second and third transitions would collide
with the first and be **silently dropped** — the outbox discarding exactly the
events it exists to guarantee. The SQL suite walks one wamid through all three
and asserts three distinct rows per subscription.

A `sent` status callback is **not** an event: D6(R1) renamed `message.sent` to
`message.accepted` precisely because "sent" overstates what a status echo
knows, and the certified `message.accepted` producer is the D13 settle.

**WhatsApp Cloud only; unavailable in Evolution QR mode.** Evolution QR
accounts do not route provider statuses through the Cloud webhook handler, so
these three events never fire for them. Documented per-event in the OpenAPI
document — not under a single "real-time" heading — because a QR-mode partner
subscribing to `message.delivered` must be told at subscription time that the
event is structurally absent for their account mode.

**Latency:** near-real-time — provider-callback-sourced, enqueued at ingest.

---

## 4. `account.reauthorization_required` (6.4)

| | |
|---|---|
| Occurrence id | `account.reauthorization_required:<account_id>:<epoch_us>` |
| Producer | `partner_record_refresh_failure` — the ONE writer the ledger pinned (`refresh-tokens`' `handleRefreshFailure`, the update formerly at :362) |
| Transition | `needs_reauth` **false → true** (guarded on the previous value) |
| Transaction | the whole failure-record write (failure_count, last_refresh_error, alert timestamp, and the escalation) and the fan-out are one statement |

**The occurrence id's timestamp is load-bearing.** An account can be flipped,
repaired by an OAuth callback, and flipped **again** — without a transition
discriminator the second flip would collide with the first and be silently
dropped. The SQL suite proves the sequence: flip → repair → flip produces two
**distinct** occurrences for the same account.

The escalation guard also makes the cron crash-retry safe: re-recording the
same failure against an already-flagged account is not a transition and emits
nothing — a cron retry after a worker death cannot double-fire the event.

D6 credited this event to `check-connection-health`; the ledger corrected that
(the function performs one SELECT and no writes) and Phase 6 certified the real
writer. The event fans out on the account's own platform, so a subscription
filtered to `platform: whatsapp` receives WhatsApp reauths, and an unfiltered
subscription receives every platform's — including e.g. Facebook accounts,
which have their own refresh path through the same writer.

**Latency:** bounded by the refresh cron's cadence — this is a
**poller-equivalent** event, not a webhook-sourced one, and the OpenAPI
document says so. It is the one Phase 6 event that is *not* near-real-time.

---

## 5. What was NOT certified: `account.connected` / `.disconnected`

The activation inventory is now **resolved** (recorded in the ledger, §1
updated): every `is_active` literal site was read, not grepped.

- **Activation (`is_active` → true): 24 genuine commit points across 15
  files** — twelve OAuth callbacks (several with separate connect and
  reconnect statements: facebook ×3, pinterest ×2, tiktok ×2, twitter ×2,
  whatsapp ×2, bluesky ×2, instagram ×2, linkedin, reddit, threads, youtube),
  the WhatsApp reconnect in `_shared/whatsappDisconnect.ts`,
  `_shared/evolutionQrAccount.ts`, **plus three branches inside the
  `activate_evolution_qr_account()` SQL RPC**. Two of the ledger's 16 candidate
  files are not activation writers at all: `higgsfield-oauth` writes
  `ai_models`, and `n8n-api`'s `is_active: true` is an `app_settings` webhook
  value. `whatsapp-evolution-bridge` inserts its provisional row
  `is_active: false` — a born-inactive row, not a disconnection.
- **Deactivation (`is_active` → false): 3 genuine commit points** —
  `_shared/whatsappDisconnect.ts` (the mandatory deactivation),
  `_shared/evolutionQrAccount.ts` (Evolution `close`), and the duplicate-row
  retirement inside the activation RPC.

Wiring each of those 24 statements with a bespoke transactional enqueue would
mean 21 RPC wrappers around payloads that differ per provider (tokens, metadata,
avatars) — and the certification would rot the moment a new OAuth callback
lands without its enqueue. That is the defect class the ledger exists to
catch, reproduced on day one by construction.

**The correct mechanism is a database trigger** on the
`is_active IS DISTINCT FROM` transition of `social_accounts` (INSERT with
`is_active` true → `account.connected`; UPDATE either direction → the matching
event), calling `partner_emit_webhook_event`. A trigger is transactional **by
construction** — whatever writer commits the transition fires it in the same
transaction, including writers that do not exist yet — and it turns the
24-commit-point problem into one mechanism with one crash test.

This is **proposed, not built**. A trigger on `social_accounts` changes the
behaviour of every writer to a hot production table, and that deserves its own
change with its own review, not a rider on Phase 6. Until it exists,
`account.connected` and `account.disconnected` stay off both allowlists — the
gate working as designed. (One design note for whoever builds it: the trigger
must resolve legacy accounts' workspace via the personal-workspace fallback —
the same resolution `partner_workspace_of_account()` already implements — and
must skip `retired_`/`pending_` placeholder rows, which are lifecycle
bookkeeping, not partner-visible activations.)

---

## 6. Per-event latency (6.5), as published

Published per event in the OpenAPI document, never under one heading:

| Event | Source | Latency |
|---|---|---|
| `message.received` | Meta / Evolution webhook | near-real-time |
| `message.accepted` | the D13 settle | near-real-time; an echo-reconciled send reports at the first status callback |
| `message.delivered` / `.read` / `.failed` | Meta status callback | near-real-time; **unavailable in Evolution QR mode** |
| `account.reauthorization_required` | the refresh cron | **bounded by cron cadence** — not real-time |

---

## 7. Corrections this phase makes to the spec

| Where | Said | Actually |
|---|---|---|
| D6 producer table | `message.accepted` produced by "the Partner API send path" | Certified exactly so — but the ledger's "12 outbound sites" are NOT producers; this record makes the scoping explicit so nobody later "completes" the certification by wiring the UI send path by hand |
| D6 producer table | `message.delivered`/`.read`/`.failed` produced by "Meta status webhook" | Confirmed, and the occurrence id `<event_type>:<wamid>` is now load-bearing in SQL, not just a convention in a document |
| Plan 6.5 | "per-event latency documentation" | `account.reauthorization_required` is the one polled event among the five; the OpenAPI document marks it bounded-by-cron |
