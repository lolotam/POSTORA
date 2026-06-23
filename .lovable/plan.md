## YouTube/Google + WhatsApp OAuth Finalization

### Audit results (current vs target)

**YouTube/Google — `supabase/functions/youtube-oauth/index.ts`**

| Item | Current | Target | Action |
|---|---|---|---|
| Endpoint | `…/functions/v1/youtube-oauth` | same | ok |
| Redirect URI | Hardcoded `https://api.postora.cloud/functions/v1/youtube-oauth` | env-driven with fallback | **fix** |
| State | HMAC-signed with `GOOGLE_CLIENT_SECRET` | signed | ok |
| GET callback | Implemented, exchanges code server-side, 302 to `/profiles?connected=youtube` | same | ok |
| Refresh | `action: "refresh"`, preserves refresh_token | same | ok |
| Frontend supplies redirect_uri | Yes, in legacy `handleYouTubeCallback` POST shim | No | **fix (hook)** |
| Frontend supplies user_id at authorize | Yes (backend trusts it) | derive from JWT | **fix (minimal)** |
| Old Supabase cloud refs | None in live code | none | ok |

**WhatsApp — `supabase/functions/whatsapp-oauth/index.ts`**

| Item | Current | Target | Decision |
|---|---|---|---|
| Endpoint | `…/functions/v1/whatsapp-oauth` | same | ok |
| Flow type | Meta **Embedded Signup** (FB JS SDK → `signup.code`, no provider redirect URI) | not a normal OAuth redirect | **document, do not force** |
| Token exchange | Server-side `GRAPH_API/oauth/access_token` with `FACEBOOK_APP_ID`/`SECRET` | server-side | ok |
| Auth | Authenticates caller via Supabase JWT, uses service role for writes | server-side | ok |
| Webhook verify | `WHATSAPP_WEBHOOK_VERIFY_TOKEN` + HMAC signature on POST | same | ok |
| Config test | Reports missing config cleanly | same | ok |
| Disconnect | `action: "disconnect"`, best-effort `subscribed_apps` unsubscribe | same | ok |
| Real sends | None during audit | none | ok |

### Changes

**1. `supabase/functions/youtube-oauth/index.ts`**
- Replace constant `YOUTUBE_REDIRECT_URI` with env-driven resolver:
  ```ts
  const YOUTUBE_REDIRECT_URI =
    Deno.env.get("YOUTUBE_REDIRECT_URI") ??
    (SUPABASE_URL ? `${SUPABASE_URL}/functions/v1/youtube-oauth`
                  : "https://api.postora.cloud/functions/v1/youtube-oauth");
  ```
- In `action: "authorize"`, derive `user_id` from the caller's JWT via `authenticateCaller(req, body?.user_id)` (same helper already used by the legacy POST `callback`); keep `social_profile_id` and `return_to` from body.
- No changes to scopes, token exchange, refresh, channel discovery, DB upsert, or GET callback shape.

**2. `src/hooks/oauth/useYouTubeOAuth.ts`**
- `handleYouTubeConnect`: stop sending `user_id` (JWT carries identity); keep `social_profile_id`, `return_to`. Set `setConnectingPlatform("youtube")` + `setConnectingProfile(profileId)` at start; clear on error.
- `handleYouTubeCallback` (legacy POST shim): stop sending `redirect_uri` and `user_id`; keep `code` + `social_profile_id` for in-flight sessions.

**3. `.env.example`**
- Add `YOUTUBE_REDIRECT_URI=https://api.postora.cloud/functions/v1/youtube-oauth` under the existing YouTube/Google block. No real secrets, no inline comments. WhatsApp block already present and complete.

**4. WhatsApp**
- **No code changes.** Embedded Signup uses Meta's FB JS SDK callback (`FB.login` → `signup.code`) and does **not** use a normal OAuth `redirect_uri`. The backend endpoint `whatsapp-oauth` already owns token exchange, webhook subscription, and phone registration server-side. This is documented as a permanent architectural exception alongside Facebook.

### Out of scope
- `supabase/functions/n8n-api` (untouched).
- `facebook-oauth` (existing documented exception).
- WhatsApp webhook signature / verify-token logic (already correct).
- DB schema / data — no changes.
- Swapping local HMAC signer for `_shared/oauthState.ts` (functionally equivalent; would invalidate in-flight signed states).

### Validation
- `bunx tsgo --noEmit`
- `rg "youtube-oauth|whatsapp-oauth|whatsapp-webhook" src supabase`
- `rg "\.supabase\.co/functions/v1|efruibswazzuuupgyzmf|supabase\.postora\.cloud" src supabase` — expect zero hits in live code.

### Manual actions (final report)
- **Google Cloud Console**: confirm authorized redirect URI `https://api.postora.cloud/functions/v1/youtube-oauth`; confirm OAuth consent scopes (`https://www.googleapis.com/auth/youtube`); confirm app status / test users; ensure runtime env has `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and optionally `YOUTUBE_REDIRECT_URI`.
- **Meta / WhatsApp**: webhook callback `https://api.postora.cloud/functions/v1/whatsapp-webhook`, verify token must match `WHATSAPP_WEBHOOK_VERIFY_TOKEN`, confirm Embedded Signup configuration IDs (`wa_cloud_api_config_id`, `wa_coexistence_config_id`) belong to the same Meta App as `FACEBOOK_APP_ID`/`SECRET`, runtime env has WhatsApp secrets.
