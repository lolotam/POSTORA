## Postora Production-Readiness Audit Plan

**Mode: Audit only** (Option A). No files will be modified. Issues are reported, not patched. To switch to **Audit + safe fixes** (Option B), the project owner must explicitly approve in writing; until then, Phase 9 is report-only.

Multi-phase audit of the self-hosted Supabase cutover. No real secrets will be printed; reporting uses masked status (`present` / `missing` / `optional` / `invalid_format` / `not_tested`).

### Phase 1 — Environment & secrets validation
- Parse `.env` (and `.env.example`) keys only; never echo values.
- Check required frontend vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_ANON_KEY`, `VITE_SUPABASE_PROJECT_ID`.
- Confirm `VITE_SUPABASE_URL === https://api.postora.cloud`.
- Confirm `VITE_SUPABASE_PUBLISHABLE_KEY` and `VITE_SUPABASE_ANON_KEY` are both present, both JWT-shaped (3 dot-separated base64url segments), and equal.
- Check edge-function vars (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `DATABASE_URL`, `SUPABASE_DB_URL`, `SB_MANAGEMENT_TOKEN`, `SUPABASE_PROJECT_REF`).
- Check platform/integration keys against an "expected vs optional" matrix (Meta, TikTok, X, LinkedIn, Pinterest, Google, WhatsApp, Cloudinary, AtlasCloud, ACRCloud, OpenAI, OpenRouter, Google AI, Lovable, Resend, Stripe, Unsplash, Giphy, Pexels, Pixabay, Klipy, Slack).
- For each credential, report exactly one of: `present` / `missing` / `optional` / `invalid_format` / `not_tested`. Never print partial token characters.
- Do not validate by sending real actions to third-party APIs unless the API exposes a documented harmless health/check endpoint.
- Output: masked secrets table only.

### Phase 2 — Static repo validation
- `rg` for old refs in live code: `efruibswazzuuupgyzmf`, `supabase.postora.cloud`, `efruibswazzuuupgyzmf.supabase.co`, `.supabase.co/functions/v1` across `src/`, `supabase/`, `scripts/` (excluding migrations and archived docs).
- `git diff --check` for whitespace.
- Read `src/integrations/supabase/client.ts` and `src/lib/functionsUrl.ts` to confirm URL sources come from `VITE_SUPABASE_URL` only.

