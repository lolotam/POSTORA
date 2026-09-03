# Admin Partner Hub & Usage Monitoring — Design

**Date:** 2026-09-02
**Branch:** `feat/admin-partner-hub`
**Route:** `/admin/partner-hub`
**Status:** draft for Codex adversarial review

## 1. Goal

Give a platform administrator one page to mint, inspect and revoke Partner API
keys across every workspace, and to see how those keys are consuming the
`/v1` API and the partner webhook outbox — without ever exposing a key hash, a
webhook secret, or a previously issued plaintext key.

Completion criterion (Waleed pipeline): the feature branch passes
`tsc -b`, `vitest`, the Deno edge suites, the SQL harness, `clean-code-guard`
and `test-guard`, is reviewed by CodexBot, and is merged into `main`.

## 2. What already exists (verified 2026-09-02)

| Piece | State |
|---|---|
| `partner_api_keys` | hash at rest, `environment` (`production`/`staging`), `scopes text[]`, `monthly_quota`, `usage_reserved/confirmed/indeterminate`, `current_usage_count` (= the sum), `last_reset_at`, `last_used_at`, `expires_at`, `revoked_at`, `superseded_by_key_id`. Authenticated may SELECT a column list, only through the "Workspace admins read partner keys" RLS policy. `key_hash` is never client-selectable. |
| `create_partner_key(...)` 11-arg RPC | SECURITY DEFINER, gated by `partner_caller_may_manage_keys(workspace)` = workspace **owner/admin membership** of `auth.uid()`. Caller supplies only `key_prefix` + SHA-256 `key_hash`; writes key + binding + `partner_audit_logs` row in one transaction. |
| `revoke_partner_key(id, reason)` | One-way; carries its own inline copy of the membership predicate; appends an audit row only on a real revocation. |
| `rotate_partner_key(...)` | Exists; not surfaced by this feature. |
| `partner_api_usage` | Append-only ledger, one row per `/v1` (and alias) response once the key resolved. Columns: `id,key_id,workspace_id,action,billable,http_status,error_code,created_at`. **No `request_id`, no latency.** `authenticated` has no SELECT grant at all. |
| `partner_webhooks` / `partner_webhook_deliveries` | Service-role only (RLS on, no policies, no authenticated grants). Deliveries are per **workspace subscription**, not per key. Secrets live on the subscription row. |
| `workspaces` | Members-only SELECT. The platform admin is a member of 1 of 58 workspaces. |
| Frontend | Admin pages under `src/pages/admin/*`, routes in `src/components/AnimatedRoutes.tsx`, sidebar in `src/components/admin/AdminLayout.tsx`. Feature modules follow `src/features/<name>/{domain,infrastructure,ui}` (see `webhook-observability`). `has_role(uuid, app_role)` is the admin role check. |
| Operator script | `scripts/create-partner-key.ts` mints from the caller side under a user JWT (plaintext never reaches the server) and validates scopes (`scopeIsMintable`) and account health before calling the RPC. |
| Live data | 1 key (revoked, legacy scopes), 4 usage rows, 0 webhooks, 0 deliveries, 0 audit rows, 58 workspaces, 32 WhatsApp accounts. |

## 3. Decisions and assumptions

These are the calls a reviewer should challenge; each is deliberate.

