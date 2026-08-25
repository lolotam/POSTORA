You are an adversarial technical reviewer, ROUND 2, of an IMPLEMENTATION PLAN.
DO NOT WRITE OR EDIT CODE. DO NOT CALL ANY TOOL. DO NOT SEARCH GITHUB OR THE WEB.
Your shell is broken here; GitHub 'main' does NOT contain these documents. Everything is inlined below.

## What happened in round 1
You reviewed v1.0 of this plan and produced 26 findings (6 blockers). ALL were accepted.
The plan was substantially rewritten as v1.1 (8 phases -> 11) and the spec as v1.2.
The full round-1 correction log is in the plan's section 8, so you can see exactly what changed.

## YOUR ROUND 2 TASK - do NOT repeat round 1 findings. Judge the FIXES.
1. **Did each round-1 fix actually work?** For any round-1 finding you consider still open or newly
   mis-fixed, say so and explain what the revision missed. Be specific about which fix failed.
2. **Did the fixes introduce NEW problems?** Splitting 8 phases into 11 creates new seams, new
   ordering assumptions, and new blocks. Attack the NEW structure: is the P4-media-before-P5-webhooks
   ordering right? Is P7 (internal seam, no public API) actually shippable and independently valuable,
   or is it a phase with no observable outcome? Does the P0 fallback split for Danat actually work?
3. **Is the at-most-once choice in D13 correct?** The spec now chooses: record dispatch intent BEFORE
   the provider call, never re-dispatch on takeover, accept that a crash may abandon a never-sent
   message. Attack this choice. Is there a materially better option that was missed?
4. **Now that the plan is 11 phases, is it still executable?** Estimate whether any phase remains
   too large, and whether the total ordering has a cycle or a hidden serialization that makes the
   programme much longer than it looks.
5. **What would you cut?** If this programme had to ship value in half the phases, which phases are
   genuinely load-bearing and which are gold-plating?

## OUTPUT FORMAT - findings only, no rewrite, no summary of the documents
**Finding N - [blocker|major|minor] - <one-line claim>**
- Evidence: <plan section / spec decision>
- Why it matters: <concrete failure>
- Recommendation: <1-2 sentences>
End with: (a) any round-1 finding you consider STILL OPEN and why, (b) the single riskiest thing
remaining in the plan, (c) whether you would approve this plan to start execution - yes or no, and
the one change that would most increase your confidence.

=============== DOCUMENT UNDER REVIEW: IMPLEMENTATION PLAN v1.1 ===============
# Postora Partner API — Implementation Plan

**Status:** Draft, revised after review round 1 · **Version:** 1.1 · **Date:** 2026-08-25
**Specification:** `docs/postora future feathers/POSTORA-PARTNER-API-SPEC-v1.md` (v1.2)
**Source PRD:** `docs/postora future feathers/POSTORA_PARTNER_API_PRD_v1.0.md`

> **No code is written by this document.** It orders work, states what blocks what, and defines
> when each phase is done. Contracts and rationale live in the spec; this plan references decision
> IDs (D1–D13) rather than restating them.
>
> **Every implementer of every phase must read `ARCHITECTURE.md` first.** Nothing auto-loads it,
> and a delegation brief that omits it produces work nothing catches until human review.

---

## 1. How this plan is ordered

Not by product appeal. By **dependency and by irreversibility**.

1. **Anything that makes a false claim true comes first** — and anything that closes a *live*
   defect comes before that. `send_template` is deployed and reachable today with a known
   duplicate-send window (D13), so it is Phase 0 emergency work, not a later phase.
2. **Anything cheap now and expensive later comes early.** D1, D3 and D7 are affordable only while
   the hypotheses in spec §3.4 hold; their cost rises the day Danat goes live.
3. **Anything that would have to be rebuilt if done in the wrong order comes before its
   dependents.**

**Phases are small on purpose.** Review round 1 found the original Phases 3, 4 and 5 each bundled
enough cross-cutting change that a partial or weakly-tested delivery was the likely outcome. Each
phase below is scoped so it can be validated as one release, and so the programme can stop at any
boundary and leave a coherent product.

---

## 2. Dependency graph

```text
P0 Prerequisites + EMERGENCY send hardening
 │   (integration harness · CI gate · D13 stop-gap · Danat inventory)
 ├──► P1 Foundation hardening (D2 D4 D7 D12 audit)
 │     └──► P2 Read surface ──► P3 Text/template send (D13 gate)
 │                                    │
 │                                    ├──► P4 Media (D10)
 │                                    │      │
 │                                    │      ├──► P9 Rich-media messaging
 │                                    │      │
 └──► P5 Webhook substrate ──► P6 Messaging + account events
       (outbox · worker · CRUD)              │
                                             ▼
                              P7 Publishing seam (internal only, D9)
                                             │
                                             ▼
                              P8 Publishing API + post.* events
                                             │
                                             ▼
                                          P10 GA
```

**Hard blocks:**

| This | cannot start before | Because |
|---|---|---|
| Any "release-blocking test" claim | P0 integration harness **and** CI gate | Spec §3.3.8; and stubbed unit tests cannot prove SQL concurrency (§3.1) |
| Executing D1 / D3 / D7 on the **live key** | P0 Danat inventory | Spec §3.4 H1/H2 are unconfirmed hypotheses. Implementing them for *new* keys is not blocked — see §3 P0 fallback |
| P2 account selection (D11) | P1 join table (D4) | Selection is meaningless with one pinned account |
| Any public send route | P3 D13 gate | Binary: either D13 passes, or send routes stay closed |
| Rich-media messaging | P4 media controls | Otherwise an interim media contract gets invented, or unsafe external URLs accepted |
| Any **advertised** webhook event | its own certified transactional producer | Outbox-table existence is not sufficient (D5 R1) |
| `post.*` events | P7 seam | Events must enqueue in the status transaction |
| Public publishing API | P4 media | A publishing API that cannot post an image is not a coherent product |
| GA | P1 lifecycle (D12) | Partners cannot be onboarded by hand-written SQL |

---

## 3. Phases

### Phase 0 — Prerequisites and emergency hardening

**Goal.** Close the live defect, make the programme's claims checkable, and confirm the
assumptions the cheap decisions rest on.

#### 0A — Emergency: the live duplicate-send window

`send_template` is deployed and the Danat key holds `whatsapp:template.send` today. The D13 crash
window is therefore **live**, not hypothetical, and it sits in front of two phases of unrelated
work.

| # | Deliverable | Spec ref |
|---|---|---|
| 0.1 | **Close or block the window on the existing alias.** Either implement the D13 pre-call dispatch boundary on `send_template`, or disable the action until P3 lands | D13 |
| 0.2 | Whichever is chosen, it must cover the **alias**, not only the future REST route | D13, D1 |

Disabling is acceptable and cheap: `send_template` has never been called (spec §3.4). Choosing it
is a deliberate, reversible decision that removes the risk in an afternoon; choosing to implement
D13 here instead simply pulls P3.1–3.3 forward. **Leaving it open is not an option**, because a
dormant Danat job or a leaked key is sufficient to trigger it.

#### 0B — Make correctness checkable

| # | Deliverable | Spec ref |
|---|---|---|
| 0.3 | **Postgres integration-test harness**: migrated database, concurrent-transaction runner. Without it, none of the idempotency, takeover, rate-limit or quota guarantees can be tested at all | §3.1, §10 |
| 0.4 | CI job running `deno test` over `supabase/functions/**` | §3.3.8 |
| 0.5 | Seeded runtime contract tests wired to the OpenAPI document | PRD §31 |

0.4 is nearly free — the 30 existing partner-api tests pass locally in 728ms; it is a wiring gap.
0.3 is not free, and it is the more important of the two: **the tests that matter most are the
ones that cannot be written without it.** A CI job that runs only stubbed unit tests turns green
while every consequential database guarantee stays unproven.

#### 0C — Contract and security groundwork

| # | Deliverable | Spec ref |
|---|---|---|
| 0.6 | OpenAPI 3.1 skeleton: servers, security schemes, scopes, error component, pagination, rate-limit headers. No endpoints yet | §3.3.4 |
| 0.7 | **Contract-drift gate, defined concretely**: named comparison mechanism, a committed baseline document, semantic breaking-change rules (field removal, type narrowing, enum removal, required-field addition), and runtime contract tests. Schema validity alone, or bumping `info.version`, must **not** be able to satisfy it | PRD §47 |
| 0.8 | Security threat review of the v1 surface, with recorded disposition | PRD §50 |
| 0.9 | **Recorded** CORS decision for `/v1` — `ARCHITECTURE.md` §25 forbids inheriting `*` by copy-paste. For a header-authenticated non-browser API `*` is defensible, but it must be reviewed and written down | §9.9 |
| 0.10 | D8 containment check added to the review gate: no new surface authenticates with `profiles.api_key` | D8 |

#### 0D — External

| # | Deliverable | Spec ref |
|---|---|---|
| 0.11 | **Danat credential inventory**: how many environments hold `pk_live_urCb…`, is there deployed client code, any dormant retry job, who owns coordination | §3.4, §11.1 |

**Exit criteria.** Every one of the following is evidenced, not asserted:

- the live send window is closed or the action is disabled, **verified against the alias**;
- the integration harness runs a deliberately concurrent test and it passes;
- CI fails when a partner-api Deno test fails (proven by breaking one);
- the drift gate rejects a seeded breaking change (proven by introducing one);
- the threat review has a written disposition;
- the CORS decision is recorded with its rationale;
- the Danat inventory is written down, and H1/H2 are confirmed or replaced with what is true.

**Fallback if Danat is unreachable (0.11).** The block is narrower than "Phase 1 cannot start".
Split it:

- **D1** — extend the alias window; no other change.
- **D3** — implement generic scopes and apply them to **new** keys; leave the existing key on its
  legacy scopes at unchanged capability until coordination happens. The spec already forbids
  widening legacy scopes, so this is safe indefinitely.
- **D7** — implement risk classes and apply them to **`/v1` routes**; leave the alias's limiter
  behaviour untouched until coordinated.

Phase 1 therefore proceeds regardless; only the migration of the one live credential waits.

---

### Phase 1 — Foundation hardening

**Goal.** Fix what is wrong or missing in the existing foundation before building surface on it.
No new partner-facing endpoints except credential lifecycle.

