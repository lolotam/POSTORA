# Decision: suspend `send_template` on the Partner API alias (0A)

- **Date:** 2026-08-30
- **Owner:** the repository owner (Postora). Notification of Danat's named owner is
  self-coordination — both sides of this integration are owned by the same person.
- **Status:** In effect. Supersedes nothing; withdraws one action temporarily.

## Decision

The `send_template` action of the `partner-api` edge function (the frozen alias) is
**suspended as a safety measure** until the D13 duplicate-send window is closed. The
suspension is implemented as a deliberate, explicit refusal in code
(`SEND_TEMPLATE_SUSPENDED` in `supabase/functions/partner-api/router.ts`, enforced in
`index.ts`), not as a configuration or environmental side effect.

## Reason

D13: a process death between the Meta provider call and the durable idempotency settle
can deliver the same WhatsApp message to a real customer twice. The window is real,
known, and **unfixed** — the Phase 3 pre-call dispatch boundary that closes it has not
been built. The programme plan (§3, Phase 0, 0A) requires the window be closed **or**
the action disabled until it is. Disabling is chosen because the D13 research has not
been done.

At the time of this decision nothing could reach `send_template` anyway — three
unrelated accidents each independently block it:

1. the Postora provider entry on the partner's side is disabled
   (`provider_configs.postora.is_enabled = false`),
2. the partner's `POSTORA_WHATSAPP_API_KEY` environment variable is unset,
3. the key's pinned Postora account is inactive (`is_active = false`).

**None of these is a fix, and none is relied upon.** Any one being undone re-arms the
defect. That is exactly why the refusal lives in code: luck is not a control.

## What a caller sees

`send_template` returns **HTTP 503** with the typed, stable error code
`temporarily_unavailable` and **`retryable: false`**:

```json
{
  "success": false,
  "error": {
    "code": "temporarily_unavailable",
    "message": "This action is temporarily suspended; see the Partner API changelog. Retrying will not succeed until it is re-enabled",
    "retryable": false
  },
  "request_id": "…"
}
```

- Never a 404 — the action exists; claiming otherwise would break the frozen-alias
  contract (it must not degrade to `unknown_action`).
- Never a bare 500 — that would imply a bug and invite retries.
- No `Retry-After` header — restoration is gated on an engineering milestone, not a
  duration, so no schedule can honestly be promised.
- The refusal fires **after** the scope check (a key without
  `whatsapp:template.send` still gets `insufficient_scope` — the suspension is not an
  authorization bypass) and **before** the rate limiter, the account lookup, the
  idempotency claim, the quota reservation, and any provider work. A suspended action
  consumes no budget and poisons no idempotency key. It is still recorded in the usage
  ledger as a non-billable request so retry activity remains reconstructable.
- `get_status` and `list_templates` are unchanged in status, body and behavior.

## Restoration condition

Restore only when **the Phase 3 D13 gate has passed**: a durable dispatch intent is
written *before* the provider call, and a reconciler makes "process died mid-send"
distinguishable from "never sent", proven against the alias. At that point flip
`SEND_TEMPLATE_SUSPENDED` to `false` in `supabase/functions/partner-api/router.ts` —
that single value is the entire restoration *of the behaviour*; nothing else needs
deleting. The restoration must be verified (test + redeploy), not assumed.

**One thing the switch does not restore, and it is a test gap, so it is written down
here rather than left to be rediscovered.** `send_template` is the only class-C action,
and the suspension sits in front of the limiter, so three handler-level tests in
`supabase/functions/partner-api/limiterPolicy.test.ts` could no longer exercise class C
through the handler. Two were re-pointed at `list_templates` (class B, which shares the
fail-closed branch) and one was rewritten to prove the limiter is never consulted for a
suspended send. Class-C policy is still proven directly against `checkRateLimit` in
`supabase/functions/_shared/partnerApiMetering.test.ts`, so nothing is unproven today —
but when the switch is flipped back, those handler tests must be re-pointed at
`send_template`, or the restored action ships with its own fail-closed path untested
end to end.

Do not flip the switch casually: until the gate passes, restoring the action re-arms
a known duplicate-send defect against real customers.
