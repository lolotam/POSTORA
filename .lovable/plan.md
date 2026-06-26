# Plan: Google OAuth — Test-mode runbook + Verification submission checklist (completed 2026-06-26)

Documentation only. No code, no SQL, no env, no Edge Function redeploy, no SSH, no n8n changes.

## Files created

- `docs/runbooks/2026-06-26-google-oauth-unverified-test-mode.md` — Test-mode bypass runbook. Final status: `ready_for_real_oauth_test`.
- `docs/runbooks/2026-06-26-google-oauth-verification-submission-checklist.md` — Verification submission checklist. Final status: `ready_for_provider_console_update`.

## Confirmation

- No code changes.
- No SQL / migrations.
- No `.env`, secrets, Dokploy, or Docker changes.
- No SSH or server actions.
- No n8n changes.
- No edits to existing privacy/terms pages.

## Key manual Google Console actions (owner)

1. Add Test Users (APIs & Services → OAuth consent screen → Test users).
2. Use **Advanced → Go to POSTORA (unsafe)** to bypass the warning while in Testing.
3. When ready: PUBLISH APP → PREPARE FOR VERIFICATION → SUBMIT.
4. Upload unlisted demo video URL into verification form.
5. Fill scope justifications (`youtube.readonly`, `youtube.upload` only — never the broad `youtube`).
6. Verify `postora.cloud` domain ownership in Search Console under the Cloud-project-owner Google account.
7. Respond to Google reviewer emails within 7 days each.

## Prior context (kept for reference)

The `kong:8000` redirect-leak runbook from earlier in the day (`docs/runbooks/2026-06-26-fix-kong-redirect-leak.md`) remains valid and unchanged.

## Final status

`completed`
