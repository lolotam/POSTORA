## Goal

Fix "AAL2 session required" error when MFA-enabled users change their password, and harden both password-change flows so they always go through proper verification (MFA challenge or email OTP) and a server-side update — never a raw client-side `auth.updateUser({ password })`.

## Current state (audit)

- **Logged-in change** (`src/components/settings/SecuritySection.tsx` + `src/components/profile/PasswordSection.tsx`) calls `supabase.auth.updateUser({ password })` directly from the browser. This is what fails with `AAL2 session is required…` when the user has a verified TOTP factor.
- **Forgot-password (outside app)** uses `send-reset-otp` → `verify-reset-otp` edge functions and a `password_reset_otps` table. `verify-reset-otp` already updates the password server-side with the service-role key, but the contract requires `mfaCode` for every user and the frontend (`ResetPassword.tsx`) currently only collects email + sends a magic link — the OTP UI path isn't actually wired in. `verify-mfa-reset` is disabled (HTTP 410).
- `check-user-mfa` exists and can report whether an email has a verified factor.
- OTP code hashing + `used` flag exist; need to confirm rate-limit + single-use + expiry are enforced and the response stays generic.

## Implementation plan

### A. New shared edge function: `change-password`
Single service-role endpoint that performs the final `supabase.auth.admin.updateUserById(userId, { password })`. It requires a valid user JWT and one of:
1. **AAL2 session** — caller's JWT already has `aal: "aal2"` from a fresh `mfa.challengeAndVerify`. Verified server-side via `getUser(jwt)` + decoding the AAL claim.
2. **Email-OTP proof** — `{ otp }` body, looked up in `password_reset_otps` (reused table, scoped by `purpose = 'change_password'` column added via migration) and matched against the caller's email. Only allowed when the user has **no verified MFA factor**.

Rate-limited via the existing `rate_limit_buckets` RPC (5/hour/user). Generic error responses. No password/OTP/token logging.

### B. Logged-in flow — `SecuritySection.tsx` & `PasswordSection.tsx`
Replace the direct `updateUser` call with a pre-flight that:
1. Calls `supabase.auth.mfa.listFactors()`.
2. **If a verified TOTP factor exists** → open a "Confirm with authenticator code" step → `mfa.challenge` + `mfa.verify` to upgrade the session to AAL2 → then POST to `change-password` with the new password.
3. **If no MFA factor** → POST to `send-change-password-otp` (new tiny wrapper around existing OTP issuance, scoped `purpose='change_password'`, sent to the user's own verified email) → user enters OTP → POST `change-password` with `{ otp, newPassword }`.
4. Google-only users with no password keep the same branching (they will always go via email-OTP since they can't have MFA without a password).

### C. Forgot-password flow — `ResetPassword.tsx` + `PasswordResetOptions.tsx`
Wire the existing UI to actually use the OTP edge functions instead of `resetPasswordForEmail`:
1. Email input → `send-reset-otp` → generic "If an account exists…" message.
2. OTP + new-password screen → `verify-reset-otp`.
3. Adjust `verify-reset-otp` so `mfaCode` is **only required when the account has a verified MFA factor** (call `check-user-mfa` internally). If MFA exists, prompt for TOTP code in the same screen and verify via admin MFA API; otherwise skip. Keeps MFA enforcement without leaking enrollment status (response is generic until OTP is valid).
4. Mark OTP `used=true`, delete sibling unused OTPs for that email atomically.

### D. SQL (only if missing — to be confirmed before writing)
Likely already exists, but if `password_reset_otps` lacks a `purpose text not null default 'reset'` column, add one **manual** migration file at `supabase/manual-sql/20260627xxxxxx_otp_purpose.sql`. No automatic execution. No other schema changes.

### E. Tests
- `src/lib/__tests__/passwordChangeFlow.test.ts` — assert frontend never calls `supabase.auth.updateUser({ password })` directly (regression guard).
- Edge function unit test for `change-password`: AAL1 + no OTP → 401; AAL2 → 200; OTP path with MFA-enrolled user → 403; valid OTP, no MFA → 200; reused OTP → 400; rate-limit exceeded → 429.
- Update `verify-reset-otp` test for conditional `mfaCode`.

### F. Validation
Run `npm run check:edge-env`, `npm run build`, `npm run lint`, `npx vitest run`, `git diff --check`, CleanCodeGuard, TestGuard.

## Out of scope

- Removing/altering `verify-mfa-reset` (stays disabled).
- Any change to n8n, OAuth, or unrelated edge functions.
- Direct SQL writes to `auth.users`.
- Restructuring the existing `rate_limit_buckets` or MFA enrollment flows.

## Deliverables

- New edge function `supabase/functions/change-password/index.ts` (+ test).
- New edge function `supabase/functions/send-change-password-otp/index.ts`.
- Updated `supabase/functions/verify-reset-otp/index.ts` (conditional MFA).
- Updated `src/components/settings/SecuritySection.tsx`, `src/components/profile/PasswordSection.tsx`, `src/pages/ResetPassword.tsx`, `src/components/auth/PasswordResetOptions.tsx`.
- Optional manual SQL file (only if `purpose` column missing).
- Final report with status `completed_requires_server_sync` (edge functions need volume sync + functions container restart on the VPS).
