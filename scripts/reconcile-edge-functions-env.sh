#!/usr/bin/env bash
# =============================================================================
# Postora — Self-healing reconciliation for Supabase Edge Functions env injection.
#
# WHAT THIS FIXES
#   Dokploy regenerates docker-compose.yml on every stack redeploy and, in doing
#   so, strips the `env_file:` directive from the `functions` service. When that
#   happens, Deno.env.get() in edge functions returns undefined for every
#   variable that is NOT explicitly listed in the `environment:` block, causing
#   the recurring "secret not configured" 500s (Stripe, Cloudinary, etc.).
#
# WHAT THIS SCRIPT DOES
#   - Detects whether the `functions` service has an `env_file:` directive.
#   - If MISSING: backs up the compose file, re-inserts `env_file: [./.env]`
#     precisely under the functions service, validates the compose, and recreates
#     ONLY the functions container.
#   - If PRESENT: verifies the critical vars are actually visible inside the
#     running container and restarts the functions container only if a var that
#     exists in .env is absent from the container (drift recovery).
#   - Logs every action. Silent (exit 0) when no change is needed (cron-safe).
#
# DESIGNED TO RUN FROM HOST ROOT CRONTAB every ~5 minutes. It lives OUTSIDE
# Dokploy's control so it survives every Dokploy redeploy and self-heals within
# the cron interval. See docs/EDGE_RUNTIME_ENV_RUNBOOK.md.
#
# Usage:
#   reconcile-edge-functions-env.sh              # uses defaults
#   COMPOSE_DIR=/path reconcile-edge-functions-env.sh
#
# Env overrides:
#   COMPOSE_DIR   Dokploy Supabase compose dir.
#                 Default: /etc/dokploy/compose/postorasupabase-supabase-j8axyh/code
#   ENV_FILE      Relative path to .env from COMPOSE_DIR. Default: ./.env
#   FUNCTIONS_CONTAINER  Override edge-functions container name.
#   DRY_RUN       1 = report only, make no changes.
# =============================================================================

set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code}"
ENV_FILE="${ENV_FILE:-./.env}"
COMPOSE_FILE="$COMPOSE_DIR/docker-compose.yml"
ENV_PATH="$COMPOSE_DIR/$ENV_FILE"
DRY_RUN="${DRY_RUN:-0}"
LOG_TAG="reconcile[$$]"

# Critical provider secrets that, when missing from the container, prove env
# injection is broken. Each must ALSO exist (non-empty) in .env for the drift
# recovery to trigger a restart.
CRITICAL_VARS=(
  STRIPE_SECRET_KEY
  CLOUDINARY_CLOUD_NAME
  CLOUDINARY_API_KEY
  CLOUDINARY_API_SECRET
)

# Edge functions service identifier. The image line is the stable, unique anchor
# used to locate the functions block precisely without a YAML parser (which
# would reorder/drop comments).
FUNCTIONS_IMAGE_ANCHOR="image: supabase/edge-runtime:v1.67.4"

log() {
  # ISO-8601 timestamp + tag + message. Routed to stdout so cron capture works.
  printf '%s %s %s\n' "$(date -u +'%Y-%m-%dT%H:%M:%SZ')" "$LOG_TAG" "$*"
}

die() { log "ERROR: $*" >&2; exit 1; }

# -----------------------------------------------------------------------------
# Preflight
# -----------------------------------------------------------------------------
[ -f "$COMPOSE_FILE" ] || die "compose file not found: $COMPOSE_FILE"
[ -f "$ENV_PATH" ]     || die ".env not found: $ENV_PATH"

# Resolve container name if not overridden.
if [ -z "${FUNCTIONS_CONTAINER:-}" ]; then
  FUNCTIONS_CONTAINER="$(docker ps --filter 'name=supabase-edge-functions' --format '{{.Names}}' | head -n1 || true)"
fi

# -----------------------------------------------------------------------------
# has_env_file_in_functions: returns 0 if the functions service block already
# declares env_file:, 1 otherwise. Scans only the functions service block.
# -----------------------------------------------------------------------------
has_env_file_in_functions() {
  awk '
    /^  functions:/ { active=1; next }
    active && /^  [a-z]/ { active=0 }
    active && /env_file:/ { found=1 }
    END { exit found ? 0 : 1 }
  ' "$COMPOSE_FILE"
}