### Phase 3 — Build & type checks
- Run `npm run lint`, `npm run build`, `npm run typecheck` (or report unavailable).
- Run `npx vitest run` if test files exist (Lovable harness runs builds automatically — I'll only re-run if needed for diagnostics).

### Phase 4 — Edge function inventory & static contract check
- List every function in `supabase/functions/`.
- For each: read `index.ts` head, classify auth model (public / user JWT / service role / webhook secret / admin), verify CORS preflight handler, structured error shape, and absence of hardcoded cloud URLs.
- Special check for `manage-app-secrets`: confirm the self-hosted guard returns the structured `management_api_unavailable` 200 response and does not throw.
- Output: endpoint status table (auth type, contract check, issues).

### Destructive endpoint denylist (applies to Phases 5, 7, 8)
The following functions must **never** be invoked live during the audit — only static contract review, CORS preflight check, missing-auth behavior, missing-input validation, and (if the function itself supports it) a built-in safe dry-run mode:
- `process-post`, `process-scheduled-posts`
- `whatsapp-broadcast`, `whatsapp-scheduled-sender`, any `whatsapp-*` send path
- `send-inbox-email`, `send-auth-email`, `send-subscription-email`, `send-expiry-reminders`, `send-token-expiry-notifications`, `send-token-failure-alert`, `send-weekly-analytics`, `send-reset-otp`
- `stripe-checkout`, `stripe-webhook`, `create-payment`, `verify-payment`, `stripe-manage-subscription`
- `manage-cron-jobs`, `manage-app-secrets`, `manage-oauth-redirects`
- `cloudinary-delete`, `cleanup-media`
- any function that deletes, sends, publishes, bills, refreshes real OAuth tokens, or mutates production data

### Phase 5 — Runtime smoke tests against api.postora.cloud (safe by default)
- Anonymous REST ping (already observed in network logs: `app_settings` 200 — confirms gateway + anon JWT work).
- Anonymous edge-function ping for `get-public-config` (public, read-only).
- For every function on the denylist: contract-only — confirm CORS preflight (`OPTIONS`), missing-auth returns structured 401/403 (not a crash), missing required input returns 400 with a clear error.
- Service-role calls are **never** executed from browser/sandbox context. If service-role validation is genuinely needed, run it from a local server-side script outside this audit; never print the service role key; report only masked status and HTTP class.
- Auth/session flow: if a Lovable browser session is pre-minted (`LOVABLE_BROWSER_SUPABASE_SESSION_JSON`), use Playwright against `localhost:8080` to load `/dashboard`, confirm session restore. If no session env is present, mark authenticated and admin UI flows as `not_tested` and list them under manual actions. Never ask the user for a password and never use a value that would require printing it.
- Admin route guard: if signed in, navigate `/admin` and verify role-based gating; otherwise mark `not_tested`.
- RLS spot-checks (do not rely on anon alone):
  - anon REST on user-owned tables (`posts`, `media_files`, `social_accounts`) must return empty or 403 — verified.
  - authenticated user can only see their own rows — only runs if a safe test session is available; otherwise `not_tested`.
  - admin routes blocked for non-admin users — only runs if a safe non-admin test session is available; otherwise `not_tested`.
  - Any RLS check that cannot run safely is listed as a manual action.

### Phase 6 — Frontend feature sweep (Playwright)
- Visit each public route (`/`, `/auth`, `/pricing`, `/privacy`, `/terms`, `/docs` if present), screenshot, capture console + failed network.
- If a pre-minted session is present, visit each authenticated route (Dashboard, Profiles, Create Post, Calendar, History, Media, Analytics, Templates, Settings, API Keys, Connection Health) and admin routes (Users, Plans, Coupons, Messages, Notifications, Blog, Settings, OAuth Apps, Feature Flags, Logs, Observability, Token Health, Rate Limits, Launch Checklist). If no session is present, mark all of these `not_tested` and list as manual action.
- For each visited route: status (ok / warn / fail), console errors, failed XHRs.
- No destructive actions (no real posting, no real Stripe charges, no real OAuth completion, no media deletion of real assets).

### Phase 7 — OAuth & integration static checks
- For each platform OAuth function, confirm:
  - redirect URI built from `SUPABASE_URL` / app origin, not the old project ref
  - missing-credential path returns a clear structured error
  - token storage targets `social_accounts` with correct fields
- Do NOT initiate real OAuth handshakes.

### Phase 8 — Workflow contract checks (no live publishing)
- Posting flow: read `process-post` and `process-scheduled-posts` to confirm DB writes (posts + platform_posts), status transitions, error structure. Static only — function is on the denylist.
- Media flow: read `cloudinary-upload`, validate path uses `${userId}/` (RLS rule from memory). `cloudinary-delete` and `cleanup-media` are denylisted — static review only.
- AI flow: read `generate-caption`, `generate-hashtags`, `generate-image`, `ai-config` — confirm Lovable AI Gateway + fallback chain wiring. Do not call live unless billable cost is zero.
- Billing flow: read `stripe-checkout`, `stripe-webhook`, `check-subscription` — confirm signature verification and missing-key behavior. Denylisted — static only.
- Messaging/WhatsApp: read `messaging-api`, `whatsapp-*` — confirm webhook verify token handling. All send paths denylisted — static only.

### Phase 9 — Findings report (report-only under Option A)
Under the current **Audit only** mode, this phase produces a list of recommended fixes — **no code changes are made**. Each finding includes file path, line, severity, and a proposed patch description. The owner can then approve Option B (Audit + safe fixes) for a follow-up pass.

Examples of items this phase would surface:
- Missing CORS headers on edge-function error branches
- Edge functions that throw instead of returning structured 200 with `error_code`
- Stray `efruibswazzuuupgyzmf` / `supabase.postora.cloud` in live code
- Frontend hooks that build `.supabase.co/functions/v1` URLs manually

What this phase will never touch (even under Option B):
- Historical migrations (`supabase/migrations/*.sql`)
- Archived docs banners
- Real secret values
- Working compatibility env-var aliases
- Anything outside the audit scope

### `manage-app-secrets` special handling
- Do **not** call the Supabase Cloud Management API in self-hosted mode.
- Verify only that the endpoint returns the structured `management_api_unavailable` response and that Admin Settings renders that message without crashing.

### Phase 10 — Final structured report
Every line item in the report carries one of these explicit status labels:
- `verified` — runtime evidence captured this turn
- `statically_verified` — confirmed by reading code / config only
- `smoke_tested` — non-destructive live ping succeeded
- `not_tested` — could not be tested safely; listed under manual actions
- `blocked` — a precondition (credentials, session, deploy) is missing

Sections A–G:
- A. Environment status (masked)
- B. Build/test status
- C. Edge function table
- D. Feature status table
- E. Security status (grep results, RLS, admin guard, webhook auth)
- F. Manual actions (OAuth console redirect URIs, real account reconnects, Stripe mode confirmation, WhatsApp webhook verification, edge function deploy on the VPS, missing test credentials, etc.)
- G. Final conclusion. Allowed verdicts: `ready` / `ready with warnings` / `blocked` / `blocked by missing credentials` / `blocked by code errors` / `blocked by missing test credentials`.
  - The app is **not** marked `ready` unless **all** of these pass: build, Supabase client init, anon REST under RLS, public route loading, public edge function ping, and admin route guard.
  - If authenticated E2E cannot run because no safe session/test user exists, the verdict is at most `ready with warnings` or `blocked by missing test credentials` — never `ready`.

### Constraints honored throughout
- No secret values printed, logged, screenshotted, or committed.
- No partial token characters reported.
- No destructive DB ops, no real posting, no real billing, no real OAuth handshakes, no real email/WhatsApp/Stripe sends.
- No service-role calls from browser/sandbox context.
- No rewriting of historical migrations or archived docs.
- Self-hosted Supabase compatibility preserved.
- Old compatibility env-var aliases (`VITE_SUPABASE_PUBLISHABLE_KEY` ↔ `VITE_SUPABASE_ANON_KEY`) preserved.

Approximate scope: ~15–25 tool calls (parallel file reads, `rg`, `curl`, one Playwright sweep).

Approve this and I'll execute Phases 1–10 in **Audit only** mode and return the final structured report. To enable in-place safe fixes, reply with explicit approval of Option B.