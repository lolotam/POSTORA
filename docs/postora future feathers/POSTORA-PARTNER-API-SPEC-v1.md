# Postora Partner API — Specification v1

**Status:** Draft, revised after review rounds 1-2 · **Version:** 1.3 · **Date:** 2026-08-25
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

1. Legacy scope strings remain accepted **at exactly their current capability** — and are never
   widened.
2. The Danat key is **reissued** with explicit generic scopes as part of its migration, which is a
   deliberate grant with a human decision behind it.
3. Legacy scope strings are then rejected for new keys.

**(R3) The explicit legacy allowlist.** "Current capability" must be enumerated, not inferred,
because one of the three legacy scopes currently grants **nothing at all**:

| Legacy scope | Actions it authorises **today** | Capability after migration |
|---|---|---|
| `whatsapp:template.send` | `send_template` only | Exactly that. **Not** free-form messaging, not another platform, not a newly bound account |
| `whatsapp:templates.read` | `list_templates` only | Exactly that |
| `whatsapp:webhooks.manage` | **Nothing — no action exists behind it** (§3.2) | **Nothing.** It must never map to `webhooks:manage` |

The third row is the trap. `whatsapp:webhooks.manage` is held by the live Danat key and is inert
today. Mapping it to `webhooks:manage` when the webhook API arrives would convert **zero
capability into full webhook CRUD plus outbound test** — an SSRF-capable, class-C surface. That is
precisely the escalation this decision was rewritten to prevent, arriving through a different
door. Every legacy scope is tested for what it grants, and the dormant one is tested to prove it
grants nothing.

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
   `index.ts`. The narrow publish-invocation path lives in `_shared/` behind `PublishPort`; both
   `process-post`'s entrypoint and the Partner API route call it.
2. **The status transition and the outbox enqueue happen in one database transaction.** Whatever
   writes the terminal `platform_posts` status also writes the delivery row. Required, not
   optional — and "whatever writes" means *every* writer, not only the new port (see the plan's
   writer inventory).
3. **(R3) The provider branches must move, and pretending otherwise was incoherent.** v1.2 said
   the port is in `_shared/`, must not import `index.ts`, must not bridge over HTTP — *and* that
   the ten provider branches stay inside `process-post/index.ts`. Those four constraints cannot
   all hold: if the branch bodies live in the entrypoint, a shared use case cannot reach them by
   any permitted route.

   The minimum constructible design, which must be written out **before** implementation starts:

   - `PublishPort` (the interface) lives in `_shared/platforms/`, alongside the existing
     `types.ts` / `media-helpers.ts` / `polling-helpers.ts` that already establish this location.
   - Each `postToX` **function body moves** from `process-post/index.ts` into
     `_shared/platforms/<platform>.ts` as a `PublishPort` implementation. This is a *move*, not a
     rewrite: the provider logic itself is not redesigned.
   - Both callers obtain implementations from one registry.

   So the honest scope is: **the branches move, their contents do not change.** What remains out
   of scope is redesigning provider logic, changing per-platform behaviour, or restructuring the
   dispatcher beyond what the move requires — that is the separate Core 1 refactor.

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

**(R3) Ownership rules for the non-messaging resources**, which v1.2 left for implementers to
invent — and which determine whether a rotated key, a differently scoped key, or another bound
account can read a resource:

| Resource | Owner | Consequence |
|---|---|---|
| **Media** | **Workspace-owned**, with the creating key recorded for audit | A rotated or replaced key can still reach media it uploaded; any key bound to the same workspace may reference it. Key-owned media would be orphaned by rotation, which D12 makes routine |
| **Webhook subscriptions** | **Key-owned**, with an optional account filter | A subscription must die with its credential. Workspace-owned subscriptions would outlive a revoked key and keep delivering to a partner whose access was withdrawn |
| **Usage** | **Key-scoped by default**, workspace-scoped with `usage:read` on a workspace-level key | Billing attribution follows the credential |

`POST /v1/media` takes no `account_id` — media is not account-scoped. Account association happens
when the media is *used*, by the send or publish that references it.

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

**Decision: record before the call, and accept at-most-once as the default.** Once the pre-call
boundary is durable, a takeover **must never re-dispatch** — it resolves to `indeterminate`.

**(R3) `indeterminate` is terminal, and the earlier rationale was wrong.** v1.2 justified this
choice by claiming an abandoned message is "fully recoverable — the partner observes
`indeterminate`, checks, and re-sends under a new `Idempotency-Key`." **That is false, and the
error matters.** The durable intent exists in *both* crash cases — the one where the message was
never sent, and the one where the provider accepted it — and with no provider-side lookup the two
are **indistinguishable**. Telling a partner to re-send on `indeterminate` therefore reintroduces
exactly the duplicate this decision exists to prevent.

