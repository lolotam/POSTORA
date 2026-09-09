#!/bin/bash
# =============================================================================
# POSTORA - Edge Functions sync & reload
# -----------------------------------------------------------------------------
# Executed by the Dokploy Schedule "Edge Functions Sync (POSTORA)", which runs
# INSIDE the Dokploy container (scheduleType=dokploy-server). Replaces the
# billing-blocked GitHub Actions workflow .github/workflows/deploy-edge-functions.yml
#
# Schedule body is a single line:   bash /etc/dokploy/postora-edge-deploy.sh
#
# Design notes:
#   * The volume is synced from `git archive <ref>` into a clean temp dir, never
#     from the checkout's working tree, so untracked cruft can never reach prod.
#   * The restart decision comes from rsync's itemized output, not `git diff`,
#     so drift between the volume and the deployed commit is always corrected.
#   * HEAD in the checkout only advances after a verified-healthy deploy, so it
#     is always the last known-good commit and rollback needs no extra state.
#   * A failed target commit is recorded and skipped, so a bad merge cannot turn
#     into a restart storm every two minutes.
# =============================================================================
set -eo pipefail

# ----------------------------- configuration ---------------------------------
VOL="/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions"
STACK="/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code"
RUNTIME="/etc/dokploy/postora-runtime"
SSH_KEY="/etc/dokploy/ssh/postora_edge_deploy"
KNOWN_HOSTS="/etc/dokploy/ssh/known_hosts"
FUNCTIONS_BASE="https://api.postora.cloud/functions/v1"
HEALTH_URL="$FUNCTIONS_BASE/get-public-config"
WORKER="ai-knowledge-excel-worker"

LOCKFILE="/tmp/postora-deploy.lock"
TMP_SYNC="/tmp/postora-functions-sync"
RSYNC_RAW="/tmp/postora-functions-sync.itemized"
CHANGES="/tmp/postora-functions-sync.changes"
ROLLBACK_CHANGES="/tmp/postora-functions-sync.rollback"
# Persisted outside /tmp so they survive a Dokploy container restart.
FAILED_MARKER="/etc/dokploy/postora-edge-deploy.failed"
# Hand-created by an operator before a server-only hotfix. `rsync --delete` would
# otherwise revert that hotfix within one tick, whether or not a commit landed.
PAUSE_MARKER="/etc/dokploy/postora-edge-deploy.paused"

LOCK_WAIT=180          # seconds to wait for a concurrent run to release the lock
FETCH_TIMEOUT=30       # seconds before giving up on git fetch
HEALTH_ATTEMPTS=3      # healthcheck retries, 3s apart
PROBE_LIMIT=15         # most changed functions to boot-probe in one deploy

# ------------------------------- helpers -------------------------------------
log() { echo "[$(date -u '+%H:%M:%S')] $*"; }

healthcheck() {
    local attempts="${1:-$HEALTH_ATTEMPTS}"
    local i status
    for i in $(seq 1 "$attempts"); do
        sleep 3
        status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$HEALTH_URL" || echo 000)"
        log "  healthcheck $i/$attempts -> HTTP $status"
        [ "$status" = "200" ] && return 0
    done
    return 1
}

# probe_changed_functions <changes-file>
# A module that fails to load — a bad import, a top-level throw — answers 5xx on
# every request, but only for its own function. The shared healthcheck above hits
# get-public-config, which keeps returning 200 while a sibling is dead, so a
# broken deploy would otherwise be accepted (that is how generate-caption stayed
# down for ten weeks). OPTIONS is used because it is side-effect free: it reaches
# the CORS preamble on a healthy function and never a webhook's body handler.
probe_changed_functions() {
    local fn code failed=0
    local -a functions
    mapfile -t functions < <(
        awk '{print $NF}' "$1" | cut -d/ -f1 | grep -vx '_shared' | sort -u | head -"$PROBE_LIMIT"
    )

    for fn in "${functions[@]}"; do
        # Skip a directory the sync just deleted; there is nothing left to boot.
        [ -d "$VOL/$fn" ] || continue
        code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 -X OPTIONS "$FUNCTIONS_BASE/$fn" || echo 000)"
        if [ "$code" = "000" ] || [ "$code" -ge 500 ]; then
            log "  probe $fn -> HTTP $code   FAILED"
            failed=1
        else
            log "  probe $fn -> HTTP $code"
        fi
    done
    return "$failed"
}

