# Disable 2FA with an AAL2 step-up — implementation plan

Spec: [2026-10-29-mfa-disable-aal2-design.md](../specs/2026-10-29-mfa-disable-aal2-design.md).
Branch: `fix/mfa-disable-aal2`. Required reading: `ARCHITECTURE.md` §1, §8–11, §33, §35.

## Task 1 — step-up hook

`src/features/mfa/ui/useDisableMfa.ts`:
- `disable(factorId)`: reads the assurance level; at `aal2` it unenrolls; otherwise it sets
  `pendingFactorId` so the UI asks for a code.
- `submitCode(code)`: `challengeAndVerify` → `unenroll` → `refreshSession`. It returns typed
  outcomes: `disabled`, `invalid_code` or `failed` with a message.
- The Supabase calls go through a small adapter in `src/features/mfa/infrastructure/` (§11).

## Task 2 — code dialog

`src/features/mfa/ui/DisableMfaDialog.tsx`: a 6-digit input, Confirm and Cancel buttons, an
inline "Invalid code" message, and a link to the existing backup-code recovery. Strings go
through i18n, with Arabic entries.

## Task 3 — wire both entry points

Replace the direct `unenroll` calls in `SecuritySection.handleUnenrollMfa` and
`MFASection.handleUnenroll` with the hook and dialog. Their success and error toasts stay
the same. The enroll-time clean-up of unverified factors is not touched.

## Task 4 — tests

Vitest for the hook (AAL1 → code → disabled; AAL2 → disabled directly; invalid code → nothing
removed; refreshSession called) and for one entry point rendering the dialog.

## Task 5 — verify and ship

Run vitest, tsc, eslint and the Lint/i18n gate locally. Commit only the scoped files and
open a draft PR. Frontend only, so it deploys on merge. The owner then confirms the manual
check from Settings and from Profile.
