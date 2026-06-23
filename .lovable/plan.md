## Reddit + Bluesky OAuth Finalization

### Audit results (current vs target)

**Reddit — `supabase/functions/reddit-oauth/index.ts`**

| Item | Current | Target | Action |
|---|---|---|---|
| Endpoint name | `reddit-oauth` (lowercase) | same | ok |
| Redirect URI | env `REDDIT_REDIRECT_URI` → `${SUPABASE_URL}/functions/v1/reddit-oauth` | same | ok |
| Signed state (HMAC) via `_shared/oauthState.ts` carrying `profile_id`/`return_to` | yes | yes | ok |
| GET callback exchanges code server-side, 302 to `return_to?connected=reddit` | yes | yes | ok |
| Frontend sends `redirect_uri` + `user_id` at authorize | **yes** (with `profile_id` in legacy `/profiles?platform=reddit&profile_id=…`) | no | **fix (hook)** |
| Frontend POST `callback` shim still wires `redirect_uri` + `user_id` | yes | minimal compat | **fix (hook)** |
| Old Supabase cloud refs | none in live code | none | ok |

**Bluesky — `supabase/functions/bluesky-oauth/index.ts`**

| Item | Current | Target | Action |
|---|---|---|---|
| Endpoint name | `bluesky-oauth` | same | ok |
| `CLIENT_ID` is metadata URL `https://postora.cloud/client-metadata.json` | yes | yes (ATProto identity) | ok |
| `redirect_uri` used in authorize/token | `redirect_uri \|\| "https://postora.cloud/profiles"` — frontend route, not backend | backend Edge Function URL | **fix** |
| GET callback handler in edge function | **missing** (only POST `action: "callback"` invoked by frontend after redirect to `/profiles`) | present | **add** |
| State already carries `user_id`, `social_profile_id`, `handle`, `code_verifier`, DPoP keys (base64-encoded JSON) | yes | yes (preserve as-is — PKCE/DPoP intact) | ok |
| Token exchange + DB upsert server-side | yes | yes | ok |
| `public/client-metadata.json` includes backend URL | yes (entry already present alongside `/profiles` + Lovable preview) | yes | ok |
| Frontend sends `redirect_uri` + `user_id` | yes | no | **fix (hook)** |
| Old Supabase cloud refs | none | none | ok |

### Changes

**1. `src/hooks/oauth/useRedditOAuth.ts`**
- `handleRedditConnect`: stop sending `user_id` and `redirect_uri`; keep `social_profile_id` + `return_to: ${origin}/profiles`. Move `setConnectingPlatform("reddit")`/`setConnectingProfile(profileId)` to start, clear on error.
- `handleRedditCallback` (legacy POST shim): stop sending `redirect_uri` and `user_id`; keep `code` + `social_profile_id` for in-flight sessions.

**2. `supabase/functions/bluesky-oauth/index.ts`**
- Add module constant:
  ```ts
  const BLUESKY_REDIRECT_URI =
    Deno.env.get("BLUESKY_REDIRECT_URI") ??
    `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/bluesky-oauth`;
  ```
- In `action: "authorize"` and `action: "callback"`, replace `redirect_uri || "https://postora.cloud/profiles"` with `BLUESKY_REDIRECT_URI` (the body's `redirect_uri` is no longer trusted). The value must match an entry in `client-metadata.json` — the backend URL is already listed.
- Add a `GET` handler at the top of `Deno.serve`:
  - Parse `code` + `state` query params.
  - Reuse the existing callback logic (decode base64 state, discover token endpoint, DPoP-bound token exchange with nonce retry, profile fetch, DB upsert) by extracting it into a small `completeBlueskyCallback(code, state, supabase, logger)` helper, then invoking it.
  - On success, 302 to `${state.return_to ?? "https://postora.cloud/profiles"}?connected=bluesky` (+ `profile_id` if present).
  - On error, 302 to `https://postora.cloud/profiles?connected=bluesky&error=bluesky_callback_failed`.
- Extend state encoding to include `return_to` (default `"https://postora.cloud/profiles"`) so the GET handler can route back. Keep existing keys intact — pure additive change preserves any in-flight sessions.
- Keep `action: "callback"` POST path as legacy compat shim, refactored to call the same helper.
- No changes to PKCE generation, DPoP key generation/export/import, nonce retry, scope, or `account_metadata` shape.

**3. `src/hooks/oauth/useBlueskyOAuth.ts`**
- `handleBlueskyOAuthConnect`: stop sending `redirect_uri` and `user_id`; keep `handle` + `social_profile_id`. Remove the domain-warning toast (no longer relevant — backend owns redirect).
- `handleBlueskyOAuthCallback` (legacy POST shim): stop sending `redirect_uri`; keep `code` + `state` for in-flight sessions.
- `handleBlueskyConnect` (app-password flow): stop sending `user_id` (JWT verified backend-side by `authenticateCaller`).

**4. `public/client-metadata.json`**
- No changes. Backend URL `https://api.postora.cloud/functions/v1/bluesky-oauth` already listed. `/profiles` and Lovable preview entries stay for legacy/preview support and will be retired once backend cutover is verified.

**5. `.env.example`**
- Add a Reddit + Bluesky block:
  ```
  REDDIT_CLIENT_ID=
  REDDIT_CLIENT_SECRET=
  REDDIT_REDIRECT_URI=https://api.postora.cloud/functions/v1/reddit-oauth

  BLUESKY_REDIRECT_URI=https://api.postora.cloud/functions/v1/bluesky-oauth
  ```
  (Bluesky's "client identity" is the metadata URL — no `BLUESKY_CLIENT_ID`/`SECRET` env exists in code and none will be invented. `token_endpoint_auth_method` is `none`.)

### Out of scope
- `supabase/functions/n8n-api` (untouched).
- Bluesky `connect` (app-password) flow internals beyond dropping client `user_id`.
- Bluesky `refresh` and `get_lists` actions.
- Rotating signing keys or migrating Bluesky state to HMAC — current base64 state is integrity-bound by DPoP and the auth-server's code↔state pairing; rewriting it would invalidate in-flight sessions.
- DB schema/data — none.

### Validation
- `bunx tsgo --noEmit`
- `rg -n "reddit-oauth|bluesky-oauth|Reddit-oauth" src supabase public`
- `rg -n "profile_id=.*reddit" src supabase public`
- `rg -n "\.supabase\.co/functions/v1|efruibswazzuuupgyzmf|supabase\.postora\.cloud" src supabase public` — expect zero hits in live code.

### Manual actions (final report)
- **Reddit Developer Console**: confirm authorized redirect URI `https://api.postora.cloud/functions/v1/reddit-oauth`; remove the legacy `https://postora.cloud/profiles?platform=reddit&profile_id=…`-style URI after 24–48h of clean backend GET-callback logs; runtime env has `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` (optionally `REDDIT_REDIRECT_URI`); redeploy `reddit-oauth`.
- **Bluesky / ATProto**: confirm `https://postora.cloud/client-metadata.json` resolves in production with backend URL in `redirect_uris`; retire `/profiles` and Lovable-preview entries once the backend GET cutover is verified; runtime env optionally has `BLUESKY_REDIRECT_URI`; redeploy `bluesky-oauth`.
