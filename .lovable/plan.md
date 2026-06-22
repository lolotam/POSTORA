## Goal

Cut the project cleanly over to the self-hosted Supabase at `https://api.postora.cloud` and remove every trace of the old Supabase Cloud project `efruibswazzuuupgyzmf`. Provide a single `.env` placeholder file you can fill in.

## Scope (only what you asked for)

1. **Delete the existing `.env`** (it points to `supabase.postora.cloud` and a stale anon JWT).
2. **Create a new `.env`** at project root with placeholders only — no secret values committed. You'll paste real values yourself. It will contain:
   - Frontend (Vite, used by the SPA): `VITE_SUPABASE_URL=https://api.postora.cloud`, `VITE_SUPABASE_PUBLISHABLE_KEY=<ANON_KEY placeholder>`, `VITE_SUPABASE_PROJECT_ID=self-hosted` (kept because some code reads it; documented as cosmetic).
   - Server / Edge-Function side mirror (for local dev & deployment to the self-hosted edge runtime): `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`, `DATABASE_URL`.
   - All 37 platform/AI/integration secrets from your README list, each as `KEY=` placeholder (ACRCLOUD_*, APIFY, ATLASCLOUD, CLOUDINARY_*, FACEBOOK_*, INSTAGRAM_*, THREADS_*, GOOGLE_*, TIKTOK_*, TWITTER_*/X_*, LINKEDIN_*, PINTEREST_*, OPENAI/OPENROUTER/GOOGLE_AI_STUDIO, RESEND_*, STRIPE_*, UNSPLASH/GIPHY/PEXELS/PIXABAY/KLIPY, WHATSAPP_VERIFY_PIN, SB_MANAGEMENT_TOKEN, SEND_EMAIL_HOOK_SECRET, THREADS_DEMO_MODE).
3. **Update `.env.example`** to mirror the new placeholder file (same keys, no values) so it stays the canonical reference.
4. **Point the SPA at api.postora.cloud everywhere.** The Supabase client (`src/integrations/supabase/client.ts`) already reads from `VITE_SUPABASE_URL` — no code change needed there. I'll grep-replace any **hardcoded** occurrences of `supabase.postora.cloud`, `efruibswazzuuupgyzmf.supabase.co`, or `efruibswazzuuupgyzmf` in:
   - `nginx.conf`
   - `src/hooks/*` (useBrandScrape, useWhatsApp*, useTikTokApiAnalytics, useMessaging)
   - `src/components/settings/IntegrationsSection.tsx`
   - `src/components/messaging/*` (4 files)
   - `src/integrations/__tests__/*`
   - `supabase/functions/manage-app-secrets/index.ts`
   - `supabase/config.toml` (project_id field — switch to a self-hosted sentinel)
   - `scripts/upload_logos.{ts,js}` and `scripts/deploy-oauth-fixes.sh`
   Replacement strategy: use `import.meta.env.VITE_SUPABASE_URL` (frontend) and `Deno.env.get("SUPABASE_URL")` (edge functions) instead of hardcoded hosts. Where a host literal is unavoidable (nginx, shell scripts), use `https://api.postora.cloud`.
5. **Edge-function URL helper.** Several hooks build URLs like `https://<ref>.supabase.co/functions/v1/...`. I'll route these through a single helper `src/lib/functionsUrl.ts` that returns `${VITE_SUPABASE_URL}/functions/v1/<name>`, and refactor the listed callers to use it. This way any future host change is one edit.
6. **Migrations & docs.** The 11 migration files and 6 doc files (`README.md`, `CLAUDE.md`, `AGENTS.md`, `API_REFERENCE.md`, `SECURITY-NOTES.md`, `LOVABLE-MIGRATION-INSTRUCTIONS.md`, `docs/*`) reference the old project ref in comments/examples. I will **not** rewrite historical migrations (they've already run on your DB and changing them breaks hash checks). I'll only update the docs and add a short "Host: api.postora.cloud" note to README.

## Out of scope (deliberately — to keep this PR focused)

- Seeding `app_settings`, `subscription_plans`, `user_roles` (your call once you decide on admin email).
- Deploying edge functions to the self-hosted edge-runtime.
- Updating OAuth redirect URIs in each platform's dev console (manual, on your side).
- Setting actual secret values (you'll do that in the new `.env`).
- Linking the Google Search Console connector (separate one-tool step; will do right after env switch).

## Technical details

- **Why `VITE_SUPABASE_PROJECT_ID` stays:** removing it would touch many files that read `import.meta.env.VITE_SUPABASE_PROJECT_ID` to construct URLs. Cleaner fix: keep the var but stop using it for URL construction (use `VITE_SUPABASE_URL` instead). The remaining reads become cosmetic logging.
- **`supabase/config.toml`** uses `project_id = "efruibswazzuuupgyzmf"`. For self-hosted this field is only used by the Supabase CLI to namespace local state — I'll change it to `project_id = "postora-self-hosted"`. No runtime impact.
- **Tests** in `src/integrations/__tests__/` will be updated to use a mocked `VITE_SUPABASE_URL` and stop asserting against the cloud host.
- After the changes land, the live preview will still 401 until you paste the new `ANON_KEY` JWT (from your self-hosted `.env`) into Lovable's `VITE_SUPABASE_PUBLISHABLE_KEY`. That's the single value that unblocks the whole app.

## File changes summary

```text
delete      .env
create      .env                        (placeholders)
update      .env.example                (mirror placeholders)
create      src/lib/functionsUrl.ts     (single source for /functions/v1 URLs)
update      src/hooks/useBrandScrape.ts
update      src/hooks/useWhatsAppCatalog.ts
update      src/hooks/useWhatsAppBusinessProfile.ts
update      src/hooks/useWhatsAppBroadcasts.ts
update      src/hooks/useTikTokApiAnalytics.ts
update      src/hooks/useMessaging.ts
update      src/components/settings/IntegrationsSection.tsx
update      src/components/messaging/WhatsAppDiagnostics.tsx
update      src/components/messaging/WhatsAppTemplatesContent.tsx
update      src/components/messaging/WhatsAppCatalogContent.tsx
update      src/components/messaging/ConversationDetail.tsx
update      src/integrations/__tests__/supabaseClient.test.ts
update      src/integrations/__tests__/integration.test.ts
update      supabase/functions/manage-app-secrets/index.ts
update      supabase/config.toml
update      nginx.conf
update      scripts/upload_logos.ts
update      scripts/upload_logos.js
update      scripts/deploy-oauth-fixes.sh
update      README.md / CLAUDE.md / AGENTS.md / API_REFERENCE.md / SECURITY-NOTES.md / LOVABLE-MIGRATION-INSTRUCTIONS.md / docs/OAUTH-TOKEN-REFRESH-GUIDE.md / docs/EXTERNAL-DEVELOPER-GUIDE.md
leave       supabase/migrations/*.sql   (historical, do not rewrite)
```

## After you approve

I will execute the file changes above, then tell you exactly which value to paste into `VITE_SUPABASE_PUBLISHABLE_KEY` so the preview comes back online. Then we can move to seeding the DB and linking the Google Search Console connector.