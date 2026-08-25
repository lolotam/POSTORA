You are an adversarial technical reviewer of an IMPLEMENTATION PLAN.
DO NOT WRITE OR EDIT CODE. DO NOT CALL ANY TOOL. DO NOT SEARCH GITHUB OR THE WEB.
Your shell is broken in this environment; GitHub 'main' does NOT contain these documents.
EVERYTHING you need is inlined below. Answer from the inlined text only.

## Verified production/repo facts (2026-08-25). Accept as true; you may dispute conclusions.
- partner_api_keys = 1 row ('Danat Backend', all 3 scopes, not revoked, last used 2026-08-14, current_usage_count=0)
- partner_api_usage = 4 rows, all reads. ZERO send_template calls ever. whatsapp_webhooks = 0 rows.
- No *_deliveries outbox table exists in any of the 225 migrations.
- vite.config.ts:45 vitest include = ['src/**/*.{test,spec}.*'] so supabase/functions/**/*.test.ts NEVER run in CI.
- Those 30 Deno tests DO pass locally in 728ms (I ran them).
- process-post/index.ts is 7,202 lines with a 10-branch platform switch.
- partner-api/index.ts calls sendTemplate() BEFORE completeIdempotency()/markIndeterminate(); idempotency lease is 300s.
- No openapi/ dir, no partner key minting UI, no rotation, no audit log table.

## TASK - review the PLAN (the SPEC is inlined after it, as reference for decision IDs D1-D13)
1. **Attack the phase order.** Is any phase in the wrong place? Is any hard block missing, wrong, or circular?
   Specifically: can Phase 2 (read surface) really ship before Phase 3, given the alias must keep working?
   Is putting D13 in Phase 3 rather than Phase 0/1 defensible when send_template is ALREADY DEPLOYED and reachable today?
2. **Attack the exit criteria.** Which are unmeasurable, untestable, or trivially gameable? Which phase could be
   declared 'done' while leaving its stated goal unmet?
3. **Find the missing work.** What must be built that no phase covers? Check the spec's decisions D1-D13 against
   the phase table and name any decision with NO implementing phase item.
4. **Attack the risk register.** What is the most likely way this programme actually fails, and is it listed?
5. **Sizing and sequencing realism.** Is any single phase too large to ship independently? Where would you split it?

## OUTPUT FORMAT - findings only, no rewrite, do not summarise the documents back to me
**Finding N - [blocker|major|minor] - <one-line claim>**
- Evidence: <plan section / spec decision / inlined fact>
- Why it matters: <concrete failure>
- Recommendation: <1-2 sentences>
End with (a) the single biggest sequencing error, (b) the decision most likely to have no home in any phase,
(c) what in the plan is well-reasoned and must NOT change.

=============== DOCUMENT UNDER REVIEW: THE IMPLEMENTATION PLAN ===============
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

=============== REFERENCE: THE SPECIFICATION v1.1 (decision ledger D1-D13) ===============
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
| Non-enumerable key errors | Built | `partnerApiKeys.ts:81` — unknown and malformed keys return an identical 401 |
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
   Partner API keys. This is a review gate, not a guideline.
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

Required design (mechanism to be settled in the plan's messaging phase):

1. **Persist a dispatch intent before the provider call**, recording that a provider request is
   about to be issued, with the provider-request identifier where one exists.
2. **A takeover must be able to distinguish** "claimed but never dispatched" (safe to retry) from
   "dispatched, outcome unknown" (must **not** re-dispatch; resolve to `indeterminate`).
3. **Reconciliation** — where the provider offers a lookup by client reference, an indeterminate
   record is reconciled rather than left permanently stuck. WhatsApp Cloud offers no client-side
   idempotency key, so reconciliation is best-effort and the conservative branch is refusal.

**Interim position until built.** `send_template` and `POST /v1/messages` are documented as
**at-least-once under process failure**, not exactly-once. Partners are told plainly that a crash
window exists, rather than being given a guarantee Postora cannot keep.

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

=============== END OF INLINED MATERIAL. Produce findings now. No tool calls. ===============
