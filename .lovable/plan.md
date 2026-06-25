## OTP + Cron Auth Security Hardening — Plan

### Phase 1 — OTP audit (`send-reset-otp`)
Read the function and verify against checklist: no `debug_otp` in response, no OTP logging, 503 when `RESEND_API_KEY` missing, OTP stored hashed (SHA-256 / bcrypt), expiry enforced, single-use marker, old OTPs invalidated on reissue, constant-time compare on verify side, generic response (no email-existence leak), per-email/IP rate limit, sanitized errors. Apply minimal fixes only for confirmed gaps.

### Phase 2 — `_shared/cron-auth.ts` audit
Read helper; confirm: missing/invalid secret → 401, both `Authorization: Bearer` and `x-cron-secret` accepted, service-role fallback documented and gated, no secret logging, no broad try/catch swallowing auth failure, CORS preflight still returns before auth check in callers.

### Phase 3 — Coverage check
`grep -R "verifyCronAuth" supabase/functions` and confirm the 9 listed functions each import and call it before any work. Report any unprotected scheduled function found.

### Phase 4 — Env manifest
Inspect `infra/edge-runtime.required-env.json` and `.env.example` — add `CRON_SECRET` entry/placeholder if missing. Report production/container presence as `present|missing|empty|invalid_format` only. Do not generate a value.

### Phase 5 — Manual SQL migration (no execution)
Create `supabase/migrations/<ts>_update_pg_cron_auth_headers.sql` containing:
- `cron.unschedule` + `cron.schedule` re-registrations for the 9 jobs
- URLs pinned to `https://api.postora.cloud/functions/v1/<fn>`
- Header `Authorization: Bearer <CRON_SECRET_FROM_PRODUCTION_ENV>` placeholder
- Comments: owner must substitute placeholder, run manually, replace any legacy `efruibswazzuuupgyzmf.supabase.co` URLs
- Rollback notes (re-schedule previous job definitions)
- Affected job list

### Phase 6 — Deployment verification (self-hosted only)
Via `ssh-contabo-mcp`: hash-compare repo function files vs `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions`. Report drift only; do NOT auto-sync. Check container logs for boot errors / `InvalidWorkerCreation` after restart (owner-triggered).

### Phase 7 — Safe endpoint tests
For each of the 9 functions:
- No auth → expect 401/403
- Wrong secret → expect 401/403
- Valid secret: only for non-destructive (`observability-collector`, possibly `cleanup-media` dry-side). All others (`process-scheduled-posts/emails/blog-posts/flags`, `refresh-tokens`, `send-expiry-reminders`, `send-weekly-analytics`) → `not_tested_safe`.

### Phase 8 — Supply-chain
File a follow-up: "Dependency vulnerability audit and safe upgrade plan". No fixes this task.

### Phase 9 — Validation
Run: `check:edge-env`, `build`, `lint`, `vitest run`, `git diff --check`, and the four grep checks. Allow legacy refs only in historical migrations / archived docs.

### Phase 10 — Guard reviews
CleanCodeGuard on `send-reset-otp/index.ts`, `_shared/cron-auth.ts`, and any cron function modified. TestGuard skipped unless test files changed.

### Phase 11 — Final report
Structured 13-section report with masked status only. Final status one of: `completed`, `completed_requires_manual_sql`, `completed_requires_cron_secret`, `blocked_by_missing_cron_secret`, `blocked`.

### Guardrails honored
- No SQL execution, no destructive ops
- No secret/OTP/token printing
- No Supabase Cloud / `efruibswazzuuupgyzmf` deploys
- No n8n behavior changes
- DB changes delivered as manual SQL only

Approve to switch to build mode and execute phases 1–11.
