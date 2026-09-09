# Partner API section expansion — design

**Date:** 2026-09-10
**Branch:** `feat/partner-api-sections`
**Status:** proposed, awaiting review
**Consumer:** `wasl-selfhosted` (F:/wasl-selfhosted), first external product to depend on this surface

---

## 1. Why this exists

`wasl-selfhosted` is dropping its own Evolution API integration and will depend
entirely on Postora for WhatsApp, social messaging, comments, automation and
human-agent handoff. It must reach all of that through the Partner API.

Today it cannot. Two facts block it:

1. **wasl does not use the Partner API at all.** `server/providers/postoraAdapter.ts`
   calls `/functions/v1/n8n-api` with an `x-api-key` header, against routes
   `api/v1/post` and `api/v1/upload-media`. That is a different door with
   different auth, no scopes, no metering and no idempotency.
2. **The capability wasl needs is not on the Partner API.** The four sections it
   is cloning run on private surfaces: the `messaging-api` edge function
   (40 actions), the `comment-manager` edge function (7 actions), the
   `whatsapp-evolution-bridge` (6 actions), and direct table reads.

This document specifies the Partner API expansion. The wasl-side integration is
a separate spec and is out of scope here.

---

## 2. Current state, verified against the working tree

Verified on 2026-09-10 at `5b3a98e9`.

### 2.1 What the Partner API already has

`supabase/functions/partner-api/` exposes 24 routes under `/v1`: usage,
accounts, conversations (read only), connectors, media, messages, tools,
templates, posts and webhooks. Phases 5, 7, 8 and 10 are merged; Phase 10
("GA & DX") landed on main on 2026-09-02 as `9a7cd43f`.

Every route is registered in `V1_ROUTES` naming an **alias action**. The
action's OAuth scope lives in `ACTION_SCOPES` and its rate-limit **risk class**
is passed to the limiter. One policy table, two doors.

### 2.2 The PRD banner is stale

`POSTORA_PARTNER_API_PRD_v1.0.md` opens with "STATUS: DEFERRED — DO NOT
IMPLEMENT YET" and lists five open contract questions. Four of the five are
already answered in shipped code. **This spec supersedes that banner**, and
updating it is a deliverable.

### 2.3 Contract decisions already implemented — document, do not redesign

| PRD open question | Where it is actually answered |
|---|---|
| §13 Account selection | `v1/binding.ts`. A key binds to many accounts through `partner_api_key_accounts`. Collection reads default to **all** bound accounts, each row labelled by `account_id`; `?account_id=` selects one. An unbound id answers `resource_not_found`, never `resource_forbidden`, so the partner learns nothing about accounts it cannot see. |
| §22 Webhook HMAC | `process-partner-webhooks/worker.ts` signs every delivery via `signWebhookPayload(secret, timestampSeconds, body)`. Secret rotation keeps the previous secret verifying for a bounded overlap. |
| §22-23 Event identifier naming | `_shared/partnerWebhookEvents.ts` holds `CERTIFIED_EVENT_TYPES`. A subscription may only name a certified type. |
| §24 Idempotency | `_shared/partnerApiIdempotency.ts` implements claim, settle, and an explicit `indeterminate` outcome that is never downgraded from a settled success. |

The fifth, **legacy to v1 scope mapping**, is answered by **capability
pinning**, not by exclusion. An earlier draft of this spec said no legacy scope
satisfies any `/v1` action. That is false and acting on it would break live
partners.

The real rule, readable in `ACTION_SCOPES`:

```typescript
send_template:  ["whatsapp:template.send", "messages:send"],
list_templates: ["whatsapp:templates.read", "templates:read"],
```

Both legacy scopes **do** satisfy a `/v1` action, and `/v1/templates` serves
`list_templates` today. What D3 froze is that a legacy scope grants exactly the
capability it had when it was frozen and **no new one**. So
`whatsapp:templates.read` reads templates through either door, while
`whatsapp:webhooks.manage` — which authorised nothing — satisfies nothing, and
the `/v1` read surface added in phases 2.3 to 2.6 takes generic scopes only
because no legacy scope predates those capabilities.

`partnerScopes.test.ts` asserts that pinning, not a blanket absence.

**Consequence for this spec:** every action added here is new, so no legacy
scope may satisfy it. But removing an existing legacy grant is a **breaking
change** requiring its own review, and is not in scope.

### 2.4 The contract is published and machine-checked

Contrary to the PRD, the canonical contract exists and CI enforces it. The
`contract-drift` job in `.github/workflows/test.yml` guards four artifacts:

| Artifact | Guarded by |
|---|---|
| `docs/api/openapi.yaml` (2789 lines) | `scripts/check-openapi-drift.ts` |
| `docs/api/openapi.baseline.yaml` (862 lines) | the last accepted contract; a diff against it is a **breaking-change** verdict |
| `docs/api/postman/` | `scripts/generate-postman.test.ts` — the committed JSON must be byte-identical to the generator's output |
| `docs/developer/AGENT-CONTEXT.md` (956 lines) | `scripts/generate-agent-context.test.ts` |

