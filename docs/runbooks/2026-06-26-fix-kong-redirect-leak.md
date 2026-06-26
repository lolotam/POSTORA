# Runbook: Fix `Error 400: invalid_request` / `kong:8000` redirect leak

**Date:** 2026-06-26
**Stack:** Dokploy `postorasupabase-supabase-j8axyh` on Contabo `86.48.2.205`
**Scope:** Self-hosted Supabase Edge Functions only. No DB changes.

## Symptom

Connecting YouTube (or any of the 5 OAuth providers) shows Google:

```
Access blocked: Authorization Error
Error 400: invalid_request
```

Decoding the Google error URL reveals:

```
redirect_uri = http://kong:8000/functions/v1/youtube-oauth
```

That is the **internal Docker Kong hostname**. Google refuses any non-public, non-HTTPS redirect_uri.

## Root cause

The repo-side fix is already merged: `youtube-oauth`, `facebook-oauth`,
`instagram-oauth`, `instagram-business-oauth`, and `linkedin-oauth` now resolve
`redirect_uri` from `PUBLIC_API_ORIGIN` first, and only fall back to
`SUPABASE_URL` for **internal** REST/Storage calls.

Production is still leaking `kong:8000` because the running **functions
container** is either:

1. still on the **old code** (functions volume not synced from the repo), or
2. on the new code but **without `PUBLIC_API_ORIGIN`** (and/or
   `YOUTUBE_REDIRECT_URI`) in its environment, so the new fallback chain still
   lands on `SUPABASE_URL` = `http://kong:8000`.

Both cases are fixed by the steps below. Lovable cannot SSH or restart
containers — this must be run on the VPS.

---

## 1. Pre-flight on the VPS

```bash
ssh contabo
cd /etc/dokploy/compose/postorasupabase-supabase-j8axyh
ls files/volumes/functions/youtube-oauth/index.ts
```

Take backups before touching anything:

```bash
for fn in youtube-oauth facebook-oauth instagram-oauth instagram-business-oauth linkedin-oauth; do
  cp -a "files/volumes/functions/$fn/index.ts" "files/volumes/functions/$fn/index.ts.bak.$(date +%Y%m%d%H%M%S)"
done
```

## 2. Sync the 5 patched OAuth functions

From the repo (latest `main`), copy these 5 files into the functions volume:

| Source (repo)                                                 | Destination (VPS)                                                                                  |
|---------------------------------------------------------------|----------------------------------------------------------------------------------------------------|
| `supabase/functions/youtube-oauth/index.ts`                   | `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/youtube-oauth/index.ts`                  |
| `supabase/functions/facebook-oauth/index.ts`                  | `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/facebook-oauth/index.ts`                 |
| `supabase/functions/instagram-oauth/index.ts`                 | `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/instagram-oauth/index.ts`                |
| `supabase/functions/instagram-business-oauth/index.ts`        | `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/instagram-business-oauth/index.ts`       |
| `supabase/functions/linkedin-oauth/index.ts`                  | `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/linkedin-oauth/index.ts`                 |

Verify with `sha256sum` on both sides before continuing:

```bash
sha256sum files/volumes/functions/youtube-oauth/index.ts
```

The hash must match the repo file.

## 3. Confirm/append required env vars

Edit `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code/.env`. The
following lines MUST exist and be uncommented:

```env
PUBLIC_API_ORIGIN=https://api.postora.cloud
YOUTUBE_REDIRECT_URI=https://api.postora.cloud/functions/v1/youtube-oauth
```

Recommended (explicit per-provider URIs — removes any future ambiguity):

```env
FACEBOOK_REDIRECT_URI=https://api.postora.cloud/functions/v1/facebook-oauth
INSTAGRAM_REDIRECT_URI=https://api.postora.cloud/functions/v1/instagram-oauth
INSTAGRAM_BUSINESS_REDIRECT_URI=https://api.postora.cloud/functions/v1/instagram-business-oauth
LINKEDIN_REDIRECT_URI=https://api.postora.cloud/functions/v1/linkedin-oauth
```

Confirm the `functions` service in `docker-compose.yml` still has:

```yaml
env_file:
  - ./.env
```

(per project knowledge — Docker Compose `.env` does NOT auto-inject into
containers without `env_file:` or `environment:` mappings).

## 4. Restart ONLY the functions container

```bash
cd /etc/dokploy/compose/postorasupabase-supabase-j8axyh/code
docker compose up -d --no-deps functions
docker compose logs -f --tail=100 functions
```

Wait for "Serving functions" with no boot errors, then Ctrl-C the log follow.

## 5. Verify env actually reached the container

```bash
docker compose exec functions sh -lc 'echo PUBLIC_API_ORIGIN=$PUBLIC_API_ORIGIN; echo YOUTUBE_REDIRECT_URI=$YOUTUBE_REDIRECT_URI'
```

Both must print the `https://api.postora.cloud/...` values — **not empty**.

Then run the existing checker:

```bash
bash scripts/check-edge-env-server.sh
```

## 6. Verify the live OAuth URL

From a workstation, click "Connect YouTube" in the app and **inspect the
resulting Google URL** (browser address bar, before approving). The
`redirect_uri` query param must read:

```
https://api.postora.cloud/functions/v1/youtube-oauth
```

If it still says `http://kong:8000/...`, the container is still on old code or
env did not load — re-do steps 2-4.

## 7. Real OAuth round-trip

1. Sign in as `dr.vet.waleedtam@gmail.com`.
2. Click "Connect YouTube" — Google consent screen must appear (no Error 400).
3. Approve.
4. Callback must land on `/profiles`; new row must appear in `social_accounts`
   (verify via `supabase_postora_mcp`).
5. Repeat for Facebook, Instagram, Instagram Business, and LinkedIn to confirm
   the same `PUBLIC_API_ORIGIN` hardening took effect on all five.

## 8. Rollback

If step 4 logs show boot errors:

```bash
cd /etc/dokploy/compose/postorasupabase-supabase-j8axyh
for fn in youtube-oauth facebook-oauth instagram-oauth instagram-business-oauth linkedin-oauth; do
  cp -a "files/volumes/functions/$fn/index.ts.bak."* "files/volumes/functions/$fn/index.ts"
done
cd code
docker compose up -d --no-deps functions
```

---

## Why this fixes it

The patched code (already in `main`) computes the OAuth redirect like:

```ts
const PUBLIC_API_ORIGIN =
  Deno.env.get("PUBLIC_API_ORIGIN") ?? "https://api.postora.cloud";
const redirectUri =
  Deno.env.get("YOUTUBE_REDIRECT_URI") ??
  `${PUBLIC_API_ORIGIN}/functions/v1/youtube-oauth`;
```

`SUPABASE_URL` (which resolves to `http://kong:8000` inside Docker) is no longer
in the redirect fallback chain — it is preserved only for the internal
`createClient(...)` REST/Storage calls. Once the container is on this code with
`PUBLIC_API_ORIGIN` set, `kong:8000` cannot leak to Google again.

## Final status

`completed_ready_for_server_sync`
