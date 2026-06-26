# Plan: Google OAuth — Test-mode runbook + Verification submission checklist

Documentation only. **No code, no SQL, no env, no Edge Function redeploy, no SSH, no n8n changes.**

Lovable cannot perform any Google Cloud Console action — both deliverables are checklists the owner executes manually.

---

## Deliverable 1 — `docs/runbooks/2026-06-26-google-oauth-unverified-test-mode.md`

Lets you and teammates connect YouTube today, without waiting for Google's review.

Sections:

1. **What this screen means** — Not a Postora bug; the YouTube OAuth redirect, token exchange, and callback are working (confirmed by the prior `kong:8000` fix). Wording (verbatim):
   > "The warning can appear when the app is still in Testing or when the app requests sensitive/restricted scopes before the relevant OAuth verification is fully completed."
   Plus a note that **"Branding verified" is not necessarily the same as "sensitive-scope verification completed"** — the app can show verified branding while the YouTube sensitive-scope verification still needs to be done.
2. **Who is affected** — Any Gmail not on the Test Users list while Publishing status = Testing.
3. **Add Test Users** — Cloud Console path: APIs & Services → OAuth consent screen → Test users → + ADD USERS (up to 100). Owner-only action.
4. **Bypass path for added test users** — Advanced → Go to POSTORA (unsafe) → normal consent → tokens land in Postora.
5. **Limits of Testing mode** — 100 user cap; refresh-token wording (verbatim):
   > "For External apps in Testing, refresh tokens can expire after 7 days when requested scopes are broader than only openid/email/profile."
6. **Validation** — Real test-user connect; row in `social_accounts` with `needs_reauth=false`; one test upload succeeds.
7. **Manual actions Lovable cannot perform** — Adding test users, clicking the Advanced bypass.
8. **Final status** — `ready_for_real_oauth_test`.

---

## Deliverable 2 — `docs/runbooks/2026-06-26-google-oauth-verification-submission-checklist.md`

Everything Google requires to remove the warning for all users and lift the 7-day refresh-token expiry.

Sections:

0. **Important — what Lovable cannot do** — explicit list: add test users, publish app, submit verification, upload demo video URL, fill scope justification, verify domain ownership, answer Google reviewer emails (within 7 days or request is closed).
1. **Pre-flight checklist** — Publishing status In production, app name, support/contact emails, 120×120 logo, homepage `https://postora.cloud`, privacy `/privacy` (must mention YouTube/Google data + Limited Use + deletion path), terms `/terms`, authorized domain `postora.cloud` verified in Search Console under the same Google account that owns the Cloud project. Reminder: branding-verified ≠ sensitive-scope-verified.
2. **Confirm actual requested scopes from code** — Open `supabase/functions/youtube-oauth/index.ts` and confirm it requests ONLY:
   - `https://www.googleapis.com/auth/youtube.readonly`
   - `https://www.googleapis.com/auth/youtube.upload`
   - `openid email profile` — **only if actually needed**
   And explicitly MUST NOT request the broad `https://www.googleapis.com/auth/youtube`. If present, narrow before submitting.
3. **Scope justifications** — Drop-in paragraph per sensitive scope (where it's called, why it's minimum-necessary, where tokens are stored, RLS by `auth.uid()`).
4. **Demo video requirements** — Unlisted YouTube, < 5 min, 6-shot storyboard: connect button → consent screen with all scopes visible → grant → return to Postora → exercise each sensitive scope (channel list, real upload) → revoke from `myaccount.google.com/permissions`.
5. **YouTube API Services compliance** — Link to YouTube API Services Terms in privacy policy, data-retention statement, user-data-deletion path, YouTube API audit form when requested.
6. **Submission form** — OAuth consent screen → PUBLISH APP → PREPARE FOR VERIFICATION → SUBMIT. Reviewer email cadence; 7-day response deadline.
7. **What changes after approval** — Warning gone; 7-day refresh expiry lifted; 100-user cap removed; branding fields lock.
8. **Rejection-recovery checklist** — Common reasons with one-line fixes (homepage unreachable, demo missing a scope, privacy policy missing YouTube section, domain not verified under right account, broad `youtube` scope still present).
9. **Manual actions Lovable cannot perform** — Cross-reference §1, §4, §5, §6, §8.
10. **Final status** — `ready_for_provider_console_update`.

---

## What this task will NOT do

- No changes to `youtube-oauth/index.ts` or any other edge function.
- No SQL, no migrations.
- No `.env` / secrets / Dokploy / Docker changes.
- No SSH or server actions.
- No n8n changes.
- No edits to existing privacy/terms pages (the checklist flags what YouTube-specific text Google will look for, but the owner decides and approves wording).

## Files created

- `docs/runbooks/2026-06-26-google-oauth-unverified-test-mode.md`
- `docs/runbooks/2026-06-26-google-oauth-verification-submission-checklist.md`
- `.lovable/plan.md` — index updated only because that file already exists and is used as the project plan index.

## Final report (will appear after files are written)

- **Files created** — the three above.
- **Confirmation** — no code, no SQL, no env, no server changes.
- **Key manual Google Console actions** — add test users; click Advanced → Go to POSTORA (unsafe); publish app; submit for verification; upload demo video URL; fill scope justifications; verify `postora.cloud` in Search Console; answer reviewer emails within 7 days.
- **Final status** — `completed`.
