#!/usr/bin/env bash
# The gates that used to run in GitHub Actions, run here instead.
#
# The Actions workflows were deleted on 2026-09-09: the account's Actions
# billing lapsed, so every job had been failing in under four seconds with zero
# steps for days and every merge was going in under an admin override. A gate
# that never runs is worse than no gate, because it looks like one. Deployment
# is manual now (docs/runbooks/deploy-edge-function.md); this is the check that
# has to happen before you deploy.
#
#   bash scripts/local-gates.sh          # everything runnable on this machine
#   bash scripts/local-gates.sh edge     # one gate by name
#
# Gate names: types lint unit edge contract build
#
# ORDERING IS LOAD-BEARING. The Deno gates pass --node-modules-dir=auto, which
# rewrites node_modules and leaves vitest unable to resolve its own imports. So
# Deno runs first and `bun install` runs after it, before anything using
# node_modules. Reordering these silently breaks the unit gate.
#
# Not covered here: the Postgres integration harness. It needs Docker and a
# PG17 image, and this host has no psql. Run it on the server if you touch
# /v1 handlers or their SQL.

set -uo pipefail
cd "$(dirname "$0")/.."

FAILED=()
PASSED=()

run_gate() {
  local name="$1"; shift
  printf '\n\033[1m=== %s\033[0m\n' "$name"
  if "$@"; then
    PASSED+=("$name")
  else
    FAILED+=("$name")
  fi
}

gate_edge() {
  deno test --allow-env --allow-net --allow-read --allow-write \
    --no-check --node-modules-dir=auto supabase/functions/
}

gate_contract() {
  deno run --allow-read scripts/check-openapi-drift.ts &&
  deno test --allow-env --allow-read --no-check --node-modules-dir=auto \
    scripts/generate-postman.test.ts &&
  deno test --allow-env --allow-read --no-check --node-modules-dir=auto \
    scripts/generate-agent-context.test.ts
}

gate_install() { bun install --frozen-lockfile; }
gate_types()   { npx tsc -b --noEmit; }
gate_lint()    { bun run lint; }
gate_unit()    { bun run test; }
gate_build()   { bun run build; }

only="${1:-all}"

case "$only" in
  edge)     run_gate "edge functions"  gate_edge ;;
  contract) run_gate "contract drift"  gate_contract ;;
  types)    run_gate "typecheck"       gate_types ;;
  lint)     run_gate "lint"            gate_lint ;;
  unit)     run_gate "unit tests"      gate_unit ;;
  build)    run_gate "build"           gate_build ;;
  all)
    run_gate "edge functions" gate_edge
    run_gate "contract drift" gate_contract
    # Repairs whatever the Deno gates did to node_modules. Not a gate itself,
    # so a failure here is reported but the summary still names it.
    run_gate "restore deps"   gate_install
    run_gate "typecheck"      gate_types
    run_gate "lint"           gate_lint
    run_gate "unit tests"     gate_unit
    run_gate "build"          gate_build
    ;;
  *) echo "unknown gate: $only" >&2; exit 2 ;;
esac

printf '\n\033[1m=== summary ===\033[0m\n'
for g in "${PASSED[@]:-}"; do [ -n "$g" ] && printf '  \033[32mpass\033[0m  %s\n' "$g"; done
for g in "${FAILED[@]:-}"; do [ -n "$g" ] && printf '  \033[31mFAIL\033[0m  %s\n' "$g"; done

# Exit non-zero on any failure so this can gate a script or a git hook.
[ ${#FAILED[@]} -eq 0 ] || exit 1
echo "  all gates green"