**Consequence for every task in this spec.** Adding a route is not done when
the handler and its tests pass. The route must also appear in `openapi.yaml`,
be checked against the **unchanged** baseline with
`scripts/check-openapi-drift.ts`, and have the Postman collection and agent
bundle regenerated. Otherwise CI fails and, worse, a partner imports a
collection that disagrees with the contract it claims to mirror.

**The baseline is never regenerated inside a task.**
`scripts/regenerate-openapi-baseline.sh` refuses a dirty tree and, as its own
header says, running it before review "would make the gate compare the document
to itself and find nothing". Advancing the baseline is a post-merge,
human-reviewed step.

`scripts/generate-agent-context.ts` also reads only `v1/router.ts` and the
workspace policy table, and recognises only `withPartnerAuth` with a literal
risk class. The platform tier satisfies neither condition, so the generator
must be taught about it or the published agent bundle will omit the entire
tier while its equality test still passes.

A deliberate breaking change is recorded in
`docs/api/accepted-breaking-changes.txt`. This spec introduces none: every
change is additive.

### 2.5 Primitives that already exist and are reused unchanged

- **Cursor pagination** — `v1/pagination.ts`. Opaque keyset cursors carrying a
  value boundary, `limit` clamped to 1..100 with a default of 20, a tampered
  cursor rejected rather than silently reset. Every new collection uses it.
- **Metering and risk classes** — `_shared/partnerApiMetering.ts`. Quota
  reserve, confirm and release, plus limiter classes A, B and C.
- **Free-form and media sending** — `POST /v1/messages` already dispatches
  `send_text`, `send_media` and `send_template` by body type.

---

## 3. The genuine gaps

Everything below is missing and is what this spec designs.

**G1. No credential tier above a workspace.** `partner_api_keys.workspace_id` is
`NOT NULL` with a composite foreign key binding every key to one workspace, and
**no edge function inserts into `workspaces`**. One Postora workspace per wasl
tenant therefore has no mechanism.

**G2. The section capability is not exposed.** Around 70 business operations
live only behind user-JWT edge functions.

**G3. The human-agent tables carry a nullable tenancy column and writers that
ignore it.** Migration `20260726000001` already added `workspace_id` to
`whatsapp_agents` and `whatsapp_conversation_assignments`, backfilled it, and
scoped the active-assignment index by workspace — so the column exists. But it
is **nullable**, existing assignment writers still omit it, and
`whatsapp_assignment_history` was never covered. A workspace-scoped partner read
would silently omit any null-workspace row, making the section look empty for an
affected tenant. §6 states the remaining delta.

**G4. The event catalogue covers messages only.** Comments, assignments and
connection state emit nothing.

**G5. Feature entitlement is client-side.** The four sections are gated by
`useFeatureFlags` in the browser. A partner key bypasses the browser entirely.

---

## 4. Architecture — how capability is lifted

### 4.1 The shared use-case layer already exists — extend it, do not invent one

An earlier draft of this spec proposed creating a `_shared/usecases/`
directory as a new architectural decision. That was wrong, and the correction
matters more than the original proposal.

`supabase/functions/_shared/whatsappPartnerOps.ts` (26KB) is already exactly
that layer. Its header states the pattern outright:

> WhatsApp operations shared by the JWT door (`messaging-api`) and the key door
> (`partner-api`). The context is deliberately role-free: each door authorizes
> in its own terms before constructing one.

It already exports `sendTemplate`, `sendText`, `sendMedia`, `listTemplates` and
`upsertOutboundConversation`, and `messaging-api/index.ts` already consumes it.

**Therefore: every operation this spec lifts is added to
`whatsappPartnerOps.ts`, or to a sibling module following the same shape.**
Creating a second, parallel use-case directory with its own context type is the
duplicate implementation PRD §4.1 forbids, arriving through a different door.

The established shape, which all new work matches:

| Element | Established form |
|---|---|
| Context | `WhatsAppOpsContext { admin, accountId, ownerId, workspaceId, phoneNumberId, accessToken, connectionMode }` — role-free, built by each door |
| Failure | `throw new WhatsAppOpError(message, code, status, metaCode?, indeterminate)` — not a tagged return |
| Indeterminacy | `indeterminate: true` when it cannot be proven Meta did *not* accept, so the caller keeps the quota unit and the request becomes non-resendable |
| Provider seam | the exported `Fetcher` type, threaded by `partnerDispatch.ts` and the crash tests |

**Rejected alternatives.** Re-implementing in `/v1` against the same tables
duplicates rules living in sibling modules (`configBlanking`, `toolSharing`,
`whatsappAccess`, `aiConfigScope`). Proxying `/v1` to `messaging-api` needs user
impersonation, because that door authenticates by user JWT and a partner key has
no user.

**Accepted cost.** Lifting the not-yet-shared operations still touches
`messaging-api/index.ts`, a 2091-line file the browser depends on. Mitigation:
lift only what a phase needs, in the same slice as its endpoints, never as one
upfront rewrite; and treat the existing `messaging-api` tests as the regression
gate on each lift.

### 4.4 Account resolution: two models already coexist

The Partner API resolves a WhatsApp account two different ways, and new routes
must pick the right one deliberately.