# sync_volume <git-ref> <changes-file>
# Extracts the ref into a clean temp dir and mirrors it into the volume.
# Writes the real (non attribute-only) rsync changes into <changes-file>.
# Returns non-zero if the extract or the mirror itself failed.
sync_volume() {
    local ref="$1" out="$2"

    rm -rf "$TMP_SYNC"
    mkdir -p "$TMP_SYNC"
    git -C "$RUNTIME" archive "$ref" supabase/functions | tar -x -C "$TMP_SYNC" || return 1

    # --delete removes functions deleted from git. `main` is the edge-runtime
    # bootstrap service, untracked but required for boot, so it is never touched.
    # --checksum is essential: `git archive` stamps every file with the commit
    # time, so a time-based comparison reports all ~700 files as changed on every
    # deploy. Comparing content instead makes the change list mean something.
    rsync -aic --delete --exclude "main" \
        "$TMP_SYNC/supabase/functions/" "$VOL/" > "$RSYNC_RAW" || return 1

    # Keep transfers and deletions; drop attribute-only lines (leading '.').
    grep -E '^(\*deleting|[<>ch][fdLDS])' "$RSYNC_RAW" > "$out" || true
    return 0
}

# Restores the volume to the last known-good commit and verifies it came back.
rollback() {
    set +e
    log "Deploy failed - rolling back to $PREV_COMMIT"

    sync_volume "$PREV_COMMIT" "$ROLLBACK_CHANGES" \
        || log "WARNING: sync during rollback failed"

    cd "$STACK" || { log "CRITICAL: cannot cd into $STACK - MANUAL INTERVENTION REQUIRED"; exit 1; }
    docker compose restart functions || log "WARNING: functions restart during rollback failed"
    if [ "$WORKER_TOUCHED" = "1" ]; then
        docker compose restart "$WORKER" || log "WARNING: $WORKER restart during rollback failed"
    fi

    if healthcheck "$HEALTH_ATTEMPTS"; then
        log "Rollback complete - service healthy on $PREV_COMMIT"
    else
        log "CRITICAL: ROLLBACK HEALTHCHECK FAILED - Edge Functions are DOWN. MANUAL INTERVENTION REQUIRED."
    fi

    # Record the bad commit so the next tick skips it instead of looping.
    [ -n "$TARGET" ] && echo "$TARGET" > "$FAILED_MARKER"
    log "Recorded failed commit in $FAILED_MARKER - delete that file to retry."
    exit 1
}

# Scratch files are removed on every exit path, not just the successful one.
trap 'rm -rf "$TMP_SYNC" "$RSYNC_RAW" "$CHANGES" "$ROLLBACK_CHANGES"' EXIT

# ------------------------- 1. concurrency lock -------------------------------
# Wait for an in-flight run rather than skipping, so the newest commit is never
# silently dropped.
exec 200>"$LOCKFILE"
if ! flock -w "$LOCK_WAIT" 200; then
    log "Timed out after ${LOCK_WAIT}s waiting for another run to release the lock."
    exit 1
fi

echo "=========================================="
log "Postora Edge Functions sync"
echo "=========================================="

if [ -f "$PAUSE_MARKER" ]; then
    log "Paused by $PAUSE_MARKER - not touching the volume."
    log "Remove that file to resume automatic deploys."
    exit 0
fi

TARGET=""
WORKER_TOUCHED=0
WORKER_STATUS="SKIPPED"

if [ -f "$SSH_KEY" ]; then
    export GIT_SSH_COMMAND="ssh -i $SSH_KEY -o IdentitiesOnly=yes -o UserKnownHostsFile=$KNOWN_HOSTS -o StrictHostKeyChecking=yes"
fi