| # | Deliverable | Spec ref |
|---|---|---|
| 1.1 | `partner_api_key_accounts` with **both** composite FKs and `UNIQUE (key_id, social_account_id)`; backfill one row per key | D4 |
| 1.2 | `partner_audit_logs`, append-only — no `UPDATE`/`DELETE` grant to any role | D12 |
| 1.3 | Credential lifecycle: create / rotate-with-overlap / revoke, in the Developer area, **user-JWT authenticated** | D12 |
| 1.4 | Risk-class enforcement in the limiter: A fails open, B and C fail closed with `503 limiter_unavailable` + `Retry-After` | D7 |
| 1.5 | `X-RateLimit-Limit` / `-Remaining` / `-Reset` on every response | §3.3.2 |
| 1.6 | Legacy scopes pinned at current capability, never widened; generic scopes available for new keys | D3 |

**Moved out of this phase.** Splitting the usage counters (reserved / confirmed / indeterminate)
depended on an unresolved product decision (§7 item 2) and would have made Phase 1 unable to
complete deterministically. It now sits in P10 as 10.1, gated on that decision.

**Exit criteria — each a test, not a demonstration:**

- **D4:** a tenant-isolation test proves a key cannot reach an account outside its bindings. The
  test is written to **fail against a single-composite-FK implementation** — that is its purpose.
- **D3, full intersection:** a legacy-scope key cannot send free-form messages, *and* cannot reach
  a newly bound account, *and* cannot act on a platform outside its original grant. Testing only
  the first leaves the escalation D3 exists to prevent.
- **D12, full lifecycle:** plaintext is shown exactly once and is not retrievable afterwards;
  creation is refused for a non-owner/admin; rotation works **before, during, and after** the
  overlap window, with the old secret rejected after expiry; revocation is irreversible; an
  attempted `UPDATE` or `DELETE` on `partner_audit_logs` is rejected.
- **D7:** one operation from each risk class behaves correctly under a simulated limiter outage.
- **D8:** the phase diff contains no new `profiles.api_key` authentication path.

**Risks.**

- **1.1 is the highest-consequence migration in the programme.** One composite FK instead of two
  silently loses the cross-workspace guarantee.
- **1.4 changes shipped behaviour.** Safe now only because `send_template` has never run in
  production. Ship before Danat's first send or it becomes a change under live traffic.

---

### Phase 2 — Read surface

**Goal.** Ship the `/v1` REST shape with read-only endpoints. Establishes routing, pagination,
account selection and the error envelope with nothing at risk.

| # | Deliverable | Spec ref |
|---|---|---|
| 2.1 | `/v1` router. **Alias migration is partial by design**: only alias actions whose shared use case exists in this phase move onto it. `get_status` converges here; `list_templates` and `send_template` converge in P3 | D1 |
| 2.2 | `/v1` error envelope; `X-Postora-Request-Id` on **every** application response, success or failure | D2 |
| 2.3 | `GET /v1/accounts`, `/v1/accounts/{id}` | §7 |
| 2.4 | `GET /v1/conversations`, `/{id}`, `/{id}/messages`, `GET /v1/messages/{id}` | §7 |
| 2.5 | Account selection per the D11 table, including non-enumerable `resource_not_found` | D11 |
| 2.6 | Opaque cursor pagination; prefixed opaque IDs | §7.1 |
| 2.7 | `GET /v1/usage` | §7 |
| 2.8 | OpenAPI entries + contract tests | PRD §31 |

**Exit criteria — a per-endpoint matrix, not a spot check.** For every endpoint above:

| Property | Assertion |
|---|---|
| Scope | Missing scope → `insufficient_scope`; wrong scope → same |
| Tenancy | Cross-workspace and cross-account → `resource_not_found`, never `resource_forbidden` |
| Selection | Collections default to all bound accounts and label each row; `?account_id=` narrows; an unbound `account_id` → `resource_not_found` |
| Pagination | Cursor stable across an interleaved write; page bounds enforced; a malformed cursor is rejected, not silently reset |
| IDs | Prefixed and opaque; no provider ID appears as a primary ID |
| Correlation | `X-Postora-Request-Id` present on success, 4xx **and** 5xx |
| Contract | Response validates against OpenAPI; a seeded drift is caught |

**Alias compatibility criterion — corrected.** The original wording, "byte-identical responses",
is impossible: request IDs are dynamic and Phase 1 adds rate-limit headers to every response.
Replaced with: **status code and body semantics identical after normalising `request_id` and any
timestamp, with a closed, enumerated list of permitted additive headers.** Anything outside that
list is a regression.

**Deliberately not in this phase.** No sends, no writes.

---

### Phase 3 — Text and template send

**Goal.** Close D13 and ship `POST /v1/messages` for text and templates. **Text and templates
only** — attachment sends need P4's media controls and would otherwise force an interim media
contract.

| # | Deliverable | Spec ref |
|---|---|---|
| 3.1 | **Settle the D13 state machine explicitly**, in writing, against what WhatsApp Cloud exposes | D13, §11.5 |
| 3.2 | Durable dispatch intent written **before** the provider call | D13 |
| 3.3 | Takeover **never re-dispatches** past a durable intent; it resolves to `indeterminate` | D13 |
| 3.4 | Reconciliation where the provider permits lookup; conservative refusal where it does not | D13 |
| 3.5 | `POST /v1/messages` — **text and template only** | §7 |
| 3.6 | `unsupported_capability` for platform/type combinations that do not exist | PRD §15.4 |
| 3.7 | `GET /v1/templates` (class B); `list_templates` and `send_template` alias actions converge onto the shared use cases | D1 |

**Exit criteria — binary, with no third option:**

Crash tests run **both** immediately before and immediately after the provider invocation, then
retry with the same `Idempotency-Key`. Then exactly one of:

- **Pass** — no second provider call in either case, and a never-dispatched request is resolvable.
  Sending ships.
- **Fail** — `POST /v1/messages` **does not ship**, and every public send route stays closed,
  including the alias.

There is no outcome where the endpoint ships with the safety property unresolved. The original
plan's wording permitted the interim at-least-once position to persist indefinitely while the
endpoint shipped anyway, which would have defeated the phase's entire purpose. **Documentation is
not a substitute for the safety property.**

**Risk.** 3.1 may find no clean mechanism. That is an acceptable outcome — it ends the phase as a
recorded research finding with send routes closed. It is not a licence to ship.

---

### Phase 4 — Media

**Goal.** Partner uploads against an explicit security contract. Sequenced before rich messaging
and before publishing because both need it.

| # | Deliverable | Spec ref |
|---|---|---|
| 4.1 | **Fill in the D10 control matrix first** — max size per type, sniffed-content allowlist, scan-before-availability, availability semantics, tenant ownership, download TTL **as a number**, retention/deletion, quota dimension | D10 |
| 4.2 | Any matrix row the existing pipeline cannot satisfy becomes implementation work **in this phase** | D10 |
| 4.3 | `POST /v1/media` (class C, Idempotency-Key) | §7 |
| 4.4 | `GET /v1/media/{id}`, `GET /{id}/download` via a Postora-controlled time-bounded URL | §7 |
| 4.5 | Media association with posts and messages | §7 |

**Exit criteria.**

- Every control-matrix row is answered with a number or a named mechanism.
- A file whose extension and real content disagree is rejected.
- A download URL expires at the documented TTL.
- No provider URL or credential is ever returned.
- **Scan-before-availability is enforced.** A media id that has not reached a clean state cannot be
  consumed by a send or a publish.

**Hard block, corrected.** The original plan called a missing malware scanner "a finding to surface
and decide on", which would have let the endpoint ship while exposing unscanned partner uploads —
directly contradicting D10. **If the existing pipeline has no scanning, the endpoint does not ship
until either scanning exists or D10 is formally revised by a recorded decision.**

---

### Phase 5 — Webhook substrate

**Goal.** Durable delivery machinery and subscription management. **No event family is advertised
in this phase** — events are certified individually in P6 and P8.

| # | Deliverable | Spec ref |
|---|---|---|
| 5.1 | `partner_webhooks` — per-subscription HMAC secret, event filter, platform, account filter, health state | D5 |
| 5.2 | `partner_webhook_deliveries` outbox; `UNIQUE (webhook_id, source_event_id)` | D5 |
| 5.3 | Worker: `FOR UPDATE SKIP LOCKED` + lease; backoff 1m/5m/30m/2h/6h; auto-disable only after exhaustion | D5 |
| 5.4 | **Worker operations**: scheduling and runtime ownership, backlog and age metrics, stuck-lease alerting, redrive/replay tooling, deployment verification | *new — see below* |
| 5.5 | Canonical headers: `X-Postora-Event`, `-Timestamp`, `-Event-Id`, `-Signature: sha256=…` | PRD §22.2 |
| 5.6 | Webhook CRUD + rotate-secret, class C, SSRF-validated per redirect hop | D7, §9.7 |
| 5.7 | `webhook.test` — the one event this phase does certify, since it has no external producer | D6 |
| 5.8 | **Producer ledger** — a table, filled in as producers are certified in P6/P8, with one row per event: transition, function, stable source ID, transaction mechanism, crash test | *new — see below* |

**Why 5.4 and 5.8 exist.** Round 1 identified that a correct outbox schema can silently accumulate
undelivered rows with nobody noticing, and that "transactional enqueue at every producer" is a
sentence, not a checklist — one missed producer silently voids at-least-once. Neither is provable
without an explicit ledger and operational visibility.

**Exit criteria.**

- A crash-during-dispatch test recovers the event.
- **Exactly one outbox row exists per source event** — asserted directly, not inferred. (A test
  that merely checks "delivered at least once" passes even when the `UNIQUE` constraint is
  missing, which is precisely the invariant at stake.)
- The `event_id` is immutable across retries, while delivery *attempts* may repeat.
- SSRF rejection proven, including on redirect hops.
- The retry ladder is observed end to end, and exhaustion disables the endpoint visibly.
- Backlog age is monitored and a stuck lease alerts.

---

### Phase 6 — Messaging and account events

**Goal.** Certify and advertise event families one at a time.

