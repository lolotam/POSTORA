## Goal

Refine the prior cutover. The frontend is already pointing at `https://api.postora.cloud` and live code is free of the old cloud ref — this iteration tightens env naming compatibility, adds the helper + missing secrets, hardens `manage-app-secrets` for self-hosted, refreshes docs, and runs validation greps.

## Already done (from prior turn — won't redo)

- Old `.env` deleted; new `.env` + `.env.example` created with placeholders at `api.postora.cloud`.
- `nginx.conf`, `scripts/upload_logos.{ts,js}`, `scripts/deploy-oauth-fixes.sh`, `supabase/config.toml` (`project_id = "postora-self-hosted"`), and `supabase/functions/manage-app-secrets/index.ts` (`PROJECT_REF` env-driven) updated.
- Live-code grep confirmed clean of `efruibswazzuuupgyzmf` and `supabase.postora.cloud` (only remaining match is a test asserting the cloud ref is absent — correct).

## Changes in this pass

### 1. Expand `.env` and `.env.example` (placeholders only, mirrored)

Add the additional variables the user listed so naming compatibility is covered both ways. Final placeholder set:

**Supabase (frontend + server, both naming patterns):**
```
VITE_SUPABASE_URL=https://api.postora.cloud
VITE_SUPABASE_PUBLISHABLE_KEY=
VITE_SUPABASE_ANON_KEY=
VITE_SUPABASE_STUDIO_URL=https://api.postora.cloud
VITE_SUPABASE_PROJECT_ID=self-hosted   # cosmetic only
SUPABASE_URL=https://api.postora.cloud
SUPABASE_ANON_KEY=
SUPABASE_PUBLISHABLE_KEY=
SUPABASE_SERVICE_ROLE_KEY=
SUPABASE_JWT_SECRET=
DATABASE_URL=
SUPABASE_DB_URL=
SB_MANAGEMENT_TOKEN=
SUPABASE_PROJECT_REF=self-hosted
```
With a comment: *"`VITE_SUPABASE_PUBLISHABLE_KEY` and `VITE_SUPABASE_ANON_KEY` must hold the same self-hosted anon JWT until the codebase standardizes on one variable."*

**Platform / integration secrets (all empty placeholders):**
ACRCLOUD_HOST / ACCESS_KEY / ACCESS_SECRET · APIFY_API_TOKEN · ATLASCLOUD_API_KEY · CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET · FACEBOOK_APP_ID/SECRET · INSTAGRAM_APP_ID/SECRET · THREADS_APP_ID/SECRET / DEMO_MODE / WEBHOOK_VERIFY_TOKEN · FACEBOOK_GRAPH_API_VERSION=v22.0 · GOOGLE_CLIENT_ID/SECRET · GOOGLE_AI_STUDIO_KEY · TIKTOK_CLIENT_KEY/SECRET · TWITTER_CLIENT_ID/SECRET · X_CLIENT_ID/SECRET (added) · LINKEDIN_CLIENT_ID/SECRET · PINTEREST_CLIENT_ID/SECRET · OPENAI_API_KEY · OPENROUTER_API_KEY · **LOVABLE_API_KEY** (added) · RESEND_API_KEY / WEBHOOK_SECRET · SEND_EMAIL_HOOK_SECRET · STRIPE_SECRET_KEY / WEBHOOK_SECRET · UNSPLASH_ACCESS_KEY · GIPHY_API_KEY · PEXELS_API_KEY · PIXABAY_API_KEY · KLIPY_API_KEY · **WHATSAPP_ACCESS_TOKEN / PHONE_NUMBER_ID / BUSINESS_ACCOUNT_ID / VERIFY_PIN / WEBHOOK_VERIFY_TOKEN** (expanded) · **SLACK_API_KEY** (added).

The prior X_API_KEY/X_API_SECRET names will be **kept alongside** X_CLIENT_ID/X_CLIENT_SECRET with a comment that they're aliases, so we don't break any code that still reads either name.

### 2. Create `src/lib/functionsUrl.ts`

