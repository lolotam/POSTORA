# Postora WhatsApp Partner API — Design (v2)

**Date:** 2026-08-13
**Status:** Draft for review — revised after adversarial review (Codex, thread `019ff844`)
**Reference integration:** `F:\Danat-Mostakbal` (property management: tenants, contracts, invoices, electricity billing)

> **v2 changes.** v1 was reviewed against the code and failed. It named tenancy
> tables that do not exist (a hard migration blocker), claimed four capabilities
> inaccurately, promised a `message.status` callback that is never dispatched, and
> scoped v1 far wider than the reference integration needs. v2 narrows v1 to
> **pinned template sends + inbound webhooks**, corrects every verified error, and
> records what was independently confirmed versus what still needs checking.
> §16 is the correction log.
>
> **v2.1 additions** (after user decisions, 2026-08-13): metering and monthly quota
> are in scope (§5.1b); account tenancy is now **database-enforced** via a composite
> FK, confirmed viable against the live schema (§5.1a); and the cross-server network
> path was verified in both directions from the servers themselves (§13a.1).

---

## 1. Problem

Postora already contains a near-complete WhatsApp Business platform. What it lacks
is a **server-to-server door**: a way for another product's backend to send WhatsApp
messages through a business's connected Postora account and receive inbound messages
back, without holding a Supabase user session.

There are three machine-authenticated doors today; each fails differently:

| Door | Auth | Why it fails for a partner app |
|---|---|---|
| `messaging-api` | Supabase **user JWT** (`index.ts:95-118`) | A backend service cannot hold a user session. Full capability, correct workspace scoping, wrong auth. |
| `ecommerce-whatsapp-api` | `profiles.api_key` | Scopes by `user_id`, predating workspace tenancy. Supports `send_text` (`:229`), `send_template`/`event` (`:242`), `send_media` (`:318`) — but **no inbox reads**, no webhook management, and six hardcoded event names. |
| `n8n-api` | `profiles.api_key` (`:1835-1864`) | Same key model; social-posting oriented. |

`profiles.api_key` is the deeper problem: **one key per user**, unscoped,
unrotatable, no per-key permissions, not bound to a workspace or a phone number.

**However, this repo already has a better credential precedent** —
`mcp_oauth_tokens` (migration `20260601224925_ca73c2f6…`) stores `token_hash TEXT
NOT NULL UNIQUE`, `scopes TEXT[]`, `expires_at`, `revoked_at`, `last_used_at`, and
uses **column-level GRANTs** so clients can read metadata and update only
`revoked_at` while never seeing the hash. Partner keys follow that shape rather than
inventing one.

## 2. Goals

1. A partner backend sends WhatsApp **template** messages through a client's
   connected number using a revocable, least-privilege, workspace-scoped key.
2. Those messages appear in the Postora inbox with full CRM context.
3. Inbound customer replies reach the partner's backend via a signed, **retried,
   at-least-once** webhook that cannot silently disable itself.
4. Retries by the partner never double-message a real customer.
5. Existing `ecommerce-whatsapp-api` consumers (Curemedkw) keep working unchanged.

## 3. Non-goals (v1)

Deliberately cut after review — each is real work that the reference integration
does not need, and each carries risk disproportionate to its v1 value:

- **Postora owning the WABA / reselling numbers.** Would make Postora a de-facto BSP
  requiring Meta Tech Provider status and per-conversation billing. **Decision: each
  client business brings its own WABA.**
- **Extracting all 16 WhatsApp operations** into a shared module (see §8).
- **Free-form text, standalone media, interactive messages, inbox reads, contact and
  label mutation** over the partner API.
- **Unpinned keys** ("any account in this workspace").
- **The AI bot for partner data** — blocked on real work, see §10.
- Instagram/Facebook parity. Those actions still use the legacy `user_id` guard and
  are explicitly outside the partner surface.

## 4. Architecture

```
Danat backend                Postora                          Meta
─────────────                ───────                          ────
sendWithWhatsApp()  ──POST──▶ partner-api            ──────▶ Graph API
  (provider seam)             ├── authenticatePartnerKey()   (Meta is the
                              │     partner_api_keys (hashed)  authority on
                              ├── scope check                  policy)
                              ├── idempotency claim
                              ├── resolves workspace + pinned account
                              └── _shared/whatsappPartnerOps.ts
                                        │
Postora UI ──JWT──▶ messaging-api ──────┘   (shared ops, independent auth)
                                        │
                                        ▼
                              whatsapp_messages + conversations
                                        │
Danat webhook   ◀─signed, retried─ outbox worker ◀── whatsapp-webhook ◀── Meta
  endpoint                         (at-least-once, unordered)
```

