OpenAI Codex v0.147.0
--------
[1mworkdir:[0m F:\Postora_new
[1mmodel:[0m gpt-5.6-sol
[1mprovider:[0m openai
[1mapproval:[0m never
[1msandbox:[0m read-only
[1mreasoning effort:[0m high
[1mreasoning summaries:[0m none
[1msession id:[0m 01a0368b-5170-7f62-b53d-1579f2703828
--------
[36muser[0m
You are an adversarial technical reviewer of a SPECIFICATION document.
DO NOT WRITE OR EDIT CODE. DO NOT CALL ANY TOOL. DO NOT SEARCH GITHUB OR THE WEB.
Your shell is broken in this environment and the repo on GitHub 'main' does NOT contain
these documents. EVERYTHING you need is inlined below. Answer from the inlined text only.

## Verified production facts (queried 2026-08-25). Accept as true; you may dispute conclusions drawn from them.
- partner_api_keys = 1 row: name='Danat Backend', prefix pk_live_urCb, scopes {whatsapp:template.send, whatsapp:templates.read, whatsapp:webhooks.manage}, revoked=false, last_used_at=2026-08-14 01:28 UTC, current_usage_count=0
- partner_api_usage = 4 rows, ALL from 2026-08-14 01:17-01:28: one ''=400 unknown_action, two get_status=200, one list_templates=200. ZERO send_template calls.
- whatsapp_webhooks = 0 rows. No *_deliveries table exists in any of the 225 migrations.
- vite.config.ts vitest include = ["src/**/*.{test,spec}.*"] so supabase/functions/**/*.test.ts NEVER run in CI.
- No openapi/ directory exists. partner_api_keys appears in src/ only in generated types.ts (no minting UI).
- src/pages/ApiKeys.tsx manages profiles.api_key (plaintext UUID, used by n8n-api) - a DIFFERENT system.

## TASK
Attack the Decision Ledger (section 6, D1-D10) and the verified-state claims (section 3) of the spec inlined below.
1. Falsify section 3 where the source excerpts contradict it.
2. For EACH decision D1-D10 state AGREE or DISAGREE + the concrete failure if wrong. Prioritise expensive/irreversible mistakes.
3. What decision is MISSING that an implementer would be forced to invent? What PRD requirement is silently dropped without being listed as a non-goal? What tenancy/security hole does section 9 fail to close?
4. Are D5 (webhook outbox is a prerequisite) and D9 (do not refactor process-post) compatible with a shippable phase order?

## OUTPUT FORMAT - findings only, no rewrite, do not summarise the spec back to me
Numbered findings, most severe first:
**Finding N - [blocker|major|minor] - <one-line claim>**
- Evidence: <spec section or source excerpt below>
- Why it matters: <concrete failure>
- Recommendation: <1-2 sentences>
End with (a) the 3 decisions most likely WRONG, (b) what is well-reasoned and must NOT change.

=============== DOCUMENT UNDER REVIEW ===============
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

=============== SOURCE EXCERPT: supabase/functions/partner-api/router.ts ===============
import type { PartnerScope } from "../_shared/partnerApiKeys.ts";

/** null = no scope required; undefined = unknown action. */
const ACTION_SCOPES: Record<string, PartnerScope | null> = {
  get_status: null,
  send_template: "whatsapp:template.send",
  list_templates: "whatsapp:templates.read",
};

export function requiredScopeFor(action: string): PartnerScope | null | undefined {
  // Object.hasOwn, not `in`: `in` walks the prototype chain, so an action
  // named "toString" or "constructor" would resolve as a known action.
  return Object.hasOwn(ACTION_SCOPES, action) ? ACTION_SCOPES[action] : undefined;
}

/** Send actions cost money and reach a real customer, so they demand an
 *  Idempotency-Key and consume quota. Reads do neither. */
export function isSendAction(action: string): boolean {
  return action === "send_template";
}

=============== SOURCE EXCERPT: supabase/functions/_shared/partnerApiKeys.ts ===============
// Partner API key generation and authentication.
//
// Keys are shown to the operator exactly once and stored only as a SHA-256
// hex digest, following the mcp_oauth_tokens precedent — a database leak
// yields no usable credentials.

const KEY_PREFIX = "pk_live_";
const BASE62 = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

export type PartnerScope =
  | "whatsapp:template.send"
  | "whatsapp:templates.read"
  | "whatsapp:webhooks.manage";

export interface PartnerKeyRecord {
  id: string;
  workspaceId: string;
  socialAccountId: string;
  keyPrefix: string;
  scopes: string[];
  rateLimitPerMin: number;
  monthlyQuota: number | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export class PartnerAuthError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "PartnerAuthError";
  }
}

/** Async because SubtleCrypto's digest is the only hash available in the
 *  edge runtime — node:crypto is not reliably present. */
export async function generatePartnerKey(): Promise<{
  key: string;
  prefix: string;
  hash: string;
}> {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let body = "";
  for (const b of bytes) body += BASE62[b % BASE62.length];
  const key = KEY_PREFIX + body;
  return { key, prefix: key.slice(0, 12), hash: await hashPartnerKey(key) };
}

export async function hashPartnerKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(key),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function authenticatePartnerKey(
  // deno-lint-ignore no-explicit-any
  client: any,
  presentedKey: string,
  now: Date = new Date(),
): Promise<PartnerKeyRecord> {
  if (!presentedKey || !presentedKey.startsWith(KEY_PREFIX)) {
    throw new PartnerAuthError("Invalid API key", "invalid_key", 401);
  }

  const hash = await hashPartnerKey(presentedKey);
  const { data, error } = await client
    .from("partner_api_keys")
    .select(
      "id, workspace_id, social_account_id, key_prefix, scopes, " +
        "rate_limit_per_min, monthly_quota, expires_at, revoked_at",
    )
    .eq("key_hash", hash)
    .maybeSingle();

  if (error) throw new PartnerAuthError("Key lookup failed", "internal_error", 500);
  // Same response for "no such key" as for a malformed one: non-enumerable.
  if (!data) throw new PartnerAuthError("Invalid API key", "invalid_key", 401);

  if (data.revoked_at) {
    throw new PartnerAuthError("API key revoked", "key_revoked", 401);
  }
  if (data.expires_at && new Date(data.expires_at) <= now) {
    throw new PartnerAuthError("API key expired", "key_expired", 401);
  }

  return {
    id: data.id,
    workspaceId: data.workspace_id,
    socialAccountId: data.social_account_id,
    keyPrefix: data.key_prefix,
    scopes: data.scopes ?? [],
    rateLimitPerMin: data.rate_limit_per_min,
    monthlyQuota: data.monthly_quota,
    expiresAt: data.expires_at,
    revokedAt: data.revoked_at,
  };
}

export function assertScope(
  record: PartnerKeyRecord,
  scope: PartnerScope,
): void {
  if (!record.scopes.includes(scope)) {
    throw new PartnerAuthError(
      `This key lacks the ${scope} scope`,
      "insufficient_scope",
      403,
    );
  }
}

=============== SOURCE EXCERPT: supabase/functions/_shared/partnerApiMetering.ts ===============
// Rate limiting, monthly quota, and the usage ledger for partner API keys.
//
// Deliberately NOT built on api_logs: that table is keyed by (user_id,
// endpoint) with no key column, and the existing ecommerce limiter counts
// then inserts, which two concurrent requests can both pass.

import { type PartnerKeyRecord, PartnerAuthError } from "./partnerApiKeys.ts";

export interface UsageInput {
  keyId: string;
  workspaceId: string;
  action: string;
  billable: boolean;
  httpStatus: number;
  errorCode?: string;
}

/**
 * Reserve one unit of monthly quota before sending. Returns false when the
 * reservation would exceed quota — the caller must then settle the pending
 * idempotency claim rather than leaving it in `processing`.
 *
 * Reserve/settle rather than consume-on-entry, because the plan promises a
 * partner is charged only for messages Meta accepted.
 */
export async function reserveQuota(
  // deno-lint-ignore no-explicit-any
  client: any,
  record: PartnerKeyRecord,
): Promise<boolean> {
  const { data, error } = await client.rpc("reserve_partner_quota", {
    p_key_id: record.id,
  });
  if (error) {
    throw new PartnerAuthError("Quota check failed", "internal_error", 500);
  }
  const row = Array.isArray(data) ? data[0] : data;
  return Boolean(row?.allowed);
}

/** Refund a reservation after Meta DEFINITELY rejected the send. Never call
 *  this for an indeterminate outcome — the message may have been delivered. */
export async function releaseQuota(
  // deno-lint-ignore no-explicit-any
  client: any,
  record: PartnerKeyRecord,
): Promise<void> {
  const { error } = await client.rpc("release_partner_quota", { p_key_id: record.id });
  if (error) console.error("[partner-api] quota release failed:", error.message);
}

/**
 * Non-send actions never reserve quota, so they update last_used_at here.
 *
 * Failure is logged, not thrown: a missing last_used_at stamp must never turn a
 * successful read into an error for the caller.
 */
export async function touchKey(
  // deno-lint-ignore no-explicit-any
  client: any,
  record: PartnerKeyRecord,
): Promise<void> {
  const { error } = await client.rpc("touch_partner_key", { p_key_id: record.id });
  if (error) console.error("[partner-api] touch key failed:", error.message);
}

/**
 * Per-minute rate limit via an atomic bucket.
 *
 * Counting rows in the usage ledger and inserting afterwards would be the
 * same count-then-insert race the spec rejects — concurrent requests all read
 * the same stale count and all pass. consume_partner_rate does the increment
 * and the read in one statement.
 */
export async function checkRateLimit(
  // deno-lint-ignore no-explicit-any
  client: any,
  record: PartnerKeyRecord,
): Promise<void> {
  const { data, error } = await client.rpc("consume_partner_rate", {
    p_key_id: record.id,
    p_limit: record.rateLimitPerMin,
  });
  if (error) return; // Never fail a send because the limiter is unavailable.
  if (data === false) {
    throw new PartnerAuthError("Rate limit exceeded", "rate_limited", 429);
  }
}

/**
 * Append to the usage ledger. Swallows its own errors on purpose: losing an
 * audit row must never turn a delivered message into a reported failure.
 */
export async function recordUsage(
  // deno-lint-ignore no-explicit-any
  client: any,
  input: UsageInput,
): Promise<void> {
  try {
    const { error } = await client.from("partner_api_usage").insert({
      key_id: input.keyId,
      workspace_id: input.workspaceId,
      action: input.action,
      billable: input.billable,
      http_status: input.httpStatus,
      error_code: input.errorCode ?? null,
    });
    if (error) console.error("[partner-api] usage ledger write failed:", error.message);
  } catch (err) {
    console.error("[partner-api] usage ledger threw:", err);
  }
}

=============== SOURCE EXCERPT: supabase/functions/partner-api/index.ts (the whole adapter) ===============
// Partner API — machine-authenticated door into WhatsApp sending.
//
// This function authenticates and authorizes; all WhatsApp behaviour lives in
// _shared/whatsappPartnerOps.ts, which the JWT door also calls.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import {
  assertScope,
  authenticatePartnerKey,
  PartnerAuthError,
  type PartnerKeyRecord,
} from "../_shared/partnerApiKeys.ts";
import {
  checkRateLimit,
  recordUsage,
  releaseQuota,
  reserveQuota,
  touchKey,
} from "../_shared/partnerApiMetering.ts";
import {
  claimIdempotency,
  completeIdempotency,
  hashRequest,
  markIndeterminate,
} from "../_shared/partnerApiIdempotency.ts";
import {
  listTemplates,
  sendTemplate,
  WhatsAppOpError,
} from "../_shared/whatsappPartnerOps.ts";
import { isSendAction, requiredScopeFor } from "./router.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-postora-key, idempotency-key",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  // Without this a browser caller cannot read the correlation handle the API
  // documents, nor tell a replay from a fresh send.
  "Access-Control-Expose-Headers": "x-postora-request-id, idempotency-replayed, retry-after",
};

function json(body: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", ...extra },
  });
}

function errorBody(code: string, message: string, retryable: boolean, details?: unknown) {
  return { success: false, error: { code, message, retryable, ...(details ? { details } : {}) } };
}

/**
 * Every response carries a request id, success or failure.
 *
 * Without one a partner reporting "the 09:14 send failed" gives us nothing to
 * grep for: the partner key is hashed, message bodies are never logged, and a
 * failed send has no Meta message id. This is the only correlation handle
 * between their logs and ours, and the spec requires it in the normalized
 * response.
 */
function withRequestId<T extends Record<string, unknown>>(
  body: T,
  requestId: string,
): T & { request_id: string } {
  return { ...body, request_id: requestId };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Declared first: every exit path below stamps it, including the ones that
  // run before a key is authenticated. `const` is not hoisted, so declaring it
  // later would make the method-not-allowed branch a ReferenceError.
  const requestId = crypto.randomUUID();
  if (req.method !== "POST") {
    // Before authentication, so there is no key to bill and no ledger row -
    // but the caller still gets a correlatable id.
    return json(withRequestId(errorBody("method_not_allowed", "Use POST", false), requestId),
                405, { "X-Postora-Request-Id": requestId });
  }

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let record: PartnerKeyRecord | null = null;
  let action = "unknown";
  let idempotencyKey: string | null = null;

  // Bound once so every exit path stamps the request id automatically. The
  // alternative - adding a trailing argument at each call site - is how
  // touchKey ended up implemented but never called.
  const finish = (
    status: number,
    billable: boolean,
    body: unknown,
    extraHeaders: Record<string, string> = {},
    errorCode?: string,
  ) => respond(admin, record!, action, status, billable, body, extraHeaders,
               errorCode, requestId);

  try {
    record = await authenticatePartnerKey(admin, req.headers.get("x-postora-key") ?? "");

    const body = await req.json().catch(() => ({}));
    action = String(body.action ?? "");

    const scope = requiredScopeFor(action);
    if (scope === undefined) {
      return await finish(400, false,
        errorBody("unknown_action", `Unknown action: ${action}`, false), {}, "unknown_action");
    }
    if (scope !== null) assertScope(record, scope);

    await checkRateLimit(admin, record);

    // Resolve the key's pinned account. The composite FK already guarantees it
    // belongs to this workspace, so this read cannot cross a tenant boundary.
    const { data: account, error: accountError } = await admin
      .from("social_accounts")
      // One string literal, not a concatenation: supabase-js resolves the
      // column list at the TYPE level, and a non-literal collapses the row
      // type to GenericStringError.
      .select("id, user_id, workspace_id, platform, platform_user_id, access_token, connection_mode, is_active, needs_reauth, token_expires_at, account_metadata")
      .eq("id", record.socialAccountId)
      .maybeSingle();

    // A database error is not "not connected" — do not disguise one as the other.
    if (accountError) {
      return await finish(
        500, false,
        errorBody("internal_error", "Could not resolve the account", true),
        {}, "internal_error",
      );
    }

    // The composite FK proves the account is in this workspace. It does NOT
    // prove the account is WhatsApp — a mis-created key could pin a Facebook
    // page, so check platform explicitly, as the human resolver does
    // (_shared/whatsappWorkspaceAccess.ts:124-136).
    if (!account || account.platform !== "whatsapp" || !account.is_active) {
      return await finish(
        409, false,
        errorBody("account_not_connected", "The WhatsApp account is not connected", false),
        {}, "account_not_connected",
      );
    }

    // Spec §9: preflight health, so a partner gets a typed, actionable error
    // instead of a raw Meta rejection. refresh-tokens has no WhatsApp path,
    // so an expired token stays expired until someone reconnects.
    const tokenExpired = account.token_expires_at &&
      new Date(account.token_expires_at) <= new Date();
    if (account.needs_reauth || tokenExpired) {
      return await finish(
        401, false,
        errorBody("account_needs_reauth",
          "The WhatsApp connection needs to be re-authorized in Postora", false),
        {}, "account_needs_reauth",
      );
    }

    const ctx = {
      admin,
      accountId: account.id,
      ownerId: account.user_id,
      workspaceId: account.workspace_id,
      phoneNumberId: account.platform_user_id,
      accessToken: account.access_token,
      connectionMode: account.connection_mode,
    };

    if (action === "get_status") {
      await touchKey(admin, record);
      return await finish(200, false, {
        success: true,
        whatsapp_connected: true,
        phone_number_id: account.platform_user_id,
        workspace_id: account.workspace_id,
      });
    }

    if (action === "list_templates") {
      const wabaId = (account.account_metadata as Record<string, unknown> | null)?.waba_id;
      if (!wabaId) {
        return await finish(
          409, false,
          errorBody("account_not_connected", "No WABA id recorded for this account", false),
        );
      }
      const templates = await listTemplates(ctx, String(wabaId));
      await touchKey(admin, record);
      return await finish(200, false, { success: true, templates });
    }

    // ---- send_template ----
    idempotencyKey = req.headers.get("idempotency-key");
    if (isSendAction(action) && !idempotencyKey) {
      return await finish(
        400, false,
        errorBody("missing_idempotency_key", "Idempotency-Key header is required for sends", false),
      );
    }

    // Validate BEFORE claiming. Claiming first would leave an invalid request
    // stuck in `processing` forever, poisoning that idempotency key.
    if (!body.recipient_phone || !body.template_name) {
      return await finish(
        400, false,
        errorBody("invalid_request", "recipient_phone and template_name are required", false),
      );
    }

    const requestHash = await hashRequest({
      action,
      recipient_phone: body.recipient_phone,
      template_name: body.template_name,
      template_language: body.template_language,
      template_components: body.template_components ?? null,
    });

    const claim = await claimIdempotency(admin, record.id, idempotencyKey!, requestHash);
    // Held for the rest of the request; every settle is fenced on it.
    const attemptToken = claim.outcome === "claimed" ? claim.attemptToken : "";

    if (claim.outcome === "replay") {
      // A replay must not consume quota, but it IS still a request the partner
      // made: recording it non-billable keeps the ledger able to reconstruct
      // retry activity. Not consuming quota and not being recorded are two
      // different things.
      return await finish(
        claim.httpStatus, false, claim.body,
        { "Idempotency-Replayed": "true" },
      );
    }
    if (claim.outcome === "conflict") {
      return await finish(
        409, false,
        errorBody("idempotency_conflict", "This Idempotency-Key was used with a different body", false),
      );
    }
    if (claim.outcome === "in_progress") {
      return await finish(
        409, false,
        errorBody("idempotency_in_progress", "An identical request is still processing", true),
        { "Retry-After": "2" },
      );
    }
    if (claim.outcome === "indeterminate") {
      return await finish(
        409, false,
        errorBody("idempotency_indeterminate",
          "A previous attempt may have been delivered; resolve it before retrying", false),
      );
    }

    // Reserve quota only once we are actually about to send. On any definite
    // rejection below we release it, so a partner is charged only for messages
    // Meta accepted. On an indeterminate outcome we deliberately do NOT
    // release: the message may have been delivered.
    const reserved = await reserveQuota(admin, record);
    if (!reserved) {
      // reserve_partner_quota increments before it reports, so a refused
      // attempt must give its unit back. Otherwise every rejected call pushes
      // current_usage_count further past the quota and the number stops
      // meaning anything for reporting.
      await releaseQuota(admin, record);
      // Settle the idempotency claim before returning, or a retry of this same
      // request would see `processing` forever instead of a clear quota error.
      const body = errorBody("quota_exceeded", "Monthly quota exhausted for this key", false);
      await completeIdempotency(admin, record.id, idempotencyKey!, attemptToken, 429, body)
        .catch((e) => console.error("[partner-api] settle after quota refusal failed:", e));
      return await finish(429, false, body, {}, "quota_exceeded");
    }

    try {
      const result = await sendTemplate(ctx, {
        recipientPhone: String(body.recipient_phone),
        templateName: String(body.template_name),
        templateLanguage: String(body.template_language ?? "en_US"),
        components: body.template_components,
      });

      const success = {
        success: true,
        message_id: result.messageId,
        state: "accepted_by_meta",
        recorded_in_inbox: result.persisted,
      };

      // Meta has ACCEPTED the message at this point — the customer may already
      // have it. A bookkeeping failure here must never be reported as a failed
      // or indeterminate send, or the partner will show a delivered message as
      // undelivered. But the claim still has to be settled somehow: if the row
      // stays `processing`, its lease expires, and the partner's retry would
      // take it over and send a SECOND message to a real customer.
      try {
        await completeIdempotency(admin, record.id, idempotencyKey!, attemptToken, 200, success);
      } catch (settleError) {
        console.error("[partner-api] settle failed after a successful send:", settleError);
        // Best effort, and deliberately not awaited into the failure path:
        // `indeterminate` is the one state no retry will ever re-send from,
        // which is exactly the protection needed here.
        await markIndeterminate(admin, record.id, idempotencyKey!, attemptToken).catch(() => {});
      }

      return await finish(200, true, success);
    } catch (err) {
      // A network failure after the request left leaves us unable to know
      // whether Meta delivered it. Never auto-retry, and never release the
      // quota reservation — the message may well have been sent.
      if (!(err instanceof WhatsAppOpError)) {
        await markIndeterminate(admin, record.id, idempotencyKey!, attemptToken);
        const body = errorBody("idempotency_indeterminate",
          "The send may have been delivered; resolve it before retrying", false);
        return await finish(409, false, body, {},
          "idempotency_indeterminate");
      }
      // Only a DEFINITE rejection may be refunded and settled as a failure.
      // An indeterminate one (5xx, missing message id) may already have
      // reached the customer, so it keeps its quota unit and becomes
      // non-resendable — the same treatment as a transport failure.
      if (err.indeterminate) {
        await markIndeterminate(admin, record.id, idempotencyKey!, attemptToken)
          .catch((e) => console.error("[partner-api] indeterminate mark failed:", e));
        const body = errorBody("idempotency_indeterminate",
          "The send may have been delivered; resolve it before retrying", false,
          err.metaCode ? { meta_code: err.metaCode } : undefined);
        return await finish(409, false, body, {},
          "idempotency_indeterminate");
      }
      await releaseQuota(admin, record);
      const failure = errorBody(err.code, err.message, false,
        err.metaCode ? { meta_code: err.metaCode } : undefined);
      // Settling must not turn a clean rejection into a generic 500.
      await completeIdempotency(admin, record.id, idempotencyKey!, attemptToken, err.status, failure)
        .catch((e) => console.error("[partner-api] settle after rejection failed:", e));
      return await finish(err.status, false, failure, {}, err.code);
    }
  } catch (err) {
    // listTemplates and the account lookups can also throw WhatsAppOpError.
    // Without this branch a token failure while listing templates would be
    // reported as a generic internal_error instead of account_needs_reauth.
    if (err instanceof WhatsAppOpError) {
      const body = errorBody(err.code, err.message, err.status >= 500,
        err.metaCode ? { meta_code: err.metaCode } : undefined);
      if (record) return await finish(err.status, false, body, {}, err.code);
      return json(withRequestId(body, requestId), err.status,
                  { "X-Postora-Request-Id": requestId });
    }
    if (err instanceof PartnerAuthError) {
      const retryable = err.code === "rate_limited";
      const body = errorBody(err.code, err.message, retryable);
      if (record) {
        return await finish(err.status, false, body, {}, err.code);
      }
      // No key resolved yet, so there is no ledger row to write - but the
      // caller still gets a correlatable id.
      return json(withRequestId(body, requestId), err.status,
                  { "X-Postora-Request-Id": requestId });
    }
    console.error(`[partner-api] unhandled (request ${requestId}, key ${record?.keyPrefix ?? "none"}):`, err);
    const body = errorBody("internal_error", "Unexpected error", true);
    if (record) return await finish(500, false, body, {}, "internal_error");
    return json(withRequestId(body, requestId), 500,
                { "X-Postora-Request-Id": requestId });
  }
});

/** Emit the response, stamp it with the request id, and append exactly one
 *  usage-ledger row for it. */
async function respond(
  // deno-lint-ignore no-explicit-any
  admin: any,
  record: PartnerKeyRecord,
  action: string,
  status: number,
  billable: boolean,
  body: unknown,
  extraHeaders: Record<string, string> = {},
  errorCode?: string,
  requestId?: string,
) {
  await recordUsage(admin, {
    keyId: record.id,
    workspaceId: record.workspaceId,
    action,
    billable,
    httpStatus: status,
    errorCode,
  });
  const stamped = requestId && body && typeof body === "object"
    ? withRequestId(body as Record<string, unknown>, requestId)
    : body;
  // Also a header, so a partner can correlate without parsing the body -
  // which matters for the 5xx paths where the body may not be ours.
  return json(stamped, status, {
    ...extraHeaders,
    ...(requestId ? { "X-Postora-Request-Id": requestId } : {}),
  });
}

=============== SOURCE EXCERPT: migration 20260813120000_partner_api_foundation.sql ===============

-- Partner API: machine-authenticated, workspace-scoped access to WhatsApp sending.
-- Keys are hashed at rest and pinned to exactly one social account.

-- A composite FK needs a matching unique constraint on the referenced side.
-- Redundant with the PK, but it is what makes (id, workspace_id) referenceable.
ALTER TABLE public.social_accounts
  ADD CONSTRAINT social_accounts_id_workspace_key UNIQUE (id, workspace_id);

-- WhatsApp accounts must be workspace-scoped. All 4 live rows already are;
-- other platforms are deliberately left alone.
ALTER TABLE public.social_accounts
  ADD CONSTRAINT social_accounts_whatsapp_needs_workspace
  CHECK (platform <> 'whatsapp' OR workspace_id IS NOT NULL) NOT VALID;

-- Validate in the migration itself. Leaving it NOT VALID would enforce new
-- writes but leave the constraint catalogued as unvalidated in production,
-- so nothing would ever prove the existing rows comply. All 4 whatsapp rows
-- were verified populated on 2026-08-13; if this fails, a non-compliant row
-- appeared since and must be backfilled before deploying.
ALTER TABLE public.social_accounts
  VALIDATE CONSTRAINT social_accounts_whatsapp_needs_workspace;

CREATE TABLE public.partner_api_keys (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  social_account_id   UUID NOT NULL,
  created_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_by          UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_reason      TEXT,
  name                TEXT NOT NULL,
  key_prefix          TEXT NOT NULL,
  key_hash            TEXT NOT NULL UNIQUE,
  scopes              TEXT[] NOT NULL DEFAULT '{}',
  rate_limit_per_min  INTEGER NOT NULL DEFAULT 60,
  monthly_quota       INTEGER,
  current_usage_count INTEGER NOT NULL DEFAULT 0,
  last_reset_at       TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now()),
  last_used_at        TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ,
  revoked_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- The control that makes cross-workspace key misuse impossible in the database.
  CONSTRAINT partner_api_keys_account_in_workspace
    FOREIGN KEY (social_account_id, workspace_id)
    REFERENCES public.social_accounts (id, workspace_id) ON DELETE CASCADE
);

-- Referenced by partner_api_usage's composite FK below.
ALTER TABLE public.partner_api_keys
  ADD CONSTRAINT partner_api_keys_id_workspace_key UNIQUE (id, workspace_id);

CREATE INDEX partner_api_keys_hash_active_idx
  ON public.partner_api_keys (key_hash) WHERE revoked_at IS NULL;
CREATE INDEX partner_api_keys_workspace_idx
  ON public.partner_api_keys (workspace_id);

CREATE TABLE public.partner_api_idempotency (
  key_id          UUID NOT NULL REFERENCES public.partner_api_keys(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('processing','completed','indeterminate')),
  -- Fencing token. A state predicate alone cannot protect this row: taking
  -- over an expired lease leaves state = 'processing', so a revived stale
  -- writer would still satisfy `state = 'processing'` and could settle the
  -- NEW owner's row with its own result. Every claim and every takeover mints
  -- a fresh token, and only the holder of the current token may settle.
  attempt_token   UUID NOT NULL DEFAULT gen_random_uuid(),
  http_status     INTEGER,
  response_body   JSONB,
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '7 days',
  PRIMARY KEY (key_id, idempotency_key)
);

CREATE INDEX partner_api_idempotency_expiry_idx
  ON public.partner_api_idempotency (expires_at);

-- The two foreign keys below are each individually valid but, declared
-- separately, would allow a usage row whose workspace_id is not the key's
-- workspace -- silently corrupting per-workspace billing and reporting.
-- A composite FK against (id, workspace_id) makes the pairing impossible,
-- the same technique used for account tenancy on partner_api_keys.
CREATE TABLE public.partner_api_usage (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id       UUID NOT NULL,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  action       TEXT NOT NULL,
  billable     BOOLEAN NOT NULL DEFAULT false,
  http_status  INTEGER NOT NULL,
  error_code   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- RESTRICT, not CASCADE: usage rows are billing history and must outlive
  -- day-to-day key churn. Keys are meant to be REVOKED, not deleted; if a key
  -- genuinely must be removed, its usage has to be archived deliberately
  -- rather than disappearing as a side effect.
  CONSTRAINT partner_api_usage_key_in_workspace
    FOREIGN KEY (key_id, workspace_id)
    REFERENCES public.partner_api_keys (id, workspace_id) ON DELETE RESTRICT
);

CREATE INDEX partner_api_usage_ws_time_idx
  ON public.partner_api_usage (workspace_id, created_at DESC);
CREATE INDEX partner_api_usage_key_time_idx
  ON public.partner_api_usage (key_id, created_at DESC);

-- Per-key, per-minute rate limit bucket. Counting rows in the usage ledger
-- would be the same non-atomic count-then-insert the spec rejects: concurrent
-- requests all read the same old count and all pass. INSERT .. ON CONFLICT
-- DO UPDATE .. RETURNING is a single atomic statement instead.
CREATE TABLE public.partner_api_rate_buckets (
  key_id       UUID NOT NULL REFERENCES public.partner_api_keys(id) ON DELETE CASCADE,
  window_start TIMESTAMPTZ NOT NULL,
  request_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, window_start)
);

CREATE OR REPLACE FUNCTION public.consume_partner_rate(p_key_id UUID, p_limit INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count INTEGER;
BEGIN
  INSERT INTO public.partner_api_rate_buckets (key_id, window_start, request_count)
  VALUES (p_key_id, date_trunc('minute', now()), 1)
  ON CONFLICT (key_id, window_start)
  DO UPDATE SET request_count = partner_api_rate_buckets.request_count + 1
  RETURNING request_count INTO v_count;

  RETURN v_count <= p_limit;
END;
$$;

-- Quota is RESERVED before the send and SETTLED after, because the plan
-- promises quota is consumed only by a Meta-accepted send. A single
-- increment-then-check would charge the partner for 4xx rejections too.
--
-- reserve: increments and reports whether the reservation is within quota.
-- release: decrements, called when Meta definitely rejected the send.
-- Nothing is released for an indeterminate send — it may have been delivered.
CREATE OR REPLACE FUNCTION public.reserve_partner_quota(p_key_id UUID)
RETURNS TABLE (allowed BOOLEAN, usage_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_quota INTEGER;
  v_count INTEGER;
BEGIN
  UPDATE public.partner_api_keys k
     SET current_usage_count =
           CASE WHEN k.last_reset_at < date_trunc('month', now())
                THEN 1 ELSE k.current_usage_count + 1 END,
         last_reset_at = date_trunc('month', now()),
         last_used_at  = now()
   WHERE k.id = p_key_id
   RETURNING k.monthly_quota, k.current_usage_count
        INTO v_quota, v_count;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0;
    RETURN;
  END IF;

  RETURN QUERY SELECT (v_quota IS NULL OR v_count <= v_quota), v_count;
END;
$$;

CREATE OR REPLACE FUNCTION public.release_partner_quota(p_key_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.partner_api_keys
     SET current_usage_count = GREATEST(current_usage_count - 1, 0)
   WHERE id = p_key_id;
$$;

-- Touch last_used_at for non-send actions, which never reserve quota.
CREATE OR REPLACE FUNCTION public.touch_partner_key(p_key_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.partner_api_keys SET last_used_at = now() WHERE id = p_key_id;
$$;

-- The idempotency claim lives in SQL, not in the edge function.
--
-- Doing it in JS needs insert -> catch 23505 -> re-read, which cannot express
-- "take over a lease that expired" without another race. One statement here
-- is atomic, handles stale leases and row expiry in the same place, and is
-- directly testable with psql.
--
-- Returns one row: outcome in
--   claimed | replay | conflict | in_progress | indeterminate
CREATE OR REPLACE FUNCTION public.claim_partner_idempotency(
  p_key_id UUID,
  p_idempotency_key TEXT,
  p_request_hash TEXT,
  -- MUST exceed the maximum end-to-end send deadline, with margin.
  -- The auto-registration path allows send(30s) + register(15s) + retry(30s)
  -- = 75s. A 60s lease would let a SECOND caller take over a request that is
  -- still in flight, and both would send to the same customer. 300s leaves
  -- room for that worst case plus retries and clock skew; the cost of a lease
  -- that is too long is only a delayed recovery, while one that is too short
  -- is a duplicate message.
  p_lease_seconds INTEGER DEFAULT 300
)
RETURNS TABLE (outcome TEXT, http_status INTEGER, response_body JSONB, attempt_token UUID)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row   public.partner_api_idempotency%ROWTYPE;
  v_token UUID;
BEGIN
  -- Opportunistic pruning: expired rows must not resurrect as false replays.
  DELETE FROM public.partner_api_idempotency
   WHERE key_id = p_key_id AND expires_at < now();

  v_token := gen_random_uuid();

  INSERT INTO public.partner_api_idempotency
    (key_id, idempotency_key, request_hash, state, locked_until, attempt_token)
  VALUES
    (p_key_id, p_idempotency_key, p_request_hash, 'processing',
     now() + make_interval(secs => p_lease_seconds), v_token)
  ON CONFLICT (key_id, idempotency_key) DO NOTHING;

  IF FOUND THEN
    RETURN QUERY SELECT 'claimed'::TEXT, NULL::INTEGER, NULL::JSONB, v_token;
    RETURN;
  END IF;

  -- Lock the existing row so two concurrent duplicates cannot both take over
  -- the same expired lease.
  SELECT * INTO v_row
    FROM public.partner_api_idempotency
   WHERE key_id = p_key_id AND idempotency_key = p_idempotency_key
     FOR UPDATE;

  IF NOT FOUND THEN
    -- Pruned between the insert and the read; retry is safe and cheap.
    RETURN QUERY SELECT 'in_progress'::TEXT, NULL::INTEGER, NULL::JSONB, NULL::UUID;
    RETURN;
  END IF;

  IF v_row.request_hash IS DISTINCT FROM p_request_hash THEN
    RETURN QUERY SELECT 'conflict'::TEXT, NULL::INTEGER, NULL::JSONB, NULL::UUID;
    RETURN;
  END IF;

  IF v_row.state = 'completed' THEN
    RETURN QUERY SELECT 'replay'::TEXT, v_row.http_status, v_row.response_body, NULL::UUID;
    RETURN;
  END IF;

  IF v_row.state = 'indeterminate' THEN
    -- The first attempt may have reached Meta. Never silently re-send.
    RETURN QUERY SELECT 'indeterminate'::TEXT, NULL::INTEGER, NULL::JSONB, NULL::UUID;
    RETURN;
  END IF;

  -- state = 'processing'. A live lease means a genuine concurrent duplicate;
  -- an expired one means the previous attempt died before settling, so this
  -- caller takes it over rather than wedging the key forever.
  IF v_row.locked_until IS NOT NULL AND v_row.locked_until > now() THEN
    RETURN QUERY SELECT 'in_progress'::TEXT, NULL::INTEGER, NULL::JSONB, NULL::UUID;
    RETURN;
  END IF;

  -- Takeover: mint a NEW token so the previous holder can no longer settle.
  UPDATE public.partner_api_idempotency
     SET locked_until  = now() + make_interval(secs => p_lease_seconds),
         attempt_token = v_token
   WHERE key_id = p_key_id AND idempotency_key = p_idempotency_key;

  RETURN QUERY SELECT 'claimed'::TEXT, NULL::INTEGER, NULL::JSONB, v_token;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_partner_idempotency(UUID, TEXT, TEXT, INTEGER)
  FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.claim_partner_idempotency(UUID, TEXT, TEXT, INTEGER)
  TO service_role;

REVOKE ALL ON FUNCTION public.consume_partner_rate(UUID, INTEGER) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION public.reserve_partner_quota(UUID) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION public.release_partner_quota(UUID) FROM PUBLIC, authenticated, anon;
REVOKE ALL ON FUNCTION public.touch_partner_key(UUID) FROM PUBLIC, authenticated, anon;
GRANT EXECUTE ON FUNCTION public.consume_partner_rate(UUID, INTEGER) TO service_role;
GRANT EXECUTE ON FUNCTION public.reserve_partner_quota(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_partner_quota(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.touch_partner_key(UUID) TO service_role;

ALTER TABLE public.partner_api_keys         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_api_idempotency  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_api_usage        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partner_api_rate_buckets ENABLE ROW LEVEL SECURITY;

-- Idempotency and usage are service-role only: RLS on, no policies, no grants.

-- Keys: workspace admins/owners may read metadata and revoke. Never the hash.
CREATE POLICY "Workspace admins read partner keys"
ON public.partner_api_keys FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.workspace_members m
   WHERE m.workspace_id = partner_api_keys.workspace_id
     AND m.user_id = auth.uid()
     AND m.role IN ('owner','admin')
));

-- No UPDATE policy: revocation goes through revoke_partner_key() below, so
-- there is no path by which a client can clear revoked_at.

-- Column-level grants, mirroring the mcp_oauth_tokens precedent: key_hash is
-- never selectable by a client, and only revocation fields are writable.
REVOKE ALL ON public.partner_api_keys FROM authenticated;
GRANT SELECT (id, workspace_id, social_account_id, created_by, revoked_by,
              revoked_reason, name, key_prefix, scopes, rate_limit_per_min,
              monthly_quota, current_usage_count, last_reset_at, last_used_at,
              expires_at, revoked_at, created_at, updated_at)
  ON public.partner_api_keys TO authenticated;

-- Revocation is a one-way door, so it is NOT a granted UPDATE.
-- Granting UPDATE(revoked_at) would let an admin set it back to NULL and
-- silently un-revoke a key that was revoked because it leaked. This function
-- refuses to act on an already-revoked key and stamps the actor server-side.
CREATE OR REPLACE FUNCTION public.revoke_partner_key(p_key_id UUID, p_reason TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  UPDATE public.partner_api_keys k
     SET revoked_at = now(), revoked_by = auth.uid(), revoked_reason = p_reason
   WHERE k.id = p_key_id
     AND k.revoked_at IS NULL
     AND EXISTS (
       SELECT 1 FROM public.workspace_members m
        WHERE m.workspace_id = k.workspace_id
          AND m.user_id = auth.uid()
          AND m.role IN ('owner','admin'));
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

-- Revoke first, like every other function here: the membership predicate uses
-- auth.uid() which is NULL for anon today, but an explicit grant surface must
-- not depend on that staying true.
REVOKE ALL ON FUNCTION public.revoke_partner_key(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.revoke_partner_key(UUID, TEXT) TO authenticated;

CREATE TRIGGER update_partner_api_keys_updated_at
BEFORE UPDATE ON public.partner_api_keys
FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

=============== ARCHITECTURE.md RULES THE SPEC MUST COMPLY WITH ===============
# 12. Edge Function Prime Rule

An Edge Function entrypoint is an **adapter**, not the business layer.

Target shape:

```text
HTTP request
  ↓
CORS
  ↓
authentication
  ↓
schema validation
  ↓
construct dependencies
  ↓
invoke application use case
  ↓
map response
  ↓
sanitized error
```

`index.ts` should become boring.

---

# 13. Never Do These in a New Edge Function

Never add a new Edge Function that:

- trusts `user_id` from the request body for a normal user call,
- exposes `SUPABASE_SERVICE_ROLE_KEY`,
- returns raw database errors to clients,
- returns raw third-party credentials or tokens,
- logs access tokens, refresh tokens, API keys, cookies, authorization headers, secrets, OTPs, or webhook secrets,
- performs unrelated business workflows in one handler,
- duplicates platform contracts already defined elsewhere,
- embeds thousands of lines of provider-specific logic in `index.ts`,
- creates its own ad-hoc auth convention when `_shared/auth-helper.ts` applies,
- creates its own ad-hoc error exposure convention when `_shared/errorSanitizer.ts` applies,
- uses unlimited polling or retry loops,
- performs network calls without explicit timeout/retry policy,
- writes to another user's rows using service role without verified ownership,
- assumes CORS `*` is appropriate for a new authenticated endpoint,
- swallows provider errors without logging a sanitized operational event,
- depends on frontend files.

---

# 14. Edge Function Authentication

For authenticated user endpoints:

1. derive identity from the Authorization header,
2. use the shared authentication helper or the current approved equivalent,
3. treat body `user_id` as untrusted,
4. compare resource ownership against the authenticated identity,
5. use service role only when server privilege is genuinely required.

Service-role internal calls may pass a user identifier only after the caller itself is authenticated as service-role.

Never downgrade this rule for convenience.

---

# 15. Edge Function Validation

# 25. CORS Rules

Do not copy `Access-Control-Allow-Origin: *` into new authenticated functions by default.

Use the shared CORS policy.

Wildcard CORS is acceptable only for endpoints intentionally designed to be public and whose security model has been reviewed.

CORS is not authorization.

---

# 26. External HTTP Rules

All provider/API calls must have:

- explicit timeout,
- bounded retry policy where safe,
- response validation,
- sanitized logging,
- stable error mapping.

Retries must consider idempotency.

Never blindly retry a publish/payment/send action that can duplicate side effects.

Use idempotency keys or provider operation IDs where supported.

---

# 27. Background Work Rules

Use `EdgeRuntime.waitUntil` only for bounded background work that can safely complete after the response.

Do not treat Edge Functions as durable queues.

Long-running or retry-critical workflows must persist state so they can resume/reconcile after process termination.

Every background process must be idempotent or safely deduplicated.

---

# 28. Scheduling Rules

Scheduled publishing must treat the database as source of truth.

Do not rely on browser timers.


=============== END OF INLINED MATERIAL. Produce findings now. No tool calls. ===============

[2m2026-08-25T01:31:36.713469Z[0m [31mERROR[0m [2mrmcp::transport::worker[0m[2m:[0m worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { www_authenticate_header: "Bearer resource_metadata=\"https://mcp.facebook.com/.well-known/oauth-protected-resource/devtools\", scope=\"developer_tools_mcp_app_read developer_tools_mcp_app_management\"" })
[2m2026-08-25T01:31:36.972095Z[0m [31mERROR[0m [2mrmcp::transport::worker[0m[2m:[0m worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { www_authenticate_header: "Bearer error=\"invalid_token\", error_description=\"No authorization provided\", resource_metadata=\"https://mcp.vercel.com/.well-known/oauth-protected-resource\"" })
[2m2026-08-25T01:31:36.972282Z[0m [31mERROR[0m [2mrmcp::transport::worker[0m[2m:[0m worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { www_authenticate_header: "Bearer error=\"invalid_token\", error_description=\"No authorization provided\", resource_metadata=\"https://mcp.vercel.com/.well-known/oauth-protected-resource\"" })
[2m2026-08-25T01:31:37.003353Z[0m [31mERROR[0m [2mrmcp::transport::worker[0m[2m:[0m worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { www_authenticate_header: "Bearer resource_metadata=\"https://mcp.facebook.com/.well-known/oauth-protected-resource/devtools\", scope=\"developer_tools_mcp_app_read developer_tools_mcp_app_management\"" })
[2m2026-08-25T01:31:37.184806Z[0m [31mERROR[0m [2mrmcp::transport::worker[0m[2m:[0m worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { www_authenticate_header: "Bearer error=\"invalid_token\", error_description=\"Authentication required\", resource_metadata=\"https://mcp.mem0.ai/.well-known/oauth-protected-resource\"" })
[2m2026-08-25T01:31:37.185044Z[0m [31mERROR[0m [2mrmcp::transport::worker[0m[2m:[0m worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { www_authenticate_header: "Bearer error=\"invalid_token\", error_description=\"Authentication required\", resource_metadata=\"https://mcp.mem0.ai/.well-known/oauth-protected-resource\"" })
[2m2026-08-25T01:31:37.200906Z[0m [31mERROR[0m [2mrmcp::transport::worker[0m[2m:[0m worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { www_authenticate_header: "Bearer error=\"invalid_request\", error_description=\"No access token was provided in this request\", resource_metadata=\"https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/\"" })
[2m2026-08-25T01:31:37.247998Z[0m [31mERROR[0m [2mrmcp::transport::worker[0m[2m:[0m worker quit with fatal: Transport channel closed, when AuthRequired(AuthRequiredError { www_authenticate_header: "Bearer error=\"invalid_request\", error_description=\"No access token was provided in this request\", resource_metadata=\"https://api.githubcopilot.com/.well-known/oauth-protected-resource/mcp/\"" })
[1m[33mwarning:[0m[0m Exceeded skills context budget. All skill descriptions were removed and 115 additional skills were not included in the model-visible skills list.
[1mhook:[0m [2mSessionStart[0m
[1mhook:[0m [2mSessionStart[0m
[1mhook:[0m [2mSessionStart[0m
[1mhook:[0m [2mSessionStart[0m
[1mhook:[0m [2mSessionStart[0m
[1mhook:[0m [2mSessionStart[0m Completed
[1mhook:[0m [2mSessionStart[0m Failed
[1mhook:[0m [2mSessionStart[0m Completed
[1mhook:[0m [2mSessionStart[0m Completed
[1mhook:[0m [2mSessionStart[0m Completed
[1mhook:[0m [2mUserPromptSubmit[0m
[1mhook:[0m [2mUserPromptSubmit[0m Completed
[2m2026-08-25T01:32:17.030564Z[0m [31mERROR[0m [2mcodex_models_manager::manager[0m[2m:[0m failed to renew cache TTL: missing field `supports_parallel_tool_calls` at line 97 column 5
[35m[3mcodex[0m[0m
**Finding 1 - blocker - §3 falsely claims the send path prevents retries after indeterminate outcomes**
- Evidence: §3.1 calls idempotency “unusually rigorous” and says an indeterminate send is never retried. In `partner-api/index.ts`, Meta is called before `completeIdempotency()` or `markIndeterminate()`. If the process terminates after Meta accepts the message but before either settlement, `claim_partner_idempotency()` permits takeover after the 300-second lease.
- Why it matters: A partner retry can send the same message to a real customer twice. The fencing token prevents an old worker from settling a new worker’s row; it does not prevent the second provider call.
- Recommendation: Withdraw the no-duplicate guarantee until the provider call has a durable operation identifier, provider-supported idempotency, or a persisted dispatch/reconciliation state that cannot be reclaimed as an unsent request.

**Finding 2 - blocker - D3 DISAGREE: legacy scope aliases silently widen existing credentials**
- Evidence: D3 maps `whatsapp:template.send` to `messages:send` and says old scopes remain valid. The source scope authorizes only WhatsApp template sending; D3’s generic scope covers a broader resource family and potentially every account later attached under D4.
- Why it matters: An already-issued key can gain non-template messaging or access to newly bound platforms without an explicit grant or rotation. That is privilege escalation disguised as vocabulary migration.
- Recommendation: Preserve the exact capability of legacy scopes. New generic scopes need explicit grants, and authorization should intersect resource capability, operation subtype, and allowed accounts.

**Finding 3 - blocker - D4 AGREE in principle, but the REST account-selection contract is missing**
- Evidence: D4 changes each key from one account to many, while §7 does not define how `POST /v1/messages`, conversation lists, media operations, or publishing requests select one or several accounts. The “primary account” is defined only for the frozen alias.
- Why it matters: Every implementer must invent whether account selection belongs in the body, query, path, resource relationship, or implicit default. Different endpoints will diverge, and accidental fan-out or wrong-account sends become public-contract behavior.
- Recommendation: Add a decision defining account resolution for collection, resource, single-account mutation, and multi-account publishing requests, including the exact ambiguity error.

**Finding 4 - blocker - D4/§9 fails to prove that a join-table row binds a key and account from the same workspace**
- Evidence: D4 and §8 require `FOREIGN KEY (social_account_id, workspace_id) REFERENCES social_accounts(id, workspace_id)`, but do not also require `FOREIGN KEY (key_id, workspace_id) REFERENCES partner_api_keys(id, workspace_id)`.
- Why it matters: A malformed or compromised administrative write could associate a key from workspace A with an account from workspace B while satisfying the specified account/workspace FK. Section 9’s request-time allowance check is application enforcement through a service-role client, not the claimed database proof.
- Recommendation: Require both composite FKs on `partner_api_key_accounts`, plus uniqueness and backend authorization for binding mutations. Resource tables must also prove account allowance where feasible, not merely workspace membership.

**Finding 5 - blocker - D5 AGREE, D9 DISAGREE: they are not a shippable phase order as written**
- Evidence: D5 requires transactional outbox insertion before public webhook exposure; D6 promises `post.published` and `post.failed`; D9 delegates publishing to the existing 7,202-line `process-post` path and excludes its refactor. No decision says how that legacy path atomically records its state transition and outbox event.
- Why it matters: Shipping D9 first gives publishing without the promised events. Shipping D5’s table and worker first still loses events unless every producer atomically enqueues them. A post-result callback after the fact recreates the exact crash gap D5 is intended to eliminate.
- Recommendation: They are compatible only if a phase first adds a transactional event-emission seam—such as a status-transition RPC or database-backed producer—to the existing publishing path. “No wholesale refactor” is viable; “no required modification” is not.

**Finding 6 - major - D9 DISAGREE: a port that delegates to an Edge Function monolith is not yet an architectural boundary**
- Evidence: D9 does not define whether `PublishPort` imports a use case, calls `process-post` over HTTP, or writes records for its scheduler. `ARCHITECTURE.md` requires entrypoints to be adapters and business behavior to live behind them; `process-post/index.ts` is described as the monolith itself.
- Why it matters: An HTTP adapter-to-adapter bridge introduces double authentication, timeout, retry, and idempotency semantics. Importing the entrypoint violates the adapter rule. Either choice can duplicate publishes or freeze legacy failure behavior into `/v1`.
- Recommendation: Define the actual callable application seam and its result/idempotency contract. Extracting the narrow publish invocation is necessary even if the provider branches remain untouched.

**Finding 7 - major - D8 DISAGREE: indefinite coexistence preserves a plaintext, unscoped authority path**
- Evidence: D8 records that `profiles.api_key` is plaintext, unscoped, and grants full user authority, but makes convergence merely “later.” §11.5 acknowledges PRD §38 requires n8n operations to use the Partner API and leaves it as an open question rather than a non-goal.
- Why it matters: The weaker credential remains an actively issued parallel authentication system after the stronger system becomes strategic. Database disclosure yields usable credentials, and future integrations may continue adopting the easier legacy door.
- Recommendation: Temporary coexistence is reasonable only with a dated migration decision: stop expansion, define rotation/overlap, migrate the node, and deprecate issuance. PRD §38 must be either committed or explicitly listed as a v1 non-goal.

**Finding 8 - major - The specification drops partner-key lifecycle management without declaring it a non-goal**
- Evidence: §3.3 identifies no minting UI and no rotation; D8 again records Partner API rotation as unimplemented. §7 contains no key-management endpoints, while §8 adds only audit storage and §5 does not defer key creation, rotation, or revocation.
- Why it matters: An implementer must invent who may create keys, how plaintext is delivered once, how scopes/accounts are approved, whether rotation overlaps, and how compromised keys are replaced. A public API cannot be operated safely with hand-written production SQL.
- Recommendation: Add an explicit credential-lifecycle decision and acceptance criteria, or list the entire operator-only lifecycle as a v1 non-goal with a controlled runbook.

**Finding 9 - major - D7 DISAGREE: “billable versus reads” is the wrong failure-policy boundary**
- Evidence: D7 fails closed only for billable side effects and fails open for all reads. §7 also includes provider-backed reads, media downloads, webhook tests, uploads, scheduling, secret rotation, and other non-read or potentially expensive operations that are not necessarily billable.
- Why it matters: During limiter failure, expensive provider reads, large downloads, SSRF-capable webhook tests, storage uploads, or customer-visible scheduling actions can run without limits. Conversely, a bounded database read may safely remain available.
- Recommendation: Classify each operation by side effects, external cost, amplification, and abuse risk. Fail closed for mutations and expensive/provider-backed operations; permit fail-open only for explicitly bounded low-risk reads.

**Finding 10 - major - D6 DISAGREE: the listed events are not backed by defined producer semantics**
- Evidence: D6 labels `message.sent` as produced by the Partner API, but the source response states only `state: "accepted_by_meta"`. It also asserts connected/disconnected and publishing producers without defining their durable transition or atomic enqueue mechanism.
- Why it matters: “Accepted by provider” is not necessarily “sent,” and events emitted from loosely identified callbacks can be missing, duplicated, or semantically inconsistent. Partners will build irreversible workflows around those names.
- Recommendation: Define each event’s exact state transition, stable source identifier, producer transaction, and unsupported modes before marking it “Yes.” Rename the current message event to reflect provider acceptance unless actual sending is observable.

**Finding 11 - major - D10 DISAGREE: “reuse the existing pipeline” is not an upload security contract**
- Evidence: D10 names a “Cloudinary/Openinary pipeline,” but no excerpt establishes its limits, MIME sniffing, malware handling, retention, tenant checks, signed-download behavior, or compatibility with partner uploads. It leaves even temporary-URL expiry unresolved.
- Why it matters: Implementers must invent security-sensitive upload behavior, and reusing an unverified path can expose raw provider URLs, accept malicious files, or return a usable media ID before scanning completes.
- Recommendation: Make reuse conditional on a documented control matrix covering size, content validation, scan state, quotas, retention, deletion, tenant ownership, URL TTL, and asynchronous processing.

**Finding 12 - major - D2 DISAGREE: it unnecessarily freezes the alias envelope into the new REST API**
- Evidence: D1 already preserves the existing endpoint as a compatibility alias, so `/v1` can adopt the PRD envelope without breaking Danat. D2’s claim that HTTP status is ambiguous is unsupported by the adapter, which consistently uses meaningful 4xx/5xx statuses.
- Why it matters: The project permanently diverges from its PRD and likely SDK conventions solely to preserve a shape that the alias can retain independently. Correcting it later becomes a real breaking change after `/v1` consumers exist.
- Recommendation: Keep the implemented envelope only on the alias. Choose the `/v1` envelope on its merits now; request IDs can remain available as response headers and on successful response bodies without forcing the legacy error shape.

**Finding 13 - major - D1 AGREE, but its sunset condition can knowingly break the only partner**
- Evidence: D1 removes the alias when Danat confirms migration “or 6 months after `/v1` GA, whichever is sooner.” §11.1 says Danat’s owner and timeline are unresolved.
- Why it matters: “Whichever is sooner” permits removal at six months even if Danat has not migrated, or immediately after confirmation without a minimum observation period. One idle key proves little about deployed client code or release coordination.
- Recommendation: Require verified traffic migration and an agreed notice/observation window, with alias telemetry. Do not equate an email with a completed production migration.

**Finding 14 - major - §3.4 overclaims that one credential proves one consumer and near-free compatibility**
- Evidence: Production proves one key and four recorded calls. It does not prove that the key is held by one process, one deployed version, or one operational owner, nor that no dormant integration depends on the current contract.
- Why it matters: D1 and D3 may be treated as operationally free and deployed without inventorying Danat’s code, environments, retry jobs, or release process.
- Recommendation: Retain the production facts but downgrade the conclusions to hypotheses until the credential’s distribution and consumer deployment are verified.

**Finding 15 - major - §3.1’s quota claim contradicts the implementation and the spec’s own indeterminate policy**
- Evidence: §3.1 says quota “is consumed only by a Meta-accepted send.” `partner-api/index.ts` deliberately retains the reservation for network failures, provider 5xx responses, and missing message IDs where acceptance is unknown.
- Why it matters: Billing and usage reporting cannot truthfully describe every retained unit as an accepted message. Disputes will arise when `current_usage_count` exceeds confirmed sends.
- Recommendation: Define separate reserved/confirmed/indeterminate counters or explicitly state that quota includes accepted-or-indeterminate attempts. Do not call the present counter accepted-send usage.

**Finding 16 - major - §3’s “well-tested” characterization is not a release assurance**
- Evidence: The verified Vitest include is `src/**/*.{test,spec}.*`; tests under `supabase/functions/**` never run in CI. §10 nevertheless calls the Edge Function concurrency, idempotency, and webhook suites release-blocking without defining a runnable CI gate.
- Why it matters: The most correctness-critical code can regress while CI remains green, making “release-blocking” tests aspirational rather than enforceable.
- Recommendation: Require a CI job that discovers and executes Edge Function and SQL concurrency tests before relying on the foundation’s test status.

**Finding 17 - minor - §3.1’s “request ID on every exit path” claim is false**
- Evidence: `partner-api/index.ts` returns the CORS `OPTIONS` response before generating `requestId`; that response has neither the header nor body field.
- Why it matters: The literal guarantee and acceptance expectation are inaccurate, even if preflight correlation is low value.
- Recommendation: Narrow the claim to application responses, or require correlation on preflight too.

**Finding 18 - minor - Contacts and n8n convergence are deferred outside the declared non-goal ledger**
- Evidence: §7 makes PRD §19 contacts conditional on an unidentified future consumer. §11.5 punts PRD §38’s n8n migration to an open question. Neither appears in §5.
- Why it matters: The claimed v1 scope is not actually frozen: product requirements can disappear through conditional prose or open questions without an explicit approval record.
- Recommendation: Add both to the non-goals with rationale and re-entry criteria, or restore them to a committed phase.

(a) The three decisions most likely wrong: **D3** because it widens legacy authorization, **D9** because it does not define a viable application seam or transactional event producer, and **D7** because its billable/read split leaves major abuse classes uncovered.

(b) Well-reasoned and must not change: the move to REST while freezing the legacy alias; database-enforced composite tenancy as the governing invariant; attempt-token fencing; cautious treatment of truly indeterminate provider outcomes; atomic rate buckets; and D5’s refusal to advertise at-least-once webhooks without a durable transactional outbox.
[1mhook:[0m [2mStop[0m
[1mhook:[0m [2mStop[0m
[1mhook:[0m [2mStop[0m Completed
[1mhook:[0m [2mStop[0m Failed
[2mtokens used[0m
52,063
**Finding 1 - blocker - §3 falsely claims the send path prevents retries after indeterminate outcomes**
- Evidence: §3.1 calls idempotency “unusually rigorous” and says an indeterminate send is never retried. In `partner-api/index.ts`, Meta is called before `completeIdempotency()` or `markIndeterminate()`. If the process terminates after Meta accepts the message but before either settlement, `claim_partner_idempotency()` permits takeover after the 300-second lease.
- Why it matters: A partner retry can send the same message to a real customer twice. The fencing token prevents an old worker from settling a new worker’s row; it does not prevent the second provider call.
- Recommendation: Withdraw the no-duplicate guarantee until the provider call has a durable operation identifier, provider-supported idempotency, or a persisted dispatch/reconciliation state that cannot be reclaimed as an unsent request.

**Finding 2 - blocker - D3 DISAGREE: legacy scope aliases silently widen existing credentials**
- Evidence: D3 maps `whatsapp:template.send` to `messages:send` and says old scopes remain valid. The source scope authorizes only WhatsApp template sending; D3’s generic scope covers a broader resource family and potentially every account later attached under D4.
- Why it matters: An already-issued key can gain non-template messaging or access to newly bound platforms without an explicit grant or rotation. That is privilege escalation disguised as vocabulary migration.
- Recommendation: Preserve the exact capability of legacy scopes. New generic scopes need explicit grants, and authorization should intersect resource capability, operation subtype, and allowed accounts.

**Finding 3 - blocker - D4 AGREE in principle, but the REST account-selection contract is missing**
- Evidence: D4 changes each key from one account to many, while §7 does not define how `POST /v1/messages`, conversation lists, media operations, or publishing requests select one or several accounts. The “primary account” is defined only for the frozen alias.
- Why it matters: Every implementer must invent whether account selection belongs in the body, query, path, resource relationship, or implicit default. Different endpoints will diverge, and accidental fan-out or wrong-account sends become public-contract behavior.
- Recommendation: Add a decision defining account resolution for collection, resource, single-account mutation, and multi-account publishing requests, including the exact ambiguity error.

**Finding 4 - blocker - D4/§9 fails to prove that a join-table row binds a key and account from the same workspace**
- Evidence: D4 and §8 require `FOREIGN KEY (social_account_id, workspace_id) REFERENCES social_accounts(id, workspace_id)`, but do not also require `FOREIGN KEY (key_id, workspace_id) REFERENCES partner_api_keys(id, workspace_id)`.
- Why it matters: A malformed or compromised administrative write could associate a key from workspace A with an account from workspace B while satisfying the specified account/workspace FK. Section 9’s request-time allowance check is application enforcement through a service-role client, not the claimed database proof.
- Recommendation: Require both composite FKs on `partner_api_key_accounts`, plus uniqueness and backend authorization for binding mutations. Resource tables must also prove account allowance where feasible, not merely workspace membership.

**Finding 5 - blocker - D5 AGREE, D9 DISAGREE: they are not a shippable phase order as written**
- Evidence: D5 requires transactional outbox insertion before public webhook exposure; D6 promises `post.published` and `post.failed`; D9 delegates publishing to the existing 7,202-line `process-post` path and excludes its refactor. No decision says how that legacy path atomically records its state transition and outbox event.
- Why it matters: Shipping D9 first gives publishing without the promised events. Shipping D5’s table and worker first still loses events unless every producer atomically enqueues them. A post-result callback after the fact recreates the exact crash gap D5 is intended to eliminate.
- Recommendation: They are compatible only if a phase first adds a transactional event-emission seam—such as a status-transition RPC or database-backed producer—to the existing publishing path. “No wholesale refactor” is viable; “no required modification” is not.

**Finding 6 - major - D9 DISAGREE: a port that delegates to an Edge Function monolith is not yet an architectural boundary**
- Evidence: D9 does not define whether `PublishPort` imports a use case, calls `process-post` over HTTP, or writes records for its scheduler. `ARCHITECTURE.md` requires entrypoints to be adapters and business behavior to live behind them; `process-post/index.ts` is described as the monolith itself.
- Why it matters: An HTTP adapter-to-adapter bridge introduces double authentication, timeout, retry, and idempotency semantics. Importing the entrypoint violates the adapter rule. Either choice can duplicate publishes or freeze legacy failure behavior into `/v1`.
- Recommendation: Define the actual callable application seam and its result/idempotency contract. Extracting the narrow publish invocation is necessary even if the provider branches remain untouched.

**Finding 7 - major - D8 DISAGREE: indefinite coexistence preserves a plaintext, unscoped authority path**
- Evidence: D8 records that `profiles.api_key` is plaintext, unscoped, and grants full user authority, but makes convergence merely “later.” §11.5 acknowledges PRD §38 requires n8n operations to use the Partner API and leaves it as an open question rather than a non-goal.
- Why it matters: The weaker credential remains an actively issued parallel authentication system after the stronger system becomes strategic. Database disclosure yields usable credentials, and future integrations may continue adopting the easier legacy door.
- Recommendation: Temporary coexistence is reasonable only with a dated migration decision: stop expansion, define rotation/overlap, migrate the node, and deprecate issuance. PRD §38 must be either committed or explicitly listed as a v1 non-goal.

**Finding 8 - major - The specification drops partner-key lifecycle management without declaring it a non-goal**
- Evidence: §3.3 identifies no minting UI and no rotation; D8 again records Partner API rotation as unimplemented. §7 contains no key-management endpoints, while §8 adds only audit storage and §5 does not defer key creation, rotation, or revocation.
- Why it matters: An implementer must invent who may create keys, how plaintext is delivered once, how scopes/accounts are approved, whether rotation overlaps, and how compromised keys are replaced. A public API cannot be operated safely with hand-written production SQL.
- Recommendation: Add an explicit credential-lifecycle decision and acceptance criteria, or list the entire operator-only lifecycle as a v1 non-goal with a controlled runbook.

**Finding 9 - major - D7 DISAGREE: “billable versus reads” is the wrong failure-policy boundary**
- Evidence: D7 fails closed only for billable side effects and fails open for all reads. §7 also includes provider-backed reads, media downloads, webhook tests, uploads, scheduling, secret rotation, and other non-read or potentially expensive operations that are not necessarily billable.
- Why it matters: During limiter failure, expensive provider reads, large downloads, SSRF-capable webhook tests, storage uploads, or customer-visible scheduling actions can run without limits. Conversely, a bounded database read may safely remain available.
- Recommendation: Classify each operation by side effects, external cost, amplification, and abuse risk. Fail closed for mutations and expensive/provider-backed operations; permit fail-open only for explicitly bounded low-risk reads.

**Finding 10 - major - D6 DISAGREE: the listed events are not backed by defined producer semantics**
- Evidence: D6 labels `message.sent` as produced by the Partner API, but the source response states only `state: "accepted_by_meta"`. It also asserts connected/disconnected and publishing producers without defining their durable transition or atomic enqueue mechanism.
- Why it matters: “Accepted by provider” is not necessarily “sent,” and events emitted from loosely identified callbacks can be missing, duplicated, or semantically inconsistent. Partners will build irreversible workflows around those names.
- Recommendation: Define each event’s exact state transition, stable source identifier, producer transaction, and unsupported modes before marking it “Yes.” Rename the current message event to reflect provider acceptance unless actual sending is observable.

**Finding 11 - major - D10 DISAGREE: “reuse the existing pipeline” is not an upload security contract**
- Evidence: D10 names a “Cloudinary/Openinary pipeline,” but no excerpt establishes its limits, MIME sniffing, malware handling, retention, tenant checks, signed-download behavior, or compatibility with partner uploads. It leaves even temporary-URL expiry unresolved.
- Why it matters: Implementers must invent security-sensitive upload behavior, and reusing an unverified path can expose raw provider URLs, accept malicious files, or return a usable media ID before scanning completes.
- Recommendation: Make reuse conditional on a documented control matrix covering size, content validation, scan state, quotas, retention, deletion, tenant ownership, URL TTL, and asynchronous processing.

**Finding 12 - major - D2 DISAGREE: it unnecessarily freezes the alias envelope into the new REST API**
- Evidence: D1 already preserves the existing endpoint as a compatibility alias, so `/v1` can adopt the PRD envelope without breaking Danat. D2’s claim that HTTP status is ambiguous is unsupported by the adapter, which consistently uses meaningful 4xx/5xx statuses.
- Why it matters: The project permanently diverges from its PRD and likely SDK conventions solely to preserve a shape that the alias can retain independently. Correcting it later becomes a real breaking change after `/v1` consumers exist.
- Recommendation: Keep the implemented envelope only on the alias. Choose the `/v1` envelope on its merits now; request IDs can remain available as response headers and on successful response bodies without forcing the legacy error shape.

**Finding 13 - major - D1 AGREE, but its sunset condition can knowingly break the only partner**
- Evidence: D1 removes the alias when Danat confirms migration “or 6 months after `/v1` GA, whichever is sooner.” §11.1 says Danat’s owner and timeline are unresolved.
- Why it matters: “Whichever is sooner” permits removal at six months even if Danat has not migrated, or immediately after confirmation without a minimum observation period. One idle key proves little about deployed client code or release coordination.
- Recommendation: Require verified traffic migration and an agreed notice/observation window, with alias telemetry. Do not equate an email with a completed production migration.

**Finding 14 - major - §3.4 overclaims that one credential proves one consumer and near-free compatibility**
- Evidence: Production proves one key and four recorded calls. It does not prove that the key is held by one process, one deployed version, or one operational owner, nor that no dormant integration depends on the current contract.
- Why it matters: D1 and D3 may be treated as operationally free and deployed without inventorying Danat’s code, environments, retry jobs, or release process.
- Recommendation: Retain the production facts but downgrade the conclusions to hypotheses until the credential’s distribution and consumer deployment are verified.

**Finding 15 - major - §3.1’s quota claim contradicts the implementation and the spec’s own indeterminate policy**
- Evidence: §3.1 says quota “is consumed only by a Meta-accepted send.” `partner-api/index.ts` deliberately retains the reservation for network failures, provider 5xx responses, and missing message IDs where acceptance is unknown.
- Why it matters: Billing and usage reporting cannot truthfully describe every retained unit as an accepted message. Disputes will arise when `current_usage_count` exceeds confirmed sends.
- Recommendation: Define separate reserved/confirmed/indeterminate counters or explicitly state that quota includes accepted-or-indeterminate attempts. Do not call the present counter accepted-send usage.

**Finding 16 - major - §3’s “well-tested” characterization is not a release assurance**
- Evidence: The verified Vitest include is `src/**/*.{test,spec}.*`; tests under `supabase/functions/**` never run in CI. §10 nevertheless calls the Edge Function concurrency, idempotency, and webhook suites release-blocking without defining a runnable CI gate.
- Why it matters: The most correctness-critical code can regress while CI remains green, making “release-blocking” tests aspirational rather than enforceable.
- Recommendation: Require a CI job that discovers and executes Edge Function and SQL concurrency tests before relying on the foundation’s test status.

**Finding 17 - minor - §3.1’s “request ID on every exit path” claim is false**
- Evidence: `partner-api/index.ts` returns the CORS `OPTIONS` response before generating `requestId`; that response has neither the header nor body field.
- Why it matters: The literal guarantee and acceptance expectation are inaccurate, even if preflight correlation is low value.
- Recommendation: Narrow the claim to application responses, or require correlation on preflight too.

**Finding 18 - minor - Contacts and n8n convergence are deferred outside the declared non-goal ledger**
- Evidence: §7 makes PRD §19 contacts conditional on an unidentified future consumer. §11.5 punts PRD §38’s n8n migration to an open question. Neither appears in §5.
- Why it matters: The claimed v1 scope is not actually frozen: product requirements can disappear through conditional prose or open questions without an explicit approval record.
- Recommendation: Add both to the non-goals with rationale and re-entry criteria, or restore them to a committed phase.

(a) The three decisions most likely wrong: **D3** because it widens legacy authorization, **D9** because it does not define a viable application seam or transactional event producer, and **D7** because its billable/read split leaves major abuse classes uncovered.

(b) Well-reasoned and must not change: the move to REST while freezing the legacy alias; database-enforced composite tenancy as the governing invariant; attempt-token fencing; cautious treatment of truly indeterminate provider outcomes; atomic rate buckets; and D5’s refusal to advertise at-least-once webhooks without a durable transactional outbox.
