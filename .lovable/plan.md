## Final OAuth Matrix Audit — Plan

A read-only audit pass. Only one small safe change is proposed: completing missing placeholders in `.env.example`. No code, no DB, no provider-console action will be performed automatically.

### Scope

- Verify unification status for all 13 OAuth platforms.
- Run static greps for legacy hosts/typos.
- Confirm `.env.example` coverage for all unified redirect URIs.
- Produce provider-console + redeploy checklists.
- Do NOT touch Facebook, WhatsApp Embedded Signup, `n8n-api`, or `public/n8n-complete-workflow.json`.

### Pre-audit findings (already collected)

**Legacy host grep** (`.supabase.co/functions/v1`, `supabase.postora.cloud`, `efruibswazzuuupgyzmf`, `thread-oauth`, `instgram`, `Reddit-oauth`, `linkedin-page-oauth`):
- All hits are in allowed locations only:
  - `supabase/migrations/*.sql` — historical migrations (must not be edited).
  - `src/integrations/__tests__/supabaseClient.test.ts` — intentional regression test.
  - `public/n8n-complete-workflow.json` — protected n8n artifact; flagged as "n8n artifact needs separate compatibility review".
- No live `src/` or live edge-function code contains legacy hosts.

**Edge-function env-driven redirects** (resolved via `Deno.env.get(...) ?? https://api.postora.cloud/functions/v1/<name>-oauth`):
- `tiktok-oauth` → reads `TIKTOK_REDIRECT_URI` ✅
- `pinterest-oauth` → reads `PINTEREST_REDIRECT_URI` ✅
- `threads-oauth` → reads `THREADS_REDIRECT_URI` ✅
- `instagram-oauth`, `instagram-business-oauth`, `linkedin-oauth`, `youtube-oauth`, `reddit-oauth`, `bluesky-oauth` ✅
- `twitter-oauth` → redirect URI is **hardcoded** to `https://api.postora.cloud/functions/v1/twitter-oauth` (already correct, but not env-driven). Minor inconsistency — not changed in this audit per "no large changes" rule. Flagged in report.

**`.env.example` current coverage**: has INSTAGRAM, INSTAGRAM_BUSINESS, YOUTUBE, LINKEDIN, REDDIT, BLUESKY.
**Missing placeholders**: `TIKTOK_REDIRECT_URI`, `PINTEREST_REDIRECT_URI`, `THREADS_REDIRECT_URI`, `TWITTER_REDIRECT_URI`.

### The one proposed change

Append the 4 missing placeholders to `.env.example` (no inline comments, no real values), grouped near existing OAuth redirect block:

```
TIKTOK_REDIRECT_URI=https://api.postora.cloud/functions/v1/tiktok-oauth
PINTEREST_REDIRECT_URI=https://api.postora.cloud/functions/v1/pinterest-oauth
THREADS_REDIRECT_URI=https://api.postora.cloud/functions/v1/threads-oauth
TWITTER_REDIRECT_URI=https://api.postora.cloud/functions/v1/twitter-oauth
```

Nothing else will be edited.

### Validation steps (build mode)

1. `bunx tsgo --noEmit` (typecheck).
2. `git diff --check`.
3. Re-run the full grep set to confirm only allowed legacy refs remain.
4. CleanCodeGuard: `.env.example` only — trivial doc change.
5. TestGuard: no test files changed → state "no test-code review required".

### Final report sections

The report will include:

1. **Summary** — OAuth unification ready, with Facebook + WhatsApp + n8n artifact documented exceptions.
2. **OAuth provider matrix** — 13-row table with platform, status, backend callback, frontend return, source hook, source edge function, env vars, provider action, legacy URL keep/remove, notes.
3. **Exceptions** — Facebook (Supabase provider_token + Pages selector), WhatsApp (Embedded Signup FB SDK), n8n artifact (`public/n8n-complete-workflow.json`).
4. **Files changed** — `.env.example` only (or none if not approved).
5. **Database changes** — none.
6. **Validation results** — typecheck/lint/build/tests/grep/git diff.
7. **Guard review results**.
8. **Security/secrets check** — confirmed no secrets exposed (placeholders only).
9. **Provider console checklist** — exact backend URL per provider, scopes, legacy URL keep/remove timing.
10. **Edge function deployment checklist** — only functions actually modified in prior tasks (tiktok, pinterest, threads, instagram, instagram-business, linkedin, youtube, reddit, bluesky). whatsapp-oauth/webhook only if changed.
11. **Remaining blockers** — none (Facebook + WhatsApp are documented exceptions, not blockers).
12. **Final status** — `ready_with_documented_exceptions`.

### Out of scope

- Facebook custom-redirect migration (future task).
- WhatsApp Embedded Signup redesign.
- `n8n-api` and `public/n8n-complete-workflow.json` rewrites.
- Twitter env-driven refactor (flag only).
- Any DB migration or SQL execution.
