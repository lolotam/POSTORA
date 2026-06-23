## Goal

Standardize all Postora OAuth providers on backend Edge Function callbacks of the form:

```
https://api.postora.cloud/functions/v1/<platform>-oauth
```

After token exchange + account save, every function redirects to:

```
https://postora.cloud/profiles?connected=<platform>
```

All flow context (`profile_id`, `flow`, `return_to`, `nonce`) travels inside the OAuth `state` parameter — never inside the registered redirect URI.

---

## Phase 1 — Inventory & redirect matrix

Read every OAuth hook (`src/hooks/oauth/*`), every callback page (`src/pages/OAuthCallback.tsx`, `PinterestCallback.tsx`, `TikTokCallback.tsx`), every backend OAuth function (`facebook-oauth`, `instagram-oauth`, `threads-oauth`, `tiktok-oauth`, `pinterest-oauth`, `twitter-oauth`, `linkedin-oauth`, `youtube-oauth`, `reddit-oauth`, `bluesky-oauth`, `whatsapp-oauth`), plus `manage-oauth-redirects` and `src/lib/oauthState.ts`.

Deliverable: current-vs-target redirect matrix (in final report) and list of files needing changes. Backend functions for all 11 providers already exist — no new function directories needed except `instagram-business-oauth`.

## Phase 2 — Shared config + state helper

- **New** `src/lib/oauthRedirects.ts` — exports `OAUTH_CALLBACKS` map and `buildCallbackUrl(platform)` that resolves from `import.meta.env.VITE_SUPABASE_URL` (fallback `https://api.postora.cloud`). Includes `instagram` and `instagramBusiness` keys.
- **New** `supabase/functions/_shared/oauthState.ts` — `createState({platform, flow, profile_id, return_to})` (signs with HMAC using `OAUTH_STATE_SECRET`, includes `nonce`, `created_at`, 10-min expiry) and `verifyState(stateParam)`. If `OAUTH_STATE_SECRET` is missing, fall back to existing per-function logic so nothing breaks; emit a one-time warning.
- Extend `src/lib/oauthState.ts` to embed/parse the same shape on the frontend side where hooks still build state locally.

## Phase 3 — Backend lifecycle standardization

For every existing OAuth edge function, unify the lifecycle:

1. **Init** (`GET ?action=start` or POST from frontend) — validate env, build provider auth URL, sign state, return `{ authorize_url }`.
2. **Callback** (`GET /?code=...&state=...`) — verify state, exchange code, fetch account/pages, upsert `social_accounts`, link to `social_profile_id` from state, then `Response.redirect(`https://postora.cloud/profiles?connected=<platform>`, 302)`.
3. **Errors** — redirect to `/profiles?connected=<platform>&error=<masked_code>`; never leak tokens or secret values; log masked.

Provider-specific work:

- **facebook-oauth** — switch registered redirect from `https://postora.cloud/profiles` to its function URL; preserve Pages selection flow (handle Pages list either before redirect-back via interstitial query param, or via existing `/profiles` UI passing `?connected=facebook&pages=true`).
- **instagram-oauth** (existing) — refactor to Direct Instagram Business Login only. `state.flow = "direct"`.
- **instagram-business-oauth** — **NEW** function. Reuse Facebook Pages helper logic, fetch attached IG Business accounts, save selected. `state.flow = "facebook_business"`.
- **threads-oauth** — keep separate app creds; switch callback to function URL; preserve HTTPS guard.
- **tiktok-oauth** — switch from `https://postora.cloud/tiktok-callback` to function URL; keep `TikTokCallback.tsx` route temporarily as a 410/redirect-to-profiles compatibility shim.
- **pinterest-oauth** — switch from `https://postora.cloud/oauth/pinterest/callback` to function URL; keep `PinterestCallback.tsx` as compatibility shim.
- **twitter-oauth** — verify `TWITTER_REDIRECT_URI` (with `X_*` aliases) equals function URL.
- **linkedin-oauth** — single endpoint; branch on `state.flow` (`personal` vs `organization`). For `organization`, after token exchange, fetch `/v2/organizationAcls?q=roleAssignee` (or equivalent) and store one row per managed organization in `social_accounts` (existing schema already supports per-page rows via `platform_user_id` + `account_metadata`). Decision: do **not** create `linkedin-page-oauth` — single endpoint is sufficient because scopes can be conditionally requested based on flow.
- **youtube-oauth** — verify exact-match function URL.
- **reddit-oauth** — move `profile_id` from query string into signed state.
- **bluesky-oauth** — update `public/client-metadata.json` `redirect_uris` to include the function URL; preserve PKCE + DPoP.
- **whatsapp-oauth** — Embedded Signup; keep as-is, no provider redirect URI change, but ensure final redirect lands on `/profiles?connected=whatsapp`.