# -----------------------------------------------------------------------------
# insert_env_file: precise insertion of env_file: right after the unique
# functions image anchor line. Uses python3 for exact string replacement so the
# rest of the file (comments, ordering, indentation) is preserved byte-for-byte.
# Fails loudly if the anchor is absent or not unique, or if env_file already
# exists in the block.
# -----------------------------------------------------------------------------
insert_env_file() {
  ENV_FILE_ARG="$ENV_FILE" COMPOSE_FILE_ARG="$COMPOSE_FILE" \
    ANCHOR_ARG="$FUNCTIONS_IMAGE_ANCHOR" python3 - <<'PY'
import os, sys
p        = os.environ["COMPOSE_FILE_ARG"]
env_file = os.environ["ENV_FILE_ARG"]
anchor   = os.environ["ANCHOR_ARG"]

s = open(p).read()
anchor_line = next((ln for ln in s.splitlines(True) if ln.strip() == anchor), None)
if anchor_line is None:
    sys.exit("anchor line not found: " + anchor)
if s.count(anchor_line) != 1:
    sys.exit("anchor line not unique")

block = s.split(anchor_line, 1)[1].split("\n\n", 1)[0]
if "env_file" in block:
    sys.exit("env_file already present in functions block")

indent = "    "   # 4-space service-level indent (matches existing functions keys)
inject = "{indent}env_file:\n{indent}  - {env}\n".format(indent=indent, env=env_file)
new = s.replace(anchor_line, anchor_line + inject, 1)
open(p, "w").write(new)
print("inserted env_file under functions service")
PY
}

# -----------------------------------------------------------------------------
# var_in_container NAME: echoes present|missing. Never prints the value.
# -----------------------------------------------------------------------------
var_in_container() {
  local name="$1"
  [ -n "${FUNCTIONS_CONTAINER:-}" ] || { echo missing; return; }
  docker exec "$FUNCTIONS_CONTAINER" sh -c \
    "if [ -n \"\$(printenv '$name' 2>/dev/null)\" ]; then echo present; else echo missing; fi" \
    2>/dev/null || echo missing
}

# -----------------------------------------------------------------------------
# var_in_envfile NAME: echoes present|missing. Only checks the KEY exists with a
# non-empty value in .env. Never prints the value.
# -----------------------------------------------------------------------------
var_in_envfile() {
  local name="$1"
  if grep -qE "^[[:space:]]*${name}=.+" "$ENV_PATH" 2>/dev/null; then
    echo present
  else
    echo missing
  fi
}

# -----------------------------------------------------------------------------
# recreate_functions: validates compose then recreates ONLY the functions
# container. Other services are untouched.
# -----------------------------------------------------------------------------
recreate_functions() {
  docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_FILE" config --quiet \
    || die "compose config invalid after edit — aborting before recreate"
  log "recreating functions container (only)"
  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN=1 — skipping recreate"
    return
  fi
  docker compose --project-directory "$COMPOSE_DIR" -f "$COMPOSE_FILE" up -d --no-deps functions \
    || die "failed to recreate functions container"
  # give the runtime a moment to settle before we re-check env
  sleep 7
}

# =============================================================================
# Main reconciliation logic
# =============================================================================
log "start  compose=$COMPOSE_FILE container=${FUNCTIONS_CONTAINER:-<none>}"

changed=0

if has_env_file_in_functions; then
  log "env_file: already present in functions service"
else
  log "env_file: MISSING in functions service — restoring"
  if [ "$DRY_RUN" = "1" ]; then
    log "DRY_RUN=1 — would insert env_file and recreate"
  else
    cp "$COMPOSE_FILE" "$COMPOSE_FILE.bak.reconcile.$(date +%s)"
    insert_env_file || die "insert_env_file failed"
    log "backup saved and env_file inserted"
    recreate_functions
    changed=1
  fi
fi

# Drift recovery: even when env_file is present, a stale container (started
# before .env gained a var) can still miss it. Recreate if any critical var is
# in .env but missing from the running container.
if [ "${changed}" = "0" ] && [ -n "${FUNCTIONS_CONTAINER:-}" ]; then
  for v in "${CRITICAL_VARS[@]}"; do
    if [ "$(var_in_envfile "$v")" = "present" ] && [ "$(var_in_container "$v")" != "present" ]; then
      log "drift detected: $v is in .env but missing from container — recreating"
      recreate_functions
      changed=1
      break
    fi
  done
fi

# Final verification report for the critical vars (never prints values).
log "verification:"
for v in "${CRITICAL_VARS[@]}"; do
  log "  $v -> container=$(var_in_container "$v") envfile=$(var_in_envfile "$v")"
done

if [ "$changed" = "1" ]; then
  log "done (changed)"
else
  log "done (no change)"
fi
