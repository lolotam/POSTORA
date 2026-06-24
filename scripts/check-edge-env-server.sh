#!/usr/bin/env bash
# Postora — Production server Edge Runtime env checker.
#
# Runs ON the production host. Finds the edge-functions container and verifies
# that every required (and known optional) environment variable is visible
# inside the running container via printenv. NEVER prints values — reports only
# present / missing / empty. Also validates docker-compose config syntax,
# container health, and reachable function endpoints.
#
# Usage:
#   scripts/check-edge-env-server.sh
#
# Env overrides:
#   COMPOSE_DIR   Path to the Dokploy Supabase compose dir.
#                 Default: /etc/dokploy/compose/postorasupabase-supabase-j8axyh/code
#   FUNCTIONS_URL Base functions URL. Default: https://api.postora.cloud/functions/v1
#   CONTAINER     Override the edge-functions container name.

set -euo pipefail

COMPOSE_DIR="${COMPOSE_DIR:-/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code}"
FUNCTIONS_URL="${FUNCTIONS_URL:-https://api.postora.cloud/functions/v1}"

# ---- Locate the edge-functions container ------------------------------------
if [ -z "${CONTAINER:-}" ]; then
  CONTAINER="$(docker ps --filter 'name=supabase-edge-functions' --format '{{.Names}}' | head -n1 || true)"
fi

RED=$'\033[31m'; GRN=$'\033[32m'; YLW=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'
if [ ! -t 1 ]; then RED=""; GRN=""; YLW=""; DIM=""; RST=""; fi

fail=0

# ---- Section 0: infra checks ------------------------------------------------
echo "=== Infra checks ==="

if [ -f "$COMPOSE_DIR/docker-compose.yml" ]; then
  if docker compose -f "$COMPOSE_DIR/docker-compose.yml" config --quiet 2>/dev/null; then
    echo "${GRN}compose config: valid${RST}"
  else
    echo "${RED}compose config: INVALID${RST}"
    fail=1
  fi
else
  echo "${YLW}compose file not found at $COMPOSE_DIR/docker-compose.yml${RST}"
fi

if [ -z "$CONTAINER" ]; then
  echo "${RED}edge-functions container: not found${RST}"
  echo "Cannot verify container env without a running container."
  exit 1
fi

if docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null | grep -q true; then
  echo "${GRN}container $CONTAINER: running${RST}"
else
  echo "${RED}container $CONTAINER: NOT running${RST}"
  fail=1
fi

# ---- Variable lists ---------------------------------------------------------
# REQUIRED = app cannot boot without these. Everything else is optional
# (provider-specific). Keep in sync with infra/edge-runtime.required-env.json.
REQUIRED_VARS="
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
SUPABASE_ANON_KEY
JWT_SECRET
SUPABASE_DB_URL
OAUTH_STATE_SECRET
SITE_URL
"

