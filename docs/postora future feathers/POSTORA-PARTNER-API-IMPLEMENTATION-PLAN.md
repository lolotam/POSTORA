# Postora Partner API — Implementation Plan

**Status:** Draft for review · **Version:** 1.0 · **Date:** 2026-08-25
**Specification:** `docs/postora future feathers/POSTORA-PARTNER-API-SPEC-v1.md` (v1.1)
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

Three ordering rules, applied in this priority:

1. **Anything that makes a false claim true comes first.** The spec declares tests
   release-blocking that do not run (§3.3.8), and a no-duplicate guarantee that a crash can break
   (§3.3.9, D13). Work that closes a gap between what Postora says and what Postora does outranks
   work that adds surface.
2. **Anything that is cheap now and expensive later comes early.** D1 (REST shape), D3 (scope
   vocabulary) and D7 (limiter policy) are affordable only while the hypotheses in spec §3.4 hold.
   Their cost rises the day Danat goes live.
3. **Anything that would have to be rebuilt if done in the wrong order comes before its
   dependents.** The D4 join table precedes D11 account selection; the D9 seam precedes
   `post.published`; the outbox precedes any public webhook endpoint.

Phases are independently shippable. The programme can stop at any phase boundary and leave a
coherent product — this is a hard constraint on how each phase is scoped, not an aspiration.

---

## 2. Dependency graph

```text
  P0 Prerequisites ──────────────────────────────────────────┐
   │  (CI gate · Danat inventory · OpenAPI skeleton)          │
   │                                                          │
   ├──► P1 Foundation hardening ──┬──► P2 Read surface ──┐    │
   │    (D2 D4 D7 D12 audit)      │    (accounts, convs) │    │
   │                              │                      │    │
   │                              └──► P3 Send path ─────┤    │
   │                                   (D13 · messages)  │    │
   │                                                     │    │
   └──► P4 Webhook platform ◄────────────────────────────┘    │
        (outbox · D5 D6)                                      │
             │                                                │
             └──► P5 Publishing ──► P6 Media ──► P7 GA ◄──────┘
                  (D9 seam)          (D10)       (docs·certify)
```

**Hard blocks:**

| This | cannot start before | Because |
|---|---|---|
| Any "release-blocking test" claim | P0 CI gate | Spec §3.3.8 — no Deno test runs in CI today |
| Executing D1 / D3 / D7 | P0 Danat inventory | Spec §3.4 H1/H2 are unconfirmed hypotheses |
| P2 account selection (D11) | P1 join table (D4) | Selection is meaningless with one pinned account |
| `POST /v1/messages` GA | P3 dispatch durability (D13) | Otherwise Postora ships a guarantee a crash breaks |
| Any public webhook endpoint | P4 outbox (D5) | Fire-and-forget loses events permanently |
| `post.published` / `post.failed` events | P5 seam (D9) | Events must enqueue in the status transaction |
| GA | P1 lifecycle (D12) | Partners cannot be onboarded by hand-written SQL |

---

## 3. Phases

### Phase 0 — Prerequisites

**Goal.** Make the programme's claims checkable, and confirm the assumptions the cheap decisions
rest on. Nothing here is user-visible; everything here gates something later.

| # | Deliverable | Spec ref | Notes |
|---|---|---|---|
| 0.1 | **CI job running `deno test` over `supabase/functions/**`** | §3.3.8, §10 | `vite.config.ts:45` scopes vitest to `src/**`. The 30 existing partner-api tests pass locally in **728ms**, so this is a near-free CI addition — it is a wiring gap, not a test-writing effort |
| 0.2 | **Danat credential inventory** | §3.4 H1/H2, §11.1 | How many environments hold `pk_live_urCb…`; is there deployed client code; any dormant retry job; who owns coordination. **Blocks D1/D3/D7** |
| 0.3 | OpenAPI 3.1 skeleton + CI validation | §3.3.4, PRD §31 | Servers, security schemes, scopes, error component, pagination, rate-limit headers. No endpoints yet |
| 0.4 | Contract-drift CI gate | PRD §47 | Fails when implementation and OpenAPI disagree, and when a breaking change lands without a version bump |
| 0.5 | Security threat review of the v1 surface | PRD §50 Phase 0 | Sign-off recorded, including the §9.9 CORS decision |
| 0.6 | Decide `Access-Control-Allow-Origin` policy for `/v1` | §9.9 | `ARCHITECTURE.md` §25 forbids inheriting `*` by copy-paste. For a header-authenticated non-browser API `*` is defensible — but it must be reviewed and recorded, not inherited |