`partner-api` is an **auth adapter**, not a second implementation. Critically, the
two doors authorize **independently**: `messaging-api` resolves a human workspace
*role*, `partner-api` resolves key *scopes*. Shared operations accept an
already-authorized, **role-free** account context — the existing
`WhatsAppAccountAccess` type carries a `WorkspaceRole`
(`_shared/whatsappWorkspaceAccess.ts:32-41`) that is meaningless for a machine key.

## 5. Data model

> **Tenancy tables are `workspaces` and `workspace_members`** — *not*
> `whatsapp_workspaces`/`whatsapp_workspace_members`, as v1 wrongly stated. Verified
> in `_shared/whatsappWorkspaceAccess.ts:93-114`. v1's migration would have failed.

### 5.1 New: `partner_api_keys`

Modelled on `mcp_oauth_tokens`.

```sql
CREATE TABLE public.partner_api_keys (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  social_account_id  UUID NOT NULL REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  created_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_by         UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_reason     TEXT,
  name               TEXT NOT NULL,
  key_prefix         TEXT NOT NULL,          -- first 12 chars, for UI identification
  key_hash           TEXT NOT NULL UNIQUE,   -- SHA-256; plaintext never stored
  scopes             TEXT[] NOT NULL DEFAULT '{}',
  rate_limit_per_min INTEGER NOT NULL DEFAULT 60,
  last_used_at       TIMESTAMPTZ,
  expires_at         TIMESTAMPTZ,
  revoked_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX partner_api_keys_hash_active_idx
  ON public.partner_api_keys (key_hash) WHERE revoked_at IS NULL;
```

Key format `pk_live_<32 random bytes base62>`, returned **once** at creation.

Decisions the review forced:

- **`social_account_id` is `NOT NULL`** — every key is pinned to one phone number.
- **Keys are workspace-owned, not creator-owned.** `created_by` is `ON DELETE SET
  NULL` so deleting a user neither blocks the delete nor silently voids a live
  integration. Removing the creator from the workspace does **not** auto-revoke;
  revocation is an explicit act, recorded with `revoked_by` and `revoked_reason`.
- **Application-level tenancy is not enough.** A bare `social_account_id` FK does not
  prove the account belongs to `workspace_id`. See §5.1a — this is now settled and
  database-enforceable.

**RLS:** enabled, with **no direct client access to `key_hash`**. Follow the
`mcp_oauth_tokens` pattern: column-level `GRANT SELECT` on metadata columns to
`authenticated`, `GRANT UPDATE (revoked_at, revoked_by, revoked_reason)`, and a
membership policy restricting rows to workspace admins/owners. The edge function
reads via service role.

### 5.1a Database-enforced account tenancy — resolved

**Verified against the live production database** (`postorasupabase-supabase-j8axyh-supabase-db`,
2026-08-13):

```
social_accounts: id uuid NOT NULL | user_id uuid NOT NULL | platform text NOT NULL
                 social_profile_id uuid NULL | workspace_id uuid NULL
```

`workspace_id` **is** carried directly on `social_accounts`, so tenancy does not have
to be resolved through `social_profiles`. It is **nullable**, and the resolver falls
back to the owner's personal workspace when it is NULL
(`_shared/whatsappWorkspaceAccess.ts:93-114`: `workspaces` where `owner_id =
account.user_id AND is_personal = true`).

Backfill state, live:

| platform | rows | with `workspace_id` | NULL |
|---|---|---|---|
| **whatsapp** | **4** | **4** | **0** |
| facebook | 15 | 14 | 1 |
| instagram | 24 | 23 | 1 |
| *(all others)* | 42 | 42 | 0 |

**Every WhatsApp account already has `workspace_id` populated**, so the strict path is
available without a risky data migration:

1. Add `UNIQUE (id, workspace_id)` on `social_accounts` (redundant given the PK, but
   it is what makes a composite FK legal).
2. `partner_api_keys` declares
   `FOREIGN KEY (social_account_id, workspace_id) REFERENCES social_accounts (id, workspace_id)`.
   A key can then only ever point at an account **in its own workspace** — enforced by
   Postgres, not by application code that a future refactor could bypass.
3. Do **not** make `social_accounts.workspace_id` `NOT NULL` globally — two non-WhatsApp
   rows are NULL and that is outside this work's scope. Instead add a
   `CHECK`/trigger requiring `workspace_id IS NOT NULL` for `platform = 'whatsapp'`,
   backfilling nothing since WhatsApp is already clean.

This is the single strongest control in the design: it makes cross-workspace key
misuse structurally impossible rather than merely tested against.

### 5.1b Metering and quota

Partner usage is metered. Rate limiting alone bounds burst rate but not monthly cost,
and Meta bills per conversation — so an unmetered partner key is an open cost tap.

Added to `partner_api_keys`:

```sql
  rate_limit_per_min  INTEGER NOT NULL DEFAULT 60,
  monthly_quota       INTEGER,          -- NULL = unlimited
  current_usage_count INTEGER NOT NULL DEFAULT 0,
  last_reset_at       TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now()),
```

