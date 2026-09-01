# D13 — the dispatch state machine, and the reconciliation verdict

**Date:** 2026-09-01 · **Owner:** Partner API programme · **Deliverable:** Phase 3.1
**Status:** settled — **proceed to 3.2, with one empirical gate that must pass before any send
route opens**

**Supersedes nothing.** Refines D13 (R2, R3) with a mechanism the spec did not have when it was
written.

---

## 1. The verdict, first

The spec's premise — that WhatsApp Cloud "exposes no client-side lookup", which is what makes
`indeterminate` permanently terminal — is **out of date in one specific and useful way.**

**A reconciliation channel exists.** Meta's status webhook reference documents
`biz_opaque_callback_data` in the `statuses` object:

> *"String assigned by the business to the `biz_opaque_callback_data` property in the send message
> request. Only included if the business set a `biz_opaque_callback_data` value when sending the
> message."*

That is a **client-supplied correlator echoed back on delivery status**. It is not a lookup
endpoint — Postora cannot ask "did message X send?" — but it is the half that matters: Meta
volunteers the answer for messages it accepted.

**What has NOT changed:** there is **no idempotency key, no deduplication token, and no
client-supplied request id that stops Meta delivering a second message** on a repeated request.
Nothing in Meta's messages reference documents one. (Third-party blogs assert an `Idempotency-Key`
header works; no Meta documentation supports that, and it must not be relied on.) **So the
at-most-once decision in D13 R2 stands unchanged.**

### The one thing not yet verified, and it gates the phase

Meta's changelog describes `biz_opaque_callback_data` as added **"to free-form messages"**. Phase 3
sends **templates**. Whether the field is accepted on — and echoed back for — a `type: template`
send is **not confirmed by documentation**, and Postora cannot confirm it from its own traffic
because the field appears nowhere in this repository and there is no active WABA to test against.

**This is the empirical gate.** One real template send, with the field set, observed through to a
status webhook carrying it back. Until that passes, the reconciliation channel is a design
assumption, not a fact — and the fallback below is what applies.

---

## 2. The state machine

`partner_dispatch_intents` — a new table, one row per attempted provider call.

| State | Meaning | Durable before entering |
|---|---|---|
| `intended` | a provider call is **about to be issued** | the intent row, with its `intent_id`, before any HTTP |
| `sent` | the provider accepted; `wamid` known | the provider's 2xx response |
| `failed` | the provider **rejected**; nothing was delivered | a typed provider error |
| `indeterminate` | the outcome is unknown and **no evidence has resolved it** | reached only by takeover, never written by the original attempt |
| `reconciled_sent` | a status webhook carried this `intent_id` back | the webhook |

### Transitions

| From | To | Actor | Trigger |
|---|---|---|---|
| — | `intended` | handler | before the fetch; **this write must commit before the HTTP call is made** |
| `intended` | `sent` | handler | 2xx with a `wamid` |
| `intended` | `failed` | handler | a provider rejection that proves non-delivery |
| `intended` | `indeterminate` | **takeover** | a later attempt finds an `intended` row it does not own |
| `indeterminate` | `reconciled_sent` | webhook | a status arrives carrying this `intent_id` |
| `sent` | `reconciled_sent` | webhook | normal delivery reporting; no semantic change |

### The invariants — these are the deliverable

1. **A takeover that finds an `intended` row NEVER calls the provider.** It transitions the row to
   `indeterminate` and returns the typed `idempotency_indeterminate` to the caller. This is the
   whole point: the durable intent is the evidence that a call may already have gone out.
2. **`indeterminate` is not retryable and the API never advises retry on it.** Unchanged from
   D13 R3.
3. **Only a positive signal resolves an `indeterminate`.** A status webhook carrying the
   `intent_id` proves the send happened. **Silence proves nothing.**
4. **No transition leads from `indeterminate` to "safe to resend".** There is no such state, by
   construction, so no future edit can produce one by accident.
5. **`failed` requires proof of non-delivery**, not merely an error. A timeout, an aborted fetch or
   an unparseable body is `indeterminate`, never `failed`.

### The asymmetry, stated plainly because it is the safety property

Absence of a status webhook is **absence of evidence, not evidence of absence**. Webhooks are
delayed, dropped, retried and occasionally lost. A design that reads silence as "never sent, safe
to retry" reintroduces exactly the duplicate D13 exists to prevent — while looking like rigorous
reconciliation.

So the channel is **one-directional**: it can move a record from `indeterminate` to
`reconciled_sent`, and it can never move one toward re-dispatch.

