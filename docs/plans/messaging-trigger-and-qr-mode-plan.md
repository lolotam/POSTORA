# Implementation Plan v3 (final) — Messaging Trigger & Reply + WhatsApp QR Connect

Specs: `docs/plans/spec-1-messaging-trigger-reply.md`, `docs/plans/spec-2-whatsapp-qr-evolution.md`
v3 is the implementation contract. It supersedes v1/v2 after two rounds of adversarial review;
every finding below was verified against source or against the live server, not accepted on trust.

**Two PRs.** PR1 = Task A (Meta triggers + reply). PR2 = Task B (Evolution QR), based on PR1.

---

## 0. Verified ground truth

| Spec says | Reality (checked 2026-08-20) |
|---|---|
| Deploy `atendai/evolution-api:v2.2.0` as a new stack | **Already running**: Dokploy swarm app `postora-evolutionapi-zenkpi`, reports **v2.3.7**. Skip the deploy phase. |
| Host `wa-engine.postora.cloud` | **Wrong.** Traefik serves **`wa.postora.cloud`**. `https://wa.postora.cloud/` → 200; `/instance/fetchInstances` + global key → 200. `wa-engine` → 526, no router. |
| Edge functions reach Evolution directly | Evolution is on overlay `dokploy-network`; edge functions on bridge `postorasupabase-supabase-j8axyh`. **No container path.** Public HTTPS works — use it. |
| `social_accounts.connection_mode` column | Does not exist. Mode is `account_metadata.connection_mode`, read at `WhatsAppSetup.tsx:147` and `whatsapp-oauth/index.ts:160-163`, and **overwritten wholesale** at `whatsapp-oauth/index.ts:327-347`. |
| `WhatsAppConnectModal.tsx` | Does not exist. Mode picker is `WhatsAppSetup.tsx` (cards at :229-339). |
| n8n copies under `F:\` | **F: is not mounted.** Vendored `Postora-n8n-community-node/` v1.1.15 has both nodes + 2 test files. Publish is **blocked** — report it, don't fake it. |
| — | Runtime is `supabase/edge-runtime:v1.67.4` (deno 1.45.2); binary carries `EdgeRuntime` (22×) / `waitUntil` (14×). `process-post/index.ts:101-108` already uses it. Background work is viable. |
| — | Evolution v2.3.7 **does** sign webhooks: `headers.jwt_key` → `Authorization: Bearer <HS256 JWT>`, claims `{iat, exp: +600s, app:'evolution', action:'webhook'}` (`webhook.controller.ts:80-86, 287-305`). |

### Constraints that shape the design (all verified)

| # | Fact | Source |
|---|---|---|
| C1 | `account_metadata` is selected wholesale into the browser — **anything stored there is client-readable** | `src/hooks/useSocialAccounts.tsx:37-38` |
| C2 | `checkRateLimit` gets the **exact** path — a `/api/v1/messages` key never matches `/api/v1/messages/reply` | `n8n-api/index.ts:1868` |
| C3 | Existing delivery honours a `'*'` wildcard subscription | `n8n-api/index.ts:1789` |
| C4 | `recordInboxEvent` discards its upsert result → no new-vs-duplicate signal (WhatsApp has one at `whatsapp-webhook:375-381`) | `facebook-instagram-webhook/index.ts:216-223` |
| C5 | `social_accounts` requires `platform_user_id NOT NULL`, `access_token NOT NULL`; WhatsApp rows also require `workspace_id` | base migration `20260101204652…:13-27`; `20260813120000_partner_api_foundation.sql:10-22` |
| C6 | `postWebhook(url, init, fetcher, timeoutMs = 10_000)` **overwrites any caller `signal`** with its own controller, and its redirect loop can spend up to 6× the timeout | `_shared/webhookSecurity.ts:100-135` |
| C7 | `findWhatsAppAccount` selects only `id, user_id, workspace_id, access_token` — no `account_metadata` | `whatsapp-webhook/index.ts:159-165` |
| C8 | A second webhook registry already exists: table `whatsapp_webhooks`, dispatched at `whatsapp-webhook/index.ts:873-935` | `20260413235159…:2-15` |
| C9 | Direct WhatsApp Cloud API senders exist **outside** `messaging-api` | `ai-agent-reply:201-219`, `ecommerce-whatsapp-api:339-348`, `_shared/whatsappPartnerOps.ts:214-251`, `facebook-instagram-webhook:315-348` |
| C10 | Authenticated clients can insert/update their own `social_accounts` rows | base migration `…:107-122` |

---

## PR1 — Task A: real-time messaging trigger & reply

### A1. Background execution — `_shared/background.ts`
`runInBackground(label, fn): void`
- Uses `EdgeRuntime.waitUntil(fn())` when `globalThis.EdgeRuntime?.waitUntil` is callable (verified
  present). **Contract: the caller never awaits it, and the response is not delayed.**
- Degraded path (primitive missing): awaits `fn()` inline under a 2s cap and logs at error level.
  **This means the handler pays up to 2s in degraded mode** — that is the deliberate trade, chosen
  over dropping a customer message onto a detached promise. State it in the doc comment.
- Boot-time log records which path is active, so a runtime downgrade is visible.
- **Delivery is best-effort, not durable.** No outbox in this scope; documented, not implied.

### A2. Dispatcher — `_shared/n8nMessagingDispatch.ts`
- `buildMessagePayload(...)` → the exact envelope from spec 1 §Phase 1.4, one builder for all
  sources. Post events keep their existing `{event, timestamp, data}` shape.
- `dispatchMessageEvent(adminClient, userId, payload)`:
  - Reads `app_settings` `like 'n8n_webhook_<userId>_%'`; matches on `is_active`, event name,
    platform alias, **and the legacy `'*'` wildcard** (C3).
  - Delivers via **`postWebhook(url, init, fetch, 5000)` — the timeout must be the 4th argument**; a
    caller-supplied `AbortSignal` is silently discarded (C6). Budget accordingly: the redirect loop
    can multiply that timeout, so cap redirects or accept the documented worst case.
  - **Bounded concurrency (max 5 in flight)** plus a global fan-out deadline. Unbounded
    `Promise.allSettled` over N subscribers can outlive the background task and exhaust connections.
  - HMAC-SHA256 signature header when a secret exists.
  - Failure accounting: bump `value.failure_count`, deactivate at 10.
  - **Dedupe by destination URL within a single inbound event** so a URL registered in both
    registries (C8) is not delivered twice.
- Index: `CREATE INDEX IF NOT EXISTS app_settings_n8n_webhook_key_idx ON app_settings (key) WHERE key LIKE 'n8n\_webhook\_%';`

**Two registries, deliberately (C8).** `whatsapp_webhooks` is the existing user-facing WhatsApp
webhook feature; `app_settings` n8n keys are the n8n node's registry. They stay separate in this PR.
The WhatsApp inbound path dispatches to both — different subscribers, not a duplicate system. URL
dedupe is the guard. Migration to a single `n8n_webhooks` table (dual-write → backfill → switch
reads → retire) is documented follow-up, deferred on scale grounds.

### A3. Registry — `n8n-api/index.ts`
- Allow-list: `post.completed | post.failed | post.published | message.received | message.whatsapp |
  message.instagram | message.facebook | *`. Unknown → 400. **`'*'` must stay valid** (C3).
- `webhook_secret` is **generated server-side**, returned once, never accepted from the caller —
  in **both** places: registration (`:1437`) and the per-request path (`:477-480`).
- **Redact request-body logging** at `:1435` **and** `:1978-1981`; both currently log the whole body.

### A4. Fan-out wiring
- `whatsapp-webhook` `handleLiveMessages`: dispatch only after the existing `insertedRows` duplicate
  check (`:375-381`). Skip echoes, `statuses[]`, history sync.
- `facebook-instagram-webhook`: change `recordInboxEvent` to return `'inserted' | 'duplicate' | 'error'`
  (`.select("id")` + `ignoreDuplicates`) and dispatch only on `'inserted'` (C4). **A DB error must not
  be reported as `'duplicate'`** — a failed insert must never look like "already handled".
- Both dispatch inside `runInBackground`.

### A5. Automation ownership — explicit opt-in
Per-account `automation_handler ∈ {'internal','n8n'}`, stored in `account_metadata` (non-secret, so
browser-readable is fine per C1), **default `'internal'` ⇒ zero behaviour change for every existing
account**.
- **`findWhatsAppAccount` must be extended to select `account_metadata`** — it currently does not
  (C7), so the setting is unreadable on the WhatsApp path as written.
- Guard **all four** responder call sites, not just WhatsApp: `processAutoReplies` (`:691`) and
  `triggerAiAgentReply` (`:842`), plus the Facebook/Instagram auto-reply paths at
  `facebook-instagram-webhook:155-170`.
- n8n dispatch happens regardless of the setting, so observe-only workflows keep working.
- Preserved across OAuth reconnect: `whatsapp-oauth:327-347` replaces metadata wholesale and **must
  become a merge**.
- `resolveAutomationHandler()` is a pure, unit-tested helper.
- Known limitation, documented not hidden: an AI reply already in flight can still cross an n8n
  reply. A per-message precedence rule cannot fix that.

### A6. Reply endpoint — `POST /api/v1/messages/reply`
- API-key auth. Ownership mismatch → **404** (matches `handleGetMediaById`, `:1707-1711`).
- Rate-limit key is the **exact** string `/api/v1/messages/reply` (C2).
- Body per spec 1 §Phase 2; `platform` derived from the account row when omitted.
- Persists outbound to `whatsapp_messages` + `upsertOutboundConversation`, or `messaging_cache`
  for IG/FB, so replies appear in the unified inbox.
- **Narrow `_shared/messageSend.ts`**: text/media send for WhatsApp Cloud API, Messenger, IG Direct
  only. Preserves per-account token fallback (`messaging-api:755-767`), `sendWhatsAppWithRetry`, and
  conversation-ID normalization. **No broad `messaging-api` refactor in this PR** — migrate it onto
  the helper only after characterization tests pin its current responses.

### A7. n8n node (vendored copy only)
- `PostoraTrigger.node.ts`: add the 4 messaging events (currently only `post.completed` at `:51`).
  Preserve the existing post-event payload contract.
- `Postora.node.ts`: `message` resource + `send`/`reply` operation → `POST /api/v1/messages/reply`.
- Update both test files; bump vendored `package.json` to `1.2.0`.
- **Blocked, must be reported as such:** `F:\N8N\…` sync, standalone `npm test`/`npm run build`, npm publish.

---

## PR2 — Task B: WhatsApp Direct QR Connect (`evolution_qr`)

### B0. Infra deltas
On `postora-evolutionapi-zenkpi`: add `SERVER_URL=https://wa.postora.cloud`,
`WEBHOOK_GLOBAL_ENABLED=false`, `DEL_INSTANCE=true`.
Supabase secrets: `EVOLUTION_API_URL=https://wa.postora.cloud`, `EVOLUTION_API_KEY=<global key>`.
The global key is admin-scoped over every instance: never returned, never logged.