Plus a durable per-request ledger, because a single counter cannot answer "what did
this partner send last month" after a reset:

```sql
CREATE TABLE public.partner_api_usage (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key_id       UUID NOT NULL REFERENCES public.partner_api_keys(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  action       TEXT NOT NULL,
  billable     BOOLEAN NOT NULL DEFAULT false,  -- true only when Meta accepted a send
  http_status  INTEGER NOT NULL,
  error_code   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX partner_api_usage_ws_time_idx
  ON public.partner_api_usage (workspace_id, created_at DESC);
```

Rules:

- **Count what costs money.** `billable = true` only when Meta accepted the send.
  Rejected requests (`4xx`, `insufficient_scope`, `rate_limited`) and **idempotent
  replays** must not consume quota — otherwise a partner's retry storm burns the
  client's allowance without sending anything.
- **Reset lazily, atomically.** On each request, `UPDATE … SET current_usage_count =
  CASE WHEN last_reset_at < date_trunc('month', now()) THEN 1 ELSE current_usage_count + 1 END,
  last_reset_at = date_trunc('month', now()) … RETURNING current_usage_count` — one
  statement, no cron, no read-then-write race.
- Over quota → `429` with code `quota_exceeded` and `retryable: false` (unlike
  `rate_limited`, which *is* retryable). Partners must distinguish "slow down" from
  "you are done for the month".
- Surface usage in the Integrations UI (§11) and roll it up per workspace, so quota
  can later attach to the subscription plan.

### 5.2 Scopes (v1)

v1's four scopes were the wrong axis: `whatsapp:send` bundled low-risk approved
templates with arbitrary free-form messaging, and `whatsapp:read` bundled template
metadata with customer conversation content. Split by **risk**, not by verb:

| Scope | Grants |
|---|---|
| `whatsapp:template.send` | Send an approved template to a recipient |
| `whatsapp:templates.read` | List approved template names/status |
| `whatsapp:webhooks.manage` | Register/update the key's own callback |

Danat v1 needs all three. Later, if genuinely needed:
`whatsapp:session.send`, `whatsapp:messages.read`, `whatsapp:conversations.manage`.
A leaked v1 key can send a pre-approved template and nothing else — it cannot read a
single customer conversation.

### 5.3 New: `partner_api_idempotency`

v1 said "store the response for 24h" and left concurrency undefined — the gap that
actually causes duplicate messages to real customers.

```sql
CREATE TABLE public.partner_api_idempotency (
  key_id          UUID NOT NULL REFERENCES public.partner_api_keys(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  request_hash    TEXT NOT NULL,
  state           TEXT NOT NULL CHECK (state IN ('processing','completed','indeterminate')),
  http_status     INTEGER,
  response_body   JSONB,      -- normalized partner response only, never raw Meta
  locked_until    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '7 days',
  PRIMARY KEY (key_id, idempotency_key)
);
```

Semantics:

1. **Atomically insert** `state='processing'` with `request_hash` **before** calling Meta.
2. Same key, **different** `request_hash` → `409 idempotency_conflict`.
3. Same key/hash still `processing` → bounded wait, then `409
   idempotency_in_progress` with `Retry-After`.
4. `completed` → replay the stored body and original HTTP status, header
   `Idempotency-Replayed: true`.
5. **Timeout after the Meta call was issued** → mark `indeterminate`. **Never
   auto-retry a send in this state**; surface it and let a human or a status webhook
   resolve it. This is the case that silently double-messages customers.
6. Store only a **normalized** response — Postora request id, Meta message id,
   state, typed error. Not the raw Meta body, which current code sometimes returns
   verbatim (`messaging-api/index.ts:947`, `:1007`).

Retention is **7 days**, not 24h: it must outlive the partner's own retry window.
Danat's `notificationDrainJob` retention must be confirmed to be shorter.

Note `whatsapp_messages` is unique on `(user_id, message_id)` (migration
`20260710100000`), which prevents storing the *same* Meta message twice — it does
**not** prevent two genuine sends with different message ids. Idempotency is the
only defence.

### 5.4 Changed: `whatsapp_webhooks`

Add `workspace_id UUID REFERENCES workspaces(id)` (backfilled) so webhook config
follows workspace membership, and `partner_api_key_id UUID`.

**Revocation is soft** (`revoked_at`), and a foreign key reacts only to row
*deletion* — so revoking a key does **not** disable its webhook by itself. Dispatch
must therefore **join against an active, unexpired key**, or revocation must update
the webhook in the same transaction. Pick the join; it cannot drift.

### 5.5 New: `whatsapp_webhook_deliveries` (transactional outbox)

