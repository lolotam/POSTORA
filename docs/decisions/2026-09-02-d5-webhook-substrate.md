# D5 — the webhook substrate: occurrence identity, rotation, and what is *not* advertised

**Date:** 2026-09-02 · **Owner:** Partner API programme · **Deliverable:** Phase 5 (5.1–5.9)
**Status:** settled for the substrate; **two rows constrained rather than built**, flagged below

**Refines** D5 and D5(R1). **Advertises no event family** — that is P6/P8 by D6, and this
document is careful not to leak an implicit promise that it does.

---

## 0. The one thing to read if you read nothing else

The plan's exit criteria hinge on a term the spec never defined: **event occurrence ID**. Every
other decision here follows from pinning it, so it is first.

> An **occurrence** is one *transition*. It is not a resource, and it is not a delivery.

The distinction is not pedantry — v1.1 of the plan got the cardinality wrong in **both**
directions off the back of it, and the correction log says so:

| Naive reading | Why it is wrong |
|---|---|
| "one outbox row per source event" | One event matching **three** subscriptions must produce **three** rows. Deduplication is per subscription, because delivery is. |
| "the source id is the resource id" | `message.accepted`, `.delivered` and `.read` for one message share **one provider message ID**. Keyed on the resource, the second transition collides with the first and is silently dropped — the outbox would discard the very events it exists to guarantee. |

**Definition, as implemented.** `event_occurrence_id` is a producer-supplied string that is
deterministic for a transition and distinct across transitions:

```
<event_type>:<stable resource key>[:<discriminator>]
```

- `message.received:wamid.ABC` — one insert, one occurrence.
- `message.delivered:wamid.ABC` vs `message.read:wamid.ABC` — **the event type is part of the
  key**, which is the whole reason the collision above does not happen.
- `webhook.test:<uuid minted per request>` — a manual trigger has no natural resource, and two
  tests are genuinely two occurrences.

The uniqueness anchor is therefore `UNIQUE (webhook_id, event_occurrence_id)`.

**Renamed from the spec's `source_event_id`, deliberately.** The spec named the column before the
exit criteria redefined what it holds. Keeping a name that says *source event* for a value that
identifies a *transition* would preserve exactly the misreading the correction log records. The
column is `event_occurrence_id`; this paragraph is the rename's audit trail.

### `event_id` is not the same thing, and the difference is partner-visible

`event_id` (the `X-Postora-Event-Id` header, prefix `evt_`) is the **delivery row's own id**.
Because there is exactly one row per `(webhook, occurrence)`, a partner deduplicating on
`event_id` is deduplicating on occurrence *for their subscription* — which is the guarantee D5
publishes. It is immutable across retries: **delivery attempts repeat, the event id does not.**

Two subscriptions to the same URL receive two ids for one occurrence. That is correct — they are
two subscriptions, and collapsing them would make "delete one subscription" silently change what
the other receives.

---

## 1. Rotation (5.9): the secret is captured at enqueue, not read at send

An HMAC signing secret **cannot be hashed** the way `partner_api_keys.key_hash` is, and the
asymmetry is worth stating so nobody later "fixes" it: for an API key Postora is the *verifier*,
so a hash suffices; for a webhook Postora is the *signer*, so it must hold the secret itself. It
is displayed once at creation and once at rotation, and never returned by any read.

The delivery row captures `secret_version` **at enqueue**. This is the part that is easy to get
wrong. Sign at send time with "whatever the current secret is", and a rotation performed between
an event's enqueue and its 6-hour retry changes the signature of an event whose `event_id` is
immutable. The receiver sees one event id arrive under two different signatures and cannot tell
replay from rotation.

| Row holds | Signed with |
|---|---|
| The current version `n` | the current secret |
| Version `n-1`, inside the overlap | the previous secret |
| Version `n-1`, past the overlap | the current secret, and the row's `secret_version` is updated to `n` |

Overlap: **24 hours**. A full ladder run is 1m + 5m + 30m + 2h + 6h ≈ 8h 36m from the first
attempt, so 24h covers it with margin while still bounding how long a leaked secret stays live.
The last row is the honest edge: a secret cannot be kept forever, so past the overlap the
substrate prefers *delivering under a signature the partner can verify* over *failing delivery to
preserve a signature nobody holds any more*. The re-version is recorded on the row rather than
being silent.

Each rotation writes a `partner_audit_logs` entry — Phase 1 machinery, unchanged.

---

## 2. Redirects at delivery: followed, revalidated per hop, and bounded