### What reconciliation buys, and what it does not

It does **not** restore exactly-once — nothing can. It converts a subset of terminal
`indeterminate` records into *known-sent*, which:

- removes them from the operator escalation queue (D13 R3 requires each terminal `indeterminate`
  reach a human; this shrinks that queue to the genuinely unknown);
- recovers the `wamid`, so the message becomes visible in the inbox and to delivery reporting;
- leaves the remainder — no webhook after a conservative window — exactly as terminal as before.

**If the empirical gate fails** (the field is not honoured for templates), the design degrades
cleanly: every `indeterminate` stays terminal and escalates to a human, which is precisely D13 R3's
position today. Phase 3 can still ship on that basis. **The reconciliation is an improvement, not a
precondition.**

---

## 3. Why a separate table

Not a fourth state on `partner_api_idempotency`:

- **Lifetime.** `partner_api_idempotency.key_id` is `ON DELETE CASCADE`. A dispatch intent is
  *evidence that a real message may have reached a customer* and must outlive key rotation or
  deletion — the same reasoning that deliberately gave `partner_audit_logs` no FK on `key_id`, with
  a `FOR KEY SHARE` tenancy trigger instead.
- **Different guarantee.** The existing `attempt_token` fence protects *settles* — "only the
  current lease holder may write the result". The new invariant is "**a takeover that finds an
  intended row never calls the provider**". Overloading one column with two unrelated safety
  properties is how one of them gets weakened by someone servicing the other.
- **1.7 already expects it.** The tenancy matrix names "dispatch intents" as a table no phase has
  built. Building it closes another 1.7 row, with composite FKs and a negative database test.

---

## 4. What 3.2 must change in the send path

Verified against the current code:

- **`sendTemplate` in `_shared/whatsappPartnerOps.ts` builds its payload with no
  `biz_opaque_callback_data`.** Adding it is a one-line change to the payload object.
- **The intent row must be committed before `post()` is called**, not merely created in the same
  transaction as the call. This is the entire pre-call boundary.
- **`sendTemplate` already calls `post()` TWICE** on the auto-registration path (Meta error 133010
  / 100+33): register, then retry. That second call happens *inside* one dispatch attempt and is
  not a takeover — the state machine must treat the pair as one `intended` row, or the retry will
  look like a duplicate dispatch to its own bookkeeping.
- **`persistOutbound` writes the `whatsapp_messages` row only after a `wamid` is known**, so in the
  crash case no row exists — which is why today's status handler
  (`whatsapp-webhook/index.ts:615`, `.eq("message_id", wamid)`) matches nothing and cannot
  reconcile. The webhook must additionally look up dispatch intents by the echoed `intent_id`.

---

## 5. The exit gate

Unchanged and binary. Crash tests via the existing `Fetcher` seam
(`_shared/whatsappPartnerOps.ts:70`), injected **both** immediately before and immediately after
the provider invocation, then a retry with the same `Idempotency-Key`:

- **Pass** — zero second provider calls in both cases, and a never-dispatched intent resolves
  cleanly. Sending may ship.
- **Fail** — `POST /v1/messages` does not ship and **every public send route stays closed,
  including the alias**.

Plus, for the reconciliation half specifically: **one real template send observed end to end with
`biz_opaque_callback_data` echoed back.** If that fails, ship §2's fallback — all
`indeterminate` terminal — and record the negative result here.

`SEND_TEMPLATE_SUSPENDED` in `partner-api/router.ts` names its restoration condition as exactly
this gate. **This document does not authorise flipping it.** Restoration is a separate, explicit
decision after the gate passes.

---

## 6. What would change this decision

- Meta shipping a genuine idempotency key on `/messages` — that would make exactly-once reachable
  and this whole design an unnecessary detour.
- Meta shipping a lookup-by-client-reference endpoint — that would let Postora *ask*, rather than
  wait, and would let a proven-not-sent record become safely retryable.
- A per-key at-least-once opt-in, which D13 R3 names as a recognised future option explicitly out
  of v1 scope. It would need its own decision record; it must not be added by extending this one.

## 7. Sources

- Meta, *Status messages webhook reference* — the `biz_opaque_callback_data` field and its
  "only included if the business set it" condition.
- Meta, *Messages* (Cloud API reference) — no documented idempotency key, dedup token or
  client-reference lookup.
- Meta, *Changelog* — `biz_opaque_callback_data` introduced for free-form messages; template
  coverage **not** established, which is why §1 makes it an empirical gate rather than an
  assumption.
