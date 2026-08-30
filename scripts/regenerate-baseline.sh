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

# The newest migration by filename order is what the dump will include up to,
# because it is being taken from a database that has all of them applied.
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

# Secrets: a schema-only dump should carry none, and the committed one was
# checked. Check again rather than trusting that it stays true.
if grep -qE 'eyJ[A-Za-z0-9_-]{20}|sk-[a-zA-Z0-9]{20}|BEGIN (RSA |EC |)PRIVATE KEY' "$TMP"; then
  echo "regenerate-baseline: the dump appears to contain a credential." >&2
  echo "  Refusing to write it. Investigate before committing anything." >&2
  exit 1
fi

mv "$TMP" "$BASELINE"
trap - EXIT
echo "regenerate-baseline: wrote $BASELINE ($(wc -l < "$BASELINE") lines)"
echo "regenerate-baseline: commit it together with the migrations it includes."
