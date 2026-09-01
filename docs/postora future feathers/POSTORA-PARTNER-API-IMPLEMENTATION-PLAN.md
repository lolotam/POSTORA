# Postora Partner API — Implementation Plan

**Status:** Execution started 2026-08-30 · **Version:** 1.3 · **Date:** 2026-08-25, progress log 2026-08-30
**Specification:** `docs/postora future feathers/POSTORA-PARTNER-API-SPEC-v1.md` (v1.3)
**Source PRD:** `docs/postora future feathers/POSTORA_PARTNER_API_PRD_v1.0.md`
**Progress:** see §0 below — deliverables are marked there, not inline in the phase tables.

> **No code is written by this document.** It orders work, states what blocks what, and defines
> when each phase is done. Contracts and rationale live in the spec; this plan references decision
> IDs (D1–D13) rather than restating them.
>
> **Every implementer of every phase must read `ARCHITECTURE.md` first.** Nothing auto-loads it,
> and a delegation brief that omits it produces work nothing catches until human review.

---

## 0. Progress log

Execution began 2026-08-30. This section is the single place a deliverable's status is recorded —
the phase tables below are left as written so the plan and its progress do not drift into two
versions of the same claim.

**A deliverable is only marked done here if it has evidence.** "Rehearsed" means applied to a
throwaway clone of the production schema, never to production. "Live" means applied to production
and verified by querying the catalog afterwards.

### Landed

