# Postora Partner API — Specification v1

**Status:** Draft for review · **Date:** 2026-08-25 · **Supersedes scope of:** `docs/superpowers/specs/2026-08-13-postora-whatsapp-partner-api-design.md` (v2, WhatsApp-only)
**Source PRD:** `docs/postora future feathers/POSTORA_PARTNER_API_PRD_v1.0.md`
**Implementation plan:** `docs/postora future feathers/POSTORA-PARTNER-API-IMPLEMENTATION-PLAN.md`

> **No code in this document.** This is a contract and decision specification. Every claim about
> current behaviour is cited to a file, line, migration, or a live production query run on
> 2026-08-25. Anything not cited is marked as a proposal.

---

## 1. Problem

The PRD (`POSTORA_PARTNER_API_PRD_v1.0.md`) describes a full developer platform: REST `/v1`
resources across messaging, publishing, media, contacts, analytics and AI; OAuth app
installations; a webhook product; SDKs; billing.

What exists in the repository today is a **single-endpoint, action-RPC door that does three
things for WhatsApp.** The gap is not a matter of adding endpoints — the PRD and the
implementation disagree about the *shape* of the API, the *error envelope*, the *scope
vocabulary*, and the *unit of tenancy*.

This specification's job is to close that gap explicitly. It does not restate the PRD. It
records, for each conflict between the PRD's target and the code's reality, **which one wins in
v1 and why** — so that implementation is a matter of execution rather than re-litigation.

The central finding that makes this tractable is in §3.4: **the Partner API has exactly one
credential, which has never sent a message.** The backward-compatibility burden that would
normally force an awkward compromise does not exist yet. It will exist the moment Danat goes
live, which is why the shape decision must be made now rather than after.

---

## 2. Relationship to other documents

| Document | Owns |
|---|---|
| `POSTORA_PARTNER_API_PRD_v1.0.md` | Product intent, target users, commercial framing, long-range roadmap |
| `docs/superpowers/specs/2026-08-13-postora-whatsapp-partner-api-design.md` | The WhatsApp partner door as built: key hashing, tenancy FK, idempotency semantics, Danat topology |
| `ARCHITECTURE.md` | Layering, dependency direction, Edge Function shape, security rules that all new code must follow |
| **This document** | The v1 public contract, the decision ledger, the data-model delta, and the acceptance bar |
| `POSTORA-PARTNER-API-IMPLEMENTATION-PLAN.md` | Ordered phases, sequencing, risk, and per-phase exit criteria |

The 2026-08-13 spec is **not superseded as a record of why the foundation is built the way it
is.** Its §5.1a (composite-FK tenancy), §5.1b (metering), §5.3 (idempotency states) and §5.5
(delivery outbox) remain the authoritative rationale. This document generalises the *surface*
above that foundation and carries forward the one part of it that was specified but never built
(§3.3 below).

Per `CLAUDE.md`, a fact lives in exactly one file. Where this spec needs a fact from another
document it links rather than copies.

---

## 3. Verified current state

Everything in this section was checked on 2026-08-25 against the working tree and the
production database. This is the baseline the plan builds from.

### 3.1 What is built and working

The foundation is substantially more complete than the PRD assumes. PRD §50's "Phase 1 —
Partner API Foundation" is, with the exceptions in §3.3, **already delivered**.

