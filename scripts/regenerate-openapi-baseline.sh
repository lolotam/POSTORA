#!/usr/bin/env bash
#
# Move the contract-drift baseline forward to the current document, and clear
# the acknowledgements that move satisfied.
#
# WHY BOTH IN ONE SCRIPT
# ----------------------
# These two steps are separable and must not be separated. Updating the
# baseline while leaving an acknowledgement in place would leave a line that
# pre-approves the SAME break next time it happens -- and the next occurrence
# would sail through with nobody deciding anything. The drift gate fails on a
# stale ack precisely so this cannot be forgotten; this script is how you
# satisfy it without hand-editing two files and hoping.
#
# WHEN TO RUN IT
# --------------
# After a contract change has been reviewed and merged. Not before: the
# baseline is what the gate compares against, so regenerating it first would
# make the gate compare the document to itself and find nothing.
#
# Mirrors scripts/regenerate-baseline.sh (the database harness's equivalent),
# including its refusal to run on a dirty tree.

set -euo pipefail

DOC="docs/api/openapi.yaml"
BASELINE="docs/api/openapi.baseline.yaml"
ACKS="docs/api/accepted-breaking-changes.txt"

cd "$(dirname "$0")/.."

for f in "$DOC" "$ACKS"; do
  [ -f "$f" ] || { echo "missing $f -- run from a full checkout" >&2; exit 2; }
done

# A dirty document would bake uncommitted, unreviewed edits into the baseline,
# which is exactly the state the gate exists to catch.
# BOTH the working tree AND the index. `git diff` alone compares the tree with
# the INDEX, so a staged-but-uncommitted contract edit -- an ordinary
# pre-commit state -- reported clean, the edit was copied into the baseline,
# and committing both files together bypassed the gate entirely. Reported by
# the Codex reviewer on #91 and #93.
if ! git diff --quiet -- "$DOC" || ! git diff --quiet --cached -- "$DOC"; then
  echo "refusing to run: $DOC has uncommitted changes (working tree or index)." >&2
  echo "Commit or stash the contract change first; the baseline records what was REVIEWED," >&2
  echo "and a baseline taken from an unreviewed document is a gate defending nothing." >&2
  exit 3
fi

cp "$DOC" "$BASELINE"

# Strip every acknowledgement line, keeping the explanatory header. After the
# baseline moves, no finding exists for any of them by definition -- they are
# all stale, and the gate would fail on them.
#
# Pure shell, not python: this is an operator tool run on a developer's machine
# as often as in CI, and `python3` is not on PATH on a stock Windows box (found
# the hard way). `|| true` because grep exits 1 when nothing matches, which
# under `set -e` would abort on a legitimately empty file.
acks_tmp="$(mktemp)"
grep -E '^[[:space:]]*(#|$)' "$ACKS" > "$acks_tmp" || true
mv "$acks_tmp" "$ACKS"

echo "baseline moved to the current $DOC"
echo "acknowledgements cleared in $ACKS"
echo
echo "Verify before committing:"
echo "  deno run --allow-read scripts/check-openapi-drift.ts"