## Phase 4 — Frontend hook + UI refactor

- Refactor all hooks in `src/hooks/oauth/` to read callback URLs from `OAUTH_CALLBACKS` and to send `profile_id` / `flow` only via state, never via redirect URI.
- **New UI**: `LinkedInConnectDialog` with two cards: *Personal Account* (flow=`personal`) and *Commercial Page / Organization* (flow=`organization`); after org connect, surface the fetched org list (reuse existing Pages selector pattern if available).
- **New UI**: `InstagramConnectDialog` with two cards: *Connect Instagram Directly* (flow=`direct`, hits `instagram-oauth`) and *Connect via Facebook Business* (flow=`facebook_business`, hits `instagram-business-oauth`).
- Wire both dialogs into the existing Connect-account entry points on `/profiles`.
- Mark `OAuthCallback.tsx`, `PinterestCallback.tsx`, `TikTokCallback.tsx` as **deprecated compatibility shims**: keep routes, but body becomes "Finishing connection…" + `window.location.replace('/profiles?connected=<platform>')`. Add code comment with removal target.

## Phase 5 — Provider hardening checks

Static checks only (no provider console access from Lovable):
- TikTok / Pinterest / YouTube: exact-match URL audit in code + report.
- Bluesky: `client-metadata.json` updated.
- WhatsApp: confirm Embedded Signup completion path.
- Twitter/X: env alias handling (`TWITTER_*` || `X_*`).
- Threads: separate `THREADS_APP_ID` / `THREADS_APP_SECRET` confirmed.

## Phase 6 — Compatibility & cleanup

- Keep `OAuthCallback.tsx`, `PinterestCallback.tsx`, `TikTokCallback.tsx` as forward-only shims with TODO comments listing the provider-console URL to remove.
- Keep `/profiles` accepting `?connected=<platform>` to refresh queries (already supported via `useOAuthRedirectHandler.ts`).
- No deletion of working OAuth logic until phase 7 passes.

## Phase 7 — Validation

- Add Vitest unit tests for: `buildCallbackUrl`, state sign/verify roundtrip, LinkedIn flow branching helper, Instagram flow branching helper.
- Run lint, build, typecheck, vitest.
- Run grep guards (forbid `efruibswazzuuupgyzmf`, `supabase.postora.cloud`, `.supabase.co/functions/v1`, `postora.cloud/tiktok-callback`, `postora.cloud/oauth/pinterest/callback` in live code paths — allow in migrations/archived docs/compat shims with comment).

## Phase 8 — Final report

Return sections A–I as specified in the request, including provider console checklist (provider | new URI | old URI to remove | exact-match required | scopes | status).

---

## Technical details

**Database**: no schema change planned. `social_accounts` already stores per-page/per-org rows via `platform_user_id` + `account_metadata` JSONB + `social_profile_id`. If LinkedIn org fetch reveals a missing column during implementation, a new timestamped migration will be added — historical migrations untouched.

**Secrets needed (do NOT request unless missing at implementation time)**: `OAUTH_STATE_SECRET` (generated via `generate_secret`, 64 chars). All provider client IDs/secrets are assumed already present.

**Out of scope**: rotating provider client secrets; updating provider developer consoles (manual step listed in final report).

**Risk mitigation**: backend functions changed one at a time; frontend compat shims keep old provider-console URIs working until each console is updated.