> **Deployment status as of 2026-09-01.** Everything below is **live in production**: `main` was
> deployed to the functions volume on 2026-08-31, all four changed files SHA256-verified against
> git, `functions` and `ai-knowledge-excel-worker` restarted, healthcheck 200, and `partner-api`
> probed live (401 `invalid_key` / 405 `method_not_allowed`, with **no** `X-RateLimit-*` on the
> pre-auth failure — the documented omission, confirmed against production).
>
> The deploy ran **by hand via `ssh-contabo-mcp`**, replicating
> `.github/workflows/deploy-edge-functions.yml` step for step, because GitHub Actions stopped
> dispatching jobs at ~16:16 UTC on 2026-08-31 (billing: *"recent account payments have failed or
> your spending limit needs to be increased"*). Jobs fail at startup in ~3s with zero steps; the
> message is only in the check-runs annotations API. **CI has not run since.**
>
> **One thing is NOT applied: the 1.3 migration.** See its row below.

| # | Deliverable | Evidence |
|---|---|---|
| 0.4 | CI job running `deno test` over `supabase/functions/**` | **Already done before this plan was written.** PR #67 added the `edge-functions` job to `.github/workflows/test.yml`. The plan was stale in its own favour |
| 0.12 | Danat credential inventory | Done 2026-08-30 — see "What the inventory found" below |
| 1.1 | `partner_api_key_accounts`, both composite FKs, `UNIQUE (key_id, social_account_id)`, backfill | PR #70. **Live** — both FKs confirmed in `pg_constraint`, backfill mirrors the one existing key |
| 1.2 | `partner_audit_logs`, append-only | PR #70. **Live** — `anon` holds nothing, `authenticated` SELECT, `service_role` INSERT+SELECT. Note it had **zero writers** until 1.3 |
| 1.4 | Risk-class enforcement: A fails open, B and C fail closed with `503 limiter_unavailable` + `Retry-After` | PR #70. **Live since 2026-08-31** — `ACTION_RISK_CLASSES` confirmed present in the deployed `partner-api/router.ts`. Was "merged, not deployed" for a day |
| 0.1, 0.2 | **0A safety suspension.** `send_template` returns a typed `temporarily_unavailable`; the key `pk_live_urCb` is revoked | PR #72. **Live** — refusal verified in the deployed volume, ordering confirmed (scope → suspension → account) |
| 0.3 | Postgres integration harness | PR #74. **In CI** — see "0.3, and what it found" below. Note CI cannot currently run (billing) |
| — | Least-privilege grants on the four foundation tables | PR #72. **Live** — `anon` now holds zero grants on any partner table; every production access path re-verified as `service_role` |
| 1.5 | `X-RateLimit-*` with defined response classes | PR #70. **Live since 2026-08-31** — `consume_partner_rate_v2` confirmed in the deployed `_shared/partnerApiMetering.ts`. The omission on pre-auth failures verified against live production |
| 0.7 | OpenAPI 3.1 skeleton — `docs/api/openapi.yaml` | PR #91. Servers, `x-postora-key` security scheme, 14 generic + 3 legacy scopes, 23 error codes, cursor pagination, rate-limit headers. No endpoints (`/v1` has none). **Found a FOURTH drift**: `unsupported_direct_qr` was emitted by `whatsappPartnerOps.ts:221` and listed nowhere |
| 0.8 | Contract-drift gate | PR #91. `scripts/check-openapi-drift.ts` + committed baseline + `contract-drift` CI job. R1 field removal / R2 type narrowing / R3 enum removal / R4 required-field addition; acknowledgement ids carry the transition, so an ack authorises one change only; stale acks also fail. **`info.version` is never read** — verified by mutation (a break plus a version bump still fails). Descends into path operations, resolves `$ref`, and handles the boolean `required` on Parameter Objects |
| 0.5 | Runtime contract tests | PR #91. Six runtime tests reading the document and checking it against the real handler, **plus a source-side sweep** asserting every code the partner surface can emit is documented — the runtime tests sample, the sweep enumerates. The sweep fails if it finds fewer than 15 codes, so a regex that stops matching cannot masquerade as a clean result |
| 1.6 | Legacy scope pinning | PR #93. **Live** — `_shared/partnerScopes.ts` confirmed in the deployed volume. Per-ACTION satisfying sets, never a vocabulary mapping. `whatsapp:webhooks.manage` is an explicit EMPTY capability. New keys may hold only generic scopes — **no migration needed**, since D3 step 2's reissue has no subject with zero active keys |
| 1.3 | Credential lifecycle (D12), closing F11 and the F3 residual | PR #94. Code **merged and live**; ⚠️ **the migration is NOT applied to production** — `supabase/migrations/20260831170000_partner_api_credential_lifecycle.sql` is the owner's to apply. One nullable column (`superseded_by_key_id`) + three `SECURITY DEFINER` RPCs; rotation reuses `expires_at` rather than adding a second validity rule. **Rehearsed twice** against `supabase/postgres:17.6.1.158` restored from the production baseline, the second time on the final merged tree: harness exit 0, P1–P11 pass, suite mutation-tested. Nothing in production depends on it — it touches no edge function, and only the two operator scripts call its RPCs |
| 2.1 | `/v1` router — path routing, method validation, `X-Postora-Request-Id` on every response | PR #105. **Live** — auto-deployed by `.github/workflows/deploy-edge-functions.yml` (billing restored 2026-09-01, the workflow path is active again) and probed on production: an unmatched `/v1` path returns the D2 envelope with the header id equal to the body's `request_id`, and the alias still answers its own envelope unchanged. Reached by path inside the SAME function; `/v1x` deliberately does not match |
| 2.2 | D2 error envelope, one construction site | PR #105. **Live** — `V1_ERROR_POLICY` pins status/`retryable`/message for all 24 codes; `V1ErrorCode` derives from the table so a misspelled code will not compile; `details` omitted rather than null. `resource_not_found` moved from documented-but-unreachable into the enum, and the baseline was regenerated in a second commit so it is now R3-protected |
| 3.1 | Settle the D13 state machine against what WhatsApp Cloud exposes | PR #108. Research, not implementation — the plan permits it to end the phase. **Verdict: proceed.** Found a reconciliation channel the spec's "no client-side lookup" premise missed: Meta echoes `biz_opaque_callback_data` back in status webhooks. No idempotency key exists, so D13 R2's at-most-once decision stands. Record: `docs/decisions/2026-09-01-d13-dispatch-state-machine.md` |
| 3.2 | Durable dispatch intent written **before** the provider call | PR #111. Migration `20260901120000_partner_dispatch_intents.sql` — **applied to production 2026-09-01**, verified by catalog: table, 3 triggers, 7 constraints, 5 indexes, `anon` holds nothing. `UNIQUE (key_id, idempotency_key)` makes at-most-once structural rather than procedural |
| 3.3 | Takeover **never re-dispatches**; resolves to `indeterminate` | PR #111. A takeover is any attempt whose intent INSERT conflicts, and it never touches a fetcher. Crash-verified with a real `Worker.terminate()`: abort **before** the provider call → 0 calls, retry 0 additional; abort **after** → 1 call, retry **0 additional**. Mutation-verified by the orchestrator — removing the guard fails both crash tests at the provider-call-count assertion |
| 3.4 | Reconciliation where the provider permits it; conservative refusal where it does not | PR #111. `sendTemplate`/`sendText` stamp the intent id as `biz_opaque_callback_data`; the status webhook resolves intents by the echoed value. **One-directional by construction**: `indeterminate → reconciled_sent` exists, no path toward re-dispatch, and silence resolves nothing. Invariant 4 is a **database trigger**, not a convention |
| 3.5 | `POST /v1/messages` — text and template only | PR #113. **Text was new provider surface** — `sendTemplate` had been the only send here. Both arms now run behind a private `performSend` inside the durable core, deliberately unexported so a route cannot reach the provider without an intent. Ships **behind** `SEND_TEMPLATE_SUSPENDED`, through the same flag as the alias |
| 3.6 | `unsupported_capability` for platform/type combinations that do not exist | PR #113. Checked **before** the suspension: a misspelled type is a permanent fact about the request, and `temporarily_unavailable` would send a partner away to wait for something that will never work. Enum + policy table + baseline regenerated, so removing it now fires an R3 finding |
| 3.7 | `GET /v1/templates` (class B); alias convergence | PR #113. Both doors read one policy table for scope and risk class — D1 convergence is a shared implementation underneath, deliberately **not** a shared envelope (D2). Fails CLOSED on a limiter outage |
| 2.3 | `GET /v1/accounts`, `/v1/accounts/{id}` | PR #115. Lists the key's **binding**, which may be a strict subset of the workspace's accounts — the map every other `/v1` read is scoped to. Not paginated: the binding is bounded server-side and REFUSES rather than truncates, because a silently truncated tenancy set shows up as accounts that exist in the UI and not in the API |
| 2.4 | `GET /v1/conversations`, `/{id}`, `/{id}/messages`, `GET /v1/messages/{id}` | PR #115. **WhatsApp-only, and it refuses the rest explicitly**: `messaging_cache` is cross-platform but per-message rows are split — WhatsApp in `whatsapp_messages`, Meta DMs in `social_inbox_events` (`src/hooks/useMessaging.ts:178`), different shapes, no common row. A bound non-WhatsApp account answers `unsupported_capability`, never an empty page a partner cannot tell from a quiet inbox |
| 2.5 | Account selection per D11, with non-enumerable `resource_not_found` | PR #115. Tenancy anchors on `partner_api_key_accounts`, **never** on `partner_api_keys.social_account_id` — those hold the same value in production, so almost any test passes against the wrong one. Test T1 makes them different accounts deliberately. No fallback for an empty binding: an unbound key reads nothing. A malformed id 404s **without touching the database**, so a typo is neither a 500 nor an existence oracle |
| 2.6 | Opaque cursor pagination; prefixed opaque ids | PR #115. Keyset on the **pair** (timestamp, id) — history sync makes microsecond collisions routine, and a timestamp-only cursor would re-emit a colliding group or drop all but one of it. Over-fetch `limit + 1`, so `next_cursor` appears only when another page provably exists. Published ids are the **surrogates**: `messaging_cache.conversation_id` is text of the form `wa_<phone_id>_<msisdn>` and would have put a customer's phone number in every partner's URL bar |
| — | Frozen-alias action allowlist | PR #115. `index.ts` read "present in `ACTION_SCOPES`" as "is an alias action", then dispatched through an if-ladder with **no final else** — adding 2.3-2.6's read policies would have let `{action:"list_conversations", recipient_phone, template_name}` reach the provider, past the 0A suspension AND past the Idempotency-Key requirement, since both match only the literal `send_template`. `ALIAS_ACTIONS` closes the list; no observable change |
| — | Authentication on `/v1` | PR #113. Attaches to a **matched route**, never above routing: an unmatched `/v1` path still 404s without creating a Supabase client, preserving Phase 2's non-enumerability. Mutation-verified — hoisting auth above routing fails 7 tests |

### Partially landed

| # | Deliverable | What is done, what is not |
|---|---|---|
| 1.7 | Tenancy constraint matrix, each table with a negative database test | Done for the two tables that now exist (`partner_api_key_accounts`, `partner_audit_logs`), proven by `supabase/tests/partner_api_tenancy_negative.sql` — 14 assertions. The matrix's other rows (dispatch intents, webhooks, deliveries, media association) name tables no phase has built yet |
| ~~0.3~~ | ~~Postgres integration harness~~ | **Done — moved to Landed.** Previously: **No harness exists.** What exists is a repeatable manual rehearsal: dump the production schema, restore into a throwaway database, apply, run the proof. That is enough to have caught real defects but it is not CI, so nothing re-runs it on a future change |

### Remaining, in the order recommended (updated 2026-09-01, after Phase 2's read surface)

**Phases 0, 1, 3 and all of Phase 2 except 2.7 are complete.** Everything outstanding is either an
owner decision, a later phase, or the one empirical check Phase 3 could not run.

| | Item | Owner | Why it is where it is |
|---|---|---|---|
| ~~0~~ | ~~Apply the two partner migrations~~ | ~~owner~~ | **Both applied and verified in production.** `20260831170000` (credential lifecycle) on 2026-08-31; `20260901120000` (dispatch intents) on 2026-09-01 — catalog-verified: table, 3 triggers, 7 constraints, 5 indexes, `anon` holds nothing |
| ~~0~~ | ~~Restore GitHub Actions billing~~ | ~~owner~~ | **Done 2026-09-01.** CI and the auto-deploy workflow both run again |
| ~~A~~ | ~~Deploy `main` to the functions volume~~ | ~~auto~~ | **Done and probed.** The workflow deployed both `5c99c701` (Phase 3) and `1b9b7bfa` (the read surface). Live: the three read paths answer 401 `invalid_key` while `/v1/nope` answers 404 `resource_not_found` — that difference IS the proof the routes are registered, and that non-enumerability survived — and `DELETE /v1/accounts` answers 405 `allow: GET`. **Do not hand-deploy**: the automated path is active, and the two must not both be used |
| **A′** | **Apply migration `20260901180000`** | **owner** | Two additive indexes for the read surface. **Not applied as of 2026-09-01** — verified absent from `pg_indexes`. Order is not load-bearing: code-before-index means slow reads, never wrong ones, and at 6.8k rows / 6.3 MB the scan is currently milliseconds. Apply before `whatsapp_messages` grows |
| **B** | **One live template send** to confirm `biz_opaque_callback_data` echoes back | **owner** | The single unproven assumption in the whole D13 design. Needs a real WABA, which does not exist yet — the revoked key was pinned to an inactive one. **Not a blocker**: without the echo every `indeterminate` stays terminal, which is today's behaviour |
| **C** | **Restoring `SEND_TEMPLATE_SUSPENDED`** | **owner decision** | The crash gate passed, so this is now *available* rather than blocked. One flag opens **both** the alias and `POST /v1/messages`. Recommended only after B, since reconciliation is what shrinks the operator escalation queue |
| 0.6 | Staging environment | owner decision | **Blocked on §2.1's finding**: it must be built by restoring a schema dump, because the migrations cannot rebuild the database. Infrastructure provisioning, not a coding task |
| **D** | **One live page-2 probe** of a paginated listing | **owner** | The one thing a stubbed client cannot check: a PostgREST filter STRING is only validated by a real server. `T12` pins the disjunction's shape and asserts exactly one `.or()` call — this repo shipped the double-`.or()` bug once (PR #35) — but needs data and a real key to close |
| 2.7 | `GET /v1/usage` | next build task, **gated** | The last of Phase 2, and deliberately last: it ships **only if** its counter schema is settled first (reserved / confirmed / indeterminate), otherwise it moves to P10 with 10.1 |
| 1.7 | Tenancy matrix, remaining rows | later phases | Three tables now proven (`partner_api_key_accounts`, `partner_audit_logs`, `partner_dispatch_intents`). The rest name tables no phase has built |
| — | `/v1` CORS decision | owner decision | The function emits no `Access-Control-*`; **Kong adds `*` at the gateway**, so the decision cannot be made in the function alone. See `docs/decisions/2026-09-01-v1-cors-is-decided-at-the-gateway.md` |
| 4–10 | Media, webhooks, publishing, GA | later | Tranche 2 in §3b — justified by observed demand, not architecture |

**Recommended next build task: Phase 4 (media) or Phase 5 (webhooks), not 2.7.**

2.7 is the only Phase 2 row left and it is gated on a schema decision, not on engineering — building
it before that decision is how the counters get a shape nobody chose. Of the two tranche-2 phases,
**webhooks (D5) is the one the read surface makes newly worth having**: a partner who can list
conversations still has to poll them, and the outbox is what turns that into delivery.

Both are larger than anything since Phase 1, and both are genuinely blocked on nothing.
### 0.3, and what it found

`scripts/db-harness.sh` gates every push and PR: it restores a committed schema
baseline, applies only migrations newer than its marker, and runs the four SQL
suites. `supabase/tests/README.md` carries the contract and the limitations.

**It is a baseline-and-delta harness, not a replay, because a replay is
impossible.** Replaying all 253 migrations onto a blank database applies 113 and
then fails on 12. These are not environment problems:

- `20260323202049` inserts `ai_models` rows with a **hardcoded `provider_id`**
  (`44bee76d-…`). `ai_providers.id` defaults to `gen_random_uuid()`, and no
  migration ever creates a "Z AI" provider — that row was made by hand in
  production. The migration can only ever succeed against the one database
  where that UUID happened to be generated. Its same-day sibling
  `20260323201022` does it correctly, looking the provider up by
  `provider_code`.
- Three migrations insert seed rows referencing production users and posts no
  migration creates; one calls a function no migration defines; six more fail on
  relations and columns that never got created.

**This is a hard constraint on 0.6 (staging), which the plan assumes away.** A
fresh Postora database cannot be built from its own migrations. Staging must be
created by restoring a schema dump, and disaster recovery depends on a backup
rather than on version control. Migrations are immutable, so this cannot be
fixed by editing history.

A second finding, recorded because it will bite the same work: **this project
has no migration ledger.** There is no `supabase_migrations.schema_migrations` —
only Supabase's own service tables. Nothing records which of the 253 migrations
are applied to production, which is why `scripts/regenerate-baseline.sh` demands
an explicit operator confirmation rather than assuming.

### Not started

**Superseded 2026-09-01 — see "Remaining, in the order recommended" above.** 0.5, 0.7–0.11, 1.3 and
1.6 have all landed; what is left is 0.6 (staging), 1.7's future rows, and Phases 2–10.

The one note worth keeping from the original text, because it turned out to be **wrong in an
instructive way**:

> *"1.3 is larger than its one line suggests: `partner_api_keys` has no rotation fields (successor
> key id, overlap expiry). Spec §8 requires them."*

