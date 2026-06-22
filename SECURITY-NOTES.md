> **⚠️ Self-hosted migration notice (2026-06):** This project now runs on a **self-hosted Supabase** at `https://api.postora.cloud`. Any reference below to `efruibswazzuuupgyzmf`, `efruibswazzuuupgyzmf.supabase.co`, or `supabase.postora.cloud` is **historical only** and does not reflect runtime configuration. Runtime URLs come from `VITE_SUPABASE_URL` / `SUPABASE_URL`.

# Security Notes

This document explains how secrets and environment configuration are handled in
this repository. Read it before adding new environment variables or rotating
credentials.

## `.env` is local only

- The real `.env` file is **never** tracked by git.
- `.gitignore` ignores it and every `.env.*` variant, except the template:
  ```
  .env
  .env.*
  !.env.example
  ```
- If you need local configuration, copy the template and fill in real values:
  ```bash
  cp .env.example .env
  ```
  Never edit `.env.example` with real secret values.

## `.env.example` is the safe template

`.env.example` is committed on purpose. It contains **only**:

- Non-secret placeholder values (e.g. `YOUR_SELF_HOSTED_SUPABASE_ANON_KEY`).
- Public URL defaults (e.g. `https://supabase.postora.cloud`).

Do not put real keys, JWTs, service-role keys, or passwords in `.env.example`.

## Rotate anything that was ever committed

Earlier commits in this repository contained real credentials (legacy Supabase
project reference, anon JWTs, and other secrets). Treat **all** previously
committed secrets as compromised, regardless of the cleanup performed here.

Before the final production cutover to `https://postora.cloud`:

1. Rotate the self-hosted Supabase anon/publishable key and the service-role key.
2. Rotate any OAuth client secrets stored in Supabase secrets (Edge Functions).
3. Rotate the database password and any `JWT_SECRET`.
4. Confirm the new values are only ever stored locally in `.env` or in the
   self-hosted Supabase secret store — never in git.

> Note: this task removes `.env` from the git index going forward and refactors
> hardcoded values out of code. It does **not** rewrite git history. The old
> secrets remain in historical commits and must be rotated independently.

## Self-hosted Supabase endpoints

- Supabase API / Kong gateway: `https://supabase.postora.cloud`
- Supabase Studio (admin): configure via `VITE_SUPABASE_STUDIO_URL`, default
  `https://supabase.postora.cloud`.

The frontend (API/Storage client) uses `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY` only. Server-side scripts that need elevated
access use `SUPABASE_SERVICE_ROLE_KEY`, which must **not** be committed or
exposed to the browser.
