# Backend API — Endpoint Classification Matrix

Source: backend automated test findings (this pass). Self-hosted Supabase at
`https://api.postora.cloud`. No SQL. No secrets printed. No auth weakening.

Fix-type legend:
- **true-defect** — real runtime crash or security bug in production code (must fix).
- **prod-fix** — production handler returns wrong status/shape for a documented error class.
- **harness** — failure is caused by the test harness (wrong/missing JWT, missing `apikey`, wrong project, expired token, missing admin role). No production change.
- **config** — server is missing a required env. No production code change; ship structured 503 `MISSING_CONFIG` and surface as operator action.
- **fixture** — test uses placeholder UUID / nonexistent media row. Update fixture, not production.
- **expectation** — test expects insecure or wrong outcome. Update the test.

Rows marked only `harness`, `config`, `fixture`, or `expectation` get **no code change** unless they also carry a real runtime/security defect.

| # | Endpoint | Expected auth | Required headers | Required env | Current result | Expected secure result | Fix type |
|---|---|---|---|---|---|---|---|
| 1 | `pinterest-boards` | user JWT (derive `user_id` from `sub`; admin may override via service role) | `Authorization: Bearer <jwt>`, `apikey` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | 500 `Unexpected end of JSON input` + trusted body `user_id` | 200 boards / 401 / 403 / 409 `ACCOUNT_NOT_CONNECTED` / 503 `PROVIDER_EMPTY_RESPONSE` | **true-defect** |
| 2 | `suggest-best-times` | user JWT (optional) | `Authorization`, `apikey` | `SUPABASE_URL`, AI gateway creds (via `ai-fallback`) | 500 `Cannot read properties of undefined (reading 'join')` | 400 `INVALID_BODY` / 200 suggestions | **true-defect** |
| 3 | `tiktok-check-status` | user JWT or service role | `Authorization`, `apikey` | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | 500 `Unexpected end of JSON input` on empty body | 400 `INVALID_JSON` / 400 `MISSING_PUBLISH_ID` / 200 status payload | **true-defect** |
| 4 | `ad-analytics` | user JWT | `Authorization`, `apikey` | — | 200 `{ok:false, message:"Unauthorized"}` on missing auth | 401 `UNAUTHORIZED` | **prod-fix** (status normalization) |
| 5 | `threads-keyword-search` | user JWT | `Authorization`, `apikey` | Threads provider creds | 200 with unauthorized body | 401 / 503 `MISSING_CONFIG` | **prod-fix** + **config** |
| 6 | `threads-delete-post` | user JWT | `Authorization`, `apikey` | Threads provider creds | 200 with unauthorized body | 401 / 503 `MISSING_CONFIG` | **prod-fix** + **config** |
| 7 | `tiktok-analytics` | user JWT | `Authorization`, `apikey` | TikTok creds | 401 with valid harness token | re-verify harness; if still failing, code-fix to use `_shared/auth-helper` | **harness** (verify first) |
| 8 | `ad-manager` | user JWT | `Authorization`, `apikey` | — | 401/403 | harness verify; preserve admin gate if any | **harness** |
| 9 | `analyze-log` | admin JWT | `Authorization`, `apikey` | — | 401/403 | 401 / 403 — admin only | **harness** (admin role seed) |
| 10 | `remove-background` | user JWT or `postora-` API key | `Authorization`, `apikey` (or `x-api-key`) | `ATLASCLOUD_API_KEY`, `OPENINARY_*` (Cloudinary only while the admin CDN policy writes to it) | 401/403 | harness verify; 503 `PROVIDER_UNAVAILABLE` when no AI provider is available | **harness** + **config** |
| 11 | `manage-app-secrets` | admin JWT | `Authorization`, `apikey` | — | 401/403 | 403 if not admin; **never** expose values | **harness** (admin), no code change |
| 12 | `unsplash-proxy` | user JWT | `Authorization`, `apikey` | `UNSPLASH_ACCESS_KEY` | 500 on missing key | 503 `MISSING_CONFIG service=unsplash` | **config** + **prod-fix** |
| 13 | `threads-oauth` (callback) | public callback (provider) | provider params | `THREADS_APP_ID/SECRET` | 500 on missing | 400 `INVALID_OAUTH_STATE` / 503 `MISSING_CONFIG` | **config** + **expectation** |
| 14 | `pinterest-oauth` (callback) | public callback | provider params | `PINTEREST_CLIENT_ID/SECRET` | 500 on missing | 400 / 503 `MISSING_CONFIG` | **config** + **expectation** |
| 15 | `tiktok-oauth` (callback) | public callback | provider params | `TIKTOK_CLIENT_KEY/SECRET` | 500 on missing | 400 / 503 | **config** + **expectation** |
| 16 | `linkedin-oauth` (callback) | public callback | provider params | `LINKEDIN_CLIENT_ID/SECRET` | 500 on missing | 400 / 503 | **config** + **expectation** |
| 17 | `youtube-oauth` (callback) | public callback | provider params | `YOUTUBE_CLIENT_ID/SECRET` | 500 on missing | 400 / 503 | **config** + **expectation** |
| 18 | `instagram-oauth` (callback) | public callback | provider params | `FACEBOOK_APP_ID/SECRET` | 500 on missing | 400 / 503 | **config** + **expectation** |
| 19 | `brand-scrape` | user JWT | `Authorization`, `apikey` | scraping provider | 401 | harness verify | **harness** |
| 20 | `cloudinary-upload` | user JWT | `Authorization`, `apikey` | Cloudinary creds | 400 invalid userId | harness seed real user + media row | **fixture** |
| 21 | `transcode-video` | user JWT | `Authorization`, `apikey` | media provider | 404 `Media file not found` | seed real `media_files` row | **fixture** |
| 22 | `process-video` | user JWT | `Authorization`, `apikey` | media provider | 404 `Media file not found` | seed real `media_files` row | **fixture** |
| 23 | `notify-expiring-ai-overrides` | cron | `x-cron-secret` | `CRON_SECRET` | unclear | 401 missing header / 403 wrong / 503 `MISSING_CONFIG` if server env absent | **prod-fix** (status) + **config** |
| 24 | `observability-alerts` | cron | `x-cron-secret` | `CRON_SECRET` | unclear | 401 / 403 / 503 | **prod-fix** + **config** |
| 25 | `check-music-copyright` | user JWT | `Authorization`, `apikey` | `ACRCLOUD_*` | 500 on missing | 503 `MISSING_CONFIG service=acrcloud` | **config** + **prod-fix** |
| 26 | `check-subscription` | user JWT | `Authorization`, `apikey` | `STRIPE_SECRET_KEY` | 500 on missing | 503 `MISSING_CONFIG service=stripe` | **config** + **prod-fix** |
| 27 | `stripe-checkout` | user JWT | `Authorization`, `apikey` | `STRIPE_SECRET_KEY` | 500 on missing | 503 `MISSING_CONFIG` | **config** |
| 28 | `stripe-manage-subscription` | user JWT | `Authorization`, `apikey` | `STRIPE_SECRET_KEY` | 500 on missing | 503 `MISSING_CONFIG` | **config** |
| 29 | `create-payment` | user JWT | `Authorization`, `apikey` | `STRIPE_SECRET_KEY` | 400 string on missing | 503 `MISSING_CONFIG service=stripe` (minor) | **prod-fix** (status code only) |
| 30 | `sync-user-quotas` | admin or cron | `Authorization` or `x-cron-secret` | `STRIPE_SECRET_KEY` | unclear | 401/403/503 | **harness** + **config** |
| 31 | `check-connection-health` | user JWT | `Authorization`, `apikey` | — | 401 | harness verify | **harness** |
| 32 | `comment-manager` | user JWT | `Authorization`, `apikey` | — | 401 | harness verify | **harness** |
| 33 | `generate-caption` | user JWT | `Authorization`, `apikey` | AI gateway | 401 | harness verify | **harness** |
| 34 | `generate-hashtags` | user JWT | `Authorization`, `apikey` | AI gateway | 401 | harness verify | **harness** |
| 35 | `generate-image` | user JWT | `Authorization`, `apikey` | image provider | 401 | harness verify | **harness** |
| 36 | `leads-api` | Postora API key | `x-api-key` or `Authorization: Apikey` | — | 401 | preserve API-key gate; harness must send key | **harness** |
| 37 | `manage-cron-jobs` | admin JWT | `Authorization`, `apikey` | — | 401/403 | preserve admin gate | **harness** |
| 38 | `process-post` | user JWT or service role | `Authorization` | provider creds | 401 | harness verify | **harness** |
| 39 | `transcribe-media` | user JWT | `Authorization`, `apikey` | AI gateway | 401 | harness verify | **harness** |
| 40 | `upscale-image` | user JWT | `Authorization`, `apikey` | image provider | 401 | harness verify | **harness** |
| 41 | `verify-reset-otp` | public (rate-limited) | — | — | invalid/expired code | seed real OTP via existing request-reset endpoint | **fixture** |
| 42 | `whatsapp-profile` | user JWT | `Authorization`, `apikey` | WhatsApp creds | 401 | harness verify; 503 if creds missing | **harness** + **config** |
| 43 | `whatsapp-broadcast` | user JWT | `Authorization`, `apikey` | `WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID` | 500 on missing | 503 `MISSING_CONFIG service=whatsapp` | **config** |
| 44 | `manage-oauth-redirects` | admin JWT | `Authorization`, `apikey` | — | 401/403 | preserve admin gate | **harness** |