| Model | Where | Used for |
|---|---|---|
| **Pinned account** — `partner_api_keys.social_account_id`, `NOT NULL` | `resolveWhatsAppAccount(authed)` in `v1/authenticated.ts` | every existing WhatsApp *operation* (send, templates) |
| **Bound set** — `partner_api_key_accounts` | `boundAccountIds` / `selectBoundAccounts` in `v1/binding.ts` | every existing *collection read*, defaulting to all bound accounts |

`resolveWhatsAppAccount` also performs the preflight new routes must not skip:
it refuses a non-WhatsApp or inactive account with `account_not_connected`, and
a `needs_reauth` or token-expired account with `account_needs_reauth`.

**The gap this spec must close.** A wasl tenant will hold several WhatsApp
numbers in one workspace, but a key pins exactly one. Operating on a second
number would require a second key.

**Decision:** WhatsApp operation routes accept an optional `account_id`.
Resolution becomes: use `account_id` when supplied, else the pinned
`record.socialAccountId`. The supplied id must be in the bound set, and an
unbound id answers `resource_not_found`, matching D11's existing rule. This is
implemented by extending `resolveWhatsAppAccount` to take an optional id rather
than by adding a second resolver.

The pinned account therefore stays the default and nothing existing changes
behaviour, while one key can serve a multi-number tenant.

### 4.2 Resource shape rule

Resources are **channel-generic where the underlying table already is**:
`/v1/conversations`, `/v1/messages`, `/v1/contacts`, `/v1/comments`,
`/v1/agents`. They are WhatsApp-namespaced only for things that are inherently
WhatsApp: numbers and pairing, business profile, catalog and products,
broadcasts.

This rule exists to stop the table becoming `/v1/whatsapp/everything`, which
would freeze a channel name into a contract that already serves seven channels.

### 4.3 Every route declares three things

No route may be added without an alias action, a scope, and a risk class.
`router.ts` structurally requires the first two; the third is a reviewer's job.

- **A** — bounded local read.
- **B** — heavier read, or one that fans out to a provider.
- **C** — any write, anything with an external side effect, anything billable.

Generic scopes only. No legacy scope may satisfy a new action.

---

## 5. Tenancy and the provisioning tier (G1)

### 5.1 Model

One Postora workspace per wasl tenant, one partner key per workspace, bound to
that workspace's social accounts through `partner_api_key_accounts`.

### 5.2 The bootstrap ordering problem, and what it forces

`partner_api_keys.social_account_id` is `NOT NULL` with a composite foreign key
to `(social_account_id, workspace_id)`, and the `create_partner_key` RPC in
`20260831170000_partner_api_credential_lifecycle.sql` requires it. So a
workspace key cannot exist before an account exists.

But an account is created by pairing a WhatsApp number, which needs a key.
**That is a circular dependency and it fails on the first call.**

An earlier draft of this spec did not see it. The resolution is to break the
cycle rather than weaken the constraint: **`social_account_id` stays NOT NULL**,
because relaxing it would let every existing workspace-scoped query match a
null, converting a structural tenancy control into an application-code one.

**The platform tier therefore creates the number placeholder, not the workspace
key holder.** Provisioning becomes one ordered operation:

1. create the partner principal's workspace and its service owner (§5.4),
2. create the WhatsApp `social_accounts` placeholder row in that workspace,
3. issue the workspace key bound to that account, and insert its
   `partner_api_key_accounts` binding in the same transaction,
4. return the key once.

The workspace key then does everything else, including pairing the number it
was issued against.

**Additional numbers are a workspace-tier call**, `POST /v1/whatsapp/numbers`
(§7.1). The cycle forbids only the *first* account, because only then does no
key exist. Once a workspace key exists it can create further accounts and their
own bindings, so routing that through the platform tier would add a second way
to do one thing. An earlier draft had it both ways; the workspace tier owns it.

### 5.3 Credentials attach to a principal, not the reverse

Ownership must not bind to a particular key. If `partner_provisioned_workspaces`
recorded a `platform_key_id`, rotating or revoking that credential would strand
the entire estate: the replacement could not list the workspaces or revoke their
child keys.

So a `partner_principals` row is the stable owner. Platform keys are rotatable
credentials attached to it, and provisioned workspaces record the **principal**.

### 5.4 The platform surface

A **platform key** is not workspace-bound and may do exactly what provisioning
requires. It cannot read a conversation, send a message, or list an account.

| Endpoint | Alias action | Scope | Risk |
|---|---|---|---|
| `POST /v1/platform/workspaces` | `create_workspace` | `platform:workspaces.manage` | C |
| `GET /v1/platform/workspaces` | `list_platform_workspaces` | `platform:workspaces.read` | A |
| `GET /v1/platform/workspaces/{id}` | `get_platform_workspace` | `platform:workspaces.read` | A |
| `POST /v1/platform/workspaces/{id}/keys` | `issue_workspace_key` | `platform:keys.manage` | C |
| `DELETE /v1/platform/keys/{id}` | `revoke_workspace_key` | `platform:keys.manage` | C |

`POST /v1/platform/workspaces` performs steps 1 to 4 above atomically and
returns the workspace, the account id and the key. It is the only call a
partner needs to onboard a tenant.

