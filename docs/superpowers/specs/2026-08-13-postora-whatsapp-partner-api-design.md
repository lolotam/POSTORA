# Postora WhatsApp Partner API — Design

**Date:** 2026-08-13
**Status:** Draft for review
**Author:** Claude (brainstorming session)
**Reference integration:** `F:\Danat-Mostakbal` (property management: tenants, contracts, invoices, electricity billing)

---

## 1. Problem

Postora already contains a near-complete WhatsApp Business platform. What it lacks
is a **server-to-server door** into that platform: a way for another product's
backend to send WhatsApp messages through a business's connected Postora account,
read the resulting conversation, and receive inbound messages back — without
holding a Supabase user session.

Today there are exactly two machine-authenticated doors, and each fails a different way:

| Door | Auth | Why it fails for a partner app |
|---|---|---|
| `messaging-api` | Supabase **user JWT** | A backend service cannot hold a user session. Full capability, correct workspace scoping, wrong auth. |
| `ecommerce-whatsapp-api` | `profiles.api_key` | Machine auth, but scopes by `user_id` (predates workspace tenancy), template-only, six hardcoded event names, no inbox reads, no media, no webhook management. |
| `n8n-api` | `profiles.api_key` | Same key model; social-posting oriented, not messaging. |

`profiles.api_key` itself is the deeper problem: **one key per user**, unscoped,
unrotatable, no per-key permissions, not bound to a workspace or a phone number.
Leaking it from a partner's server exposes every Postora capability that accepts it.

## 2. Goals

1. A partner backend can send WhatsApp messages through a client business's
   connected number using a **revocable, least-privilege, workspace-scoped key**.
2. Every message sent this way appears in the Postora inbox with full CRM context,
   identical to a message sent from the Postora UI.
3. Inbound customer replies are delivered to the partner's backend with a signed,
   **retried** webhook.
4. One implementation of WhatsApp logic serves both doors — no divergence between
   what the UI can do and what the API can do.
5. Existing consumers of `ecommerce-whatsapp-api` (Curemedkw) keep working unchanged.

## 3. Non-goals

- Postora owning the WABA / reselling phone numbers (would make Postora a de-facto
  BSP requiring Meta Tech Provider status, per-conversation billing pass-through,
  and much heavier review). **Decision: each client business brings its own WABA.**
- Instagram/Facebook DM parity in the partner API. WhatsApp only for v1 — the
  IG/FB actions in `messaging-api` still use the legacy `user_id` guard and are
  explicitly out of the partner surface.
- Billing/metering of partner API usage beyond rate limiting.

## 4. Architecture

```
Danat backend                Postora                          Meta
─────────────                ───────                          ────
sendWithWhatsApp()  ──POST──▶ partner-api            ──────▶ Graph API
  (provider seam)             ├── authenticatePartnerKey()
                              │     partner_api_keys (hashed)
                              ├── resolves workspace + account
                              └── _shared/whatsappOps.ts ─────┘
                                        │
Postora UI ──JWT──▶ messaging-api ──────┘   (same logic, both doors)
                                        │
                                        ▼
                              whatsapp_messages + conversations
                                   (inbox, CRM, pipelines)

Danat webhook   ◀──signed POST── whatsapp-webhook ◀──inbound── Meta
  endpoint                        (+ retry queue)
```

The load-bearing idea: `partner-api` is an **auth adapter**, not a second
implementation. All WhatsApp behaviour lives in `_shared/whatsappOps.ts`, which
both `messaging-api` (JWT door) and `partner-api` (key door) call.

## 5. Data model

### 5.1 New: `partner_api_keys`

```sql
CREATE TABLE public.partner_api_keys (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      UUID NOT NULL REFERENCES public.whatsapp_workspaces(id) ON DELETE CASCADE,
  social_account_id UUID REFERENCES public.social_accounts(id) ON DELETE CASCADE,
  created_by        UUID NOT NULL REFERENCES auth.users(id),
  name              TEXT NOT NULL,
  key_prefix        TEXT NOT NULL,          -- first 12 chars, shown in UI for identification
  key_hash          TEXT NOT NULL UNIQUE,   -- SHA-256 of the full key; plaintext never stored
  scopes            TEXT[] NOT NULL DEFAULT '{}',
  rate_limit_per_min INTEGER NOT NULL DEFAULT 60,
  last_used_at      TIMESTAMPTZ,
  expires_at        TIMESTAMPTZ,
  revoked_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX partner_api_keys_hash_active_idx
  ON public.partner_api_keys (key_hash) WHERE revoked_at IS NULL;
```