**Exit criteria.** CI fails if a partner-api Deno test fails. OpenAPI validates in CI. The Danat
inventory is written down and H1/H2 are either confirmed or replaced with what is actually true.

**Risk.** 0.2 depends on an external party. If Danat cannot be reached, D1/D3/D7 must be re-costed
assuming an unknown number of deployed consumers — which likely means a longer alias window rather
than abandoning the decisions.

---

### Phase 1 — Foundation hardening

**Goal.** Fix what is wrong or missing in the existing foundation, before building surface on top
of it. No new endpoints except credential lifecycle.

| # | Deliverable | Spec ref |
|---|---|---|
| 1.1 | `partner_api_key_accounts` with **both** composite FKs and `UNIQUE (key_id, social_account_id)`; backfill one row per key | D4 |
| 1.2 | `partner_audit_logs`, append-only — no `UPDATE`/`DELETE` grant to any role | D12 |
| 1.3 | Credential lifecycle: create / rotate-with-overlap / revoke, in the Developer area, **user-JWT authenticated** | D12 |
| 1.4 | Risk-class enforcement in the limiter: A fails open, B and C fail closed with `503 limiter_unavailable` + `Retry-After` | D7 |
| 1.5 | `X-RateLimit-Limit` / `-Remaining` / `-Reset` on every response | §3.3.2 |
| 1.6 | Split usage counters: reserved / confirmed / indeterminate | §3.1, §8 |
| 1.7 | Legacy scopes pinned at current capability; **never** widened. Reissue the Danat key with generic scopes | D3 |

**Exit criteria.** A tenant-isolation test proves a key cannot reach an account outside its
bindings. A test proves a legacy-scope key cannot send a free-form message. Rotation is
demonstrated with a real overlap window. Every lifecycle action writes an audit row.

**Risks.**

- **1.4 changes shipped behaviour.** The limiter currently fails open for sends
  (`partnerApiMetering.ts:84`). This is safe to change *now* only because `send_template` has never
  run in production. Ship it before Danat's first send, or it becomes a behaviour change under
  live traffic.
- **1.1 is the highest-consequence migration in the programme.** A join table with one composite
  FK instead of two silently loses the cross-workspace guarantee (D4). The tenant-isolation test in
  the exit criteria exists specifically to catch that, and must be written to fail against a
  single-FK implementation.
- **1.7 touches the only live credential.** Coordinate with the Danat inventory from 0.2.

---

### Phase 2 — Read surface

**Goal.** Ship the `/v1` REST shape with read-only endpoints. Establishes routing, pagination,
account selection, and the error envelope with no side effects at risk.

| # | Deliverable | Spec ref |
|---|---|---|
| 2.1 | `/v1` router; alias endpoint refactored to call the same use cases | D1 |
| 2.2 | `/v1` error envelope; `X-Postora-Request-Id` on every response including successes | D2 |
| 2.3 | `GET /v1/accounts`, `/v1/accounts/{id}` | §7 |
| 2.4 | `GET /v1/conversations`, `/{id}`, `/{id}/messages`, `GET /v1/messages/{id}` | §7 |
| 2.5 | Account selection implemented per the D11 table, including non-enumerable `resource_not_found` | D11 |
| 2.6 | Opaque cursor pagination; prefixed opaque IDs | §7.1 |
| 2.7 | `GET /v1/usage` | §7 |
| 2.8 | OpenAPI entries + contract tests for all of the above | PRD §31 |