### 5.4a The limiter cannot meter a platform key as-is

`consume_partner_rate_v2` writes buckets whose `key_id` references
`partner_api_keys`. A platform key id violates that foreign key, so the existing
limiter cannot be reused by renaming a call.

The real export is `checkRateLimit(client, record, riskClass)`, which returns a
status union and throws on refusal. There is no `enforceRateLimit`.

**Decision:** platform keys get their own bucket table and RPC, mirroring the
existing one's semantics and headers exactly. The orchestration is shared; only
the persistence differs, because only the persistence is what the foreign key
constrains.

### 5.3 Rules this tier must satisfy

1. A platform scope is **never** satisfiable by a workspace key, and a workspace
   scope is never satisfiable by a platform key. Asserted in
   `partnerScopes.test.ts` alongside the existing D3 assertions.
2. The issued key's secret is returned **once**, at creation, exactly as
   `create_webhook` already returns a subscription secret.
3. A platform key reaching any non-`/v1/platform/` route answers
   `resource_not_found`, preserving the non-enumerability property that
   `v1/router.test.ts` asserts.
4. `partner_api_keys.workspace_id` stays `NOT NULL`. The platform key lives in a
   separate table rather than relaxing that constraint, because relaxing it
   would let every existing workspace-bound query silently match a null.

### 5.4 A provisioned workspace needs an owner identity

`social_accounts.user_id` is `NOT NULL REFERENCES auth.users(id) ON DELETE
CASCADE`. Every connected account is owned by a real auth user. A partner key
has no user, so a workspace with no owner can never hold an account, and the
first pairing call would fail on a foreign key.

`create_workspace` therefore provisions **a workspace and its owner together**:
a service-account `auth.users` row that no human logs in as, recorded in
`partner_provisioned_workspaces.owner_user_id`. Every account created through
the Partner API in that workspace is owned by it.

Two consequences to hold:

1. **The cascade is a demolition charge.** Deleting that owner deletes every
   social account in the workspace. The owner row must never be cleaned up by a
   routine user-pruning job, and the provisioning table's foreign key to it is
   `ON DELETE RESTRICT`.
2. **The owner has no credentials.** It is created with no password and no
   confirmed email, so the browser door cannot be reached with it. The partner
   key is the only way in.

### 5.5 Direct QR consent has no partner-side answer yet

`createAndGetQr` requires `risk_consent === true` and records the client IP
against it. That gate exists because Direct QR pairing is unofficial WhatsApp
access carrying a real account-ban risk, and Postora records who accepted it.

A partner call has no end-user IP and no end-user click. **Decision:** the
Partner API's pairing endpoint requires an explicit `risk_consent` object
naming the accepting party — `{ accepted: true, accepted_by, accepted_at,
accepted_ip }` — and the partner attests that it collected it. Postora records
the attestation and the partner key that made it, rather than a client IP it
cannot observe.

This shifts a compliance obligation onto the partner, and that is stated in the
contract rather than left implicit. Cloud API and coexistence modes need no such
gate.

### 5.6 Billing is out of scope, and stated as an assumption

Who pays for a wasl tenant's Postora workspace, and which plan it gets, is a
product decision this spec does not make.

**Provisioning does not accept or assign a plan.** An earlier draft promised a
caller-supplied `plan_slug`; nothing consumed it, and neither
`check-subscription` nor `sync-user-quotas` assigns a plan to a synthetic user
— they resolve Stripe state, and account allowances come from user quotas and
subscriptions. Rather than accept a parameter that silently does nothing, the
field is removed.

**Consequence, stated plainly:** a provisioned workspace has whatever plan a
workspace with no subscription has. Entitlement (§10) still gates every action,
so this does not open access, but quota behaviour for provisioned workspaces is
undefined until someone assigns them a plan. That is a deliberate gap, not an
oversight, and it should be closed before the first paying tenant.

**Earlier assumption, now withdrawn:** that provisioned workspaces
are created on a named default plan supplied in the create call, and
`sync-user-quotas` and `check-subscription` treat them like any other. If that
is wrong, quota and metering behaviour for provisioned workspaces is undefined.

---

## 6. Human-agent tenancy migration (G3)

**Correction.** An earlier draft of this spec claimed these tables carry no
workspace column and specified a full tenancy migration. That was wrong.
Migration `20260726000001_supercharge_postora_wacrm_chatwoot.sql` already adds
`workspace_id` to `whatsapp_agents` and `whatsapp_conversation_assignments` by
`ALTER TABLE`, backfills it from each owner's personal workspace, replaces the
agent uniqueness with `(workspace_id, user_id)`, and scopes the active-assignment
index by workspace. The original `CREATE TABLE` statements do not show this,
which is how the error was made.

**The remaining delta is small, and one part of it is a trap.**

1. The added columns are **nullable**, and existing assignment writers still
   omit `workspace_id`. Making it `NOT NULL` immediately would break them.
   Sequence it as expand, backfill, fix writers, then contract — never in one
   migration.
2. `whatsapp_assignment_history` was not covered by that migration and still
   needs its `workspace_id`.