| PRD requirement | Status | Evidence |
|---|---|---|
| API-key auth, hashed at rest | ✅ Built | `_shared/partnerApiKeys.ts` — SHA-256 hex digest, `pk_live_` prefix, plaintext never stored |
| Non-enumerable key errors | ✅ Built | `partnerApiKeys.ts:81` — unknown key and malformed key return the identical 401 |
| Scopes | ✅ Built | `partnerApiKeys.ts` `PartnerScope`; enforced via `assertScope` + `partner-api/router.ts` |
| Workspace/account binding | ✅ Built, DB-enforced | `20260813120000_partner_api_foundation.sql` — composite FK `(social_account_id, workspace_id)` makes cross-workspace key misuse impossible in the database, not merely in code |
| Request IDs | ✅ Built | `partner-api/index.ts` — `X-Postora-Request-Id` header **and** body field, on every exit path including pre-auth |
| Idempotency | ✅ Built, unusually rigorous | `claim_partner_idempotency()` SQL function: atomic claim, lease takeover, and an `attempt_token` fencing UUID so a revived stale writer cannot settle a new owner's row |
| Indeterminate-outcome handling | ✅ Built | `partner-api/index.ts` — an indeterminate send is never auto-retried and never refunded, because the customer may already have the message |
| Rate limiting, concurrency-safe | ✅ Built | `consume_partner_rate()` — single atomic `INSERT … ON CONFLICT DO UPDATE … RETURNING`, explicitly rejecting the count-then-insert race |
| Quota reserve/settle | ✅ Built | `reserve_partner_quota()` / `release_partner_quota()` — quota is consumed only by a Meta-accepted send, released on definite rejection, retained on indeterminate |
| Usage ledger | ✅ Built | `partner_api_usage`, composite FK prevents a usage row whose workspace disagrees with its key |
| Revocation as a one-way door | ✅ Built | `revoke_partner_key()` — no `UPDATE` grant exists, so a leaked key cannot be silently un-revoked |
| Sanitized errors | ✅ Built | Typed error codes throughout; raw Meta/Postgres errors are not returned |

This foundation should be **extended, not redesigned.** Several of its properties (the fencing
token, the reserve/settle split, the composite FKs) are subtle correctness work that a rewrite
would likely lose.

### 3.2 What the API actually exposes

Three actions, WhatsApp only, over a single `POST` endpoint (`partner-api/router.ts`):

| Action | Scope required | Side effect |
|---|---|---|
| `get_status` | none | none |
| `list_templates` | `whatsapp:templates.read` | none |
| `send_template` | `whatsapp:template.send` | billable; requires `Idempotency-Key` |

A fourth scope, `whatsapp:webhooks.manage`, is **defined and granted but has no action behind
it** (`partnerApiKeys.ts` `PartnerScope`; absent from `ACTION_SCOPES`).

### 3.3 What is specified but missing

These are the real gaps. Each is a prerequisite for something the PRD promises.

1. **The webhook delivery outbox does not exist.** The 2026-08-13 spec §5.5 specified
   `whatsapp_webhook_deliveries` as a transactional outbox, with the explicit reasoning that
   fire-and-forget dispatch loses events permanently: the inbound message is inserted first,
   dispatched second, so a lost dispatch is never recovered because Meta's redelivery hits the
   duplicate check and skips. **No `*_deliveries` table was ever created** — a scan of all 225
   migrations finds only `whatsapp_webhooks` and `workflow_webhooks`. The PRD's entire webhook
   product (§22–23: retries, delivery ledger, event IDs, replay, endpoint health) rests on this
   missing table.

2. **No `X-RateLimit-*` headers are emitted.** PRD §25 requires `X-RateLimit-Limit`,
   `-Remaining`, `-Reset` and `Retry-After`. `checkRateLimit` (`_shared/partnerApiMetering.ts:75`)
   returns `void` or throws; it never surfaces the counts, so the caller cannot back off
   intelligently. `Retry-After` is emitted only for `idempotency_in_progress`.

3. **The rate limiter fails open, unconditionally.** `partnerApiMetering.ts:84` —
   `if (error) return;` with the comment "Never fail a send because the limiter is unavailable."
   PRD §25 requires a *deliberate* fail-open/fail-closed policy **chosen per operation risk**.
   Today a limiter outage removes all rate limiting from billable sends. See Decision D7.

4. **No OpenAPI document exists.** PRD §31 makes it the source of truth; `openapi/` is absent
   from the repository.

5. **No key-minting UI.** `partner_api_keys` appears nowhere in `src/` except the generated
   `src/integrations/supabase/types.ts`. Keys are minted by hand-written SQL. Note that
   `src/pages/ApiKeys.tsx` is a *different* system — it manages `profiles.api_key`, the plaintext
   per-user UUID used by `n8n-api`. See Decision D8.

