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
  whatsapp_workspace_crm.sql
  import_whatsapp_contacts_to_workspace.sql
)
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
prod_like() {
  # '*production*' needs no case of its own: '*prod*' already covers it.
  case "$1" in
    *prod*|*live*|*primary*) return 0 ;;
    *) return 1 ;;
  esac
}
if [ -z "$DB_URL" ]; then
  fail 2 "DB_URL is not set. Usage:
  DB_URL='postgres://user:pass@host:5432/postgres' bash scripts/db-harness.sh
  or:  bash scripts/db-harness.sh 'postgres://user:pass@host:5432/postgres'"
fi
if prod_like "$HARNESS_DB_NAME"; then
  fail 2 "REFUSING: harness database name '$HARNESS_DB_NAME' looks production-like.
  This script drops and creates databases. Point it at a throwaway server."
fi
MAINT_DB="$(printf '%s' "$DB_URL" | sed -nE 's#.*/([^/?]+)(\?.*)?$#\1#p')"
if [ -z "$MAINT_DB" ]; then
  fail 2 "REFUSING: the connection string names no database (got '$DB_URL').
  Name a maintenance database explicitly, e.g. .../postgres — the harness
  creates '$HARNESS_DB_NAME' itself."
fi
case "$MAINT_DB" in
  *[@:]*)
    fail 2 "REFUSING: could not parse a database name out of '$DB_URL'
  (got '$MAINT_DB', which still looks like host/user fragments). Name a
  maintenance database explicitly, e.g. .../postgres." ;;
esac
if prod_like "$MAINT_DB"; then
  fail 2 "REFUSING: the connection string targets database '$MAINT_DB', which looks production-like."
fi
if [ "$MAINT_DB" = "$HARNESS_DB_NAME" ]; then
  fail 2 "REFUSING: the connection string already targets the harness database '$HARNESS_DB_NAME'.
  Connect to a maintenance database (e.g. 'postgres'); the harness creates '$HARNESS_DB_NAME' itself."
fi
command -v psql >/dev/null 2>&1 || fail 2 "psql is required but not on PATH"

# URL for the harness database: swap the path component of DB_URL.
# The scheme must be matched up to '://' — an earlier version of this regex
# omitted the colon and silently matched nothing, leaving every subsequent
# step pointed at the MAINTENANCE database (dropping its schemas!). The
# current_database() check below now makes any rewrite failure loud.
harness_url() {
  printf '%s' "$DB_URL" | sed -E "s#^([a-zA-Z][a-zA-Z0-9+.-]*://[^/]*/)[^/?]*(\?.*)?\$#\1$HARNESS_DB_NAME#"
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
MARKER="$(sed -n '1s/^-- BASELINE_MIGRATION: \(.*\.sql\)[[:space:]]*$/\1/p' "$BASELINE")"
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
GOT_DB="$(psql "${PSQL_COMMON[@]}" "$HARNESS_URL" -Atqc "select current_database()" 2>/dev/null)" \
  || fail 2 "could not connect to the harness database via '$HARNESS_URL'
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
echo "db-harness: baseline marker        : $MARKER"
echo "db-harness: migrations in baseline : $((TOTAL - ${#NEW_MIGRATIONS[@]})) (skipped — already in the dump)"
echo "db-harness: migrations to apply    : ${#NEW_MIGRATIONS[@]}"

ERR="$(mktemp)"
trap 'rm -f "$ERR"' EXIT
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
for s in "${SUITES[@]}"; do
  STEP="suite $s"
  echo "db-harness: running suite $s"
  if ! psql "${PSQL_COMMON[@]}" "$HARNESS_URL" -f "$TESTS_DIR/$s" 2>"$ERR"; then
    echo "" >&2
    echo "db-harness: SUITE FAILED: $s" >&2
    sed 's/^/  /' "$ERR" >&2
    exit 1
  fi
done

echo "db-harness: race fixture partner_api_race_fixture.sql intentionally NOT applied (manual concurrency rehearsal; see supabase/tests/README.md)"
echo "db-harness: OK — baseline ($MARKER) + ${#NEW_MIGRATIONS[@]} newer migrations + ${#SUITES[@]} suites passed"
echo "db-harness: harness database left in place for inspection: $HARNESS_URL"
