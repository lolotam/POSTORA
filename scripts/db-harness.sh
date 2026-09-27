#!/usr/bin/env bash
# ============================================================================
# db-harness.sh — Postgres integration-test harness (deliverable 0.3).
#
# DESIGN: baseline + delta. The migration history is NOT replayable from
# scratch: 12 of the 253 migrations can only ever succeed against the one
# production database (see supabase/tests/README.md — worst is
# 20260323202049, which inserts ai_models rows with a provider_id hardcoded
# to a UUID that no migration ever creates). A replay can never be green,
# and a harness that tolerates failures proves nothing.
#
# What this proves instead: that migrations NEWER than a committed baseline
# apply cleanly to today's production shape, and that the SQL suites pass on
# the result — on every push and PR.
#
# Steps (each must succeed, or the run stops and names the step):
#   0. safety: refuse production-looking database names; require superuser
#   1. validate the baseline contract locally (file + marker, see below)
#   2. drop + create HARNESS_DB_NAME on the server DB_URL points at
#   3. prep: extensions schema + extensions the baseline needs but a
#      schema-only dump never carries, then drop any existing copies of the
#      four schemas the dump recreates (pg_dump emits unconditional
#      CREATE SCHEMA for each; `public` exists in every fresh database and
#      this image also templates auth/storage/realtime into new databases
#      some time after boot), then ensure the supabase_realtime publication
#      exists (publications are database-level objects and are NOT included
#      in a schema-filtered dump, but migrations ALTER this one)
#   4. restore supabase/tests/baseline_schema.sql
#   5. apply ONLY migrations strictly newer than the baseline marker
#   6. seed one auth.users row (partner_api_test.sql takes
#      `(select id from auth.users limit 1)` as an owner)
#   7. run the SQL suites:
#        partner_api_test.sql             rolls itself back
#        partner_api_tenancy_negative.sql self-cleaning; MUST run as
#                                          superuser — it SET ROLEs away from
#                                          it, or its grant checks would be
#                                          vacuous (superuser bypasses them)
#        whatsapp_workspace_crm.sql       pgTAP; rolls itself back
#        import_whatsapp_contacts_to_workspace.sql  pgTAP; rolls itself back
#      supabase/tests/partner_api_race_fixture.sql is deliberately NOT run:
#      it is a fixture for the manual two-session concurrency rehearsal, not
#      a suite; applying it on its own proves nothing.
#
# BASELINE CONTRACT — supabase/tests/baseline_schema.sql
#   * FIRST line, exactly:  -- BASELINE_MIGRATION: <filename>.sql
#     naming the newest supabase/migrations/*.sql file the dump contains.
#     A missing/corrupt marker, or one naming a migration that does not
#     exist, is a LOUD failure — never a silent skip or re-application.
#   * Body: a schema-only dump of the PRODUCTION schemas that `public`
#     objects depend on:
#       pg_dump --schema-only --no-owner \
#         --schema=public --schema=auth --schema=storage --schema=realtime \
#         <production connection>
#     - auth/storage/realtime are included because public tables FK to
#       auth.users and public policies call auth.uid()/storage.foldername();
#       a public-only dump cannot restore without them.
#     - `extensions` is deliberately NOT dumped: a schema-filtered pg_dump
#       emits unconditional `CREATE SCHEMA` for every schema it carries, so
#       anything prep creates here would collide at restore time. Prep
#       creates the extensions schema and the extensions instead.
#     - --no-owner so the dump restores regardless of which superuser runs
#       it; do NOT add --no-privileges — the tenancy suite asserts the
#       production GRANT surface, which the ACLs in the dump carry.
#   * Target server: the supabase/postgres image (CI pins
#     supabase/postgres:17.6.1.158). The Supabase roles (anon,
#     authenticated, service_role, ...) are created cluster-wide by that
#     image, so the dump's GRANTs resolve. A vanilla postgres server will
#     fail at the first GRANT — that is intentional, not a bug.
#   * Regeneration procedure: supabase/tests/README.md.
#
# pg_cron note: pg_cron refuses CREATE EXTENSION in any database except the
# one named by cron.database_name (a postmaster-level setting). Start the
# server with:
#   -c cron.database_name=$HARNESS_DB_NAME -c shared_preload_libraries=pg_cron,pg_net
# CI does exactly this. Without it the harness still runs — prep prints a
# NOTICE and a migration that needs cron fails loudly with the hint below.
#
# Usage:
#   DB_URL='postgres://supabase_admin:pass@localhost:5432/postgres' \
#     HARNESS_DB_NAME=partner_api_harness bash scripts/db-harness.sh
#   or:  bash scripts/db-harness.sh 'postgres://user:pass@host:5432/postgres'
#
# THIS SCRIPT DROPS AND CREATES DATABASES. The name guard below is a
# seatbelt, not a guarantee: point it only at servers you are willing to
# lose.
# ============================================================================
set -euo pipefail
set +x            # never trace: DB_URL carries a password and xtrace prints it
export LC_ALL=C   # deterministic filename ordering everywhere in this script