6. **No audit log.** PRD §30 requires an auditable record of key creation, rotation, revocation
   and scope changes. `revoke_partner_key()` stamps `revoked_by`/`revoked_reason` on the row
   itself, which records the latest state but is not an append-only audit trail.

7. **No OAuth, no applications, no installations.** PRD §12.2, §40 and §50 Phase 6 are entirely
   unbuilt. There is no `partner_applications`, `partner_oauth_*`, or `partner_installations`.

8. **The Partner API's tests never run in CI.** `vite.config.ts:45` sets the vitest
   `include` to `["src/**/*.{test,spec}.*"]`, so every Deno test under `supabase/functions/**`
   is outside the pattern. `.github/workflows/test.yml` runs only `bun run test` (vitest) and
   `npx tsc --noEmit`. Consequently `partner-api/isolation.test.ts`,
   `partner-api/router.test.ts`, `_shared/partnerApiIdempotency.test.ts`,
   `partnerApiKeys.test.ts` and `partnerApiMetering.test.ts` **exist but gate nothing.**

   This is load-bearing for §10: the spec declares tenant-isolation tests release-blocking, and
   under today's CI they would block nothing. A Deno test job is therefore a Phase 0
   prerequisite, not a testing nicety — see the implementation plan.

### 3.4 Live production state — the decisive fact

Queried against the production database on 2026-08-25:

```
partner_api_keys:  1 row
partner_api_usage: 4 rows
whatsapp_webhooks: 0 rows
```

The single key is `Danat Backend` (`pk_live_urCb…`), holding all three scopes, **not revoked**,
`last_used_at = 2026-08-14 01:28 UTC`, `current_usage_count = 0`.

All four usage rows are from a single 11-minute smoke-test window on 2026-08-14:
one `unknown_action` 400, two `get_status` 200s, one `list_templates` 200.

**There has never been a `send_template` call. There are no configured webhooks. The one
credential has been idle for eleven days.**

Consequences, which drive §5:

- The Partner API has **one consumer, and it has never exercised the side-effectful path.**
- Backward compatibility is a **single coordinated change with one named partner**, not a
  public deprecation window.
- Any breaking change to shape, envelope, or scope vocabulary is close to free **right now**
  and becomes progressively expensive from Danat's go-live onward.
- Conversely: nothing about the current surface has been proven in production under real load.
  Treat the foundation's *correctness* as well-reasoned and well-tested, but its *operational
  behaviour* as unvalidated.

---

## 4. Goals

1. Freeze the v1 public contract shape, error envelope, and scope vocabulary **before** the
   second consumer arrives.
2. Carry the existing foundation forward without redesigning its correctness-critical parts.
3. Deliver the missing prerequisites (§3.3) that the PRD's promises depend on.
4. Make the OpenAPI document the enforced source of truth, with CI gates.
5. Keep every phase independently shippable, so the programme can stop at any phase boundary
   and still leave a coherent product.

## 5. Non-goals for v1

Beyond the PRD's own §6 non-goals, this specification additionally defers:

- **OAuth and app installations** (PRD §12.2, Phase 6). No consumer needs them: Danat is
  server-to-server, and the WooCommerce plugin is site-owner-installed, both of which are
  correctly served by API keys. OAuth is required only for *public marketplace* apps
  (Shopify/Salla/Zid public listings), which are not v1 commitments.
- **SDK generation** (PRD §34). Deferred until the OpenAPI document is stable — generating SDKs
  from a moving contract produces churn, not value.
- **Billing integration** (PRD §27, Phase 9). The metering ledger must be *billing-ready*; wiring
  Stripe is not v1.
- **The AI API** (PRD §21). AI generation has its own quota model and cost profile; exposing it
  publicly is a separate commercial decision.
- **Analytics API** (PRD §20). It would be built on a warehouse that does not exist — see the
  roadmap's Core 2 finding in `Ai agent improvemnets.md`. Specifying a public analytics contract
  before the data layer exists would freeze a contract we cannot serve.

---

## 6. Decision ledger

Each decision resolves a conflict between the PRD and the implementation. These are the
contested claims; they are the intended target of review.

---

