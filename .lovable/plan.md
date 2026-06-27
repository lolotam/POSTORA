# Postora Security Hardening Audit — Phased Plan

Postora is large (100+ edge functions, 50+ pages, self-hosted Supabase at `api.postora.cloud`). A single mega-pass would be unsafe and noisy. This plan splits the work into 5 phases, with explicit gates between each.

## Phase 1 — Full security inventory (READ-ONLY, no code changes)

I will produce a single **Risk Register** document at `docs/security/audit-2026-06.md` (new file, documentation only — not code) covering all 11 areas you listed. For each area I will inspect the relevant files in parallel and record findings in the required format:

```
area | file/function | issue | severity | exploit | recommended fix
requires SQL | can Lovable fix | needs server/Zed
```

Areas and inspection targets:

1. **Auth flows** — `src/pages/Auth.tsx`, `ResetPassword.tsx`, `src/hooks/useAuth.tsx`, `send-reset-otp`, `send-auth-email`, `verify-mfa-reset`, `check-user-mfa`
2. **OAuth flows** — every `*-oauth/index.ts` (facebook, instagram, instagram-business, threads, tiktok, pinterest, linkedin, youtube, twitter, reddit, bluesky) + `manage-oauth-redirects`, `OAuthCallback.tsx`, `*Callback.tsx`
3. **Webhooks** — `stripe-webhook`, `resend-webhook`, `tiktok-webhook`, `threads-webhook`, `ecommerce-whatsapp-api` (WhatsApp webhook surface), `mcp` (public?)
4. **Cron / scheduled** — `process-scheduled-posts`, `process-scheduled-emails`, `process-scheduled-blog-posts`, `process-scheduled-flags`, `observability-collector`, `cleanup-media`, `refresh-tokens`, `send-expiry-reminders`, `send-weekly-analytics`, `send-token-expiry-notifications`, `notify-expiring-ai-overrides`, `sync-resend-delivery-status`, `sync-user-quotas`
5. **Service-role usage** — grep every function for `SUPABASE_SERVICE_ROLE_KEY` and classify: legitimate (admin task) vs leaky (user-callable but uses service role without auth check)
6. **DB / RLS** — read `supabase/migrations/` index + spot-check sensitive tables: `social_accounts`, `backup_codes`, `app_settings`, `api_logs`, `user_roles`, `user_subscriptions`, storage policies
7. **Uploads / media** — `cloudinary-upload`, `cloudinary-email-upload`, `cloudinary-delete`, `process-video`, `transcode-video`, `MediaLibrary.tsx`, storage RLS path conventions
8. **AI providers** — `generate-caption`, `generate-image`, `generate-hashtags`, `ai-config`, `ai-email-assistant`, `test-ai-model`, `fetch-openrouter-models`
9. **Payments** — `stripe-checkout`, `stripe-webhook`, `stripe-manage-subscription`, `create-payment`, `check-subscription`, `backfill-subscription`
10. **Secrets / env** — `infra/edge-runtime.required-env.json`, `.env.example`, `scripts/check-edge-env-*`, repo-wide grep for hardcoded URLs / old `efruibswazzuuupgyzmf` refs
11. **Logging** — grep for `console.log` of tokens/otp/state/code; broad `catch(e)` returning fake success; raw provider error pass-through
12. **n8n API** — `n8n-api/index.ts` auth header handling only; no contract changes unless confirmed bug

Deliverable: `docs/security/audit-2026-06.md` with full risk register + summary counts by severity.

## Phase 2 — Prioritization roadmap (READ-ONLY)

Append to the same audit doc:

- **P1 Critical** — OTP/token leakage, unauth cron/webhook, service-role exposure, missing webhook signature verify, public admin endpoints, broken RLS
- **P2 High** — OAuth redirect fallback, missing rate limits, weak error handling, payment replay/idempotency, upload validation
- **P3 Medium** — dep vulns, old runtime refs in docs, generic FE errors, missing monitoring

For each item: file list, fix sketch, SQL-needed flag, server-action-needed flag.

**Gate:** I stop and show you the audit + roadmap. You approve which P1 items to implement.

## Phase 3 — Implement Priority 1 only

Rules I will follow:

- Small focused diffs per finding, never bundled
- Preserve behavior; add auth/signature checks rather than refactor
- Sanitize logs (redact tokens/otp/state)
- Never print secrets, never add real env values
- Each new env var: append name only to `infra/edge-runtime.required-env.json` + `.env.example` + a runbook note
- Each DB change: new file `supabase/migrations/<UTC-timestamp>_<desc>.sql` with rollback notes; **not executed**
- n8n-api untouched unless Phase 1 confirms a security bug

Before editing I will list the exact files per fix and confirm.

## Phase 4 — Validation

Run (allowing failures):
```
npm run check:edge-env || true
npm run build || true
npm run lint || true
npx vitest run || true
git diff --check || true
```
Plus security greps for token/otp/service-role leakage and old Supabase Cloud refs (allowed only in historical migrations & archived docs).

## Phase 5 — Guards & final report

- CleanCodeGuard on production diffs
- TestGuard only if test files changed (else: "no test files changed; no test-code review required")
- Final report in your exact 14-section format ending in one of: `audit_completed`, `priority_1_completed_requires_server_sync`, `completed_requires_manual_sql`, `blocked`

## What Lovable cannot do (called out up front)

- SSH to Contabo VPS
- Edit production `.env` at `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code/.env`
- Sync edge functions to the self-hosted functions volume
- Restart the functions container
- Execute SQL on the self-hosted Postgres
- Run real production OAuth/webhook tests

These will be listed as explicit server actions in the final report.

## This turn's scope

If you approve this plan, I will execute **Phase 1 only** (read-only inventory → `docs/security/audit-2026-06.md`) and stop at the Phase 2 gate so you can steer which P1 fixes get implemented. No code, SQL, or env changes in this first execution.
