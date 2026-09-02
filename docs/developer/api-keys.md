# API Keys — Lifecycle

There is no self-service UI for partner keys in v1. All lifecycle operations are operator-run.

## Issue

Operator runs `scripts/create-partner-key.ts` with `--token <user JWT>` (or `SUPABASE_USER_JWT`) plus `--workspace`, `--account`, `--name`, `--scopes`, `--quota`, `--environment`. The service-role key is refused. The plaintext is printed once; only `key_hash` and `key_prefix` are persisted. The account must be an active WhatsApp account in that workspace.

Contact your operator with the workspace, the `acc_` account to bind, and the generic scopes you need (see `scopes.md`). You will receive a `pk_live_REPLACE_ME` or `pk_test_REPLACE_ME`.

## Rotate with overlap

Rotation has built-in overlap via `scripts/rotate-partner-key.ts --overlap <minutes>` (default 60, maximum 43200 = 30 days, never extends an existing `expires_at`). The old key's `expires_at` is set to the end of the window; it stops authenticating when the window closes.

1. Operator runs `scripts/rotate-partner-key.ts --key <uuid> --overlap 60 --token <user JWT>`.
2. Deploy the new key (plaintext shown once) before the deadline printed by the script.
3. After the deadline the old key is expired; no revocation step is needed.

During overlap both keys are valid.

## Revoke

Revocation sets `revoked_at` and immediately returns `key_revoked` 401. It is one-way.

## What a partner must do at rotation

- Never log the plaintext.
- Update the `x-postora-key` header in all callers before the overlap deadline.
- Deploy within the window; if the old key was already time-boxed to sooner, the earlier deadline wins.

Reference: `scripts/create-partner-key.ts`, `supabase/functions/_shared/partnerApiKeys.ts`.