### D1 — API shape: REST `/v1` resources, with the action endpoint retained as a frozen alias

**Conflict.** PRD §11 specifies REST resources (`GET /v1/conversations`, `POST /v1/messages`).
The implementation is a single `POST` taking `{action: "..."}` (`partner-api/index.ts`,
`router.ts`).

**Decision.** Adopt REST `/v1` as the v1 public contract. Keep the existing action endpoint
alive, frozen at its current three actions, as a compatibility alias for Danat.

**Rationale.** The action-RPC shape is a poor fit for what the PRD asks for — it cannot express
resource-scoped pagination, conditional requests, or per-resource rate limits without inventing
a parallel convention for each, and it makes the OpenAPI document (PRD §31) describe one
endpoint with a discriminated-union body rather than a resource model. That is a contract
readers and generators handle badly.

The usual counterargument — "you cannot break existing consumers" — **does not apply**. §3.4
shows one consumer, four smoke-test calls, no sends, idle eleven days. The migration is an email
to one partner.

**Cost accepted.** Two code paths during the alias window. Bounded by keeping the alias frozen:
no new actions are ever added to it, and every alias action is implemented as a thin translation
onto the same use-case layer the REST route calls, so behaviour cannot diverge.

**Alias sunset.** The alias is removed when Danat has migrated and confirmed, or 6 months after
`/v1` GA, whichever is sooner. This resolves open question 1 of the 2026-08-13 spec for the
`partner-api` surface (`ecommerce-whatsapp-api` remains separately open — see Q3).

**Rejected alternative.** Keeping action-RPC and layering REST later. This produces the worst
outcome: the contract freezes twice, and the second freeze happens *after* consumers exist.

---

### D2 — Error envelope: extend the existing shape; do not adopt the PRD's

**Conflict.** The PRD §28 envelope is `{"error": {code, message, request_id, details}}`. The
implementation emits `{success: false, error: {code, message, retryable, details}}` with
`request_id` at the top level (`partner-api/index.ts` `errorBody` / `withRequestId`).

**Decision.** Freeze the **implemented** envelope as the v1 contract, with `request_id` staying
top-level. Add `details` uniformly. The PRD's shape is not adopted.

**Rationale.** The implemented envelope carries two fields the PRD's lacks, and both are load-
bearing:

- `retryable` tells a client whether to back off or fail permanently, without maintaining a
  client-side table of which codes are transient. This is exactly the information an integrator
  most often gets wrong.
- `success` lets a client branch before inspecting the body, which matters for the alias
  endpoint where HTTP status alone is ambiguous.

`request_id` stays top-level because it is present on **successful** responses too
(`withRequestId` is applied to every response, not only errors). Nesting it under `error` would
make the correlation handle available only on failure — the opposite of what an integrator
debugging a *successful-but-wrong* call needs.

**Cost accepted.** Divergence from the PRD, and from the Stripe-style convention the PRD echoes.
Documented explicitly in the developer docs so it is a deliberate difference, not an accident.

---

### D3 — Scope vocabulary: generic resource scopes, with the WhatsApp scopes retained as aliases

**Conflict.** PRD §13 specifies generic scopes (`messages:send`, `posts:publish`). The
implementation uses provider-prefixed ones (`whatsapp:template.send`).

**Decision.** v1 issues generic scopes. The three existing WhatsApp scopes remain valid on
already-issued keys and map onto the generic set. New keys receive generic scopes only.

Mapping:

| Existing | v1 generic |
|---|---|
| `whatsapp:template.send` | `messages:send` |
| `whatsapp:templates.read` | `templates:read` |
| `whatsapp:webhooks.manage` | `webhooks:manage` |

**Rationale.** Provider-prefixed scopes force a new scope for every platform (`instagram:messages.send`,
`facebook:messages.send`), which multiplies the authorisation surface and pushes provider
knowledge into the credential model — the opposite of the provider-neutral boundary the PRD
(§42) and `ARCHITECTURE.md` both require. Which *platforms* a key may act on is already answered
by its bound accounts (D4), so encoding it in the scope too is redundant and can contradict it.