**Exit criteria.** Contract tests pass against OpenAPI. Cross-workspace and cross-account reads
return `resource_not_found`, not `resource_forbidden`. The alias returns byte-identical responses
to before — proving the refactor onto shared use cases changed nothing for Danat.

**Deliberately not in this phase.** No sends, no writes. If the programme stops here, Postora has
a coherent read-only Partner API and has broken nothing.

---

### Phase 3 — Send path

**Goal.** `POST /v1/messages`, with the duplicate-send gap closed first.

| # | Deliverable | Spec ref |
|---|---|---|
| 3.1 | **Settle the D13 mechanism** — dispatch intent as its own table, a state on the idempotency row, or a provider reference. Decide against what WhatsApp Cloud actually exposes | D13, §11.5 |
| 3.2 | Durable pre-dispatch record written **before** the provider call | D13 |
| 3.3 | Takeover distinguishes "claimed, never dispatched" (retry safe) from "dispatched, outcome unknown" (must not re-dispatch) | D13 |
| 3.4 | Reconciliation for indeterminate records where the provider permits lookup; conservative refusal where it does not | D13 |
| 3.5 | `POST /v1/messages` — text first, then image / video / audio / document / template | §7 |
| 3.6 | `unsupported_capability` for platform/type combinations that do not exist | PRD §15.4 |
| 3.7 | `GET /v1/templates` (class B, provider-backed) | §7 |

**Exit criteria.** A test that **kills the process between provider acceptance and settlement**,
then retries with the same `Idempotency-Key`, and asserts no second provider call. Until that test
exists and passes, the developer docs say *at-least-once under process failure* (D13 interim
position) and do not claim exactly-once.

**Risks.**

- **3.1 may find no clean mechanism.** WhatsApp Cloud offers no client-side idempotency key. If
  reconciliation proves impossible, the honest outcome is to keep the interim position permanently
  and document the crash window — not to quietly claim exactly-once. Decide this explicitly rather
  than letting it default.
- This is the first phase where a bug reaches a real customer. It follows Phase 2 so that routing,
  auth and tenancy are already proven before anything sends.

---

### Phase 4 — Webhook platform

**Goal.** The event product, on durable delivery. This is where the PRD's biggest unbuilt promise
gets its foundation.

| # | Deliverable | Spec ref |
|---|---|---|
| 4.1 | `partner_webhooks` — per-subscription HMAC secret, event filter, platform, account filter, health state | D5 |
| 4.2 | `partner_webhook_deliveries` outbox; `UNIQUE (webhook_id, source_event_id)` | D5 |
| 4.3 | Worker: `FOR UPDATE SKIP LOCKED` + lease; backoff 1m/5m/30m/2h/6h; auto-disable only after exhaustion | D5 |
| 4.4 | **Transactional enqueue at every producer** — the event row is written in the same transaction as the state change it reports | D5(R1) |
| 4.5 | Canonical headers: `X-Postora-Event`, `-Timestamp`, `-Event-Id`, `-Signature: sha256=…` | PRD §22.2 |
| 4.6 | Webhook CRUD + rotate-secret + test, all class C, all SSRF-validated per redirect hop | D7, §9.7 |
| 4.7 | Messaging and account events only — `message.accepted` (**not** `message.sent`), `.received`, `.delivered`/`.read`/`.failed`, `account.*` | D6 |
| 4.8 | Per-event documentation of latency and of modes where the event is unavailable (e.g. delivery status absent in Evolution QR) | D6 |

**Exit criteria.** A crash-during-dispatch test recovers the event. A duplicate `event_id` is
delivered at-least-once and the docs tell partners to deduplicate. SSRF rejection is proven,
including on redirect. The retry ladder is observed end to end.

**Deliberately not in this phase.** `post.*` events — they need the Phase 5 seam. Shipping the
webhook platform without them is coherent; shipping them without a transactional producer is not.

---

### Phase 5 — Publishing

**Goal.** Publishing endpoints, plus the narrow seam that lets publishing emit events truthfully.