- **D1 — Platform admins may manage keys in any workspace.** `partner_caller_may_manage_keys(p_workspace_id)` is widened to `membership OR public.has_role(auth.uid(), 'admin')`, and `revoke_partner_key` is rewritten to call that shared predicate instead of its inline copy (otherwise the widening never reaches revocation). Same signatures, `CREATE OR REPLACE`. This widens access for the `admin` role only and narrows nothing (AGENTS.md rule 5). `created_by` / `actor_id` keep coming from `auth.uid()`, so the audit trail names the administrator.
- **D2 — Reads go through admin-only SECURITY DEFINER RPCs.** No table policy is widened. Each `admin_partner_*` function starts with `partner_hub_assert_admin()`, which RAISES `insufficient_privilege` for a non-admin (a refused read must never look like an empty one). No function ever selects `key_hash`, `secret`, or `previous_secret`.
- **D3 — Minting happens in the browser, like the operator script.** The page generates the key with `crypto.getRandomValues` + `crypto.subtle.digest("SHA-256")`, then calls the existing `create_partner_key` under the admin's JWT with only the prefix and hash. The plaintext never transits a Postora server. No new edge function. The database already refuses a prefix/environment mismatch and a non-64-hex hash; the two checks it does not make (mintable scopes, account health) move into the form: the scope list is a frontend twin of `GENERIC_SCOPES` kept in sync by a vitest that reads `docs/api/openapi.yaml` `GenericScope` (the same parity check the Deno suite runs), and the account picker only offers healthy accounts.
- **D4 — Request ID and latency are added to the ledger.** `partner_api_usage` gains nullable `request_id TEXT` and `latency_ms INTEGER`. `recordUsage` writes them from both the `/v1` door and the alias door. Old rows render "—". This makes the change a `partner-api` edge deploy, not frontend-only, and the migration must be live before the edge deploy (nullable columns keep old code valid in the gap).
- **D5 — "Status toggle" becomes a status badge plus a one-way Revoke.** Revocation has no inverse (no UPDATE policy, `revoked_at` is monotonic by design). The table shows a status badge (`active` / `revoked` / `expired` / `rotated`) and a Revoke button that opens a confirmation dialog with a required reason. Un-revoking is not offered; mint a new key instead.
- **D6 — Webhook deliveries are shown per workspace.** A key does not own deliveries; its workspace's subscriptions do. The drawer's second section is titled "Webhook deliveries — workspace <name>" and lists deliveries for every subscription in that workspace.
- **D7 — Definitions.**
  - *Active partners* = keys with status `active` (not revoked, not past `expires_at`, not superseded). A rotated predecessor still inside its overlap window does not count.
  - *Monthly consumption* = billable ledger rows in the current UTC calendar month (`billable = true`, i.e. Meta-accepted sends that reserved quota), shown with a secondary line of posts created this month (`create_post` with 2xx, which is not billable).
  - *API health* = `http_status < 400` / all ledger rows in the trailing 30 days. Only authenticated requests reach the ledger, so 401s are invisible here by design (non-enumerability).
  - *Webhooks health* = deliveries created in the trailing 30 days, and `delivered / (delivered + exhausted)` among settled ones; pending/delivering counts shown separately.
  - *Quota bar* uses the charged total under the same stale-period rule as `/v1/usage`: `CASE WHEN last_reset_at < date_trunc('month', now()) THEN 0 ELSE current_usage_count END`, computed in SQL so the browser never re-derives it. `monthly_quota IS NULL` = unlimited: show the count, no bar.
- **D8 — The account picker offers WhatsApp accounts only**, matching the operator script's current contract (the composite FK only proves the account is in the workspace; every `/v1` messaging op assumes the bound account is WhatsApp). Filtered in SQL, so the rule lives in one place.
- **D9 — Rotation, rate-limit editing, quota editing, and request-id search are out of scope.** They are PRD §49 items but not in this task's deliverables; the RPCs are shaped so they can be added without reshaping the page.
- **D10 — File locations.** The user's requested paths win where they are explicit: page `src/pages/admin/AdminPartnerHub.tsx`, components `src/components/admin/partner/`, tests `src/components/admin/partner/__tests__/`. ARCHITECTURE §11 forbids raw Supabase queries in pages/components, so adapters, domain rules and hooks live in `src/features/partner-hub/{domain,infrastructure,ui/hooks}` and the components consume them.

## 4. Data layer

One migration, `supabase/migrations/20260902200000_admin_partner_hub.sql`, expand-only and idempotent:

1. `ALTER TABLE partner_api_usage ADD COLUMN IF NOT EXISTS request_id TEXT; ADD COLUMN IF NOT EXISTS latency_ms INTEGER` with `CHECK (latency_ms IS NULL OR latency_ms >= 0)`.
2. `partner_hub_assert_admin()` — private helper (REVOKE from PUBLIC/anon/authenticated); raises `insufficient_privilege` unless `has_role(auth.uid(), 'admin')`.
3. `partner_caller_may_manage_keys` — body widened per D1.
4. `revoke_partner_key` — body uses the shared predicate; audit behaviour unchanged.
5. `admin_partner_hub_overview()` → one row: `active_keys, revoked_keys, month_billable, month_posts, requests_30d, success_30d, deliveries_30d, delivered_30d, exhausted_30d, pending_deliveries`.
6. `admin_partner_keys()` → one row per key, newest first: id, name, environment, key_prefix, workspace_id, workspace_name, social_account_id, account_platform, account_username, scopes, rate_limit_per_min, monthly_quota, usage_charged (stale rule), usage_reserved, usage_confirmed, usage_indeterminate (stale rule), period_start, status, created_at, last_used_at, expires_at, revoked_at, revoked_reason, superseded_by_key_id.
7. `admin_partner_key_targets()` → workspace_id, workspace_name, social_account_id, platform, platform_username, is_active, needs_reauth — WhatsApp accounts with a workspace.
8. `admin_partner_key_activity(p_key_id, p_limit default 50)` → recent ledger rows: id, created_at, action, http_status, error_code, billable, request_id, latency_ms. Limit clamped to 1..200. Raises `no_data_found` if the key does not exist.
9. `admin_partner_key_webhook_deliveries(p_key_id, p_limit default 50)` → deliveries for the key's workspace joined to their subscription: id, occurred_at, event_type, status, attempts, next_attempt_at, last_status_code, last_error, delivered_at, webhook_id, webhook_url, webhook_is_active. Same clamp and not-found behaviour.
10. Grants: every `admin_partner_*` function `REVOKE ALL FROM PUBLIC, anon; GRANT EXECUTE TO authenticated` (the gate is inside). `NOTIFY pgrst, 'reload schema'` at the end.

All functions: `SECURITY DEFINER`, `SET search_path = public`, no dynamic SQL.

## 5. Edge change (`partner-api`)

- `_shared/partnerApiMetering.ts`: `UsageInput` gains `requestId?: string` and `latencyMs?: number`; `recordUsage` writes `request_id` and `latency_ms` (null when absent).
- `partner-api/v1/authenticated.ts`: capture `performance.now()` at handler entry; `usageRowFor` receives `requestId` and the start time and fills both fields.
- `partner-api/index.ts`: the alias door's `respond()` helper already receives `requestId`; it also receives the request start time and passes both to `recordUsage`.

Existing tests extended: `authenticated.test.ts` asserts the ledger row carries `request_id` equal to the response's `X-Postora-Request-Id` and a non-negative integer `latency_ms`; `partnerApiMetering.test.ts` asserts `recordUsage` maps the two new fields and writes null when absent.

## 6. Frontend

```
src/features/partner-hub/
  domain/quotaUsage.ts          quotaPercent(), quotaTone() — 'ok' <80, 'warning' >=80, 'critical' >=95, null when unlimited
  domain/partnerKeyMint.ts      generatePartnerKey(env) → { key, prefix, hash }; browser twin of _shared/partnerApiKeys.ts
  domain/partnerScopes.ts       PARTNER_SCOPES (twin of GENERIC_SCOPES) + one-line descriptions
  domain/activityEndpoints.ts   ACTION_ENDPOINTS: ledger action → "POST /v1/messages" etc.; unknown → the raw action
  domain/credentialsFile.ts     buildCredentialsFile(): the JSON the success view downloads
  infrastructure/partnerHubApi.ts  RPC adapters (fetchOverview, fetchKeys, fetchTargets, fetchKeyActivity, fetchKeyDeliveries, createPartnerKey, revokePartnerKey); throws on error
  ui/hooks/usePartnerHub.ts     react-query hooks; query keys under ["admin","partner-hub", ...]; mutations invalidate keys + overview
  index.ts                      public surface
src/components/admin/partner/
  PartnerHubKpiCards.tsx        four cards from the overview row
  QuotaUsageBar.tsx             Progress + "used / limit (pct%)" with tone colours; unlimited → count only
  ScopeBadges.tsx               clickable badges; active filter highlighted
  PartnerKeysTable.tsx          the table; Revoke disabled unless status === 'active'
  GeneratePartnerKeyDialog.tsx  form → mutation → PartnerKeyCreatedView
  PartnerKeyCreatedView.tsx     plaintext shown once, Copy, Download JSON, warning
  RevokePartnerKeyDialog.tsx    AlertDialog with required reason
  PartnerKeyActivitySheet.tsx   Sheet: recent requests + workspace webhook deliveries
  __tests__/                    vitest for each component
src/pages/admin/AdminPartnerHub.tsx   composes the above; owns scope filter + selected key + dialog state
```