### B1. Schema — `20260821090000_evolution_qr_support.sql`
Mode becomes a real constrained column (as spec 2 asked). JSONB alone is wrong for a
routing-critical field: nothing prevents typos, `whatsapp-oauth:7-14` accepts any non-empty runtime
`mode` string despite its TS union, unknown modes silently read as Cloud API
(`WhatsAppSetup.tsx:146-148`), and clients can write their own rows (C10).

```sql
ALTER TABLE social_accounts ADD COLUMN IF NOT EXISTS connection_mode text DEFAULT 'cloud_api';
-- preflight: normalise anything unexpected BEFORE constraining
UPDATE social_accounts SET connection_mode =
  CASE WHEN account_metadata->>'connection_mode' IN ('cloud_api','coexistence','evolution_qr')
       THEN account_metadata->>'connection_mode' ELSE 'cloud_api' END
  WHERE platform = 'whatsapp';
ALTER TABLE social_accounts ADD CONSTRAINT social_accounts_connection_mode_chk
  CHECK (platform <> 'whatsapp' OR connection_mode IN ('cloud_api','coexistence','evolution_qr')) NOT VALID;
ALTER TABLE social_accounts VALIDATE CONSTRAINT social_accounts_connection_mode_chk;
CREATE INDEX IF NOT EXISTS social_accounts_evolution_qr_idx
  ON social_accounts (user_id, platform) WHERE connection_mode = 'evolution_qr';
```
`DEFAULT 'cloud_api'` closes the NULL routing hole. Platform-aware CHECK leaves other platforms
alone. Follow the existing `NOT VALID` → `VALIDATE` idiom from `20260813120000`. Readers move to the
column (`WhatsAppSetup.tsx:147`, `whatsapp-oauth:160-163`); metadata keeps being written for one
release. **Regenerate `src/integrations/supabase/types.ts` (`:3386-3458`).**