| # | Deliverable | Spec ref |
|---|---|---|
| 5.1 | Extract the narrow publish invocation into `_shared/` behind `PublishPort` — **in-process, not an HTTP bridge, not an import of `index.ts`** | D9 |
| 5.2 | `process-post`'s entrypoint calls the same port, so there is exactly one publish path | D9 |
| 5.3 | Terminal `platform_posts` status transition and outbox enqueue in **one transaction** | D9, D5(R1) |
| 5.4 | `POST /v1/posts`, `GET /{id}`, `GET /{id}/status` | §7 |
| 5.5 | `POST /{id}/publish` (Idempotency-Key), `POST`/`DELETE /{id}/schedule` | §7 |
| 5.6 | Multi-account `targets[]` per D11, with per-target status | D11 |
| 5.7 | `post.published` / `post.failed` / `post.scheduled` events | D6 |

**Exit criteria.** A publish through `/v1` and a publish through the existing UI take the same code
path. A crash after a platform result is written still delivers `post.published`. Per-target status
is visible when one platform succeeds and another fails.

**Risks.**

- **5.1 is the riskiest extraction in the programme.** It touches the most business-critical
  function in the product (`process-post/index.ts`, 7,202 lines, ten platform branches). Scope
  discipline is the mitigation: extract the *invocation*, not the branches. If the extraction
  starts growing into the provider logic, stop — that is the separate Core 1 refactor.
- v1 publishing **inherits `process-post`'s current failure modes** (spec D9). The port is an
  architectural boundary, not a behavioural fix. Do not let the plan imply otherwise in partner
  docs.

---

### Phase 6 — Media

**Goal.** Partner uploads, against an explicit security contract.

| # | Deliverable | Spec ref |
|---|---|---|
| 6.1 | **Fill in the D10 control matrix first** — max size per type, sniffed content allowlist, scan-before-availability, availability semantics, tenant ownership, download TTL as a number, retention/deletion, quota dimension | D10 |
| 6.2 | Any matrix row the existing pipeline cannot satisfy becomes implementation work in this phase | D10 |
| 6.3 | `POST /v1/media` (class C, Idempotency-Key) | §7 |
| 6.4 | `GET /v1/media/{id}`, `GET /{id}/download` via Postora-controlled time-bounded URL | §7 |
| 6.5 | Media association with posts and messages | §7 |

**Exit criteria.** Every control-matrix row is answered with a number or a named mechanism. A file
whose extension and real content disagree is rejected. A download URL expires at the documented
TTL. No provider URL or credential is ever returned.

**Risk.** 6.1 may reveal that the existing pipeline has no malware scanning at all. If so, that is
a finding to surface and decide on — not a gap to paper over by shipping the endpoint.

---

### Phase 7 — GA

**Goal.** Make it usable by someone who does not work at Postora.

| # | Deliverable | Spec ref |
|---|---|---|
| 7.1 | Developer documentation per PRD §32, with fake credentials and synthetic data | PRD §32 |
| 7.2 | Postman collection generated from OpenAPI; no production secret committed | PRD §33 |
| 7.3 | Changelog and deprecation policy published | PRD §43–44 |
| 7.4 | Staging environment with environment-specific credentials; a staging key must not authenticate against production | PRD §45 |
| 7.5 | **One certified end-to-end integration** — external client → `/v1` → provider → webhook | PRD §46.8 |
| 7.6 | Documented divergences from the PRD: the `retryable` field (D2), and the D13 delivery guarantee in whatever form it lands | D2, D13 |
| 7.7 | Alias sunset process armed: telemetry on alias traffic, per D1's three conjunctive conditions | D1 |

**Exit criteria.** PRD §52's GA list, with two amendments: the "idempotency works for side effects"
item is read against D13's actual outcome rather than an assumed exactly-once, and "quotas and rate
limits are concurrency-safe" requires the Phase 0 CI gate to be running the tests that prove it.

---

## 4. Risk register

