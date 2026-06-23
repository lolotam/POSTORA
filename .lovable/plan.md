## Facebook OAuth Custom Redirect Migration — Plan

Goal: add a unified backend GET callback at `https://api.postora.cloud/functions/v1/facebook-oauth` for connecting Facebook Pages (and the IG-via-FB sub-flow), without breaking the current FB JS SDK flow, the Instagram Business edge function, or existing connected accounts.

### Current vs target

| Aspect | Current | Target (new path) |
|---|---|---|
| Auth start | Browser FB JS SDK (`facebookLogin(scopes)`) | POST `facebook-oauth { action: "authorize", social_profile_id, target_platform }` → returns Meta authorize URL |
| Token source | `loginResult.response.authResponse.accessToken` (FB SDK, browser-held) | Server-side `code` exchange in GET `/functions/v1/facebook-oauth` callback |
| Page selection input | Frontend re-sends `provider_token` on every `store_page` / `store_instagram` POST | Backend stashes token + pages list in a short-lived pending-selection row; frontend references it by `selection_id` only |
| Redirect | none (no redirect URI used by SDK flow) | `https://api.postora.cloud/functions/v1/facebook-oauth` → 302 `https://postora.cloud/profiles?connected=facebook&select=<selection_id>` (or `?connected=facebook` when only one page auto-stored) |
| Legacy compat | — | Keep `action=store_account|list_pages|store_page|store_instagram` with `provider_token` working unchanged during transition |

Important clarification: the existing `provider_token` in `useFacebookOAuth.ts` is the **FB JS SDK** access token, **not** Supabase Auth's `provider_token`. Supabase Auth user login is unrelated and **will not be touched**.

### Phase A — Backend (`supabase/functions/facebook-oauth/index.ts`)

Add, do not remove:

1. `FACEBOOK_REDIRECT_URI` constant: `Deno.env.get("FACEBOOK_REDIRECT_URI") ?? (SUPABASE_URL ? \`${SUPABASE_URL}/functions/v1/facebook-oauth\` : "https://api.postora.cloud/functions/v1/facebook-oauth")`.
2. Top-level `if (req.method === "GET")` handler **before** the existing POST gate:
   - Read `code`, `state`, `error` from query string.
   - On `error`: 302 to `return_to?connected=facebook&error=<reason>`.
   - `verifyOAuthState(state, { expectedPlatform: "facebook" })` (HMAC, 10-min TTL).
   - POST to `https://graph.facebook.com/v22.0/oauth/access_token` with `client_id`, `client_secret`, `redirect_uri` = `FACEBOOK_REDIRECT_URI`, `code` → short-lived user access token.
   - Exchange to long-lived user token (`fb_exchange_token` grant).
   - Fetch `/me/accounts?fields=id,name,access_token,category,instagram_business_account{...},picture` and (when IG-via-FB enabled) standalone IG accounts using the existing helper logic refactored into a `fetchFacebookPagesAndIg(userToken)` function.
   - Insert one row into new `oauth_pending_facebook_selections` table with `{ user_id, social_profile_id, target_platform, provider_token (long-lived), pages_json, ig_standalone_json, expires_at = now()+15min }`.
   - 302 to `${return_to || "https://postora.cloud/profiles"}?connected=facebook&select=<id>`.
   - If exactly one page and no standalone IG and `target_platform === "facebook"`, **auto-store** via the existing `store_page` code path (reusing the same helpers) and 302 to `?connected=facebook` (no `select` param).
3. New POST action `action: "authorize"`:
   - JWT-authenticate caller via `authenticateCaller(req, body?.user_id)` (signature already present).
   - Validate `social_profile_id`, `target_platform ∈ {facebook, instagram}`, `return_to` (only `https://postora.cloud/...`).
   - `createOAuthState({ platform: "facebook", flow: "pages", user_id, profile_id, return_to, extra: { target_platform } })`.
   - Build `https://www.facebook.com/v22.0/dialog/oauth?client_id=...&redirect_uri=${FACEBOOK_REDIRECT_URI}&state=...&scope=<existing scopes joined>&response_type=code`.
   - Return `{ url }`.
4. New POST action `action: "get_pending_selection"`:
   - JWT-authenticate. Read `selection_id`. Verify `user_id` matches the stored row. Return `{ pages, standalone_instagram, social_profile_id, target_platform }` — **never** the token.
5. Refactor `store_page` / `store_instagram` to accept **either** `selection_id` (new path: server reads token from the pending row) **or** legacy `provider_token` (unchanged). After successful store with `selection_id`, delete the pending row.
6. Extract shared helpers used today inside `store_account` for page enumeration/upsert into private functions to avoid duplication. Keep behavior identical (same `social_accounts` columns, same Cloudinary avatar caching, same IG merge-by-username).

### Phase B — Database (manual SQL only)

Create script `supabase/manual-sql/20260623_facebook_pending_selections.sql` with:

```sql
-- Purpose: short-lived stash for Facebook OAuth backend-callback page selection.
-- Type: schema (table + RLS + grants). Safe to re-run (IF NOT EXISTS / DROP POLICY IF EXISTS).
-- Rollback: DROP TABLE public.oauth_pending_facebook_selections;

CREATE TABLE IF NOT EXISTS public.oauth_pending_facebook_selections (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  social_profile_id UUID,
  target_platform TEXT NOT NULL CHECK (target_platform IN ('facebook','instagram')),
  provider_token TEXT NOT NULL,
  pages_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  ig_standalone_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '15 minutes')
);

GRANT SELECT ON public.oauth_pending_facebook_selections TO authenticated;
GRANT ALL ON public.oauth_pending_facebook_selections TO service_role;

ALTER TABLE public.oauth_pending_facebook_selections ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "own pending fb selection read" ON public.oauth_pending_facebook_selections;
CREATE POLICY "own pending fb selection read"
ON public.oauth_pending_facebook_selections
FOR SELECT TO authenticated
USING (user_id = auth.uid());

CREATE INDEX IF NOT EXISTS idx_oauth_pending_fb_expires ON public.oauth_pending_facebook_selections (expires_at);
```

**Not executed automatically.** Report and wait for owner to run.

### Phase C — Frontend (`src/hooks/oauth/useFacebookOAuth.ts`)

Add, do not remove:

1. New exported function `handleFacebookConnectBackend(targetPlatform, profileId)`:
   - Invoke `facebook-oauth { action: "authorize", target_platform, social_profile_id: profileId, return_to: \`${origin}/profiles\` }`.
   - `window.location.assign(data.url)`.
2. Keep `handleFacebookConnect` (FB SDK path) unchanged as legacy.
3. New exported `loadPendingSelection(selectionId)` → POST `action: "get_pending_selection"`. Hydrates `pageSelectionData` shape (with `selectionId` instead of `providerToken`).
4. `handleSelectPage` / `handleSelectStandaloneInstagram`: accept either `selectionId` or `providerToken` — when `selectionId` present, send it instead of `provider_token`.
5. `src/hooks/oauth/useOAuthRedirectHandler.ts`: when URL has `?connected=facebook&select=<id>`, call `loadPendingSelection(id)` and clean the query string.

Frontend selection strategy: callers (Connect button UI) will keep calling `handleFacebookConnect` (legacy SDK) by default; a new opt-in entry point exposes `handleFacebookConnectBackend`. Switching the default happens in a later turn after production logs confirm the new path is healthy.

### Phase D — Instagram Business dependency

`instagram-business-oauth` already has its own unified flow (verified in earlier audit). The Facebook migration does not touch it. After Phase A, I will:

- Re-read `instagram-business-oauth/index.ts` to confirm it does not call back into `facebook-oauth` POST actions.
- If it shares page-enumeration logic, leave the duplication in place rather than risk a refactor in this turn.

### Phase E — Env & docs

Append to `.env.example` (no real values, no inline comments) if missing:

```
FACEBOOK_REDIRECT_URI=https://api.postora.cloud/functions/v1/facebook-oauth
```

`FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `OAUTH_STATE_SECRET` already documented elsewhere — verify presence and add only if missing.

### Phase F — Validation

```
bunx tsgo --noEmit
git diff --check
grep -RnE "\.supabase\.co/functions/v1|efruibswazzuuupgyzmf|supabase\.postora\.cloud" src supabase scripts --exclude-dir=node_modules
grep -n "provider_token" src/hooks/oauth/useFacebookOAuth.ts supabase/functions/facebook-oauth/index.ts supabase/functions/instagram-business-oauth/index.ts
```

Acceptable: `provider_token` remains in clearly-marked legacy branches in both the hook and the edge function.

### Phase G — Guard reviews

- CleanCodeGuard on `facebook-oauth/index.ts` and `useFacebookOAuth.ts`.
- TestGuard: no test files changed; no test-code review required.

### Phase H — Manual actions (in final report)

- Add Meta Facebook Login → Valid OAuth Redirect URIs: `https://api.postora.cloud/functions/v1/facebook-oauth`. Keep existing entries for 24–48h.
- Confirm scopes still cover: `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `pages_manage_engagement`, `pages_read_user_content`, `business_management`, `pages_manage_metadata`, `pages_messaging`, `read_insights`, `instagram_basic`, `instagram_content_publish`, `instagram_manage_comments`, `instagram_manage_messages`, `whatsapp_business_messaging`, `whatsapp_business_management`, `ads_read`, `ads_management`, `leads_retrieval`, `pages_manage_ads`.
- Run the manual SQL script in step Phase B.
- Redeploy `facebook-oauth` edge function.
- After production verifies backend path, future task: switch default UI entry to `handleFacebookConnectBackend` and remove legacy SDK path.

### Out of scope

- Removing the FB JS SDK flow (kept for fallback).
- Touching Supabase Auth user login.
- `instagram-business-oauth` refactor.
- `n8n-api`.
- Running the SQL.
- Switching default frontend connect entry (separate cutover task).

### Expected final status

`blocked pending manual SQL` until owner runs the SQL script and redeploys the function. Code changes themselves will be `completed` with documented exception (legacy SDK path preserved).