Key format: `pk_live_<32 random bytes base62>`. Returned **once** at creation.
Lookup is by SHA-256 of the presented key — a database leak yields no usable keys.
`social_account_id` NULL means "any WhatsApp account in this workspace"; set means
the key is pinned to one phone number (recommended for partner integrations).

**RLS:** manageable only by workspace `admin` or `owner`, following the existing
`whatsapp_workspace_members` policy pattern. The edge function reads via service role.

### 5.2 Scopes

| Scope | Grants |
|---|---|
| `whatsapp:send` | `send_text`, `send_template`, `send_media`, `send_interactive` |
| `whatsapp:read` | `list_conversations`, `get_messages`, `list_templates` |
| `whatsapp:manage` | `mark_read`, contact upsert, label assignment |
| `whatsapp:webhooks` | register/update the partner's own callback URL |

Danat v1 needs `whatsapp:send` + `whatsapp:webhooks`. Least privilege is the point:
a send-only key that leaks cannot read the client's customer conversations.

### 5.3 New: `partner_api_idempotency`

```sql
CREATE TABLE public.partner_api_idempotency (
  key_id          UUID NOT NULL REFERENCES public.partner_api_keys(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  response_body   JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (key_id, idempotency_key)
);
```

Retention: 24 hours, pruned by the existing cron mechanism. Without this, a partner
retrying a timed-out send double-messages a real customer — the single most
user-visible failure mode of a notification integration.

### 5.4 Changed: `whatsapp_webhooks`

