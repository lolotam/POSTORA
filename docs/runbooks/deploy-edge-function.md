# Deploy Edge Function to Self-Hosted Supabase

Dokploy auto-redeploys the **frontend** (`postora` app) on every push. It does **not** touch the edge-functions volume of the self-hosted Supabase stack. After any change under `supabase/functions/*`, follow this runbook to make it live on `https://api.postora.cloud`.

Run on the Contabo VPS (`86.48.2.205`) via `ssh-contabo-mcp` or a normal SSH session.

---

## Paths (constant)

```bash
REPO=/root/postora       # adjust if your git checkout lives elsewhere
VOL=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions
STACK=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code
```

---

## 1. One-function deploy (common case)

Just changed `supabase/functions/linkedin-oauth/index.ts`? Paste this, swap `FN`:

```bash
FN=linkedin-oauth

cd "$REPO" && git pull --ff-only
rsync -av --delete "$REPO/supabase/functions/$FN/" "$VOL/$FN/"

# Verify file hash matches between repo and volume
sha256sum "$REPO/supabase/functions/$FN/index.ts" "$VOL/$FN/index.ts"

# Restart ONLY the functions container (do not restart the whole stack)
cd "$STACK" && docker compose up -d --no-deps functions

# Tail logs and confirm the function loaded cleanly
docker compose logs --tail=80 functions | grep -i "$FN"
```

The two `sha256sum` lines must print identical hashes. If they don't, the rsync didn't land — re-run it.

---

## 2. All-functions deploy (refactor touched many)

```bash
cd "$REPO" && git pull --ff-only
rsync -av --delete "$REPO/supabase/functions/" "$VOL/"
cd "$STACK" && docker compose up -d --no-deps functions
docker compose logs --tail=120 functions
```

`--delete` removes functions in the volume that no longer exist in the repo. Skip the `--delete` flag if you want to leave orphaned functions in place.

---

## 3. Smoke tests

Public health (no auth needed):

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://api.postora.cloud/functions/v1/get-public-config
# expect 200
```

OAuth `authorize` (replace `<FN>` with `linkedin-oauth`, `tiktok-oauth`, etc.) — should be reachable, not 404:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS https://api.postora.cloud/functions/v1/<FN>
# expect 200 (CORS preflight)
```

UI check for OAuth fixes: open `https://postora.cloud/profiles`, click **Connect <Provider>**. Expected: immediate redirect to the provider's authorization URL (e.g. `https://www.linkedin.com/oauth/v2/authorization?...`). If it bounces back with a toast, tail logs:

```bash
cd "$STACK" && docker compose logs -f functions | grep -i <FN>
```

---

## 4. Rollback

```bash
FN=linkedin-oauth
cd "$REPO"
git log --oneline supabase/functions/$FN/        # find the prior good SHA
git checkout <prev-sha> -- supabase/functions/$FN/
rsync -av --delete "$REPO/supabase/functions/$FN/" "$VOL/$FN/"
cd "$STACK" && docker compose up -d --no-deps functions
```

After verifying the rollback works, restore the repo to `HEAD` with `git checkout HEAD -- supabase/functions/$FN/` so future Lovable edits aren't based on stale code.

---

## 5. Env sanity (only if logs show `X not configured`)

Do **not** echo secret values. Confirm the var exists in the stack `.env`:

```bash
grep -E '^<VAR_NAME>=' "$STACK/.env" >/dev/null && echo present || echo MISSING
```

If missing, add it to `$STACK/.env`, then follow `docs/EDGE_RUNTIME_ENV_RUNBOOK.md` (the `functions` service uses `env_file: [./.env]`, so a restart is enough):

```bash
cd "$STACK" && docker compose up -d --no-deps functions
```

Then re-run the server env checker:

```bash
COMPOSE_DIR="$STACK" bash "$REPO/scripts/check-edge-env-server.sh"
```

---

## 6. Signal in Lovable chat

Whenever Lovable edits anything under `supabase/functions/`, the final report ends with:

```
Manual deploy required:
  FN=<function-name>
  See: docs/runbooks/deploy-edge-function.md
Final status: completed_requires_manual_redeploy
```

That's your trigger to run Section 1 with the named `FN`.

---

## Why this is manual

- Lovable's sandbox has no SSH access to Contabo.
- Dokploy's `postora` app only rebuilds the frontend container; the Supabase stack (`postorasupabase-supabase-j8axyh`) is a separate Dokploy stack and its `functions` volume is not in the frontend build context.
- Restarting only the `functions` container (not the whole stack) avoids any auth/db/storage downtime.