`_shared/webhookSecurity.ts` already exists and already does what 5.6 asks — it revalidates the
target **on every hop**, not only the first, which is the omission that makes most SSRF guards
ornamental. It is reused rather than reimplemented. This phase adds **no third URL fetcher**; the
one change is an explicit hop budget, and n8n-api's existing callers keep their current default.

Two limits recorded rather than papered over:

- **DNS rebinding.** Validation is on the hostname; resolution happens inside `fetch`. A host
  that resolves public at validation and private at connect is not caught. This is the same known
  limit the n8n node's README documents for `safeFetchAndStage`, and closing it needs
  resolve-then-connect-to-a-pinned-IP, which Deno's `fetch` does not expose.
- **A partner pointing a webhook at a third party.** Deliberately allowed — that is what a
  webhook is.

**Hop budget of 2 at delivery**, against the helper's default of 5. Not a security argument —
per-hop validation is the security argument and it holds at either number. It is a *budget*
argument: each hop carries its own 10s timeout, so 5 hops is a 60s single delivery against a
**60s worker ceiling** that kills the isolate with no log row (the 2026-08-27 `ai-agent-reply`
finding). A delivery that can eat the whole tick is a delivery that can starve every other
subscription queued behind it.

---

## 3. Worker sizing (open item 4), decided as a default rather than blocked on

Item 4 of the plan's open items — "webhook delivery volume: worker cadence and concurrency
sizing" — has no measured answer available, because **zero partners are live**. Answering it with
a starting point plus the instrument needed to revise it is the only honest move:

| Knob | Value | Why |
|---|---|---|
| Cadence | **60s** | The ladder's finest step is 1m; a slower tick makes the first retry a lie. |
| Rows claimed per tick | **20** | Bounded by the budget below, not by appetite. |
| Concurrency | **5** | 20 rows × 10s serially is 200s against a 60s ceiling. Four waves of five fit. |
| Whole-tick budget | **45s** | The ceiling minus a settle-and-report reserve. Claiming stops when the remaining budget cannot cover another wave: a claim charges an attempt, and a row the deadline cut off pays for an attempt that never happened. |
| Lease | **90s** | Longer than a worst-case delivery, short enough that a killed worker's rows recover on the next tick. |
| Implied ceiling | **~1,200 deliveries/hour** | Written down so the first partner who exceeds it is a known event rather than a mystery backlog. |

`partner_webhook_backlog()` is the instrument: depth, oldest-pending age, stuck-lease count.
Revisiting the table above without it would be guesswork.

---

## 4. What is constrained rather than built (the 5.4 rows)

Same move as the D10 malware row, flagged the same way: **Postora has no alerting stack.** There
is nothing to page, no on-call rotation, no metrics sink. Inventing one inside a Partner API phase
would be scope theft, and claiming "stuck-lease alerting" without one would be the untrue claim
the working agreement's §6.6 exists to forbid.

| 5.4 row | Status |
|---|---|
| Scheduling and runtime ownership | **Built** — cron-invoked function, `verifyCronAuth`, the same shape as `process-pending-replies`. |
| Backlog and age metrics | **Built** — `partner_webhook_backlog()`, service-role. |
| Stuck-lease alerting | **Constrained.** The metric exists and the worker writes a `system_logs` row when backlog age crosses a threshold. Routing that to a human is ops work, not a function. |
| Redrive / replay tooling | **Built** — `redrive_partner_webhook_deliveries()`, service-role, refuses any row that is not exhausted. |
| Deployment verification | **Built** — runbook section. |

---

## 5. What this phase does **not** advertise

D6 is explicit that an event ships only when its transition, stable identifier and *transactional*
producer are all defined, and D5(R1) is explicit that an outbox without transactional producers
still loses events. So:

**The only event this phase certifies is `webhook.test`** — certifiable precisely because it has
no external producer. Its transition is "a partner asked", its occurrence id is minted at request
time, and its enqueue is the request's own transaction. There is nothing to crash between.

`partner_webhooks.events` accepts only names on a **closed allowlist**, and this phase's allowlist
has one entry. A subscription for `message.received` cannot be created before Phase 6 certifies
it. That is the mechanism which stops the substrate becoming an implicit promise: a partner cannot
subscribe to an event Postora does not produce, so nobody can build against one and discover later
that it never fires.

The producer-write inventory 5.8 requires precedes that certification and is a separate document:
`docs/decisions/2026-09-02-webhook-producer-ledger.md`.
