# Password change OTP email fails — debugging spec

Status: root cause proven; fixed on 2026-10-29 (new key, functions container recreated). Branch: `fix/password-change-otp-email`.

## Symptom

Settings → Security → Change password, for a user without an authenticator app:
`change-password` answers `otp_required`, the page calls `send-change-password-otp`, and it
shows "Could not send verification email" (the function's error).

## Evidence (2026-10-29, Contabo `86.48.2.205`)

1. **The code on the server is current.** `send-change-password-otp/index.ts`,
   `change-password/index.ts` and `_shared/rate-limiter.ts` in the functions volume match the
   repo byte for byte.
2. **The function fails at the email step.** Edge-function logs (72 h):
   ```
   serving the request with /home/deno/functions/send-change-password-otp
   [Error] send-change-password-otp: resend send failed
   ```
   That line runs after the auth, rate-limit, MFA and `password_reset_otps` insert steps all
   succeeded, so the database and the code path are fine up to Resend.
3. **Resend rejects the key.** `GET https://api.resend.com/domains` with the container's
   `RESEND_API_KEY` (piped in, never printed):
   `{"statusCode":400,"message":"API key is invalid","name":"validation_error"}`.
4. **Control:** an invented key gives the identical 400; no key gives
   `401 missing_api_key`. So the test is sound, and the real key is unknown to Resend
   (revoked or deleted), not malformed. Shape check: 36 chars, `re_` prefix, no quotes or
   whitespace.
5. **The `.env` key is invalid too.** Read straight from `code/.env`, it gets the same
   `400 validation_error`. *Correction (2026-10-29, after the fix):* an earlier version of this
   spec said `.env` and the container held different keys. That comparison was flawed: the
   `.env` hash included a trailing newline and the container hash did not, so it proves
   nothing either way. Whether a plain restart had left a stale value is unknown; the fix
   recreates the container regardless.
6. `EMAIL_FROM` is not set, so the sender is `Postora <noreply@postora.cloud>`.

## Root cause

`RESEND_API_KEY` is invalid on the server; the value in `.env` is invalid as well.

## Impact (wider than the reported bug)

Every function that sends through this key fails:
- `send-change-password-otp`: the reported error.
- `send-reset-otp` (forgot password): fails **silently**. It returns success to the
  browser by design (no account enumeration), so users wait for a code that never comes.
- `notify-admin-new-user`, inbox/WhatsApp-workspace email, and other Resend senders.

## Fix

### A. Operations (needs the owner's Resend account; cannot be done from code)

1. In the Resend dashboard, create an API key with sending access in the account that owns
   `postora.cloud`, and confirm the domain shows **Verified**.
2. Put it in the Dokploy compose environment for `postorasupabase-supabase-j8axyh` as
   `RESEND_API_KEY` (Dokploy writes `code/.env` from that; editing the file alone is lost on
   redeploy). Optionally set `EMAIL_FROM="Postora <noreply@postora.cloud>"`.
3. **Recreate** the functions container so it reads the new value:
   `docker compose up -d --no-deps --force-recreate functions` (a restart is not enough).
4. Verify the key without sending mail: `GET /domains` with the container's key returns 200
   and `postora.cloud` is `verified`.

### B. Code hardening (small, this branch)

The failure was only diagnosable from the server, because the change-password function
logs no reason.
- `send-change-password-otp`: log Resend's `statusCode` and `name` (not secret) on failure,
  matching `send-reset-otp`.
- Both functions: when Resend reports an invalid or missing key (`validation_error`,
  `missing_api_key`, `restricted_api_key`), log one distinct line
  (`RESEND_API_KEY rejected by Resend`) so the cause is obvious next time.
- No change to what the browser sees. The reset flow keeps its anti-enumeration response.

## Verification ("confirm it's working")

1. `GET /domains` with the container's key returns 200.
2. Settings → Security → Change password with a non-MFA account: the code email arrives and
   entering it changes the password ("Password changed!").
3. Forgot password on the sign-in page: the reset code email arrives.
4. Logs show no `resend send failed` for those calls.
5. Deno tests for the new log classification pass.

## Also found, out of scope

`password_reset_otps.purpose` (with its CHECK constraint) exists in production, per the
baseline dump, but no migration in the repo creates it. That is schema drift for a separate
change.