It needed **one** nullable column, not two. `expires_at` already existed and
`authenticatePartnerKey` already enforced it, so rotation sets the predecessor's `expires_at` to
the end of the overlap window and adds only `superseded_by_key_id` for the audit trail. Adding a
separate overlap-expiry column would have created a *second* way for a key to be invalid, and the
two can disagree — a key past its overlap but not its expiry, or the reverse, with someone left to
decide which wins. Reusing the existing field made rotation a **write** rather than a new **rule**.
them. So credential lifecycle needs its own migration before any UI work.

### What the Danat inventory (0.12) found

The plan assumed Danat's side was unbuilt and that an unreachable partner might block Phase 1. Both
assumptions were wrong, and the correction matters more than the phase ordering it was meant to
inform:

- **Deployed client code exists.** On the Danat host — a *different server* from Postora's, reached
  with `ssh-danatfuture-mcp`, not `ssh-contabo-mcp` — under
  `/etc/dokploy/applications/danatfuture-danatfuture-vk5hnn/code/`:
  `src/lib/providers/postora.ts` with its tests, plus `configValidation.ts` and
  `whatsappTemplateBinding.ts` in that same directory; `src/fns/notificationDrainJob.ts`; and the
  applied migrations `db/migrations/134_postora_provider_config.sql` and
  `136_postora_api_key_env.sql`.