DB_URL="${1:-${DB_URL:-}}"
HARNESS_DB_NAME="${HARNESS_DB_NAME:-partner_api_harness}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIGRATIONS_DIR="$REPO_ROOT/supabase/migrations"
TESTS_DIR="$REPO_ROOT/supabase/tests"
BASELINE="$TESTS_DIR/baseline_schema.sql"
# Ordered on purpose: the partner suite rolls back; the tenancy suite
# self-cleans and commits (its cascade-survival check needs committed
# state, which is also why it cannot join the rolling-back suite); the two
# pgTAP suites roll back and seed their own auth.users.
SUITES=(
  partner_api_test.sql
  partner_api_tenancy_negative.sql
  partner_api_credential_lifecycle.sql
  partner_api_dispatch_intents.sql
  partner_media_tenancy.sql
  partner_webhook_outbox.sql
  partner_webhook_phase6_events.sql
  publishing_seam.sql
  hybrid_connectors.sql
  comment_workflow.sql
  youtube_composio_provider.sql
  youtube_comments.sql
  partner_posts.sql
  partner_media_scan_state.sql
  partner_usage_counters.sql
  partner_key_environment.sql
  partner_hub_admin.sql
  whatsapp_workspace_crm.sql
  import_whatsapp_contacts_to_workspace.sql
  social_contacts.sql
  byok_provider_keys.sql
  log_system_event.sql
  ai_agent_dashboard.sql
  agent_procedures.sql
  agent_test_limits.sql
  agent_procedures_b.sql
  whatsapp_scheduled_sender.sql
)
# These fixtures build their own focused schema and apply the migration under
# test. They must never run against the restored production-shaped database.
ISOLATED_SUITES=(website_setup_jobs.sql)
ISOLATED_DB_NAME=website_setup_test
SEED_USER_ID="0e5eeee1-0000-4000-8000-000000000001"
SEED_USER_EMAIL="harness-seed@example.invalid"

STEP="setup"
trap 'echo "" >&2; echo "db-harness: FAILED at step: $STEP" >&2' ERR

fail() {  # fail <exit-code> <message-lines...>
  local code="$1"; shift
  echo "db-harness: $*" >&2
  exit "$code"
}

# --- 0. safety: never touch anything that smells like production -----------

# Defined here, above the first failure path, because two early exits used to
# interpolate the raw DB_URL and leaked its password. A redactor that only
# exists further down protects only the exits below it.
redact() {  # redact <url> -> mask credentials wherever a URI can carry them
  # TWO places, not one. An authority-only redactor leaves
  # `?password=...` in plain sight, and libpq accepts credentials there.
  printf '%s' "$1" \
    | sed -E 's#(://)[^/@]*@#\1***@#' \
    | sed -E 's#([?&](password|passfile|sslpassword|sslkey)=)[^&]*#\1***#g'
}
prod_like() {
  # Lowercased first: '/Production' and '/LIVE' are the same danger as
  # '/production', and a case-sensitive guard waves them through.
  local n
  n="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')"
  # '*production*' needs no case of its own: '*prod*' already covers it.
  case "$n" in
    *prod*|*live*|*primary*) return 0 ;;
    *) return 1 ;;
  esac
}
if [ -z "$DB_URL" ]; then
  fail 2 "DB_URL is not set. Usage:
  DB_URL='postgres://user:pass@host:5432/postgres' bash scripts/db-harness.sh
  or:  bash scripts/db-harness.sh 'postgres://user:pass@host:5432/postgres'"
fi
# HARNESS_DB_NAME is interpolated into DROP DATABASE / CREATE DATABASE. It is
# an environment variable, so it is untrusted input to a destructive statement:
# without this it accepts quotes and semicolons and becomes SQL injection with
# DROP privileges. A plain lowercase identifier is all a throwaway database
# ever needs.
case "$HARNESS_DB_NAME" in
  *[!a-z0-9_]*|"" )
    fail 2 "REFUSING: HARNESS_DB_NAME='$HARNESS_DB_NAME' is not a plain identifier.
  Allowed: lowercase letters, digits and underscore. This value is
  interpolated into DROP DATABASE." ;;
esac
if prod_like "$HARNESS_DB_NAME"; then
  fail 2 "REFUSING: harness database name '$HARNESS_DB_NAME' looks production-like.
  This script drops and creates databases. Point it at a throwaway server."
fi
MAINT_DB="$(printf '%s' "$DB_URL" | sed -nE 's#.*/([^/?]+)(\?.*)?$#\1#p')"
if [ -z "$MAINT_DB" ]; then
  fail 2 "REFUSING: the connection string names no database (got '$(redact "$DB_URL")').
  Name a maintenance database explicitly, e.g. .../postgres — the harness
  creates '$HARNESS_DB_NAME' itself."
fi
case "$MAINT_DB" in
  *[@:]*)
    fail 2 "REFUSING: could not parse a database name out of '$(redact "$DB_URL")'
  (got '$MAINT_DB', which still looks like host/user fragments). Name a
  maintenance database explicitly, e.g. .../postgres." ;;
esac
# Checked BEFORE libpq decodes it, so '/pr%6fduction' would slip past the
# prod_like test below and connect to `production`. Rather than reimplement
# libpq PERCENT-DECODES query keywords before matching them against connection
# options, so `%64bname=production` is `dbname=production` and `%70assword=` is
# `password=`. Both walked straight past an earlier version of this guard and
# past the redactor. Rather than reimplement libpq's decoding in bash, refuse a
# query string containing any percent-encoding at all: the harness has no
# legitimate use for one, and "cannot tell what this decodes to" is not a state
# a guard on a destructive script should proceed from.
case "$DB_URL" in
  *\?*%*)
    fail 2 "REFUSING: the connection string's query contains percent-encoding.
  libpq decodes query keywords before matching them, so an encoded key such as
  %64bname= is dbname= by the time it reaches the server, while these checks
  would still be reading it as literal text. Pass unencoded parameters." ;;
