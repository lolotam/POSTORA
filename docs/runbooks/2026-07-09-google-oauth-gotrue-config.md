# Runbook — Enable Google OAuth sign-in in GoTrue (auth provider)

**Date:** 2026-07-09
**Scope:** Server-side configuration only. No code changes, no edge function redeploy.
**Audience:** Operator with SSH access to the Contabo VPS.

---

## 1. Symptom

Calling the Google OAuth authorize endpoint:

```
GET https://api.postora.cloud/auth/v1/authorize?provider=google&redirect_to=https://postora.cloud/dashboard&scopes=openid%20email%20profile&include_granted_scopes=true
```

Returns:

```
400 validation_failed: "Unsupported provider: provider is not enabled"
```

## 2. Root cause

The GoTrue auth container (`auth` service) in the Supabase Docker Compose stack had **no Google external OAuth provider configuration**. The `.env` file contained `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` (used by edge functions for YouTube API OAuth), but GoTrue never read them because the `GOTRUE_EXTERNAL_GOOGLE_*` environment variables were missing from the GoTrue `environment:` block.

## 3. Files changed (server-side)

All paths are relative to the Dokploy compose directory:

```
/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code/
```

### 3.1 `.env` — added `GOOGLE_REDIRECT_URI`

```bash
# Added after GOOGLE_PROJECT_NUMBER= (line ~62)
GOOGLE_REDIRECT_URI=https://api.postora.cloud/auth/v1/callback
```

### 3.2 `docker-compose.yml` — added 4 GoTrue environment variables

Added in the `auth` service `environment:` block after `GOTRUE_EXTERNAL_PHONE_ENABLED`:

```yaml
GOTRUE_EXTERNAL_GOOGLE_ENABLED: ${GOOGLE_ENABLED}
GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID}
GOTRUE_EXTERNAL_GOOGLE_SECRET: ${GOOGLE_CLIENT_SECRET}
GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI: ${GOOGLE_REDIRECT_URI}
```

The existing `.env` values are reused:
- `GOOGLE_ENABLED=true`
- `GOOGLE_CLIENT_ID=422723670496-utf237ri9imn52cnben85ro49i80gkge.apps.googleusercontent.com`
- `GOOGLE_CLIENT_SECRET=<redacted>`

## 4. Redeploy

From the compose directory, recreate only the auth container:

```bash
cd /etc/dokploy/compose/postorasupabase-supabase-j8axyh/code
docker compose up -d --no-deps auth
```

## 5. Validation

```bash
curl -s -o /dev/null -w "%{http_code}" \
  "https://api.postora.cloud/auth/v1/authorize?provider=google&redirect_to=https://postora.cloud/dashboard&scopes=openid%20email%20profile&include_granted_scopes=true"
```

Expected: **302** (redirect to `accounts.google.com/o/oauth2/v2/auth`).

Before the fix this returned 400.

## 6. Google Cloud Console — manual step required

Add the GoTrue callback URL as an **Authorized redirect URI** in the Google OAuth 2.0 client:

1. Open [Google Cloud Console](https://console.cloud.google.com/) → **POSTORA** project
2. **APIs & Services → Credentials** → Edit the OAuth 2.0 client
3. Under **Authorized redirect URIs**, add:
   ```
   https://api.postora.cloud/auth/v1/callback
   ```
4. Save

Without this step, Google will reject the callback after the user consents (redirect_uri_mismatch).

## 7. Symptom 2 — bad_oauth_state after consent

After Google consent, the callback redirects to:

```
http://localhost:3000/?error=invalid_request&error_code=bad_oauth_state&error_description=OAuth+callback+with+invalid+state
```

### 7.1 Root cause

`SITE_URL=http://localhost:3000` in `.env`. GoTrue encodes `site_url` into the state JWT cookie. When the callback arrives at `api.postora.cloud/auth/v1/callback`, GoTrue validates the state — and the domain mismatch between the cookie's `site_url` (`localhost:3000`) and the live redirect causes the `bad_oauth_state` error.

Additionally, the redirect to `localhost` means no real users can complete sign-in.

### 7.2 Fix — update SITE_URL and ADDITIONAL_REDIRECT_URLS

```bash
# Change from:
SITE_URL=http://localhost:3000
ADDITIONAL_REDIRECT_URLS=https://api.postora.cloud/*,http://localhost:3000/*

# To:
SITE_URL=https://postora.cloud
ADDITIONAL_REDIRECT_URLS=https://api.postora.cloud/*,https://postora.cloud/*
```

Redeploy auth:

```bash
cd /etc/dokploy/compose/postorasupabase-supabase-j8axyh/code
docker compose up -d --no-deps auth
```

### 7.3 Validation

Inspect the state JWT in the authorize redirect — it should encode `"site_url":"https://postora.cloud"`:

```bash
curl -s "https://api.postora.cloud/auth/v1/authorize?provider=google&redirect_to=https://postora.cloud/dashboard&scopes=openid%20email%20profile&include_granted_scopes=true" \
  -o /dev/null -w "%{redirect_url}" \
  | grep -o 'state=[^&]*' | cut -d= -f2 \
  | python3 -c "import sys,base64,json; d=base64.urlsafe_b64decode(sys.stdin.read().strip()+'=='); print(json.loads(d))"
```

## 8. CRITICAL — Dokploy is the source of truth (config does NOT persist on disk)

Editing `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code/docker-compose.yml` or `.env` directly is **insufficient**. Dokploy stores the compose config in its Postgres DB (`compose` table, `composeId=YrlABDQZh5Z2fw8-gvTIv`, `autoDeploy=true`) and **rewrites those on-disk files on every redeploy**, discarding manual edits. This is exactly why the first fix (disk-only) reverted and the error returned.

**The persistent fix must be applied to the Dokploy DB, not the disk files.**

### 8.1 Apply the fix in Dokploy's Postgres (persists across redeploys)

```bash
# Dokploy Postgres credentials
DOKP_HOST=dokploy-postgres.1.<swarm-id>
DOKP_USER=dokploy
DOKP_DB=dokploy
DOKP_PASS=$(docker exec dokploy.<id> cat /run/secrets/postgres_password)

docker exec -e PGPASSWORD="$DOKP_PASS" "$DOKP_HOST" psql -U "$DOKP_USER" -d "$DOKP_DB" -c "
UPDATE compose
SET \"composeFile\" = REPLACE(
  \"composeFile\",
  'GOTRUE_EXTERNAL_PHONE_ENABLED: \${ENABLE_PHONE_SIGNUP}' || CHR(10) || '      GOTRUE_SMS_AUTOCONFIRM',
  'GOTRUE_EXTERNAL_PHONE_ENABLED: \${ENABLE_PHONE_SIGNUP}' || CHR(10) ||
  '      GOTRUE_EXTERNAL_GOOGLE_ENABLED: \${GOOGLE_ENABLED}' || CHR(10) ||
  '      GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID: \${GOOGLE_CLIENT_ID}' || CHR(10) ||
  '      GOTRUE_EXTERNAL_GOOGLE_SECRET: \${GOOGLE_CLIENT_SECRET}' || CHR(10) ||
  '      GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI: \${GOOGLE_REDIRECT_URI}' || CHR(10) ||
  '      GOTRUE_SMS_AUTOCONFIRM')
WHERE \"composeId\"='YrlABDQZh5Z2fw8-gvTIv';"

docker exec -e PGPASSWORD="$DOKP_PASS" "$DOKP_HOST" psql -U "$DOKP_USER" -d "$DOKP_DB" -c "
UPDATE compose
SET env = REPLACE(REPLACE(env,
  'ADDITIONAL_REDIRECT_URLS=https://api.postora.cloud/*,http://localhost:3000/*',
  'ADDITIONAL_REDIRECT_URLS=https://api.postora.cloud/*,https://postora.cloud/*'),
  'GOOGLE_CLIENT_SECRET=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' || CHR(10),
  'GOOGLE_CLIENT_SECRET=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' || CHR(10) || 'GOOGLE_REDIRECT_URI=https://api.postora.cloud/auth/v1/callback' || CHR(10))
WHERE \"composeId\"='YrlABDQZh5Z2fw8-gvTIv';"
```

### 8.2 Sync the on-disk files (so the immediate redeploy reads the same config) + redeploy

```bash
cd /etc/dokploy/compose/postorasupabase-supabase-j8axyh/code
# docker-compose.yml: insert the 4 google lines after GOTRUE_EXTERNAL_PHONE_ENABLED
sed -i '/GOTRUE_EXTERNAL_PHONE_ENABLED: ${ENABLE_PHONE_SIGNUP}/a\      GOTRUE_EXTERNAL_GOOGLE_ENABLED: ${GOOGLE_ENABLED}\n      GOTRUE_EXTERNAL_GOOGLE_CLIENT_ID: ${GOOGLE_CLIENT_ID}\n      GOTRUE_EXTERNAL_GOOGLE_SECRET: ${GOOGLE_CLIENT_SECRET}\n      GOTRUE_EXTERNAL_GOOGLE_REDIRECT_URI: ${GOOGLE_REDIRECT_URI}' docker-compose.yml
# .env: fix redirect allow-list + add GOOGLE_REDIRECT_URI
sed -i 's|ADDITIONAL_REDIRECT_URLS=https://api.postora.cloud/\*,http://localhost:3000/\*|ADDITIONAL_REDIRECT_URLS=https://api.postora.cloud/*,https://postora.cloud/*|' .env
sed -i '/^GOOGLE_CLIENT_SECRET=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$/a GOOGLE_REDIRECT_URI=https://api.postora.cloud/auth/v1/callback' .env
# Redeploy with the EXACT Dokploy project name (do not omit -p or it duplicates containers)
docker compose -p postorasupabase-supabase-j8axyh -f docker-compose.yml up -d --no-deps auth
```

### 8.3 Why the disk-only edit reverted

The DB `compose` row is the canonical config. Any Dokploy redeploy (`autoDeploy=true`, or a manual redeploy from the dashboard) regenerates the on-disk `docker-compose.yml`/`.env` from the DB, overwriting hand edits. Always edit the DB row (section 8.1) so the change survives.

## 9. Notes

- The same `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` is used for both **YouTube API OAuth** (edge functions) and **Google sign-in** (GoTrue). A separate OAuth client is not required.
- The YouTube OAuth uses `https://api.postora.cloud/functions/v1/youtube-oauth` as its redirect URI. Both URIs must be registered on the same Google Cloud client.
- GoTrue is `supabase/gotrue:v2.171.0` — provider config is **env-var only** (no `auth.configs` table in this version), so the `GOTRUE_EXTERNAL_GOOGLE_*` vars are mandatory.

## Final status

`google-oauth-signin-enabled`