for d in "$RUNTIME/.git" "$VOL" "$STACK"; do
    [ -d "$d" ] || { log "ERROR: required path missing: $d"; exit 1; }
done

# --------------------- 2. resolve current commit (loudly) --------------------
# No silent fallback: an unresolvable HEAD would turn rollback into a no-op that
# reports success.
if ! PREV_COMMIT="$(git -C "$RUNTIME" rev-parse HEAD)"; then
    log "ERROR: cannot resolve HEAD in $RUNTIME"
    exit 1
fi
log "Last known-good commit: ${PREV_COMMIT:0:7}"

# ------------------------------ 3. fetch -------------------------------------
log "Fetching origin/main (${FETCH_TIMEOUT}s timeout)..."
if ! timeout "$FETCH_TIMEOUT" git -C "$RUNTIME" fetch origin "+refs/heads/main:refs/remotes/origin/main" --prune; then
    log "ERROR: git fetch timed out or failed - aborting, nothing changed."
    exit 1
fi
TARGET="$(git -C "$RUNTIME" rev-parse refs/remotes/origin/main)"
log "Target commit: ${TARGET:0:7}"

# A commit that already failed once is skipped until an operator clears it.
if [ -f "$FAILED_MARKER" ] && [ "$(cat "$FAILED_MARKER")" = "$TARGET" ]; then
    log "Commit ${TARGET:0:7} already failed a previous deploy - skipping."
    log "Delete $FAILED_MARKER to retry."
    exit 0
fi

# --------------------------- 4. sync to volume -------------------------------
log "Syncing ${TARGET:0:7} -> $VOL ..."
if ! sync_volume "$TARGET" "$CHANGES"; then
    log "ERROR: extract or rsync to the volume failed."
    rollback
fi

if [ ! -s "$CHANGES" ]; then
    log "Volume already matches ${TARGET:0:7} - nothing to do."
    git -C "$RUNTIME" reset --hard "$TARGET" --quiet
    rm -f "$FAILED_MARKER"
    exit 0
fi

log "Volume changes ($(wc -l < "$CHANGES") entries, first 40):"
head -40 "$CHANGES" | sed 's/^/     /'

if grep -qE "[[:space:]](_shared|${WORKER})/" "$CHANGES"; then
    WORKER_TOUCHED=1
fi

# ------------------------- 5. restart containers -----------------------------
cd "$STACK"

log "Restarting functions container..."
# Guarded with `if !` so set -e cannot kill the script before rollback runs.
if ! docker compose restart functions; then
    log "ERROR: 'docker compose restart functions' failed."
    rollback
fi

if [ "$WORKER_TOUCHED" = "1" ]; then
    log "Restarting $WORKER (shared code changed)..."
    if docker compose restart "$WORKER"; then
        WORKER_STATUS="SUCCESS"
    else
        WORKER_STATUS="FAILED"
        log "WARNING: failed to restart $WORKER - background jobs may run stale code."
    fi
fi

# ---------------------------- 6. healthcheck ---------------------------------
log "Verifying $HEALTH_URL ..."
if ! healthcheck "$HEALTH_ATTEMPTS"; then
    log "ERROR: healthcheck failed after $HEALTH_ATTEMPTS attempts."
    rollback
fi

log "Boot-probing the changed functions ..."
if ! probe_changed_functions "$CHANGES"; then
    log "ERROR: a changed function does not boot."
    rollback
fi

# ------------------------------ 7. result ------------------------------------
# HEAD advances only now, so it is always the last verified-healthy commit.
git -C "$RUNTIME" reset --hard "$TARGET" --quiet
rm -f "$FAILED_MARKER"

log "Edge Functions healthy on ${TARGET:0:7}"
log "  Worker restart: $WORKER_STATUS"

if [ "$WORKER_STATUS" = "FAILED" ]; then
    # Functions are healthy, so no rollback - but the deploy is not clean.
    # Exit non-zero so Dokploy flags it instead of showing green.
    log "Deploy completed with a degraded worker - check '$WORKER' manually."
    exit 1
fi

log "Deploy successful."
exit 0
