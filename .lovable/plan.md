# Social Reconnect Workflow Fix — Phased Plan

Goal: clicking **Reconnect** on Pinterest, X/Twitter, or TikTok expired warnings runs an OAuth flow that updates the existing `social_accounts` row, clears warnings, and never creates a duplicate — without weakening auth, leaking tokens, or requiring manual delete.

## Phase 1 — Map current flow (read-only)
Inspect and document:
- Frontend: dashboard/profile warning + Reconnect handlers, `src/hooks/oauth/{usePinterestOAuth,useTwitterOAuth,useTikTokOAuth}.ts`, `useProfileOAuth`, `useOAuthRedirectHandler`, social-account/health/dashboard query hooks, `src/pages/PinterestCallback.tsx`, `OAuthCallback.tsx`.
- Backend: `supabase/functions/{pinterest-oauth,twitter-oauth,tiktok-oauth}/index.ts`, `_shared/oauthState.ts`, `_shared/auth-helper.ts`, `_shared/auth-responses.ts`, `refresh-tokens`, `check-connection-health`.
- Answer the 7 mapping questions (which handler runs, does state carry `social_account_id`, does callback update vs insert, are queries invalidated, where warning is derived).

## Phase 2 — Reproduce safely
For each of the 3 platforms: click Reconnect on an expired account, trace redirect, callback, and row diff. Report only presence/absence of fields (never values). Confirm whether duplicates appear and whether UI cache refreshes.

## Phase 3 — Reconnect state propagation (frontend + shared state)
- Extend `_shared/oauthState.ts` payload to include `mode?: "connect" | "reconnect"` and `social_account_id?: string` (already supports `extra`).
- Pinterest/Twitter/TikTok authorize hooks accept optional `{ mode, socialAccountId }`. Reconnect handlers pass `mode="reconnect"` + existing `social_account_id`. CSRF nonce + HMAC signature preserved.
- Add a single `useReconnectAccount(account)` hook used by both the dashboard warning and the profile platform card so behavior is identical.

## Phase 4 — Backend callback update-in-place
In each of `pinterest-oauth`, `twitter-oauth`, `tiktok-oauth` callback handlers:
1. Verify HMAC state via `verifyOAuthState` (existing).
2. If `state.mode === "reconnect"` and `state.social_account_id`:
   - Service-role fetch the row; **403** unless `row.user_id === state.user_id` AND `row.platform === <this provider>`.
   - Exchange code → tokens.
   - **UPDATE** the existing row: `access_token`, `refresh_token`, `token_expires_at`, `is_active=true`, `needs_reauth=false`, clear `failure_count`/`last_refresh_error` (where columns exist), merge `account_metadata`, `updated_at=now()`. Keep `social_profile_id` linkage.
   - Never INSERT a new row in reconnect mode. If the platform-user-id from the new token differs from the stored one, return a clear error code (`RECONNECT_ACCOUNT_MISMATCH`) — do not silently swap identities.
3. If not reconnect mode → existing connect behavior unchanged.
4. Use `auth-responses.ts` helpers; never log tokens, codes, refresh tokens, or Authorization headers.

## Phase 5 — Clear expired warning
- Ensure the fields the dashboard warning reads (`needs_reauth`, `is_active`, `token_expires_at`, `last_refresh_error`, `failure_count`) are reset by callback.
- After successful return to `/profiles?reconnected=<platform>`, invalidate queries: social accounts, connection health, dashboard stats, token warnings, profile accounts.
- If warning is sourced from `token_refresh_history`, ensure latest successful entry supersedes failures (insert a success row in callback if such table is used).

## Phase 6 — User feedback
Reconnect button shows "Connecting…" only during redirect. Success toast "Connection refreshed successfully". Failure toast with readable message (no `[object Object]`). Stale "Could not refresh token" cleared via query invalidation.

## Phase 7 — Per-platform checks
- **Pinterest**: callback updates existing row, board metadata preserved, `PinterestCallback.tsx` forwards `state` unchanged so backend mode propagates.
- **Twitter/X**: OAuth2 PKCE — verifier must round-trip with reconnect mode; no duplicate username row.
- **TikTok**: legacy `/tiktok-callback` path and unified backend redirect both honor reconnect mode; creator metadata preserved.

## Phase 8 — Tests
Vitest additions:
- `oauthState` round-trips `mode` + `social_account_id`.
- Each provider's authorize hook includes reconnect fields when invoked in reconnect mode.
- Each callback (mocked token exchange + mocked supabase) UPDATEs existing row, never INSERTs, in reconnect mode.
- Cross-user reconnect rejected with 403.
- Mismatched provider platform rejected.
- Query invalidation fires after reconnect.
- Grep guard: no `console.log` of `access_token`/`refresh_token`/`Authorization` in changed files.

## Phase 9 — Validation
`npm run build`, `npm run lint`, `npx vitest run`, `git diff --check`, plus the two security greps from the brief (all `|| true`).

## Phase 10 — Deployment notes
Edge Function sync list to `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/`:
- `_shared/` (oauthState extension)
- `pinterest-oauth/`
- `twitter-oauth/`
- `tiktok-oauth/`
Then `docker compose up -d --no-deps functions`. Frontend deploy for hook/UI changes. No SQL expected; if a column is missing (`needs_reauth`, `failure_count`, `last_refresh_error`), create a manual SQL file under `supabase/manual-sql/` and **stop** for owner review.

## Phase 11 — Final 18-section report
Sections 1–18 as specified, ending with one of: `social_reconnect_workflow_fixed` | `social_reconnect_requires_function_sync` | `social_reconnect_requires_frontend_deploy` | `social_reconnect_partial` | `blocked`.

## Out of scope
n8n, Supabase MCP DB writes, old Cloud project, RLS/auth weakening, deleting accounts as a workaround, any secret/token logging or commits.

## Execution
Delegated to Codex phase-by-phase. After Codex completes, run CleanCodeGuard on touched edge functions + frontend hooks, TestGuard on changed tests, and fix or re-delegate findings before final report.
