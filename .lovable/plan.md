# Backend API Test Findings — Fix Plan (Revised)

Self-hosted Supabase only (`https://api.postora.cloud`). No SQL. No secrets printed. No auth weakening. No n8n behavior changes. Edge-function + test-harness only. No deployment performed in this phase.

## Implementation order

1. Classification matrix
2. Harness auth verification
3. Fixture corrections (test side)
4. Runtime crash fixes
5. Auth status normalization
6. Missing-config structured responses
7. Targeted tests
8. CleanCodeGuard / TestGuard
9. Final 18-section report

## 1. Classification matrix — `docs/qa/backend-api-classification.md`

Columns: endpoint, expected auth (user JWT / admin JWT / cron / API key / provider callback / public), required headers, required env, current result, expected secure result, fix type ∈ {true defect, harness, config missing, test expectation wrong, fixture, production code fix}.

Coverage: all endpoints in the request (tiktok-analytics, ad-manager/ad-analytics, analyze-log, remove-background, manage-app-secrets, unsplash-proxy, pinterest-boards, suggest-best-times, threads/pinterest/tiktok/linkedin/youtube/instagram-oauth, brand-scrape, threads-keyword-search, threads-delete-post, cloudinary-upload, transcode-video, notify-expiring-ai-overrides, observability-alerts, check-music-copyright, check-subscription, stripe-checkout, stripe-manage-subscription, create-payment, sync-user-quotas, check-connection-health, comment-manager, generate-caption/hashtags/image, leads-api, manage-cron-jobs, process-post, process-video, transcribe-media, upscale-image, verify-reset-otp, whatsapp-profile, whatsapp-broadcast, manage-oauth-redirects, tiktok-check-status).

**Rows marked only `harness`, `config missing`, or `test expectation wrong` get no code change** unless they also carry a runtime/security defect.

## 2. Harness auth verification (no production code changes)

Update test fixture helper to:
- Mint session against `https://api.postora.cloud/auth/v1/token` using existing test creds (never printed).
- Decode JWT and assert presence of `iss`, `aud`, `sub`, `exp`, `aal` — log presence only.
- Always send both `Authorization: Bearer <jwt>` AND `apikey: <anon>` where required.
- Admin suite uses a user pre-seeded with `admin` in `user_roles`; assert via existing `has_role` RPC before running admin tests.
- Cron suite reads `x-cron-secret` from env; skip with clear "harness: CRON_SECRET not provided" if missing.

Endpoints whose only failure cause is harness (wrong/missing JWT, missing `apikey`, expired token, missing admin role, wrong project issuer) are flagged `harness` and not touched in code.

## 3. Fixture corrections (test side only)

- `cloudinary-upload`, `transcode-video`, `process-video` — harness seeds a real `media_files` row owned by the authenticated test user, then deletes it on teardown.
- `verify-reset-otp` — harness first calls the existing request-reset endpoint to create a real OTP, then verifies.

No production validation changes; placeholder UUIDs continue to return 400/404 as designed.

## 4. Runtime crash fixes (highest priority — real defects)

**A. `pinterest-boards`**
- Authenticate via `_shared/auth-helper.authenticateCaller(req, body.user_id)`. **Derive `user_id` from the verified JWT `sub`**. If body includes `user_id`, accept only when it matches `sub` OR caller is verified admin (`has_role`); otherwise 403.
- Query `social_accounts` by the JWT-derived user id only.
- Guard upstream parse: read body text, attempt JSON parse in try/catch; empty/non-JSON → `503 { error, code: "PROVIDER_EMPTY_RESPONSE", service: "pinterest" }`.
- Missing/expired Pinterest account → `409 { code: "ACCOUNT_NOT_CONNECTED" }`. Never expose tokens or raw upstream payloads.

**B. `suggest-best-times`**
- Zod-validate body: `{ platforms: string[] min 1, historicalData: { hourCounts, dayCounts, totalPosts } }`. Missing/invalid → `400 { code: "INVALID_BODY", details }`.
- No `.join()` on undefined.

**C. `tiktok-check-status`**
- Wrap `req.json()` in try/catch → `400 { code: "INVALID_JSON" }`. Missing `publish_id` → `400 { code: "MISSING_PUBLISH_ID" }`. Preserve current happy-path TikTok API call.

## 5. Auth status normalization — `_shared/auth-responses.ts`

Helpers (all include existing CORS headers from `_shared/cors.ts`; OPTIONS preflight untouched):
- `unauthorized(message?, code?)` → 401
- `forbidden(message?, code?)` → 403
- `missingConfig(service)` → 503 `{ error: "Service not configured", code: "MISSING_CONFIG", service }`
- `providerUnavailable(service, code?)` → 503
- `invalidBody(details)` → 400

All helpers redact sensitive detail (no env names with values, no upstream stack traces).

**Status rules applied uniformly:**
- Missing/invalid/expired JWT → 401
- Valid user, not admin on admin endpoint → 403
- Missing `x-cron-secret` request header → 401
- Wrong `x-cron-secret` request header → 403
- Server `CRON_SECRET` env missing → 503 `MISSING_CONFIG`
- Never 200 `{ ok:false, message:"Unauthorized" }`

