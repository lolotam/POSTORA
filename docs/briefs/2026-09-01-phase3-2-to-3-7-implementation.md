# Brief — Phase 3, deliverables 3.2 through 3.7

**Date:** 2026-09-01 · **Design authority:**
`docs/decisions/2026-09-01-d13-dispatch-state-machine.md` (deliverable 3.1, approved)

> **The design is settled. This brief is an instruction to implement it, not to redesign it.** If
> you believe part of the state machine is wrong, **stop and say so** — do not substitute your own.

## Why this ships in two stages

**Stage 1 = 3.2 + 3.3 + 3.4** — the durable dispatch core. No new endpoint.
**Stage 2 = 3.5 + 3.6 + 3.7** — `POST /v1/messages`, `GET /v1/templates`, alias convergence.

Stage 2 is dispatched **only after Stage 1's crash-test gate passes**, because Phase 3's exit
criterion is binary: if the safety property is not demonstrated, `POST /v1/messages` does not ship
and every public send route stays closed, the alias included. Building the endpoint first would be
paying for work that must then be withheld.

---

# The settled state machine

One row per attempted provider call, in a new table `partner_dispatch_intents`.

| State | Meaning |
|---|---|
| `intended` | a provider call is **about to be issued** |
| `sent` | the provider accepted; `wamid` known |
| `failed` | the provider **rejected**; nothing was delivered |
| `indeterminate` | outcome unknown, **no evidence has resolved it** |
| `reconciled_sent` | a status webhook carried this intent's id back |

| From | To | Actor | Trigger |
|---|---|---|---|
| — | `intended` | handler | **committed before the fetch** |
| `intended` | `sent` | handler | 2xx with a `wamid` |
| `intended` | `failed` | handler | a rejection that **proves** non-delivery |
| `intended` | `indeterminate` | **takeover** | a later attempt finds an `intended` row it does not own |
| `indeterminate` | `reconciled_sent` | webhook | a status arrives carrying this intent id |
| `sent` | `reconciled_sent` | webhook | normal delivery reporting |

### The five invariants — these are the deliverable

1. **A takeover that finds an `intended` row NEVER calls the provider.** It moves the row to
   `indeterminate` and returns the typed `idempotency_indeterminate`.
2. **`indeterminate` is not retryable and the API never advises retry on it.**
3. **Only a positive signal resolves an `indeterminate`.** A status webhook carrying the intent id
   proves the send happened. **Silence proves nothing.**
4. **No transition leads from `indeterminate` toward re-dispatch.** There is no state meaning "safe
   to resend" — do not add one.
5. **`failed` requires proof of non-delivery.** A timeout, an aborted fetch, or an unparseable body
   is `indeterminate`, **never** `failed`.

**The asymmetry is the safety property.** Absence of a status webhook is absence of *evidence*, not
evidence of absence — webhooks are delayed, dropped and retried. Reading silence as "never sent,
safe to retry" reintroduces exactly the duplicate D13 exists to prevent, while looking like
rigorous reconciliation.

---

# Stage 1 — 3.2, 3.3, 3.4

## 3.2 The durable pre-call boundary

**One migration**, `supabase/migrations/<timestamp>_partner_dispatch_intents.sql`. Pick a timestamp
later than every existing migration; **check for a collision first** — two migrations sharing a
timestamp order by filename sort, which is not an ordering anyone should rely on.

`partner_dispatch_intents` must carry at least: its own id (the correlator echoed to Meta),
`workspace_id`, `key_id`, `social_account_id`, the idempotency key it belongs to, `state`,
`wamid` (nullable), timestamps, and enough of the request to identify it to an operator.

Follow the established patterns in this repository — read them, do not guess:

- **Composite FKs for tenancy**, as in `20260830120000_partner_api_key_accounts.sql`. A single
  column FK would let one workspace's intent reference another's account.
- **No FK on `key_id`, with a `FOR KEY SHARE` tenancy trigger instead**, as in
  `20260830120100_partner_audit_logs.sql`. The reasoning transfers exactly: a dispatch intent is
  *evidence that a real message may have reached a customer* and must outlive key rotation or
  deletion. `partner_api_idempotency.key_id` is `ON DELETE CASCADE`; this must not be.
- **A `CHECK` on `state`** naming the five states.
- **Least-privilege grants**, matching `20260830120300`: `anon` gets nothing.

**The ordering requirement is the whole deliverable.** The intent row must be **committed** —
visible to another transaction — *before* the HTTP call is made. Not created in the same
transaction as the call. Not written optimistically and rolled back. If your implementation cannot
demonstrate that ordering under the crash test, it has not done 3.2.

## 3.3 Takeover never re-dispatches

Today `claimIdempotency` takes over an expired lease and the caller then sends. That is the
duplicate. After this change, a takeover must check for a dispatch intent **first**, and an
`intended` row is a hard stop.

**A trap, found in the code and easy to get wrong:** `sendTemplate` in
`_shared/whatsappPartnerOps.ts` **already calls `post()` twice** on the auto-registration path
(Meta error `133010`, or `100` with `error_subcode 33`): it registers the phone number, then
retries. **That pair is ONE dispatch attempt, not a takeover.** If your bookkeeping treats the
second `post()` as a new dispatch it will flag its own retry as a duplicate. One `intended` row
covers both calls.

## 3.4 Reconciliation, and conservative refusal

Stamp the intent id into the outbound send as `biz_opaque_callback_data`. `sendTemplate`'s payload
object currently has no such field; adding it is one line.

Then teach the status-webhook path to resolve intents. **Note why the existing handler cannot do
this today:** `whatsapp-webhook/index.ts:615` updates `whatsapp_messages` by
`.eq("message_id", wamid)`, and `persistOutbound` writes that row only *after* a `wamid` is known —
so in the crash case no row exists and the update matches nothing. The webhook must **additionally**
look up dispatch intents by the echoed id.