Current dispatch (`whatsapp-webhook/index.ts:873-934`) is fire-and-forget: one
`fetch`, and `is_active: newFailures < 10` **silently disables the integration** on
the tenth failure. There is no retry, dead-letter, or redelivery.

Worse, and the reason a plain retry table is insufficient: the inbound message is
inserted first and dispatched afterwards (`:355-381`, `:424-436`). If dispatch is
lost after the insert, Meta's own redelivery hits the duplicate check at `:378-381`
and **skips** — so the partner callback is lost permanently. The fix must be a
**transactional outbox**: insert the message and its delivery rows atomically.

```sql
CREATE TABLE public.whatsapp_webhook_deliveries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id      UUID NOT NULL REFERENCES public.whatsapp_webhooks(id) ON DELETE CASCADE,
  source_event_id TEXT NOT NULL,       -- Meta message/status id; dedup anchor
  event           TEXT NOT NULL,
  payload         JSONB NOT NULL,
  state           TEXT NOT NULL DEFAULT 'pending',
  attempts        INTEGER NOT NULL DEFAULT 0,
  locked_until    TIMESTAMPTZ,         -- lease for the worker
  next_retry_at   TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  last_status     INTEGER,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (webhook_id, source_event_id)
);
```

Worker: claim atomically with `FOR UPDATE SKIP LOCKED` plus a lease
(`locked_until`) — **not** the select-then-loop pattern in
`whatsapp-scheduled-sender/index.ts:26-32`, which has no atomic claim and would
double-deliver under concurrency. Backoff 1m / 5m / 30m / 2h / 6h. Auto-disable only
after the ladder is exhausted, and surface it in the UI.

**Guarantees promised to partners — no more:**
- **at-least-once** delivery,
- **best-effort ordering** (backoff inherently lets event 2 land before event 1's
  retry; strict per-conversation ordering would mean head-of-line blocking),
- immutable delivery + event ids, so **partners deduplicate**.

### 5.6 Pre-existing bug this work must not build on

`whatsapp_contacts` is `UNIQUE(user_id, phone_number)` (migration
`20260413173217_9a04ec64…:16`) and upserts still conflict on that pair
(`messaging-api/index.ts:61-70`, `whatsapp-webhook/index.ts:668-673`), while
workspace support only *added* a `workspace_id` column. So one owner handling the
same customer in two workspaces can overwrite or move contact tenancy. Not caused by
this work, but partner traffic will increase the write rate against it. Fix it in the
same migration batch or accept it explicitly.

## 6. The `partner-api` function

`supabase/functions/partner-api/index.ts`, `POST /functions/v1/partner-api`.

**Gateway config is required, not optional.** Every public custom-auth function in
this repo is declared in `supabase/config.toml` with `verify_jwt = false`
(`threads-webhook`, `mcp`, `mcp-oauth`, `ecommerce-whatsapp-api` at `:23-33`).
`partner-api` needs the same entry, and the self-hosted Kong runtime must be
configured to match — otherwise the platform rejects the request before the function
ever authenticates the key.

```
Header: X-Postora-Key: pk_live_...
Header: Idempotency-Key: <caller-generated uuid>   (required on every send)
Body:   { "action": "send_template", ... }
```

Pipeline: authenticate (hash lookup, not revoked, not expired) → scope check →
per-key rate limit → idempotency claim → resolve the key's pinned account →
**verify account health** (§9) → shared op → audit log (never bodies or tokens).

### 6.1 Actions (v1 — three implemented, one deferred)

| Action | Scope | Status |
|---|---|---|
| `get_status` | any — connection health, sends nothing | Plan 1 |
| `send_template` | `whatsapp:template.send` | Plan 1 |
| `list_templates` | `whatsapp:templates.read` — so partners discover approved names instead of hardcoding them | Plan 1 |
| `register_webhook` | `whatsapp:webhooks.manage` | **Plan 2** — deferred with the outbox it configures. The scope exists in v1 so keys can be minted with it, but registering a callback is pointless until the delivery machinery exists. |

### 6.2 Rate limiting

**Not via `api_logs`.** Its schema and indexes are user/endpoint-based, and the
existing count-then-insert limiter in `ecommerce-whatsapp-api/index.ts:120-146` is
non-atomic (two concurrent requests both read under the limit and both pass). Use an
atomic per-key counter — a single `INSERT … ON CONFLICT DO UPDATE … RETURNING`
against a bucket table. Keep `api_logs` for auditing only.

### 6.3 Error contract

```json
{ "success": false, "error": { "code": "outside_session_window",
  "message": "...", "retryable": false, "details": { "meta_code": 131047 } } }
```

Codes — this list is **exhaustive** and every entry must have a test pinning its
code, HTTP status, and `retryable` value. It had already drifted once: two codes
shipped without being added here, which is exactly how a table that calls itself
exhaustive stops being true. Add the row in the same change as the code.