### B2. Server-only credential store
`account_metadata` goes straight to the browser (C1), so no credential may live there.

`whatsapp_evolution_instances`: `social_account_id` (PK, FK), `instance_name` (unique), `jwt_key`,
`created_at`, `rotated_at`, `last_connection_state`, `last_qr`.
**RLS enabled, no client-facing policy — service role only.** Nothing here is ever returned to the
browser. `jwt_key` must be stored **recoverably, not hashed**, because HS256 verification is
symmetric. Consent audit fields (`risk_consent_accepted_at`, `risk_consent_user_ip`) stay in
`account_metadata` — they are not credentials.

### B3. Typed client — `_shared/evolutionApi.ts`
`createInstance`, `connect`, `connectionState`, `logout`, `deleteInstance`, `sendText`, `sendMedia`,
`setWebhook`. Base URL and key from env only. All calls timeout-bounded. Tests stub `fetch`.

### B4. Bridge — `whatsapp-evolution-bridge/index.ts` (user JWT auth)
**Account lifecycle (resolves the v2 contradiction with C5).** `create_and_get_qr` is the only
action that does not take a `social_account_id` — it creates one:
1. Resolve the caller's `workspace_id` (required for WhatsApp rows, C5) and enforce account quota.
2. Require explicit risk consent; record `risk_consent_accepted_at` + client IP.
3. Insert the row satisfying the NOT NULLs (C5): `platform='whatsapp'`, `is_active=false`,
   `connection_mode='evolution_qr'`, `platform_user_id='pending_'||<uuid>`, `access_token=''`.