3. Null-workspace assignment rows predating the backfill must be resolved or
   excluded, because a partner read filtered by workspace would silently omit
   them and the section would look empty for an affected tenant.

The API naming decision stands unchanged: the resource is `/v1/agents`, not
`/v1/whatsapp/agents`, because assignment is not a WhatsApp property. The tables
keep their names.

**Whatever migration remains is a backward-compatible prerequisite and must be
applied before the merge that ships its code**, per `AGENTS.md` reviewer rule 2.

---

## 7. Resource model

Alias action, scope and risk class are given for every route. A star marks a
route that already exists and is being extended rather than added.

### 7.1 WhatsApp — numbers and connection lifecycle

The connection lifecycle is native rather than a hosted link, so wasl renders
its own pairing screen.

**Phase 1 supports Direct QR (`evolution_qr`) only.** Cloud API and coexistence
onboarding need a Meta credential exchange, phone-number and WABA association,
and business verification, none of which exist as a partner-drivable flow today.
An earlier draft implied all three were covered; in fact its registration wrote
the same placeholder row for every mode — a `pending_` id, an empty token and
`is_active: false` — which is usable only for the QR path that fills those in
during pairing. `messaging-api`'s `whatsapp_register_phone` registers an
**already connected** account with Meta; it is not this operation.

`POST /v1/whatsapp/numbers` therefore accepts `connection_mode: "evolution_qr"`
and answers `unsupported_capability` for the other two, so a partner learns the
boundary at the call rather than from a number that never connects. Cloud API
and coexistence onboarding is its own deliverable, sequenced after phase 3.

| Endpoint | Alias action | Scope | Risk |
|---|---|---|---|
| `GET /v1/whatsapp/numbers` | `list_whatsapp_numbers` | `whatsapp:numbers.read` | A |
| `GET /v1/whatsapp/numbers/{id}` | `get_whatsapp_number` | `whatsapp:numbers.read` | A |
| `POST /v1/whatsapp/numbers` | `register_whatsapp_number` | `whatsapp:numbers.manage` | C |
| `POST /v1/whatsapp/numbers/{id}/pairing` | `create_whatsapp_pairing` | `whatsapp:numbers.manage` | C |
| `GET /v1/whatsapp/numbers/{id}/pairing` | `get_whatsapp_pairing` | `whatsapp:numbers.read` | B |
| `DELETE /v1/whatsapp/numbers/{id}/session` | `end_whatsapp_session` | `whatsapp:numbers.manage` | C |
| `POST /v1/whatsapp/numbers/{id}/history-sync` | `start_whatsapp_history_sync` | `whatsapp:numbers.manage` | C |
| `GET /v1/whatsapp/numbers/{id}/history-sync` | `get_whatsapp_history_sync` | `whatsapp:numbers.read` | A |
| `GET /v1/whatsapp/numbers/{id}/profile` | `get_whatsapp_profile` | `whatsapp:profile.read` | B |
| `PATCH /v1/whatsapp/numbers/{id}/profile` | `update_whatsapp_profile` | `whatsapp:profile.manage` | C |

Sources: `whatsapp-evolution-bridge` (`create_and_get_qr`, `get_qr_status`,
`get_sync_status`, `logout_instance`, `sync_past_chats`, `resubscribe_webhook`),
`messaging-api` (`whatsapp_register_phone`), and `whatsapp-profile`.

`resubscribe_webhook` is deliberately **not** exposed. It repairs Postora's own
Evolution webhook registration and is an operator action, not a partner one.

### 7.2 Conversations, messages, contacts

| Endpoint | Alias action | Scope | Risk |
|---|---|---|---|
| `GET /v1/conversations` (star) | `list_conversations` | `conversations:read` | A |
| `GET /v1/conversations/{id}` (star) | `get_conversation` | `conversations:read` | A |
| `GET /v1/conversations/{id}/messages` (star) | `list_conversation_messages` | `messages:read` | A |
| `DELETE /v1/conversations/{id}` | `delete_conversation` | `conversations:manage` | C |
| `POST /v1/conversations/{id}/read` | `mark_conversation_read` | `conversations:manage` | C |
| `GET /v1/conversations/{id}/state` | `get_conversation_state` | `conversations:read` | A |
| `POST /v1/messages` (star) | `send_text`, `send_media`, `send_template` | `messages:send` | C |
| `POST /v1/messages` (new body types) | `send_interactive`, `send_voice`, `send_product`, `send_product_list` | `messages:send` | C |
| `GET /v1/messages/{id}` (star) | `get_message` | `messages:read` | A |
| `POST /v1/messages/{id}/forward` | `forward_message` | `messages:send` | C |
| `DELETE /v1/messages/{id}` | `revoke_message` | `messages:manage` | C |
| `PATCH /v1/messages/{id}` | `flag_message` | `messages:manage` | C |
| `GET /v1/contacts` | `list_contacts` | `contacts:read` | A |
| `GET /v1/contacts/{id}` | `get_contact` | `contacts:read` | A |

The four new send types extend the existing `POST /v1/messages` body
discriminator rather than adding routes, matching how `send_text`, `send_media`
and `send_template` already share one route. Each still gets its own alias
action, so a key may be trusted to send text without being trusted to send a
product catalogue.