esac
# libpq accepts connection parameters in the URI query string, and dbname=
# there OVERRIDES the path. A guard that only inspects the path can be walked
# straight past with `.../scratch?dbname=production`. Rather than reimplement
# libpq's precedence rules in bash, refuse a URL that carries any query
# parameter capable of redirecting the connection.
case "$DB_URL" in
  *[?\&]dbname=*|*[?\&]host=*|*[?\&]hostaddr=*|*[?\&]service=*|*[?\&]port=*)
    fail 2 "REFUSING: the connection string carries a query parameter that can
  redirect the connection (dbname=, host=, hostaddr=, service= or port=).
  libpq lets those override the URL's own path, so the safety checks below
  would be inspecting one target while psql connects to another. Put the
  database in the path instead." ;;
esac
case "$MAINT_DB" in
  *%*)
    fail 2 "REFUSING: the database name in the connection string is
  percent-encoded ('$MAINT_DB'). This script cannot safely tell what it
  decodes to before connecting. Pass a plain database name." ;;
esac
if prod_like "$MAINT_DB"; then
  fail 2 "REFUSING: the connection string targets database '$MAINT_DB', which looks production-like."
fi
if [ "$MAINT_DB" = "$HARNESS_DB_NAME" ]; then
  fail 2 "REFUSING: the connection string already targets the harness database '$HARNESS_DB_NAME'.
  Connect to a maintenance database (e.g. 'postgres'); the harness creates '$HARNESS_DB_NAME' itself."
fi
if [ "$MAINT_DB" = "$ISOLATED_DB_NAME" ] || [ "$HARNESS_DB_NAME" = "$ISOLATED_DB_NAME" ]; then
  fail 2 "REFUSING: '$ISOLATED_DB_NAME' is reserved for the isolated SQL suite.
  Neither the maintenance nor the baseline harness database may use that name."
fi
command -v psql >/dev/null 2>&1 || fail 2 "psql is required but not on PATH"

# URL for the harness database: swap the path component of DB_URL.
# The scheme must be matched up to '://' — an earlier version of this regex
# omitted the colon and silently matched nothing, leaving every subsequent
# step pointed at the MAINTENANCE database (dropping its schemas!). The
# current_database() check below now makes any rewrite failure loud.
harness_url() {
  local target_db="${1:-$HARNESS_DB_NAME}"
  printf '%s' "$DB_URL" | sed -E "s#^([a-zA-Z][a-zA-Z0-9+.-]*://[^/]*/)[^/?]*(\?.*)?\$#\1$target_db#"
}

PSQL_COMMON=(-X --set=ON_ERROR_STOP=1)

echo "db-harness: maintenance database : $MAINT_DB"
echo "db-harness: harness database     : $HARNESS_DB_NAME (dropped + recreated)"

# --- 1. baseline contract, validated BEFORE touching the server ------------
STEP="baseline contract"
if [ ! -f "$BASELINE" ]; then
  fail 2 "baseline not found: $BASELINE
  It is generated from production and committed — see supabase/tests/README.md,
  'Regenerating the baseline'. Nothing runs without it."
fi
# The marker line carries two fields; the count is parsed separately below.
#   -- BASELINE_MIGRATION: <file>.sql  BASELINE_COUNT: <n>
MARKER="$(sed -n '1s/^-- BASELINE_MIGRATION: \([^ ]*\.sql\).*$/\1/p' "$BASELINE")"
if [ -z "$MARKER" ]; then
  fail 2 "baseline $BASELINE is missing its marker: the FIRST line must be
  -- BASELINE_MIGRATION: <newest migration filename included in the dump>.sql
  A baseline without a marker cannot be trusted; regenerate it (README) rather
  than hand-editing this one — the marker decides which migrations get applied."
fi
if [ ! -f "$MIGRATIONS_DIR/$MARKER" ]; then
  fail 2 "baseline marker names migration '$MARKER', which does not exist in
  $MIGRATIONS_DIR. Either the baseline was generated against a different
  history, or a migration was renamed/removed. Regenerate the baseline (README)."
fi

# --- connectivity + superuser -----------------------------------------------
STEP="connectivity preflight"
SUPER="$(psql "${PSQL_COMMON[@]}" "$DB_URL" -Atc \
  "select rolsuper from pg_roles where rolname = current_user" 2>/dev/null)" \
  || fail 2 "cannot connect with the given DB_URL"
[ "$SUPER" = "t" ] || fail 2 "REFUSING: the connecting role is not a superuser.
  DROP DATABASE needs it, and partner_api_tenancy_negative.sql requires it
  (its grant checks SET ROLE away from superuser, which is the point).
  On the supabase/postgres image connect as supabase_admin, NOT 'postgres' —
  in that image 'postgres' is deliberately not superuser and cannot touch
  the auth schema."

# --- 2. fresh database -------------------------------------------------------
STEP="create harness database"
psql "${PSQL_COMMON[@]}" "$DB_URL" -q -c "drop database if exists \"$HARNESS_DB_NAME\" with (force)"
psql "${PSQL_COMMON[@]}" "$DB_URL" -q -c "create database \"$HARNESS_DB_NAME\""
HARNESS_URL="$(harness_url)"
# HARNESS_URL carries whatever credentials DB_URL carried. It must never be
# echoed: CI logs are retained and frequently public, and the documented local
# interface takes an arbitrary connection string. Everything user-facing uses
# this redacted form instead.
redacted_url() {
  # strip any user[:password]@ between the scheme and the host
  printf '%s' "$HARNESS_URL" | sed -E 's#(://)[^/@]*@#\1***@#'
}
GOT_DB="$(psql "${PSQL_COMMON[@]}" "$HARNESS_URL" -Atqc "select current_database()" 2>/dev/null)" \
  || fail 2 "could not connect to the harness database via '$(redacted_url)'
  (check the URL rewrite if your connection string is unusual)"