Note the two 503s differ in `retryable`, and the difference is the point.
`limiter_unavailable` is a transient dependency failure, so retrying is the right
thing to do. `temporarily_unavailable` is a capability deliberately withdrawn until
an engineering gate passes, so retrying cannot help and must not be encouraged —
which is also why it carries no `Retry-After`: no honest duration exists.

| Code | Status | Retryable |
|---|---|---|
| `invalid_key` | 401 | no |
| `key_revoked` | 401 | no |
| `key_expired` | 401 | no |
| `insufficient_scope` | 403 | no |
| `unknown_action` | 400 | no |
| `invalid_request` | 400 | no |
| `missing_idempotency_key` | 400 | no |
| `rate_limited` | 429 | **yes** |
| `quota_exceeded` | 429 | no — waiting does not help until the month rolls over |
| `idempotency_conflict` | 409 | no |
| `idempotency_in_progress` | 409 | yes |
| `idempotency_indeterminate` | 409 | no — a previous attempt may have been delivered |
| `account_not_connected` | 409 | no |
| `account_needs_reauth` | 401 | no |
| `outside_session_window` | 422 | no |
| `template_not_approved` | 422 | no |
| `invalid_recipient` | 422 | no |
| `meta_error` | 422 or 502 | 502 only |
| `internal_error` | 500 | yes |
| `limiter_unavailable` | 503 | **yes** — the limiter is down, not the caller's fault (D7) |
| `temporarily_unavailable` | 503 | no — the action is withdrawn until an engineering gate passes, so retrying cannot help |

Responses distinguish **`accepted_by_meta`** from **`delivered`**. Meta accepting a
send is not delivery, and some policy failures arrive later via status webhooks.

## 7. The 24-hour session window — advisory, not authoritative

**v1 was wrong twice here.** It claimed nothing enforces the window; in fact
`ai-agent-reply/index.ts:115` has `isWithinServiceWindow()` gating AI replies, and
`whatsapp-webhook/index.ts:450` already translates Meta error `131047` into a
human-readable "send a template instead". And its proposed **hard local pre-check
was the wrong design.**

Postora's message history is not authoritative: it can be incomplete or delayed, and
it cannot represent Meta's policy variants (free-entry-point, 72h customer-service
windows). A hard local rejection would block messages Meta would have accepted.

**Design:**
- Treat the local timestamp as **advisory metadata** returned to the caller, never as
  authorization.
- **Send, and translate Meta's error** into the typed `outside_session_window` code —
  extending the mapping that already exists at `whatsapp-webhook:450`.
- Handle the **asynchronous** case: `131047` can arrive later via a status webhook.
- **Never apply the window check to templates.** They are always permitted.
- Reuse `isWithinServiceWindow` rather than writing a second implementation.

This matters less in v1 than it looks, since v1 is template-only — but the contract
must be right before free-form sends are added.

## 8. Refactor — minimal, not wholesale

v1 proposed extracting all 16 WhatsApp operations into `_shared/whatsappOps.ts`.
Rejected as too large a regression surface for its benefit: existing tests cover
**access decisions**, not Graph calls, persistence, or response shape
(`whatsappAccess.test.ts`, `_shared/whatsappWorkspaceAccess.test.ts`) — so there is no
characterization safety net. v1 also wrongly implied the 16 ops are uniform; the
product ops use raw `fetch` and inconsistent persistence
(`messaging-api/index.ts:1417-1481`).

**v1 extracts only what it needs**, into `_shared/whatsappPartnerOps.ts`:

```ts
sendTemplate(ctx: WhatsAppOpsContext, input): Promise<SendResult>
listTemplates(ctx): Promise<TemplateSummary[]>
persistOutbound(ctx, result): Promise<void>   // whatsapp_messages + conversation upsert
```

`WhatsAppOpsContext` is **role-free** — account id, phone number id, token, owner id,
workspace id. Each door authorizes before constructing it.

Rules: write **characterization tests first** against current behaviour, then move
the code, then point `messaging-api` at it. Existing tests must pass untouched.
The remaining 14 ops stay where they are until a later phase needs them.

One thing the extraction must fix, not preserve: several insert/upsert calls do not
check the returned Supabase `error` (`messaging-api/index.ts:922-947`, `:982-1007`,
`:1270-1297`), so persistence can fail silently *after* Meta accepted the message.
The shared op needs explicit partial-success semantics — Meta accepted, we failed to
record — surfaced rather than swallowed.

## 9. Account health

Partner sends will fail on stale credentials unless this is handled.
`whatsapp-oauth` stores token expiry (`:253-254`, `:323-365`), but the workspace
resolver does not select or validate `expires_at`, `is_active`, or reauth state
(`_shared/whatsappWorkspaceAccess.ts:54-85`), and `refresh-tokens` has no WhatsApp
implementation. `partner-api` must check health before sending and return
`account_needs_reauth` — a typed, actionable error rather than a Meta rejection.