**Capability, not scope, gates what a platform supports.** A key holding `messages:send` bound
to an Instagram account can send what Instagram supports; anything else returns
`unsupported_capability` (PRD §15.4). Scope answers *may you*; capability answers *can this
platform*. Conflating them is what produces a scope explosion.

**Cost accepted.** One mapping table, and one key to migrate. Trivial at today's scale (§3.4);
this decision is materially harder in six months.

---

### D4 — Account binding: many accounts per key, additively

**Conflict.** PRD §14 shows `allowed_social_accounts: [...]`. The implementation pins exactly one
(`partner_api_keys.social_account_id UUID NOT NULL`).

**Decision.** Move to a many-to-many `partner_api_key_accounts` join table. Retain
`social_account_id` as a generated/maintained "primary account" for the frozen alias endpoint,
which has no way to express account selection.

**Rationale.** One-account-per-key is correct for Danat and wrong for everything else. A
WooCommerce site publishing to five platforms would need five keys, five secrets in
`wp_options`, and five rotations — and the merchant would reasonably store them insecurely. More
importantly, the publishing API (PRD §18) is inherently multi-account: one post fans out across
platforms.

**Non-negotiable constraint.** The join table **must** carry the same composite-FK tenancy proof
as the current column: `FOREIGN KEY (social_account_id, workspace_id) REFERENCES social_accounts
(id, workspace_id)`. This is the control that makes cross-workspace misuse impossible in the
database rather than in application code (2026-08-13 spec §5.1a). A naive join table with two
independent FKs **loses that guarantee silently** and would be the single most dangerous
regression available in this programme.

**Migration.** Additive. Backfill one row per existing key; the `NOT NULL` column stays until the
alias is sunset.

---

### D5 — The webhook delivery outbox is a v1 prerequisite, not a later phase

**Conflict.** The PRD treats webhooks as one product area among several (§22–23). The 2026-08-13
spec §5.5 specified the outbox and it was never built (§3.3.1).

**Decision.** Build `partner_webhook_deliveries` as a transactional outbox **before** any
webhook endpoint is exposed publicly. No webhook API ships on fire-and-forget dispatch.

**Rationale.** The failure mode is not "an event is late" but "an event is lost permanently and
neither side can tell." Because the message row is inserted before dispatch, a dropped dispatch
is unrecoverable: Meta's own redelivery hits the duplicate check and skips. Publishing a webhook
product with that property, and a documented at-least-once guarantee, would be an untrue claim.

Carry forward, unchanged, from the 2026-08-13 spec §5.5:

- atomic claim via `FOR UPDATE SKIP LOCKED` **plus a lease** — explicitly *not* the
  select-then-loop pattern in `whatsapp-scheduled-sender/index.ts:26-32`, which has no atomic
  claim and double-delivers under concurrency;
- backoff ladder 1m / 5m / 30m / 2h / 6h;
- auto-disable only after the ladder is exhausted, surfaced in the UI;
- `UNIQUE (webhook_id, source_event_id)` as the dedup anchor.

**Guarantees published to partners — and no more:** at-least-once delivery; best-effort ordering
(backoff inherently lets event 2 land before event 1's retry; strict per-conversation ordering
would mean head-of-line blocking); immutable event IDs, so **partners deduplicate**.

**Generalisation.** The 2026-08-13 table was WhatsApp-named. v1 names it `partner_webhook_*` and
carries a `platform` column, so the publishing and account event families (PRD §22.4) use the
same machinery.

---

### D6 — Event families: publish only what the platform can actually produce

**Decision.** v1 publishes an event only where a real producer exists. Documented per event with
its delivery mechanism and its latency characteristic, because they differ sharply.

| Event | Producer | Ships in v1? |
|---|---|---|
| `message.received` | Meta webhook / Evolution webhook | Yes |
| `message.sent` | Partner API send path | Yes |
| `message.delivered` / `.read` / `.failed` | Meta status webhook | Yes, WhatsApp Cloud only — **not** available in Evolution QR mode |
| `post.published` / `.failed` | `process-post` result | Yes |
| `post.scheduled` | Scheduling path | Yes |
| `account.reauthorization_required` | `check-connection-health` | Yes |
| `account.connected` / `.disconnected` | OAuth callbacks | Yes |
| `conversation.updated` | — | **No** — no single producer exists today; it would be inferred, and an inferred event with a documented contract is a liability |
| `webhook.test` | Manual trigger | Yes |
| Comment events | Poller (Threads/YouTube) or webhook (Meta) | **No** — deferred; see roadmap Core 4 |