The honest contract:

- `indeterminate` is a **terminal state**. It is not safely retryable, and the API must never
  advise retry on it.
- The record is resolvable **only** by reconciliation that proves non-delivery. Where the provider
  offers no such lookup — WhatsApp Cloud does not — it stays terminal.
- Each terminal `indeterminate` requires a **named escalation path**: it surfaces to the operator,
  and a human decides whether to contact the recipient or re-send deliberately under a new key,
  accepting the duplicate risk with full knowledge.

**Corrected rationale.** At-most-once is preferred not because the failure is recoverable — it is
not — but because it **shrinks the ambiguity window from the whole provider call to the gap
between a durable write and the next instruction**, and because a message Postora silently drops
is an internal failure it can detect, count and alarm on, whereas a duplicate is an external
failure the customer experiences and the partner cannot undo.

**(R3) This is a default, not a universal truth.** The ordering of harms is use-case-dependent:
for a critical alert, a reservation confirmation, or a payment notification, a dropped message may
be worse than a duplicate. v1 ships **at-most-once for everyone**. A narrowly defined, per-key
opt-in at-least-once policy is a recognised future option, explicitly **not** in v1 scope, and
must not be added without its own decision record.

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

   **(R3) This applies to every new table, not only the join table.** v1.2 specified the double
   composite FK for `partner_api_key_accounts` and left the others to inherit the principle by
   implication, which is exactly how such a guarantee gets lost. Each new table below must state
   its constraint, and each needs a negative database test proving the cross-workspace row cannot
   be written:

   | Table | Must make unrepresentable |
   |---|---|
   | `partner_api_key_accounts` | A key and an account from different workspaces (both composite FKs, D4) |
   | `partner_dispatch_intents` | An intent whose key and target account disagree on workspace |
   | `partner_webhooks` | A subscription whose key and account filter disagree on workspace |
   | `partner_webhook_deliveries` | A delivery row whose subscription belongs to another workspace |
   | `partner_audit_logs` | An audit row attributed to a workspace other than its target's |
   | Media association | A `media_file_id` referenced by a post or message in another workspace |

   Where a composite FK is genuinely impossible for a table, that must be stated explicitly with
   the compensating control named — silence is not an acceptable answer.
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

### v1.3 — 2026-08-25 — plan review round 2, spec consequences

Round 2 attacked the round-1 fixes rather than repeating findings. Five blockers; the three that
land on the spec were all defects in my own reasoning, not merely in wording.

- **D13's rationale was false, and the contract is now corrected.** v1.2 claimed an abandoned
  message is "fully recoverable — the partner observes `indeterminate` and re-sends under a new
  key." The durable intent exists in *both* crash cases, and without a provider lookup they are
  indistinguishable — so advising a re-send reintroduces the very duplicate the decision prevents.
  `indeterminate` is now **terminal**, not retryable, with a named operator escalation path. The
  corrected justification for at-most-once is that it shrinks the ambiguity window and converts an
  external, unfixable failure into an internal, detectable one — **not** that it is recoverable.
  *(blocker)*
- **D13 is now stated as a default, not a universal truth.** For a critical alert or a payment
  notification, a dropped message may be worse than a duplicate. v1 ships one policy for everyone;
  opt-in at-least-once is recorded as a future option and explicitly out of v1 scope.
- **D9's constraints were mutually unsatisfiable.** It required a `_shared/` port, forbade
  importing `index.ts`, forbade an HTTP bridge, *and* required the ten provider branches to stay
  inside `process-post/index.ts`. Those cannot all hold. The honest scope is now stated: the
  branch bodies **move** to `_shared/platforms/<platform>.ts`; their contents do not change.
  *(blocker)*
- **The tenancy guarantee applied to only one table.** §9.1 asserted the principle for "every
  partner-scoped table" but v1.2 specified constraints only for the join table. A per-table
  constraint matrix is now mandatory, with a negative test each, and "impossible here" must name
  its compensating control. *(blocker)*
- **D3 gained an explicit legacy allowlist.** The dormant `whatsapp:webhooks.manage` scope — held
  by the live key, authorising nothing today — would become full webhook CRUD plus an SSRF-capable
  outbound test if mapped to `webhooks:manage`. The round-1 fix tested free-form sending and
  cross-account access but never the dormant scope, so the escalation could have arrived through a
  different door.
- **D11 gained ownership rules** for media (workspace-owned), webhook subscriptions (key-owned,
  so they die with the credential) and usage — all previously left for implementers to invent.
