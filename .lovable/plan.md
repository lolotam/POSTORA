# Plan: Server-side runbook to resolve `Error 400: invalid_request` (kong redirect leak)

## Root cause (confirmed)

The Google error URL decodes to:

```
redirect_uri = http://kong:8000/functions/v1/youtube-oauth
```

That is the **internal Docker Kong hostname**, which Google rightly rejects. The repo-side fix is already merged: `youtube-oauth` and the other 4 OAuth functions resolve `redirect_uri` from `PUBLIC_API_ORIGIN` first and only fall back to `SUPABASE_URL` for internal calls.

So the bug is **not in the code anymore** — it is in the running production container, which is either:

1. still running the **old code** (functions volume not synced), or
2. running the new code but with **no `PUBLIC_API_ORIGIN`** / **no `YOUTUBE_REDIRECT_URI`** in its env, so the new fallback chain still lands on `SUPABASE_URL` = `http://kong:8000`.

Lovable cannot SSH into the Contabo VPS or restart Docker containers, so this plan is a runbook for the project owner (or Zed) to execute on the server. No file changes in the repo.

## Deliverable

A single markdown runbook at `docs/runbooks/2026-06-26-fix-kong-redirect-leak.md` that the operator follows top-to-bottom on the Contabo VPS (`86.48.2.205`, Dokploy stack `postorasupabase-supabase-j8axyh`).

## Runbook contents (what the file will contain)

### 1. Pre-flight on the VPS

```bash
ssh contabo
cd /etc/dokploy/compose/postorasupabase-supabase-j8axyh
```

Confirm functions volume path:

```bash
ls files/volumes/functions/youtube-oauth/index.ts
```

### 2. Sync the 5 patched OAuth functions

From the repo (latest `main`), copy these 5 files into the functions volume:

```text
supabase/functions/youtube-oauth/index.ts
supabase/functions/linkedin-oauth/index.ts
supabase/functions/instagram-oauth/index.ts
supabase/functions/instagram-business-oauth/index.ts
supabase/functions/facebook-oauth/index.ts
```

Destination:

```text
/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/<name>/index.ts
```

Verify with `sha256sum` on both sides before continuing.

### 3. Confirm/append required env vars

Edit `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code/.env`. The following lines MUST exist and be uncommented:

```env
PUBLIC_API_ORIGIN=https://api.postora.cloud
YOUTUBE_REDIRECT_URI=https://api.postora.cloud/functions/v1/youtube-oauth
```

Optional but recommended (explicit per-provider URIs, removes any future ambiguity):

```env
FACEBOOK_REDIRECT_URI=https://api.postora.cloud/functions/v1/facebook-oauth
INSTAGRAM_REDIRECT_URI=https://api.postora.cloud/functions/v1/instagram-oauth
INSTAGRAM_BUSINESS_REDIRECT_URI=https://api.postora.cloud/functions/v1/instagram-business-oauth
LINKEDIN_REDIRECT_URI=https://api.postora.cloud/functions/v1/linkedin-oauth
```

Confirm `docker-compose.yml` `functions` service still has `env_file: - ./.env` (per project knowledge).

### 4. Restart ONLY the functions container

```bash
cd /etc/dokploy/compose/postorasupabase-supabase-j8axyh/code
docker compose up -d --no-deps functions
docker compose logs -f --tail=100 functions
```

Wait for "Serving functions" line, no boot errors.

### 5. Verify env reached the container

```bash
docker compose exec functions sh -lc 'echo PUBLIC_API_ORIGIN=$PUBLIC_API_ORIGIN; echo YOUTUBE_REDIRECT_URI=$YOUTUBE_REDIRECT_URI'
```

Both must print the `https://api.postora.cloud/...` values, NOT empty.

Then run the existing checker:

```bash
bash scripts/check-edge-env-server.sh
```

### 6. Verify the live OAuth URL

From a workstation, hit the function's authorize endpoint (or use the app's "Connect YouTube" button) and inspect the resulting Google URL. The `redirect_uri` query param must read:

```text
https://api.postora.cloud/functions/v1/youtube-oauth
```

If it still says `http://kong:8000/...`, the container is still on old code — re-run step 2 and restart.

### 7. Real OAuth round-trip

1. In the app, click "Connect YouTube" as `dr.vet.waleedtam@gmail.com`.
2. Confirm Google shows the consent screen (no Error 400).
3. Approve.
4. Confirm callback lands on `/profiles` and the new YouTube account row appears in `social_accounts` (via `supabase_postora_mcp`).
5. Repeat for Facebook / Instagram / Instagram Business / LinkedIn to confirm the same hardening took effect.

### 8. Rollback

If step 4 logs show boot errors, restore the previous `index.ts` files from `files/volumes/functions/<name>/index.ts.bak` (take backups before step 2) and re-run `docker compose up -d --no-deps functions`.

## Files changed in this task

- **NEW** `docs/runbooks/2026-06-26-fix-kong-redirect-leak.md` — the runbook above.

No source code, no SQL, no env manifest changes. The repo-side hardening is already done in a previous task.

## Database changes

None.

## Env changes required

None in the repo. On the **production VPS** `.env`, ensure the two `PUBLIC_API_ORIGIN` + `YOUTUBE_REDIRECT_URI` lines are present (step 3). They are already declared in `.env.example` and `infra/edge-runtime.required-env.json`.

## Deployment notes for self-hosted Supabase

Entirely covered by the runbook. Lovable cannot perform these steps; the project owner runs them on Contabo.

## Validation results

- Decoded the Google error URL → confirmed `redirect_uri=http://kong:8000/functions/v1/youtube-oauth`, which matches a server still using the `SUPABASE_URL` fallback (old code OR missing `PUBLIC_API_ORIGIN`).
- Repo code already hardened in prior turn — no further code changes needed.

## Guard review results

- CleanCodeGuard: doc-only change, not applicable.
- TestGuard: no test files changed; no test-code review required.

## Security check

No secrets, OAuth codes, access tokens, service-role keys, n8n keys, or cron secrets are written to the runbook. Only **non-secret** env var **names** and the public `https://api.postora.cloud/...` URLs appear.

## Remaining manual actions (owner on Contabo)

1. Sync 5 OAuth `index.ts` files to `files/volumes/functions/<name>/`.
2. Ensure `PUBLIC_API_ORIGIN` and `YOUTUBE_REDIRECT_URI` are set in production `.env`.
3. `docker compose up -d --no-deps functions`.
4. Run `scripts/check-edge-env-server.sh`.
5. Real OAuth test for YouTube + the other 4 providers.

## Final status

`completed_ready_for_server_sync` — runbook delivered; awaits manual execution on the Contabo VPS to clear the `kong:8000` redirect leak in production.
