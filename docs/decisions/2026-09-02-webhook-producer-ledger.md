# The webhook producer ledger, and the database-write inventory behind it

**Date:** 2026-09-02 · **Owner:** Partner API programme · **Deliverable:** Phase 5.8
**Status:** inventory complete; **one row of D6's producer table is wrong** and is corrected here

**Companion to** `docs/decisions/2026-09-02-d5-webhook-substrate.md`.

---

## 0. Why this document exists, and what it found

5.8 says a ledger row is per **(event type, writer path)** — not per event — because the same
transition can be committed by several paths, and certifying one of them proves nothing about the
others. It requires a database-write inventory *first*.

The inventory found exactly the thing that phrasing was written to catch:

> **D6 names `check-connection-health` as the producer of `account.reauthorization_required`.
> That function writes nothing.**

It is 232 lines with a single database access — a `SELECT` from `social_accounts` at
`check-connection-health/index.ts:154`. There is no `.update(`, no `.insert(`, no `.upsert(` in
the file. It is a read-only reporter that *computes* health for the UI; it has never committed the
transition it is credited with.

Phase 6 would have certified a producer that does not produce. The event would have been
advertised, the ledger row would have been ticked, and the event would simply never have fired —
and because nothing else writes that column on that path, no test built around
`check-connection-health` could have noticed.

The real producer is one line elsewhere. Which is good news, and it is only visible because the
inventory came before the certification.

---

## 1. The inventory

Counted on `main` at 2026-09-02, excluding `*.test.ts`. Each row is reproducible with the grep
beside it, so a reader can re-derive it rather than trust it.

### `account.reauthorization_required` — the transition is `needs_reauth` false → true

| | |
|---|---|
| Paths that set it **true** | **1** — `refresh-tokens/index.ts:355` |
| Paths that set it **false** | **24 sites across 13 functions** |
| `check-connection-health` | **0 writes** |

```
grep -rn "needs_reauth" --include=*.ts supabase/functions/ | grep -v '\.test\.'
```

One producer is a *good* result: it means this event is certifiable with one transactional
enqueue rather than thirteen. It is also the opposite of what D6 assumed, and the asymmetry is
the interesting part — **setting** the flag is centralised in the refresh path, while **clearing**
it is scattered across every OAuth callback:

```
bluesky 2 · facebook 3 · instagram-business 1 · instagram 1 · linkedin 2 · pinterest 3
reddit 1 · refresh-tokens 1 · threads 1 · tiktok 3 · twitter 3 · whatsapp 1 · youtube 2
```

That matters for `account.connected`, below, and it is consistent with the 2026-08-30 finding
that only `handleRefreshSuccess` may clear the health columns.

### `account.connected` / `.disconnected` — activation transitions

| | |
|---|---|
| Files carrying an `is_active: true` literal | **16** — every OAuth callback plus `_shared/evolutionQrAccount.ts`, `_shared/whatsappDisconnect.ts`, `n8n-api`, `higgsfield-oauth` |
| Files setting `is_active: false` | **4** — `_shared/whatsappDisconnect.ts`, `_shared/evolutionQrAccount.ts`, `whatsapp-evolution-bridge/index.ts`, `higgsfield-oauth/index.ts` |

**Deliberately stated as candidates, not as producers.** Some of those 16 are write payloads and
some are query filters, and separating them needs each call site read rather than grepped — the
literal sits many lines from its `.insert(`/`.update(`, so no pattern decides it. Resolving the
exact set is Phase 6's first task, and this row exists to say that it is *unresolved* rather than
to guess a number.

What the count already settles is the only thing Phase 5 needs from it: this transition has
**many independent commit points**, so "enqueue transactionally at every producer" is a sentence
here, not a checklist. The finding that the UI had wired only *one* of the two WhatsApp disconnect
paths is the same shape of defect one level down.

### `message.received` / `message.accepted` — the `whatsapp_messages` insert

**16 write sites across 11 files.** The direction column, not the file, is what separates the two
events — and `whatsapp-webhook/index.ts` alone writes **both**:

| Site | Direction |
|---|---|
| `whatsapp-webhook/index.ts:451` | `inbound` |
| `whatsapp-webhook/index.ts:765` | `isInbound ? "inbound" : "outbound"` — **either**, per row, inside one bulk upsert |
| `whatsapp-webhook/index.ts:809` | `outbound` |
| `whatsapp-webhook/index.ts:1017` | `outbound` |
| `whatsapp-evolution-webhook/index.ts:123` | QR-mode inbound upsert |
| `_shared/messageSend.ts:145`, `_shared/whatsappPartnerOps.ts:430`, `_shared/whatsappVoiceSend.ts:146` | outbound |
| `messaging-api/index.ts` ×3, `whatsapp-broadcast:170`, `whatsapp-scheduled-sender:116`, `ecommerce-whatsapp-api:392`, `ai-agent-reply:645` | outbound |

