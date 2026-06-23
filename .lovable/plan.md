# Instagram OAuth Unification — Two-Path Connection

## Current state (already in place)

- `InstagramConnectDialog` already exists and offers "Direct" vs "Facebook Business" choice — Phase 2 UI is essentially done.
- `useInstagramOAuth.handleInstagramConnect(profileId, flow)` already routes to the two endpoints; Phase 5 hook surface exists but still POSTs `redirect_uri` for direct and falls back to FB SDK for business.
- `instagram-oauth` edge function: POST-only, signs state with raw `btoa(JSON)`, accepts client-supplied `redirect_uri`, no GET callback.
- `instagram-business-oauth`: scaffold that delegates `authorize` to `facebook-oauth` (which has no `authorize` action, so it 4xxs and the hook silently falls back to the FB SDK page-picker flow).
- Shared `_shared/oauthState.ts` helper (HMAC-SHA256) is available and used by Threads/Pinterest/TikTok.
- `buildCallbackUrl("instagram"|"instagramBusiness")` + `buildReturnUrl(...)` already exist in `src/lib/oauthRedirects.ts`.
- `facebook-oauth` keeps its documented exception (SDK + `provider_token` + `list_pages`/`store_page`/`store_instagram`) — untouched.

## Current vs Target

| Surface | Current | Target |
|---|---|---|
| Direct authorize | POST returns URL using client `redirect_uri`, unsigned state | POST forces backend `INSTAGRAM_REDIRECT_URI`, signed state via `createOAuthState` |
| Direct callback | POST `action=callback` invoked by frontend after browser hits `/profiles` | GET on `/functions/v1/instagram-oauth` verifies state, saves, 302 → `/profiles?connected=instagram` (POST callback kept as legacy shim) |
| Business authorize | Delegates to non-existent FB `authorize` → silent fallback to SDK | Self-contained: signed state + Meta `www.facebook.com/v22.0/dialog/oauth` URL with Pages+IG scopes |
| Business callback | None | GET on `/functions/v1/instagram-business-oauth` verifies state, exchanges with Graph, lists Pages, fetches linked IG Business accounts, upserts each, 302 → `/profiles?connected=instagram_business` |
| Frontend hook | Sends `redirect_uri` for direct; sets `window.location.href = data.url` | Stops sending `redirect_uri`; sends only `social_profile_id` + `return_to` |
| Facebook SDK flow | Used for both real FB Pages and (as fallback) IG-business | Used ONLY for real Facebook Pages connection (Phase exception preserved) |

## Phase 3 — `supabase/functions/instagram-oauth/index.ts` (rewrite)

Lifecycle:

- **GET** `?code&state` (provider callback)
  - `verifyOAuthState(state, { expectedPlatform: "instagram" })`
  - Exchange code at `api.instagram.com/oauth/access_token` against `INSTAGRAM_REDIRECT_URI` (server constant)
  - Long-lived exchange (`graph.instagram.com/v22.0/access_token?grant_type=ig_exchange_token`)
  - `/me?fields=id,username,account_type,profile_picture_url`
  - If `account_type === "PERSONAL"` → 302 to `${return_to}&error=personal_account` (frontend hook reads `?error=` and offers FB Business path)
  - Cache avatar; upsert `social_accounts` row (same shape as today, `ig_auth_type:"business_login"`, `flow:"direct"` in metadata) with merge-by-normalized-username preserved
  - 302 → `${return_to || OAUTH_RETURN_URL + "?connected=instagram"}`
- **POST `action=authorize`** — validate env, `createOAuthState({ platform:"instagram", flow:"direct", user_id, profile_id, return_to })`, return Instagram dialog URL with `redirect_uri = INSTAGRAM_REDIRECT_URI` (server) and signed `state`
- **POST `action=callback`** — kept as temporary legacy shim (in-flight sessions); marked `// TEMP: remove after 24-48h`
- Auth: `authenticateCaller` only for POST authorize; GET is unauthenticated (provider redirect) — relies on signed state for identity

## Phase 4 — `supabase/functions/instagram-business-oauth/index.ts` (rewrite)

Lifecycle:

- **GET** `?code&state`
  - `verifyOAuthState(state, { expectedPlatform: "instagram" })`, require `flow === "facebook_business"`
  - Exchange code at `graph.facebook.com/v22.0/oauth/access_token` against `INSTAGRAM_BUSINESS_REDIRECT_URI`
  - `me/accounts?fields=id,name,access_token,instagram_business_account{id,username,profile_picture_url}` (paginated)
  - For each Page that has a linked IG Business account, upsert into `social_accounts` with `platform="instagram"`, `platform_user_id=<ig_business_id>`, `ig_auth_type="facebook_business"`, `account_metadata = { source:"facebook_business", facebook_page_id, page_name, page_access_token, ig_business_account_id }`, `social_profile_id` from state, `onConflict: "user_id,platform,platform_user_id"`
  - 302 → `${return_to || OAUTH_RETURN_URL}?connected=instagram_business&count=<n>`; on zero pages with IG, redirect with `?error=no_instagram_business`
- **POST `action=authorize`** — validate env, sign state, build `https://www.facebook.com/v22.0/dialog/oauth?...` with scopes: `pages_show_list, pages_read_engagement, instagram_basic, instagram_content_publish, business_management, pages_manage_metadata`; force `redirect_uri = INSTAGRAM_BUSINESS_REDIRECT_URI`
- Do not touch `facebook-oauth`; do not duplicate Page-selection UI (this path auto-saves every IG-Business account discovered, which is the unified-callback behavior). If user has zero pages or no linked IG, return error param. (Facebook-Page-only connections continue via the existing FB SDK flow.)

## Phase 5 — Frontend hook (`useInstagramOAuth.ts`)

- `handleInstagramConnect("direct")` POSTs `{ action:"authorize", social_profile_id, return_to: buildReturnUrl("instagram") }` — no `redirect_uri`. Sets `window.location.href = data.url`.
- `handleInstagramConnect("facebook_business")` POSTs `{ action:"authorize", social_profile_id, return_to: buildReturnUrl("instagramBusiness") }` to `instagram-business-oauth`. **Removes the silent FB SDK fallback** so the unified flow is exercised; on backend error, surface toast.
- `handleInstagramBusinessCallback` retained as legacy shim for `useOAuthRedirectHandler` until the GET-302 path is verified in production.
- Add light handling in `useOAuthRedirectHandler` (or rely on `?connected=` / `?error=` query string) to toast on `error=personal_account` and offer "Connect via Facebook Business" CTA. (Keep changes minimal — primarily a toast.)

## Phase 6 — `.env.example`

Add (no real values, no inline comments):

```
INSTAGRAM_APP_ID=
INSTAGRAM_APP_SECRET=
INSTAGRAM_REDIRECT_URI=https://api.postora.cloud/functions/v1/instagram-oauth
INSTAGRAM_BUSINESS_REDIRECT_URI=https://api.postora.cloud/functions/v1/instagram-business-oauth
FACEBOOK_APP_ID=
FACEBOOK_APP_SECRET=
OAUTH_STATE_SECRET=
```

## Phase 7 — Provider console (manual, reported only)

1. Meta App → Instagram product → Valid OAuth Redirect URIs: add `https://api.postora.cloud/functions/v1/instagram-oauth`
2. Meta App → Facebook Login → Valid OAuth Redirect URIs: add `https://api.postora.cloud/functions/v1/instagram-business-oauth`
3. Keep `https://postora.cloud/profiles` registered temporarily
4. After 24–48h of clean GET-callback logs, remove the legacy URI

## Out of scope

- `facebook-oauth` (documented exception; SDK + `list_pages`/`store_page` untouched)
- `n8n-api` and `n8n-community-node/`
- Any DB schema change — none needed; `social_accounts.ig_auth_type` and `account_metadata` already accept the new `facebook_business` source
- Removing `InstagramConnectDialog` or Profiles.tsx page selection UX

## Validation

`tsgo --noEmit`; greps for `instgram` (must be 0), `instagram-oauth` / `instagram-business-oauth` (present), `.supabase.co/functions/v1` / `efruibswazzuuupgyzmf` / `supabase.postora.cloud` (must be 0 in live code), `postora.cloud/profiles` only in `oauthRedirects.ts` + legacy shim comment; `git diff --check`.

## Final report

Will follow the project's required template (Summary / Files / DB / Validation / Guards / Secrets / Manual / Status).