[ "$GOT_DB" = "$HARNESS_DB_NAME" ] || fail 2 "REFUSING: after rewriting the URL for the harness database, psql reports current_database() = '$GOT_DB', expected '$HARNESS_DB_NAME'. The connection string shape is not understood — refusing rather than running further steps against the wrong database."

# --- 3. prep -----------------------------------------------------------------
# See BASELINE CONTRACT in the header for why each piece lives here and not
# in the dump: schema-filtered pg_dump emits unconditional CREATE SCHEMA for
# every schema it carries and NO CREATE EXTENSION statements at all.
STEP="prep (extensions, public schema, realtime publication)"
psql "${PSQL_COMMON[@]}" "$HARNESS_URL" -q <<'PREP'
CREATE SCHEMA IF NOT EXISTS extensions;

-- The dump carries GRANTs to every role production has, and a GRANT to a role
-- that does not exist is a hard error, not a warning. The supabase/postgres
-- image creates all of them cluster-wide EXCEPT supabase_realtime_admin, which
-- the Realtime service creates at runtime -- so the image alone cannot restore
-- a dump that includes the realtime schema.
--
-- Created NOLOGIN with no privileges: it exists so the dump's GRANTs resolve,
-- nothing more. Nothing in the harness authenticates as it, and no test asserts
-- anything through it. Verified 2026-08-30: this is the ONLY role the baseline
-- references that the image lacks -- the other eight (anon, authenticated,
-- dashboard_user, postgres, service_role, supabase_admin, supabase_auth_admin,
-- supabase_storage_admin) all ship with it.
DO $realtime_role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'supabase_realtime_admin') THEN
    CREATE ROLE supabase_realtime_admin NOLOGIN NOINHERIT;
    RAISE NOTICE 'prep: created stub role supabase_realtime_admin (Realtime creates it in production)';
  END IF;
END
$realtime_role$;

-- Deterministic extensions: binaries only, no server configuration needed.
-- Hard-fail if these are missing: the baseline restore would otherwise die
-- later with a confusing "type <schema>.vector does not exist".
--
-- THE SCHEMA OF EACH ONE MATCHES PRODUCTION, and that is not cosmetic. An
-- extension's schema is part of the type names the dump emits: production has
-- vector in PUBLIC, so the baseline is full of `public.vector` and creating it
-- in `extensions` here fails the restore outright. It did, the first time this
-- was run. Verified against production on 2026-08-30:
--
--   vector     public       <- not extensions, despite the others
--   pgcrypto   extensions
--   uuid-ossp  extensions
--   pg_net     extensions
--   pg_cron    pg_catalog
--
-- If a future baseline moves one of these, this block moves with it, or the
-- restore breaks in a way that reads like a missing binary rather than a
-- misplaced one.
-- NOTE: `vector` is deliberately NOT created here. It lives in `public`, which
-- the DROP SCHEMA below destroys, so it is created in step 4 instead, after
-- that drop and immediately before the restore that needs it.
-- USAGE on `extensions`, matching production. Without it the schema has NO
-- acl at all, and the moment a suite SET ROLEs away from superuser -- which
-- the pgTAP suites and the tenancy suite both do, deliberately -- every
-- function in there becomes invisible. It surfaces as
-- "function lives_ok(unknown, unknown) does not exist", which reads like a
-- missing extension rather than a missing grant. Production's ACL, verified
-- 2026-08-30: anon=U, authenticated=U, service_role=U, dashboard_user=UC.
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
GRANT USAGE, CREATE ON SCHEMA extensions TO dashboard_user;

CREATE EXTENSION IF NOT EXISTS pgcrypto    WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA extensions;

-- pg_cron / pg_net are configuration-dependent (shared_preload_libraries,
-- and pg_cron only loads in the database named by cron.database_name), so
-- they are best-effort here WITH the remediation spelled out. A migration
-- that needs cron will then fail loudly naming it.
DO $cron$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;
  RAISE NOTICE 'prep: pg_cron ready';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'prep: pg_cron unavailable (%) — start the server with -c cron.database_name=% and -c shared_preload_libraries=pg_cron,pg_net if a migration needs it', SQLERRM, current_database();
END
$cron$;
DO $net$
BEGIN
  CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;
  RAISE NOTICE 'prep: pg_net ready';
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'prep: pg_net unavailable (%) — start the server with -c shared_preload_libraries=pg_cron,pg_net if a migration needs it', SQLERRM;
END
$net$;

-- pg_dump recreates every schema it carries with an UNCONDITIONAL
-- CREATE SCHEMA (including `public`), so remove whatever copies already
-- exist or the restore aborts with "schema ... already exists". This
-- matters twice over: `public` exists in every fresh database, and this
-- image also scaffolds auth/storage/realtime into new databases from its
-- template some time after boot — so the same run can meet either shape.
-- The dump is the single source of truth for all four schemas.
DROP SCHEMA IF EXISTS auth CASCADE;
DROP SCHEMA IF EXISTS storage CASCADE;
DROP SCHEMA IF EXISTS realtime CASCADE;
DROP SCHEMA IF EXISTS public CASCADE;

-- Migrations ALTER this publication; publications are database-level and a
-- schema-filtered dump does not carry them.
DO $pub$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END
$pub$;
PREP