The row at 765 is the one to notice: a **single statement** that commits either transition
depending on a per-row boolean. A producer hook attached to "the inbound webhook" would fire for
outbound rows too, and one attached to a file would have to branch inside a bulk upsert.

### `post.published` / `.failed` — Phase 8, inventoried now because it is cheap to

`platform_posts` is written by **3 functions**: `process-post/index.ts`,
`send-weekly-analytics/index.ts`, `threads-delete-post/index.ts`. D9's publishing seam is the
right place to resolve this; it is recorded here so Phase 8 starts from a count rather than an
assumption.

---

## 2. The ledger

One row per **(event type, writer path)**. Only a row that is complete in every column may be
advertised.

| Event | Transition | Writer path | Occurrence ID | Transaction mechanism | Crash test | Advertised |
|---|---|---|---|---|---|---|
| `webhook.test` | A partner asked | `partner-api/v1/webhooks.ts` → `enqueuePartnerWebhookEvent` | `webhook.test:<uuid>` minted per request | **The enqueue IS the transition.** There is no state change to crash between — which is exactly why this is the one event Phase 5 can certify | Not required: no window exists | ✅ **Yes** |
| `account.reauthorization_required` | `needs_reauth` false → true | `refresh-tokens/index.ts:355` | `account.reauthorization_required:<account_id>:<transition timestamp>` | ❌ **Not built.** Needs a SECURITY DEFINER function that flips the flag and enqueues in one statement | ❌ | ❌ No |
| `account.connected` | `is_active` → true | **Unresolved — 16 candidate files** (see above) | — | ❌ Not built | ❌ | ❌ No |
| `account.disconnected` | `is_active` → false | **4 paths** | — | ❌ Not built | ❌ | ❌ No |
| `message.received` | Inbound row committed | `whatsapp-webhook:451`, `:765` (inbound rows), `whatsapp-evolution-webhook:123` | `message.received:<provider message id>` | ❌ Not built | ❌ | ❌ No |
| `message.accepted` | Provider accepted a send | **12 outbound sites** | `message.accepted:<wamid>` | ❌ Not built | ❌ | ❌ No |
| `message.delivered` / `.read` / `.failed` | Provider status callback | `whatsapp-webhook` status handler | `<event_type>:<wamid>` — **the type is part of the key**, or the three collide on one provider id | ❌ Not built | ❌ | ❌ No |
| `post.published` / `.failed` | Terminal `platform_posts` status | 3 functions; needs the D9 seam | — | ❌ Not built | ❌ | ❌ No |

**Every "no" is enforced, not merely intended.** `partner_webhooks.events` carries a CHECK
constraint listing the certified events, and `CERTIFIED_EVENT_TYPES` carries the same list in
TypeScript. A partner cannot subscribe to a row that is not complete above, so an uncertified
event cannot be built against and later discovered never to fire.

---

## 3. What Phase 6 has to build, now that the shape is known

Two things the inventory makes concrete:

1. **A transactional enqueue primitive.** supabase-js cannot run a multi-statement transaction, so
   "enqueue in the same transaction as the state change" cannot be expressed by two client calls —
   the crash gap between them is precisely the gap the outbox exists to close. It needs a
   `SECURITY DEFINER` function per transition that performs the state change *and* the fan-out in
   one statement. `enqueuePartnerWebhookEvent` (the TypeScript fan-out shipped in Phase 5) is
   correct for `webhook.test`, whose enqueue is its own transition, and is **not** sufficient for
   any row above it.

2. **Per-path certification, not per-file.** `whatsapp-webhook/index.ts:765` decides direction per
   row inside one bulk upsert. A ledger row that said "the inbound webhook" would be true of a
   file and false of a statement.

3. **Finish the activation inventory by reading the call sites**, not by grepping them. It is the
   one row above where this document stops at candidates, and it stops there on purpose.

---

## 4. Corrections this document makes to the spec

| Where | Said | Actually |
|---|---|---|
| D6 producer table | `account.reauthorization_required` is produced by `check-connection-health` | That function performs one `SELECT` and no writes. The producer is `refresh-tokens/index.ts:355` |
| D6 producer table | `account.connected` / `.disconnected` produced by "OAuth callbacks" | Incomplete: deactivation happens in 4 files, and **two of them are not OAuth callbacks at all** — `_shared/whatsappDisconnect.ts` and `whatsapp-evolution-bridge/index.ts`. The activation set is larger than the OAuth callbacks and is not yet resolved |
| Plan 5.2 | `UNIQUE (webhook_id, source_event_id)` | Renamed `event_occurrence_id`; see §0 of the substrate record for why the name mattered |
