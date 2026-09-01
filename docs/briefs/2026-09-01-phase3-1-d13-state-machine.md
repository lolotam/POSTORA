# Brief — Phase 3.1: settle the D13 dispatch state machine

**Date:** 2026-09-01 · **Deliverable:** 3.1 only · **Output:** a written state machine and a
decision record. **No production code, no migration, no endpoint.**

> **This is a research and design task whose legitimate outcome may be "do not build the rest of
> Phase 3."** The plan says so explicitly: *"3.1 may find no clean mechanism. That is an acceptable
> outcome — it ends the phase as a recorded research finding with send routes closed. It is not a
> licence to ship."* Deliverables 3.2–3.7 are dispatched only after the owner has read this
> verdict.

---

## 1. The problem, stated exactly

A durable write and a provider HTTP call cannot be made atomic. Process death can occur between
any durable state change and the provider invocation, so exactly-once is unreachable. The only
real choice is **which way to fail**, and D13 has already chosen:

| Boundary | Guarantee | Failure mode |
|---|---|---|
| Record **after** the call returns | at-least-once | a crash mid-call lets a retry **send a second real message** — *this is today's behaviour* |
| Record **before** the call | **at-most-once** | a crash between the record and the call abandons a request that was **never sent** |

**Decision already made (D13 R2): record before the call.** Not because the failure is
recoverable — it is not — but because it shrinks the ambiguity window from the whole provider call
to the gap between a durable write and the next instruction, and because a message Postora
silently drops is an internal failure it can detect, count and alarm on, whereas a duplicate is an
external failure the customer experiences and the partner cannot undo.

**`indeterminate` is terminal (D13 R3).** The durable intent exists in *both* crash cases — the one
where the message was never sent and the one where the provider accepted it — and without a
provider-side lookup the two are **indistinguishable**. Advising a partner to retry on
`indeterminate` reintroduces exactly the duplicate this decision exists to prevent. Each terminal
`indeterminate` needs a named escalation path to a human.

## 2. What this task must produce

**(a) The state machine, written out.** Every state, every transition, every actor (request
handler, takeover, reconciler, operator), and for each transition what is durable before it and
what is durable after. It must answer, unambiguously, what a takeover does when it finds a record
in each state. Prose is not enough — a table or diagram plus the invariants in words.

**(b) The verdict on reconciliation** — see §3, which is the part that decides the phase.

**(c) A decision record** at `docs/decisions/2026-09-01-d13-dispatch-state-machine.md`, matching
the shape of the existing records in that directory: short, factual, dated, with an owner and an
explicit restoration/review condition.

## 3. The fact that decides the phase — RE-VERIFY IT, DO NOT QUOTE IT

The spec asserts that WhatsApp Cloud "exposes no client-side lookup", and D13's entire
`indeterminate`-is-terminal contract rests on that. **That is a claim about Meta's API at the
spec's writing date.** 3.1's literal wording is "against what WhatsApp Cloud exposes", so
establishing what it exposes *today* is the task, not an assumption to inherit.

Check both, and report each with its source:

1. **Does `POST /{phone-number-id}/messages` accept any client-supplied idempotency or dedup
   token?** Historically no. Verify against current Meta documentation.
2. **Does `biz_opaque_callback_data` exist, and does Postora already receive it?** It is a
   client-supplied field Meta is documented to echo back in **status webhooks**. Check the current
   docs *and* this repository's own webhook ingest — grep the WhatsApp webhook handlers and any
   stored `social_inbox_events` / status payloads for the field. Evidence from Postora's own
   traffic outranks documentation.

**Two facts already established, so you do not spend time on them:** the `Fetcher` seam in
`_shared/whatsappPartnerOps.ts:70` exists and is already parameterised (`fetcher: Fetcher = fetch`),
so crash injection has a clean hook. And `biz_opaque_callback_data` appears **nowhere in this
repository** — Postora neither sends nor reads it today. So the question is not "are we already
receiving it" but "would Meta echo it if we started sending it", which is a documentation question
plus, ideally, one real send observed end to end.