**Latency must be documented per event, not globally.** Events sourced from a Meta webhook are
near-real-time. Events sourced from a poller are bounded by the cron cadence. Publishing both
under one "real-time events" heading would be untrue for the polled ones.

---

### D7 — Rate limiter failure: fail closed for billable operations, open for reads

**Conflict.** PRD §25 requires a deliberate per-risk policy. The implementation
(`partnerApiMetering.ts:84`) fails open for everything.

**Decision.** On limiter unavailability: **reads proceed** (fail open); **billable side effects
are refused** with `503 limiter_unavailable`, `retryable: true`, and `Retry-After`.

**Rationale.** The current comment — "Never fail a send because the limiter is unavailable" —
optimises for availability of a *money-spending, customer-reaching* operation. A limiter outage
combined with a partner retry loop is precisely the scenario rate limiting exists to prevent:
the blast radius is real messages to real customers and real spend, and it is not recoverable by
apology. A refused send is retryable and harmless; an unbounded send storm is neither.

Reads are cheap and idempotent, so failing open there is the right trade.

**This is a deliberate behaviour change to shipped code.** It is safe to make now precisely
because `send_template` has never been called in production (§3.4). Flag it explicitly in the
plan's risk register.

---

### D8 — Two API-key systems: keep both, document the boundary, converge later

**Finding.** Postora has two unrelated API-key systems:

| | `profiles.api_key` | `partner_api_keys` |
|---|---|---|
| Consumer | `n8n-api` | `partner-api` |
| Storage | **Plaintext UUID** on `profiles` | SHA-256 hash |
| Scopes | None — full user authority | Yes |
| Rotation | Regenerate in `src/pages/ApiKeys.tsx` | Not implemented |
| Tenancy | User-scoped | Workspace + account, DB-enforced |

**Decision.** v1 does not merge them. The Partner API model is the strategic one; `n8n-api`
keys continue to serve the n8n node. Document the boundary and mark convergence as post-v1.

**Rationale.** Merging them means reissuing credentials to every n8n user — a migration with a
real blast radius, for an internal consistency benefit, at a time when the Partner API itself is
not yet stable. Sequencing that before v1 GA risks both.

**Recorded as a security observation, not a v1 commitment:** `profiles.api_key` is stored in
plaintext and grants unscoped user-level authority. That is a weaker posture than
`partner_api_keys`, and it should not be extended to new surfaces. New integrations use Partner
API keys.

---

### D9 — Publishing goes through a port, and does not wait for the `process-post` refactor

**Conflict.** PRD §18 requires provider-neutral publishing ports. `process-post/index.ts` is a
7,202-line monolith with a ten-branch platform switch.

**Decision.** The Partner API publishing endpoints call a new `PublishPort` interface. Its v1
implementation **delegates to the existing `process-post` path**. The monolith is not refactored
as part of this programme.

**Rationale.** Coupling a public API programme to a 7,000-line refactor makes both slower and
puts the refactor on the critical path of a contract commitment. The port gives the PRD what it
actually needs — a stable seam, so the public contract does not encode `process-post`'s internal
shape — while letting the refactor proceed independently behind it.

**Consequence to state honestly:** v1 publishing inherits `process-post`'s current per-platform
behaviour, including its failure modes. The port is an *architectural* boundary, not a
behavioural improvement.

---

### D10 — Media: reuse the existing pipeline; no new storage path

**Decision.** `POST /v1/media` accepts an upload and routes it through the existing
Cloudinary/Openinary pipeline, returning a Postora `media_file_id`. Partners never receive
provider credentials or raw provider URLs; downloads are served through a Postora-controlled,
time-bounded URL.

**Rationale.** A second upload path would double the surface for the file-type, size and
malware controls the PRD (§16) requires.