| # | Deliverable | Spec ref |
|---|---|---|
| 6.1 | `message.received` — enqueued in the same transaction as the inbound insert | D5, D6 |
| 6.2 | `message.accepted` (**not** `message.sent`) — enqueued with the send settle | D6 |
| 6.3 | `message.delivered` / `.read` / `.failed` — documented as **WhatsApp Cloud only; unavailable in Evolution QR mode** | D6 |
| 6.4 | `account.connected` / `.disconnected` / `.reauthorization_required` | D6 |
| 6.5 | Per-event latency documentation, and the modes where each event is unavailable | D6 |
| 6.6 | Producer ledger row completed for each of the above | 5.8 |

**Exit criteria — per event family, not per phase.** An event is advertised only when its ledger
row is complete **and** a crash test between its state change and its enqueue still delivers it.
An event without a certified transactional producer stays unadvertised, even if the code exists.

---

### Phase 7 — Publishing seam (internal only)

**Goal.** Do the risky extraction on its own, behind the existing UI, with **no public API
attached**. When something breaks here, it is unambiguously the seam.

| # | Deliverable | Spec ref |
|---|---|---|
| 7.1 | Extract the narrow publish invocation into `_shared/` behind `PublishPort` — **in-process; not an HTTP bridge, not an import of `index.ts`** | D9 |
| 7.2 | `process-post`'s entrypoint calls the port, so there is exactly one publish path | D9 |
| 7.3 | Terminal `platform_posts` status transition and outbox enqueue in **one transaction** | D9, D5 |
| 7.4 | Schedule-row creation and its enqueue likewise in one transaction (this is what `post.scheduled` needs) | D6 |

**Exit criteria.** Publishing through the existing UI is unchanged in behaviour and in per-platform
results. A crash after a platform result is written still produces a queued delivery row. No
public endpoint exists yet.

**Risk.** This is the riskiest extraction in the programme — `process-post/index.ts` is 7,202 lines
with ten platform branches. **Scope discipline is the mitigation: extract the invocation, not the
branches.** If the extraction starts reaching into provider logic, stop; that is the separate
Core 1 refactor.

---

### Phase 8 — Publishing API and post events

**Goal.** The public publishing surface, on a seam that already works.

| # | Deliverable | Spec ref |
|---|---|---|
| 8.1 | `POST /v1/posts`, `GET /{id}`, `GET /{id}/status` | §7 |
| 8.2 | `POST /{id}/publish` (Idempotency-Key), `POST`/`DELETE /{id}/schedule` | §7 |
| 8.3 | Multi-account `targets[]` per D11, with per-target status | D11 |
| 8.4 | `post.published` / `post.failed` / `post.scheduled`, each with a completed producer-ledger row | D6, 5.8 |

**Exit criteria.** A publish through `/v1` and a publish through the UI take the same path.
Per-target status is correct when one platform succeeds and another fails. Each `post.*` event
passes its own crash test.

**Stated honestly.** v1 publishing inherits `process-post`'s current per-platform failure modes.
The port is an architectural boundary, not a behavioural fix, and partner documentation must not
imply otherwise.

---

### Phase 9 — Rich-media messaging

**Goal.** Attachment sends, now that media controls (P4) exist.

| # | Deliverable | Spec ref |
|---|---|---|
| 9.1 | `POST /v1/messages` extended to image / video / audio / document, referencing `media_file_id` only | §7, D10 |
| 9.2 | `unsupported_capability` per platform and media type | PRD §15.4 |
| 9.3 | Scan-state enforcement: an unclean media id cannot be sent | D10 |

**Exit criteria.** No send path accepts an external URL. An unscanned or unclean media id is
refused. Every platform/type combination is either supported or returns
`unsupported_capability` — none fails opaquely.

---

### Phase 10 — GA

**Goal.** Usable by someone who does not work at Postora.

| # | Deliverable | Spec ref |
|---|---|---|
| 10.1 | Split usage counters: reserved / confirmed / indeterminate — gated on the §7 item 2 decision | §3.1, §8 |
| 10.2 | Developer documentation per PRD §32, fake credentials and synthetic data | PRD §32 |
| 10.3 | Postman collection generated from OpenAPI; no production secret committed | PRD §33 |
| 10.4 | Changelog and deprecation policy published | PRD §43–44 |
| 10.5 | Staging environment; a staging key must not authenticate against production — **tested** | PRD §45 |
| 10.6 | Documented divergences: `retryable` (D2), and D13's actual delivery guarantee | D2, D13 |
| 10.7 | Alias sunset armed: telemetry on alias traffic, per D1's three conjunctive conditions | D1 |
| 10.8 | **Certified end-to-end integration** — see below | PRD §46.8 |

**Certification is an artifact, not an assertion.** "One certified integration" is unmeasurable as
written, so it is defined here:

| Field | Requirement |
|---|---|
| Owner | A named person who signs off |
| Client | A real external client, running outside Postora's infrastructure |
| Environment | Staging first, then production, with environment-specific credentials |
| Path | External client → `/v1` → provider → webhook → status reconciliation |
| Failure cases | Must include at least: an invalid scope, a cross-tenant attempt, a duplicate `Idempotency-Key`, a provider rejection, and a webhook endpoint that fails then recovers |
| Evidence | Run artifacts retained: request IDs, delivery rows, and the resulting audit entries |

**Exit criteria.** PRD §52's GA list, enumerated explicitly in this document before GA is
declared, with two amendments: "idempotency works for side effects" is read against D13's *actual*
outcome rather than an assumed exactly-once; and "quotas and rate limits are concurrency-safe"
requires the P0 integration harness to be running the tests that prove it.

---

## 4. Risk register

### Programme risks — the likely failure modes

These are how this programme most plausibly fails as a whole. They matter more than any single
defect below.

| Risk | Impact | Mitigation |
|---|---|---|
| **No production-like integration harness** | Green unit tests over stubs while every consequential database and crash guarantee stays unproven. This is the single most likely path to a platform that looks finished and is not | P0.3 is a prerequisite, not a nicety; concurrency tests are exit criteria in P1, P3, P5 |
| **Producer sprawl** | "Transactional enqueue at every producer" spans inbound webhooks, status callbacks, health checks and several OAuth paths. One missed producer silently voids at-least-once | The 5.8 producer ledger; per-event certification in P6/P8 rather than per-phase |
| **Phase-size-driven partial delivery** | Large phases ship half-integrated; seam regressions become indistinguishable from new-API defects | The v1.1 split: 8 phases became 11, with the riskiest extraction (P7) isolated from its consumer (P8) |
| **No operational ownership of the outbox worker** | A correct schema accumulates undelivered rows indefinitely with nobody watching | 5.4 makes scheduling, metrics, alerting and redrive deliverables |
| **Decisions executed on unconfirmed hypotheses** | D1/D3/D7 justified by "one consumer" that was never verified | P0.11 inventory; the split fallback in P0 so the programme is not blocked on an external party |

### Defect risks

| Risk | Phase | Impact | Mitigation |
|---|---|---|---|
| D4 join table built with one composite FK | 1 | **Silent cross-workspace access** — the worst available outcome | Isolation test written to fail against a single-FK implementation; explicit migration review |
| D13 has no clean mechanism on WhatsApp Cloud | 3 | Sends cannot ship | Binary exit; the phase ends as a research finding with routes closed, never as a shipped endpoint with an unresolved guarantee |
| `PublishPort` extraction grows into the monolith | 7 | Programme absorbs a 7,000-line refactor | Extract the invocation only; stop and escalate if provider branches are touched |
| Limiter fail-closed lands after Danat's first send | 1 | Behaviour change under live traffic | Sequence 1.4 before Danat go-live |
| Media pipeline has no malware scanning | 4 | Unscanned partner uploads behind a public endpoint | Hard block: no scanning, no endpoint, unless D10 is formally revised |
| `profiles.api_key` spreads to new surfaces | all | The weaker credential outlives its deprecation | D8 containment is a mechanical exit criterion on every endpoint phase, not only a risk-register line |
| Concurrent branch resets drop work | all | Committed work disappears from `main` | Observed in this repository on 2026-08-25: commit `92cbe138` was dropped from `main` by a concurrent sync. Work on feature branches; verify `git log` after any sync |

---

## 5. What this plan deliberately does not do

Each maps to a spec §5 non-goal with re-entry criteria. Absence here is a decision, not an
oversight.

No OAuth, applications or installations · No SDKs · No Stripe wiring · No analytics endpoints ·
No AI endpoints · No contacts endpoints until a named consumer requires them · No n8n node
migration onto `/v1` · No `profiles.api_key` convergence (deferred but contained by D8) ·
No `process-post` refactor beyond the narrow P7 extraction.

---

## 6. Per-phase working agreement

1. **`ARCHITECTURE.md` is required reading**, named explicitly in any delegation brief along with
   the rule sections in play (§12 Edge Function shape, §13 prohibitions, §24 service role, §25
   CORS, §26 external HTTP, §27 background work). Nothing auto-loads it.
2. **Migrations are additive.** No column is dropped or repurposed in this programme.
3. **Guard passes before commit:** `clean-code-guard` on production code, `test-guard` on tests,
   `docs-guard` on developer documentation.
4. **An endpoint is not done** until it satisfies spec §10's definition of done — PRD §53's
   sixteen points plus a declared D7 risk class, a declared D11 selection rule, a CI-validated
   OpenAPI entry, and the D8 containment check.
5. **Edge function changes deploy via `ssh-contabo-mcp`**, per `CLAUDE.md` step 7 and
   `docs/runbooks/deploy-edge-function.md`. `npx supabase functions deploy` targets Supabase Cloud
   and fails against this self-hosted stack.
6. **No phase claims a guarantee it has not tested.** This is the rule D13 exists to enforce, and
   it applies generally.

---

## 7. Open items carried from the spec

| # | Question | Blocks | Spec ref |
|---|---|---|---|
| 1 | Danat inventory: how many environments, deployed client code, who coordinates? | Migrating the live key under D1/D3/D7. **Not** the phases themselves — see the P0 fallback | §11.1 |
| 2 | Quota semantics: accepted-only, or accepted-plus-indeterminate? Per-key or plan-derived? | 10.1 | §11.2 |
| 3 | `ecommerce-whatsapp-api`: deprecate with a sunset, or maintain? | Post-GA | §11.3 |
| 4 | Webhook delivery volume — worker cadence and concurrency sizing | 5.3, 5.4 | §11.4 |
| 5 | D13 mechanism against what WhatsApp Cloud exposes | 3.1, and therefore Phase 3 | §11.5 |