```ts
// Single source of truth for Edge Function URLs on the self-hosted instance.
export function functionsUrl(name: string): string {
  const base = import.meta.env.VITE_SUPABASE_URL;
  if (!base) throw new Error("VITE_SUPABASE_URL is not configured");
  return `${base.replace(/\/$/, "")}/functions/v1/${name}`;
}
```

Then **search for and refactor** any frontend caller that builds a function URL manually (pattern `.supabase.co/functions/v1/` or `${...PROJECT_ID}.supabase.co/functions/v1/`). Prior grep showed **zero current callers** in `src/` — most code uses `supabase.functions.invoke()`. The helper still ships so future hand-built URLs have one place to go.

### 3. Tests

Update `src/integrations/__tests__/supabaseClient.test.ts` and `integration.test.ts` to:
- Mock `import.meta.env.VITE_SUPABASE_URL = "https://api.postora.cloud"` and `VITE_SUPABASE_PUBLISHABLE_KEY = "test-anon"`.
- Keep the existing assertion that the source does **not** contain `efruibswazzuuupgyzmf` (it now serves as a regression guard).

### 4. Harden `supabase/functions/manage-app-secrets/index.ts`

The function calls `https://api.supabase.com/v1/projects/{ref}/secrets` — that's cloud-only. Add a guard at request entry:

```ts
const mgmtToken = Deno.env.get("SB_MANAGEMENT_TOKEN");
if (!mgmtToken || PROJECT_REF === "self-hosted") {
  return new Response(JSON.stringify({
    success: false,
    error_code: "management_api_unavailable",
    message: "Self-hosted Supabase: secrets must be managed via the host .env / Dokploy. Set SB_MANAGEMENT_TOKEN and SUPABASE_PROJECT_REF to enable remote management.",
  }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
```
(Matches the project's "return 200 + structured error" memory rule.)

### 5. `supabase/config.toml`

Already changed to `project_id = "postora-self-hosted"`. Add a one-line comment above it: *"local CLI namespace only — does not affect runtime."*

### 6. Docs

Update only **active** docs (no rewriting historical migrations or old release notes):
- `README.md`: change "Supabase Backend" line to `Self-hosted Supabase at https://api.postora.cloud`; replace any `efruibswazzuuupgyzmf` runtime reference with `postora-self-hosted` and a "historical only" callout where the ref is shown for archival reasons.
- `CLAUDE.md`, `AGENTS.md`, `API_REFERENCE.md`, `SECURITY-NOTES.md`, `LOVABLE-MIGRATION-INSTRUCTIONS.md`, `docs/OAUTH-TOKEN-REFRESH-GUIDE.md`, `docs/EXTERNAL-DEVELOPER-GUIDE.md`: same treatment — host swap + historical tag on cloud refs. No migration files touched.

### 7. Validation (run after edits)

```bash
grep -R "efruibswazzuuupgyzmf"            . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=playwright-report --exclude-dir=test-results
grep -R "supabase.postora.cloud"          . --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=playwright-report --exclude-dir=test-results
grep -R "efruibswazzuuupgyzmf.supabase.co" . --exclude-dir=node_modules --exclude-dir=.git
grep -R ".supabase.co/functions/v1"       src supabase scripts --exclude-dir=node_modules
```
Expected outcome:
- First three: hits only in `supabase/migrations/*.sql` (historical), in archived markdown clearly marked `<!-- historical -->`, and in the regression test that asserts the string is absent from `client.ts`.
- Fourth: zero hits.
TypeScript build runs automatically; I'll fix anything it surfaces.

## Out of scope (still)

- Real secret values (you'll fill them in).
- Deploying edge functions to the self-hosted edge-runtime.
- Updating OAuth redirect URIs in each platform's dev console.
- Seeding `app_settings` / `subscription_plans` / `user_roles`.
- Linking the Google Search Console connector (next pass, single tool call).

## Final reminder you'll see after execution

> The single runtime value you must paste to unblock the preview is:
> ```
> VITE_SUPABASE_PUBLISHABLE_KEY=<your self-hosted anon JWT>
> VITE_SUPABASE_ANON_KEY=<same value>
> ```
> Until this is set, the live preview will return **401 Invalid authentication credentials** on every Supabase request — that's expected, not a code bug.

I will not echo, log, or commit any real secret values.