Sweep `rg "Unauthorized" supabase/functions` and replace wrong-status sites. Confirmed targets so far: `ad-analytics`, `threads-keyword-search`, `threads-delete-post`.

## 6. Missing-config structured responses

**Protected endpoints** — order: auth → config → provider. Auth must be checked before config so an unauthenticated probe never learns which env is missing.

**OAuth callback endpoints** (public by nature, no user JWT):
1. Validate `state` and `code` safely → 400 `INVALID_OAUTH_STATE` / `INVALID_CALLBACK` on failure.
2. Check required provider creds before any token exchange → 503 `MISSING_CONFIG` if absent.
3. Never expose raw provider errors or secrets.

Functions converted from crash/500 to structured:
- `unsplash-proxy` (`UNSPLASH_ACCESS_KEY`)
- `check-music-copyright` (`ACRCLOUD_*`)
- `check-subscription`, `create-payment`, `stripe-checkout`, `stripe-manage-subscription`, `sync-user-quotas` (`STRIPE_SECRET_KEY`, webhook secret where used)
- `notify-expiring-ai-overrides`, `observability-alerts` (`CRON_SECRET`)
- `threads/pinterest/tiktok/linkedin/youtube/instagram-oauth` (respective provider creds)
- `whatsapp-broadcast` (`WHATSAPP_ACCESS_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`)

Log only `console.warn("[<fn>] missing config: <NAME>")` — name only, never value.

**No new public env-status Edge Function.** Env presence verification uses existing tooling only: `npm run check:edge-env` / `scripts/check-edge-env-server.sh` / `scripts/check-edge-env-local.mjs` against `infra/edge-runtime.required-env.json`. If those are insufficient, the final report flags it as an operator action — no introspection endpoint is added.

## 7. OAuth mock-callback decision

No production mock mode. Tests that pass fake `code`/`state` are updated to expect:
- 400 `INVALID_OAUTH_STATE`
- 400 `INVALID_CALLBACK`
- 503 `MISSING_CONFIG`

If a non-prod mock path is ever needed it must be gated by an explicit non-production flag and never deployed to `api.postora.cloud` — not added in this pass.

## 8. Authenticated-endpoint sweep (preserve intended access)

For each endpoint in the "valid token rejected" list (tiktok-analytics, ad-manager, analyze-log, remove-background, manage-app-secrets, brand-scrape, check-connection-health, comment-manager, generate-caption/hashtags/image, leads-api, manage-cron-jobs, process-post, transcribe-media, upscale-image, whatsapp-profile, manage-oauth-redirects):

- Diff handler against `_shared/auth-helper.authenticateCaller`. Fix only where a valid self-hosted user/admin JWT is incorrectly rejected (e.g. handler reads `Authorization` itself and compares strict-equal to service-role, or fails to forward the header to the supabase client).
- Preserve intended access tier per endpoint:
  - user endpoints → valid user JWT
  - admin endpoints (`manage-app-secrets`, `manage-cron-jobs`, `manage-oauth-redirects`, `analyze-log`, `observability-alerts`) → JWT + `has_role(uid,'admin')`
  - cron endpoints → valid `x-cron-secret`
  - API-key endpoints (e.g. `leads-api`, `n8n-api`-adjacent) → existing Postora API-key validation
  - provider callbacks → provider-specific validation
- No admin-check removal. No generic permissive replacement. No JWT bypass.

## 9. Validation

`npm run build`, `npm run lint`, `npx vitest run`, `git diff --check` (all `|| true`). Targeted vitest for the three crash fixes and the auth-helper response codes.

Security greps for token/secret/password/otp leaks in `console.log` across `src` and `supabase/functions`.

CleanCodeGuard on touched edge functions; TestGuard on changed tests.

## 10. Out of scope

- No SQL migrations. If schema change appears necessary, stop and report.
- No n8n-api changes.
- No CORS allowlist, redactor, rate limiter, cron-auth shape, MFA/backup-code changes.
- No new public introspection endpoints.
- No deployment performed; report lists exact `supabase/functions/<name>/` dirs needing sync to `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/` + `docker compose up -d --no-deps functions`.

## 11. Final report — 18 sections per request

Standard sections 1–18 plus explicit confirmations:
- No auth weakening
- No new public env introspection endpoint
- No fake OAuth success in production
- `pinterest-boards` derives `user_id` from JWT, not body
- Server env values never printed

Final status ∈ `backend_api_findings_fixed` | `backend_api_findings_requires_env_update` | `backend_api_findings_requires_harness_fix` | `backend_api_findings_partial_runtime_fixes` | `blocked`.

## Technical notes

- `_shared/auth-helper.ts` already does timing-safe service-role compare + `getClaims` — reuse, never duplicate.
- `pinterest-boards` currently trusts `body.user_id` with no JWT check — corrected per §4A.
- `create-payment` already auth-checks via `getUser(token)` — only the missing-Stripe path needs structured 503 instead of 400 string.
- `supabase/config.toml` is local-CLI only; not modified.