Add `workspace_id UUID REFERENCES whatsapp_workspaces(id)` (backfilled from the
owner's workspace) so webhook config follows workspace membership like the rest of
the WhatsApp stack, and `partner_api_key_id UUID` so a key's webhook is revoked
with the key.

### 5.5 New: `whatsapp_webhook_deliveries`

```sql
CREATE TABLE public.whatsapp_webhook_deliveries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_id    UUID NOT NULL REFERENCES public.whatsapp_webhooks(id) ON DELETE CASCADE,
  event         TEXT NOT NULL,
  payload       JSONB NOT NULL,
  attempts      INTEGER NOT NULL DEFAULT 0,
  next_retry_at TIMESTAMPTZ,
  delivered_at  TIMESTAMPTZ,
  last_status   INTEGER,
  last_error    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

Existing behaviour (`whatsapp-webhook/index.ts:873 dispatchToWebhooks`) is
fire-and-forget: a single non-2xx increments `failure_count`, and at 10 it flips
`is_active: false`, **silently disabling the integration**. For a partner whose
notification log depends on these callbacks, that is data loss. New behaviour:
enqueue a delivery row, attempt inline, and on failure retry with exponential
backoff (1m, 5m, 30m, 2h, 6h) via `whatsapp-scheduled-sender`'s existing cron slot.
Auto-disable only after the backoff ladder is exhausted, and surface it in the UI.

## 6. The `partner-api` function

`supabase/functions/partner-api/index.ts` — routed as
`POST https://api.postora.cloud/functions/v1/partner-api`.

**Request:**
```
Header: X-Postora-Key: pk_live_...
Header: Idempotency-Key: <caller-generated uuid>   (required for all send_* actions)
Body:   { "action": "send_template", ...params }
```

Pipeline, in order:

1. `authenticatePartnerKey(hash)` → row where `revoked_at IS NULL` and not expired.
2. Scope check for the action; `403 insufficient_scope` on failure.
3. Rate limit per key (`rate_limit_per_min`), sliding window in `api_logs`.
   Return `429` with `Retry-After`.
4. Idempotency replay: on hit, return the stored response verbatim, `200`, with
   `Idempotency-Replayed: true`.
5. Resolve the target `social_account_id` — either the key's pinned account, or a
   request param validated to belong to `key.workspace_id`.
6. Delegate to `_shared/whatsappOps.ts`.
7. Log to `api_logs` (never log message bodies or tokens).

### 6.1 Actions (v1)

| Action | Scope | Notes |
|---|---|---|
| `get_status` | any | Connection health; no message sent. Mirrors the existing `ecommerce-whatsapp-api` GET. |
| `send_template` | `whatsapp:send` | Business-initiated. Always allowed. |
| `send_text` | `whatsapp:send` | Only inside the 24h session window (see §7). |
| `send_media` | `whatsapp:send` | Same window rule. |
| `send_interactive` | `whatsapp:send` | Same window rule. |
| `list_templates` | `whatsapp:read` | So partners can discover approved names rather than hardcode them. |
| `list_conversations` | `whatsapp:read` | |
| `get_messages` | `whatsapp:read` | |
| `register_webhook` | `whatsapp:webhooks` | Upsert URL + secret + event filter. |

### 6.2 Error contract

Typed, stable, machine-readable — partners must branch on these, never on prose:

```json
{ "success": false, "error": { "code": "outside_session_window",
  "message": "...", "retryable": false, "details": { "last_inbound_at": "..." } } }
```

Codes: `invalid_key`, `key_revoked`, `insufficient_scope`, `rate_limited`,
`account_not_connected`, `outside_session_window`, `template_not_approved`,
`invalid_recipient`, `meta_error` (with Meta's code in `details`), `internal_error`.

## 7. The 24-hour session window

Postora does not enforce it today; it sends and lets Meta reject. That is acceptable
for a human in a UI who can read the error, and unacceptable for a machine caller.

`_shared/whatsappSessionWindow.ts`:

```ts
// A free-form (non-template) message is deliverable only within 24h of the
// customer's most recent inbound message. Meta enforces this server-side; we
// check first so callers get a typed, actionable error instead of a Meta code.
export async function assertSendable(client, accountId, phone, messageType)
```

Implementation: read `MAX(timestamp)` from `whatsapp_messages` where
`direction = 'inbound'` for that conversation. If `> 24h` and `messageType !==
'template'`, throw `outside_session_window` with `last_inbound_at` in the details so
the partner can fall back to a template deterministically. This mirrors the
discipline Danat's own provider already has (`src/lib/providers/whatsapp.ts` refuses
to send without a resolved template mapping).

Applied in `whatsappOps`, so **both** doors gain it — the Postora UI benefits too.

## 8. Refactor: `_shared/whatsappOps.ts`

`messaging-api/index.ts` is 1679 lines with ~40 actions. Extract only the 16
WhatsApp ones — the ones already guarded by `withWhatsAppActionAccess` — into pure
functions taking a resolved `WhatsAppAccountAccess`:

```ts
export async function sendText(ctx: WhatsAppOpsContext, input: SendTextInput): Promise<SendResult>
export async function sendTemplate(ctx, input): Promise<SendResult>
export async function sendMedia(ctx, input): Promise<SendResult>
export async function sendInteractive(ctx, input): Promise<SendResult>
export async function listConversations(ctx, input)
export async function getMessages(ctx, input)
export async function listTemplates(ctx)
export async function markRead(ctx, input)
```

Each op keeps the behaviour `messaging-api` has today: call Graph via
`sendWhatsAppWithRetry`, insert into `whatsapp_messages`, and call
`upsertOutboundConversation` with `account.ownerId` / `account.workspaceId` so the
message lands in the inbox and auto-creates the contact.

`messaging-api` action handlers become thin: resolve access via
`withWhatsAppActionAccess`, then call the op. **Behaviour-preserving** — the existing
`messaging-api` tests must pass untouched, which is the refactor's safety net.

The IG/FB actions and their legacy `getAccountToken` path are **not** touched and
**not** exposed via `partner-api`. Reducing that legacy scope is separate work.

## 9. Postora UI

New tab under the existing WhatsApp workspace settings: **Integrations → API Keys**.
- Create key: name, target account, scope checkboxes, optional expiry.
- Full key shown **once** on creation, with copy button; thereafter only `key_prefix`.
- Table: name, prefix, scopes, last used, revoke.
- Webhook panel: URL, secret, event filter, recent delivery attempts with status
  (reading `whatsapp_webhook_deliveries`) — so a partner can self-diagnose.

Follows the existing `useWhatsAppWebhooks.ts` hook pattern.

## 10. AI bot for partner data

`ai-agent-reply` already supports RAG plus user-defined tools
(`ai_agent_tools`, `tool_type = 'n8n_webhook'`, with `url` + `secret`), so "the bot
answers a tenant's question about their invoice" is **configuration plus one endpoint
on the partner's side**, not new agent code:

1. Danat exposes `POST /api/agent/tenant-lookup`, HMAC-verified with the tool secret,
   taking `{ phone }` and returning contract/invoice/balance facts.
2. A Postora `ai_agent_tools` row points at it.
3. The agent calls it when a tenant asks, and answers from real data.

One required fix: `ai_agent_tools` is `user_id`-scoped while the rest of the WhatsApp
stack is workspace-scoped. Add `workspace_id` and scope tool visibility to the
workspace that owns the conversation, or a workspace agent's tools are invisible to
the bot answering that workspace's messages.

**Safety rule for the spec:** the tool endpoint must key off the WhatsApp sender's
phone number as verified by Postora, and must never accept a tenant identifier
supplied in the conversation text — otherwise a customer can ask the bot about
someone else's invoice. This is a prompt-injection-adjacent data-leak path and must
be tested explicitly.

## 11. Danat-Mostakbal integration — step by step

Danat's seam is clean: one function, `sendWithWhatsApp` in
`src/lib/providers/whatsapp.ts`, called through `dispatchNotification.ts`. Its
signature (`WhatsAppProviderMessage → ProviderResult`) is unchanged by this work.

**Phase 0 — Meta prerequisites (blocking, not code, do first):**
1. Danat's business completes Meta Business Verification.
2. Creates its own WABA and adds its phone number.
3. Submits its notification templates for approval (contract expiry, invoice due,
   payment received, maintenance update). *Approval takes days and can be rejected —
   start here, not last.*

**Phase 1 — Connect:** a Danat admin signs into Postora, creates a workspace, and
runs Embedded Signup (`whatsapp-oauth`, `action: exchange_signup`) to connect the
WABA. Already built; no new work.

**Phase 2 — Key:** in Postora → Integrations → API Keys, create a key named
"Danat backend", pinned to the Danat number, scopes `whatsapp:send` +
`whatsapp:webhooks`. Store as `POSTORA_API_KEY` in Danat's environment.

**Phase 3 — Swap the provider:** rewrite `sendWithWhatsApp` to POST
`{ action: "send_template", recipient_phone, template_name, template_language,
template_components }` to `partner-api` with `X-Postora-Key` and an
`Idempotency-Key` derived from Danat's own notification row id — which makes the
existing `notificationDrainJob` retry loop safe by construction. Map the typed error
codes onto Danat's existing `ProviderResult` failure shape. Delete
`WHATSAPP_ACCESS_TOKEN` / `WHATSAPP_PHONE_NUMBER_ID` / `WHATSAPP_WABA_ID` from
Danat's environment — Postora now holds the Meta credentials, which is a security
improvement in itself.

**Phase 4 — Inbox:** tenant replies already flow through `whatsapp-webhook` into
`whatsapp_messages` and the CRM. Danat staff answer from Postora's inbox. Zero code.

**Phase 5 — Webhooks back:** register Danat's `/api/webhooks/postora` endpoint via
`register_webhook`, subscribed to `message.received` and `message.status`. Danat
verifies the `X-Webhook-Signature` HMAC and writes to its notification log.

**Phase 6 — AI bot:** per §10.

## 12. Testing

- **Unit (Deno):** key auth (valid / revoked / expired / wrong workspace), scope
  enforcement per action, idempotency replay, session-window logic at the 23h/25h
  boundaries, HMAC signature generation.
- **Tenancy matrix:** reuse the pattern from the existing cross-workspace isolation
  suite (commit c5f16035) — a key for workspace A must not reach workspace B's
  account, conversations, or templates. This is the highest-risk area and gets the
  most tests.
- **Refactor safety:** existing `messaging-api` and `whatsappAccess` tests pass
  unchanged.
- **Danat side (vitest):** `whatsapp.test.ts` rewritten against a mocked partner-api,
  asserting the typed-error mapping and that `Idempotency-Key` is stable across
  retries of the same notification.
- **Manual:** one real template send to a test number; confirm it appears in the
  Postora inbox with the contact auto-created.

## 13. Deployment sequencing

`main` auto-deploys the frontend via Dokploy, so ordering matters:

1. Apply migrations against production Postgres.
2. Deploy `partner-api`, updated `messaging-api`, updated `whatsapp-webhook` via
   `ssh-contabo-mcp` into the functions volume, then
   `docker compose up -d --no-deps functions` (see `docs/runbooks/deploy-edge-function.md`).
3. **Only then** merge to `main` so the UI ships against a live backend.
4. Danat deploys its provider swap last, after a smoke test of the key.

## 14. Risks

| Risk | Mitigation |
|---|---|
| Template rejection by Meta blocks go-live | Phase 0 first; `list_templates` lets Danat verify approved names at runtime rather than hardcoding. |
| Refactor regresses the Postora UI | Behaviour-preserving extraction; existing tests are the gate; no signature changes to the 16 actions. |
| Leaked partner key | Hashed at rest, scoped, pinned to one account, revocable, rate-limited, expirable. |
| Double-sends to real customers | Idempotency keys required on all sends. |
| Webhook loss silently disabling integration | Retry ladder + delivery table + UI visibility. |
| Bot leaking one tenant's data to another | Tool lookups keyed on Postora-verified sender phone only; explicit test. |

## 15. Open questions

1. Should partner keys be billed/metered per message, or covered by the client's
   Postora subscription? (Affects whether `api_logs` needs a usage rollup.)
2. Should `ecommerce-whatsapp-api` be formally deprecated with a sunset date once it
   is a shim, or maintained indefinitely?
3. Does Danat want staff replying from Postora's inbox, or should replies also
   surface inside Danat's own admin UI (would need `whatsapp:read` + a UI build)?