### 7.3 Templates and catalog

| Endpoint | Alias action | Scope | Risk |
|---|---|---|---|
| `GET /v1/templates` (star) | `list_templates` | `templates:read` | B |
| `POST /v1/templates` | `create_template` | `templates:manage` | C |
| `DELETE /v1/templates/{id}` | `delete_template` | `templates:manage` | C |
| `GET /v1/whatsapp/catalog` | `get_whatsapp_catalog` | `whatsapp:catalog.read` | B |
| `GET /v1/whatsapp/products` | `list_whatsapp_products` | `whatsapp:catalog.read` | B |

### 7.4 Broadcasts, scheduled sends, analytics

| Endpoint | Alias action | Scope | Risk |
|---|---|---|---|
| `POST /v1/whatsapp/broadcasts` | `create_broadcast` | `whatsapp:broadcasts.manage` | C |
| `GET /v1/whatsapp/broadcasts` | `list_broadcasts` | `whatsapp:broadcasts.read` | A |
| `GET /v1/whatsapp/broadcasts/{id}` | `get_broadcast` | `whatsapp:broadcasts.read` | A |
| `POST /v1/whatsapp/scheduled-messages` | `schedule_message` | `messages:schedule` | C |
| `GET /v1/whatsapp/scheduled-messages` | `list_scheduled_messages` | `messages:read` | A |
| `DELETE /v1/whatsapp/scheduled-messages/{id}` | `unschedule_message` | `messages:schedule` | C |
| `GET /v1/whatsapp/analytics` | `get_whatsapp_analytics` | `analytics:read` | B |
| `GET /v1/whatsapp/analytics/messages` | `get_message_analytics` | `analytics:read` | B |

`messages:schedule` is its own scope rather than a `messages:send` rider, for
the reason `posts:schedule` already is: scheduling changes *when* a
customer-visible send happens, and a key trusted to send need not be trusted to
time.

### 7.5 Comments

| Endpoint | Alias action | Scope | Risk |
|---|---|---|---|
| `GET /v1/comments` | `list_comments` | `comments:read` | B |
| `GET /v1/comments/{id}` | `get_comment` | `comments:read` | B |
| `POST /v1/comments/{id}/reply` | `reply_comment` | `comments:manage` | C |
| `POST /v1/comments/{id}/hide` | `hide_comment` | `comments:manage` | C |
| `DELETE /v1/comments/{id}` | `delete_comment` | `comments:manage` | C |

`GET /v1/comments` takes `?platform=` and `?post_id=`, unifying the three
platform-specific list actions (`get_page_comments`, `get_ig_comments`,
`get_youtube_comments`) behind one resource. Risk class B because every list
fans out to a provider.

`get_youtube_videos` is **not** exposed as `/v1/videos`. It is a picker feed for
the browser UI; a partner selects a post through `/v1/posts`.

Platform asymmetry is contract, not accident: delete is unsupported on YouTube
and answers the **existing** `unsupported_capability` code (422), matching how
`messages.capability.test.ts` already handles per-channel capability. Its
current message is message-type specific and is generalised as part of this
work.

### 7.6 Automation and AI agents

| Endpoint | Alias action | Scope | Risk |
|---|---|---|---|
| `GET /v1/automation/agent` | `get_agent_config` | `automation:read` | A |
| `PUT /v1/automation/agent` | `update_agent_config` | `automation:manage` | C |
| `GET /v1/automation/tools` | `list_agent_tools` | `automation:read` | A |
| `PUT /v1/automation/tools/{id}` | `upsert_agent_tool` | `automation:manage` | C |
| `DELETE /v1/automation/tools/{id}` | `delete_agent_tool` | `automation:manage` | C |
| `PUT /v1/automation/tools/{id}/accounts` | `set_tool_accounts` | `automation:manage` | C |
| `GET /v1/automation/handlers` | `get_automation_handlers` | `automation:read` | A |
| `PUT /v1/automation/handlers` | `set_automation_handlers` | `automation:manage` | C |
| `GET /v1/automation/conversation-modes` | `list_conversation_modes` | `automation:read` | A |
| `GET /v1/conversations/{id}/mode` | `get_conversation_mode` | `automation:read` | A |
| `PUT /v1/conversations/{id}/mode` | `set_conversation_mode` | `automation:manage` | C |
| `GET /v1/automation/auto-replies` | `list_auto_replies` | `automation:read` | A |
| `POST /v1/automation/auto-replies` | `create_auto_reply` | `automation:manage` | C |
| `PATCH /v1/automation/auto-replies/{id}` | `update_auto_reply` | `automation:manage` | C |
| `DELETE /v1/automation/auto-replies/{id}` | `delete_auto_reply` | `automation:manage` | C |
| `GET /v1/automation/audience` | `get_audience` | `automation:read` | B |

`update_agent_config` is the highest-risk write in this spec: it changes what an
autonomous agent says to end customers. It carries `automation:manage`, class C,
and its use-case must preserve `configBlanking`'s existing protection, so a
partial write never blanks a live persona. `AGENTS.md` reviewer rule 3 records
that this exact failure already happened once.

### 7.7 Human agents and assignment