# --- 4. restore the baseline --------------------------------------------------
#
# The baseline needs `public.vector` to exist before it declares its first
# vector column, but the extension cannot be created before the prep step's
# DROP SCHEMA public CASCADE (which takes the extension with it -- "drop
# cascades to extension vector", observed the first time this ran), and cannot
# be created after the restore either, because the restore is what needs it.
#
# So: create `public` and the extension here, between the drop and the restore,
# and strip the dump's own `CREATE SCHEMA public;` -- the one statement that
# would then collide. Every other CREATE SCHEMA in the dump is left alone.
#
# The count is asserted rather than assumed. If a regenerated dump ever stops
# containing exactly one such line -- a different pg_dump version, a different
# schema list -- this fails loudly here instead of silently restoring a
# half-built schema.
STEP="restore baseline_schema.sql"

SCHEMA_LINES=$(grep -c '^CREATE SCHEMA public;$' "$BASELINE" || true)
if [ "$SCHEMA_LINES" != "1" ]; then
  echo "db-harness: expected exactly 1 'CREATE SCHEMA public;' in the baseline, found ${SCHEMA_LINES}." >&2
  echo "  The baseline's shape has changed; re-check the pg_dump invocation in supabase/tests/README.md." >&2
  exit 1
fi

psql "${PSQL_COMMON[@]}" "$HARNESS_URL" -q <<'VECTOR_PREP'
CREATE SCHEMA public;
-- public, matching production: the dump is full of `public.vector`.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
VECTOR_PREP

grep -v '^CREATE SCHEMA public;$' "$BASELINE" \
  | psql "${PSQL_COMMON[@]}" "$HARNESS_URL" -q

# --- 5. apply only migrations strictly newer than the marker -----------------
# Pure-bash glob (not `ls *.sql` under nullglob, and not `find -printf`,
# which does not exist on BusyBox userlands like the postgres image's):
# with nullglob an empty directory yields an empty list, which the TOTAL
# guard below turns into a loud failure instead of a silent no-op.
ALL_MIGRATIONS=()
shopt -s nullglob
for f in "$MIGRATIONS_DIR"/*.sql; do
  ALL_MIGRATIONS+=("${f##*/}")
done
shopt -u nullglob
TOTAL="${#ALL_MIGRATIONS[@]}"
[ "$TOTAL" -gt 0 ] || fail 2 "no migrations found in $MIGRATIONS_DIR"

NEW_MIGRATIONS=()
for f in "${ALL_MIGRATIONS[@]}"; do
  if [[ "$f" > "$MARKER" ]]; then
    NEW_MIGRATIONS+=("$f")
  fi
