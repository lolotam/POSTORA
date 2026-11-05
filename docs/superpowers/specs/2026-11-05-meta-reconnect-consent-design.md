# Meta reconnect consent: show the permission screen again on Instagram, Facebook and Threads reconnects

Date: 2026-11-05. Status: design, awaiting owner review.

## 1. Goal

After an owner disconnects an Instagram, Facebook Page or Threads account in Postora and connects it again, the provider's permission screen must appear again so the owner can review and change the granted permissions. TikTok already behaves this way (branch `ccr-f0848f64-lbmmrr`: `disable_auto_auth=1` on the authorize URL and a token revoke on Disconnect through `_shared/tiktokRevoke.ts`). This design brings Facebook Login, Instagram Login and Threads as close to that as each provider allows.

Completion criterion: Disconnect then Connect of a Facebook Page, a Page-linked Instagram account and a direct-login Instagram account shows the provider's permission list again; a Threads reconnect shows the permissions Postora holds inside the app, because Threads offers nothing else; no sibling account loses its token because of a Disconnect.

## 2. Non-goals

- Changing which permissions Postora requests.
- Changing the dashboard Disconnect (`useDisconnectAccount`, `is_active=false` only); only the Profiles-page Disconnect (`useDisconnectAccountFromProfile`, row delete) is in scope, the same surface the TikTok fix used.
- Re-asking automatically when Meta reports a missing permission; this stays an owner-initiated reconnect.
- Any change to the protected OAuth attempt lifecycle (`meta_oauth_attempts`, `commit_meta_oauth_selection`).

## 3. What each provider offers (verified 2026-11-05)

| Provider | Authorize parameter that re-shows consent | Revoke endpoint | Verified how |
|---|---|---|---|
| Facebook Login (`facebook-oauth`, `instagram-business-oauth`) | `auth_type=rerequest` re-asks permissions the person declined; the dialog is shown again instead of being skipped. `auth_type=reauthenticate` forces a password re-entry and is not wanted. | `DELETE /{facebook-user-id}/permissions` with a user token or the app access token de-authorizes the app: every user access token of that Facebook user is invalidated and the next login asks "as if logging in for the first time". | Meta docs: Facebook Login › Permissions › Requesting & Revoking; Facebook Login › Web › Permissions (rerequest). |
| Instagram Login, direct (`instagram-oauth`) | `force_reauth=true` forces the person to enter their Instagram credentials again. Whether the permission list is shown again after that is not documented; it is the only lever the window has. | None documented. A developer-forum report says the Facebook-style `DELETE …/permissions` fails with "Unsupported delete request" under Instagram Login. | Meta docs: Instagram Platform › Instagram API with Instagram Login › Business Login (parameter table). |
| Threads (`threads-oauth`) | None. The window takes only `client_id`, `redirect_uri`, `response_type`, `scope`, `state`. | None. Spike on the pilot token: `GET /v1.0/me/permissions` → HTTP 500 `THApiException` code 100 "Tried accessing nonexisting field (permissions)"; `DELETE /v1.0/me/permissions` → HTTP 400 code 100 subcode 33 "Unsupported delete request"; the token stayed valid. | Meta docs: Threads › Get access tokens and permissions; live spike. |

Consequence: the existing `/me/permissions` probe in `threads-oauth/index.ts` (lines 130–145) can never succeed and is dead code.

## 4. Design

### 4.1 Facebook Login flows: `auth_type=rerequest` on every authorize URL

Files: `supabase/functions/facebook-oauth/index.ts` (both the protected and the legacy authorize URL, lines ~966 and ~986), `supabase/functions/instagram-business-oauth/index.ts` (line ~902).

Add `auth_type=rerequest` to the `dialog/oauth` URL for `connect` and `reconnect` alike. Meta's own guidance is to re-ask at most once after an education screen; a reconnect the owner starts is that case. No new setting or flag: the behaviour is the same for every caller.

### 4.2 Direct Instagram Login: `force_reauth=true`

File: `supabase/functions/instagram-oauth/index.ts` (line ~745).

Add `force_reauth=true` to `https://www.instagram.com/oauth/authorize`. This guarantees a fresh login; the permission list after it is Meta's decision. The live journey (section 7) records what the window actually shows, and the result is written into this document.

### 4.3 Disconnect: de-authorize the app only when the last grant member goes

New action `disconnect` in `supabase/functions/facebook-oauth/index.ts`, shaped like `tiktok-oauth`'s `disconnect` (authenticate the caller, validate the UUID, scope every read to the caller's `user_id`, log every refusal and every failed revoke to `system_logs` with `source: "facebook-oauth"`, best effort, never block the removal).

Rule, evaluated inside the action:

1. Load the account's binding from `facebook_user_credential_bindings` (platform `facebook` or `instagram`). No binding (legacy account, direct Instagram login) → nothing to revoke; return `{ success: true, revoked: false, reason: "no_binding" }`.
2. Count the bindings that share the same `credential_id`. More than one → the Facebook user grant is shared by a sibling account (Page + Instagram + WhatsApp on one login). Return `{ success: true, revoked: false, reason: "grant_shared" }`. The sibling keeps working; the next reconnect of this account still shows the dialog because of 4.1.
3. Exactly one → this account is the last member. Call `DELETE https://graph.facebook.com/v22.0/{provider_user_id}/permissions` with the **app access token** (`{app_id}|{app_secret}`). `provider_user_id` comes from `facebook_user_credentials`; the stored user token is never read for this call. Success is the body `true`.
4. Return `{ success: true, revoked }`. The frontend then deletes the `social_accounts` row as today; the `AFTER DELETE` trigger from `20261105120000_social_account_disconnect_credential_trigger.sql` purges the binding and the orphaned credential.

Why the app token: it needs no secret from the database, it works even when the user token already expired, and it keeps the revoke independent of the token-refresh state of the account.

Why not revoke on every disconnect (option C, rejected): one Facebook user grant backs several Postora accounts; de-authorizing it on a single Page's removal would silently break the sibling accounts' tokens.

Frontend: `useDisconnectAccountFromProfile` in `src/hooks/useSocialProfiles.tsx` gains a branch for `platform IN ('facebook', 'instagram')` that invokes `facebook-oauth` `{ action: "disconnect", social_account_id }` before the delete, mirroring the TikTok branch. The direct-login Instagram account has no binding and returns `no_binding`; the call is still made so one code path covers both Instagram kinds.

### 4.4 Threads: show what Postora holds

No provider change is possible. The Threads account row on the Profiles page (`src/components/profiles/ProfileRow.tsx`, which today has no permission element for Threads) gets a small "Permissions" popover listing `account_metadata.granted_scopes`. The callback already writes that list: the `permissions` field of the token response plus the capability probes (`threads-oauth/index.ts`, `accountMetadata.granted_scopes`, line ~268). The popover text: "Threads does not offer a permission review on reconnect; these are the permissions Postora holds. Remove the app under Threads › Settings › Security › Apps and websites to withdraw them." The `/me/permissions` probe (lines ~126–145), which can never succeed, is removed; the token-reported `permissions` path stays.

### 4.5 What is deliberately unchanged

- The Dashboard Disconnect (`useDisconnectAccount`) keeps setting `is_active=false`; it never revoked for TikTok either.
- The protected attempt lifecycle, the candidate stash and `commit_meta_oauth_selection` are untouched; the authorize URL parameters sit outside the captured state.

## 5. Security and data rules

- The revoke call carries the app access token only; no user token leaves the database for it and nothing is logged beyond the account id, the credential id and the outcome.
- Every refusal and every failed revoke writes a `system_logs` row (source `facebook-oauth`, category `auth`), as the TikTok action does.
- Ownership: the action reads the account, binding and credential with `user_id = caller.userId` even under the service role.

## 6. Testing

- `facebook-oauth`: Deno tests for the `disconnect` action through the real handler with a mocked fetch: no binding → `no_binding`; shared grant (two bindings) → `grant_shared` and **no** Graph call; last member → one `DELETE /{provider_user_id}/permissions` with the app token and `revoked: true`; Graph failure → `revoked: false`, a `system_logs` row, HTTP 200.
- `facebook-oauth`, `instagram-business-oauth`, `instagram-oauth`: the authorize URL tests assert `auth_type=rerequest` / `force_reauth=true` for `connect` and `reconnect`.
- `threads-oauth`: the probe removal has no behaviour to test; the existing callback tests stay green.
- Frontend: `useDisconnectAccountFromProfile` test that a Facebook or Instagram account calls `facebook-oauth` `disconnect` before the delete and that a revoke error does not stop the delete.
- SQL: none; no migration.

## 7. Live journeys (owner, after deploy)

1. Facebook Page: Disconnect `Xsellpoint` (its grant has one member) → `system_logs` shows no failure → Connect → the Facebook dialog lists the permissions again → both alternatives of PR #380 appear → choose.
2. Page-linked Instagram as a sibling: connect Page + Instagram, disconnect only the Instagram → `grant_shared`, the Page keeps posting → Connect Instagram → dialog shown by `rerequest`.
3. Direct Instagram login: Disconnect → Connect → record whether the permission list appears after `force_reauth`; write the answer into section 3.
4. Threads: Disconnect → Connect → no dialog (expected); the permission popover shows the held scopes and the Threads settings path.

## 8. Owner decisions already taken

- Approach A (rerequest / force_reauth plus last-member revoke) — card 2026-11-05.
- Threads spike approved and run; outcome in section 3.
- Branch: `main` only.