Requires the §6 migration first.

| Endpoint | Alias action | Scope | Risk |
|---|---|---|---|
| `GET /v1/agents` | `list_agents` | `agents:read` | A |
| `POST /v1/agents` | `create_agent` | `agents:manage` | C |
| `GET /v1/agents/{id}` | `get_agent` | `agents:read` | A |
| `PATCH /v1/agents/{id}` | `update_agent` | `agents:manage` | C |
| `DELETE /v1/agents/{id}` | `delete_agent` | `agents:manage` | C |
| `GET /v1/conversations/{id}/assignment` | `get_assignment` | `agents:read` | A |
| `PUT /v1/conversations/{id}/assignment` | `assign_conversation` | `agents:manage` | C |
| `DELETE /v1/conversations/{id}/assignment` | `unassign_conversation` | `agents:manage` | C |
| `GET /v1/conversations/{id}/assignment-history` | `list_assignment_history` | `agents:read` | A |

Assignment is modelled as a **singleton sub-resource** rather than a collection,
because `idx_active_assignment` already enforces at most one active assignment
per conversation. `PUT` therefore reassigns rather than creating a duplicate,
and the database constraint, not the handler, is what guarantees it.

---

## 8. Event catalogue additions (G4)

Appended to `CERTIFIED_EVENT_TYPES`. Naming follows the existing convention and
current industry practice: singular resource, `resource.action`, past tense.

| Event | Producer |
|---|---|
| `comment.created` | comment ingest (`threadsCommentIngest`, `youtube-poll-comments`, Meta webhooks) |
| `comment.replied` | `_shared/commentActions.ts` |
| `comment.hidden` | comment use-case |
| `comment.deleted` | comment use-case |
| `conversation.assigned` | assignment trigger |
| `conversation.unassigned` | assignment trigger |
| `conversation.mode_changed` | conversation-mode use-case |
| `whatsapp_number.connected` | `reconcileAccountConnection` in the Evolution bridge |
| `whatsapp_number.disconnected` | same |
| `whatsapp_number.pairing_expired` | QR status poll |
| `history_sync.completed` | history sync worker |

**Producer placement rule.** Where a database trigger can produce the event, it
must, exactly as `post.scheduled` already does via migration `20260902150000`.
A trigger emits transactionally for every writer, the browser and `/v1` alike,
whereas an application-code emitter only fires for the path that remembers to
call it. `conversation.assigned` and `conversation.unassigned` are therefore
trigger-produced.

**Delivery guarantee, stated for partners.** Webhook delivery is at-least-once
with retry. Consumers must key on the event id and treat redelivery as normal.
Because at-least-once with retry can still drop an event across a long consumer
outage, every event-bearing resource is also readable through its
cursor-paginated collection ordered by update time. That is the reconciliation
path, and it is why webhooks alone were rejected.

---

## 9. Scope vocabulary added

`platform:workspaces.read`, `platform:workspaces.manage`, `platform:keys.manage`,
`whatsapp:numbers.read`, `whatsapp:numbers.manage`, `whatsapp:profile.read`,
`whatsapp:profile.manage`, `whatsapp:catalog.read`, `whatsapp:broadcasts.read`,
`whatsapp:broadcasts.manage`, `conversations:manage`, `messages:manage`,
`messages:schedule`, `contacts:read`, `templates:manage`, `analytics:read`,
`comments:read`, `comments:manage`, `automation:read`, `automation:manage`,
`agents:read`, `agents:manage`.

All generic. No legacy scope satisfies any of them, preserving D3.

Three legacy WhatsApp scopes exist (`whatsapp:template.send`,
`whatsapp:templates.read`, `whatsapp:webhooks.manage`). The new `whatsapp:*`
scopes above are generic scopes that merely share a prefix. The prefix is not
what makes a scope legacy; membership in `LegacyScope` is.
`partnerScopes.test.ts` must assert the new ones are not legacy.

---

## 10. Entitlement enforcement (G5)

The four sections are gated in the browser by `useFeatureFlags`. A partner key
never touches the browser, so the same entitlement must be enforced
server-side, in the use-case layer.

**Where entitlement actually lives.** `useFeatureFlags` does not read a plan.
It composes two sources:

1. **Global flags** — `app_settings`, keyed by flag name, value a boolean or a
   JSON-encoded boolean.
2. **Per-user overrides** — `user_feature_overrides` rows of
   `(user_id, feature_key, enabled, expires_at)`. An unexpired override wins
   over the global value.

Both are **user-scoped**. There is no workspace-level entitlement table, and
there is no `workspace_entitlements`.

**The subject for a partner call is the provisioned owner user**, reached
through `partner_provisioned_workspaces.owner_user_id`. That is the one identity
the workspace has, and it is the same identity that owns its accounts, so
entitlement and ownership cannot drift apart.

**There is no one flag per section.** `FLAG_KEYS` is channel- and
mode-specific: WhatsApp alone has distinct visibility, messaging, Cloud API and
Direct QR controls. A single `whatsapp` boolean would let a partner use a
connection mode an operator had disabled.

So entitlement is an **(action, channel, mode) policy**, not a section boolean:

| Checked at | Predicate |
|---|---|
| any WhatsApp route | the WhatsApp section flag |
| a route naming a connection mode | that mode's flag as well |
| a comments route | the flag for that comment platform |
| an automation route | the automation flag for that surface |

Each alias action declares the exact `app_settings` keys it requires, in one
table beside `ACTION_SCOPES`, so the predicate is reviewable in one place and
cannot be chosen differently by two implementers. Every required key must be
enabled; the check is a conjunction.

Feature flags stay distinct from subscription quotas. A flag says whether a
capability is available at all; a quota says how much of it remains.

**Two deliberate differences from the browser.** The browser preserves its last
known cache when the flag read fails, so a transient error never collapses a
live UI. The server does the opposite and **fails closed**: a failed read
refuses. It also **ignores the admin override** that grants admins every flag,
because a partner key is not a person and must not inherit an operator's
elevation.

An action whose feature is not entitled answers a new `feature_not_entitled`
code at **403**, alongside the existing `insufficient_scope` at 403. A partner
must be able to tell "your key may not do this" from "your plan does not include
this", because the remedies differ.

The distinction is carried by the **code**, not the status. That follows
`errors.ts`'s own stated rule that the typed entry, not the HTTP status family,
is what a partner discriminates on. A 402 would be the only 402 in the
vocabulary and would imply a payment flow the Partner API does not operate.

---

## 11. Phasing

One spec, delivered in five phases. WhatsApp first, because wasl loses Evolution
and cannot ship without it.

| Phase | Contents | Unblocks |
|---|---|---|
| 1 | Platform tier (§5), entitlement (§10), WhatsApp numbers and connection lifecycle (§7.1), connection events | wasl can provision a tenant and pair a number |
| 2 | Conversations, messages, contacts, templates, catalog (§7.2, §7.3) | wasl inbox reads and sends |
| 3 | Broadcasts, scheduled sends, analytics (§7.4) | remaining WhatsApp sub-pages |
| 4 | Comments (§7.5) and comment events | the `/comments` section |
| 5 | Automation (§7.6), then the human-agent migration and endpoints (§6, §7.7) | `/automation` and `/human-agent` |

Each phase is independently shippable and independently deployable. Phase 5's
migration is a hard prerequisite for its own endpoints and must land first.

---

## 12. Testing

New endpoints must satisfy the existing suites, which encode security
properties rather than behaviour:

- `contractConformance.test.ts` — the route table matches the published contract.
- `d8Containment.test.ts` — containment of the action surface.
- `isolation.test.ts` — no cross-workspace read.
- `limiterPolicy.test.ts` — every action has a risk class.
- `partnerScopes.test.ts` — no legacy scope satisfies a `/v1` action.
- `v1/router.test.ts` — an unmatched path 404s without touching Supabase.

Added for this work:

- A platform-tier isolation test: a platform key on any workspace route 404s,
  and a workspace key on any platform route 404s.
- An entitlement test per section: an unentitled workspace gets 403 with code
  `feature_not_entitled`, distinguishable from 403 `insufficient_scope`. The
  status is deliberately shared; the code is the discriminator (§10).
- A per-channel capability test for comments, mirroring
  `messages.capability.test.ts`.
- An extraction regression test per lifted use-case: the browser door and the
  `/v1` door produce the same result for the same input.

---

## 13. Deployment

Edge functions do **not** auto-deploy. Every phase ends with a manual deploy per
`docs/runbooks/deploy-edge-function.md`: copy changed files into
`/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/`
over `ssh-contabo-mcp`, verify SHA256, then
`docker compose up -d --no-deps functions`. `npx supabase functions deploy`
targets Supabase Cloud and fails against this self-hosted stack.

Migrations apply **before** the merge that ships their code.

---

## 14. Risks

1. **Extraction regression.** Lifting use-cases out of `messaging-api` can break
   the browser. Mitigated by per-slice extraction and the existing test suite as
   the gate, but it remains the largest risk in this spec.
2. **The platform tier is new attack surface.** A leaked platform key mints
   workspaces and keys. Mitigated by a scope set that grants nothing else, and
   by the 404-on-wrong-tier rule.
3. **Known Evolution defects are inherited.** Direct-QR webhook registration
   builds its URL from the internal `SUPABASE_URL`, and Evolution does not
   return profile pictures. Exposing pairing through the Partner API fixes
   neither; wasl will observe both.
4. **Billing for provisioned workspaces is assumed, not designed** (§5.4).
5. **`update_agent_config` can blank a live persona** if the use-case loses
   `configBlanking`'s protection during extraction.
6. **The provisioned owner user is a cascade root** (§5.4). Deleting it deletes
   every social account in its workspace. Any future user-cleanup job that does
   not know about service-account owners would destroy a tenant's connections.
7. **Direct QR consent becomes a partner attestation** (§5.5). Postora records
   who claimed consent but can no longer observe the accepting client.

---

## 15. Out of scope

- The wasl-side integration. Separate spec.
- Retiring `n8n-api`. wasl migrates onto `/v1`; the old door stays for existing
  n8n users.
- Renaming the `whatsapp_agents` and `whatsapp_conversation_assignments` tables.