Wiring: lazy route `/admin/partner-hub` in `AnimatedRoutes.tsx`; sidebar item "Partner Hub" (icon `Handshake`) after "OAuth Apps" in `AdminLayout.tsx`.

Mint form fields: Name (required), Workspace (select from targets), Account (select filtered by workspace; unhealthy accounts listed but disabled with a reason), Environment (radio `production` / `staging`), Scopes (checkboxes from `PARTNER_SCOPES`, at least one), Monthly quota (integer ≥ 0, blank = unlimited), Rate limit per minute (integer ≥ 1, default 60). Submit: generate → `create_partner_key` → success view. Closing the dialog after success clears the plaintext from state; there is no way to reopen it.

Success view: plaintext in a read-only monospace field, Copy button (Clipboard API with a fallback toast on failure), Download JSON (`{ name, environment, key, key_prefix, scopes, workspace_id, social_account_id, base_url: "https://api.postora.cloud/functions/v1/partner-api/v1", created_at }`), and a persistent warning that the key is shown once.

Error handling: adapters throw the PostgREST error; hooks surface it through toasts; the page shows an inline error state per section (KPIs, table, sheet) instead of an empty table when a read fails.

## 7. Security invariants

- Admin UI is not the boundary: every read and write is enforced in SQL by `has_role` or the widened membership predicate.
- No RPC returns `key_hash`, `secret`, `previous_secret`, or a plaintext key.
- The plaintext exists only in the browser tab that generated it and only until the dialog closes.
- The service-role key is never involved (§24).
- No secrets are logged; the credentials download is a client-side Blob.

## 8. Testing

- SQL harness suite `supabase/tests/partner_hub_admin.sql` (registered in `scripts/db-harness.sh`), in the `partner_key_environment.sql` idiom: non-admin refused on every `admin_partner_*` RPC; admin sees keys from two workspaces they do not belong to; result columns never include a secret; admin creates and revokes a key in a foreign workspace and the audit rows record the admin as actor; a workspace owner still can; latency CHECK rejects a negative value.
- Deno: the two extensions in §5.
- Vitest: domain tests (quota thresholds, key format/prefix/hash, scope parity with `openapi.yaml`, endpoint mapping, credentials file), component tests (KPI cards render the four numbers; quota bar tones; keys table disables Revoke for non-active keys and calls the scope filter; generate dialog submits prefix + 64-hex hash and shows the plaintext once; activity sheet renders "—" for null latency/request id).
- Gates: `npx tsc -b --noEmit`, `npx vitest run`, Deno suites for `_shared` and `partner-api`, `bash scripts/db-harness.sh` against the PG17 harness, `clean-code-guard`, `test-guard`.

## 9. Deployment order

1. Apply the migration on Contabo via `ssh-contabo-mcp` as `supabase_admin`, then `NOTIFY pgrst, 'reload schema'` and probe one RPC through `https://api.postora.cloud/rest/v1/rpc/admin_partner_hub_overview`.
2. Merge the PR → Dokploy auto-deploys the frontend.
3. Redeploy `partner-api` (index.ts, v1/authenticated.ts, `_shared/partnerApiMetering.ts`) via `docs/runbooks/deploy-edge-function.md` §0 and verify SHA256 hashes.
4. Verify on the live page with the admin account: KPIs load, a staging key can be minted and revoked, the audit rows exist.

## 10. Out of scope

Key rotation UI, editing quota/rate limit on an existing key, request-id search, per-user (non-admin) Developer area, staging environment provisioning.