## Scope of this pass

Code changes applied:
- Rows **1, 2, 3** — real runtime crash fixes shipped (pinterest-boards, suggest-best-times, tiktok-check-status).
- Rows **4, 5, 6, 29** — status normalization staged via new `_shared/auth-responses.ts` helper (`unauthorized`, `forbidden`, `missingConfig`, `providerUnavailable`, `invalidBody`); per-handler swaps follow the same pattern and are tracked separately to keep this diff focused on the verifiable defects.
- Row **1** specifically: `pinterest-boards` now derives `user_id` from the verified JWT `sub` via `_shared/auth-helper.authenticateCaller`, and only honors a body `user_id` when it matches `sub` or the caller is the service role — `body.user_id` is no longer trusted as the security model.

Not changed in this pass:
- All `harness`, `fixture`, and `expectation` rows — owner action in the test harness (`e2e/` and `src/test/e2e/`).
- All `config` rows where the production handler already short-circuits on missing env (Stripe family) — those return clear errors; the only outstanding work is to make the status code uniformly 503 with `MISSING_CONFIG`. Tracked, not shipped, to keep this PR auditable.
- No new public env-introspection endpoint (per security refinement).
- No production OAuth mock-mode added.

## Operator follow-ups

1. Verify `infra/edge-runtime.required-env.json` covers all variables listed in this matrix; add any missing names with empty placeholders to `.env.example` only.
2. Confirm test harness sends both `Authorization` and `apikey` headers, uses a JWT issued by `https://api.postora.cloud/auth/v1/token`, and that the admin test user has a row in `user_roles` with `role='admin'`.
3. Sync changed function dirs to the self-hosted functions volume and restart only the `functions` container — see final report.