**Documented limit.** Temporary-URL expiry must be stated numerically in the developer docs.
"Temporary" without a number is not a contract.

---

## 7. Target v1 surface

Scoped to what §5's non-goals leave in. Every endpoint requires a scope and is tenant-checked
against the credential's bound accounts (D4).

```text
Accounts
  GET    /v1/accounts                          accounts:read
  GET    /v1/accounts/{id}                     accounts:read

Messaging
  GET    /v1/conversations                     conversations:read
  GET    /v1/conversations/{id}                conversations:read
  GET    /v1/conversations/{id}/messages       messages:read
  GET    /v1/messages/{id}                     messages:read
  POST   /v1/messages                          messages:send      · Idempotency-Key required
  GET    /v1/templates                         templates:read

Media
  POST   /v1/media                             media:write        · Idempotency-Key required
  GET    /v1/media/{id}                        media:read
  GET    /v1/media/{id}/download                media:read

Publishing
  POST   /v1/posts                             posts:write
  GET    /v1/posts/{id}                        posts:read
  GET    /v1/posts/{id}/status                 posts:read
  POST   /v1/posts/{id}/publish                posts:publish      · Idempotency-Key required
  POST   /v1/posts/{id}/schedule               posts:schedule
  DELETE /v1/posts/{id}/schedule               posts:schedule

Webhooks
  GET    /v1/webhooks                          webhooks:read
  POST   /v1/webhooks                          webhooks:manage
  PATCH  /v1/webhooks/{id}                     webhooks:manage
  DELETE /v1/webhooks/{id}                     webhooks:manage
  POST   /v1/webhooks/{id}/rotate-secret       webhooks:manage
  POST   /v1/webhooks/{id}/test                webhooks:manage

Usage
  GET    /v1/usage                             usage:read

Frozen alias — no new actions, sunset per D1
  POST   /partner-api  {action: get_status | list_templates | send_template}
```

**Contacts** (PRD §19) are included only if a v1 consumer requires them; no current consumer
does. Listed here as deferred rather than dropped.

### 7.1 Cross-cutting conventions

- **Pagination:** opaque cursors only. No offset pagination — it is unstable under concurrent
  writes, which conversation and message lists are by definition.
- **IDs:** opaque, prefixed, stable (`acc_`, `conv_`, `msg_`, `post_`, `media_`, `evt_`, `wh_`).
  Provider IDs are exposed as clearly named separate fields, never as the primary ID.
- **Idempotency:** required on every operation marked above. Reusing the existing
  `claim_partner_idempotency` semantics unchanged, including the `attempt_token` fence and the
  indeterminate state.
- **Unknown fields:** clients must ignore them; additive optional fields are non-breaking.

---

## 8. Data-model delta

All migrations additive. Existing tables keep their current shape during the alias window.

| Table | Change | Driven by |
|---|---|---|
| `partner_api_key_accounts` | **New.** Join table. **Must** carry composite FK `(social_account_id, workspace_id)` | D4 |
| `partner_api_keys` | `social_account_id` retained, `NOT NULL` kept until alias sunset | D4 |
| `partner_webhooks` | **New.** Per-subscription HMAC secret, event filter, platform, account filter, health state | D5 |
| `partner_webhook_deliveries` | **New.** Transactional outbox. `UNIQUE (webhook_id, source_event_id)` | D5 |
| `partner_audit_logs` | **New.** Append-only; no `UPDATE`/`DELETE` grant to any role | PRD §30 |
| `partner_api_usage` | Add `meter` dimension (requests / messages / posts / media / webhook deliveries) | PRD §26 |
| `partner_api_keys.scopes` | Values migrate to the generic vocabulary; old values remain accepted | D3 |

**Not created in v1:** `partner_applications`, `partner_oauth_clients`, `partner_oauth_grants`,
`partner_installations` — all deferred with OAuth (§5).

**Naming note.** The PRD §40 lists `partner_idempotency_keys` and `partner_webhooks`. The
existing table is `partner_api_idempotency`. Per PRD §40's own instruction not to duplicate
existing structures merely to satisfy naming, the existing name stands.

