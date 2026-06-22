#!/usr/bin/env bash
#
# Deploys the edge functions affected by the token-reauth flag reset fix
# (commit 78abe44d): tiktok-oauth, pinterest-oauth, twitter-oauth, linkedin-oauth.
#
# Usage:
#   SUPABASE_ACCESS_TOKEN=sbp_xxx ./scripts/deploy-oauth-fixes.sh
#
# Get a deploy-capable token:
#   Supabase Dashboard -> Account -> Access Tokens -> Generate new token
#
set -euo pipefail

PROJECT_REF="postora-self-hosted"
FUNCTIONS=(tiktok-oauth pinterest-oauth twitter-oauth linkedin-oauth)

if [[ -z "${SUPABASE_ACCESS_TOKEN:-}" ]]; then
  echo "ERROR: SUPABASE_ACCESS_TOKEN is not set." >&2
  echo "Get one at: https://supabase.com/dashboard/account/tokens" >&2
  echo "Then run:  SUPABASE_ACCESS_TOKEN=sbp_xxx $0" >&2
  exit 1
fi

cd "$(dirname "$0")/.."   # project root

echo "Deploying ${#FUNCTIONS[@]} edge functions to project ${PROJECT_REF}..."
echo "Functions: ${FUNCTIONS[*]}"
echo ""

for fn in "${FUNCTIONS[@]}"; do
  echo "──────────────────────────────────────────"
  echo "▶ Deploying ${fn} ..."
  echo "──────────────────────────────────────────"
  if npx -y supabase functions deploy "${fn}" \
        --project-ref "${PROJECT_REF}"; then
    echo "✅ ${fn} deployed"
  else
    echo "❌ ${fn} FAILED — check output above" >&2
    exit 1
  fi
  echo ""
done

echo "=========================================="
echo "✅ All 4 edge functions deployed successfully."
echo "=========================================="
echo ""
echo "Next: verify in the UI — reconnect a flagged account and confirm the"
echo "red banner / 'Action Required' badge / 'Re-auth required' text all clear."
