# LinkedIn OAuth Finalization Audit

## Current state — already unified

Auditing the live code shows LinkedIn is already largely on the target architecture:

- **Single endpoint** `supabase/functions/linkedin-oauth/index.ts` handles both flows.
- **GET callback** at `/functions/v1/linkedin-oauth?code&state` is implemented and 302s back to `return_to?connected=linkedin&...`.
- **POST `authorize`** generates an HMAC-SHA256 signed state with `{ user_id, social_profile_id, return_to, flow }`, accepts `flow: "personal" | "organization"`, and grants member-only scopes for personal and member + org scopes for organization.
- **POST `callback`** kept as legacy compat shim.
- **POST `refresh`** exists for token refresh.
- **Backend-forced redirect_uri**: hardcoded `https://api.postora.cloud/functions/v1/linkedin-oauth` (frontend-supplied URI ignored — good, but not env-driven).
- **Org pages**: on connect we fetch `/v2/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED` and persist the list in `account_metadata.linkedin_pages` for use by posting UI.
- **Frontend**: `LinkedInConnectDialog` and `useLinkedInOAuth(profileId, flow)` already exist and are wired into `Profiles.tsx`. `n8n-api` not affected.

## Architecture decision

**Keep one endpoint** (`linkedin-oauth`). State carries `flow`, scopes are flow-aware, and org-page discovery already lives in the existing callback path. No justification exists to split into `linkedin-page-oauth`.

## Current vs Target — remaining gaps

| Area | Current | Target / Action |
|---|---|---|
| Redirect URI source | Hardcoded constant in `linkedin-oauth/index.ts` | Read from `LINKEDIN_REDIRECT_URI` env, default to `${SUPABASE_URL}/functions/v1/linkedin-oauth`. Document in `.env.example`. |
| State signer | Local HMAC keyed by `LINKEDIN_CLIENT_SECRET` | Keep local signer untouched to avoid invalidating in-flight sessions and breaking already-signed states; add a one-line comment noting the deliberate choice. (Migrating to `_shared/oauthState.ts` would invalidate signatures created by older deploys mid-flight; no functional gain — same HMAC-SHA256.) |
| Callback redirect param | `?connected=linkedin` for both flows | When state `flow === "organization"`, use `?connected=linkedin_organization`; keep `?connected=linkedin` for personal. Preserve existing `account_name` and `profile_id` params. |
| Hook return surface | `handleLinkedInConnect(profileId, flow)` only | Also expose `connectLinkedInPersonal(profileId)` and `connectLinkedInOrganization(profileId)` as thin aliases. Stop forwarding `user_id` (JWT already authoritative). Add `setConnectingPlatform/Profile` calls on start so UI button states match other providers. |
| `.env.example` | `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | Add `LINKEDIN_REDIRECT_URI=https://api.postora.cloud/functions/v1/linkedin-oauth`. (`OAUTH_STATE_SECRET` already in the file.) |
| Frontend dialog | Already exists with correct copy | No change required. |

## Files to change

1. `supabase/functions/linkedin-oauth/index.ts`
   - Replace hardcoded `LINKEDIN_REDIRECT_URI` constant with `Deno.env.get("LINKEDIN_REDIRECT_URI") ?? \`${SUPABASE_URL}/functions/v1/linkedin-oauth\``.
   - In GET callback, set `connected=linkedin_organization` when parsed state has `flow === "organization"`, otherwise `connected=linkedin`.
   - No changes to scopes, token handling, org-ACL fetching, or DB upsert shape.
2. `src/hooks/oauth/useLinkedInOAuth.ts`
   - Drop `user_id` from invoke body (JWT carries identity).
   - Set `setConnectingPlatform("linkedin")` + `setConnectingProfile(profileId)` at start of authorize; clear on error.
   - Add aliases `connectLinkedInPersonal` / `connectLinkedInOrganization`.
   - Keep `handleLinkedInCallback` as legacy shim.
3. `.env.example`
   - Add `LINKEDIN_REDIRECT_URI=https://api.postora.cloud/functions/v1/linkedin-oauth` in the LinkedIn block. No inline comments, no real values.

## Out of scope

- `n8n-api`, `n8n-community-node/`, `facebook-oauth`, posting logic in `process-post`.
- Any DB migration — `social_accounts.account_metadata.linkedin_pages` already accepts org list.
- Swapping the local HMAC signer for `_shared/oauthState.ts` (would invalidate in-flight signed states; functionally equivalent).

## Validation

- `bunx tsgo --noEmit`
- greps: `linkedin-page-oauth` (must be 0), `linkedin-oauth` (present), `.supabase.co/functions/v1` / `efruibswazzuuupgyzmf` / `supabase.postora.cloud` (none in live code).

## Manual provider actions

1. LinkedIn Developer Portal → Auth → Authorized redirect URLs: confirm `https://api.postora.cloud/functions/v1/linkedin-oauth` is registered.
2. Confirm products enabled for the required scopes:
   - Personal posting: `r_basicprofile`, `w_member_social`, `w_member_social_feed`, `r_member_postAnalytics`, `r_member_profileAnalytics`, `r_1st_connections_size` (Community Management API).
   - Organization posting: above plus `rw_organization_admin`, `r_organization_social`, `w_organization_social`, `r_organization_social_feed`, `w_organization_social_feed`, `r_organization_followers`.
3. If any legacy redirect URI was registered, keep it temporarily; remove after 24–48h of clean GET-callback logs.
4. Ensure runtime env has `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET`, `LINKEDIN_REDIRECT_URI`, `OAUTH_STATE_SECRET` (the last only used by other providers but already standardized).

## Final report

Will follow the required template (Summary / Architecture decision / Files / DB / Validation / Guards / Secrets / Manual / Status).