**If (2) holds, it is a reconciliation channel the spec's "no lookup" claim underweights.** The
shape would be: stamp the dispatch intent's id into the outbound send; on takeover of a dispatched
intent, a later status webhook carrying that id **proves the send happened** — resolve to sent and
recover the `wamid`; silence past a conservative window stays `indeterminate`.

**Note the asymmetry, and preserve it.** Such a channel converts some indeterminates into
*resolved-sent*. It must **never** convert one into *safe-to-resend*. Absence of a status webhook
is not proof of non-delivery — it is only absence of evidence. That asymmetry is precisely 3.4's
"conservative refusal where the provider does not permit lookup", and any design that loses it has
reintroduced the duplicate.

## 4. Schema direction — decided in advance, justify or object

Use a **separate `partner_dispatch_intents` table**, not a fourth state on
`partner_api_idempotency`. Three reasons:

- **1.7's tenancy matrix already names "dispatch intents"** as an expected table. Building it
  closes another 1.7 row, with the same treatment its siblings got: composite FKs for tenancy and a
  negative database test.
- **Lifetime differs.** `partner_api_idempotency.key_id` is `ON DELETE CASCADE`. A dispatch intent
  is *evidence that a real message may have reached a customer* and must outlive key rotation or
  deletion — the same reasoning that deliberately gave `partner_audit_logs` no FK on `key_id`, with
  a `FOR KEY SHARE` tenancy trigger instead.
- **The property is different.** The existing `attempt_token` fence protects *settles* — "only the
  current lease holder may write the result". The new invariant is "**a takeover that finds a
  dispatched intent never calls the provider**". That is a different guarantee and deserves its own
  row rather than an overloaded state column.

If you conclude any of this is wrong, **say so and argue it** — this is a design brief, not an
instruction to type.

## 5. The exit gate, and what it binds

The phase's exit criterion is binary, with no third option. Crash tests run **both** immediately
before and immediately after the provider invocation, then retry with the same `Idempotency-Key`:

- **Pass** — no second provider call in either case, and a never-dispatched request is resolvable.
  Sending may ship.
- **Fail** — `POST /v1/messages` does not ship, and **every public send route stays closed,
  including the alias**.

`SEND_TEMPLATE_SUSPENDED` in `supabase/functions/partner-api/router.ts` names its restoration
condition as exactly this criterion. The two are the same gate deliberately. **Nobody flips that
flag on a partial pass**, and this brief does not authorise flipping it at all — restoration is a
separate, explicit decision after the gate passes.

The crash tests need an **injectable fetcher** (the existing `Fetcher` parameter in
`_shared/whatsappPartnerOps.ts` is the seam) so "crash" is a real control-flow abort at a chosen
instruction, not a simulated one.

## 6. Required reading

- `ARCHITECTURE.md` — nothing auto-loads it.
- Spec **D13 in full**, including revisions R2 and R3; **§11.5**; **§3.3.9**.
- Plan **Phase 3** and its exit criteria.
- `supabase/functions/_shared/partnerApiIdempotency.ts` — `claimIdempotency`,
  `completeIdempotency`, `markIndeterminate`, and the `attempt_token` fencing comment.
- The `partner_api_idempotency` table in `20260813120000_partner_api_foundation.sql` —
  states `processing | completed | indeterminate`, the lease, the fence.
- `supabase/functions/_shared/whatsappPartnerOps.ts` — the send path and its `Fetcher` seam.
- `supabase/migrations/20260830120100_partner_audit_logs.sql` — the no-FK + `FOR KEY SHARE`
  precedent for a table that must outlive its subject.
- `docs/decisions/` — the shape a decision record takes here.

## 7. Report contract

1. **The state machine** — states, transitions, actors, and the takeover behaviour per state.
2. **The reconciliation verdict** — what Meta exposes today, with sources, and whether Postora's
   own ingest already carries `biz_opaque_callback_data`. State plainly whether a reconciliation
   channel exists.
3. **The recommendation** — ship 3.2–3.7, or close the phase with send routes shut. Both are
   acceptable outcomes; an equivocal answer is not.
4. **What you could not verify**, and what would settle it.