| Risk | Phase | Impact | Mitigation |
|---|---|---|---|
| D4 join table built with one composite FK | 1 | **Silent cross-workspace access.** The worst available outcome | Tenant-isolation test written to fail against a single-FK implementation; explicit review of the migration |
| D13 has no clean mechanism on WhatsApp Cloud | 3 | Exactly-once cannot be promised | Decide explicitly; keep the interim at-least-once wording permanently rather than overclaiming |
| `PublishPort` extraction grows into the monolith | 5 | Programme absorbs a 7,000-line refactor | Extract the invocation only; stop and escalate if provider branches are touched |
| Danat unreachable for 0.2 | 0 | D1/D3/D7 lose their justification | Re-cost with a longer alias window; do not execute on unconfirmed hypotheses |
| Limiter fail-closed lands after Danat's first send | 1 | A behaviour change under live traffic | Sequence 1.4 before Danat go-live; it is cheap now and not later |
| Media pipeline has no malware scanning | 6 | A security gap becomes a public endpoint | 6.1 is a precondition, not a checklist item; surface the finding rather than shipping |
| `profiles.api_key` spreads to new surfaces | all | The weaker credential outlives its deprecation | D8 containment rule is a review gate on every PR that adds an integration point |
| Concurrent branch resets drop work | all | Committed work disappears from `main` | Observed in this repository on 2026-08-25: commit `92cbe138` was dropped from `main` by a concurrent sync. Work on feature branches; verify `git log` after any sync |

---

## 5. What this plan deliberately does not do

Stated so that absence reads as a decision rather than an oversight. Each maps to a spec §5
non-goal with re-entry criteria.

- **No OAuth, applications, or installations.** No v1 consumer needs them.
- **No SDKs.** Generating from a moving contract produces churn.
- **No Stripe wiring.** Metering is billing-*ready*; billing is not v1.
- **No analytics endpoints.** They would be built on a warehouse that does not exist.
- **No AI endpoints.**
- **No contacts endpoints** until a named consumer requires them.
- **No n8n node migration** onto `/v1`.
- **No `profiles.api_key` convergence** — deferred, but contained by D8.
- **No `process-post` refactor** beyond the narrow Phase 5 extraction.

---

## 6. Per-phase working agreement

Applies to every phase, whether implemented directly or delegated.

1. **`ARCHITECTURE.md` is required reading**, named explicitly in any delegation brief along with
   the specific rule sections in play (§12 Edge Function shape, §13 prohibitions, §24 service role,
   §25 CORS, §26 external HTTP, §27 background work). Nothing auto-loads it.
2. **Migrations are additive.** Production schema evolution never drops or repurposes a column in
   this programme.
3. **Guard passes before commit:** `clean-code-guard` on changed production code, `test-guard` on
   changed tests, `docs-guard` on changed developer documentation.
4. **An endpoint is not done until it satisfies the spec §10 definition of done** — PRD §53's
   sixteen points plus a declared D7 risk class, a declared D11 selection rule, and a CI-validated
   OpenAPI entry.
5. **Edge function changes deploy via `ssh-contabo-mcp`**, per `CLAUDE.md` step 7 and
   `docs/runbooks/deploy-edge-function.md`. `npx supabase functions deploy` targets Supabase Cloud
   and fails against this self-hosted stack.
6. **No phase claims a guarantee it has not tested.** This is the rule D13 exists to enforce, and
   it applies generally.

---

## 7. Open items carried from the spec

These block or shape phases and are not resolved by this plan:

| # | Question | Blocks | Spec ref |
|---|---|---|---|
| 1 | Danat inventory: how many environments, is there deployed client code, who coordinates? | D1/D3/D7 execution — i.e. Phases 1 and 2 | §11.1 |
| 2 | Quota semantics: accepted-only, or accepted-plus-indeterminate? Per-key or plan-derived? | 1.6 | §11.2 |
| 3 | `ecommerce-whatsapp-api`: deprecate with a sunset, or maintain? | Post-GA | §11.3 |
| 4 | Webhook delivery volume — worker cadence and concurrency | 4.3 sizing | §11.4 |
| 5 | D13 mechanism against what WhatsApp Cloud actually exposes | 3.1, and therefore Phase 3 | §11.5 |

Item 1 is the one to resolve first. It is external, it gates two phases, and everything else can
proceed in parallel with chasing it.