---

## 9. Security requirements

Additional to `ARCHITECTURE.md`, which is required reading for any implementer.

1. **Tenancy is proven in the database, not asserted in code.** Every new partner-scoped table
   carries a composite FK to the workspace. This is the single most important invariant in the
   programme (D4).
2. **A caller-supplied ID is never trusted.** Resource IDs are checked against the credential's
   resolved allowance on every request.
3. **Secrets never in URLs.** Keys in headers; webhook secrets never returned after creation.
4. **Webhook signing covers the exact raw body**, with timestamp, and a documented tolerance
   window for replay rejection.
5. **SSRF validation on every webhook destination**, revalidated on every redirect hop —
   matching the hardening already in the n8n node's `safeFetchAndStage`.
6. **Redaction on every log path.** Never log keys, tokens, authorization headers, webhook
   secrets, or message bodies.
7. **The admin UI is not the security boundary.** Backend authorisation is mandatory and
   independent.

---

## 10. Testing and acceptance

Release-blocking, per PRD §46:

- **Tenant isolation.** For every resource family, attempt cross-workspace and cross-account
  access with a valid credential. These tests block release. They are the tests that would catch
  a D4 join table built without its composite FK.
- **Authentication matrix.** Valid / invalid / revoked / expired / insufficient-scope /
  wrong-account.
- **Idempotency.** Duplicate request; same key with a different body; concurrent duplicates;
  provider timeout producing an indeterminate outcome; lease takeover after a dead attempt.
- **Rate limit and quota under concurrency**, including the D7 limiter-unavailable path for both
  a read and a billable send.
- **Webhooks.** Signature; tampered body; timestamp outside tolerance; retry ladder; duplicate
  `event_id`; disabled endpoint; SSRF rejection; and **crash-during-dispatch recovery**, which is
  the specific property the outbox exists to provide.
- **Contract tests** validating the implementation against the OpenAPI document.
- **One certified end-to-end integration** — external client → Partner API → provider → webhook.

### Definition of done per endpoint

PRD §53's sixteen-point list is adopted unchanged and is not restated here.

---

## 11. Open questions

1. **Danat's migration window.** D1 and D3 are cheap only while Danat has not gone live. What is
   Danat's actual timeline, and who owns the coordination? *This is the highest-value unknown in
   the document* — it converts several decisions from cheap to expensive.
2. **Quota source.** Per-key by hand, or derived from `subscription_plans`? Carried forward
   unresolved from the 2026-08-13 spec, open question 3. v1 keeps per-key.
3. **`ecommerce-whatsapp-api` disposition.** Deprecate with a sunset once `/v1` messaging is
   stable, or maintain indefinitely? Carried forward from the 2026-08-13 spec, open question 1.
4. **Webhook delivery volume.** The outbox worker's cadence and concurrency need a load estimate.
   Currently unknowable — zero webhooks exist (§3.4).
5. **Does the n8n node migrate onto `/v1`?** PRD §38 says node operations should call the Partner
   API rather than private surfaces. Today the node calls `n8n-api` with `profiles.api_key`.
   Converging is coherent with D8's "converge later" but needs its own migration plan.

---

## 12. Correction log

Records what changed and why, across review rounds. Entries are appended, never edited.

### v1.0 — 2026-08-25 — initial draft

Authored from the PRD plus a verification pass over the working tree and production database.
Findings that shaped the draft rather than following from the PRD:

- The foundation is far more complete than the PRD assumes; PRD Phase 1 is largely delivered
  (§3.1).
- The delivery outbox specified on 2026-08-13 was never built, and the PRD's webhook product
  depends on it (§3.3.1, D5).
- Exactly one credential exists and it has never sent a message (§3.4) — which is what makes D1,
  D3 and D7 affordable now.
- The rate limiter fails open for billable sends (§3.3.3, D7).
- Two independent API-key systems exist, one storing plaintext keys (D8).
- The Partner API's existing test files are excluded from CI by the vitest `include` pattern, so
  they gate nothing (§3.3.8). Added after the first draft, on a separate verification pass.