OPTIONAL_VARS="
SUPABASE_PUBLISHABLE_KEY
SUPABASE_JWT_SECRET
PUBLIC_APP_ORIGIN
PUBLIC_API_ORIGIN
SUPABASE_PROJECT_REF
FACEBOOK_APP_ID
FACEBOOK_APP_SECRET
FACEBOOK_REDIRECT_URI
FACEBOOK_GRAPH_API_VERSION
INSTAGRAM_APP_ID
INSTAGRAM_APP_SECRET
INSTAGRAM_REDIRECT_URI
INSTAGRAM_BUSINESS_REDIRECT_URI
THREADS_APP_ID
THREADS_APP_SECRET
THREADS_REDIRECT_URI
THREADS_WEBHOOK_VERIFY_TOKEN
TIKTOK_CLIENT_KEY
TIKTOK_CLIENT_SECRET
TIKTOK_REDIRECT_URI
TIKTOK_WEBHOOK_SECRET
PINTEREST_CLIENT_ID
PINTEREST_CLIENT_SECRET
PINTEREST_REDIRECT_URI
LINKEDIN_CLIENT_ID
LINKEDIN_CLIENT_SECRET
LINKEDIN_REDIRECT_URI
TWITTER_CLIENT_ID
TWITTER_CLIENT_SECRET
TWITTER_REDIRECT_URI
GOOGLE_CLIENT_ID
GOOGLE_CLIENT_SECRET
YOUTUBE_REDIRECT_URI
REDDIT_CLIENT_ID
REDDIT_CLIENT_SECRET
REDDIT_REDIRECT_URI
BLUESKY_REDIRECT_URI
WHATSAPP_WEBHOOK_VERIFY_TOKEN
WHATSAPP_VERIFY_PIN
WHATSAPP_ACCESS_TOKEN
WHATSAPP_PHONE_NUMBER_ID
WHATSAPP_BUSINESS_ACCOUNT_ID
WHATSAPP_APP_SECRET
META_APP_SECRET
RESEND_API_KEY
RESEND_WEBHOOK_SECRET
SEND_EMAIL_HOOK_SECRET
EMAIL_FROM
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
OPENAI_API_KEY
OPENROUTER_API_KEY
ANTHROPIC_API_KEY
GEMINI_API_KEY
GOOGLE_AI_STUDIO_KEY
PERPLEXITY_API_KEY
XAI_API_KEY
ZAI_API_KEY
MINIMAX_API_KEY
MINIMAX_GROUP_ID
ELEVENLABS_API_KEY
LOVABLE_API_KEY
BRAVE_SEARCH_API_KEY
EXA_API_KEY
FIRECRAWL_API_KEY
APIFY_API_TOKEN
UNSPLASH_ACCESS_KEY
CLOUDINARY_CLOUD_NAME
CLOUDINARY_API_KEY
CLOUDINARY_API_SECRET
ACRCLOUD_HOST
ACRCLOUD_ACCESS_KEY
ACRCLOUD_ACCESS_SECRET
DEEPGRAM_API_KEY
ATLASCLOUD_API_KEY
"

# ---- Report status for a var (masked) ---------------------------------------
# Prints "present" / "missing" / "empty". Never echoes the value.
check_var() {
  local name="$1"
  local out
  out="$(docker exec "$CONTAINER" sh -c "if v=\$(printenv \"$name\" 2>/dev/null); then if [ -n \"\$v\" ]; then echo present; else echo empty; fi; else echo missing; fi" 2>/dev/null || echo missing)"
  echo "$out"
}

echo ""
echo "=== Required variables (must be present) ==="
for v in $REQUIRED_VARS; do
  s="$(check_var "$v")"
  if [ "$s" != "present" ]; then
    echo "${RED}  $v: $s  <-- REQUIRED MISSING${RST}"
    fail=1
  else
    echo "${GRN}  $v: $s${RST}"
  fi
done

echo ""
echo "=== Optional variables (provider-specific) ==="
for v in $OPTIONAL_VARS; do
  s="$(check_var "$v")"
  case "$s" in
    present) echo "${GRN}  $v: $s${RST}" ;;
    empty)   echo "${YLW}  $v: empty${RST}" ;;
    *)       echo "${DIM}  $v: missing${RST}" ;;
  esac
done

# ---- Endpoint smoke tests ---------------------------------------------------
echo ""
echo "=== Endpoint smoke tests ==="

code="$(curl -s -o /dev/null -w '%{http_code}' "$FUNCTIONS_URL/get-public-config" 2>/dev/null || echo 000)"
if [ "$code" = "200" ]; then
  echo "${GRN}get-public-config: reachable (HTTP $code)${RST}"
else
  echo "${RED}get-public-config: HTTP $code${RST}"
  fail=1
fi

body="$(curl -s "$FUNCTIONS_URL/resend-webhook" 2>/dev/null || true)"
if echo "$body" | grep -qi "not configured"; then
  echo "${RED}resend-webhook: 'not configured' (secret missing in container)${RST}"
  fail=1
elif echo "$body" | grep -qi "signature\|svix\|invalid"; then
  echo "${GRN}resend-webhook: secret loaded (signature check active)${RST}"
else
  echo "${YLW}resend-webhook: unexpected response — manual review needed${RST}"
fi

echo ""
if [ "$fail" -ne 0 ]; then
  echo "${RED}RESULT: FAILED — see issues above.${RST}"
  exit 1
fi
echo "${GRN}RESULT: OK — all required variables present and endpoints reachable.${RST}"
exit 0
