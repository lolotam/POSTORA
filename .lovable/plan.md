## Postora Production-Readiness Audit Plan

A read-only, multi-phase audit of the self-hosted Supabase cutover. No real secrets will be printed; all reporting uses masked status (`present` / `missing` / `optional` / `invalid_format` / `not_tested`).

### Phase 1 — Environment & secrets validation
- Parse `.env` (and `.env.example`) keys only; never echo values.
- Check required frontend vars: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, `VITE_SUPABASE_ANON_KEY`, `VITE_SUPABASE_PROJECT_ID`.
- Confirm `VITE_SUPABASE_URL === https://api.postora.cloud`.
- Confirm `VITE_SUPABASE_PUBLISHABLE_KEY` and `VITE_SUPABASE_ANON_KEY` are both present, both JWT-shaped (3 dot-separated base64url segments), and equal.
- Check edge-function vars (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `DATABASE_URL`, `SUPABASE_DB_URL`, `SB_MANAGEMENT_TOKEN`, `SUPABASE_PROJECT_REF`).
- Check platform/integration keys against an "expected vs optional" matrix (Meta, TikTok, X, LinkedIn, Pinterest, Google, WhatsApp, Cloudinary, AtlasCloud, ACRCloud, OpenAI, OpenRouter, Google AI, Lovable, Resend, Stripe, Unsplash, Giphy, Pexels, Pixabay, Klipy, Slack).
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

### Phase 5 — Runtime smoke tests against api.postora.cloud
- Anonymous REST ping (already observed in network logs: `app_settings` 200 — confirms gateway + anon JWT work).
- Anonymous edge-function ping for `get-public-config` (public endpoint) via `curl`.
- Auth/session flow: use Playwright against `localhost:8080` with the pre-minted Lovable browser session to load `/dashboard`, confirm session restore, screenshot, capture console errors.
- Admin route guard: navigate `/admin` as the signed-in user, verify role-based gating.
- RLS spot-check: anon REST call to a user-scoped table (e.g. `posts`) must return empty/403; service-role calls are NOT executed from the browser (no service key in client).

### Phase 6 — Frontend feature sweep (Playwright)
- Visit each public route (`/`, `/auth`, `/pricing`, `/privacy`, `/terms`, `/docs` if present), screenshot, capture console + failed network.
- Visit each authenticated route (Dashboard, Profiles, Create Post, Calendar, History, Media, Analytics, Templates, Settings, API Keys, Connection Health).
- Visit admin routes (Users, Plans, Coupons, Messages, Notifications, Blog, Settings, OAuth Apps, Feature Flags, Logs, Observability, Token Health, Rate Limits, Launch Checklist).
- For each: status (ok / warn / fail), console errors, failed XHRs.
- No destructive actions (no real posting, no real Stripe charges, no real OAuth completion, no media deletion of real assets).

### Phase 7 — OAuth & integration static checks
- For each platform OAuth function, confirm:
  - redirect URI built from `SUPABASE_URL` / app origin, not the old project ref
  - missing-credential path returns a clear structured error
  - token storage targets `social_accounts` with correct fields
- Do NOT initiate real OAuth handshakes.

### Phase 8 — Workflow contract checks (no live publishing)
- Posting flow: read `process-post` and `process-scheduled-posts` to confirm DB writes (posts + platform_posts), status transitions, error structure.
- Media flow: read `cloudinary-upload`, validate path uses `${userId}/` (RLS rule from memory).
- AI flow: read `generate-caption`, `generate-hashtags`, `generate-image`, `ai-config` — confirm Lovable AI Gateway + fallback chain wiring.
- Billing flow: read `stripe-checkout`, `stripe-webhook`, `check-subscription` — confirm signature verification and missing-key behavior.
- Messaging/WhatsApp: read `messaging-api`, `whatsapp-*` — confirm webhook verify token handling.

### Phase 9 — Auto-fix small safe issues
Only if found during the audit. Examples of what I would fix in-place:
- Missing CORS headers on edge-function error branches
- Edge functions that throw instead of returning structured 200 with `error_code`
- Stray `efruibswazzuuupgyzmf` / `supabase.postora.cloud` in live code
- Frontend hooks that build `.supabase.co/functions/v1` URLs manually

What I will NOT touch:
- Historical migrations (`supabase/migrations/*.sql`)
- Archived docs banners
- Real secret values
- Working compatibility env-var aliases
- Anything outside the audit scope

### Phase 10 — Final structured report
Sections A–G exactly as you requested:
- A. Environment status (masked)
- B. Build/test status
- C. Edge function table
- D. Feature status table
- E. Security status (grep results, RLS, admin guard, webhook auth)
- F. Manual actions left for you (OAuth console redirect URIs, real account reconnects, Stripe mode confirmation, WhatsApp webhook verification, edge function deploy on the VPS, etc.)
- G. Final conclusion: `ready` / `ready with warnings` / `blocked` + reason

### Constraints honored throughout
- No secret values printed, logged, screenshotted, or committed.
- No destructive DB ops, no real posting, no real billing.
- No rewriting of historical migrations or archived docs.
- Self-hosted Supabase compatibility preserved.
- Old compatibility env-var aliases (`VITE_SUPABASE_PUBLISHABLE_KEY` ↔ `VITE_SUPABASE_ANON_KEY`) preserved.

### Expected runtime
~15–25 tool calls total (mostly parallel reads, `rg`, `curl`, one Playwright sweep). Estimated wall-clock 3–6 minutes depending on Playwright route count.

Approve this and I'll execute Phases 1–10 in order, fixing only safe issues in-place and returning the final structured report.