- **It is switched off.** `provider_configs.postora.is_enabled = false`, and
  `POSTORA_WHATSAPP_API_KEY` is unset in the running container. The key literal appears nowhere in
  the code — it is resolved from an environment variable name.
- **Postora's side is also shut**: the key's pinned account is `is_active = false`, and
  `partner-api/index.ts` refuses a non-active account with `409` before any provider call.

So the D13 duplicate-send window described in 0A is **unreachable today, closed by three
independent accidents, none of which is a fix.** Any one of them being undone re-arms it. 0A
therefore remains open work, but its trigger is "before anyone touches that binding", not "this
week".

- **Both sides are the same owner.** Danat is `ssh-danatfuture-mcp`; Postora is `ssh-contabo-mcp`.
  The P0 fallback machinery for an unreachable partner, and 0A's "notify Danat's named owner", are
  both self-coordination.
- **A prerequisite nobody wrote down:** the key cannot simply be re-pinned to Danat's active
  WhatsApp account, which is `evolution_qr`. `partner-api` is a Cloud-API template door needing
  `phone_number_id` and an access token, so Danat go-live needs a real WABA connection first. That
  belongs in §7 as an open item.

### Deployment state

**Current as of 2026-09-01, after Phase 3.**

**Both partner migrations are applied to production and catalog-verified.**
`20260831170000` (credential lifecycle) on 2026-08-31 — the column, all three RPCs and the
composite FK. `20260901120000` (dispatch intents) on 2026-09-01 — the table, its 3 triggers
(tenancy, transition guard, `updated_at`), 7 constraints, 5 indexes, and `anon` holding nothing.

**The automated deploy path is live again.** GitHub Actions billing was restored on 2026-09-01, and
`deploy-edge-functions.yml` deployed PR #105 on its own. **Hand-deploys must now stop** — the two
paths must not both be used, and the workflow is the one to keep. The earlier manual deploy
(2026-08-31) existed only because Actions could not dispatch a job at all; it replicated the
workflow step for step.

**Everything merged is deployed and probed**, through Phase 3 and Phase 2's read surface. The
workflow deployed `5c99c701` and `1b9b7bfa`; the live surface answers 401 on a registered `/v1`
path, 404 on an unregistered one, and 405 with `Allow` on a wrong method.

