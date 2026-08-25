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
