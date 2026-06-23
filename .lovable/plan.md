
# Facebook OAuth Backend Callback — Post-SQL Readiness Report

Verification-only task. No code changes required. Plan-mode delivery doubles as the final report.

## 1. Summary

Manual SQL was executed by the owner. Code paths in `facebook-oauth/index.ts`, `useFacebookOAuth.ts`, and `useOAuthRedirectHandler.ts` are consistent with the new table and the previously-applied CleanCodeGuard fixes. Greps confirm legacy `.supabase.co` references live only in historical migrations and the regression test that polices them.

## 2. Manual SQL verification

Source of truth: `supabase/manual-sql/20260623_facebook_pending_selections.sql` (already executed; "Success. No rows returned").

Expected schema (as authored):
- Table `public.oauth_pending_facebook_selections` — columns: `id, user_id, social_profile_id, target_platform, provider_token, pages_json, ig_standalone_json, created_at, expires_at`.
- `target_platform CHECK IN ('facebook','instagram')`.
- `GRANT SELECT … TO authenticated` and `GRANT ALL … TO service_role` (no `anon` grant).
- `ENABLE ROW LEVEL SECURITY` + policy `"own pending fb selection read"` (SELECT only, `user_id = auth.uid()`).
- Index `idx_oauth_pending_fb_expires` on `expires_at`.
- One-shot `DELETE … WHERE expires_at < now()` sweep at the bottom.

Sensitive-token exposure: `provider_token` is selected ONLY inside the service-role client in `loadPendingSelectionRow` (edge function L321–L340). The `get_pending_selection` POST response (L587–L593) returns `pages`, `standalone_instagram`, `social_profile_id`, `target_platform` — **no token field**. RLS gives `authenticated` SELECT, but there is no `INSERT/UPDATE/DELETE` grant to `authenticated`, so a logged-in user can read row metadata of *their own* row but cannot write/mint one. Acceptable, because the row only exists for ~15 min after the GET callback the user initiated.

Recommendation (not blocking): the owner may optionally tighten further by dropping `SELECT` on `provider_token` from the `authenticated` grant via a column-level grant, since the frontend never needs it. Filed as a follow-up below.

**Verdict:** table is usable and safe. No new SQL required.

## 3. Facebook backend callback readiness

Checked against `supabase/functions/facebook-oauth/index.ts`:

- POST `authorize` (L553–L575): mints signed state via `createOAuthState`, returns Meta v22.0 authorize URL with `FACEBOOK_REDIRECT_URI`. ✅
- GET handler `handleFacebookGetCallback` (L342–L454): verifies state, exchanges code at Graph v22.0, upgrades to long-lived user token, enumerates pages + standalone IG, inserts a pending selection row, 302s to `{return_to}?connected=facebook&select=<id>`. `safeReturnTo` enforces `*.postora.cloud` so the default is `https://postora.cloud/profiles`. ✅
- `get_pending_selection` returns only safe metadata (no token). ✅
- `store_page` / `store_instagram` accept either `selection_id` or legacy `provider_token`; selection branch reads the token via service-role and **deletes the row on success** (L771–L773 and L1026–L1028). ✅
- Legacy `store_account` / `list_pages` branches remain intact for the FB JS SDK fallback. ✅
- Frontend handoff in `useOAuthRedirectHandler.ts` L101–L117 calls `loadPendingFacebookSelection(selectionId)` when `?connected=facebook&select=…` is present. ✅

**Verdict:** backend callback is ready for edge redeploy + provider console update.

## 4. Files changed

None. Verification-only pass.

## 5. Database changes

Manual SQL already executed by project owner. No new SQL required.

## 6. Validation results

Greps executed (read-only):

- `rg "facebook-oauth" src supabase` — only expected refs (function, hook, tests, `oauthRedirects` map).
- `rg "oauth_pending_facebook_selections" src supabase` — only the SQL file and the four edge-function call sites (load, insert, two deletes).
- `rg "provider_token" src/hooks/oauth/useFacebookOAuth.ts supabase/functions/facebook-oauth supabase/functions/instagram-business-oauth` — all hits are in marked legacy compatibility branches or the service-role selection reader. Instagram Business function only mentions it in a header comment explaining the split.
- `rg "\.supabase\.co/functions/v1|efruibswazzuuupgyzmf|supabase\.postora\.cloud" src supabase` — hits limited to `supabase/migrations/*.sql` (historical, allowed) and `src/integrations/__tests__/supabaseClient.test.ts` (regression test asserting the string is *absent* from the client). No live code refs.
- `git diff --check`: not run (no edits this turn).
- `typecheck` / `lint` / `build` / `vitest`: not run (no code changed; previous turn already passed typecheck). Reportable as "not_tested" for this verification pass.

## 7. Runtime env (masked)

| Var | Status |
|---|---|
| `FACEBOOK_APP_ID` | not_tested (owner-managed) |
| `FACEBOOK_APP_SECRET` | not_tested (owner-managed) |
| `FACEBOOK_REDIRECT_URI` | optional — code falls back to `${SUPABASE_URL}/functions/v1/facebook-oauth`, else `https://api.postora.cloud/functions/v1/facebook-oauth`. Set explicitly for clarity. |
| `OAUTH_STATE_SECRET` | required by `_shared/oauthState.ts`; not_tested here. |
| `SUPABASE_URL` | required; not_tested. |
| `SUPABASE_SERVICE_ROLE_KEY` | required; not_tested. |

No secret values inspected or printed.

## 8. Guard review results

- **CleanCodeGuard:** Pre-existing findings 1, 2, 4, 5 already addressed in the previous turn. Remaining follow-ups (legacy SDK deprecation marker, scope-list DRY, `safeReturnTo` localhost allowance, file split at 1051 LoC) are non-blocking. No new violations introduced this turn (no code changes).
- **TestGuard:** No test files changed; no test-code review required.

## 9. Security / secrets check

No secrets read, logged, or committed. `provider_token` is never returned from `get_pending_selection`; service-role-only read path confirmed.

## 10. Manual actions required

1. **Edge function redeploy** — redeploy `facebook-oauth` so the GET callback + `authorize`/`get_pending_selection` actions are live.
2. **Meta provider console** — add `https://api.postora.cloud/functions/v1/facebook-oauth` to Facebook Login → Valid OAuth Redirect URIs. Keep `https://postora.cloud/profiles` as the legacy entry.
3. **Env confirmation** on the edge runtime — ensure `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `OAUTH_STATE_SECRET`, `FACEBOOK_REDIRECT_URI` are set.
4. **Backend callback smoke test** (after redeploy):
   - Trigger `handleFacebookConnectBackend(...)` from `/profiles`, complete Meta consent, confirm 302 lands on `/profiles?connected=facebook&select=<uuid>` and the page picker hydrates with pages but no token field.
   - Confirm `store_page` deletes the pending row.
5. **Instagram Business regression** — connect an IG Business account via the existing dedicated flow; confirm unaffected.
6. **Legacy redirect retirement** — only after 24–48h of clean GET callback logs + successful Pages + IG Business tests, remove `https://postora.cloud/profiles` from the Meta redirect list.
7. **Optional follow-ups (non-blocking):**
   - Column-level revoke of `provider_token` SELECT from `authenticated` (new manual SQL).
   - Add `pg_cron` schedule for the expired-row sweep (template already inlined in the SQL script).
   - Add deprecation marker on the legacy FB JS SDK path in `useFacebookOAuth.ts`.

## 11. Final status

**ready_for_provider_console_update** → then **ready_for_backend_callback_test** after Meta redirect URI is saved and the edge function is redeployed.

Used the clean-code-guard and test-guard skills.
