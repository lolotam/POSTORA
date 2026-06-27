# Edge Function Manual Deploy Runbook

## Why this exists

Dokploy auto-redeploys the **frontend** (`postora` app) on every Lovable push — that's already working. It does NOT touch the **Supabase edge functions volume**, which lives in a separate stack:

```
/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/
```

So whenever I edit anything under `supabase/functions/<name>/`, the repo is correct but production keeps serving the old code until someone syncs the file into that volume and restarts the functions container. This runbook is that "someone" step, written so you (or Claude/Codex with `ssh-contabo-mcp`) can run it in under a minute.

## What I'll add to the repo

A single file: `docs/runbooks/deploy-edge-function.md`

It will contain:

1. **One-function deploy** (the common case — just changed `linkedin-oauth/index.ts`):

   ```bash
   FN=linkedin-oauth   # change to the function you edited
   REPO=/root/postora  # adjust to wherever you git-pull the repo on the VPS
   VOL=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions
   STACK=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code

   cd "$REPO" && git pull --ff-only
   rsync -av --delete "$REPO/supabase/functions/$FN/" "$VOL/$FN/"
   sha256sum "$REPO/supabase/functions/$FN/index.ts" "$VOL/$FN/index.ts"   # must match
   cd "$STACK" && docker compose up -d --no-deps functions
   docker compose logs --tail=50 functions | grep -i "$FN"
   ```

2. **All-functions deploy** (after a refactor that touched many):

   ```bash
   rsync -av --delete "$REPO/supabase/functions/" "$VOL/"
   cd "$STACK" && docker compose up -d --no-deps functions
   ```

3. **Smoke test block** per common function (curl against `https://api.postora.cloud/functions/v1/<fn>` with expected status), plus the "click Connect LinkedIn → expect redirect to linkedin.com/oauth/v2/authorization" UI check for the OAuth ones.

4. **Rollback**: `git checkout <prev-sha> -- supabase/functions/<fn>/` then re-run the sync block.

5. **Env sanity check** (only when logs show `X not configured`): grep the var in `$STACK/.env`, never echo the value, follow the existing `docs/EDGE_RUNTIME_ENV_RUNBOOK.md` to inject + restart.

## How I'll signal it in chat after each edge-function edit

When I finish a task that modified anything in `supabase/functions/`, the final report will end with:

```
Manual deploy required:
  FN=<function-name>
  See: docs/runbooks/deploy-edge-function.md
Final status: completed_requires_manual_redeploy
```

So you (or your Claude/Codex session with `ssh-contabo-mcp`) always know exactly what to paste and which function name to substitute.

## Out of scope

- No SSH key sharing.
- No GitHub Actions workflow.
- No new Dokploy app.
- No changes to existing edge-function code, env, or Dokploy config.

## Files

- New: `docs/runbooks/deploy-edge-function.md`

Final status after you approve: `completed` (the runbook is just documentation; nothing to deploy).
