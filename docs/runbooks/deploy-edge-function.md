# Deploy Edge Function to Self-Hosted Supabase

Dokploy auto-redeploys the **frontend** (`postora` app) on every push. It does **not** touch the edge-functions volume of the self-hosted Supabase stack. After any change under `supabase/functions/*`, follow this runbook to make it live on `https://api.postora.cloud`.

Run on the Contabo VPS (`86.48.2.205`) via `ssh-contabo-mcp` or a normal SSH session.

---

## Paths (constant)

```bash
VOL=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions
STACK=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code
```

`/root/postora-runtime` is a checkout of `git@github.com:lolotam/POSTORA.git` that can fetch
again as of 2026-08-22: it uses the dedicated **read-only** deploy key
`~/.ssh/postora_edge_deploy_ed25519` (GitHub deploy key "postora-edge-deploy-ro", registered on
the repo), wired in via `git config core.sshCommand`. It cannot push. This makes the preferred
deploy a fetch + copy on the server — see Section 0 — rather than an rsync from a workstation.
(`/root/postora` in earlier versions of this runbook never existed; before 2026-08-22 the
earlier key `postora_runtime_deploy_ed25519` was never registered, which is why fetch failed.)

---

## 0. Preferred: deploy straight from git (no workstation upload)

```bash
FN=verify-reset-otp          # or several, space-separated
REF=origin/main              # or origin/<branch> to deploy a PR before merging
VOL=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions
STACK=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code

cd /root/postora-runtime
git fetch origin "+refs/heads/${REF#origin/}:refs/remotes/$REF"
for f in $FN; do
  git show "$REF:supabase/functions/$f/index.ts" > "$VOL/$f/index.ts"
done
# shared modules, if the change touched supabase/functions/_shared/*:
# git show "$REF:supabase/functions/_shared/foo.ts" > "$VOL/_shared/foo.ts"

# Verify: the two hashes on each line must match.
for f in $FN; do
  echo "$f git=$(git show "$REF:supabase/functions/$f/index.ts" | sha256sum | cut -d' ' -f1) vol=$(sha256sum "$VOL/$f/index.ts" | cut -d' ' -f1)"
done
cd "$STACK" && docker compose restart functions
```

Files written with `git show` are always LF, so the hashes compare directly with no CRLF
normalisation. (Do not use `"$VOL"/{$FN}/index.ts` — bash brace expansion happens before
variable expansion, so it produces literal `{` paths.)

### Auditing existing drift

That LF guarantee holds only for files this runbook wrote. Earlier deploys copied straight
from a Windows checkout, so a large share of the volume still carries CRLF. **Strip CR from
both sides when comparing**, or a survey reports near-total drift that is purely line endings:

```bash
diff <(tr -d '\r' < "$VOL/_shared/$f") <(tr -d '\r' < "supabase/functions/_shared/$f")
```

A drifted file is not automatically stale. Classify each one before copying anything:

| Class | Meaning | Action |
|---|---|---|
| A — volume behind | git holds the newer, reviewed version | copy git → volume |
| B — volume ahead | a hotfix applied straight to the volume, never committed | **port to git first**, then deploy |
| C — volume missing | file exists in git only | copy git → volume |

Class B is the one that bites: `_shared/cron-auth.ts` carried a `verifyCronOrAdmin` export for
weeks that git did not have, and `cleanup-media/index.ts` imported it. Deploying git over it
would have removed an export a live function imports, which takes the whole `functions` service
into a boot crash-loop — not just that one endpoint. Before copying any `_shared` module, check
who imports what you are about to remove:

```bash
grep -rl "<symbol>" --include=*.ts "$VOL"
```

---

## 1. One-function deploy (common case)

Just changed `supabase/functions/linkedin-oauth/index.ts`? Copy it up from your workstation:

```bash
FN=linkedin-oauth

# From your local repo checkout
rsync -av --delete "supabase/functions/$FN/" "root@86.48.2.205:/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/$FN/"
```

Then on the server:

```bash
FN=linkedin-oauth
VOL=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions
STACK=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code

sha256sum "$VOL/$FN/index.ts"

# Reload the function code (see "Why restart, not up -d" below)
cd "$STACK" && docker compose restart functions

# Confirm the runtime came back and the function answers
docker compose logs --tail=40 functions | tail -20
curl -s -o /dev/null -w '%{http_code}\n' -X OPTIONS "https://api.postora.cloud/functions/v1/$FN"
```

Compare that hash against the local file. On Windows the local copy usually has CRLF line
endings, which changes the hash even when the content is identical — normalise before comparing:

```bash
tr -d '\r' < "supabase/functions/$FN/index.ts" | sha256sum
```

If the hashes still differ, the copy didn't land — re-run the rsync.

### Why restart, not `up -d`

`docker compose up -d --no-deps functions` prints `Container ... Running` and does nothing when
the compose config is unchanged — the container keeps serving the old code, so the deploy looks
successful and isn't. The function sources are a bind mount, so `docker compose restart functions`
is what actually reloads them. Restarting only this service leaves auth, db and storage untouched.

Env-var changes are the exception: `restart` reuses the existing container and its old
environment, so after editing `$STACK/.env` use
`docker compose up -d --force-recreate --no-deps functions`.

---

## 2. All-functions deploy (refactor touched many)

```bash
# From your local repo checkout
rsync -av "supabase/functions/" "root@86.48.2.205:/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/"
```

```bash
cd "$STACK" && docker compose restart functions
docker compose logs --tail=120 functions
```

Add `--delete` to the rsync to remove functions in the volume that no longer exist in the repo.
Leave it off to keep orphaned functions in place.

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

Roll back from your local checkout, then re-deploy with Section 1:

```bash
FN=linkedin-oauth
git log --oneline supabase/functions/$FN/        # find the prior good SHA
git checkout <prev-sha> -- supabase/functions/$FN/
rsync -av --delete "supabase/functions/$FN/" "root@86.48.2.205:/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/$FN/"
```

```bash
cd "$STACK" && docker compose restart functions
```

After verifying the rollback works, restore your checkout with
`git checkout HEAD -- supabase/functions/$FN/` so later edits aren't based on stale code.

---

## 5. Env sanity (only if logs show `X not configured`)

Do **not** echo secret values. Confirm the var exists in the stack `.env`:

```bash
grep -E '^<VAR_NAME>=' "$STACK/.env" >/dev/null && echo present || echo MISSING
```

If missing, add it to `$STACK/.env`, then follow `docs/EDGE_RUNTIME_ENV_RUNBOOK.md`. The
`functions` service uses `env_file: [./.env]`, and a plain `restart` reuses the container's
existing environment, so the container has to be recreated:

```bash
cd "$STACK" && docker compose up -d --force-recreate --no-deps functions
```

Then re-run the server env checker (copy `scripts/check-edge-env-server.sh` up from your
checkout first — the server has no current copy of the repo):

```bash
COMPOSE_DIR="$STACK" bash /tmp/check-edge-env-server.sh
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
