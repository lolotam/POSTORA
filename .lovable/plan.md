## Goal

Unify Threads OAuth onto the backend Edge Function callback pattern, matching the TikTok / Pinterest / Reddit rollout. The provider must redirect to `https://api.postora.cloud/functions/v1/threads-oauth`, and the function must verify a signed state, exchange the code, save the account, and 302 to `https://postora.cloud/profiles?connected=threads`.

Threads credentials stay independent (`THREADS_APP_ID` / `THREADS_APP_SECRET`). HTTPS guard, capability probing, long‑lived token exchange, scope list, and stored shape of `social_accounts` are preserved exactly. n8n surfaces are not touched.

## Current state (from exploration)

- `supabase/functions/threads-oauth/index.ts` — POST‑only API with `action=authorize` and `action=callback`. `authorize` builds the provider URL using a frontend‑supplied `return_to || redirect_uri` (currently `${origin}/profiles`) as the registered redirect URI, and embeds an **unsigned** base64 JSON state (`user_id`, `social_profile_id`, `return_to`).
- `src/hooks/oauth/useThreadsOAuth.ts` — sends `redirect_uri: ${origin}/profiles` to backend; on return, `src/hooks/oauth/useOAuthRedirectHandler.ts` decodes the legacy state from `/profiles?code=...&state=...` and POSTs back with `action=callback`.
- Shared helper `supabase/functions/_shared/oauthState.ts` (HMAC‑signed state via `OAUTH_STATE_SECRET`) is already in use by Reddit / TikTok / Pinterest.
- `src/lib/oauthRedirects.ts` already maps `threads → threads-oauth` and exposes `buildReturnUrl("threads")`.

## Changes

### 1. `supabase/functions/threads-oauth/index.ts`

Adopt the same lifecycle shape as `tiktok-oauth` / `pinterest-oauth`:

- Add `THREADS_REDIRECT_URI` constant defaulting to `${SUPABASE_URL}/functions/v1/threads-oauth`, overridable via env.
- Keep all existing constants and the missing‑credentials guard.
- Extract two helpers from the current `callback` body so they can be shared by the legacy POST path and the new GET path:
  - `exchangeThreadsCode(code, redirectUri)` — short‑lived → long‑lived token exchange.
  - `saveThreadsAccount(supabase, user_id, social_profile_id, tokenData)` — `/me` fetch, avatar caching, capability probes (insights / discovery / keyword_search / location_tagging w/ sample‑data fingerprint / mentions), `share_to_instagram` / `delete_posts` defaults, `accountMetadata` assembly, and the atomic upsert into `social_accounts` (preserved verbatim).
- **GET handler** at `/functions/v1/threads-oauth?code=...&state=...`:
  - On `?error=...`: 302 to `${RETURN_URL_DEFAULT}?connected=threads&error=...`.
  - Verify state via `verifyOAuthState(state, { expectedPlatform: "threads" })`.
  - Run `exchangeThreadsCode(code, THREADS_REDIRECT_URI)` then `saveThreadsAccount(...)`.
  - 302 to `payload.return_to ?? RETURN_URL_DEFAULT` with `connected=threads` and `profile_id` (when present).
  - On thrown error: 302 to `…/profiles?connected=threads&error=threads_callback_failed`.
- **POST `authorize`** (refactored):
  - Authenticate caller, keep the empty‑`THREADS_APP_ID` guard.
  - Force `effectiveRedirect = THREADS_REDIRECT_URI`. Frontend‑supplied `redirect_uri` is ignored except for echoing it back as `requested_redirect_uri` in the response for debug.
  - Replace base64 JSON state with `createOAuthState({ platform: "threads", user_id, profile_id: social_profile_id ?? null, return_to: return_to ?? RETURN_URL_DEFAULT })`.
  - Build the URL exactly as today (manual `&scope=` concatenation so commas stay literal) using `effectiveRedirect` and the new state.
  - Keep the structured `threads_oauth_authorize_url_built` log; do **not** add anything that leaks the app secret.
- **POST `callback`** kept as a **legacy compatibility shim** so in‑flight sessions opened against `/profiles` still finish:
  - Annotated `// LEGACY: removable after provider console fully cut over.`
  - Validates caller, requires `redirect_uri` + `code`, calls `exchangeThreadsCode(code, redirect_uri)` + `saveThreadsAccount(...)`.
- Top‑level `catch` keeps the sanitized 500 response.

### 2. `src/hooks/oauth/useThreadsOAuth.ts`

- Stop sending any `redirect_uri` to the backend.
- Keep the HTTPS guard and its existing toast.
- `handleThreadsConnect`: POST `{ action: "authorize", social_profile_id: profileId, return_to: buildReturnUrl("threads") }` and follow `data.url`. `user_id` no longer needed in the body (resolved server‑side from JWT).
- `handleThreadsCallback`: keep as a legacy shim for `useOAuthRedirectHandler`. Switch its `redirect_uri` to `OAUTH_CALLBACKS.threads` so the legacy POST path still works during the transition.
- No change to `useOAuthRedirectHandler` — it continues to handle legacy `/profiles?code=&state=` returns until the old provider redirect URI is removed.

### 3. Env / docs

No code changes besides the inline `THREADS_REDIRECT_URI` fallback. Documented (chat + final report) variables:

- `THREADS_APP_ID`, `THREADS_APP_SECRET` (already present)
- `THREADS_REDIRECT_URI` (optional, defaults to `${SUPABASE_URL}/functions/v1/threads-oauth`)
- `OAUTH_STATE_SECRET` (provisioned in earlier phase)
- `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`

No secret values are read or logged.

### 4. Database

No schema or data changes. Existing rows in `social_accounts` for `platform = "threads"` are unaffected: the upsert key (`user_id, platform, platform_user_id`) and stored columns are identical to today.

### 5. Validation

- `bunx --bun tsgo --noEmit`
- `rg -n "thread-oauth" src supabase` → expect 0
- `rg -n "threads-oauth" src supabase` → expect new and existing refs only
- `rg -n "postora.cloud/profiles" src/hooks/oauth/useThreadsOAuth.ts supabase/functions/threads-oauth` → only `RETURN_URL_DEFAULT` / `buildReturnUrl`
- `rg -n "\.supabase\.co/functions/v1|efruibswazzuuupgyzmf|supabase\.postora\.cloud" src supabase` → expect 0 in live code
- `git diff --check`

### 6. Guard reviews

- CleanCodeGuard on the refactored edge function + hook.
- TestGuard: no test files changed; no test‑code review required.

## Out of scope

- No changes to `supabase/functions/n8n-api`, `n8n-community-node/`, or the public API contracts.
- No changes to other Threads functions (`threads-comment`, `threads-insights`, `threads-publish`, etc.) — they read `social_accounts` rows whose shape is preserved.
- No Facebook changes (still the documented exception).
- No database migration.

## Manual provider action (post‑deploy)

Meta / Threads Developer Console → Use cases → Threads API → Settings → Redirect URIs:

1. **Add** `https://api.postora.cloud/functions/v1/threads-oauth`.
2. Keep the existing `https://postora.cloud/profiles` redirect temporarily so in‑flight sessions still complete via the legacy POST shim.
3. After 24–48h of successful GET callback logs in `threads-oauth`, **remove** the legacy `/profiles` redirect URI.