Item 1 is external and worth chasing immediately, but the P0 fallback means it no longer blocks
Phase 1. Item 5 is the one that can genuinely stop a phase.

---

## 8. Correction log

### v1.0 — 2026-08-25 — initial draft

Eight phases ordered by dependency and irreversibility.

### v1.1 — 2026-08-25 — review round 1 (Codex `gpt-5.6-sol`, high effort)

26 findings, 6 blockers. All accepted; several were defects I had flagged as suspect myself.

**Sequencing — the substantive rewrite:**

- **The live duplicate-send window moved to Phase 0.** `send_template` is deployed and reachable
  *today*; scheduling its fix in Phase 3 left a known customer-facing defect open behind two
  phases of unrelated work. Disabling the action is now an explicitly acceptable answer. *(blocker)*
- **Phase 2's alias convergence was impossible** — it required use cases that Phase 3 builds.
  Alias migration is now explicitly partial, completing in P3. *(blocker)*
- **Phase 3's exit made binary.** The original wording let the interim at-least-once position
  persist while the endpoint shipped anyway, defeating the phase's purpose. *(blocker)*
- **Media moved ahead of rich messaging and publishing.** Both depend on it; scheduling it last
  would have forced an interim media contract or unsafe external URLs.
- **Eight phases became eleven.** P3, P4 and P5 each bundled enough cross-cutting change that
  partial delivery was likely. The riskiest extraction (P7 publishing seam) is now isolated from
  its consumer (P8), so a failure is attributable.

**Correctness:**

- **D13's tradeoff named and chosen** *(blocker)* — "distinguish never-dispatched from
  dispatched-unknown" is unachievable; process death can occur between any durable write and the
  call. The spec now chooses **at-most-once** and the plan tests crashes on both sides of the
  invocation.
- **Phase 0 now requires a Postgres integration harness** *(blocker)* — running existing Deno
  tests in CI does not make the SQL concurrency, takeover, or quota claims checkable. This is the
  single biggest addition in v1.1.
- **Media scanning became a hard block** *(blocker)* — "surface and decide" would have permitted
  unscanned uploads behind a public endpoint, contradicting D10.
- **Webhook gating moved from table-existence to per-event certification**, matching D5's actual
  requirement.
- **The dedup exit criterion was rewritten** — "delivered at-least-once" passes even with the
  `UNIQUE` constraint missing. It now asserts one outbox row per source event.
- **"Byte-identical alias responses" was literally impossible** — request IDs are dynamic and
  Phase 1 adds rate-limit headers. Replaced with normalised semantic equivalence plus an
  enumerated additive-header allowlist.

**Completeness:**

- **D8 gained an implementing item** — it existed only in the risk register, so no phase could
  fail because of it.
- **D6 gained `webhook.test` and the `post.scheduled` transaction**, both previously unowned.
- **The producer ledger (5.8) and worker operations (5.4) were added** — "transactional enqueue at
  every producer" is not an auditable item, and a correct outbox with no monitoring silently
  accumulates undelivered rows.
- **The contract-drift gate was defined concretely** — as written it could be satisfied by schema
  validity or an `info.version` bump.
- **GA certification became an artifact** with a named owner, environments, failure cases and
  retained evidence.
- **Phase 0 and Phase 2 exit criteria were expanded** to cover their own deliverables; both could
  previously be declared done with their stated goals unmet.
- **Quota-counter work moved out of Phase 1**, which was blocked by an unresolved product decision
  not listed in the block table.
- **The Danat block was split per-decision**, so an unreachable partner no longer stalls Phase 1.
- **Programme-level risks were added** to the register, which previously listed only individual
  defects and missed the most likely failure mode: a partially integrated platform with green
  unit tests and unproven database semantics.

=============== REFERENCE: SPECIFICATION v1.2 (decisions D1-D13) ===============
# Postora Partner API — Specification v1

**Status:** Draft, revised after review round 1 · **Version:** 1.1 · **Date:** 2026-08-25
**Supersedes scope of:** `docs/superpowers/specs/2026-08-13-postora-whatsapp-partner-api-design.md` (v2, WhatsApp-only)
**Source PRD:** `docs/postora future feathers/POSTORA_PARTNER_API_PRD_v1.0.md`
**Implementation plan:** `docs/postora future feathers/POSTORA-PARTNER-API-IMPLEMENTATION-PLAN.md`

> **No code in this document.** This is a contract and decision specification. Every claim about
> current behaviour is cited to a file, line, migration, or a live production query run on
> 2026-08-25. Anything not cited is marked as a proposal.

---

## 1. Problem

The PRD describes a full developer platform: REST `/v1` resources across messaging, publishing,
media, contacts, analytics and AI; OAuth app installations; a webhook product; SDKs; billing.

What exists today is a **single-endpoint, action-RPC door that does three things for WhatsApp.**
The gap is not a matter of adding endpoints — the PRD and the implementation disagree about the
*shape* of the API, the *error envelope*, the *scope vocabulary*, and the *unit of tenancy*.

This specification closes that gap explicitly. It does not restate the PRD. For each conflict
between the PRD's target and the code's reality it records **which one wins in v1 and why**, so
implementation is execution rather than re-litigation.

---

## 2. Relationship to other documents

| Document | Owns |
|---|---|
| `POSTORA_PARTNER_API_PRD_v1.0.md` | Product intent, target users, commercial framing, long-range roadmap |
| `docs/superpowers/specs/2026-08-13-postora-whatsapp-partner-api-design.md` | The WhatsApp partner door as built: key hashing, tenancy FK, idempotency semantics, Danat topology |
| `ARCHITECTURE.md` | Layering, dependency direction, Edge Function shape, security rules all new code must follow |
| **This document** | The v1 public contract, the decision ledger, the data-model delta, the acceptance bar |
| `POSTORA-PARTNER-API-IMPLEMENTATION-PLAN.md` | Ordered phases, sequencing, risk, per-phase exit criteria |

The 2026-08-13 spec is **not superseded as a record of why the foundation is built as it is.** Its
§5.1a (composite-FK tenancy), §5.1b (metering), §5.3 (idempotency states) and §5.5 (delivery
outbox) remain the authoritative rationale. This document generalises the *surface* above that
foundation and carries forward the part of it that was specified but never built (§3.3.1).

Per `CLAUDE.md`, a fact lives in exactly one file; where this spec needs a fact from another
document it links rather than copies.

---

## 3. Verified current state

Checked on 2026-08-25 against the working tree and the production database.

### 3.1 What is built

The foundation is substantially more complete than the PRD assumes. PRD §50's "Phase 1 — Partner
API Foundation" is, with the exceptions in §3.3, largely delivered.