**One migration is outstanding**: `20260901180000` (the read surface's two indexes) is committed and
harness-verified but **not applied to production**. Additive and order-independent — code-before-index
means slow reads, never wrong ones.

Two things remain deliberately closed, and neither is an accident:

1. **`SEND_TEMPLATE_SUSPENDED` is still `true`.** The crash gate passed, so restoring it is now an
   *available* decision rather than a blocked one — but it is the owner's, and one flag opens
   **both** the alias action and `POST /v1/messages`.
2. **`biz_opaque_callback_data` on template sends is unproven.** Meta documents it for free-form
   messages; no live WABA exists to test the template case. The system is correct either way — with
   no echo, every `indeterminate` stays terminal, which is the pre-Phase-3 behaviour.
### One thing found while working, outside this programme's scope

`partner_api_usage` — the billing ledger created by the foundation migration — grants `anon`,
`authenticated` and `service_role` **full privileges including `DELETE` and `TRUNCATE`**, relying
on RLS alone. It is not touched by this work and is recorded here only so it is not lost.

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

## 2. Dependencies

**Phase numbers are labels, not an execution order.** Review round 2 correctly showed that the
v1.1 arrow diagram encoded both false blocks (media waiting on sends) and missing ones (webhook
CRUD needs the `/v1` router; `message.accepted` needs the send path; GA needs more than P8). What
follows replaces it with **deliverable-level prerequisites** and explicit parallel lanes.

### 2.1 Prerequisites, per deliverable

| Deliverable | Requires | Why |
|---|---|---|
| Any "release-blocking test" claim | P0 integration harness **and** CI gate | Spec §3.3.8; stubbed unit tests cannot prove SQL concurrency (§3.1) |
| Any phase exit at all | P0 staging environment | A phase cannot be validated as a *release* without somewhere to release it |
| Migrating the **live key** under D1/D3/D7 | P0 Danat inventory | Spec §3.4 H1/H2 unconfirmed. Implementing for *new* keys is **not** blocked — see the P0 fallback |
| D11 account selection (P2) | D4 join table (P1) | Selection is meaningless with one pinned account |
| `/v1` router + envelope (P2) | P1 error/limiter conventions | Every later route inherits them |
| Webhook CRUD (P5) | **P2 `/v1` router and conventions** | It is `/v1` surface like any other. *Missing from the v1.1 graph* |
| Any public send route (P3) | D13 gate passing | Binary — see P3 |
| `message.accepted` (P6) | **P3 send path** | There is no producer until sends exist. *Missing from v1.1* |
| Any **advertised** webhook event | Its own certified transactional producer | Outbox-table existence is not sufficient (D5 R1) |
| Media endpoints (P4) | P1 + P2 only — **not P3** | Media does not require sending to work. *v1.1 falsely blocked this* |
| Rich-media messaging (P9) | **P3 and P4** | Needs both the send path and the media controls. *v1.1 listed only P4* |
| `post.*` events (P8) | P7 seam **and** P5 substrate | Events must enqueue in the status transaction |
| Public publishing API (P8) | P4 media | A publishing API that cannot post an image is not coherent |
| GA (P10) | **P6 and, if in scope, P9** — not merely P8 | *v1.1 understated this* |
| GA | P1 lifecycle (D12) | Partners cannot be onboarded by hand-written SQL |

### 2.2 Parallel lanes

After P0, P1 and P2, three lanes proceed **concurrently**. They are independent and must not be
read as a queue:

```text
P0 ──► P1 ──► P2 ──┬──► Lane M (messaging):   P3 ──────────────► P9 ─┐
                   │                                ▲               │
                   ├──► Lane A (media):       P4 ───┘               ├──► P10 GA
                   │                                                │
                   └──► Lane W (webhooks):    P5 ──► P6 ────────────┤
                                                      │             │
                                        P7 ──► P8 ────┘             │
                                    (needs P4 + P5)                 │
```

**Why this matters practically:** P4 can block indefinitely if the media pipeline turns out to
have no malware scanning (a real possibility — see P4). Under a strict numeric reading that gap
would stall all webhook work, which has nothing to do with it. Lane W proceeds regardless.

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

**If disablement is chosen, it is a safety suspension, not a silent break.** D1 freezes the alias
and its sunset conditions do not cover withdrawing an action, so this must be handled as an
explicit, temporary, documented exception:

| Element | Requirement |
|---|---|
| Response | A typed, retryable-false error (`temporarily_unavailable`) with a stable code — never a 404, never a generic 500 |
| Notification | Danat's named owner told before it takes effect, not after |
| Record | Logged as a decision with a date and an owner |
| Restoration | Automatic on P3's D13 gate passing; the restoration is verified, not assumed |

#### 0B — Make correctness checkable

| # | Deliverable | Spec ref |
|---|---|---|
| 0.3 | **Postgres integration-test harness**: migrated database, concurrent-transaction runner. Without it, none of the idempotency, takeover, rate-limit or quota guarantees can be tested at all | §3.1, §10 |
| 0.4 | CI job running `deno test` over `supabase/functions/**` | §3.3.8 |
| 0.5 | Seeded runtime contract tests wired to the OpenAPI document | PRD §31 |
| 0.6 | **Minimal isolated staging environment**, with environment-specific credentials | PRD §45 |

**Why staging is here and not at GA.** v1.1 created staging in the final phase, *after* every
risky release — migrations, credential lifecycle, sends, media, webhooks, publishing. The
integration harness proves database behaviour but not deployed routing, secret wiring, worker
scheduling, provider connectivity, or environment isolation, so every earlier phase would have had
to either deploy straight to production or go unvalidated as a real release. P10 now *certifies*
staging-to-production separation rather than creating staging for the first time.

0.4 is nearly free — the 30 existing partner-api tests pass locally in 728ms; it is a wiring gap.
*(Superseded: 0.4 was already closed by PR #67 before execution began. See §0.)*
0.3 is not free, and it is the more important of the two: **the tests that matter most are the
ones that cannot be written without it.** A CI job that runs only stubbed unit tests turns green
while every consequential database guarantee stays unproven.

#### 0C — Contract and security groundwork

| # | Deliverable | Spec ref |
|---|---|---|
| 0.7 | OpenAPI 3.1 skeleton: servers, security schemes, scopes, error component, pagination, rate-limit headers. No endpoints yet | §3.3.4 |
| 0.8 | **Contract-drift gate, defined concretely**: named comparison mechanism, a committed baseline document, semantic breaking-change rules (field removal, type narrowing, enum removal, required-field addition), and runtime contract tests. Schema validity alone, or bumping `info.version`, must **not** be able to satisfy it | PRD §47 |
| 0.9 | Security threat review of the v1 surface, with recorded disposition | PRD §50 |
| 0.10 | **Recorded** CORS decision for `/v1` — `ARCHITECTURE.md` §25 forbids inheriting `*` by copy-paste. For a header-authenticated non-browser API `*` is defensible, but it must be reviewed and written down | §9.9 |
| 0.11 | D8 containment check added to the review gate: no new surface authenticates with `profiles.api_key` | D8 |

#### 0D — External

| # | Deliverable | Spec ref |
|---|---|---|
| 0.12 | **Danat credential inventory**: how many environments hold `pk_live_urCb…`, is there deployed client code, any dormant retry job, who owns coordination | §3.4, §11.1 |

**Exit criteria.** Every one of the following is evidenced, not asserted:

- the live send window is closed or the action is disabled, **verified against the alias**;
- the integration harness runs a deliberately concurrent test and it passes;
- CI fails when a partner-api Deno test fails (proven by breaking one);
- the drift gate rejects a seeded breaking change (proven by introducing one);
- the threat review has a written disposition;
- the CORS decision is recorded with its rationale;
- the Danat inventory is written down, and H1/H2 are confirmed or replaced with what is true.

**Fallback if Danat is unreachable (0.12).** The block is narrower than "Phase 1 cannot start".
Split it:

- **D1** — extend the alias window; no other change.
- **D3** — implement generic scopes and apply them to **new** keys; leave the existing key on its
  legacy scopes at unchanged capability until coordination happens. The spec already forbids
  widening legacy scopes, so this is safe indefinitely.
- **D7** — implement risk classes and apply them to **`/v1` routes**; leave the alias's limiter
  behaviour untouched until coordinated.

Phase 1 therefore proceeds regardless; only the migration of the one live credential waits.

**The legacy adapter policy — required for the fallback to actually hold.** D1 has the alias and
`/v1` converge on shared use cases (P2, P3). Without an explicit rule, that convergence would
silently drag new limiter classes, new scope semantics and the new envelope onto the live alias —
defeating the fallback that was supposed to protect it. Therefore:

> The alias adapter pins its **own** envelope, scope interpretation, account selection and limiter
> policy, and passes them into the shared use case as parameters. A shared use case must never
> read a policy from ambient configuration. Anything a caller does not pin is a defect, and the
> P2 alias-compatibility test is what catches it.

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
| 1.5 | `X-RateLimit-*` headers, **with defined response classes** — see below | §3.3.2 |
| 1.6 | Legacy scopes pinned at current capability per the D3 allowlist, never widened; generic scopes available for new keys | D3 |
| 1.7 | **Tenancy constraint matrix** applied to every new partner table, each with a negative database test | §9.1 |

**1.5, made implementable.** "Headers on every response" is not achievable: an invalid key, a
missing credential, a preflight, and a failure before limiter consumption have no resolved
per-key limit. Define it as:

| Response class | Headers |
|---|---|
| Authenticated, limiter consumed | All three, real values |
| Authenticated, limiter unavailable (D7) | Omitted; `Retry-After` instead |
| Pre-auth failures (401 `invalid_key`, `key_revoked`, `key_expired`) | **Omitted** — there is no key whose budget could be reported, and fabricating one leaks whether a key exists |
| CORS preflight | Omitted |
| The frozen alias | Per the legacy adapter policy — the alias contract does not change |

**1.7 exists because the round-1 fix was too narrow.** v1.1 required the double composite FK for
`partner_api_key_accounts` and left every other new table to inherit the principle by implication.
Spec §9.1 now carries the full matrix — dispatch intents, webhooks, deliveries, audit logs, media
association — and each row needs its own negative test. Service-role code bypasses RLS, so a
request-time check is not the proof.

**Moved out of this phase.** Splitting the usage counters (reserved / confirmed / indeterminate)
depended on an unresolved product decision (§7 item 2) and would have made Phase 1 unable to
complete deterministically. It now sits in P10 as 10.1, gated on that decision.

**Exit criteria — each a test, not a demonstration:**

- **D4:** a tenant-isolation test proves a key cannot reach an account outside its bindings. The
  test is written to **fail against a single-composite-FK implementation** — that is its purpose.
- **D3, full intersection, every legacy scope:** a legacy-scope key cannot send free-form messages,
  *and* cannot reach a newly bound account, *and* cannot act on a platform outside its original
  grant. **Critically, `whatsapp:webhooks.manage` — held by the live key and authorising nothing
  today — is tested to prove it grants no `/v1` capability whatsoever.** v1.1 tested only the send
  scope; mapping the dormant one to `webhooks:manage` in P5 would turn zero capability into full
  webhook CRUD plus an SSRF-capable outbound test, which is the exact escalation D3 was rewritten
  to prevent, arriving through a different door.
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
| 2.7 | `GET /v1/usage` — **only if its final schema is settled first**; otherwise it moves to P10 with 10.1 | §7, §11.2 |

**On 2.7.** Splitting the usage counters (reserved / confirmed / indeterminate) was moved to P10
because it waits on a product decision (§7 item 2). Shipping `GET /v1/usage` here would freeze a
public contract whose counters and commercial meaning are still open, and P4 additionally
introduces storage/transfer meter dimensions. Either settle the schema before P2 — an extensible
`meters[]` shape rather than fixed fields would do it — or ship the endpoint in P10. **Do not ship
it in P2 with fixed counters.** Meter-dimension migrations belong to P10 alone, never split
between P4 and P10.
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
| 5.8 | **Producer ledger** — one row per **(event type, writer path)**, not per event; preceded by a database-write inventory. Columns: transition, writing function, stable occurrence ID, transaction mechanism, crash test | *new — see below* |
| 5.9 | **Webhook secret rotation semantics** — see below | D5, §9 |

**5.8, corrected.** v1.1 said "one row per event", which certifies one function and proves
nothing about the others. The same transition can be committed by several paths — an OAuth
callback, a disconnect action, a token refresh, a health check, an admin operation, a retry, a
provider callback. An event is certified only when **every path capable of committing its
transition** is either covered or explicitly prohibited, which requires enumerating the writers
first.

**5.9, because rotation is a delivery problem, not just a credential one.** Immediate rotation
either breaks a live receiver mid-deployment or changes the signature on retries of an event that
was queued under the old secret — and the event ID is immutable across those retries. Specify:
one-time display at creation; a bounded overlap during which both secrets verify; **the secret
version captured on the delivery row at enqueue time**, so a retry is signed with the secret that
was current when the event occurred; and an audit entry per rotation.

**Why 5.4 and 5.8 exist.** Round 1 identified that a correct outbox schema can silently accumulate
undelivered rows with nobody noticing, and that "transactional enqueue at every producer" is a
sentence, not a checklist — one missed producer silently voids at-least-once. Neither is provable
without an explicit ledger and operational visibility.

**Exit criteria.**

- A crash-during-dispatch test recovers the event.
- **Cardinality, correctly stated.** v1.1 said "exactly one outbox row per source event", which is
  wrong in two directions: one event matching three subscriptions *should* produce three rows, and
  `accepted` / `delivered` / `read` for the same message share one provider message ID and would
  collide. The invariant is defined against an **event-occurrence ID** that identifies the
  transition, not the resource:
  - exactly one row per `(webhook_id, event_occurrence_id)`;
  - **zero** rows for non-matching subscriptions;
  - **distinct** occurrence IDs for distinct transitions of the same underlying resource.

  Asserted directly — a test that only checks "delivered at least once" passes with the `UNIQUE`
  constraint missing entirely, which is the invariant at stake.
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

**This is explicitly a migration phase, not a product increment.** It ships no partner-visible
value, and stopping the programme here would leave nothing new for a partner. That is accepted
deliberately — the alternative is doing this extraction underneath a new public API, where a
production parity failure and a new-API defect are indistinguishable. It is therefore governed
like a migration, with the controls in the exit criteria below.

**Entry criterion — the writer inventory.** Before any code moves: enumerate **every** path that
can commit a terminal `platform_posts` status or create a schedule row. Candidates include
`process-post` itself, `process-scheduled-posts`, retry paths, provider callbacks, and any admin
or repair operation. v1.1 changed one invocation seam and asserted atomicity for "whatever writes"
terminal status — if another writer exists, that assertion is simply false and events are lost
silently.

| # | Deliverable | Spec ref |
|---|---|---|
| 7.0 | **Writer inventory** for terminal status and schedule rows — an entry criterion, not a deliverable | D9, D5 |
| 7.1 | `PublishPort` interface in `_shared/platforms/`, alongside the existing `types.ts` / `media-helpers.ts` / `polling-helpers.ts` | D9 |
| 7.2 | **Each `postToX` body moves** to `_shared/platforms/<platform>.ts` as a `PublishPort` implementation. A *move*, not a rewrite — the provider logic is unchanged | D9 |
| 7.3 | Both `process-post`'s entrypoint and the future Partner API route obtain implementations from one registry, so there is exactly one publish path | D9 |
| 7.4 | Terminal `platform_posts` transition and outbox enqueue in **one database operation used by every writer from 7.0** | D9, D5 |
| 7.5 | Schedule-row creation and its enqueue likewise, in one transaction — this is what `post.scheduled` needs | D6 |

**Why 7.2 changed.** v1.1 required a `_shared/` port, forbade importing `index.ts`, forbade an HTTP
bridge, *and* required the provider branches to stay inside `process-post/index.ts`. Those four
constraints are mutually unsatisfiable: if the branch bodies live in the entrypoint, no permitted
route reaches them. The branches move; their contents do not change. Spec D9(R3) carries the full
reasoning.

**Exit criteria — migration controls, not just "behaviour unchanged":**

- **Shadow parity:** for a bounded soak period, publishes run through the new path and their
  per-platform results are compared against the previous behaviour, with a recorded match rate.
- **Feature flag and rollback:** the port is switchable back without a deploy, and the rollback is
  *exercised* at least once, not merely available.
- **Every writer from 7.0** goes through the single atomic operation — verified by inventory, not
  by inspection of the port alone.
- A crash after a platform result is written still produces a queued delivery row.
- No public endpoint exists.

**Risk.** The riskiest work in the programme — `process-post/index.ts` is 7,202 lines with ten
platform branches. Scope discipline is the mitigation: **move the branches, do not redesign
them.** If the work starts changing provider behaviour, stop; that is the separate Core 1 refactor.

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
| 10.5 | **Certify** staging-to-production separation — a staging key must not authenticate against production, tested. (Staging itself is created in P0.6, not here) | PRD §45 |
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

## 3b. The minimum viable tranche — what to build if only half of this ships

Review round 2 asked which phases are load-bearing and which are expansion bets. The answer
matters, because the only verified partner usage in production is **status and template reads,
with no sends ever** (spec §3.4). Media, publishing and rich messaging are bets on demand that has
not yet been observed; a supportable messaging API is not.

**Tranche 1 — prove the platform (P0, P1, P2, P3, P5, P6, and a reduced P10).**

| Included | Why it is load-bearing |
|---|---|
| P0 | Closes a live customer-facing defect; without the harness and staging nothing else is verifiable |
| P1 | Tenancy, credential lifecycle, limiter policy. Without D12 no partner can be onboarded at all |
| P2 | The `/v1` contract shape, frozen before a second consumer exists |
| P3 | Text and template sending — the one capability a partner has actually asked for |
| P5 + P6 | Events are what makes an integration two-way; without them a partner must poll |
| P10 (reduced) | Docs, changelog, staging certification, one certified integration |

**Tranche 2 — expansion, on evidence (P4, P7, P8, P9).** Media brings malware-scanning
infrastructure; publishing brings a 7,202-line seam extraction. Both are substantial, and both are
justified by *demand*, not by architecture. Deferring them until Tranche 1 is in real use is the
lower-risk sequence.

**Recommendation.** Ship Tranche 1, get it used, and let observed partner demand order Tranche 2.
This is not a scope cut disguised as staging — Tranche 1 is a complete, supportable product on its
own, which is the test every phase boundary in this plan is held to.

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
| **Decisions executed on unconfirmed hypotheses** | D1/D3/D7 justified by "one consumer" that was never verified | P0.12 inventory; the split fallback in P0 so the programme is not blocked on an external party |
| **Hidden phase size** | Even at 11 phases, P0, P4 and P5 each contain several deployable increments — realistically the programme is 16–20 releases, not 11. Underestimating this is how a plan slips without anyone noticing a decision being made | P0 is already sub-divided (0A–0D) and should be released that way; P4 splits at the security-infrastructure/endpoint boundary; P5 splits at the delivery-machinery/subscription-API boundary. **Phase count is a planning label, not a release count** |
| **Building expansion bets before the platform is used** | Media and publishing absorb malware-scanning infrastructure and a 7,202-line extraction, for demand that has never been observed (spec §3.4: zero sends, zero webhooks) | The Tranche 1 / Tranche 2 split in §3b |

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
| 6 | **Danat has no WABA.** Its active WhatsApp account is `evolution_qr`; `partner-api` is a Cloud-API template door needing `phone_number_id` and an access token, so the key cannot simply be re-pinned to it | Danat go-live, and therefore any end-to-end certification (10.8) | *found by 0.12, 2026-08-30* |
| 7 | Whether audit history must survive tenant deletion. `partner_audit_logs.workspace_id` cascades, and referential actions run outside RLS and grants, so a workspace owner erases their own credential trail without holding `DELETE`. `CASCADE` was chosen because `RESTRICT` blocks tenant deletion; if compliance needs retention it is soft-delete-plus-archive | Nothing today. Cheaper to decide before the table has rows | *raised 2026-08-30* |

**Item 1 is closed** — the inventory was done on 2026-08-30; see §0. It found the opposite of what
the plan assumed: Danat's client code is deployed but switched off, and both sides are the same
owner. Item 6 replaces it as the real external blocker.

Item 1 is external and worth chasing immediately, but the P0 fallback means it no longer blocks
Phase 1. Item 5 is the one that can genuinely stop a phase.

---

## 8. Correction log

### v1.4 — 2026-08-30 — Phase 0 closed out; two assumptions in it were false

0.1/0.2 (the 0A suspension), 0.3 (the integration harness) and a
least-privilege grant reduction landed in PRs #72 and #74. Two of this plan's
assumptions did not survive contact:

- **0.6 (staging) is blocked in a way this plan does not acknowledge.** It
  assumes a staging environment can be created; building one from migrations is
  impossible, because 12 of the 253 only succeed against the one production
  database. Staging must be a schema restore. Details in §0.
- **0.3 could not be built as specified.** "Replay the migrations" was the
  design, and it cannot be made green. What shipped is a baseline-and-delta
  harness, which gates future migrations — the actual point — while proving
  nothing about history. That limitation is documented rather than hidden.

Also worth recording for whoever picks up 1.3: there is no migration ledger in
this project, so no tooling can determine which migrations production has
applied. Anything that needs to know must ask a human.

The harness went through eight adversarial review rounds and 18 blocking
defects, every one a variant of accepting evidence that something *started* as
evidence that it *finished*. A gate is not ordinary code: it is judged by
whether it can be wrong in the reassuring direction.

---

### v1.3 — 2026-08-30 — execution began; the plan met the system

Added §0, a progress log, so status lives in exactly one place rather than being edited into the
phase tables. Four corrections the work itself forced:

- **0.4 was already done.** PR #67 had wired the Deno tests into CI before this plan was written.
  The plan asserted a gap that no longer existed — the first thing checking reality turned up.
- **0.12's premise was wrong in both directions.** The plan treated Danat as unbuilt and possibly
  unreachable, and built fallback machinery for that. In fact Danat's client code is deployed (and
  switched off), and both sides have the same owner. The inventory is closed; §7 item 1 with it.
- **0A's urgency is different from what §1 says.** The duplicate-send window is real and unfixed,
  but unreachable today behind three independent accidents. §1's "reachable today" is true of the
  code and false of the system. The work stays; the trigger changes to "before anyone touches that
  binding".
- **Two open items added** (§7 items 6 and 7): Danat has no WABA, so the key cannot be re-pinned to
  its `evolution_qr` account; and whether audit history must survive tenant deletion, which is
  cheapest to decide before the table has rows.

Phase 1 partially landed: 1.1, 1.2, 1.4 and 1.5 merged in PR #70, migrations live in production,
`partner-api` deliberately not yet redeployed. 1.7 is done only for the two tables that exist. 0.3
is not done — the rehearsal that caught the defects is manual, not a harness, so nothing re-runs it.

---

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

### v1.2 — 2026-08-25 — review round 2 (Codex `gpt-5.6-sol`, high effort)

Round 2 judged the round-1 fixes rather than repeating findings: 19 findings, 5 blockers, and an
explicit **"I would not approve execution yet."** All accepted. Several were defects in the
round-1 fixes themselves, and three were errors in my own reasoning rather than in wording.

**Round-1 fixes that did not hold:**

- **D13's rationale was false** *(blocker)* — see spec v1.3. "The partner observes `indeterminate`
  and re-sends" cannot work: the durable intent exists in both the never-sent and the
  possibly-sent case, and they are indistinguishable. `indeterminate` is now terminal, with an
  operator escalation path, and the justification for at-most-once is restated honestly.
- **D9 was unconstructible** *(blocker)* — a `_shared/` port, no `index.ts` import, no HTTP
  bridge, *and* provider branches staying in the entrypoint cannot all hold. P7.2 now moves the
  branch bodies to `_shared/platforms/`; contents unchanged.
- **The tenancy fix covered one table** *(blocker)* — the double composite FK was specified for
  the join table only, leaving dispatch intents, webhooks, deliveries, audit logs and media
  association to inherit the principle by implication. Now a per-table matrix (1.7, spec §9.1).
- **The dependency graph had both false and missing blocks** *(blocker)* — media was falsely
  blocked on sending; webhook CRUD's dependency on the `/v1` router, `message.accepted`'s on the
  send path, P9's on P3, and GA's on P6/P9 were all missing. Replaced with deliverable-level
  prerequisites plus explicit parallel lanes.
- **The Danat fallback leaked** *(blocker)* — shared use cases would have dragged new limiter and
  scope semantics onto the frozen alias, and disabling `send_template` was a compatibility break
  D1's sunset does not cover. Added the legacy adapter policy and safety-suspension semantics.
- **The producer ledger recorded events, not writers** — the same transition can be committed by
  several paths; certifying one function proves nothing about the rest. Now one row per
  (event type, writer path), preceded by a write inventory.
- **The dedup criterion was wrong in two directions** — one event matching three subscriptions
  *should* produce three rows, and `accepted`/`delivered`/`read` share a provider message ID.
  Restated against an event-occurrence ID.
- **The dormant scope was untested** — `whatsapp:webhooks.manage` is held by the live key and
  authorises nothing; mapping it to `webhooks:manage` would convert zero capability into
  SSRF-capable webhook CRUD. The D3 tests covered sending but not this.

**New problems the round-1 restructure introduced:**

- **P4-before-P5 was ambiguous serialization** — a media scanning gap would have stalled unrelated
  webhook work. Parallel lanes now explicit.
- **`GET /v1/usage` in P2 froze a contract whose counters move in P10**, with meter dimensions
  split between P4 and P10. Now gated on settling the schema first.
- **P7 had no observable outcome** — it is now framed as an explicit non-product migration with
  shadow parity, an exercised rollback, a soak period, and a writer inventory as its entry
  criterion.

**Other:**

- Staging moved from P10 to P0.6. Creating it after every risky release meant earlier phases would
  deploy straight to production or go unvalidated as releases.
- Webhook secret rotation specified: one-time display, bounded overlap, and the secret version
  captured on the delivery row so retries of an already-queued event stay verifiable.
- `X-RateLimit-*` given per-response-class semantics; "every response" was not implementable, and
  fabricating values pre-auth would leak whether a key exists.
- Added §3b, the minimum viable tranche, and two programme risks: hidden phase size (realistically
  16–20 releases, not 11) and building expansion bets before the platform has been used.

**Still open after round 2.** The reviewer's position is that execution should not begin until a
**D13 decision artifact** exists: proven provider capabilities, an executable state machine, the
terminal `indeterminate` contract, and the partner-facing behaviour when reconciliation is
impossible. That artifact is P3.1, and the reviewer would pull it before P0 completes. That is a
reasonable position and is recorded here as the single highest-value next step — it is not
resolved by this revision.
