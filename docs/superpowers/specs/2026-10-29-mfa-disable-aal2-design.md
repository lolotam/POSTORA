# Disabling 2FA fails with "AAL2 required to unenroll verified factor" — debugging spec

Status: root cause proven; fix awaiting approval. Branch: `fix/mfa-disable-aal2`.

## Symptom

Settings → Security → Two-factor authentication → disable shows the toast
**"Failed to disable 2FA — AAL2 required to unenroll verified factor"**. Profile → MFA has
the same button and the same failure.

## Evidence

1. Both disable handlers call `supabase.auth.mfa.unenroll({ factorId })` directly, with no
   step-up first:
   - `src/components/settings/SecuritySection.tsx` → `handleUnenrollMfa`
   - `src/components/profile/MFASection.tsx` → `handleUnenroll`
2. Supabase Auth only unenrolls a **verified** factor from a session at assurance level
   **AAL2**: the user signed in normally *and* passed an MFA factor in this session
   ([Supabase reference: unenroll a factor](https://supabase.com/docs/reference/kotlin/auth-mfa-unenroll),
   [GoTrue MFA API](https://doc.deno.land/https://esm.sh/@supabase/supabase-js@2.89.0/dist/index.d.mts/~/GoTrueMFAApi)).
3. A session that signed in without completing an MFA challenge, or that has been
   refreshed back to AAL1, is refused with exactly the message in the toast.
4. Unverified factors are not affected: the enroll flow's clean-up of half-finished factors
   (`SecuritySection.tsx`, during enrolment) works at AAL1 and stays as is.

## Root cause

The disable flow never raises the session to AAL2 before asking Supabase to remove a
verified factor.

## Fix

One shared step-up, used by both buttons:

1. Ask `supabase.auth.mfa.getAuthenticatorAssuranceLevel()`. If the current level is
   already `aal2`, unenroll directly (today's path).
2. Otherwise open a dialog asking for the 6-digit code from the authenticator app, then call
   `supabase.auth.mfa.challengeAndVerify({ factorId, code })`, which promotes the session to
   AAL2.
3. Unenroll the factor, then `supabase.auth.refreshSession()` so the session drops back to
   AAL1 at once rather than after the refresh interval
   ([Supabase MFA guide](https://supabase.com/docs/guides/auth/auth-mfa)).
4. A wrong or expired code keeps the dialog open with "Invalid code"; nothing is removed.

Placement (ARCHITECTURE.md §10–11): the step-up and unenroll live in one hook,
`useDisableMfa` (feature `src/features/mfa/`), with a small code dialog component. Both
`SecuritySection` and `MFASection` call it, so the rule exists once.

### Lost authenticator

A user who no longer has the app cannot produce a code, so this flow cannot help them. The
existing recovery path (backup codes / `verify-mfa-reset`) stays the way out; the dialog
links to it. No change to that path here.

## Out of scope

Recovery-flow changes, admin-side 2FA reset, and the AAL2 handling in the password-change
flow (already correct).

## Verification

- Vitest: with an AAL1 session the button asks for a code and calls `challengeAndVerify`
  before `unenroll`; with AAL2 it unenrolls directly; a wrong code removes nothing; after
  success `refreshSession` runs and the factor list reloads. The same behaviour holds from
  both entry points.
- Manual: sign in, open Settings → Security, disable 2FA, enter the authenticator code, and
  the factor is removed. Repeat from Profile.
