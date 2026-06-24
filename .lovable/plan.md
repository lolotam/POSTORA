## Problem

All four failures share the same root cause: **missing/empty provider credentials on the self-hosted edge-functions container** (`api.postora.cloud`). The Reddit URL proves it — `client_id=` is empty in the authorize URL, which only happens if `Deno.env.get("REDDIT_CLIENT_ID")` returned `undefined`/empty and the function built the URL anyway.

| Symptom | Likely missing/misconfigured secret(s) |
|---|---|
| Reddit "invalid client id" (`client_id=` empty) | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` |
| "Facebook SDK failed to load" | Browser-side: ad-blocker OR missing `VITE_FACEBOOK_APP_ID` in built frontend |
| "Instagram Business isn't set up correctly on the server yet" | `INSTAGRAM_BUSINESS_APP_ID` / `INSTAGRAM_BUSINESS_APP_SECRET` (or Meta app creds) on edge container |
| "We couldn't authenticate the TikTok connection" | `TIKTOK_CLIENT_KEY` / `TIKTOK_CLIENT_SECRET` on edge container, or redirect URI mismatch |

## Plan

### Phase 1 — Diagnose (read-only, no code changes)

1. Grep the edge functions for the exact env var names used:
   - `supabase/functions/reddit-oauth/`
   - `supabase/functions/instagram-business-oauth/`
   - `supabase/functions/tiktok-oauth/`
   - frontend usage of `VITE_FACEBOOK_APP_ID` / FB SDK loader
2. SSH into Contabo and `docker exec` into the edge-runtime container to list which of these are actually present (report only `present`/`missing` — never values).
3. Confirm the exact redirect URIs each function uses, so the user can match them in each provider dashboard.

### Phase 2 — Code hardening (small, safe)

Make each OAuth function **fail fast with a clear, structured error** instead of building a broken authorize URL. Pattern already established in `oauthErrors.ts`:

- `reddit-oauth/index.ts` — if `REDDIT_CLIENT_ID` or `REDDIT_CLIENT_SECRET` missing → return 200 with `{ success:false, error_code:"missing_config", message:"Reddit isn't set up correctly on the server yet." }` and redirect back to `/profiles?error=reddit_oauth&code=missing_config`. **Do not** generate an authorize URL with an empty `client_id`.
- Same guard added to `instagram-business-oauth/index.ts`, `tiktok-oauth/index.ts`, `threads-oauth/index.ts`, `pinterest-oauth/index.ts`, `facebook-oauth/index.ts` (only where the guard is missing).
- Frontend: in the FB SDK loader, if `VITE_FACEBOOK_APP_ID` is empty, show the existing `missing_config` toast instead of the generic "SDK failed to load" message (the current copy wrongly blames ad-blockers).

No new files, no schema changes.

### Phase 3 — Manual actions for the project owner

After code is deployed, the owner must (on the Contabo box, edge-functions env):

1. Set the missing secrets — list will be produced in Phase 1 report. Likely:
   - `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET`
   - `INSTAGRAM_BUSINESS_APP_ID`, `INSTAGRAM_BUSINESS_APP_SECRET` (if separate from FB app)
   - `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`
2. Restart only the edge-functions container.
3. In each provider dashboard, whitelist:
   - Reddit: `https://api.postora.cloud/functions/v1/reddit-oauth`
   - IG Business: already whitelisted per prior turn
   - TikTok: `https://api.postora.cloud/functions/v1/tiktok-oauth`

### Phase 4 — Validation

- `npm run lint`, `npm run build`, `npm run typecheck`, `npx vitest run`
- CleanCodeGuard + TestGuard reviews
- After owner sets secrets + restarts container: manual E2E click-through on Reddit, IG Business, TikTok.

### What this plan does NOT do

- Does not run SQL (none required).
- Does not write secrets for the owner (must be set on the self-hosted box).
- Does not touch the provider dashboards.
- Does not change n8n, posting, or any unrelated code path.

### Deliverable

A short, focused PR that ensures **no OAuth function ever generates a broken authorize URL with an empty `client_id`** — every missing-config case routes through the existing `oauthErrors` normalizer and surfaces the user-friendly "isn't set up correctly on the server yet" toast.