**Do not let reconciliation become a retry path.** It may move `indeterminate → reconciled_sent`.
It must never mark anything resendable, and a missing webhook must never resolve anything.

**One thing is NOT verified and you must not assume it.** Meta documents
`biz_opaque_callback_data` as added *"to free-form messages"*; Phase 3 sends **templates**, and
template coverage is unconfirmed. Build the channel, and make the system **correct whether or not
it works**: if the field never comes back, every `indeterminate` simply stays terminal, which is
today's behaviour. Report clearly that this remains unproven — confirming it needs one real send
against a live WABA, which does not exist yet.

## Stage 1 exit gate — binary, no third option

Using the existing `Fetcher` seam (`_shared/whatsappPartnerOps.ts:70`), inject a **real
control-flow abort** — not a simulated one — at each of two points, then retry with the **same**
`Idempotency-Key`:

| Crash injected | Required outcome |
|---|---|
| **immediately before** the provider invocation | retry makes **zero** additional provider calls; the record resolves without a second send |
| **immediately after** the provider invocation returns | retry makes **zero** additional provider calls; the record is `indeterminate` |

Plus: a never-dispatched request must be resolvable, and the `intended` row must be observable by
a second connection *before* the provider call — prove the ordering, do not assert it.

**Count the provider calls with a counting fetcher.** "No duplicate was sent" is a claim about the
number of times `fetch` was invoked; assert on that number.

**Do NOT flip `SEND_TEMPLATE_SUSPENDED`.** Restoration is a separate, explicit decision by the
owner after this gate passes. Nothing in this brief authorises it.

---

# Stage 2 — 3.5, 3.6, 3.7 (dispatched only if Stage 1 passes)

Recorded here so the design is visible now; **do not build it in the Stage 1 dispatch.**

- **3.5 `POST /v1/messages` — text and template only.** Attachments need Phase 4's media controls.
  Note that Phase 2 deliberately wired **no** authentication, limiter, idempotency or quota into
  `/v1` — the router is handed a `refusingClient()` that throws if `/v1` touches Supabase. 3.5 is
  where that changes, and the middleware must apply the same gate order the alias uses: scope →
  suspension → account → idempotency → quota.
- **3.6 `unsupported_capability`** for platform/type combinations that do not exist. **A new error
  code**: it must be added to `V1ErrorCode` in `docs/api/openapi.yaml`, to `V1_ERROR_POLICY`, and
  the baseline regenerated **in a separate commit after the document commit** (the regeneration
  script refuses to run against an uncommitted document). The 0.5 source sweep will fail if the
  code exists without the document listing it — that is the gate working.
- **3.7 `GET /v1/templates` (risk class B), and alias convergence** under D1. Convergence is judged
  by Phase 2's compatibility criterion: **status and body semantics identical after normalising
  `request_id`, with a closed list of permitted additive headers.** The T5-style pinning test in
  `v1/router.test.ts` is the shape to follow.

---

# Gates — run in this order, it is load-bearing

```bash
# Deno FIRST: --node-modules-dir=auto rewrites node_modules and breaks vitest after it
deno test --allow-env --allow-net --allow-read --allow-write --no-check \
  --node-modules-dir=auto supabase/functions/
bun install --frozen-lockfile
npx tsc -b --noEmit
bun run test
deno run --allow-read scripts/check-openapi-drift.ts
```

Plus the database harness, which is the gate that matters for the migration — it applies anything
newer than the baseline marker and runs the SQL suites. Read `scripts/db-harness.sh` and the
`db-harness` job in `.github/workflows/test.yml` for how it is invoked.

**Baseline on this branch:** deno **943 passed / 0 failed / 31 ignored**; `tsc -b` exit 0; vitest
**1119 passed / 15 skipped**; drift gate clean. Report the actual numbers you get; your new tests
should raise the deno count.

`bun run lint` fails with ~1080 pre-existing errors and is `continue-on-error` in CI. Not a gate.

**If you cannot run Postgres locally, say so** — do not report SQL as verified when it has only
been read. An unrehearsed migration is the most dangerous thing you can hand back.

**Mutation-test the SQL suite.** Break the migration deliberately (drop a tenancy trigger, weaken a
CHECK), confirm a test fails at the intended assertion, revert. Note that `psql` exits 0 on a
failed assertion, so "the script ran" is not "the assertions passed" — check what `db-harness.sh`
actually treats as failure.

# Action safety

- **Do NOT apply the migration to any production database.** The owner applies it by hand. Your job
  ends at a committed, rehearsed migration file.
- No changes to `src/**`. No new dependencies.
- Do NOT flip `SEND_TEMPLATE_SUSPENDED`.
- Do NOT run `git add` or `git commit` — the orchestrator reviews, re-runs every gate, and commits.
- `graphify-out/` is another tool's scratch. Never add it.

# Report contract

1. **The migration** — table shape, every constraint with its reasoning, and the grant surface.
2. **The state machine as implemented** — where each transition lives in code, and how a takeover
   is prevented from calling the provider.
3. **The double-`post()` registration path** — how you established it is one intent, not two.
4. **Files touched.**
5. **Gate outcomes** — actual counts for deno, tsc, vitest, drift gate, and the harness. State
   plainly whether the migration was applied to a real Postgres or only read.
6. **The crash-test results** — both injection points, with the **provider-call counts**.
7. **The SQL mutation test** — what you broke, which assertion caught it, and confirmation you
   reverted.
8. **Anything unverified**, anything you inferred, anything you deviated on, and any bug you found
   but did not fix.