**Related, and worth fixing during Phase 1:** `whatsapp-oauth` treats
`subscribed_apps` and phone-registration failures as **non-fatal** (`:256-305`) and
still returns success (`:367-374`). A business can therefore appear "connected" while
being unable to receive inbound messages. Connection should be gated on verified
outbound *and* inbound health.

## 10. AI bot for partner data — deferred, and why

v1 claimed this was "configuration, not code". **That was wrong.** `ai_agent_tools`
does support `n8n_webhook` with `url` + `secret`, and `executeCustomTool`
(`tools.ts:305-357`) already has real SSRF protection (`assertPublicHttpsUrl`,
`redirect: "manual"`, timeout) worth reusing elsewhere. But the payload it posts is
`{ tool, input, conversation_id, platform, customer_name }` — where `input` is
**model-generated** — and `ToolContext` (`tools.ts:6-20`) **carries no sender phone
at all**. There is no trusted identity to key a lookup on. Agent code must change.

v1's rule ("key off the verified sender phone, never a tenant id from the
conversation") is necessary but nowhere near sufficient. A safe design needs:

- Server-injected, **signed** canonical identity — normalized sender phone,
  workspace id, account id, event id, timestamp — from trusted state, never from
  model arguments; the partner endpoint **ignores identity claims inside `input`**.
- Identity **bound to** partner + workspace + account. A phone number proves control
  of a WhatsApp identity, not entitlement to every invoice attached to it.
- Step-up verification before returning financial data.
- Narrow structured responses, treated as untrusted **data, never instructions**.
- Redaction and expiry of sensitive tool-call logs.

And the scope problem is bigger than one column: AI configs, conversation modes,
knowledge, threads, tools, and logs are **all** `user_id`-scoped (migration
`20260712000000`), and the webhook invokes AI as the account owner's `user_id`
(`whatsapp-webhook:842-865`). Workspace-safe AI is a **domain migration**, not an
added column. Deferred to its own spec.

## 11. Postora UI

WhatsApp workspace settings → **Integrations**:
- Create key: name, pinned account, scope checkboxes, optional expiry. Full key shown
  **once**; thereafter only `key_prefix`.
- Table: name, prefix, scopes, last used, revoke (with reason).
- Webhook panel: URL, secret, event filter, and recent delivery attempts from
  `whatsapp_webhook_deliveries` — the partner's self-diagnosis surface.

Follows the existing `useWhatsAppWebhooks.ts` hook pattern.

## 12. Webhook security

Current dispatch does an unrestricted `fetch` with **no timeout**
(`whatsapp-webhook:895-907`) and signs the raw body only — replayable. Required:

- Sign `timestamp + delivery_id + rawBody`; enforce timestamp freshness.
- Validate the URL and **every redirect hop**, reusing the connector's
  `assertPublicHttpsUrl` (`ai-agent-reply/tools.ts:262-302`).
- Set an explicit request timeout.

**`message.status` is not currently dispatched at all.** Only `message.received` is
(`whatsapp-webhook:424-436`); the status branch (`:439-491`) never calls
`dispatchToWebhooks`. v1 promised partners a `message.status` callback that does not
exist — implementing it is new work in this phase, with its own deduplication.

## 13. Danat-Mostakbal integration — step by step

Danat's seam is clean: `sendWithWhatsApp` in `src/lib/providers/whatsapp.ts`, called
via `dispatchNotification.ts`, already template-only. Its signature
(`WhatsAppProviderMessage → ProviderResult`) does not change.

**Phase 0 — Meta prerequisites. Start immediately; runs in parallel with all
development.** Business Verification, own WABA, phone number, and **template approval**
(contract expiry, invoice due, payment received, maintenance update). Approval takes
days and can be rejected.

**Phase 1 — Backend.** Migrations (correct table names, composite tenancy FK, RLS,
column GRANTs), key management endpoint + UI, minimal shared ops with characterization
tests, idempotency state machine, **metering + quota**, transactional webhook outbox,
account-health checks, `config.toml` entry. Network path already verified (§13a.1).

**Phase 2 — Connect.** Embedded Signup via `whatsapp-oauth`. **Do not call it
connected until** token health, `subscribed_apps`, phone registration, a real
outbound send, and a real inbound receipt all verify — per §9, the current flow can
report success when subscription or registration silently failed.

**Phase 3 — Key.** Create a pinned, template-only key. Store as `POSTORA_API_KEY`
in Danat's environment.

**Phase 4 — Webhook, before any provider swap.** Register Danat's
`/api/webhooks/postora`, and verify signature validation, retry behaviour, partner-side
deduplication, and `message.status` delivery.

**Phase 5 — Canary.** Template send; concurrent duplicate send; inbound reply; status
event; deliberate callback failure and recovery.