done
# THE SILENT-SKIP GUARD.
#
# "Strictly newer than the marker" is only safe if the set of migrations at or
# below the marker is exactly the set the dump was taken from. Two ways that
# stops being true, both of which skip a migration WITHOUT failing:
#
#   * someone adds a migration with a timestamp at or below the marker -- a
#     backdated file, a rebased branch, a hand-edited name. It sorts into the
#     "already in the dump" bucket and is never applied here, and never proven
#     anywhere.
#   * someone regenerates the baseline and forgets to move the marker (or
#     moves the marker and forgets to regenerate), so the counts drift apart.
#
# The marker line therefore also carries the COUNT of migrations the dump
# contains, and that count is asserted against what is on disk. A mismatch is
# a loud failure naming both numbers. This is the difference between a harness
# that skips work and one that says so.
# Anchored, whole-field: `BASELINE_COUNT: 253junk` must not read as 253.
BASELINE_COUNT="$(sed -n '1s/.*BASELINE_COUNT: \([0-9][0-9]*\)\([[:space:]].*\)\{0,1\}$/\1/p' "$BASELINE")"
BASELINE_SUM="$(sed -n '1s/.*BASELINE_SUM: \([0-9a-f]\{64\}\).*/\1/p' "$BASELINE")"
IN_BASELINE=$((TOTAL - ${#NEW_MIGRATIONS[@]}))
if [ -z "$BASELINE_COUNT" ]; then
  fail 2 "the baseline's first line carries no BASELINE_COUNT.
  Expected:  -- BASELINE_MIGRATION: <file>.sql  BASELINE_COUNT: <n>
  Without the count, a migration added at or below the marker would be
  silently skipped. Regenerate per supabase/tests/README.md."
fi
# The count binds the marker to a NUMBER of files, which a swap defeats:
# delete one historical migration, add another below the marker, and the count
# is unchanged. The checksum binds it to the exact SET of filenames the dump was
# taken from, so a rename, a swap or a deletion all fail here.
#
# What neither catches: regenerating the dump against a newer database while
# keeping the old marker -- nothing inside a schema dump names the last
# migration applied to it. That is why regeneration is a script
# (scripts/regenerate-baseline.sh) that writes dump, marker, count and checksum
# in one step: drift then needs a deliberate hand-edit, not a forgotten step.
# REQUIRED, not optional. An optional checksum is no checksum: deleting the
# field from the header would silently downgrade this back to the count-only
# guard that a swap defeats.
if [ -z "$BASELINE_SUM" ]; then
  fail 2 "the baseline's header carries no BASELINE_SUM.
  Expected:  -- BASELINE_MIGRATION: <file>.sql  BASELINE_COUNT: <n>  BASELINE_SUM: <sha256>
  Without it a renamed or swapped migration below the marker is undetectable.
  Regenerate with scripts/regenerate-baseline.sh."
fi
if true; then
  ACTUAL_SUM="$(printf '%s\n' "${ALL_MIGRATIONS[@]}" \
    | awk -v m="$MARKER" '$0 <= m' | sha256sum | cut -d' ' -f1)"
  if [ "$ACTUAL_SUM" != "$BASELINE_SUM" ]; then
    fail 2 "BASELINE DRIFT: the migrations at or below the marker are not the
  set the dump was taken from.
    expected $BASELINE_SUM
    actual   $ACTUAL_SUM
  Something was renamed, replaced or removed at or below '$MARKER'. A swap
  leaves the count identical, which is why this checksum exists. Regenerate
  with scripts/regenerate-baseline.sh (see supabase/tests/README.md)."
  fi
fi
if [ "$IN_BASELINE" != "$BASELINE_COUNT" ]; then
  fail 2 "BASELINE DRIFT: the dump says it contains $BASELINE_COUNT migrations,
  but $IN_BASELINE files on disk sort at or below the marker '$MARKER'.
  Something was added at or below the marker, or the baseline and its marker
  were regenerated out of step. Refusing to run, because the difference would
  otherwise be migrations nobody tests. See supabase/tests/README.md."
fi

echo "db-harness: baseline marker        : $MARKER"
echo "db-harness: migrations in baseline : $IN_BASELINE (skipped — already in the dump, count verified)"
echo "db-harness: migrations to apply    : ${#NEW_MIGRATIONS[@]}"

ERR="$(mktemp)"
OUT="$(mktemp)"   # suite stdout: the TAP stream is parsed, not just discarded
BOTH="$(mktemp)"  # stdout+stderr: NOTICE-based suites report on stderr
trap 'rm -f "$ERR" "$OUT" "$BOTH"' EXIT
n=0
for f in "${NEW_MIGRATIONS[@]}"; do
  n=$((n + 1))
  STEP="migration $f"
  printf 'db-harness: [%3d/%d] %s\n' "$n" "${#NEW_MIGRATIONS[@]}" "$f"
  if ! psql "${PSQL_COMMON[@]}" "$HARNESS_URL" -q -f "$MIGRATIONS_DIR/$f" 2>"$ERR"; then
    echo "" >&2
    echo "db-harness: MIGRATION FAILED: $f" >&2
    echo "db-harness: error:" >&2
    sed 's/^/  /' "$ERR" >&2
    echo "" >&2
    echo "db-harness: this migration is NEWER than the baseline, so it has not" >&2
    echo "db-harness: shipped yet — fix the migration. Never edit a migration" >&2
    echo "db-harness: at or below the marker: those are already applied in" >&2
    echo "db-harness: production (see README)." >&2
    exit 1
  fi
done
if [ "${#NEW_MIGRATIONS[@]}" -eq 0 ]; then
  echo "db-harness: nothing newer than the baseline — running suites against the baseline as-is"
fi

# --- 6. seed the one auth user the partner suite needs -----------------------
STEP="seed auth user"
psql "${PSQL_COMMON[@]}" "$HARNESS_URL" -q -c \
  "insert into auth.users (id, email) values ('$SEED_USER_ID', '$SEED_USER_EMAIL') on conflict do nothing"

# --- 7. suites ----------------------------------------------------------------
#
# TWO SEPARATE FAILURE SIGNALS, and psql only reports one of them.
#
#   * A SQL error aborts psql and exits non-zero. That is what `if ! psql`
#     catches, and it is all it catches.
#   * A pgTAP assertion failure is not an error. `select is(1, 2, '...')`
#     succeeds as a query and prints `not ok 3 - ...`. psql exits 0.
#
# So the exit status alone gates the SQL-error signal and is blind to the
# assertion signal. Verified by mutation on 2026-08-30: injecting a failing
# assertion into whatsapp_workspace_crm.sql produced HARNESS_EXIT=0 and the
# message "4 suites passed". Both pgTAP suites were gating nothing.
#
# The TAP stream is therefore parsed as well. Three things fail a suite:
#   `not ok`                    an assertion failed
#   `# Looks like you failed`   pgTAP's own summary
#   `# Looks like you planned`  the count ran short - a suite that dies
#                               half-way through still exits 0 otherwise
#
# stdout is captured rather than streamed so it can be inspected. It is
# echoed back on failure, so a red run still shows its output.
# A suite that exists on disk but is not in SUITES is a suite nobody runs --
# and CI reports green. partner_posts.sql sat in that state through a full PR
# review round (2026-09-02) before anyone noticed the suite count had not
# moved. So: every *.sql in the tests dir must be listed, or named here as
# deliberately excluded, or the harness fails before running anything.
STEP="suite inventory"
EXCLUDED_FROM_SUITES=(baseline_schema.sql partner_api_race_fixture.sql)
for f in "$TESTS_DIR"/*.sql; do
  name="$(basename "$f")"
  listed=0
  for s in "${SUITES[@]}" "${ISOLATED_SUITES[@]}" "${EXCLUDED_FROM_SUITES[@]}"; do
    [ "$s" = "$name" ] && listed=1 && break
  done
  if [ "$listed" -eq 0 ]; then
    echo "db-harness: FAIL: $name exists in $TESTS_DIR but is not in SUITES, ISOLATED_SUITES or EXCLUDED_FROM_SUITES." >&2
    echo "  A suite that is not listed never runs, and this harness would still report OK." >&2
    exit 1
  fi
done

for s in "${SUITES[@]}" "${ISOLATED_SUITES[@]}"; do
  STEP="suite $s"
  SUITE_URL="$HARNESS_URL"
  ISOLATED=0
  for isolated_suite in "${ISOLATED_SUITES[@]}"; do
    if [ "$s" = "$isolated_suite" ]; then
      ISOLATED=1
      psql "${PSQL_COMMON[@]}" "$DB_URL" -q -c "drop database if exists \"$ISOLATED_DB_NAME\" with (force)"
      psql "${PSQL_COMMON[@]}" "$DB_URL" -q -c "create database \"$ISOLATED_DB_NAME\""
      SUITE_URL="$(harness_url "$ISOLATED_DB_NAME")"
      GOT_DB="$(psql "${PSQL_COMMON[@]}" "$SUITE_URL" -Atqc "select current_database()")"
      [ "$GOT_DB" = "$ISOLATED_DB_NAME" ] || fail 2 "REFUSING: isolated suite URL resolved to the wrong database."
      break
    fi
  done
  echo "db-harness: running suite $s"
  if ! psql "${PSQL_COMMON[@]}" "$SUITE_URL" -f "$TESTS_DIR/$s" >"$OUT" 2>"$ERR"; then
    echo "" >&2
    echo "db-harness: SUITE FAILED (sql error): $s" >&2
    sed 's/^/  /' "$ERR" >&2
    exit 1
  fi

  # THREE WAYS TO READ THIS OUTPUT WRONG, all of them tried:
  #
  #   false green - an empty or comments-only suite emits nothing, matches no
  #     failure pattern, and gets counted among "4 suites passed". So a suite
  #     must produce POSITIVE evidence it ran: at least one `ok` line (TAP) or
  #     the non-TAP suites' own PASS/ALL CHECKS sentinel.
  #   false red - `not ok ... # TODO` is valid TAP for an expected failure and
  #     a real TAP consumer treats it as passing. Excluded.
  #   false red - the "Looks like you ..." diagnostics were matched
  #     unanchored, so a test whose NAME contains that phrase failed the run.
  #     Anchored to the start of the line, where TAP puts diagnostics.
  #
  # A `not ok` whose test NAME merely contains "not ok" is fine either way:
  # the anchor means only a real result line at column 0 counts.
  cat "$OUT" "$ERR" > "$BOTH"
  # ONE PASS, NO PIPELINE, AND THE WHOLE TAP CONTRACT -- not just "did an
  # assertion fail".
  #
  # The pipeline this replaced produced a FALSE GREEN: `grep -q` exits on its
  # first match, the upstream grep takes SIGPIPE, `pipefail` calls that a
  # failed pipeline, and the leading `!` read it as "no unexpected failures".
  # One pass followed by thousands of `not ok` exited 0.
  #
  # Counting failures alone is still not enough, because it only answers "did
  # any assertion I SAW fail?". Two ways a suite fails without a single
  # `not ok`:
  #
  #   incomplete plan  `1..52` then the connection dies after 6 tests. pgTAP
  #                    reports the discrepancy from finish(), so a suite that
  #                    dies BEFORE finish() emits no diagnostic at all.
  #   Bail out!        TAP's "stop immediately". Everything before it may have
  #                    passed; the run still did not complete.
  #
  # So the plan is parsed and compared against the test points actually seen.
  # `1..0` is a legitimate empty plan (TAP's skip-everything form) and passes.
  # Suites with no plan line at all -- the NOTICE-based ones -- are unaffected;
  # their completeness is covered by the positive-evidence check below.
  #
  # TODO and SKIP directives mark expected failures: valid TAP, and a real
  # consumer counts them as passing. Matched case-insensitively.
  VERDICT="$(awk '
    { line = $0; sub(/\r$/, "", line); low = tolower(line) }

    low ~ /^[[:space:]]*bail out!/ { bailed = 1 }

    # END-ANCHORED, so `1..2garbage` in ordinary query output is not mistaken
    # for a plan. A TAP plan may carry a trailing directive (`1..0 # SKIP ...`)
    # and nothing else.
    low ~ /^[[:space:]]*1\.\.[0-9]+[[:space:]]*(#.*)?$/ {
      planseen++
      if (planseen == 1) {
        s = line; sub(/^[[:space:]]*1\.\./, "", s); sub(/[^0-9].*$/, "", s)
        planned = s + 0
      }
    }

    # A NUMBER is required. psql renders each result in a bordered table, and
    # `select ok(...)` produces a column header that is literally the word
    # `ok` -- which a lenient pattern counts as a 53rd test point against a
    # plan of 52. TAP test points are numbered; headers are not.
    low ~ /^[[:space:]]*(not )?ok[[:space:]]+[0-9]+/ { points++ }

    low ~ /^[[:space:]]*not ok/ {
      failed++
      if (low ~ /#[[:space:]]*(todo|skip)/) excused++
    }

    END {
      if (bailed)                        { print "bailed";     exit }
      if (failed > excused)              { print "failed";     exit }
      # More than one plan is malformed TAP; pgTAP itself refuses a second
      # plan() call, so this means the output is not what it claims to be.
      if (planseen > 1)                  { print "multiplan " planseen; exit }
      if (planseen && points != planned) { print "incomplete " points " " planned; exit }
      # A plan that was seen and matched IS the completion proof; say so, so
      # the caller does not then demand a sentinel as well.
      if (planseen)                      { print "planned-complete"; exit }
      print "no-plan"
    }
  ' "$BOTH")"

  case "$VERDICT" in
    bailed)
      echo "" >&2
      echo "db-harness: SUITE BAILED OUT: $s" >&2
      echo "  TAP 'Bail out!' means the run stopped; earlier passes do not count." >&2
      { grep -inE '^[[:space:]]*bail out!' "$BOTH" || true; } | sed 's/^/  /' >&2 || true
      exit 1 ;;
    failed)
      echo "" >&2
      echo "db-harness: SUITE FAILED (assertion): $s" >&2
      echo "  psql exited 0 - a pgTAP assertion failure is not a SQL error." >&2
      # `|| true` at every stage: under pipefail a `head` that closes early
      # SIGPIPEs its upstream, and with `set -e` that killed the script before
      # its own `exit 1`, turning a clean failure into exit 141. A reporting
      # path must never be able to change the verdict it reports.
      { grep -nE '^[[:space:]]*not ok' "$BOTH" || true; } \
        | { grep -viE '#[[:space:]]*(TODO|SKIP)' || true; } \
        | { head -20 || true; } | sed 's/^/  /' >&2 || true
      exit 1 ;;
    multiplan*)
      echo "" >&2
      echo "db-harness: SUITE EMITTED ${VERDICT#multiplan } TAP PLANS: $s" >&2
      echo "  More than one 1..N line means the output is not the single TAP" >&2
      echo "  stream it claims to be -- pgTAP itself refuses a second plan()." >&2
      exit 1 ;;
    incomplete*)
      echo "" >&2
      echo "db-harness: SUITE INCOMPLETE: $s" >&2
      echo "  ran ${VERDICT#incomplete } (points planned) - the suite stopped" >&2
      echo "  before finishing its plan. pgTAP only reports this from finish()," >&2
      echo "  so a suite that dies earlier says nothing at all." >&2
      exit 1 ;;
  esac

  # pgTAP's own diagnostics, when it did reach finish().
  if grep -qE '^[[:space:]]*# Looks like you (failed|planned)' "$BOTH"; then
    echo "" >&2
    echo "db-harness: SUITE FAILED (plan): $s" >&2
    { grep -nE '^[[:space:]]*# Looks like you (failed|planned)' "$BOTH" || true; } \
      | sed 's/^/  /' >&2 || true
    exit 1
  fi

  # COMPLETION, not merely "something passed", and the sentinel must be the
  # LAST LINE -- not merely present somewhere.
  #
  # A plan that was seen and matched already proves the suite ran to the end,
  # so `planned-complete` needs nothing further. A suite with NO plan must
  # prove completion with a terminal sentinel, because an intermediate `ok`
  # only proves it reached its first assertion.
  #
  # Searching for the phrase ANYWHERE was itself a false green: this repo's
  # assert_eq helper prints its label as a NOTICE, so a test described as
  # "... ALL CHECKS PASSED ..." satisfies a substring search, and the suite can
  # then be truncated and still pass. Requiring it to be the last non-blank
  # line means only a line that actually ran last can satisfy it.
  #
  # STDOUT only, deliberately. $BOTH is stdout and stderr CONCATENATED, not
  # interleaved in time, so "last line of $BOTH" is whatever stderr happened to
  # print last and says nothing about ordering. The sentinels are \echo, which
  # psql writes to stdout.
  if [ "$VERDICT" = "no-plan" ]; then
    LAST_OUT="$(awk 'NF { last = $0 } END { print last }' "$OUT")"
    case "$LAST_OUT" in
      *"ALL CHECKS PASSED"*) : ;;
      *)
        echo "" >&2
        echo "db-harness: SUITE INCOMPLETE (no plan, no terminal sentinel): $s" >&2
        echo "  It exited 0 and emitted no TAP plan, so the only proof it ran" >&2
        echo "  to the end is a sentinel as its LAST line of stdout." >&2
        echo "  last stdout line was: ${LAST_OUT:-<no output>}" >&2
        echo "  A suite truncated after its first passing assertion looks" >&2
        echo "  exactly like this. End no-plan suites with an \echo line" >&2
        echo "  containing ALL CHECKS PASSED; see supabase/tests/README.md." >&2
        exit 1 ;;
    esac
  fi
  if [ "$ISOLATED" -eq 1 ]; then
    psql "${PSQL_COMMON[@]}" "$DB_URL" -q -c "drop database \"$ISOLATED_DB_NAME\" with (force)"
  fi
done

echo "db-harness: race fixture partner_api_race_fixture.sql intentionally NOT applied (manual concurrency rehearsal; see supabase/tests/README.md)"

# The end-to-end chain test (supabase/functions/partner-api/e2e/) runs the
# real /v1 code against THIS database through PostgREST, and needs one
# SECURITY DEFINER fixture function that mints its tenants and keys. It is
# installed here, after every suite has passed, and never anywhere else: it
# is not a migration, and a throwaway database is the only place it may exist.
# A failure to install is a failure of the run -- an E2E job that silently
# found no fixture would report its tests as ignored, which reads as green.
STEP="e2e fixture"
E2E_FIXTURE="$TESTS_DIR/e2e/partner_e2e_fixture.sql"
if [ ! -f "$E2E_FIXTURE" ]; then
  echo "db-harness: FAIL: E2E fixture $E2E_FIXTURE is missing." >&2
  exit 1
fi
if ! psql "${PSQL_COMMON[@]}" "$HARNESS_URL" -f "$E2E_FIXTURE" >"$OUT" 2>"$ERR"; then
  echo "db-harness: FAIL: installing the E2E fixture failed:" >&2
  sed 's/^/  /' "$ERR" >&2
  exit 1
fi
echo "db-harness: E2E fixture installed (partner_e2e_fixture)"

echo "db-harness: OK — baseline ($MARKER) + ${#NEW_MIGRATIONS[@]} newer migrations + ${#SUITES[@]} baseline suites + ${#ISOLATED_SUITES[@]} isolated suites passed"
echo "db-harness: harness database left in place for inspection: $(redacted_url)"