| PRD requirement | Status | Evidence and precise scope of the claim |
|---|---|---|
| API-key auth, hashed at rest | Built | `_shared/partnerApiKeys.ts` — SHA-256 hex digest, `pk_live_` prefix, plaintext never stored |
| Non-enumerable key errors | Built | `partnerApiKeys.ts:85` — unknown and malformed keys return an identical 401 |
| Workspace/account binding | Built, DB-enforced | `20260813120000_partner_api_foundation.sql` — composite FK `(social_account_id, workspace_id)` makes cross-workspace key misuse impossible in the database, not merely in code |
| Scopes | Built | `PartnerScope` in `partnerApiKeys.ts`; enforced by `assertScope` + `partner-api/router.ts` |
| Request IDs | Built **for application responses** | `partner-api/index.ts:75` — every post-`OPTIONS` exit path stamps header and body. **The CORS preflight at `:70` returns before the id is generated and carries neither** |
| Idempotency claim/replay/conflict | Built, rigorous | `claim_partner_idempotency()` — atomic claim, lease takeover, and an `attempt_token` fence so a revived stale writer cannot settle a new owner's row |
| Observed-indeterminate handling | Built | An indeterminate outcome the process *observes* is never auto-retried and never refunded. **This does not cover process death mid-send — see §3.3.9** |
| Rate limiting, concurrency-safe | Built | `consume_partner_rate()` — one atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING`, explicitly rejecting the count-then-insert race |
| Quota reserve/settle | Built | `reserve_partner_quota()` / `release_partner_quota()`. **Quota is consumed by accepted *or indeterminate* sends** — released only on a *definite* provider rejection |
| Usage ledger | Built | `partner_api_usage`; composite FK prevents a usage row whose workspace disagrees with its key |
| Revocation as a one-way door | Built | `revoke_partner_key()` — no `UPDATE` grant exists, so a leaked key cannot be silently un-revoked |
| Sanitized errors | Built | Typed error codes throughout; raw Meta/Postgres errors are not returned |

**On test status.** 30 Deno tests covering these modules pass locally in 728ms. They are *not* a
release assurance, because they do not run in CI (§3.3.8), and unit tests over stubbed clients
cannot demonstrate the SQL concurrency properties that the idempotency and rate-limit designs
depend on. Treat the foundation's *reasoning* as sound and its *operational behaviour* as
unvalidated — nothing here has run under production load (§3.4).

This foundation should be **extended, not redesigned.** Several of its properties (the fencing
token, the reserve/settle split, the composite FKs) are subtle correctness work a rewrite would
likely lose.

### 3.2 What the API exposes

Three actions, WhatsApp only, over a single `POST` (`partner-api/router.ts`):

| Action | Scope required | Side effect |
|---|---|---|
| `get_status` | none | none |
| `list_templates` | `whatsapp:templates.read` | none |
| `send_template` | `whatsapp:template.send` | billable; requires `Idempotency-Key` |

A fourth scope, `whatsapp:webhooks.manage`, is **defined and granted but has no action behind it.**

### 3.3 What is specified or required but missing

1. **The webhook delivery outbox does not exist.** The 2026-08-13 spec §5.5 specified
   `whatsapp_webhook_deliveries` as a transactional outbox, reasoning that fire-and-forget
   dispatch loses events permanently: the inbound message is inserted first and dispatched
   second, so a lost dispatch is never recovered because Meta's redelivery hits the duplicate
   check and skips. **No `*_deliveries` table exists in any of the 225 migrations.** The PRD's
   whole webhook product (§22–23) rests on it.

2. **No `X-RateLimit-*` headers.** PRD §25 requires `-Limit`, `-Remaining`, `-Reset` and
   `Retry-After`. `checkRateLimit` (`_shared/partnerApiMetering.ts:75`) returns `void` or throws;
   it never surfaces counts, so a caller cannot back off intelligently.

3. **The rate limiter fails open, unconditionally.** `partnerApiMetering.ts:84` —
   `if (error) return;`. PRD §25 requires a *deliberate* policy chosen per operation risk. Today
   a limiter outage removes all rate limiting from billable sends. See D7.

4. **No OpenAPI document.** PRD §31 makes it the source of truth; `openapi/` does not exist.

5. **No key-minting UI and no rotation.** `partner_api_keys` appears in `src/` only in the
   generated `types.ts`. Keys are minted by hand-written SQL. (`src/pages/ApiKeys.tsx` is a
   *different* system — it manages `profiles.api_key`, used by `n8n-api`. See D8.)

6. **No audit log.** PRD §30 requires an auditable record of key creation, rotation, revocation
   and scope changes. `revoke_partner_key()` stamps `revoked_by`/`revoked_reason` on the row,
   which records latest state but is not an append-only trail.

7. **No OAuth, applications, or installations.** PRD §12.2, §40, §50 Phase 6 are unbuilt.

8. **The Partner API's tests never run in CI.** `vite.config.ts:45` sets the vitest `include` to
   `["src/**/*.{test,spec}.*"]`, so every Deno test under `supabase/functions/**` is outside the
   pattern; `.github/workflows/test.yml` runs only `bun run test` (vitest) and `npx tsc --noEmit`.
   `partner-api/isolation.test.ts`, `router.test.ts`, `partnerApiIdempotency.test.ts`,
   `partnerApiKeys.test.ts` and `partnerApiMetering.test.ts` **exist but gate nothing.** §10
   declares tenant-isolation tests release-blocking; under today's CI they block nothing. A Deno
   test job is a Phase 0 prerequisite, not a testing nicety.

9. **A crash mid-send can duplicate a customer message.** `partner-api/index.ts` calls
   `sendTemplate()` **before** any durable record exists that the provider call was attempted.
   `completeIdempotency()` and `markIndeterminate()` both run *after* the call returns. If the
   isolate dies after Meta accepts the message but before either settles, the row stays
   `processing`; once the 300-second lease expires, `claim_partner_idempotency()` grants takeover
   to a retry, which sends a **second real message to a real customer**.

   The `attempt_token` fence does not prevent this — it stops a stale writer from *settling*
   another attempt's row, not from *dispatching* a second provider call. The in-code comments
   correctly identify this hazard for the settle-failure case and handle it via
   `markIndeterminate()`; the process-death case cannot be handled from inside the dying process.
   See D13.

### 3.4 Live production state

Queried against production on 2026-08-25:

```
partner_api_keys:  1 row
partner_api_usage: 4 rows
whatsapp_webhooks: 0 rows
```

The key is `Danat Backend` (`pk_live_urCb…`), all three scopes, **not revoked**,
`last_used_at = 2026-08-14 01:28 UTC`, `current_usage_count = 0`.

All four usage rows come from one 11-minute window on 2026-08-14: one `unknown_action` 400, two
`get_status` 200s, one `list_templates` 200. **No `send_template` call has ever been made. No
webhooks are configured.**

**What this proves, and what it does not.** It proves the side-effectful path has never run in
production, and that no *recorded traffic* depends on the current contract. It does **not** prove
there is only one consumer: one credential can be deployed across many hosts, environments,
release versions and dormant retry jobs, and Postora has no inventory of where Danat installed it.

Therefore the following are **working hypotheses, not established facts**, and each must be
confirmed by an inventory of Danat's deployment before any decision is executed on its strength:

- H1 — the credential is held by a single deployed consumer;
- H2 — changing shape, envelope, or scope vocabulary is close to free **today**, and grows
  expensive from Danat's go-live onward.

D1, D3 and D7 are affordable *if* H1 and H2 hold. Confirming them is the first item in §11.

---

## 4. Goals

1. Freeze the v1 public contract shape, error envelope, and scope vocabulary **before** the second
   consumer arrives.
2. Carry the existing foundation forward without redesigning its correctness-critical parts.
3. Deliver the missing prerequisites (§3.3) the PRD's promises depend on.
4. Make the OpenAPI document the enforced source of truth, with CI gates that actually run.
5. Keep every phase independently shippable.

## 5. Non-goals for v1

Beyond the PRD's own §6, this specification defers the following. Each carries re-entry criteria,
so scope cannot quietly disappear into conditional prose.

| Deferred | PRD ref | Why | Re-entry when |
|---|---|---|---|
| OAuth and app installations | §12.2, Phase 6 | No v1 consumer needs it: Danat is server-to-server, WooCommerce is site-owner-installed. OAuth is for *public marketplace* apps only | A public Shopify/Salla/Zid listing is committed |
| SDK generation | §34 | Generating from a moving contract produces churn | OpenAPI is stable and version-tagged |
| Billing integration | §27, Phase 9 | Metering must be billing-*ready*; wiring Stripe is not v1 | First paid partner contract |
| AI API | §21 | Separate quota model and commercial decision | Explicit product decision |
| Analytics API | §20 | Would be built on a warehouse that does not exist (see `Ai agent improvemnets.md`, Core 2). Specifying a contract we cannot serve would freeze a lie | The analytics warehouse ships |
| **Contacts API** | §19 | No identified v1 consumer requires it | A named consumer requires it |
| **n8n migration onto `/v1`** | §38 | The node works today on `n8n-api`; migrating it is its own plan with its own blast radius | After `/v1` messaging is GA and stable |
| **`profiles.api_key` convergence** | — | Reissuing credentials to every n8n user is a real migration for an internal-consistency benefit | See D8 |

---

## 6. Decision ledger

Each decision resolves a conflict between the PRD and the implementation, or closes a gap a
reviewer identified. Decisions marked **(R1)** were added or materially changed after review
round 1.

---

### D1 — API shape: REST `/v1` resources, with the action endpoint retained as a frozen alias

**Conflict.** PRD §11 specifies REST resources. The implementation is a single `POST` taking
`{action: "..."}`.

**Decision.** Adopt REST `/v1` as the v1 public contract. Keep the existing action endpoint alive,
frozen at its current three actions, as a compatibility alias.

**Rationale.** Action-RPC cannot express resource-scoped pagination, conditional requests, or
per-resource limits without inventing a parallel convention for each, and it forces the OpenAPI
document to describe one endpoint with a discriminated-union body — a contract that readers and
generators handle badly. The usual "you cannot break existing consumers" objection is weak here
under H2 (§3.4).

**Cost accepted.** Two paths during the alias window. Bounded by freezing the alias — no new
actions, ever — and implementing every alias action as a thin translation onto the same use-case
layer the REST route calls, so behaviour cannot diverge.

**(R1) Alias sunset — corrected.** The previous wording ("Danat confirms, or 6 months after GA,
whichever is sooner") permitted removal at six months *even if Danat had not migrated*, which
would knowingly break the only partner. Replaced with all of the following, conjunctively:

1. alias telemetry shows **zero** Danat traffic for 30 consecutive days; **and**
2. Danat confirms in writing that no deployed environment still calls the alias; **and**
3. a 30-day notice period has elapsed after that confirmation.

An email is not a completed migration. Absent all three, the alias stays.

**Rejected alternative.** Keeping action-RPC and layering REST later — the contract then freezes
twice, the second time *after* consumers exist.

---

### D2 — Error envelope: adopt the PRD's structure, keep `retryable` **(R1, revised)**

**Conflict.** PRD §28 specifies `{"error": {code, message, request_id, details}}`. The
implementation emits `{success: false, error: {code, message, retryable, details}}` with
`request_id` at the top level.

**(R1) Revision.** v1.0 of this spec froze the *implemented* envelope for `/v1`. Review round 1
correctly showed the rationale was weak: D1 already keeps the alias, so the alias can retain its
own envelope, and `/v1` is free to choose on merits. The claim that "HTTP status alone is
ambiguous" is not supported by the adapter, which uses meaningful 4xx/5xx statuses throughout.

**Decision.** `/v1` errors use:

```json
{ "error": { "code": "...", "message": "...", "retryable": false,
             "request_id": "req_...", "details": {} } }
```

- PRD nesting is adopted, including `request_id` inside `error`.
- **`retryable` is retained**, against the PRD, and this is deliberate: it tells a client whether
  to back off or fail permanently without maintaining a client-side table of which codes are
  transient — the thing integrators most often get wrong. The PRD's shape is silent on it and is
  worse for it.
- `success` is dropped from `/v1`.
- `X-Postora-Request-Id` is returned on **every** application response, success or failure, and
  successful bodies carry `request_id` too — so correlation does not depend on failing.
- The frozen alias keeps its current envelope unchanged.

---

### D3 — Scope vocabulary: generic scopes, and **reissue** rather than alias **(R1, revised)**

**Conflict.** PRD §13 specifies generic scopes (`messages:send`). The implementation uses
provider-prefixed ones (`whatsapp:template.send`).

**Decision.** v1 issues generic scopes only.

**(R1) Revision — the aliasing plan is withdrawn.** v1.0 proposed mapping
`whatsapp:template.send → messages:send` while leaving old scopes valid. Review round 1 correctly
identified this as **privilege escalation disguised as vocabulary migration**: the legacy scope
authorises *WhatsApp template* sending specifically, while `messages:send` covers a broader
resource family — free-form messages, and under D4 any newly bound account on any platform. A
credential would silently gain authority its holder never requested.

**Replacement.** No aliasing. There is exactly one key (§3.4), so:

1. Legacy scope strings remain accepted **at exactly their current capability** — WhatsApp
   template send only — and are never widened.
2. The Danat key is **reissued** with explicit generic scopes as part of its migration, which is a
   deliberate grant with a human decision behind it.
3. Legacy scope strings are then rejected for new keys.

**Authorization is an intersection, not a lookup.** A request is permitted only if the scope
allows the *operation*, the bound accounts allow the *resource*, and the platform capability
allows the *operation subtype*. Scope answers *may you*; capability answers *can this platform*;
account binding answers *on what*. Conflating any two of them is what produces either a scope
explosion or a privilege leak.

**Rationale for generic scopes.** Provider-prefixed scopes force a new scope per platform, which
multiplies the authorisation surface and pushes provider knowledge into the credential model —
the opposite of the provider-neutral boundary the PRD (§42) and `ARCHITECTURE.md` require.

---

### D4 — Account binding: many accounts per key, with **two** composite FKs **(R1, revised)**

**Conflict.** PRD §14 shows `allowed_social_accounts: [...]`. The implementation pins exactly one
(`partner_api_keys.social_account_id NOT NULL`).

**Decision.** Add a `partner_api_key_accounts` join table. Retain `social_account_id` as the
"primary account" for the frozen alias, which has no way to express account selection.

**(R1) Non-negotiable constraint — corrected.** v1.0 required only
`FK (social_account_id, workspace_id) → social_accounts (id, workspace_id)`. That is insufficient:
it proves the *account* belongs to the row's workspace but not that the *key* does, so a malformed
or compromised administrative write could bind a key from workspace A to an account from
workspace B while satisfying the constraint.

The table must carry **both**:

```
FOREIGN KEY (social_account_id, workspace_id) REFERENCES social_accounts   (id, workspace_id)
FOREIGN KEY (key_id,            workspace_id) REFERENCES partner_api_keys  (id, workspace_id)
```

plus `UNIQUE (key_id, social_account_id)`.

This is not a novel pattern: `partner_api_keys` already carries
`UNIQUE (id, workspace_id)` (`20260813120000_partner_api_foundation.sql:52`) precisely so it can
be referenced this way, and `partner_api_usage` already uses the identical double-composite
technique. Following the existing precedent is the correct move; a join table with two independent
FKs would **silently lose the guarantee** and is the single most dangerous regression available in
this programme.

**Rationale for many-per-key.** One-account-per-key is right for Danat and wrong for everything
else: a WooCommerce site publishing to five platforms would need five keys, five secrets in
`wp_options`, and five rotations. Publishing (PRD §18) is inherently multi-account.

**Migration.** Additive; backfill one row per existing key; the `NOT NULL` column stays until the
alias sunsets.

---

### D5 — The webhook delivery outbox is a v1 prerequisite

**Decision.** Build `partner_webhook_deliveries` as a transactional outbox **before** any webhook
endpoint is exposed. No webhook API ships on fire-and-forget dispatch.

**Rationale.** The failure mode is not "an event is late" but "an event is lost permanently and
neither side can tell." Because the message row is inserted before dispatch, a dropped dispatch is
unrecoverable — Meta's redelivery hits the duplicate check and skips. Publishing a webhook product
with a documented at-least-once guarantee on that basis would be an untrue claim.
`ARCHITECTURE.md` §27 independently forbids treating Edge Functions as durable queues and requires
retry-critical workflows to persist state so they can resume after process termination.

Carried forward unchanged from the 2026-08-13 spec §5.5:

- atomic claim via `FOR UPDATE SKIP LOCKED` **plus a lease** — explicitly *not* the
  select-then-loop in `whatsapp-scheduled-sender/index.ts:26-32`, which has no atomic claim and
  double-delivers under concurrency;
- backoff 1m / 5m / 30m / 2h / 6h;
- auto-disable only after the ladder is exhausted, surfaced in the UI;
- `UNIQUE (webhook_id, source_event_id)` as the dedup anchor.

**Guarantees published — and no more:** at-least-once delivery; best-effort ordering (backoff
inherently lets event 2 land before event 1's retry; strict per-conversation ordering would mean
head-of-line blocking); immutable event IDs, so **partners deduplicate**.

**(R1) The outbox alone is not sufficient.** A table and a worker still lose events unless every
producer **enqueues in the same transaction as the state change it reports.** A callback that
fires "after the post completes" recreates precisely the crash gap the outbox exists to close.
Every event in D6 must therefore name a producer that enqueues transactionally — see D9 for how
this applies to publishing, which is the hard case.

**Generalisation.** The 2026-08-13 table was WhatsApp-named; v1 names it `partner_webhook_*` with
a `platform` column, so publishing and account events use the same machinery.

---

### D6 — Event families: publish only what has a defined, transactional producer **(R1, revised)**

**Decision.** An event ships in v1 only when its **exact state transition, stable source
identifier, and transactional producer** are all defined. "A producer exists somewhere" is not
sufficient — see D5(R1).

**(R1) Naming correction.** `message.sent` was listed as produced by the Partner API send path.
The implementation only ever knows `state: "accepted_by_meta"` — provider acceptance, not
delivery, and not observably "sent". Publishing `message.sent` would have partners building
irreversible workflows on a name that overstates what Postora knows. Renamed to
**`message.accepted`**, with `message.delivered` reserved for the provider's own delivery status.

| Event | Transition it reports | Producer | v1? |
|---|---|---|---|
| `message.received` | Inbound message persisted | Meta / Evolution webhook, enqueued with the insert | Yes |
| `message.accepted` | Provider accepted for delivery | Partner API send path, enqueued with the settle | Yes |
| `message.delivered` / `.read` / `.failed` | Provider status callback | Meta status webhook | Yes — **WhatsApp Cloud only; unavailable in Evolution QR mode** |
| `post.published` / `.failed` | Terminal `platform_posts` status | Publishing status transition — requires the D9 seam | Yes, gated on D9 |
| `post.scheduled` | Schedule row created | Scheduling path | Yes |
| `account.reauthorization_required` | `needs_reauth` set true | `check-connection-health` | Yes |
| `account.connected` / `.disconnected` | Account activation transition | OAuth callbacks | Yes |
| `conversation.updated` | — | **None** — would be inferred | **No** |
| Comment events | — | Poller or webhook, per platform | **No** — deferred, see roadmap Core 4 |
| `webhook.test` | Manual trigger | Webhook API | Yes |

**Latency is documented per event, not globally.** Webhook-sourced events are near-real-time;
poller-sourced events are bounded by cron cadence. Publishing both under one "real-time events"
heading would be untrue for the polled ones.

---

### D7 — Limiter-failure policy: classify by risk, not by billability **(R1, revised)**

**Conflict.** PRD §25 requires a deliberate per-risk policy. `partnerApiMetering.ts:84` fails open
for everything.

**(R1) Revision.** v1.0 split on "billable side effect vs read". Review round 1 correctly showed
that boundary leaves major abuse classes uncovered: a webhook *test* is a read-shaped operation
that makes Postora issue an outbound request to a partner-supplied URL (SSRF amplification); media
*upload* consumes storage; provider-backed reads consume Meta quota; secret rotation is a
security-relevant mutation. None are "billable sends".

**Decision.** Every operation is assigned one of three risk classes in the OpenAPI document. On
limiter unavailability:

| Class | Definition | On limiter failure |
|---|---|---|
| **A — bounded local read** | Serves from Postora's own database, bounded page size, no outbound call | **Fail open.** Cheap, idempotent, no amplification |
| **B — external or unbounded** | Any outbound provider call, media download, or unbounded result set | **Fail closed** — `503 limiter_unavailable`, `retryable: true`, `Retry-After` |
| **C — mutation or amplifier** | Any state change, any customer-reaching effect, any operation that makes Postora call a third-party URL (webhook test, webhook create/rotate), any upload | **Fail closed** |

**Rationale.** The existing comment — "Never fail a send because the limiter is unavailable" —
optimises for availability of a money-spending, customer-reaching operation. A limiter outage plus
a partner retry loop is precisely what rate limiting exists to prevent; the blast radius is real
messages, real spend, and outbound requests Postora is attributed with, none recoverable by
apology. A refused class-B/C request is retryable and harmless.

**This is a deliberate behaviour change to shipped code**, safe to make now only because
`send_template` has never run in production (§3.4). It is in the plan's risk register.

---

### D8 — Two API-key systems: explicit non-goal, with a containment rule **(R1, revised)**

**Finding.** Postora has two unrelated API-key systems:

| | `profiles.api_key` | `partner_api_keys` |
|---|---|---|
| Consumer | `n8n-api` | `partner-api` |
| Storage | **Plaintext UUID** on `profiles` | SHA-256 hash |
| Scopes | None — full user authority | Yes |
| Rotation | Regenerate in `src/pages/ApiKeys.tsx` | **Not implemented** (D12) |
| Tenancy | User-scoped | Workspace + account, DB-enforced |

**Decision.** Convergence is an explicit **v1 non-goal** (§5), not an open question.

**(R1) Containment rule — added.** Deferral without containment would let the weaker credential
keep spreading. Therefore, binding for v1:

1. **No new surface may authenticate with `profiles.api_key`.** Every new integration point uses
   Partner API keys. **(R2)** This is enforced, not aspirational: it is an exit criterion on every
   endpoint-delivering phase, and the check is mechanical — grep the phase's diff for
   `profiles.api_key` and for reads of `profiles` in an auth path. A containment rule with no
   enforcement hook is how the weaker credential outlives its own deprecation.
2. The security posture is recorded here as a known weakness: plaintext at rest, unscoped user
   authority, so a database disclosure yields directly usable credentials.
3. Re-entry criteria: once `/v1` messaging is GA and the n8n node has a migration path (§5),
   `profiles.api_key` issuance is deprecated on a dated schedule with rotation and an overlap
   window.

**Rationale for deferring.** Merging means reissuing credentials to every n8n user — a real blast
radius, for an internal-consistency benefit, at a time when the Partner API itself is not stable.
Sequencing it before v1 GA risks both.

---

### D9 — Publishing: an in-process port with a transactional status seam **(R1, revised)**

**Conflict.** PRD §18 requires provider-neutral publishing ports. `process-post/index.ts` is a
7,202-line monolith with a ten-branch platform switch.

**(R1) Revision.** v1.0 said the port "delegates to the existing `process-post` path" and that the
monolith is untouched. Review round 1 correctly identified two problems:

- **It is not yet a boundary.** Left undefined, an implementer might bridge Edge Function to Edge
  Function over HTTP — which duplicates authentication, timeout, retry and idempotency semantics,
  and is adapter-calling-adapter, contrary to `ARCHITECTURE.md` §12. Importing the entrypoint is
  equally wrong.
- **It cannot emit `post.published` safely.** D5(R1) requires transactional enqueue. A monolith
  that writes its result and *then* notifies has the exact crash gap the outbox exists to close.

**Decision, in three parts.**

1. **The seam is an extracted in-process use case**, not an HTTP call and not an import of
   `index.ts`. The narrow publish-invocation path is extracted into `_shared/` behind
   `PublishPort`; both `process-post`'s entrypoint and the Partner API route call it. Provider
   branches stay where they are.
2. **The status transition and the outbox enqueue happen in one database transaction.** Whatever
   writes the terminal `platform_posts` status also writes the delivery row. This is the minimum
   modification to the legacy path, and it is required — not optional.
3. **No wholesale refactor.** The ten provider branches are untouched by this programme; the
   `process-post` split remains a separate initiative (see the roadmap's Core 1).

**Consequence stated honestly.** v1 publishing inherits `process-post`'s current per-platform
behaviour and failure modes. The port is an *architectural* boundary, not a behavioural
improvement. "No wholesale refactor" is viable; "no required modification" is not.

---

### D10 — Media: reuse the existing pipeline **only against a documented control matrix** **(R1, revised)**

**Decision.** `POST /v1/media` routes through the existing Cloudinary/Openinary pipeline and
returns a Postora `media_file_id`. Partners never receive provider credentials or raw provider
URLs; downloads are served through a Postora-controlled, time-bounded URL.

**(R1) Revision.** v1.0 said "reuse the existing pipeline", which is a routing decision, not a
security contract, and left implementers to invent security-sensitive behaviour. Reuse is
therefore **conditional** on documenting and verifying, before the endpoint ships:

| Control | Must be specified as |
|---|---|
| Max size | A number, per media type |
| Accepted types | An allowlist, validated by **content sniffing**, not by extension or client `Content-Type` |
| Malware handling | Scan-before-availability, with the state machine made explicit |
| Availability semantics | Whether a `media_file_id` is returned before scanning completes, and what a consumer of a not-yet-clean id receives |
| Tenant ownership | Checked on every read and download against bound accounts (D4) |
| Download URL TTL | **A number.** "Temporary" without a number is not a contract |
| Retention and deletion | Stated, including partner-initiated deletion |
| Quota dimension | Storage and transfer metered per PRD §26 |

If any row cannot be answered from the existing pipeline, that gap is implementation work in the
media phase — not an assumption.

---

### D11 — Account selection in REST requests **(R1, new)**

**Gap.** D4 gives a key many accounts, but v1.0 never said how a request selects among them. Left
undefined, every endpoint would invent its own convention and accidental wrong-account or fan-out
sends would become public-contract behaviour.

**Decision.**

| Request kind | Selection rule |
|---|---|
| **Collection reads** (`GET /v1/conversations`) | Default: **all** bound accounts, results carry `account_id`. Optional `?account_id=` narrows. Never an implicit single-account default |
| **Resource reads** (`GET /v1/conversations/{id}`) | Account is derived from the resource; the resource is then checked against the binding. A resource outside the binding returns `resource_not_found`, never `resource_forbidden` — non-enumerable, matching the key-auth precedent |
| **Single-account mutations** (`POST /v1/messages`) | `account_id` is **required and explicit**. There is no default, even when exactly one account is bound. Omitting it is `validation_error`, never a guess |
| **Multi-account publishing** (`POST /v1/posts`) | `targets[]`, each naming an `account_id`. An empty array is `validation_error`; there is no "publish to everything" shorthand |
| **Alias endpoint** | Uses `partner_api_keys.social_account_id` (the primary), which is why that column survives until sunset (D4) |

**Rationale.** Requiring an explicit `account_id` on mutations even when only one account is bound
is deliberate: the alternative silently changes meaning the day a second account is added, and the
failure mode is a message sent from the wrong identity.

---

### D12 — Partner credential lifecycle is in v1 scope **(R1, new)**

**Gap.** §3.3.5 records no minting UI and no rotation, but v1.0 neither specified a lifecycle nor
declared it a non-goal. An implementer would have had to invent who may create keys, how plaintext
is delivered, and how a compromised key is replaced.

**Decision.** Credential lifecycle is **in scope for v1** and blocks GA. A public API cannot be
operated with hand-written production SQL.

Required:

1. **Creation** — workspace owner/admin only, in the Developer area. Plaintext shown exactly once
   and never retrievable, matching the existing `mcp_oauth_tokens` precedent.
2. **Scope and account grant** — explicit at creation; broadening either is a new grant, audited.
3. **Rotation** — issues a new secret with a **bounded overlap window** during which both are
   valid, so a partner can deploy without downtime. Overlap length is configurable and audited.
4. **Revocation** — already implemented as a one-way door (`revoke_partner_key()`); surfaced in
   the UI.
5. **Audit** — every one of the above appends to `partner_audit_logs` with actor, workspace,
   action, target, timestamp and request ID.
6. **Never** does the UI reveal a previously created secret (PRD §48).

---

### D13 — Provider dispatch must be durable before the call **(R1, new)**

**Gap.** §3.3.9 — a crash between Meta accepting a message and the idempotency row being settled
lets a retry take over the expired lease and send the customer a **second real message**.

**Decision.** The no-duplicate guarantee is **withdrawn until this is closed**, and closing it is a
prerequisite for `POST /v1/messages` GA.

**(R2) The tradeoff is unavoidable and must be chosen explicitly.** A durable write and a provider
HTTP call cannot be made atomic. Process death can occur between *any* durable state change and
the provider invocation, so exactly-once is unreachable and the only real choice is which way to
fail:

| Boundary | Guarantee | Failure mode |
|---|---|---|
| Record **after** the call returns | at-least-once | A crash mid-call lets a retry **send a second real message**. This is today's behaviour |
| Record **before** the call | **at-most-once** | A crash between the record and the call abandons a request that was **never sent** |

**Decision: record before the call, and accept at-most-once.** Once the pre-call boundary is
durable, a takeover **must never re-dispatch** — it resolves to `indeterminate`.

**Rationale.** The two failures are not symmetric. An abandoned-but-never-sent message is fully
recoverable: the partner observes `indeterminate`, checks, and re-sends under a *new*
`Idempotency-Key`. A duplicate message to a customer is not recoverable by anyone. Choosing
at-most-once puts the residual risk where a partner can act on it.

Required design:

1. **Persist a dispatch intent before the provider call**, recording that a request is about to be
   issued, with the provider-request identifier where one exists.
2. **Takeover never re-dispatches** past a durable intent. The state machine must be written out
   explicitly, and tested by crashing **both** immediately before and immediately after the
   provider invocation.
3. **Reconciliation** — where the provider offers lookup by client reference, an indeterminate
   record is reconciled rather than left permanently stuck. WhatsApp Cloud exposes no client-side
   idempotency key, so reconciliation is best-effort and the conservative branch is refusal.

**Interim position until built.** The already-deployed `send_template` is documented as
**at-least-once under process failure**, not exactly-once. This is not a resting state: because
that path is live and reachable today (§3.4), closing it is emergency work, not a later phase.

**Why this matters more than it looks.** The rest of the idempotency design is genuinely
rigorous, which makes an unqualified "no duplicates" claim in the developer docs highly credible —
and wrong in exactly the case (customer receives two messages) that damages a partner most.

---

## 7. Target v1 surface

Scoped by §5. Every endpoint requires a scope, is tenant-checked against bound accounts (D4),
resolves its account per D11, and carries a D7 risk class.

```text
Accounts
  GET    /v1/accounts                          accounts:read      · class A
  GET    /v1/accounts/{id}                     accounts:read      · class A

Messaging
  GET    /v1/conversations                     conversations:read · class A
  GET    /v1/conversations/{id}                conversations:read · class A
  GET    /v1/conversations/{id}/messages       messages:read      · class A
  GET    /v1/messages/{id}                     messages:read      · class A
  POST   /v1/messages                          messages:send      · class C · Idempotency-Key · D13
  GET    /v1/templates                         templates:read     · class B (provider-backed)

Media
  POST   /v1/media                             media:write        · class C · Idempotency-Key · D10
  GET    /v1/media/{id}                        media:read         · class A
  GET    /v1/media/{id}/download               media:read         · class B

Publishing
  POST   /v1/posts                             posts:write        · class C
  GET    /v1/posts/{id}                        posts:read         · class A
  GET    /v1/posts/{id}/status                 posts:read         · class A
  POST   /v1/posts/{id}/publish                posts:publish      · class C · Idempotency-Key · D9
  POST   /v1/posts/{id}/schedule               posts:schedule     · class C
  DELETE /v1/posts/{id}/schedule               posts:schedule     · class C

Webhooks
  GET    /v1/webhooks                          webhooks:read      · class A
  POST   /v1/webhooks                          webhooks:manage    · class C
  PATCH  /v1/webhooks/{id}                     webhooks:manage    · class C
  DELETE /v1/webhooks/{id}                     webhooks:manage    · class C
  POST   /v1/webhooks/{id}/rotate-secret       webhooks:manage    · class C
  POST   /v1/webhooks/{id}/test                webhooks:manage    · class C (outbound amplifier)

Usage
  GET    /v1/usage                             usage:read         · class A

Credential lifecycle (D12) — Developer area, user-JWT authenticated, NOT partner-key authenticated

Frozen alias — no new actions, sunset per D1
  POST   /partner-api  {action: get_status | list_templates | send_template}
```

Note that credential lifecycle endpoints are authenticated by a **user JWT**, not a partner key: a
partner key must never be able to mint or broaden another key.

### 7.1 Cross-cutting conventions

- **Pagination:** opaque cursors only. No offset pagination — it is unstable under concurrent
  writes, which conversation and message lists are by definition.
- **IDs:** opaque, prefixed, stable (`acc_`, `conv_`, `msg_`, `post_`, `media_`, `evt_`, `wh_`).
  Provider IDs appear as clearly named separate fields, never as the primary ID.
- **Idempotency:** required where marked, reusing `claim_partner_idempotency` semantics unchanged,
  subject to D13.
- **Unknown fields:** clients must ignore them; additive optional fields are non-breaking.

---

## 8. Data-model delta

All migrations additive.

| Table | Change | Driven by |
|---|---|---|
| `partner_api_key_accounts` | **New.** **Both** composite FKs + `UNIQUE (key_id, social_account_id)` | D4 |
| `partner_api_keys` | `social_account_id` retained `NOT NULL` until alias sunset; add rotation fields (successor key id, overlap expiry) | D4, D12 |
| `partner_webhooks` | **New.** Per-subscription HMAC secret, event filter, platform, account filter, health state | D5 |
| `partner_webhook_deliveries` | **New.** Transactional outbox; `UNIQUE (webhook_id, source_event_id)` | D5 |
| `partner_dispatch_intents` | **New.** Durable pre-provider-call record | D13 |
| `partner_audit_logs` | **New.** Append-only; no `UPDATE`/`DELETE` grant to any role | D12, PRD §30 |
| `partner_api_usage` | Add `meter` dimension; distinguish **reserved / confirmed / indeterminate** | PRD §26, §3.1 |

**Not created in v1:** `partner_applications`, `partner_oauth_clients`, `partner_oauth_grants`,
`partner_installations` — deferred with OAuth (§5).

**Naming.** PRD §40 lists `partner_idempotency_keys`; the existing table is
`partner_api_idempotency`. Per PRD §40's own instruction not to duplicate existing structures for
naming, the existing name stands.

---

## 9. Security requirements

Additional to `ARCHITECTURE.md`, which is required reading for any implementer.

1. **Tenancy is proven in the database, not asserted in code.** Every partner-scoped table carries
   the composite FKs that make a cross-workspace row unrepresentable (D4). Request-time checks
   through a service-role client are defence in depth, **not** the proof — a service-role client
   bypasses RLS by design, so an application check is only as good as the code path taken.
2. **A caller-supplied ID is never trusted.** Resource IDs are checked against the credential's
   resolved allowance on every request; a resource outside it is `resource_not_found` (D11).
3. **Authorization is an intersection** of scope, account binding, and platform capability (D3).
4. **Secrets never in URLs.** Keys in headers; webhook secrets never returned after creation.
5. **A partner key can never mint or broaden a credential** — lifecycle is user-JWT only (D12).
6. **Webhook signing covers the exact raw body**, with timestamp and a documented replay tolerance.
7. **SSRF validation on every webhook destination**, revalidated on every redirect hop — matching
   the hardening in the n8n node's `safeFetchAndStage`. Applies to `POST /v1/webhooks/{id}/test`,
   which is an outbound amplifier (D7 class C).
8. **Redaction on every log path.** Never log keys, tokens, authorization headers, webhook
   secrets, or message bodies.
9. **CORS is not authorization.** `ARCHITECTURE.md` §25 forbids copying `Access-Control-Allow-Origin: *`
   into new authenticated functions by default. The existing `partner-api` uses `*`; for a
   header-authenticated, non-browser API this is defensible, but it must be an explicitly reviewed
   decision recorded in the plan, not inherited by copy-paste into new routes.
10. **The admin UI is not the security boundary.** Backend authorisation is mandatory and
    independent.

---

## 10. Testing and acceptance

Release-blocking, per PRD §46.

**Prerequisite: the gate must actually run.** Per §3.3.8, no Deno test currently executes in CI.
A CI job that discovers and runs `supabase/functions/**/*.test.ts` is a **Phase 0 deliverable**;
until it exists, every "release-blocking" claim below is aspirational.

- **Tenant isolation.** For every resource family, attempt cross-workspace and cross-account access
  with a valid credential. These block release. They are the tests that would catch a D4 join table
  built with only one composite FK.
- **Authentication matrix.** Valid / invalid / revoked / expired / insufficient-scope /
  wrong-account / legacy-scope-not-widened (D3).
- **Idempotency, including SQL-level concurrency.** Duplicate request; same key different body;
  concurrent duplicates; observed-indeterminate; lease takeover after a dead attempt; and the D13
  dispatch-intent path. Unit tests over stubbed clients cannot demonstrate these — they require
  real concurrent transactions against Postgres.
- **Rate limit and quota under concurrency**, including the D7 limiter-unavailable path for one
  operation in each risk class.
- **Webhooks.** Signature; tampered body; timestamp outside tolerance; retry ladder; duplicate
  `event_id`; disabled endpoint; SSRF rejection; and **crash-during-dispatch recovery**, the
  specific property the outbox exists to provide.
- **Contract tests** validating the implementation against the OpenAPI document.
- **One certified end-to-end integration** — external client → Partner API → provider → webhook.

### Definition of done per endpoint

PRD §53's sixteen-point list is adopted unchanged, plus: a declared D7 risk class, a declared D11
account-selection rule, and an OpenAPI entry that CI validates.

---

## 11. Open questions

1. **Danat inventory and migration window.** *Highest-value unknown.* H1/H2 in §3.4 are
   unconfirmed: how many environments hold `pk_live_urCb…`, is there deployed client code, is
   there a dormant retry job, and who owns the coordination? D1, D3 and D7 are affordable only if
   this comes back clean. **This must be answered before any of those three is executed.**
2. **Quota semantics.** Should `current_usage_count` count accepted-only, or accepted-plus-
   indeterminate as today? §8 proposes splitting the counters; the commercial answer is a product
   decision. Related: is quota per-key by hand, or derived from `subscription_plans`? Carried
   forward from the 2026-08-13 spec, open question 3.
3. **`ecommerce-whatsapp-api` disposition.** Deprecate with a sunset once `/v1` messaging is
   stable, or maintain indefinitely? Carried forward from the 2026-08-13 spec, open question 1.
4. **Webhook delivery volume.** The outbox worker's cadence and concurrency need a load estimate,
   currently unknowable — zero webhooks exist.
5. **D13 mechanism.** Whether the dispatch intent is a row in a new table, a state on the
   idempotency row, or a provider-side reference depends on what WhatsApp Cloud exposes. To be
   settled in the messaging phase, not here.

---

## 12. Correction log

Appended, never edited.

### v1.0 — 2026-08-25 — initial draft

Authored from the PRD plus a verification pass over the working tree and production database.
Findings that shaped the draft rather than following from the PRD: the foundation is far more
complete than the PRD assumes (§3.1); the delivery outbox specified on 2026-08-13 was never built
(§3.3.1); exactly one credential exists and has never sent a message (§3.4); the limiter fails
open for billable sends (§3.3.3); two API-key systems exist, one plaintext (D8).

### v1.0a — 2026-08-25 — CI finding

Added §3.3.8 after a separate verification pass: `vite.config.ts:45` scopes vitest to `src/**`, so
every partner-api Deno test is excluded from CI and gates nothing. 30 such tests pass locally in
728ms.

### v1.1 — 2026-08-25 — review round 1 (Codex `gpt-5.6-sol`, high effort)

18 findings, 5 blockers. Verified against source before acceptance; the load-bearing ones
(preflight request-id, the existing `UNIQUE (id, workspace_id)` constraint, the send-path
ordering) were re-checked directly.

**Accepted, changing a decision:**

- **D3 rewritten.** Scope aliasing was privilege escalation: `whatsapp:template.send` authorises
  *template* sending, while `messages:send` covers free-form messages and, under D4, any newly
  bound account. Aliasing withdrawn; the single key is reissued instead. *(blocker)*
- **D4 corrected.** One composite FK is insufficient — it proves the account's workspace, not the
  key's. Both FKs now required, matching the `partner_api_usage` precedent already in the schema.
  *(blocker)*
- **D2 reversed.** v1.0 froze the implemented envelope; since D1 already keeps the alias, `/v1` is
  free to adopt the PRD's structure. It now does, retaining `retryable` as a deliberate
  improvement on the PRD.
- **D7 reclassified.** "Billable vs read" left webhook tests (SSRF amplification), uploads, and
  provider-backed reads uncovered. Replaced with three risk classes.
- **D9 strengthened.** A port that delegates to a monolith is not yet a boundary, and cannot emit
  `post.published` transactionally. Now requires an extracted in-process seam plus same-transaction
  outbox enqueue. *(blocker)*
- **D5 extended.** The outbox alone is insufficient without transactional producers.
- **D6 corrected.** `message.sent` renamed `message.accepted` — the code only knows
  `accepted_by_meta`, and the old name overstated it.
- **D1 sunset fixed.** "Whichever is sooner" could remove the alias while Danat still used it;
  replaced with three conjunctive conditions.
- **D8 given a containment rule** — deferral without one lets the plaintext credential keep
  spreading.
- **D10 made conditional** on a documented control matrix rather than "reuse the pipeline".

**Accepted, adding a decision:**

- **D13 (new).** A crash between Meta accepting and the row settling lets a retry re-send to a
  real customer. The `attempt_token` fence prevents bad *settles*, not double *dispatches*. The
  no-duplicate guarantee is withdrawn until a durable pre-dispatch record exists. *(blocker)*
- **D11 (new).** Account selection was undefined once a key may hold many accounts. *(blocker)*
- **D12 (new).** Credential lifecycle was neither specified nor deferred; a public API cannot be
  operated with hand-written SQL.

**Accepted, correcting a claim:**

- §3.1 quota row — "consumed only by a Meta-accepted send" contradicted the implementation and
  this spec's own indeterminate policy; now states accepted-*or-indeterminate*.
- §3.1 request-id row — narrowed to application responses: the CORS preflight at
  `partner-api/index.ts:70` returns before `requestId` is generated at `:75`.
- §3.1 test status — "well-tested" downgraded; the tests do not run in CI and cannot demonstrate
  SQL concurrency.
- §3.4 — conclusions downgraded to hypotheses H1/H2. One credential does not prove one consumer,
  one deployment, or one environment.
- §5 — Contacts and n8n convergence moved from conditional prose into the non-goals table with
  re-entry criteria.

**Not accepted:**

- The reviewer's suggestion to drop `retryable` in favour of strict PRD conformance. The PRD's
  envelope is silent on retryability, which pushes a transient-vs-permanent classification table
  onto every integrator. Retained deliberately and documented as an intentional divergence (D2).

### v1.2 — 2026-08-25 — plan review round 1, spec consequences

Reviewing the implementation plan surfaced two defects in the spec itself:

- **D13 rewritten.** The plan review correctly showed that "distinguish never-dispatched from
  dispatched-unknown" is not achievable as stated: process death can occur between *any* durable
  write and the provider call, so exactly-once is unreachable. The spec now names the tradeoff
  explicitly and **chooses at-most-once** (record before the call, never re-dispatch), on the
  grounds that an abandoned-never-sent message is recoverable by the partner and a duplicate
  customer message is not. The interim wording is also corrected: because `send_template` is
  deployed and reachable *today*, closing this is emergency work, not a later phase.
- **D8 given an enforcement hook.** The containment rule existed only as prose and in the plan's
  risk register, so no phase could fail because of it. It is now a mechanical exit criterion on
  every endpoint-delivering phase.

Also corrected: the `partnerApiKeys.ts` non-enumerable-error citation, `:81` → `:85`.

=============== END OF INLINED MATERIAL. Produce round 2 findings now. No tool calls. ===============