4. Generate `jwt_key`, store it in `whatsapp_evolution_instances` (§B2).
5. Create the Evolution instance `postora_<socialAccountId>` with `webhook.headers.jwt_key=<key>`,
   events `MESSAGES_UPSERT, CONNECTION_UPDATE, QRCODE_UPDATED`.
6. **Compensating action:** if Evolution creation succeeds but any DB write fails, delete the
   instance so no orphan session survives.
On `CONNECTION_UPDATE: open`, replace `platform_user_id` with the real MSISDN/JID and set
`is_active=true`.

All **other** actions (`get_qr_status`, `logout_instance`) take `social_account_id` and resolve the
instance name **server-side from the owned row**. Client-supplied instance names are never honoured
— with a global admin key in play that is cross-tenant control.

### B5. Inbound — `whatsapp-evolution-webhook/index.ts`
- **Auth: verify the HS256 JWT** Evolution sends as `Authorization: Bearer …` (signed with the
  per-instance `jwt_key`; claims `exp`, `app:'evolution'`, `action:'webhook'`). Verify signature,
  `exp`, and both claims. Unknown instance → 401. **Verify this live against the deployed v2.3.7
  instance before relying on it**; if the header does not arrive, fall back to a per-instance static
  header token and say so.
- Replay: the JWT is not bound to the body, so a captured token is replayable for ≤10 min against
  that one instance. Mitigations: per-instance key, rotatable, plus message-ID idempotency making a
  replay a no-op. Documented limitation.
