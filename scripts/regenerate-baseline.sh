#!/usr/bin/env bash
# ============================================================================
# regenerate-baseline.sh — rewrite supabase/tests/baseline_schema.sql.
#
# WHY THIS IS A SCRIPT AND NOT A DOCUMENTED COMMAND
#
# The baseline's first line binds three facts together: which migration the
# dump includes up to (MARKER), how many migrations that is (BASELINE_COUNT),
# and the exact set of their filenames (BASELINE_SUM). The harness checks the
# last two. It CANNOT check the first — nothing inside a schema dump records
# the last migration applied to the database it came from.
#
# So a dump regenerated against a newer database while keeping an older marker
# is undetectable, and would make the harness re-apply migrations that are
# already in the dump. Every field is therefore written here, in one step, from
# the same inputs. Drift now requires deliberately hand-editing the header
# rather than merely forgetting a step. Do not hand-edit the header.
#
# Usage:
#   PRODUCTION_URL='postgres://user:pass@host:5432/postgres' \
#     bash scripts/regenerate-baseline.sh
#
# Run this whenever a new migration changes the schema and you want it folded
# into the baseline. You do NOT need to run it merely to add a migration — the
# harness applies anything newer than the marker on top.
# ============================================================================
set -euo pipefail
set +x            # never trace: PRODUCTION_URL carries a password
export LC_ALL=C

PRODUCTION_URL="${1:-${PRODUCTION_URL:-}}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"
BASELINE="$REPO_ROOT/supabase/tests/baseline_schema.sql"

if [ -z "$PRODUCTION_URL" ]; then
  echo "regenerate-baseline: PRODUCTION_URL is not set." >&2
  echo "  PRODUCTION_URL='postgres://...' bash scripts/regenerate-baseline.sh" >&2
  exit 2
fi
command -v pg_dump >/dev/null || { echo "regenerate-baseline: pg_dump not found" >&2; exit 2; }

MIGRATIONS=()
shopt -s nullglob
for f in "$MIGRATIONS_DIR"/*.sql; do MIGRATIONS+=("${f##*/}"); done
shopt -u nullglob
[ "${#MIGRATIONS[@]}" -gt 0 ] || { echo "regenerate-baseline: no migrations found" >&2; exit 2; }

# THE ONE THING THIS SCRIPT CANNOT VERIFY.
#
# The marker is taken as the newest migration in the local directory, on the
# assumption that the database being dumped has all of them applied. Nothing
# checks that, and nothing can: this project has NO migration ledger. There is
# no supabase_migrations.schema_migrations here -- only Supabase's own service
# tables for auth, storage and realtime. Migrations are applied by hand.
#
# If a local migration has NOT been applied to the target, this script dumps
# the older schema and marks that migration as included. The harness then skips
# it forever, and can pass while never having tested it.
#
# So the assertion is demanded from the operator explicitly rather than assumed
# silently. Converting a wrong assumption into a stated one is the only control
# available.
if [ "${I_CONFIRM_ALL_MIGRATIONS_APPLIED:-}" != "yes" ]; then
  echo "regenerate-baseline: REFUSING without an explicit confirmation." >&2
  echo "" >&2
  echo "  This writes a marker claiming the dump includes every migration in" >&2
  echo "  supabase/migrations/. Nothing can verify that -- this project has no" >&2
  echo "  migration ledger. If any local migration is NOT applied to the" >&2
  echo "  database you are dumping, the harness will skip it permanently." >&2
  echo "" >&2
  echo "  Check, then re-run with:" >&2
  echo "    I_CONFIRM_ALL_MIGRATIONS_APPLIED=yes PRODUCTION_URL=... bash \$0" >&2
  exit 2
fi

MARKER="${MIGRATIONS[-1]}"
COUNT="${#MIGRATIONS[@]}"
SUM="$(printf '%s\n' "${MIGRATIONS[@]}" | sha256sum | cut -d' ' -f1)"

echo "regenerate-baseline: marker $MARKER"
echo "regenerate-baseline: count  $COUNT"
echo "regenerate-baseline: sum    $SUM"

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

# Schema list and flags must match what db-harness.sh's prep expects; both are
# explained in that script's header. --no-privileges is deliberately NOT used:
# the tenancy suite asserts the production GRANT surface.
{
  printf -- '-- BASELINE_MIGRATION: %s  BASELINE_COUNT: %s  BASELINE_SUM: %s\n' \
    "$MARKER" "$COUNT" "$SUM"
  pg_dump --schema-only --no-owner \
    --schema=public --schema=auth --schema=storage --schema=realtime \
    "$PRODUCTION_URL"
} > "$TMP"

# A dump that failed half way is worse than none: it would restore a partial
# schema and the suites would fail somewhere confusing.
if ! grep -q 'PostgreSQL database dump complete' "$TMP"; then
  echo "regenerate-baseline: the dump does not end with pg_dump's completion" >&2
  echo "  marker, so it is truncated. Refusing to overwrite the baseline." >&2
  exit 1
fi

# A TRIPWIRE, NOT A CLEARANCE. A schema-only dump still carries function
# bodies, column defaults and comments, any of which can embed a credential.
# This catches the shapes that are cheap to pattern-match; it cannot certify
# that the dump is clean, and must not be read as doing so. The file is about
# to be committed to a git history -- read the diff before you push it.
if grep -qiE 'eyJ[A-Za-z0-9_-]{20}|sk-[a-zA-Z0-9]{20}|BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY|xox[baprs]-|gh[pousr]_[A-Za-z0-9]{20}|AKIA[0-9A-Z]{16}|EAA[A-Za-z0-9]{20}|(password|passwd|secret|api[_-]?key|token)[[:space:]]*(=|:=|=>)[[:space:]]*'"'"'[^'"'"']{8,}' "$TMP"; then
  echo "regenerate-baseline: the dump appears to contain a credential." >&2
  echo "  Refusing to write it. Investigate before committing anything." >&2
  exit 1
fi
echo "regenerate-baseline: pattern scan found nothing -- this is a tripwire," >&2
echo "  not a clearance. Read the diff before pushing." >&2

mv "$TMP" "$BASELINE"
trap - EXIT
echo "regenerate-baseline: wrote $BASELINE ($(wc -l < "$BASELINE") lines)"
echo "regenerate-baseline: commit it together with the migrations it includes."
