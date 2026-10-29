# Password change OTP email — implementation plan

Spec: [2026-10-29-password-change-otp-email-design.md](../specs/2026-10-29-password-change-otp-email-design.md).
Branch: `fix/password-change-otp-email`. Required reading: `ARCHITECTURE.md` §16, §17, §26, §35.

## Task 1 — owner: issue a working Resend key (blocking)

The owner creates the key in Resend, confirms `postora.cloud` is Verified, and sets
`RESEND_API_KEY` in the Dokploy compose environment. Never paste the key into chat or a commit.

## Task 2 — recreate the functions container and verify the key

With the owner's go-ahead, via `ssh-contabo-mcp`:
1. `docker compose up -d --no-deps --force-recreate functions` in the stack directory.
2. Compare SHA-256 prefixes of `.env` and container values; they must match.
3. `GET https://api.resend.com/domains` with the container key (piped in): expect 200, `postora.cloud` verified.

## Task 3 — classify Resend failures (code)

- New `supabase/functions/_shared/resendFailure.ts`: pure `describeResendFailure(error)`
  returns `{ statusCode, name, keyRejected }`, where `keyRejected` is true for
  `validation_error` with "API key is invalid", `missing_api_key` and `restricted_api_key`.
- `send-change-password-otp/index.ts`: on failure log
  `resend send failed (status, name)`, plus `RESEND_API_KEY rejected by Resend` when
  `keyRejected`. The response is unchanged.
- `send-reset-otp/index.ts`: the same distinct key-rejected line; the response is unchanged.
- Tests `_shared/resendFailure.test.ts`: invalid key, missing key, restricted key, domain
  not verified (not key-rejected), unknown shape.

## Task 4 — verify end to end

1. Deno tests and `deno lint` for the touched files.
2. Deploy the two functions and the shared file (copy, SHA-256 check, `docker compose up -d --no-deps functions`).
3. The owner runs the two UI flows in spec "Verification" (change password, forgot password).
4. Check the logs: no `resend send failed`.

## Task 5 — wrap up

Commit only the scoped files, push, open a draft PR, and report results and any remaining steps.