- **Idempotency before dispatch**, same `insertedRows` pattern as WhatsApp.
- `MESSAGES_UPSERT`: ignore `key.fromMe`, ignore status receipts, normalize into `whatsapp_messages`
  with the same column shape as the Cloud API path, upsert `messaging_cache`, then
  `dispatchMessageEvent` — identical envelope, so n8n workflows need no changes.
- `CONNECTION_UPDATE`: `open→is_active=true` (+ MSISDN fill-in), `close→false`, `connecting→unchanged`.
- `QRCODE_UPDATED`: persist to `whatsapp_evolution_instances.last_qr`.
- 200 immediately; all fan-out inside `runInBackground`.

### B6. Transport + capability enforcement — every sender, not just one
`_shared/whatsappTransport.ts`: `{ sendText, sendMedia, markRead }` with `CloudApiTransport` and
`EvolutionTransport`, resolved from `connection_mode`.

**All direct Cloud API senders must route or reject (C9)** — otherwise a QR-connected account with
the default `internal` handler will try to answer over Cloud API and fail:
`ai-agent-reply:201-219`, `ecommerce-whatsapp-api:339-348`, `_shared/whatsappPartnerOps.ts:214-251`,
`facebook-instagram-webhook:315-348`, and in `messaging-api` the template (`:964-980`), interactive
(`:1275-1294`), and catalog/product (`:1397-1445`) actions.
Unsupported-in-QR actions return a clear `"not supported in Direct QR mode"` error **server-side**.
UI disabling alone is bypassable by any API caller.

### B7. Frontend
- `WhatsAppSetup.tsx`: third mode card behind new flag `waEvolutionQrEnabled` (follow the
  `waCloudApiEnabled` pattern in `useFeatureFlags.tsx`: interface, `DEFAULT_FLAGS`,
  `feature_wa_evolution_qr_enabled` key map, label map, admin entry).
- `WhatsAppQrDisclaimerDialog.tsx`: non-bypassable; proceed disabled until the checkbox is ticked.
- `WhatsAppQrScanner.tsx`: 512px QR, 45s countdown, refresh, success state. **Pairing accounts have
  `is_active=false` and `useSocialAccounts` filters those out (`useSocialAccounts.tsx:41`)** — the
  scanner polls the bridge by account id, never through that hook.
- Mode union widens to `"cloud_api" | "coexistence" | "evolution_qr"`; fix every compiler-flagged
  site (`WhatsAppSetup.tsx:61,65,147`, `lib/whatsappEmbeddedSignup.ts`). Embedded Signup must not
  launch for QR mode.

---

## Sequencing

**PR1:** `_shared/background.ts` + `n8nMessagingDispatch.ts` (+tests) → app_settings index →
`n8n-api` allow-list / server-side secret / log redaction / reply endpoint → `recordInboxEvent`
tri-state return → fan-out in both webhooks → `findWhatsAppAccount` metadata + `automation_handler`
guards on all four responders → vendored n8n node + tests.

**PR2:** schema migration + preflight → `whatsapp_evolution_instances` → `evolutionApi.ts` → bridge
(lifecycle per §B4) → inbound webhook (verify JWT live first) → transport + rejection across all
senders → frontend flag/disclaimer/scanner.

Both: `clean-code-guard` on production code, `test-guard` on tests, `npx tsc --noEmit`, `npm test`,
scoped commits, edge-function deploy per `docs/runbooks/deploy-edge-function.md`.

## Residual risks (accepted, not solved)

- **Delivery is best-effort**, not durable. No outbox in this scope.
- Meta's 5s budget: this work adds no awaited work on the normal path, but the inbound path was
  already heavy (`whatsapp-webhook:120-129, 342-414`). Restructuring to "persist, ack, then process"
  is follow-up work needing latency measurement — not smuggled in here.
- Degraded runtime (no `waitUntil`) delays the response by up to 2s.
- Global Evolution key controls every instance.
- Evolution webhook JWT is not body-bound → ≤10-min replay window, mitigated by idempotency.
- Ban risk is inherent to the unofficial protocol; the consent trail is the mitigation the spec asks
  for, not a technical fix.
- F: not mounted — standalone n8n sync and npm publish cannot complete this session.
