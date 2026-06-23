
# Facebook OAuth Backend Callback — Activation Checklist

Plan = activation checklist + one tiny new file. After approval I will create the delta SQL file in build mode; no code edits are needed.

## 1. Summary

The full SQL script `supabase/manual-sql/20260623_facebook_pending_selections.sql` is entirely idempotent (`CREATE TABLE IF NOT EXISTS`, `DROP POLICY IF EXISTS` + `CREATE POLICY`, `CREATE INDEX IF NOT EXISTS`, trailing `DELETE … WHERE expires_at < now()`) so re-running it is safe. To minimize blast radius the owner only needs the *new* trailing cleanup statement and the optional pg_cron schedule, packaged as a small delta file.

## 2. Manual SQL status

- Original 32-line script: **already applied** by owner ("Success. No rows returned").
- New trailing section (one-shot expired-row `DELETE` + pg_cron comment template) added during the CleanCodeGuard fix: **needs delta SQL only**.
- Recommended: create `supabase/manual-sql/20260623_facebook_pending_selections_cleanup_delta.sql` with the content below; owner reviews and runs.

**DATABASE ACTION REQUIRED:** delta SQL review/run before treating the activation as fully complete. The backend callback will function without it — the delta only adds maintenance hygiene.

Delta file content (to be created in build mode):

```sql
-- Purpose: cleanup/maintenance follow-up for oauth_pending_facebook_selections.
-- Type: data (DELETE) + optional pg_cron schedule. Safe to re-run.
-- Depends on: 20260623_facebook_pending_selections.sql (already applied).
-- Rollback: SELECT cron.unschedule('oauth_pending_fb_sweep'); -- only if scheduled.
--
-- Reviewed by: Postora owner before execution.
-- This script is NOT executed automatically.

-- 1. One-shot sweep of any already-expired rows.
DELETE FROM public.oauth_pending_facebook_selections
WHERE expires_at < now();

-- 2. (Optional) Schedule a recurring sweep every 15 minutes via pg_cron.
--    Uncomment after confirming pg_cron is enabled in this project.
-- SELECT cron.schedule(
--   'oauth_pending_fb_sweep',
--   '*/15 * * * *',
--   $$DELETE FROM public.oauth_pending_facebook_selections WHERE expires_at < now()$$
-- );
```

## 3. Facebook provider console status

Manual — still required. Owner must add to Meta → Facebook Login → Valid OAuth Redirect URIs:

- `https://api.postora.cloud/functions/v1/facebook-oauth` (new, backend callback)
- Keep `https://postora.cloud/profiles` (legacy SDK fallback) until retirement criteria are met (24–48h clean logs + Pages test pass + IG Business regression pass).

## 4. Edge redeploy status

Ready for redeploy of `facebook-oauth` once:

1. Delta SQL is acknowledged (not strictly blocking).
2. Edge runtime env present: `FACEBOOK_APP_ID`, `FACEBOOK_APP_SECRET`, `FACEBOOK_REDIRECT_URI=https://api.postora.cloud/functions/v1/facebook-oauth`, `OAUTH_STATE_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Reported as masked status only:

| Var | Status |
|---|---|
| `FACEBOOK_APP_ID` | not_tested |
| `FACEBOOK_APP_SECRET` | not_tested |
| `FACEBOOK_REDIRECT_URI` | optional (code falls back to `${SUPABASE_URL}/functions/v1/facebook-oauth`) |
| `OAUTH_STATE_SECRET` | required, not_tested |
| `SUPABASE_URL` | required, not_tested |
| `SUPABASE_SERVICE_ROLE_KEY` | required, not_tested |

No values inspected or logged.

## 5. Safe smoke test after deploy

After redeploy, owner-runnable, no real OAuth completion:

1. `curl -i -X OPTIONS https://api.postora.cloud/functions/v1/facebook-oauth -H 'Origin: https://postora.cloud' -H 'Access-Control-Request-Method: POST'` → expect `200/204` + `Access-Control-Allow-Origin: *`.
2. `curl -i -X POST https://api.postora.cloud/functions/v1/facebook-oauth -H 'Content-Type: application/json' -d '{}'` → expect `401 Unauthorized` (no bearer).
3. With an authenticated session bearer, POST `{"action":"authorize","target_platform":"facebook","social_profile_id":"<test-profile-uuid>","return_to":"https://postora.cloud/profiles"}` → response must:
   - contain `success:true` and a `url`,
   - `url` host = `www.facebook.com`,
   - `redirect_uri` query param = `https://api.postora.cloud/functions/v1/facebook-oauth`,
   - `state` query param is present and non-trivial (signed).
4. STOP here — do not complete real Meta consent unless owner explicitly approves the full backend-callback test (Phase 6 below).

## 6. Backend callback end-to-end test (owner-approved only)

1. From `/profiles`, trigger Connect Facebook via `handleFacebookConnectBackend` (backend path).
2. Complete Meta consent with a safe test FB account.
3. Confirm browser lands on `https://postora.cloud/profiles?connected=facebook&select=<uuid>`.
4. Confirm page picker hydrates (pages + standalone IG) — response from `get_pending_selection` must NOT contain `provider_token`.
5. Select one test Page → `store_page` request uses `selection_id` (not `provider_token`).
6. Verify in DB: the matching row in `oauth_pending_facebook_selections` is gone after success.
7. Confirm the connected Page appears in Profiles.
8. Regression: connect an Instagram Business account via the existing dedicated flow; confirm unaffected.

## 7. Files to be changed (build mode)

- `supabase/manual-sql/20260623_facebook_pending_selections_cleanup_delta.sql` — new delta SQL file (content above).

No production code or test changes.

## 8. Validation results

- `rg "facebook-oauth" src supabase`: only expected refs.
- `rg "oauth_pending_facebook_selections" src supabase`: only the SQL file + the four edge-function call sites (load, insert, two deletes).
- `rg "provider_token" src/hooks/oauth/useFacebookOAuth.ts supabase/functions/facebook-oauth supabase/functions/instagram-business-oauth`: all hits in marked legacy branches or the service-role selection reader.
- `rg "\.supabase\.co/functions/v1|efruibswazzuuupgyzmf|supabase\.postora\.cloud" src supabase`: hits limited to historical `supabase/migrations/*.sql` and the regression test that asserts these strings are *absent* from the live client. No live-code refs.
- `typecheck` / `lint` / `build` / `vitest`: not_tested (no production code changes this turn).
- `git diff --check`: not run.

## 9. Guard review results

- **CleanCodeGuard:** SQL-only delta; no production code changed. Existing edge function and hooks already cleared the prior pass. No new violations.
- **TestGuard:** no test files changed; no test-code review required.

## 10. Security / secrets check

No secrets read, printed, logged, or committed. `provider_token` continues to leave the database only via service-role context; `get_pending_selection` never returns it.

## 11. Final status

**ready_for_provider_console_update** → **ready_for_edge_redeploy** → **ready_for_backend_callback_test**. The delta SQL is a non-blocking maintenance follow-up; the backend callback is functionally usable today.

Used the clean-code-guard and test-guard skills.