**Phase 6 — Provider swap.** Rewrite `sendWithWhatsApp` to POST `send_template` with
`X-Postora-Key` and an `Idempotency-Key` **derived from Danat's own notification row
id** — which makes the existing `notificationDrainJob` retry loop safe by
construction. Map typed error codes onto `ProviderResult`. **Keep the old direct-Meta
route behind a flag for rollback.**

**Phase 7 — Inbox.** Danat staff answer from Postora's inbox. Zero code.

**Phase 8 — Rotate out** `WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` /
`WHATSAPP_WABA_ID` from Danat only **after** stable production observation.

**Phase 9 — AI bot**, once §10's prerequisites are met.

Ordering note: v1 put the provider swap before webhook verification and deleted
Danat's credentials immediately. Both were wrong — the callback path must be proven
first, and the rollback route must survive the swap.

**Most likely practical failure:** OAuth reporting success while `subscribed_apps` or
phone registration actually failed (§9). **Second:** template component/language
mismatch on real Meta sends.

## 13a. Deployment topology — two separate servers

The two systems live on **different hosts**, so every call between them crosses the
public internet in both directions. This is not an internal integration.

| System | Server | Access MCP |
|---|---|---|
| Postora (frontend + self-hosted Supabase) | Contabo `86.48.2.205` | `ssh-contabo-mcp`, `dokploy-contaboo-mcp` |
| Danat-Mostakbal / Danat-Future | separate host | `ssh-danatfuture-mcp` |

Consequences the design must honour:

- **Outbound (Danat → Postora):** Danat's server calls `https://api.postora.cloud`
  over TLS. Its egress must permit that host, and the partner key is a **cross-host
  bearer credential** — which is exactly why it is hashed at rest, pinned to one
  account, template-only, and revocable.
- **Inbound (Postora → Danat):** the webhook endpoint must be **publicly reachable
  from Contabo** with a valid TLS certificate. Verify this before Phase 4 — a
  Danat endpoint bound to localhost, behind a VPN, or on a self-signed certificate
  will fail silently into the retry ladder. Confirm with an egress test from
  `ssh-contabo-mcp` to Danat's host, not from a laptop.
- **SSRF validation is load-bearing, not ceremony** (§12): Postora is now making
  authenticated outbound requests to a URL a partner supplies, from inside its own
  network.
- **No shared database, no shared network.** The typed HTTP error contract (§6.3) is
  the *entire* interface. Nothing may assume co-location, a shared clock, or a
  private link — which reinforces treating idempotency and at-least-once delivery as
  correctness requirements rather than niceties.
- **Two deploy paths:** Postora edge functions deploy via `ssh-contabo-mcp` into the
  functions volume (§15); Danat's provider swap deploys separately via
  `ssh-danatfuture-mcp`. They are independently rollback-able, which is what makes
  the Phase 6 flag-guarded swap workable.

### 13a.1 Egress verification — executed 2026-08-13, both directions PASS

Run from the servers themselves, not a workstation.

**Postora (Contabo) → Danat**, the webhook direction:

| Check | Result |
|---|---|
| DNS `danat-future.com` | `172.67.182.147`, `2606:4700:3032::6815:2402` (Cloudflare) |
| DNS `supabase.danat-future.com` | resolves, same Cloudflare edge |
| TLS | `ssl_verify_result: 0` — valid chain |
| `GET https://danat-future.com/` | **200**, 194 ms |
| `POST /api/webhooks/postora` (JSON + signature header) | **404**, 92 ms |
| Edge | `server: cloudflare`, `cf-ray: …-CDG` |

The POST result is the one that matters: **404 from the origin, not a 403 challenge**
— an unauthenticated cross-origin POST with a custom header passes Cloudflare and
reaches the application. 404 is expected; the route does not exist yet.

**Danat → Postora (`api.postora.cloud`)**, the send direction:

| Check | Result |
|---|---|
| DNS | `188.114.96.3`, `2a06:98c1:3120::3` (Cloudflare) |
| TLS | `ssl_verify_result: 0` |
| `GET /functions/v1/ecommerce-whatsapp-api` | **401**, 379 ms |
| `POST` with empty body, no key | `{"success":false,"error":"Missing x-api-key header"}` |

That JSON body is application output, which proves the request traversed
**Cloudflare → Kong → the edge function and executed** — and, importantly, that the
gateway lets a **JWT-less** request reach a `verify_jwt = false` function. This is
live confirmation that the §6 `config.toml` requirement for `partner-api` is the
correct and sufficient mechanism.

**Conclusion: the network path is not a risk.** Two residual items, neither blocking:

1. **Cloudflare sits in front of both hosts.** A future WAF or bot-protection rule
   change could start challenging webhook POSTs, and the failure would look like a
   generic delivery failure inside the retry ladder. Mitigate with an explicit WAF
   skip rule on Danat's `/api/webhooks/*` path, and by recording the `cf-ray` header
   in `whatsapp_webhook_deliveries.last_error` so a Cloudflare rejection is
   distinguishable from an origin one.
2. Cloudflare's ~100s proxy timeout is far above the webhook timeout in §12, so it
   does not bind — but the partner endpoint must still answer fast and process
   asynchronously.

## 14. Testing

- **Unit (Deno):** key auth (valid/revoked/expired/wrong workspace), scope
  enforcement, idempotency state machine **including the concurrent-duplicate and
  indeterminate paths**, HMAC generation with timestamp, SSRF rejection of
  private/redirecting webhook URLs.
- **Tenancy matrix:** reuse the cross-workspace isolation pattern from commit
  `c5f16035`. A key for workspace A must not reach workspace B's account or
  templates. Highest-risk area; most tests.
- **Characterization:** written **before** the extraction, asserting current
  `send_template` / `list_templates` behaviour; existing `messaging-api` and
  `whatsappAccess` tests pass unchanged.
- **Outbox:** concurrent workers must not double-deliver (lease + `SKIP LOCKED`);
  a delivery survives a dispatch crash after message insert.
- **Metering:** quota decrements only on a Meta-accepted send; **idempotent replays
  and 4xx rejections do not consume quota**; the monthly reset is atomic under
  concurrent requests; `quota_exceeded` is returned as non-retryable while
  `rate_limited` is retryable.
- **Tenancy at the database layer:** inserting a `partner_api_keys` row whose
  `social_account_id` belongs to another workspace must be rejected by Postgres —
  assert the composite FK fires, not merely that application code checks.
- **Danat (vitest):** `whatsapp.test.ts` against a mocked partner-api, asserting typed
  error mapping and a **stable `Idempotency-Key` across retries** of one notification.

## 15. Deployment sequencing

`main` auto-deploys the frontend via Dokploy, so order matters:

1. Apply migrations to production Postgres.
2. Deploy `partner-api`, updated `messaging-api`, updated `whatsapp-webhook` via
   `ssh-contabo-mcp` into the functions volume, then
   `docker compose up -d --no-deps functions`
   (`docs/runbooks/deploy-edge-function.md`). Confirm the gateway accepts
   `partner-api` without a JWT.
3. **Only then** merge to `main`, so the UI ships against a live backend.
4. Danat deploys its provider swap last, behind a rollback flag.

## 16. Correction log (v1 → v2)

Verified directly against the code during review:

| v1 claim | Reality |
|---|---|
| Tenancy tables `whatsapp_workspaces` / `whatsapp_workspace_members` | **`workspaces` / `workspace_members`** (`whatsappWorkspaceAccess.ts:93-114`). v1's migration would have failed. |
| `ecommerce-whatsapp-api` is template-only | Also supports `send_text` (`:229`) and `send_media` (`:318`). It lacks *inbox reads*, not send variety. |
| No better machine-key precedent than `profiles.api_key` | `mcp_oauth_tokens` (migration `20260601224925_ca73c2f6…`) has hashed tokens, scopes, expiry, revocation, column GRANTs. |
| Nothing enforces the 24h window | `isWithinServiceWindow` (`ai-agent-reply:115`) gates AI replies; `131047` is already translated (`whatsapp-webhook:450`). |
| AI partner tool is "configuration, not code" | `ToolContext` (`tools.ts:6-20`) carries **no sender phone**; payload `input` is model-generated. Agent code must change. |
| `message.status` callback available to partners | Never dispatched — only `message.received` is (`whatsapp-webhook:424-436`). |

Reported by review, **not yet independently verified** — confirm before implementing:
`messaging-api` unchecked insert errors at the cited lines; `refresh-tokens` having no
WhatsApp path; the precise `api_logs` schema/index shape.

## 17. Open questions

**Resolved 2026-08-13:**

- ~~Is usage metered?~~ **Yes** — metering and quota are in scope for v1 (§5.1b).
- ~~Does `social_accounts` carry `workspace_id` directly?~~ **Yes**, nullable, and all
  4 WhatsApp rows are already populated, so the composite FK is viable (§5.1a).
- ~~Is the cross-server network path viable?~~ **Yes**, verified in both directions
  (§13a.1).

**Still open:**

1. Formally deprecate `ecommerce-whatsapp-api` with a sunset once `partner-api` is
   stable, or maintain both indefinitely?
2. Should Danat staff reply from Postora's inbox only, or should conversations also
   surface inside Danat's own admin UI (needs `whatsapp:messages.read` + a UI build)?
3. Where does `monthly_quota` come from — set per key by hand, or derived from the
   client's Postora subscription plan? v1 sets it per key; deriving it from
   `subscription_plans` is the natural follow-up.
