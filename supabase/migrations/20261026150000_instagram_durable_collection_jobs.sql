-- ===========================================================================
-- Task 3c/4 prerequisite - durable Instagram collection job primitives.
--
-- Plan: docs/plans/2026-10-26-instagram-insights-and-competitor-tracking.md
--   Task 3 ("atomic job enqueue/claim/checkpoint/complete primitives for
--   §5.3, including service-only grants for workers") and the final binding
--   execution details (force semantics, fair retry, credential cutover).
--
-- APPLY AS supabase_admin. It owns the tables and the functions below;
-- postgres is not a superuser on this stack and a REVOKE by a non-owner is a
-- WARNING that changes nothing.
--
-- ===========================================================================
--
-- WHAT THIS IS
--
--   The durable work substrate for the Instagram insights / competitor
--   collector: a job row per (owner, target, Kuwait capture day), an
--   expiring lease, per-generation operation checkpoints, an atomic
--   accepted-request throttle, and fenced writes for the snapshot tables
--   that the already-shipped tracking schema defines.
--
--   It is infrastructure for a worker that does not exist yet. Nothing here
--   calls a provider, schedules a cron job, or enables a collection path.
--   The functions are the contract a future Task 4/6/7 worker will call.
--
-- WHAT THIS IS NOT
--
--   * Not the collector. There is no HTTP here, no provider parsing, no
--     metric vocabulary beyond the column whitelists the snapshot tables
--     already have.
--   * Not an activation. No schedule is created, no cron job is touched and
--     no existing OAuth, refresh or discovery path is modified. A disabled
--     collection path must return before reaching this schema.
--   * Not a second quota system. The competitor entitlement stays in
--     20261026130000; this migration only reads the watchlist.
--   * Not a credential store. It READS the frozen capability relation
--     (instagram_account_capabilities.credential_generation) as the
--     connection-version fence and never writes credentials.
--
-- SECURITY MODEL
--
--   * Every table: RLS enabled, NO policies, privileges revoked from
--     PUBLIC, anon and authenticated. The only direct writers are the
--     service role and the SECURITY DEFINER functions below, which re-check
--     ownership in SQL.
--   * Ownership is STRUCTURAL. A job, an operation, a checkpoint and a
--     throttle row all bind the owner to the target through a composite
--     foreign key (social_account_id, user_id) or (watchlist_id, user_id).
--     A caller cannot name another owner's target: the FK refuses the row.
--   * The service role bypasses RLS, so RLS is never the thing standing
--     between a caller-supplied owner id and another user's row. Every
--     function re-derives the owner from the target row.
--   * The owner-facing functions read the owner from auth.uid() and refuse
--     anything else. The service-facing functions require the service role
--     or an admin, and take the owner as an argument they verify against
--     the target row.
--
-- THE FENCE (why a stale worker cannot write)
--
--   Every result-bearing mutation uses one helper. Progress, inventory
--   checkpoints, snapshot rows and their operation rows, completion
--   (partial, full, retry, unavailable and error), provider-throttle job
--   parking and viewer attachment all refuse unless ALL of these hold,
--   in the same transaction as the write:
--
--     1. the job id exists,
--     2. the claim token matches the job's live lease,
--     3. the lease is still in the future by clock_timestamp(), which is
--        the wall clock, not now() frozen at transaction start,
--     4. the job generation the caller quotes is the job's current
--        generation (a force bumps it, which retires every older claim),
--     5. the target is still the same owned, active row,
--     6. a captured viewer context exists (there is no payload boolean
--        that skips this; a competitor job cannot record provider results
--        until attach has stored the viewer),
--     7. that viewer is still owned, active, not awaiting reauth, and its
--        live credential generation, login kind and permission-read state
--        still match the context captured for this job generation.
--
--   A worker whose credential was replaced after its HTTP call gets NO
--   snapshot, NO checkpoint, NO parked retry and NO success or partial
--   timestamp. The refusal writes nothing.
--
-- LOCK ORDER (do not invert this)
--
--   facebook_user_credential_lock_scope, the credential writers, lock
--   social_accounts FOR UPDATE by id, then the social_account_guard
--   advisory, then the instagram_capability advisory, and only then the
--   credential row. Parent delete locks the account or the watchlist and
--   then cascades to the job. This migration takes the same prefix and
--   stops before the credential row:
--
--     1. social_accounts FOR UPDATE, id order,
--     2. social_account_guard advisory, then instagram_capability advisory,
--     3. competitor_watchlist FOR UPDATE, when the job has one,
--     4. instagram_collection_jobs FOR UPDATE.
--
--   Result writes wait on that order. Claim tries the parent locks with
--   NOWAIT and skips a busy target, so it never locks the job first and
--   then waits on the account. Credential rows are not locked here. The
--   generation bump already holds the capability advisory before it
--   writes, which is the lock this fence holds across the read and the
--   result write. Locking a credential row as well would need its id and
--   would extend into the second half of the credential protocol; doing
--   that after the job row would cycle with reconnect. That coupling is
--   not required for the generation race, so it is not added.
--
-- CAPTURED CONTEXT INVALIDATION
--
--   A reclaim that finds a captured credential generation or login kind
--   which is no longer the live one bumps job_generation and leaves the
--   previous generation's checkpoints and terminal operations where they
--   are. They are history. They are not the new generation's work, and a
--   later completion cannot report them as newly complete. An owner job
--   captures the new generation onto the new revision only. A competitor
--   job drops the captured viewer and must attach again. A reclaim whose
--   captured generation still matches keeps the revision and its
--   checkpoints. Force remains the separate path that bumps the revision
--   and clears the context itself.
--
-- THE TRUTH RULES
--
--   * NULL means unavailable, never zero. The metric helpers reject a
--     negative or non-integer value and pass JSON null through as NULL.
--   * A failed read is a failure, never an empty success. A failed
--     operation records state='failed' with a retry time; it never
--     advances last_success_at and never clears a captured snapshot.
--   * A forced re-collection bumps the job generation and starts that
--     generation empty. The previous generation's checkpoints stay as
--     history; they are never re-run.
--   * A normal continuation never resets a finished operation, and a
--     normal enqueue never discards a force.
--   * The collector's own history is never the authority for freshness:
--     social_accounts.account_metadata is not written here at all.
--
-- ===========================================================================

BEGIN;

-- ===========================================================================
-- 1. Internal helpers.
--
-- These are the definer's own helpers. They are revoked from every browser
-- role below; the browser never needs them.
-- ===========================================================================

-- The caller must be an authenticated end user. Anything else (anon, or a
-- service-role session that wants to act as a user) is refused here, not
-- by a policy.
CREATE OR REPLACE FUNCTION public.ig_collection_assert_owner_caller()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF auth.role() IS DISTINCT FROM 'authenticated' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_CALLER_NOT_ALLOWED: this function is only available to an authenticated user session'
      USING ERRCODE = '42501';
  END IF;

  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION
      'IG_COLLECTION_CALLER_NOT_ALLOWED: this function requires an authenticated user identity'
      USING ERRCODE = '42501';
  END IF;
END;
$function$;

-- The caller must be the service role, or an authenticated admin. The
-- future HTTP worker verifies the role before it calls anything here; this
-- is the second, structural check.
--
-- The GRANT is the tighter of the two layers: the service functions are
-- granted to the service role only, so an admin session reaches them only
-- if that grant is widened deliberately. The admin branch below is the
-- backstop for that case - it is the authority, and the GRANT is the
-- outermost shell.
CREATE OR REPLACE FUNCTION public.ig_collection_assert_service_caller()
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF auth.role() = 'service_role' THEN
    RETURN;
  END IF;

  IF auth.role() = 'authenticated'
     AND auth.uid() IS NOT NULL
     AND public.has_role(auth.uid(), 'admin') THEN
    RETURN;
  END IF;

  RAISE EXCEPTION
    'IG_COLLECTION_CALLER_NOT_ALLOWED: this function is only available to the service role or an admin'
    USING ERRCODE = '42501';
END;
$function$;

-- A sanitised reason code. Lower-case snake_case, bounded length. Raw
-- provider text cannot pass this, so it can never reach the state tables.
CREATE OR REPLACE FUNCTION public.ig_collection_reason_code(p_value text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $function$
BEGIN
  IF p_value IS NULL THEN
    RETURN NULL;
  END IF;

  IF p_value !~ '^[a-z0-9_]{1,64}$' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_REASON_INVALID: a reason code must be lower-case snake_case of at most 64 characters'
      USING ERRCODE = '22023';
  END IF;

  RETURN p_value;
END;
$function$;

-- A metric value. Absent or JSON null is NULL (unavailable). A non-number,
-- a negative number or a fractional number is a refusal, not a silent zero.
CREATE OR REPLACE FUNCTION public.ig_collection_metric_int(p_payload jsonb, p_key text)
RETURNS bigint
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_raw  jsonb;
  v_text text;
BEGIN
  IF p_payload IS NULL THEN
    RETURN NULL;
  END IF;

  v_raw := p_payload -> p_key;

  IF v_raw IS NULL OR jsonb_typeof(v_raw) = 'null' THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(v_raw) <> 'number' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_METRIC_INVALID: metric % must be a number or null', p_key
      USING ERRCODE = '22023';
  END IF;

  v_text := (v_raw #>> '{}');

  IF v_text !~ '^[0-9]+$' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_METRIC_INVALID: metric % must be a non-negative integer', p_key
      USING ERRCODE = '22023';
  END IF;

  RETURN v_text::bigint;
END;
$function$;

-- A bounded text value. Absent or JSON null is NULL.
CREATE OR REPLACE FUNCTION public.ig_collection_text(p_payload jsonb, p_key text, p_max_len integer)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_raw jsonb;
BEGIN
  IF p_payload IS NULL THEN
    RETURN NULL;
  END IF;

  v_raw := p_payload -> p_key;

  IF v_raw IS NULL OR jsonb_typeof(v_raw) = 'null' THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(v_raw) <> 'string' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_TEXT_INVALID: % must be a string or null', p_key
      USING ERRCODE = '22023';
  END IF;

  IF char_length(v_raw #>> '{}') > p_max_len THEN
    RAISE EXCEPTION
      'IG_COLLECTION_TEXT_INVALID: % exceeds % characters', p_key, p_max_len
      USING ERRCODE = '22023';
  END IF;

  RETURN v_raw #>> '{}';
END;
$function$;

-- A finite timestamp. 'infinity' is a valid timestamptz literal and is not
-- evidence of anything, so it is refused.
CREATE OR REPLACE FUNCTION public.ig_collection_timestamp(p_payload jsonb, p_key text)
RETURNS timestamptz
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_raw  jsonb;
  v_value timestamptz;
BEGIN
  IF p_payload IS NULL THEN
    RETURN NULL;
  END IF;

  v_raw := p_payload -> p_key;

  IF v_raw IS NULL OR jsonb_typeof(v_raw) = 'null' THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(v_raw) <> 'string' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_TIMESTAMP_INVALID: % must be an ISO-8601 string or null', p_key
      USING ERRCODE = '22023';
  END IF;

  v_value := (v_raw #>> '{}')::timestamptz;

  IF NOT isfinite(v_value) THEN
    RAISE EXCEPTION
      'IG_COLLECTION_TIMESTAMP_INVALID: % must be a finite timestamp', p_key
      USING ERRCODE = '22023';
  END IF;

  RETURN v_value;
END;
$function$;

-- A calendar date.
CREATE OR REPLACE FUNCTION public.ig_collection_date(p_payload jsonb, p_key text)
RETURNS date
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_raw jsonb;
BEGIN
  IF p_payload IS NULL THEN
    RETURN NULL;
  END IF;

  v_raw := p_payload -> p_key;

  IF v_raw IS NULL OR jsonb_typeof(v_raw) = 'null' THEN
    RETURN NULL;
  END IF;

  IF jsonb_typeof(v_raw) <> 'string' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_DATE_INVALID: % must be an ISO-8601 date string or null', p_key
      USING ERRCODE = '22023';
  END IF;

  RETURN (v_raw #>> '{}')::date;
END;
$function$;

-- A bounded list of opaque media ids. A CHECK constraint cannot contain a
-- subquery, so the per-element rules live in this immutable helper and the
-- constraint calls it.
CREATE OR REPLACE FUNCTION public.ig_collection_id_array_ok(p_ids text[])
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT COALESCE(
    (SELECT bool_and(r.id IS NOT NULL
                      AND char_length(btrim(r.id)) > 0
                      AND char_length(r.id) <= 255)
       FROM unnest(p_ids) AS r(id)),
    true);
$function$;

-- The exponential backoff ladder for a retryable failure. Capped, so a
-- permanently failing query retries at a bounded interval instead of
-- occupying every tick.
CREATE OR REPLACE FUNCTION public.ig_collection_backoff_interval(p_attempts integer)
RETURNS interval
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT CASE
    WHEN p_attempts IS NULL OR p_attempts <= 1 THEN interval '1 minute'
    WHEN p_attempts = 2                      THEN interval '5 minutes'
    WHEN p_attempts = 3                      THEN interval '15 minutes'
    WHEN p_attempts = 4                      THEN interval '1 hour'
    ELSE interval '6 hours'
  END;
$function$;

-- Resolve a target for an owner. Returns the bound ids and whether the
-- target is still active. A target that is not owned by p_user_id is simply
-- "not found": the caller must not be able to learn that it exists.
CREATE OR REPLACE FUNCTION public.ig_collection_resolve_target(
  p_user_id      uuid,
  p_target_kind  text,
  p_target_id    uuid
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_account   uuid := NULL;
  v_watchlist uuid := NULL;
  v_active    boolean := false;
BEGIN
  IF p_user_id IS NULL OR p_target_id IS NULL THEN
    RETURN jsonb_build_object('found', false, 'is_active', false);
  END IF;

  IF p_target_kind = 'owner' THEN
    SELECT sa.id, sa.is_active
      INTO v_account, v_active
      FROM public.social_accounts AS sa
     WHERE sa.id = p_target_id
       AND sa.user_id = p_user_id
       AND sa.platform = 'instagram';
  ELSIF p_target_kind = 'competitor' THEN
    SELECT cw.id, cw.is_active
      INTO v_watchlist, v_active
      FROM public.competitor_watchlist AS cw
     WHERE cw.id = p_target_id
       AND cw.user_id = p_user_id
       AND cw.platform = 'instagram';
  END IF;

  RETURN jsonb_build_object(
    'found', (v_account IS NOT NULL OR v_watchlist IS NOT NULL),
    'social_account_id', v_account,
    'watchlist_id', v_watchlist,
    'is_active', COALESCE(v_active, false)
  );
END;
$function$;

-- ===========================================================================
-- 2. The job table.
--
-- One row per (owner, target, Kuwait capture day). The capture day is part
-- of the identity, so a normal same-day enqueue is idempotent and a new
-- day is a new row.
--
-- The target is carried in three columns that must agree: target_kind says
-- which parent the row belongs to, target_id names it, and the typed id
-- column carries it for the composite foreign key. A CHECK keeps them
-- consistent; the composite foreign key keeps the owner honest.
-- ===========================================================================

CREATE TABLE public.instagram_collection_jobs (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL,
  target_kind        text NOT NULL,
  target_id          uuid NOT NULL,
  social_account_id  uuid,
  watchlist_id       uuid,

  -- The Kuwait capture day. The scheduler and the display timezone.
  captured_on        date NOT NULL,

  -- The revision counter. A forced re-collection bumps it, which retires
  -- every claim taken against the previous revision.
  job_generation     bigint NOT NULL DEFAULT 1,

  status             text NOT NULL DEFAULT 'queued',
  due_at             timestamptz NOT NULL DEFAULT now(),
  retry_at           timestamptz,
  lease_token        uuid,
  lease_expires_at   timestamptz,
  attempts           integer NOT NULL DEFAULT 0,
  last_attempt_at    timestamptz,
  last_partial_at    timestamptz,
  last_success_at    timestamptz,
  last_reason_code   text,

  -- The connection context captured at claim time. For an owner job it is
  -- the target account; for a competitor job the worker binds an owned
  -- viewer account before the provider call. Nothing can be written
  -- without it.
  context_viewer_social_account_id uuid,
  context_credential_generation    bigint,
  context_login_kind               text,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT instagram_collection_jobs_target_kind_chk
    CHECK (target_kind IN ('owner', 'competitor')),
  CONSTRAINT instagram_collection_jobs_status_chk
    CHECK (status IN ('queued', 'leased', 'retry', 'partial', 'completed', 'unavailable', 'error')),
  CONSTRAINT instagram_collection_jobs_generation_chk
    CHECK (job_generation >= 1),
  CONSTRAINT instagram_collection_jobs_attempts_chk
    CHECK (attempts >= 0),
  CONSTRAINT instagram_collection_jobs_reason_code_chk
    CHECK (last_reason_code IS NULL OR last_reason_code ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT instagram_collection_jobs_login_kind_chk
    CHECK (context_login_kind IS NULL OR context_login_kind IN ('direct', 'page_linked')),

  -- The target shape. Exactly one typed id, and it must be the target.
  CONSTRAINT instagram_collection_jobs_target_shape_chk
    CHECK (
      (target_kind = 'owner'
        AND social_account_id IS NOT NULL
        AND watchlist_id IS NULL
        AND social_account_id = target_id)
      OR
      (target_kind = 'competitor'
        AND watchlist_id IS NOT NULL
        AND social_account_id IS NULL
        AND watchlist_id = target_id)
    ),

  -- The context viewer must be an account of the SAME owner. Deleting that
  -- account clears only the optional context reference; it must never
  -- delete or re-own the job.
  CONSTRAINT instagram_collection_jobs_context_owner_fkey
    FOREIGN KEY (context_viewer_social_account_id, user_id)
    REFERENCES public.social_accounts (id, user_id)
    ON DELETE SET NULL (context_viewer_social_account_id)
    ON UPDATE NO ACTION,

  -- The ownership bindings. A job cannot name an account or a watchlist
  -- entry that belongs to somebody else. Deleting either parent cascades
  -- the job, and the job's own children with it.
  CONSTRAINT instagram_collection_jobs_account_owner_fkey
    FOREIGN KEY (social_account_id, user_id)
    REFERENCES public.social_accounts (id, user_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT instagram_collection_jobs_watchlist_owner_fkey
    FOREIGN KEY (watchlist_id, user_id)
    REFERENCES public.competitor_watchlist (id, user_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,

  -- One row per target per capture day.
  CONSTRAINT instagram_collection_jobs_identity_key
    UNIQUE (user_id, target_kind, target_id, captured_on),

  -- Needed by the composite foreign key from the operation and checkpoint
  -- tables.
  CONSTRAINT instagram_collection_jobs_id_owner_key
    UNIQUE (id, user_id)
);

CREATE INDEX idx_instagram_collection_jobs_due
  ON public.instagram_collection_jobs (target_kind, due_at)
  WHERE status IN ('queued', 'retry', 'partial', 'leased');
CREATE INDEX idx_instagram_collection_jobs_owner
  ON public.instagram_collection_jobs (user_id, captured_on DESC);
CREATE INDEX idx_instagram_collection_jobs_account
  ON public.instagram_collection_jobs (social_account_id, captured_on DESC)
  WHERE social_account_id IS NOT NULL;
CREATE INDEX idx_instagram_collection_jobs_watchlist
  ON public.instagram_collection_jobs (watchlist_id, captured_on DESC)
  WHERE watchlist_id IS NOT NULL;

COMMENT ON TABLE public.instagram_collection_jobs IS
  'Durable Instagram collection work: one row per (owner, target, Kuwait '
  'capture day). Service-only raw state; the owner reads a projection '
  'through read_instagram_collection_job_status(). A forced re-collection '
  'bumps job_generation, which retires every claim taken against the '
  'previous revision.';
COMMENT ON COLUMN public.instagram_collection_jobs.job_generation IS
  'Revision counter. A force bumps it, which retires older claims and '
  'starts a fresh set of checkpoints for the new revision.';
COMMENT ON COLUMN public.instagram_collection_jobs.last_success_at IS
  'The last COMPLETE success for the current target/day. A budget-limited '
  'partial never advances it.';
COMMENT ON COLUMN public.instagram_collection_jobs.last_partial_at IS
  'The last partial progress. Stored separately so useful partial metrics '
  'stay readable without claiming a full success.';
COMMENT ON COLUMN public.instagram_collection_jobs.context_credential_generation IS
  'The credential generation captured when the work was claimed. A write is '
  'refused when the live instagram_account_capabilities.credential_generation '
  'no longer matches it.';

CREATE TRIGGER update_instagram_collection_jobs_updated_at
  BEFORE UPDATE ON public.instagram_collection_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ===========================================================================
-- 3. The per-generation operation checkpoints.
--
-- One row per (job, generation, operation). The generation is part of the
-- key, so a force starts a clean set and the previous revision's failures
-- stay as history instead of being reset.
--
-- An operation is one unit of provider work:
--   media        - one media id's insight capture
--   account_day  - one (provider date, query kind) account metric query;
--                  interactions and follow_breakdown are INDEPENDENT
--   profile      - the follower / media-count observation
--
-- Only the CURRENT generation is ever eligible to run.
-- ===========================================================================

CREATE TABLE public.instagram_collection_job_operations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid NOT NULL,
  user_id         uuid NOT NULL,
  job_generation  bigint NOT NULL,
  operation_key   text NOT NULL,
  operation_kind  text NOT NULL,
  provider_date   date,
  query_kind      text,
  state           text NOT NULL DEFAULT 'pending',
  attempts        integer NOT NULL DEFAULT 0,
  retry_at        timestamptz,
  last_attempt_at timestamptz,
  completed_at    timestamptz,
  reason_code     text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT instagram_collection_job_operations_kind_chk
    CHECK (operation_kind IN ('media', 'account_day', 'profile')),
  CONSTRAINT instagram_collection_job_operations_state_chk
    CHECK (state IN ('pending', 'success', 'unavailable', 'failed')),
  CONSTRAINT instagram_collection_job_operations_attempts_chk
    CHECK (attempts >= 0),
  CONSTRAINT instagram_collection_job_operations_generation_chk
    CHECK (job_generation >= 1),
  CONSTRAINT instagram_collection_job_operations_reason_code_chk
    CHECK (reason_code IS NULL OR reason_code ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT instagram_collection_job_operations_key_chk
    CHECK (char_length(btrim(operation_key)) > 0 AND char_length(operation_key) <= 200),

  -- The shape of an operation depends on its kind. An account-day query
  -- always names its provider date and its query kind; a media or profile
  -- operation never names a date.
  CONSTRAINT instagram_collection_job_operations_shape_chk
    CHECK (
      (operation_kind = 'account_day'
        AND provider_date IS NOT NULL
        AND query_kind IN ('interactions', 'follow_breakdown'))
      OR
      (operation_kind = 'media'
        AND provider_date IS NULL
        AND query_kind IS NULL)
      OR
      (operation_kind = 'profile'
        AND provider_date IS NULL
        AND query_kind IS NULL)
    ),

  CONSTRAINT instagram_collection_job_operations_job_owner_fkey
    FOREIGN KEY (job_id, user_id)
    REFERENCES public.instagram_collection_jobs (id, user_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,

  CONSTRAINT instagram_collection_job_operations_identity_key
    UNIQUE (job_id, job_generation, operation_key)
);

CREATE INDEX idx_instagram_collection_job_operations_job
  ON public.instagram_collection_job_operations (job_id, job_generation, state);
CREATE INDEX idx_instagram_collection_job_operations_retry
  ON public.instagram_collection_job_operations (retry_at)
  WHERE state IN ('pending', 'failed');

COMMENT ON TABLE public.instagram_collection_job_operations IS
  'Per-job-generation operation checkpoints. Keyed by generation, so a '
  'forced re-collection starts a clean set while the previous revision''s '
  'failures stay visible as history. Only the current generation is ever '
  'eligible to run.';

CREATE TRIGGER update_instagram_collection_job_operations_updated_at
  BEFORE UPDATE ON public.instagram_collection_job_operations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ===========================================================================
-- 4. The per-generation inventory checkpoint.
--
-- The media inventory cursor, the ids still to fetch, and the coverage
-- flags. All of it is bounded: a cursor is an opaque provider token (never
-- a URL), and the remaining-id list is capped.
-- ===========================================================================

CREATE TABLE public.instagram_collection_job_checkpoints (
  job_id                   uuid NOT NULL,
  user_id                  uuid NOT NULL,
  job_generation           bigint NOT NULL,
  inventory_cursor         text,
  inventory_remaining_ids  text[] NOT NULL DEFAULT '{}'::text[],
  inventory_pages_fetched  integer NOT NULL DEFAULT 0,
  inventory_partial        boolean NOT NULL DEFAULT false,
  inventory_truncated      boolean NOT NULL DEFAULT false,
  inventory_oldest_returned_at timestamptz,
  inventory_window_start   date,
  inventory_window_end     date,
  inventory_window_covered boolean NOT NULL DEFAULT false,
  inventory_gap_reason     text,
  updated_at               timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT instagram_collection_job_checkpoints_pkey
    PRIMARY KEY (job_id, job_generation),
  CONSTRAINT instagram_collection_job_checkpoints_generation_chk
    CHECK (job_generation >= 1),
  CONSTRAINT instagram_collection_job_checkpoints_pages_chk
    CHECK (inventory_pages_fetched >= 0),
  CONSTRAINT instagram_collection_job_checkpoints_remaining_len_chk
    CHECK (array_length(inventory_remaining_ids, 1) IS NULL
           OR array_length(inventory_remaining_ids, 1) <= 500),
  CONSTRAINT instagram_collection_job_checkpoints_remaining_items_chk
    CHECK (public.ig_collection_id_array_ok(inventory_remaining_ids)),
  -- A cursor is an opaque provider token. It is not a URL and it carries
  -- no credential, so it is bounded and refused if it looks like either.
  CONSTRAINT instagram_collection_job_checkpoints_cursor_chk
    CHECK (inventory_cursor IS NULL
           OR (char_length(inventory_cursor) BETWEEN 1 AND 512
               AND inventory_cursor !~ '[[:space:]]'
               AND inventory_cursor !~ '://'
               AND lower(inventory_cursor) NOT LIKE '%access_token%')),
  CONSTRAINT instagram_collection_job_checkpoints_gap_reason_chk
    CHECK (inventory_gap_reason IS NULL
           OR inventory_gap_reason ~ '^[a-z0-9_]{1,64}$'),
  CONSTRAINT instagram_collection_job_checkpoints_job_owner_fkey
    FOREIGN KEY (job_id, user_id)
    REFERENCES public.instagram_collection_jobs (id, user_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION
);

COMMENT ON TABLE public.instagram_collection_job_checkpoints IS
  'Per-job-generation media inventory checkpoint: the provider cursor, the '
  'ids still to fetch, and the coverage flags. A truncated inventory stays '
  'visible as truncated and never advances a full success.';

CREATE TRIGGER update_instagram_collection_job_checkpoints_updated_at
  BEFORE UPDATE ON public.instagram_collection_job_checkpoints
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- ===========================================================================
-- 5. The accepted-request throttle state.
--
-- Durable, and deliberately NOT keyed by the capture day: the window has
-- to carry across midnight, so the state lives with the target.
--
-- The scope separates a user's own request from the scheduled enqueue. A
-- user request is windowed at 15 minutes. The scheduled enqueue is not
-- windowed, because it creates at most one row per target per day and
-- cannot amplify provider work - gating it on the user's request window
-- would let a user's own recent request suppress the daily collection.
-- ===========================================================================

CREATE TABLE public.instagram_collection_request_throttles (
  scope             text NOT NULL DEFAULT 'user_request',
  target_kind       text NOT NULL,
  target_id         uuid NOT NULL,
  user_id           uuid NOT NULL,
  social_account_id uuid,
  watchlist_id      uuid,
  last_accepted_at  timestamptz,
  accepted_count    integer NOT NULL DEFAULT 0,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT instagram_collection_request_throttles_pkey
    PRIMARY KEY (scope, target_kind, target_id),
  CONSTRAINT instagram_collection_request_throttles_scope_chk
    CHECK (scope IN ('user_request')),
  CONSTRAINT instagram_collection_request_throttles_kind_chk
    CHECK (target_kind IN ('owner', 'competitor')),
  CONSTRAINT instagram_collection_request_throttles_count_chk
    CHECK (accepted_count >= 0),
  CONSTRAINT instagram_collection_request_throttles_shape_chk
    CHECK (
      (target_kind = 'owner'
        AND social_account_id IS NOT NULL
        AND watchlist_id IS NULL
        AND social_account_id = target_id)
      OR
      (target_kind = 'competitor'
        AND watchlist_id IS NOT NULL
        AND social_account_id IS NULL
        AND watchlist_id = target_id)
    ),
  CONSTRAINT instagram_collection_request_throttles_account_owner_fkey
    FOREIGN KEY (social_account_id, user_id)
    REFERENCES public.social_accounts (id, user_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION,
  CONSTRAINT instagram_collection_request_throttles_watchlist_owner_fkey
    FOREIGN KEY (watchlist_id, user_id)
    REFERENCES public.competitor_watchlist (id, user_id)
    ON DELETE CASCADE
    ON UPDATE NO ACTION
);

COMMENT ON TABLE public.instagram_collection_request_throttles IS
  'Durable accepted-request throttle state, keyed by scope and target and '
  'NOT by capture day, so the window carries across midnight. Owned by the '
  'service role; a client cannot clear it to buy itself another request.';

CREATE TRIGGER update_instagram_collection_request_throttles_updated_at
  BEFORE UPDATE ON public.instagram_collection_request_throttles
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- The accepted-request throttle.
--
-- One row per (scope, target). The accept is atomic across processes: the
-- conditional ON CONFLICT update is the whole mechanism. A second caller
-- that arrives while the first transaction is open blocks on the row, then
-- re-evaluates the predicate against the committed row and updates nothing,
-- which is how it learns it was throttled.
--
-- The state is durable and NOT keyed by the capture day, so the window
-- carries across a day boundary instead of resetting at midnight.
CREATE OR REPLACE FUNCTION public.ig_collection_throttle_accept(
  p_scope       text,
  p_user_id     uuid,
  p_target_kind text,
  p_target_id   uuid,
  p_window      interval
)
RETURNS timestamptz
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_accepted timestamptz := NULL;
  v_account  uuid := NULL;
  v_watchlist uuid := NULL;
BEGIN
  IF p_target_kind = 'owner' THEN
    v_account := p_target_id;
  ELSE
    v_watchlist := p_target_id;
  END IF;

  INSERT INTO public.instagram_collection_request_throttles AS t (
    target_kind, target_id, user_id, social_account_id, watchlist_id,
    scope, last_accepted_at, accepted_count, updated_at
  )
  VALUES (
    p_target_kind, p_target_id, p_user_id, v_account, v_watchlist,
    p_scope, now(), 1, now()
  )
  ON CONFLICT (scope, target_kind, target_id) DO UPDATE
     SET last_accepted_at = now(),
         accepted_count   = t.accepted_count + 1,
         updated_at       = now()
   WHERE t.last_accepted_at IS NULL
      OR t.last_accepted_at <= now() - p_window
  RETURNING last_accepted_at INTO v_accepted;

  RETURN v_accepted;
END;
$function$;

-- The last accepted request for a target, for the typed refusal payload.
CREATE OR REPLACE FUNCTION public.ig_collection_throttle_last_accepted(
  p_scope       text,
  p_target_kind text,
  p_target_id   uuid
)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
  SELECT t.last_accepted_at
    FROM public.instagram_collection_request_throttles AS t
   WHERE t.scope = p_scope
     AND t.target_kind = p_target_kind
     AND t.target_id = p_target_id;
$function$;

-- ===========================================================================
-- 6. The provider throttle buckets.
--
-- The shared app / token bucket state a worker records after a provider
-- response. The key is a NON-SECRET hash the worker computes - the
-- database never receives a token, and a raw token cannot be mistaken for
-- a bucket key because only a 64-character lower-case hex digest is
-- accepted.
-- ===========================================================================

CREATE TABLE public.instagram_provider_throttle_buckets (
  bucket_key        text PRIMARY KEY,
  usage_percent     integer,
  throttled_until   timestamptz,
  last_reported_at  timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT instagram_provider_throttle_buckets_key_chk
    CHECK (bucket_key ~ '^[0-9a-f]{64}$'),
  CONSTRAINT instagram_provider_throttle_buckets_usage_chk
    CHECK (usage_percent IS NULL OR (usage_percent >= 0 AND usage_percent <= 100)),
  CONSTRAINT instagram_provider_throttle_buckets_throttled_chk
    CHECK (throttled_until IS NULL OR isfinite(throttled_until))
);

COMMENT ON TABLE public.instagram_provider_throttle_buckets IS
  'Shared provider throttle state, keyed by a non-secret hash of the app / '
  'token bucket identity. The database never receives a credential.';

-- ===========================================================================
-- 7. RLS and grants.
--
-- House convention: RLS on, NO policies, explicit grants. This stack carries
-- ALTER DEFAULT PRIVILEGES ... GRANT ALL, so the REVOKEs are load-bearing.
-- ===========================================================================

ALTER TABLE public.instagram_collection_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instagram_collection_job_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instagram_collection_job_checkpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instagram_collection_request_throttles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instagram_provider_throttle_buckets ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.instagram_collection_jobs FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.instagram_collection_job_operations FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.instagram_collection_job_checkpoints FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.instagram_collection_request_throttles FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.instagram_provider_throttle_buckets FROM PUBLIC, anon, authenticated;

REVOKE ALL ON public.instagram_collection_jobs FROM service_role;
REVOKE ALL ON public.instagram_collection_job_operations FROM service_role;
REVOKE ALL ON public.instagram_collection_job_checkpoints FROM service_role;
REVOKE ALL ON public.instagram_collection_request_throttles FROM service_role;
REVOKE ALL ON public.instagram_provider_throttle_buckets FROM service_role;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.instagram_collection_jobs TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instagram_collection_job_operations TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instagram_collection_job_checkpoints TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instagram_collection_request_throttles TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instagram_provider_throttle_buckets TO service_role;

-- ===========================================================================
-- 8. The owner-facing enqueue.
--
-- enqueue_instagram_collection_job(target_kind, target_id, mode)
--
-- The owner comes from auth.uid(). A caller cannot enqueue for another
-- owner, cannot enqueue "everything", and cannot ask for the service or an
-- admin role. The 15-minute accepted-request window is shared across
-- processes through the throttle table.
--
-- mode:
--   'normal' - idempotent. An existing same-day row is left exactly as it
--              is: its generation, its checkpoints and its finished
--              operations survive. A force is never discarded.
--   'force'  - accepted only when the throttle allows it. Bumps the job
--              generation, clears the lease (which retires every in-flight
--              claim), resets the due time and starts the new generation
--              with no checkpoints. The previous generation's history stays.
--
-- Returns a typed document. It never raises for an ordinary refusal such as
-- the throttle window, because the caller has to turn that into a 429.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.enqueue_instagram_collection_job(
  p_target_kind text,
  p_target_id   uuid,
  p_mode        text DEFAULT 'normal'
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_owner       uuid;
  v_target      jsonb;
  v_mode        text := lower(COALESCE(p_mode, 'normal'));
  v_captured_on date;
  v_accepted    timestamptz;
  v_last        timestamptz;
  v_job_id      uuid;
  v_generation  bigint;
  v_status      text;
  v_inserted    boolean := false;
  v_existed     boolean := false;
BEGIN
  PERFORM public.ig_collection_assert_owner_caller();

  IF p_target_kind IS NULL OR p_target_kind NOT IN ('owner', 'competitor') THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_TARGET_KIND: target kind must be owner or competitor'
      USING ERRCODE = '22023';
  END IF;

  IF p_target_id IS NULL THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_TARGET: a target id is required'
      USING ERRCODE = '22023';
  END IF;

  IF v_mode NOT IN ('normal', 'force') THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_MODE: mode must be normal or force'
      USING ERRCODE = '22023';
  END IF;

  v_owner := auth.uid();
  v_captured_on := (now() AT TIME ZONE 'Asia/Kuwait')::date;

  v_target := public.ig_collection_resolve_target(v_owner, p_target_kind, p_target_id);

  IF NOT COALESCE((v_target ->> 'found')::boolean, false) THEN
    RAISE EXCEPTION
      'IG_COLLECTION_TARGET_NOT_FOUND: no such Instagram target for this user'
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT COALESCE((v_target ->> 'is_active')::boolean, false) THEN
    RAISE EXCEPTION
      'IG_COLLECTION_TARGET_INACTIVE: the target is not active'
      USING ERRCODE = 'P0002';
  END IF;

  -- The accepted-request window. It is consumed before anything is
  -- written, and the whole transaction rolls back if the enqueue fails,
  -- so a refused enqueue never burns the window.
  v_accepted := public.ig_collection_throttle_accept(
    'user_request', v_owner, p_target_kind, p_target_id, interval '15 minutes');

  IF v_accepted IS NULL THEN
    v_last := public.ig_collection_throttle_last_accepted(
      'user_request', p_target_kind, p_target_id);

    RETURN jsonb_build_object(
      'accepted', false,
      'reason', 'throttled',
      'retry_after_seconds', GREATEST(
        0,
        CEIL(EXTRACT(EPOCH FROM ((v_last + interval '15 minutes') - now())))::integer),
      'captured_on', v_captured_on
    );
  END IF;

  -- Whether the row already existed, so the answer can say 'created' or
  -- 'already_enqueued' honestly.
  SELECT EXISTS (
           SELECT 1 FROM public.instagram_collection_jobs AS j
            WHERE j.user_id = v_owner
              AND j.target_kind = p_target_kind
              AND j.target_id = p_target_id
              AND j.captured_on = v_captured_on)
    INTO v_existed;

  IF v_mode = 'force' THEN
    INSERT INTO public.instagram_collection_jobs AS j (
      user_id, target_kind, target_id, social_account_id, watchlist_id,
      captured_on, job_generation, status, due_at, attempts
    )
    VALUES (
      v_owner, p_target_kind, p_target_id,
      (v_target ->> 'social_account_id')::uuid,
      (v_target ->> 'watchlist_id')::uuid,
      v_captured_on, 1, 'queued', now(), 0
    )
    ON CONFLICT (user_id, target_kind, target_id, captured_on) DO UPDATE
       SET job_generation   = j.job_generation + 1,
           status           = 'queued',
           due_at           = now(),
           retry_at         = NULL,
           lease_token      = NULL,
           lease_expires_at = NULL,
           attempts         = 0,
           last_reason_code = NULL,
           -- The new revision starts with no connection context; the worker
           -- captures it again when it claims the work.
           context_viewer_social_account_id = NULL,
           context_credential_generation    = NULL,
           context_login_kind               = NULL,
           updated_at       = now()
    RETURNING j.id, j.job_generation, j.status INTO v_job_id, v_generation, v_status;
  ELSE
    INSERT INTO public.instagram_collection_jobs AS j (
      user_id, target_kind, target_id, social_account_id, watchlist_id,
      captured_on, job_generation, status, due_at, attempts
    )
    VALUES (
      v_owner, p_target_kind, p_target_id,
      (v_target ->> 'social_account_id')::uuid,
      (v_target ->> 'watchlist_id')::uuid,
      v_captured_on, 1, 'queued', now(), 0
    )
    ON CONFLICT (user_id, target_kind, target_id, captured_on) DO NOTHING
    RETURNING j.id, j.job_generation, j.status INTO v_job_id, v_generation, v_status;

    IF v_job_id IS NULL THEN
      SELECT j.id, j.job_generation, j.status
        INTO v_job_id, v_generation, v_status
        FROM public.instagram_collection_jobs AS j
       WHERE j.user_id = v_owner
         AND j.target_kind = p_target_kind
         AND j.target_id = p_target_id
         AND j.captured_on = v_captured_on;
    END IF;
  END IF;

  v_inserted := NOT v_existed;

  RETURN jsonb_build_object(
    'accepted', true,
    'reason', CASE WHEN v_mode = 'force' THEN 'forced'
                   WHEN v_inserted THEN 'enqueued'
                   ELSE 'already_enqueued' END,
    'job_id', v_job_id,
    'job_generation', v_generation,
    'status', v_status,
    'captured_on', v_captured_on,
    'created', v_inserted,
    'accepted_at', v_accepted
  );
END;
$function$;

-- ===========================================================================
-- 9. The owner-facing status read.
--
-- read_instagram_collection_job_status(target_kind, target_id, capture_day)
--
-- The owner boundary. It verifies auth.uid() and the target ownership, and
-- it projects NOTHING sensitive: no lease token, no lease expiry, no
-- cursor, no remaining ids, no provider error text. Only a typed reason
-- code, which is sanitised by construction.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.read_instagram_collection_job_status(
  p_target_kind text,
  p_target_id   uuid,
  p_capture_day date DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_owner  uuid;
  v_target jsonb;
  v_day    date;
  v_job    jsonb;
  v_pending integer := 0;
BEGIN
  PERFORM public.ig_collection_assert_owner_caller();

  IF p_target_kind IS NULL OR p_target_kind NOT IN ('owner', 'competitor') THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_TARGET_KIND: target kind must be owner or competitor'
      USING ERRCODE = '22023';
  END IF;

  IF p_target_id IS NULL THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_TARGET: a target id is required'
      USING ERRCODE = '22023';
  END IF;

  v_owner := auth.uid();
  v_target := public.ig_collection_resolve_target(v_owner, p_target_kind, p_target_id);

  IF NOT COALESCE((v_target ->> 'found')::boolean, false) THEN
    RAISE EXCEPTION
      'IG_COLLECTION_TARGET_NOT_FOUND: no such Instagram target for this user'
      USING ERRCODE = 'P0002';
  END IF;

  v_day := COALESCE(p_capture_day, (now() AT TIME ZONE 'Asia/Kuwait')::date);

  SELECT jsonb_build_object(
    'job_id', j.id,
    'status', j.status,
    'job_generation', j.job_generation,
    'attempts', j.attempts,
    'due_at', j.due_at,
    'next_retry_at', j.retry_at,
    'last_attempt_at', j.last_attempt_at,
    'last_partial_at', j.last_partial_at,
    'last_success_at', j.last_success_at,
    'reason_code', j.last_reason_code,
    'inventory', jsonb_build_object(
      'truncated', COALESCE(c.inventory_truncated, false),
      'partial', COALESCE(c.inventory_partial, false),
      'window_covered', COALESCE(c.inventory_window_covered, false),
      'oldest_returned_at', c.inventory_oldest_returned_at,
      'gap_reason', c.inventory_gap_reason,
      'pages_fetched', COALESCE(c.inventory_pages_fetched, 0)
    )
  )
    INTO v_job
    FROM public.instagram_collection_jobs AS j
    LEFT JOIN public.instagram_collection_job_checkpoints AS c
           ON c.job_id = j.id AND c.job_generation = j.job_generation
   WHERE j.user_id = v_owner
     AND j.target_kind = p_target_kind
     AND j.target_id = p_target_id
     AND j.captured_on = v_day;

  IF v_job IS NULL THEN
    RETURN jsonb_build_object(
      'target_kind', p_target_kind,
      'target_id', p_target_id,
      'captured_on', v_day,
      'status', 'none',
      'job_generation', 0,
      'attempts', 0,
      'due_at', NULL,
      'next_retry_at', NULL,
      'last_attempt_at', NULL,
      'last_partial_at', NULL,
      'last_success_at', NULL,
      'reason_code', NULL,
      'inventory', jsonb_build_object(
        'truncated', false, 'partial', false, 'window_covered', false,
        'oldest_returned_at', NULL, 'gap_reason', NULL, 'pages_fetched', 0
      )
    );
  END IF;

  SELECT count(*)::integer
    INTO v_pending
    FROM public.instagram_collection_job_operations AS o
   WHERE o.job_id = (v_job ->> 'job_id')::uuid
     AND o.job_generation = (v_job ->> 'job_generation')::bigint
     AND o.state IN ('pending', 'failed');

  RETURN jsonb_build_object(
    'target_kind', p_target_kind,
    'target_id', p_target_id,
    'captured_on', v_day,
    'status', v_job ->> 'status',
    'job_generation', (v_job ->> 'job_generation')::bigint,
    'attempts', (v_job ->> 'attempts')::integer,
    'due_at', v_job -> 'due_at',
    'next_retry_at', v_job -> 'next_retry_at',
    'last_attempt_at', v_job -> 'last_attempt_at',
    'last_partial_at', v_job -> 'last_partial_at',
    'last_success_at', v_job -> 'last_success_at',
    'reason_code', v_job ->> 'reason_code',
    'inventory', v_job -> 'inventory',
    'pending_operations', v_pending
  );
END;
$function$;

-- ===========================================================================
-- 10. The service enqueue.
--
-- enqueue_instagram_collection_jobs_service(owner_id, requests)
--
-- The least-privileged path for the cron / admin boundaries. The future
-- HTTP worker verifies the role before it calls this; the function verifies
-- it again.
--
-- requests is a bounded array (at most 50) of
--   { "target_kind": "owner"|"competitor", "target_id": "<uuid>",
--     "mode": "normal"|"force" }
--
-- Every request is checked against owner_id: the target must really belong
-- to that owner, in the database. A normal enqueue is idempotent and does
-- not consume the user's request window - the scheduled path creates at
-- most one row per target per day. A force does consume it.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.enqueue_instagram_collection_jobs_service(
  p_owner_id uuid,
  p_requests jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_item       jsonb;
  v_kind       text;
  v_target_id  uuid;
  v_mode       text;
  v_target     jsonb;
  v_captured_on date;
  v_accepted   timestamptz;
  v_last       timestamptz;
  v_job_id     uuid;
  v_generation bigint;
  v_status     text;
  v_results    jsonb := '[]'::jsonb;
  v_count      integer := 0;
BEGIN
  PERFORM public.ig_collection_assert_service_caller();

  IF p_owner_id IS NULL THEN
    RAISE EXCEPTION
      'IG_COLLECTION_OWNER_REQUIRED: an owner id is required'
      USING ERRCODE = '22023';
  END IF;

  IF p_requests IS NULL OR jsonb_typeof(p_requests) <> 'array' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_REQUESTS: requests must be an array'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_requests) = 0 THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_REQUESTS: at least one request is required'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_requests) > 50 THEN
    RAISE EXCEPTION
      'IG_COLLECTION_BATCH_TOO_LARGE: at most 50 requests per call'
      USING ERRCODE = '22023';
  END IF;

  v_captured_on := (now() AT TIME ZONE 'Asia/Kuwait')::date;

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_requests) LOOP
    v_count := v_count + 1;

    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION
        'IG_COLLECTION_INVALID_REQUEST: request % must be an object', v_count
        USING ERRCODE = '22023';
    END IF;

    IF (SELECT count(*) FROM jsonb_object_keys(v_item)) <> 3
       OR NOT (v_item ? 'target_kind')
       OR NOT (v_item ? 'target_id')
       OR NOT (v_item ? 'mode') THEN
      RAISE EXCEPTION
        'IG_COLLECTION_INVALID_REQUEST: request % must carry exactly target_kind, target_id and mode', v_count
        USING ERRCODE = '22023';
    END IF;

    v_kind := lower(v_item ->> 'target_kind');
    v_mode := lower(v_item ->> 'mode');

    IF v_kind NOT IN ('owner', 'competitor') THEN
      RAISE EXCEPTION
        'IG_COLLECTION_INVALID_TARGET_KIND: request % has an unknown target kind', v_count
        USING ERRCODE = '22023';
    END IF;

    IF v_mode NOT IN ('normal', 'force') THEN
      RAISE EXCEPTION
        'IG_COLLECTION_INVALID_MODE: request % has an unknown mode', v_count
        USING ERRCODE = '22023';
    END IF;

    BEGIN
      v_target_id := (v_item ->> 'target_id')::uuid;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION
        'IG_COLLECTION_INVALID_TARGET: request % has a malformed target id', v_count
        USING ERRCODE = '22023';
    END;

    -- The owner is not taken on trust: the target must belong to it.
    v_target := public.ig_collection_resolve_target(p_owner_id, v_kind, v_target_id);

    IF NOT COALESCE((v_target ->> 'found')::boolean, false) THEN
      RAISE EXCEPTION
        'IG_COLLECTION_TARGET_NOT_FOUND: request % names a target that does not belong to the owner', v_count
        USING ERRCODE = 'P0002';
    END IF;

    IF NOT COALESCE((v_target ->> 'is_active')::boolean, false) THEN
      RAISE EXCEPTION
        'IG_COLLECTION_TARGET_INACTIVE: request % names an inactive target', v_count
        USING ERRCODE = 'P0002';
    END IF;

    IF v_mode = 'force' THEN
      v_accepted := public.ig_collection_throttle_accept(
        'user_request', p_owner_id, v_kind, v_target_id, interval '15 minutes');

      IF v_accepted IS NULL THEN
        v_last := public.ig_collection_throttle_last_accepted(
          'user_request', v_kind, v_target_id);

        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'target_kind', v_kind,
          'target_id', v_target_id,
          'accepted', false,
          'reason', 'throttled',
          'retry_after_seconds', GREATEST(
            0,
            CEIL(EXTRACT(EPOCH FROM ((v_last + interval '15 minutes') - now())))::integer)
        ));
        CONTINUE;
      END IF;
    END IF;

    IF v_mode = 'force' THEN
      INSERT INTO public.instagram_collection_jobs AS j (
        user_id, target_kind, target_id, social_account_id, watchlist_id,
        captured_on, job_generation, status, due_at, attempts
      )
      VALUES (
        p_owner_id, v_kind, v_target_id,
        (v_target ->> 'social_account_id')::uuid,
        (v_target ->> 'watchlist_id')::uuid,
        v_captured_on, 1, 'queued', now(), 0
      )
      ON CONFLICT (user_id, target_kind, target_id, captured_on) DO UPDATE
         SET job_generation   = j.job_generation + 1,
             status           = 'queued',
             due_at           = now(),
             retry_at         = NULL,
             lease_token      = NULL,
             lease_expires_at = NULL,
             attempts         = 0,
             last_reason_code = NULL,
             context_viewer_social_account_id = NULL,
             context_credential_generation    = NULL,
             context_login_kind               = NULL,
             updated_at       = now()
      RETURNING j.id, j.job_generation, j.status INTO v_job_id, v_generation, v_status;
    ELSE
      INSERT INTO public.instagram_collection_jobs AS j (
        user_id, target_kind, target_id, social_account_id, watchlist_id,
        captured_on, job_generation, status, due_at, attempts
      )
      VALUES (
        p_owner_id, v_kind, v_target_id,
        (v_target ->> 'social_account_id')::uuid,
        (v_target ->> 'watchlist_id')::uuid,
        v_captured_on, 1, 'queued', now(), 0
      )
      ON CONFLICT (user_id, target_kind, target_id, captured_on) DO NOTHING
      RETURNING j.id, j.job_generation, j.status INTO v_job_id, v_generation, v_status;

      IF v_job_id IS NULL THEN
        SELECT j.id, j.job_generation, j.status
          INTO v_job_id, v_generation, v_status
          FROM public.instagram_collection_jobs AS j
         WHERE j.user_id = p_owner_id
           AND j.target_kind = v_kind
           AND j.target_id = v_target_id
           AND j.captured_on = v_captured_on;
      END IF;
    END IF;

    v_results := v_results || jsonb_build_array(jsonb_build_object(
      'target_kind', v_kind,
      'target_id', v_target_id,
      'accepted', true,
      'reason', CASE WHEN v_mode = 'force' THEN 'forced' ELSE 'enqueued' END,
      'job_id', v_job_id,
      'job_generation', v_generation,
      'status', v_status,
      'captured_on', v_captured_on
    ));
  END LOOP;

  RETURN jsonb_build_object(
    'owner_id', p_owner_id,
    'captured_on', v_captured_on,
    'accepted', (SELECT count(*) FROM jsonb_array_elements(v_results) AS r WHERE (r ->> 'accepted')::boolean),
    'results', v_results
  );
END;
$function$;

-- ===========================================================================
-- 11. Shared fence helpers.
--
-- Internal. Revoked from every browser role and from the service role.
-- The service functions below are the only callers.
-- ===========================================================================

-- The account half of facebook_user_credential_lock_scope, in that
-- function's id order, without the credential-row half. p_nowait asks the
-- account row lock not to wait; the advisories are the same ones the
-- generation bump holds, so once the account lock is ours a bump cannot
-- pass the advisory.
CREATE OR REPLACE FUNCTION public.ig_collection_lock_accounts(
  p_account_ids uuid[],
  p_nowait boolean
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_account uuid;
BEGIN
  FOR v_account IN
    SELECT DISTINCT x
      FROM unnest(COALESCE(p_account_ids, ARRAY[]::uuid[])) AS u(x)
     WHERE x IS NOT NULL
     ORDER BY 1
  LOOP
    IF p_nowait THEN
      PERFORM 1
        FROM public.social_accounts AS sa
       WHERE sa.id = v_account
         FOR UPDATE NOWAIT;
    ELSE
      PERFORM 1
        FROM public.social_accounts AS sa
       WHERE sa.id = v_account
         FOR UPDATE;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext('social_account_guard:' || v_account::text));
    PERFORM pg_advisory_xact_lock(hashtext('instagram_capability:' || v_account::text));
  END LOOP;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ig_collection_lock_watchlist(
  p_watchlist_id uuid,
  p_nowait boolean
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_watchlist_id IS NULL THEN
    RETURN;
  END IF;

  IF p_nowait THEN
    PERFORM 1
      FROM public.competitor_watchlist AS cw
     WHERE cw.id = p_watchlist_id
       FOR UPDATE NOWAIT;
  ELSE
    PERFORM 1
      FROM public.competitor_watchlist AS cw
     WHERE cw.id = p_watchlist_id
       FOR UPDATE;
  END IF;
END;
$function$;

-- Wall clock. now() is the start of the transaction, so a write that
-- blocked on a parent lock can outlive the lease and still see it as
-- unexpired. The lease is live only while it is strictly after the
-- current wall clock.
CREATE OR REPLACE FUNCTION public.ig_collection_assert_lease_live(
  p_lease_expires_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF p_lease_expires_at IS NULL OR p_lease_expires_at <= clock_timestamp() THEN
    RAISE EXCEPTION
      'IG_COLLECTION_CLAIM_STALE: the claim is no longer valid for this job'
      USING ERRCODE = '40001';
  END IF;
END;
$function$;

-- Lock parents, then the job, then apply the shared result fence.
-- p_require_context is the provider-result rule: progress, snapshots,
-- completion and throttle parking refuse until a viewer context has been
-- captured. Attachment passes false and names the viewer it is about to
-- bind so that account is locked in the same ordered set.
CREATE OR REPLACE FUNCTION public.ig_collection_load_fenced_job(
  p_job_id uuid,
  p_claim_token uuid,
  p_job_generation bigint,
  p_require_context boolean,
  p_extra_account uuid
)
RETURNS public.instagram_collection_jobs
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_attempt integer;
  v_peek public.instagram_collection_jobs%ROWTYPE;
  v_job public.instagram_collection_jobs%ROWTYPE;
  v_accounts uuid[];
  v_live_gen bigint;
  v_live_login text;
  v_read_state text;
  v_active boolean;
  v_reauth boolean;
BEGIN
  FOR v_attempt IN 1..3 LOOP
    BEGIN
      SELECT * INTO v_peek
        FROM public.instagram_collection_jobs AS j
       WHERE j.id = p_job_id;

      IF NOT FOUND THEN
        RAISE EXCEPTION
          'IG_COLLECTION_JOB_NOT_FOUND: no such collection job'
          USING ERRCODE = 'P0002';
      END IF;

      v_accounts := ARRAY[
        v_peek.social_account_id,
        v_peek.context_viewer_social_account_id,
        p_extra_account
      ];

      PERFORM public.ig_collection_lock_accounts(v_accounts, false);
      PERFORM public.ig_collection_lock_watchlist(v_peek.watchlist_id, false);

      SELECT * INTO v_job
        FROM public.instagram_collection_jobs AS j
       WHERE j.id = p_job_id
         FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION
          'IG_COLLECTION_JOB_NOT_FOUND: no such collection job'
          USING ERRCODE = 'P0002';
      END IF;

      IF v_job.social_account_id IS DISTINCT FROM v_peek.social_account_id
         OR v_job.watchlist_id IS DISTINCT FROM v_peek.watchlist_id
         OR v_job.context_viewer_social_account_id IS DISTINCT FROM v_peek.context_viewer_social_account_id THEN
        RAISE EXCEPTION 'IG_COLLECTION_LOCK_RETRY'
          USING ERRCODE = 'P0001';
      END IF;

      IF v_job.lease_token IS DISTINCT FROM p_claim_token
         OR v_job.status <> 'leased'
         OR v_job.job_generation <> p_job_generation THEN
        RAISE EXCEPTION
          'IG_COLLECTION_CLAIM_STALE: the claim is no longer valid for this job'
          USING ERRCODE = '40001';
      END IF;

      PERFORM public.ig_collection_assert_lease_live(v_job.lease_expires_at);

      IF v_job.target_kind = 'owner' THEN
        PERFORM 1
          FROM public.social_accounts AS sa
         WHERE sa.id = v_job.social_account_id
           AND sa.user_id = v_job.user_id
           AND sa.platform = 'instagram'
           AND sa.is_active
           AND NOT COALESCE(sa.needs_reauth, false);

        IF NOT FOUND THEN
          RAISE EXCEPTION
            'IG_COLLECTION_TARGET_INACTIVE: the target account is no longer active and usable'
            USING ERRCODE = '22023';
        END IF;
      ELSE
        PERFORM 1
          FROM public.competitor_watchlist AS cw
         WHERE cw.id = v_job.watchlist_id
           AND cw.user_id = v_job.user_id
           AND cw.is_active;

        IF NOT FOUND THEN
          RAISE EXCEPTION
            'IG_COLLECTION_TARGET_INACTIVE: the watchlist entry is no longer active'
            USING ERRCODE = '22023';
        END IF;
      END IF;

      IF p_require_context THEN
        IF v_job.context_viewer_social_account_id IS NULL
           OR v_job.context_credential_generation IS NULL
           OR v_job.context_login_kind IS NULL THEN
          RAISE EXCEPTION
            'IG_COLLECTION_CONTEXT_MISSING: the job has no bound connection context'
            USING ERRCODE = '22023';
        END IF;

        SELECT sa.is_active, COALESCE(sa.needs_reauth, false)
          INTO v_active, v_reauth
          FROM public.social_accounts AS sa
         WHERE sa.id = v_job.context_viewer_social_account_id
           AND sa.user_id = v_job.user_id
           AND sa.platform = 'instagram';

        IF NOT FOUND OR NOT COALESCE(v_active, false) THEN
          RAISE EXCEPTION
            'IG_COLLECTION_VIEWER_INACTIVE: the viewer account is not active'
            USING ERRCODE = '22023';
        END IF;

        IF v_reauth THEN
          RAISE EXCEPTION
            'IG_COLLECTION_VIEWER_NEEDS_REAUTH: the viewer account needs to be reconnected'
            USING ERRCODE = '22023';
        END IF;

        SELECT c.credential_generation, c.login_kind, c.permission_read_state
          INTO v_live_gen, v_live_login, v_read_state
          FROM public.instagram_account_capabilities AS c
         WHERE c.social_account_id = v_job.context_viewer_social_account_id;

        IF v_live_gen IS NULL OR v_read_state IS DISTINCT FROM 'ok' THEN
          RAISE EXCEPTION
            'IG_COLLECTION_CAPABILITY_MISSING: the bound account has no recorded capability'
            USING ERRCODE = '22023';
        END IF;

        IF v_live_gen IS DISTINCT FROM v_job.context_credential_generation
           OR v_live_login IS DISTINCT FROM v_job.context_login_kind THEN
          RAISE EXCEPTION
            'IG_COLLECTION_CREDENTIAL_CHANGED: the connection was replaced after this work was claimed'
            USING ERRCODE = '40001';
        END IF;
      END IF;

      RETURN v_job;
    EXCEPTION
      WHEN SQLSTATE 'P0001' THEN
        IF SQLERRM NOT LIKE '%IG_COLLECTION_LOCK_RETRY%' THEN
          RAISE;
        END IF;
    END;
  END LOOP;

  RAISE EXCEPTION
    'IG_COLLECTION_LOCK_RETRY: the job parents changed while the fence was locking them'
    USING ERRCODE = '40001';
END;
$function$;

-- One candidate. Parents are locked NOWAIT, in the order above, and the
-- job row only after that. A busy parent is skipped. When the captured
-- connection generation or login kind is no longer live, the job
-- generation advances and the old checkpoints stay on the old generation.
CREATE OR REPLACE FUNCTION public.ig_collection_try_claim_job(
  p_job_id uuid,
  p_lease interval
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_peek public.instagram_collection_jobs%ROWTYPE;
  v_job public.instagram_collection_jobs%ROWTYPE;
  v_anchor uuid;
  v_live_gen bigint;
  v_live_login text;
  v_invalidate boolean := false;
  v_new_generation bigint;
  v_ctx_account uuid;
  v_ctx_gen bigint;
  v_ctx_login text;
BEGIN
  SELECT * INTO v_peek
    FROM public.instagram_collection_jobs AS j
   WHERE j.id = p_job_id
     AND j.status IN ('queued', 'retry', 'partial', 'leased')
     AND j.due_at <= now()
     AND (j.lease_token IS NULL OR j.lease_expires_at IS NULL
          OR j.lease_expires_at <= clock_timestamp());

  IF NOT FOUND THEN
    RETURN false;
  END IF;

  BEGIN
    PERFORM public.ig_collection_lock_accounts(
      ARRAY[v_peek.social_account_id, v_peek.context_viewer_social_account_id],
      true);
    PERFORM public.ig_collection_lock_watchlist(v_peek.watchlist_id, true);

    SELECT * INTO v_job
      FROM public.instagram_collection_jobs AS j
     WHERE j.id = p_job_id
       AND j.status IN ('queued', 'retry', 'partial', 'leased')
       AND j.due_at <= now()
       AND (j.lease_token IS NULL OR j.lease_expires_at IS NULL
            OR j.lease_expires_at <= clock_timestamp())
       FOR UPDATE NOWAIT;

    IF NOT FOUND THEN
      RETURN false;
    END IF;

    IF v_job.social_account_id IS DISTINCT FROM v_peek.social_account_id
       OR v_job.watchlist_id IS DISTINCT FROM v_peek.watchlist_id
       OR v_job.context_viewer_social_account_id IS DISTINCT FROM v_peek.context_viewer_social_account_id THEN
      RETURN false;
    END IF;

    v_anchor := CASE
      WHEN v_job.target_kind = 'owner' THEN v_job.social_account_id
      ELSE v_job.context_viewer_social_account_id
    END;

    IF v_anchor IS NOT NULL THEN
      SELECT c.credential_generation, c.login_kind
        INTO v_live_gen, v_live_login
        FROM public.instagram_account_capabilities AS c
       WHERE c.social_account_id = v_anchor;
    END IF;

    v_invalidate := v_job.context_credential_generation IS NOT NULL
      AND (
        v_anchor IS NULL
        OR v_live_gen IS NULL
        OR v_live_gen IS DISTINCT FROM v_job.context_credential_generation
        OR v_live_login IS DISTINCT FROM v_job.context_login_kind
      );

    v_new_generation := v_job.job_generation;
    v_ctx_account := v_job.context_viewer_social_account_id;
    v_ctx_gen := v_job.context_credential_generation;
    v_ctx_login := v_job.context_login_kind;

    IF v_invalidate THEN
      v_new_generation := v_job.job_generation + 1;
      IF v_job.target_kind = 'owner' AND v_live_gen IS NOT NULL THEN
        v_ctx_account := v_job.social_account_id;
        v_ctx_gen := v_live_gen;
        v_ctx_login := v_live_login;
      ELSE
        v_ctx_account := NULL;
        v_ctx_gen := NULL;
        v_ctx_login := NULL;
      END IF;
    ELSIF v_job.target_kind = 'owner' AND v_live_gen IS NOT NULL THEN
      v_ctx_account := v_job.social_account_id;
      v_ctx_gen := v_live_gen;
      v_ctx_login := v_live_login;
    END IF;

    UPDATE public.instagram_collection_jobs AS j
       SET status = 'leased',
           job_generation = v_new_generation,
           lease_token = gen_random_uuid(),
           lease_expires_at = clock_timestamp() + p_lease,
           attempts = j.attempts + 1,
           last_attempt_at = clock_timestamp(),
           context_viewer_social_account_id = v_ctx_account,
           context_credential_generation = v_ctx_gen,
           context_login_kind = v_ctx_login,
           updated_at = clock_timestamp()
     WHERE j.id = p_job_id;

    RETURN true;
  EXCEPTION
    WHEN lock_not_available THEN
      RETURN false;
  END;
END;
$function$;

-- ===========================================================================
-- 12. The claim.
--
-- claim_instagram_collection_jobs(target_kind, limit)
--
-- Claims due work. The limit is clamped per kind: at most 25 owner jobs
-- and at most 50 competitor jobs per call. A busy parent lock is skipped
-- (NOWAIT); the job row is locked only after its account and watchlist.
--
-- Ordering is a three-pass fairness rule, not a single oldest-first sort:
--   pass 1 takes a reserved share of the fresh work (a job with no
--           operations yet, or with due pending/failed work for a recent
--           provider date),
--   pass 2 fills the rest with the oldest open work (no operations yet,
--           or a pending/failed operation whose retry is due), so a
--           permanently failing old query can never occupy every tick,
--   pass 3 finalizes a generation whose operations are all terminal.
--
-- A terminal operation is success or unavailable. Unavailable is permanent:
-- this pass does not reset it and does not turn it into provider work.
-- The pass exists so a worker that committed those rows and died before
-- complete(), and a retry or partial that became due with nothing left
-- open, can reach the claim helper. The same connection keeps the
-- generation, so complete() can close it without rerunning the terminal
-- rows. A changed connection still bumps the generation inside that
-- helper, and the new revision starts with no checkpoint and no operations.
--
-- States, precisely:
--   queued with no operations     passes 1 and 2 (new work)
--   queued, leased, partial or
--     retry, and every current
--     operation is terminal      pass 3, once due and the lease is dead
--   pending or failed, retry due  passes 1 and 2, never pass 3
--   failed with retry_at ahead    neither pass; it waits for its backoff
--   completed, unavailable, error not claimable job statuses
--
-- Pass 3 does not enter the fresh share. When the caller asked for more
-- than one job and a finalize candidate exists, pass 2 leaves one slot so
-- a full failure queue cannot postpone that finalization forever. Each
-- pass still stops at 500 candidates.
--
-- The lease is 120 seconds, which is longer than the 40 second bounded run
-- the future worker is planned around.
--
-- The claim returns the claim token, the job generation, the connection
-- context captured at claim time and the checkpoint state for the current
-- generation.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.claim_instagram_collection_jobs(
  p_target_kind text,
  p_limit       integer
)
RETURNS SETOF jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_limit       integer;
  v_fresh_cap   integer;
  v_pass2_limit integer;
  v_recovery_waiting boolean := false;
  v_lease       interval := interval '120 seconds';
  v_fresh_cutoff date;
  v_ids         uuid[] := ARRAY[]::uuid[];
  v_candidate   uuid;
BEGIN
  PERFORM public.ig_collection_assert_service_caller();

  IF p_target_kind IS NULL OR p_target_kind NOT IN ('owner', 'competitor') THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_TARGET_KIND: target kind must be owner or competitor'
      USING ERRCODE = '22023';
  END IF;

  v_limit := LEAST(
    GREATEST(COALESCE(p_limit, 0), 1),
    CASE WHEN p_target_kind = 'owner' THEN 25 ELSE 50 END
  );
  v_fresh_cap := GREATEST(1, CEIL(v_limit * 0.6)::integer);
  v_fresh_cutoff := (now() AT TIME ZONE 'Asia/Kuwait')::date - 2;

  -- Bounded look for a finalize-only generation. A failed row, even one
  -- whose retry_at is still ahead, is open work and is not this case.
  SELECT EXISTS (
    SELECT 1
      FROM (
        SELECT j.id
          FROM public.instagram_collection_jobs AS j
         WHERE j.target_kind = p_target_kind
           AND j.status IN ('queued', 'retry', 'partial', 'leased')
           AND j.due_at <= now()
           AND (j.lease_token IS NULL OR j.lease_expires_at IS NULL
                OR j.lease_expires_at <= clock_timestamp())
           AND EXISTS (
             SELECT 1
               FROM public.instagram_collection_job_operations AS o
              WHERE o.job_id = j.id
                AND o.job_generation = j.job_generation)
           AND NOT EXISTS (
             SELECT 1
               FROM public.instagram_collection_job_operations AS o
              WHERE o.job_id = j.id
                AND o.job_generation = j.job_generation
                AND o.state IN ('pending', 'failed'))
         ORDER BY j.due_at ASC, j.id ASC
         LIMIT 500
      ) AS recovery_candidate
  ) INTO v_recovery_waiting;

  v_pass2_limit := v_limit - CASE
    WHEN v_recovery_waiting AND v_limit > 1 THEN 1
    ELSE 0
  END;

  -- Each pass scans a bounded candidate list and skips a busy parent.
  -- The bound is deliberate: NOWAIT cannot keep walking forever the way
  -- SKIP LOCKED did inside one statement. 500 is well above either cap.
  -- Pass 1: the reserved fresh share.
  FOR v_candidate IN
    SELECT j.id
      FROM public.instagram_collection_jobs AS j
     WHERE j.target_kind = p_target_kind
       AND j.status IN ('queued', 'retry', 'partial', 'leased')
       AND j.due_at <= now()
       AND (j.lease_token IS NULL OR j.lease_expires_at IS NULL
            OR j.lease_expires_at <= clock_timestamp())
       AND NOT (j.id = ANY(v_ids))
       AND (
         NOT EXISTS (
           SELECT 1 FROM public.instagram_collection_job_operations AS o
            WHERE o.job_id = j.id AND o.job_generation = j.job_generation)
         OR EXISTS (
           SELECT 1 FROM public.instagram_collection_job_operations AS o
            WHERE o.job_id = j.id
              AND o.job_generation = j.job_generation
              AND o.state IN ('pending', 'failed')
              AND (o.retry_at IS NULL OR o.retry_at <= now())
              AND (o.provider_date IS NULL OR o.provider_date >= v_fresh_cutoff))
       )
     ORDER BY j.due_at ASC, j.id ASC
     LIMIT 500
  LOOP
    EXIT WHEN COALESCE(array_length(v_ids, 1), 0) >= v_fresh_cap;
    IF public.ig_collection_try_claim_job(v_candidate, v_lease) THEN
      v_ids := v_ids || v_candidate;
    END IF;
  END LOOP;

  -- Pass 2: the oldest remaining eligible work, so old failures still run
  -- but never take every slot.
  FOR v_candidate IN
    SELECT j.id
      FROM public.instagram_collection_jobs AS j
     WHERE j.target_kind = p_target_kind
       AND j.status IN ('queued', 'retry', 'partial', 'leased')
       AND j.due_at <= now()
       AND (j.lease_token IS NULL OR j.lease_expires_at IS NULL
            OR j.lease_expires_at <= clock_timestamp())
       AND NOT (j.id = ANY(v_ids))
       AND (
         NOT EXISTS (
           SELECT 1 FROM public.instagram_collection_job_operations AS o
            WHERE o.job_id = j.id AND o.job_generation = j.job_generation)
         OR EXISTS (
           SELECT 1 FROM public.instagram_collection_job_operations AS o
            WHERE o.job_id = j.id
              AND o.job_generation = j.job_generation
              AND o.state IN ('pending', 'failed')
              AND (o.retry_at IS NULL OR o.retry_at <= now()))
       )
     ORDER BY j.due_at ASC, j.id ASC
     LIMIT 500
  LOOP
    EXIT WHEN COALESCE(array_length(v_ids, 1), 0) >= v_pass2_limit;
    IF public.ig_collection_try_claim_job(v_candidate, v_lease) THEN
      v_ids := v_ids || v_candidate;
    END IF;
  END LOOP;

  -- Pass 3: finalize a generation that has only terminal operations.
  -- The claim helper still applies the connection check, so a changed
  -- credential bumps the generation and leaves the old rows as history.
  FOR v_candidate IN
    SELECT j.id
      FROM public.instagram_collection_jobs AS j
     WHERE j.target_kind = p_target_kind
       AND j.status IN ('queued', 'retry', 'partial', 'leased')
       AND j.due_at <= now()
       AND (j.lease_token IS NULL OR j.lease_expires_at IS NULL
            OR j.lease_expires_at <= clock_timestamp())
       AND NOT (j.id = ANY(v_ids))
       AND EXISTS (
         SELECT 1
           FROM public.instagram_collection_job_operations AS o
          WHERE o.job_id = j.id
            AND o.job_generation = j.job_generation)
       AND NOT EXISTS (
         SELECT 1
           FROM public.instagram_collection_job_operations AS o
          WHERE o.job_id = j.id
            AND o.job_generation = j.job_generation
            AND o.state IN ('pending', 'failed'))
     ORDER BY j.due_at ASC, j.id ASC
     LIMIT 500
  LOOP
    EXIT WHEN COALESCE(array_length(v_ids, 1), 0) >= v_limit;
    IF public.ig_collection_try_claim_job(v_candidate, v_lease) THEN
      v_ids := v_ids || v_candidate;
    END IF;
  END LOOP;

  RETURN QUERY
  SELECT jsonb_build_object(
    'job_id', j.id,
    'user_id', j.user_id,
    'target_kind', j.target_kind,
    'target_id', j.target_id,
    'social_account_id', j.social_account_id,
    'watchlist_id', j.watchlist_id,
    'captured_on', j.captured_on,
    'job_generation', j.job_generation,
    'claim_token', j.lease_token,
    'lease_expires_at', j.lease_expires_at,
    'attempts', j.attempts,
    'context', jsonb_build_object(
      'viewer_social_account_id', j.context_viewer_social_account_id,
      'credential_generation', j.context_credential_generation,
      'login_kind', j.context_login_kind,
      'capability_present', COALESCE(cap.info ->> 'capability_present', 'false')::boolean,
      'permission_read_state', cap.info ->> 'permission_read_state',
      'granted_scopes', COALESCE(cap.info -> 'granted_scopes', '[]'::jsonb)
    ),
    'checkpoint', COALESCE(ck.info, '{}'::jsonb),
    'pending_operations', COALESCE(ops.info, '[]'::jsonb),
    'claimed_at', now()
  )
  FROM public.instagram_collection_jobs AS j
  LEFT JOIN LATERAL (
    SELECT jsonb_build_object(
      'capability_present', (c.social_account_id IS NOT NULL),
      'permission_read_state', c.permission_read_state,
      'granted_scopes', COALESCE(to_jsonb(c.granted_scopes), '[]'::jsonb)
    ) AS info
      FROM (SELECT 1) AS one
      LEFT JOIN public.instagram_account_capabilities AS c
             ON c.social_account_id = j.context_viewer_social_account_id
  ) AS cap ON true
  LEFT JOIN LATERAL (
    SELECT to_jsonb(cp) - 'id' - 'job_id' - 'user_id' - 'job_generation' AS info
      FROM public.instagram_collection_job_checkpoints AS cp
     WHERE cp.job_id = j.id AND cp.job_generation = j.job_generation
  ) AS ck ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
             'operation_key', o.operation_key,
             'operation_kind', o.operation_kind,
             'provider_date', o.provider_date,
             'query_kind', o.query_kind,
             'state', o.state,
             'attempts', o.attempts,
             'retry_at', o.retry_at,
             'reason_code', o.reason_code
           ) ORDER BY o.provider_date NULLS FIRST, o.operation_key), '[]'::jsonb) AS info
      FROM (
        SELECT o2.operation_key, o2.operation_kind, o2.provider_date, o2.query_kind,
               o2.state, o2.attempts, o2.retry_at, o2.reason_code
          FROM public.instagram_collection_job_operations AS o2
         WHERE o2.job_id = j.id
           AND o2.job_generation = j.job_generation
           AND o2.state IN ('pending', 'failed')
         ORDER BY o2.provider_date NULLS FIRST, o2.operation_key
         LIMIT 200
      ) AS o
  ) AS ops ON true
  WHERE j.id = ANY(v_ids)
  ORDER BY j.due_at ASC, j.id ASC;
END;
$function$;

-- ===========================================================================
-- 12. The viewer context.
--
-- attach_instagram_collection_job_viewer_context(job, token, generation, viewer)
--
-- A competitor job has no viewer until the worker chooses one. This binds
-- the chosen account BEFORE the provider call, under the same lease fence
-- as every other write, and records the credential generation that was
-- observed.
--
-- The viewer must be an Instagram account of the SAME owner, active, not
-- needing a reauth, page-linked (a direct Instagram login cannot perform
-- Business Discovery) and carrying a capability row whose permission read
-- succeeded and which grants an insights scope.
--
-- A missing or unusable viewer is a typed refusal. It is never a silent
-- completion: without a bound viewer the job cannot be written and cannot
-- be completed successfully.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.attach_instagram_collection_job_viewer_context(
  p_job_id               uuid,
  p_claim_token          uuid,
  p_job_generation       bigint,
  p_viewer_social_account_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_job        public.instagram_collection_jobs%ROWTYPE;
  v_viewer_active boolean := false;
  v_viewer_needs_reauth boolean := false;
  v_credential_generation bigint := NULL;
  v_login_kind  text := NULL;
  v_read_state  text := NULL;
  v_scopes      text[] := ARRAY[]::text[];
BEGIN
  PERFORM public.ig_collection_assert_service_caller();

  -- Parents first, including the viewer this call is about to bind.
  -- Context is not required yet: this call is what captures it.
  v_job := public.ig_collection_load_fenced_job(
    p_job_id, p_claim_token, p_job_generation, false, p_viewer_social_account_id);

  IF v_job.target_kind <> 'competitor' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_VIEWER_NOT_APPLICABLE: an owner job is bound to its own account'
      USING ERRCODE = '22023';
  END IF;

  IF p_viewer_social_account_id IS NULL THEN
    RAISE EXCEPTION
      'IG_COLLECTION_VIEWER_REQUIRED: a viewer account is required'
      USING ERRCODE = '22023';
  END IF;

  SELECT sa.is_active, sa.needs_reauth
    INTO v_viewer_active, v_viewer_needs_reauth
    FROM public.social_accounts AS sa
   WHERE sa.id = p_viewer_social_account_id
     AND sa.user_id = v_job.user_id
     AND sa.platform = 'instagram';

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'IG_COLLECTION_VIEWER_NOT_OWNED: the viewer account does not belong to this owner'
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT COALESCE(v_viewer_active, false) THEN
    RAISE EXCEPTION
      'IG_COLLECTION_VIEWER_INACTIVE: the viewer account is not active'
      USING ERRCODE = '22023';
  END IF;

  IF COALESCE(v_viewer_needs_reauth, false) THEN
    RAISE EXCEPTION
      'IG_COLLECTION_VIEWER_NEEDS_REAUTH: the viewer account needs to be reconnected'
      USING ERRCODE = '22023';
  END IF;

  -- The capability row is the connection authority. No row means the
  -- account was never read; a row whose read never succeeded means the
  -- scope set is unknown. Neither may drive a provider call.
  SELECT c.credential_generation, c.login_kind, c.permission_read_state, c.granted_scopes
    INTO v_credential_generation, v_login_kind, v_read_state, v_scopes
    FROM public.instagram_account_capabilities AS c
   WHERE c.social_account_id = p_viewer_social_account_id;

  IF v_credential_generation IS NULL THEN
    RAISE EXCEPTION
      'IG_COLLECTION_VIEWER_CAPABILITY_MISSING: the viewer account has no recorded capability'
      USING ERRCODE = '22023';
  END IF;

  IF v_read_state <> 'ok' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_VIEWER_CAPABILITY_MISSING: the viewer capability has not been read successfully'
      USING ERRCODE = '22023';
  END IF;

  IF v_login_kind <> 'page_linked' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_VIEWER_UNSUPPORTED_LOGIN: a competitor query needs a page-linked viewer'
      USING ERRCODE = '22023';
  END IF;

  IF NOT (v_scopes @> ARRAY['instagram_manage_insights']
          OR v_scopes @> ARRAY['instagram_business_manage_insights']) THEN
    RAISE EXCEPTION
      'IG_COLLECTION_VIEWER_SCOPE_MISSING: the viewer does not hold an insights scope'
      USING ERRCODE = '22023';
  END IF;

  -- A second attachment cannot retarget a captured connection onto the
  -- same job generation. Reclaim is what advances the generation.
  IF v_job.context_credential_generation IS NOT NULL THEN
    IF v_job.context_viewer_social_account_id IS DISTINCT FROM p_viewer_social_account_id THEN
      RAISE EXCEPTION
        'IG_COLLECTION_VIEWER_ALREADY_BOUND: this generation already has a viewer'
        USING ERRCODE = '22023';
    END IF;

    IF v_job.context_credential_generation IS DISTINCT FROM v_credential_generation
       OR v_job.context_login_kind IS DISTINCT FROM v_login_kind THEN
      RAISE EXCEPTION
        'IG_COLLECTION_CREDENTIAL_CHANGED: the connection was replaced after this work was claimed'
        USING ERRCODE = '40001';
    END IF;
  END IF;

  PERFORM public.ig_collection_assert_lease_live(v_job.lease_expires_at);

  UPDATE public.instagram_collection_jobs AS j
     SET context_viewer_social_account_id = p_viewer_social_account_id,
         context_credential_generation    = v_credential_generation,
         context_login_kind               = v_login_kind,
         updated_at = now()
   WHERE j.id = p_job_id;

  RETURN jsonb_build_object(
    'job_id', p_job_id,
    'job_generation', v_job.job_generation,
    'viewer_social_account_id', p_viewer_social_account_id,
    'credential_generation', v_credential_generation,
    'login_kind', v_login_kind,
    'granted_scopes', to_jsonb(v_scopes)
  );
END;
$function$;

-- ===========================================================================
-- 13. The progress record.
--
-- record_instagram_collection_job_progress(job, token, generation, payload)
--
-- The channel for everything that is NOT a captured value:
--
--   { "kind": "operations", "items": [
--       { "operation_key": "...", "operation_kind": "media"|"account_day"|"profile",
--         "provider_date": "YYYY-MM-DD", "query_kind": "interactions"|"follow_breakdown",
--         "state": "pending"|"failed", "reason_code": "...", "retry_at": "..." } ] }
--
--   { "kind": "inventory",
--     "cursor": "...", "remaining_ids": ["..."], "pages_fetched": 2,
--     "oldest_returned_at": "...", "window_start": "YYYY-MM-DD",
--     "window_end": "YYYY-MM-DD", "partial": false, "truncated": false,
--     "window_covered": false, "gap_reason": "..." }
--
-- A 'pending' operation is REGISTERED. It never resets an operation that
-- already finished. A 'failed' operation records the failure and its retry
-- time; it never downgrades a finished operation either.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.record_instagram_collection_job_progress(
  p_job_id         uuid,
  p_claim_token    uuid,
  p_job_generation bigint,
  p_payload        jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_job      public.instagram_collection_jobs%ROWTYPE;
  v_kind     text;
  v_item     jsonb;
  v_item_key text;
  v_op_kind  text;
  v_state    text;
  v_reason   text;
  v_retry_at timestamptz;
  v_date     date;
  v_query    text;
  v_affected integer := 0;
  v_cursor   text;
  v_remaining text[];
  v_pages    integer;
  v_oldest   timestamptz;
  v_wstart   date;
  v_wend     date;
  v_partial  boolean;
  v_trunc    boolean;
  v_covered  boolean;
  v_gap      text;
BEGIN
  PERFORM public.ig_collection_assert_service_caller();

  -- Provider results, including inventory pages and operation rows, require
  -- the captured viewer context. A boolean in the payload is not read.
  v_job := public.ig_collection_load_fenced_job(
    p_job_id, p_claim_token, p_job_generation, true, NULL);

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_PAYLOAD: the payload must be an object'
      USING ERRCODE = '22023';
  END IF;

  v_kind := lower(p_payload ->> 'kind');

  IF v_kind = 'operations' THEN
    IF jsonb_typeof(p_payload -> 'items') <> 'array' THEN
      RAISE EXCEPTION
        'IG_COLLECTION_INVALID_PAYLOAD: items must be an array'
        USING ERRCODE = '22023';
    END IF;

    IF jsonb_array_length(p_payload -> 'items') > 200 THEN
      RAISE EXCEPTION
        'IG_COLLECTION_BATCH_TOO_LARGE: at most 200 operations per call'
        USING ERRCODE = '22023';
    END IF;

    PERFORM public.ig_collection_assert_lease_live(v_job.lease_expires_at);

    FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload -> 'items') LOOP
      IF jsonb_typeof(v_item) <> 'object' THEN
        RAISE EXCEPTION
          'IG_COLLECTION_INVALID_PAYLOAD: every operation must be an object'
          USING ERRCODE = '22023';
      END IF;

      v_item_key := public.ig_collection_text(v_item, 'operation_key', 200);
      v_op_kind  := lower(public.ig_collection_text(v_item, 'operation_kind', 32));
      v_state    := lower(public.ig_collection_text(v_item, 'state', 32));
      v_reason   := public.ig_collection_reason_code(v_item ->> 'reason_code');
      v_retry_at := public.ig_collection_timestamp(v_item, 'retry_at');
      v_date     := public.ig_collection_date(v_item, 'provider_date');
      v_query    := public.ig_collection_text(v_item, 'query_kind', 32);

      IF v_item_key IS NULL OR btrim(v_item_key) = '' THEN
        RAISE EXCEPTION
          'IG_COLLECTION_INVALID_PAYLOAD: an operation_key is required'
          USING ERRCODE = '22023';
      END IF;

      IF v_op_kind NOT IN ('media', 'account_day', 'profile') THEN
        RAISE EXCEPTION
          'IG_COLLECTION_INVALID_PAYLOAD: unknown operation kind'
          USING ERRCODE = '22023';
      END IF;

      IF v_state NOT IN ('pending', 'failed') THEN
        RAISE EXCEPTION
          'IG_COLLECTION_INVALID_PAYLOAD: progress may only record a pending or a failed operation'
          USING ERRCODE = '22023';
      END IF;

      IF v_op_kind = 'account_day' AND (v_date IS NULL OR v_query NOT IN ('interactions', 'follow_breakdown')) THEN
        RAISE EXCEPTION
          'IG_COLLECTION_INVALID_PAYLOAD: an account_day operation needs a provider_date and a query_kind'
          USING ERRCODE = '22023';
      END IF;

      IF v_op_kind <> 'account_day' AND (v_date IS NOT NULL OR v_query IS NOT NULL) THEN
        RAISE EXCEPTION
          'IG_COLLECTION_INVALID_PAYLOAD: only an account_day operation may carry a date or a query kind'
          USING ERRCODE = '22023';
      END IF;

      IF v_state = 'failed' AND v_retry_at IS NULL THEN
        v_retry_at := now() + public.ig_collection_backoff_interval(v_job.attempts)
                      + make_interval(secs => (random() * 60)::integer);
      END IF;

      INSERT INTO public.instagram_collection_job_operations AS o (
        job_id, user_id, job_generation, operation_key, operation_kind,
        provider_date, query_kind, state, attempts, retry_at, last_attempt_at,
        reason_code
      )
      VALUES (
        p_job_id, v_job.user_id, v_job.job_generation, v_item_key, v_op_kind,
        v_date, v_query, v_state,
        CASE WHEN v_state = 'failed' THEN 1 ELSE 0 END,
        v_retry_at, CASE WHEN v_state = 'failed' THEN now() ELSE NULL END,
        v_reason
      )
      ON CONFLICT (job_id, job_generation, operation_key) DO UPDATE
         SET state       = CASE WHEN o.state IN ('success', 'unavailable') THEN o.state ELSE EXCLUDED.state END,
             attempts    = CASE WHEN o.state IN ('success', 'unavailable') THEN o.attempts
                                ELSE GREATEST(o.attempts, EXCLUDED.attempts) END,
             retry_at    = CASE WHEN o.state IN ('success', 'unavailable') THEN o.retry_at ELSE EXCLUDED.retry_at END,
             reason_code = CASE WHEN o.state IN ('success', 'unavailable') THEN o.reason_code ELSE EXCLUDED.reason_code END,
             last_attempt_at = CASE WHEN o.state IN ('success', 'unavailable') THEN o.last_attempt_at
                                    ELSE EXCLUDED.last_attempt_at END,
             updated_at  = now()
        WHERE o.state NOT IN ('success', 'unavailable');

      v_affected := v_affected + 1;
    END LOOP;

    RETURN jsonb_build_object(
      'job_id', p_job_id,
      'job_generation', v_job.job_generation,
      'recorded', v_affected
    );
  ELSIF v_kind = 'inventory' THEN
    v_cursor    := public.ig_collection_text(p_payload, 'cursor', 512);
    v_remaining := ARRAY(SELECT jsonb_array_elements_text(p_payload -> 'remaining_ids'));
    v_pages    := COALESCE(public.ig_collection_metric_int(p_payload, 'pages_fetched'), 0);
    v_oldest   := public.ig_collection_timestamp(p_payload, 'oldest_returned_at');
    v_wstart   := public.ig_collection_date(p_payload, 'window_start');
    v_wend     := public.ig_collection_date(p_payload, 'window_end');
    v_partial  := COALESCE((p_payload ->> 'partial')::boolean, false);
    v_trunc    := COALESCE((p_payload ->> 'truncated')::boolean, false);
    v_covered  := COALESCE((p_payload ->> 'window_covered')::boolean, false);
    v_gap      := public.ig_collection_reason_code(p_payload ->> 'gap_reason');

    IF v_cursor IS NOT NULL
       AND (v_cursor !~ '^[^[:space:]]+$' OR v_cursor ~ '://' OR lower(v_cursor) LIKE '%access_token%') THEN
      RAISE EXCEPTION
        'IG_COLLECTION_INVALID_PAYLOAD: the cursor must be an opaque provider token'
        USING ERRCODE = '22023';
    END IF;

    IF COALESCE(array_length(v_remaining, 1), 0) > 500 THEN
      RAISE EXCEPTION
        'IG_COLLECTION_BATCH_TOO_LARGE: at most 500 remaining media ids'
        USING ERRCODE = '22023';
    END IF;

    PERFORM public.ig_collection_assert_lease_live(v_job.lease_expires_at);

    INSERT INTO public.instagram_collection_job_checkpoints AS c (
      job_id, user_id, job_generation, inventory_cursor, inventory_remaining_ids,
      inventory_pages_fetched, inventory_partial, inventory_truncated,
      inventory_oldest_returned_at, inventory_window_start, inventory_window_end,
      inventory_window_covered, inventory_gap_reason, updated_at
    )
    VALUES (
      p_job_id, v_job.user_id, v_job.job_generation, v_cursor,
      COALESCE(v_remaining, ARRAY[]::text[]),
      v_pages, v_partial, v_trunc, v_oldest, v_wstart, v_wend, v_covered, v_gap, now()
    )
    ON CONFLICT (job_id, job_generation) DO UPDATE
       SET inventory_cursor            = EXCLUDED.inventory_cursor,
           inventory_remaining_ids     = EXCLUDED.inventory_remaining_ids,
           inventory_pages_fetched     = EXCLUDED.inventory_pages_fetched,
           inventory_partial           = EXCLUDED.inventory_partial,
           inventory_truncated         = EXCLUDED.inventory_truncated,
           inventory_oldest_returned_at = EXCLUDED.inventory_oldest_returned_at,
           inventory_window_start      = EXCLUDED.inventory_window_start,
           inventory_window_end        = EXCLUDED.inventory_window_end,
           inventory_window_covered    = EXCLUDED.inventory_window_covered,
           inventory_gap_reason        = EXCLUDED.inventory_gap_reason,
           updated_at                  = now();

    RETURN jsonb_build_object(
      'job_id', p_job_id,
      'job_generation', v_job.job_generation,
      'inventory', 'recorded'
    );
  ELSE
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_PAYLOAD: kind must be operations or inventory'
      USING ERRCODE = '22023';
  END IF;
END;
$function$;

-- ===========================================================================
-- 14. The fenced snapshot write.
--
-- persist_instagram_collection_snapshot(job, token, generation, payload)
--
-- The payload is discriminated by 'kind' and every kind has its own fixed
-- column whitelist. There is no dynamic SQL and no way to name a table or
-- a column: an unknown key is refused.
--
--   { "kind": "owner_media", "items": [ { "ig_media_id": "...",
--       "media_product_type": "REELS", "media_type": "VIDEO",
--       "product": "...", "thumbnail_url": "...", "caption": "...",
--       "permalink": "...", "published_at": "...",
--       "status": "ok"|"unavailable",
--       "metrics": { "views": 12, "reach": null, ... } } ] }
--
--   { "kind": "owner_account_day", "items": [ { "provider_date": "...",
--       "metric_date": "...", "query_kind": "interactions"|"follow_breakdown",
--       "period_start": "...", "period_end": "...",
--       "provider_timezone": "...", "status": "ok"|"unavailable",
--       "metrics": { ... } } ] }
--
--   { "kind": "owner_profile_observation", "items": [ { "observed_at": "...",
--       "status": "ok"|"unavailable",
--       "metrics": { "followers_count": 12, "media_count": 3 } } ] }
--
--   { "kind": "competitor_profile", "items": [ { "source": "official",
--       "status": "ok"|"unavailable", "metrics": { ... } } ] }
--
--   { "kind": "competitor_media", "items": [ { "ig_media_id": "...",
--       "source": "official", "published_at": "...", "status": "ok"|"unavailable",
--       "metrics": { "like_count": 1, "comments_count": 2, "view_count": 3 } } ] }
--
-- The owner, the target, the capture day and the post link come from the
-- JOB and from the owned platform_posts lookup - never from the payload.
-- Every write happens in this transaction, so the checkpoint and the success
-- timestamps advance only if the snapshot rows actually commit.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.persist_instagram_collection_snapshot(
  p_job_id         uuid,
  p_claim_token    uuid,
  p_job_generation bigint,
  p_payload        jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_job         public.instagram_collection_jobs%ROWTYPE;
  v_kind        text;
  v_item        jsonb;
  v_metrics     jsonb;
  v_key         text;
  v_allowed     text[];
  v_status      text;
  v_source      text;
  v_media_id    text;
  v_product     text;
  v_media_type  text;
  v_thumb       text;
  v_caption     text;
  v_permalink   text;
  v_published   timestamptz;
  v_observed    timestamptz;
  v_provider_date date;
  v_metric_date date;
  v_query_kind  text;
  v_period_start timestamptz;
  v_period_end   timestamptz;
  v_tz          text;
  v_post_id     uuid;
  v_op_state    text;
  v_written     integer := 0;
  v_affected    integer;
  v_credential  bigint;
BEGIN
  PERFORM public.ig_collection_assert_service_caller();

  v_job := public.ig_collection_load_fenced_job(
    p_job_id, p_claim_token, p_job_generation, true, NULL);

  IF p_payload IS NULL OR jsonb_typeof(p_payload) <> 'object' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_PAYLOAD: the payload must be an object'
      USING ERRCODE = '22023';
  END IF;

  v_kind := lower(p_payload ->> 'kind');

  IF v_kind IS NULL OR v_kind NOT IN ('owner_media', 'owner_account_day',
                                      'owner_profile_observation',
                                      'competitor_profile', 'competitor_media') THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_PAYLOAD: unknown snapshot kind'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_typeof(p_payload -> 'items') <> 'array' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_PAYLOAD: items must be an array'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_payload -> 'items') = 0 THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_PAYLOAD: at least one item is required'
      USING ERRCODE = '22023';
  END IF;

  IF jsonb_array_length(p_payload -> 'items') > 100 THEN
    RAISE EXCEPTION
      'IG_COLLECTION_BATCH_TOO_LARGE: at most 100 items per call'
      USING ERRCODE = '22023';
  END IF;

  -- The snapshot rows and the operation rows are one transaction. The
  -- lease is checked again here, after payload validation and after the
  -- parent locks were waited out inside the fence.
  PERFORM public.ig_collection_assert_lease_live(v_job.lease_expires_at);

  FOR v_item IN SELECT * FROM jsonb_array_elements(p_payload -> 'items') LOOP
    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION
        'IG_COLLECTION_INVALID_PAYLOAD: every item must be an object'
        USING ERRCODE = '22023';
    END IF;

    v_metrics := COALESCE(v_item -> 'metrics', '{}'::jsonb);

    IF jsonb_typeof(v_metrics) <> 'object' THEN
      RAISE EXCEPTION
        'IG_COLLECTION_INVALID_PAYLOAD: metrics must be an object'
        USING ERRCODE = '22023';
    END IF;

    v_status := lower(public.ig_collection_text(v_item, 'status', 32));

    IF v_status IS NULL THEN
      v_status := 'ok';
    END IF;

    IF v_status NOT IN ('ok', 'unavailable') THEN
      RAISE EXCEPTION
        'IG_COLLECTION_INVALID_PAYLOAD: a captured item is ok or unavailable; a failure is a progress record'
        USING ERRCODE = '22023';
    END IF;

    v_op_state := CASE WHEN v_status = 'ok' THEN 'success' ELSE 'unavailable' END;

    -- The metric whitelist is per kind AND, for an account day, per query
    -- kind. A metric that belongs to the other query kind is refused rather
    -- than silently dropped.
    IF v_kind = 'owner_account_day' THEN
      v_query_kind := lower(public.ig_collection_text(v_item, 'query_kind', 32));

      IF v_query_kind NOT IN ('interactions', 'follow_breakdown') THEN
        RAISE EXCEPTION
          'IG_COLLECTION_INVALID_PAYLOAD: query_kind must be interactions or follow_breakdown'
          USING ERRCODE = '22023';
      END IF;
    END IF;

    IF v_kind = 'owner_media' THEN
      v_allowed := ARRAY['views', 'reach', 'likes', 'comments', 'saved', 'shares',
                         'total_interactions', 'follows', 'profile_visits', 'replies',
                         'ig_reels_avg_watch_time_ms', 'like_count_public',
                         'comments_count_public'];
    ELSIF v_kind = 'owner_account_day' THEN
      v_allowed := CASE v_query_kind
        WHEN 'interactions' THEN ARRAY['reach', 'views', 'accounts_engaged',
                                       'total_interactions', 'likes', 'comments',
                                       'saves', 'shares']
        ELSE ARRAY['follows', 'unfollows']
      END;
    ELSIF v_kind = 'owner_profile_observation' THEN
      v_allowed := ARRAY['followers_count', 'media_count'];
    ELSIF v_kind = 'competitor_profile' THEN
      v_allowed := ARRAY['followers_count', 'media_count'];
    ELSE
      v_allowed := ARRAY['like_count', 'comments_count', 'view_count'];
    END IF;

    FOR v_key IN SELECT jsonb_object_keys(v_metrics) LOOP
      IF v_key <> ALL (v_allowed) THEN
        RAISE EXCEPTION
          'IG_COLLECTION_INVALID_PAYLOAD: metric % is not allowed for %', v_key, v_kind
          USING ERRCODE = '22023';
      END IF;
    END LOOP;

    IF v_kind = 'owner_media' THEN
      v_media_id   := public.ig_collection_text(v_item, 'ig_media_id', 255);
      v_product    := public.ig_collection_text(v_item, 'media_product_type', 32);
      v_media_type := public.ig_collection_text(v_item, 'media_type', 32);
      v_thumb      := public.ig_collection_text(v_item, 'thumbnail_url', 2000);
      v_caption    := public.ig_collection_text(v_item, 'caption', 2000);
      v_permalink  := public.ig_collection_text(v_item, 'permalink', 2000);
      v_published  := public.ig_collection_timestamp(v_item, 'published_at');

      IF v_media_id IS NULL OR btrim(v_media_id) = '' THEN
        RAISE EXCEPTION
          'IG_COLLECTION_INVALID_PAYLOAD: an ig_media_id is required'
          USING ERRCODE = '22023';
      END IF;

      IF v_published IS NULL THEN
        RAISE EXCEPTION
          'IG_COLLECTION_INVALID_PAYLOAD: a published_at is required'
          USING ERRCODE = '22023';
      END IF;

      -- The post link is resolved from the OWNED platform_posts rows. An
      -- ambiguous or missing match stays NULL; it is never guessed.
      v_post_id := public.resolve_ig_media_post_link(v_job.social_account_id, v_media_id);

      INSERT INTO public.ig_media_insight_snapshots AS t (
        user_id, social_account_id, post_id, ig_media_id, media_product_type,
        media_type, product, thumbnail_url, caption, permalink, published_at,
        captured_on, captured_at, capture_timezone, views, reach, likes,
        comments, saved, shares, total_interactions, follows, profile_visits,
        replies, ig_reels_avg_watch_time_ms, like_count_public,
        comments_count_public, status
      )
      VALUES (
        v_job.user_id, v_job.social_account_id, v_post_id, v_media_id, v_product,
        v_media_type, public.ig_collection_text(v_item, 'product', 64), v_thumb,
        v_caption, v_permalink, v_published, v_job.captured_on, now(),
        'Asia/Kuwait',
        public.ig_collection_metric_int(v_metrics, 'views'),
        public.ig_collection_metric_int(v_metrics, 'reach'),
        public.ig_collection_metric_int(v_metrics, 'likes'),
        public.ig_collection_metric_int(v_metrics, 'comments'),
        public.ig_collection_metric_int(v_metrics, 'saved'),
        public.ig_collection_metric_int(v_metrics, 'shares'),
        public.ig_collection_metric_int(v_metrics, 'total_interactions'),
        public.ig_collection_metric_int(v_metrics, 'follows'),
        public.ig_collection_metric_int(v_metrics, 'profile_visits'),
        public.ig_collection_metric_int(v_metrics, 'replies'),
        public.ig_collection_metric_int(v_metrics, 'ig_reels_avg_watch_time_ms'),
        public.ig_collection_metric_int(v_metrics, 'like_count_public'),
        public.ig_collection_metric_int(v_metrics, 'comments_count_public'),
        v_status
      )
      ON CONFLICT (social_account_id, ig_media_id, captured_on) DO UPDATE
         SET media_product_type          = EXCLUDED.media_product_type,
             media_type                  = EXCLUDED.media_type,
             product                     = EXCLUDED.product,
             thumbnail_url               = EXCLUDED.thumbnail_url,
             caption                     = EXCLUDED.caption,
             permalink                   = EXCLUDED.permalink,
             published_at                = EXCLUDED.published_at,
             captured_at                 = EXCLUDED.captured_at,
             views                       = EXCLUDED.views,
             reach                       = EXCLUDED.reach,
             likes                       = EXCLUDED.likes,
             comments                    = EXCLUDED.comments,
             saved                       = EXCLUDED.saved,
             shares                      = EXCLUDED.shares,
             total_interactions          = EXCLUDED.total_interactions,
             follows                     = EXCLUDED.follows,
             profile_visits              = EXCLUDED.profile_visits,
             replies                     = EXCLUDED.replies,
             ig_reels_avg_watch_time_ms  = EXCLUDED.ig_reels_avg_watch_time_ms,
             like_count_public           = EXCLUDED.like_count_public,
             comments_count_public       = EXCLUDED.comments_count_public,
             status                      = EXCLUDED.status;

      PERFORM public.ig_collection_record_operation(
        p_job_id, v_job.user_id, v_job.job_generation,
        'media:' || v_media_id, 'media', NULL, NULL, v_op_state, NULL);

    ELSIF v_kind = 'owner_account_day' THEN
      v_provider_date := public.ig_collection_date(v_item, 'provider_date');
      v_metric_date   := public.ig_collection_date(v_item, 'metric_date');
      v_period_start  := public.ig_collection_timestamp(v_item, 'period_start');
      v_period_end    := public.ig_collection_timestamp(v_item, 'period_end');
      v_tz            := public.ig_collection_text(v_item, 'provider_timezone', 64);

      IF v_provider_date IS NULL OR v_metric_date IS NULL THEN
        RAISE EXCEPTION
          'IG_COLLECTION_INVALID_PAYLOAD: a provider_date and a metric_date are required'
          USING ERRCODE = '22023';
      END IF;

      IF v_metric_date <> v_provider_date THEN
        RAISE EXCEPTION
          'IG_COLLECTION_INVALID_PAYLOAD: the metric day must be the provider day; a provider bucket is never relabelled'
          USING ERRCODE = '22023';
      END IF;

      IF v_query_kind NOT IN ('interactions', 'follow_breakdown') THEN
        RAISE EXCEPTION
          'IG_COLLECTION_INVALID_PAYLOAD: query_kind must be interactions or follow_breakdown'
          USING ERRCODE = '22023';
      END IF;

      IF v_query_kind = 'interactions' THEN
        INSERT INTO public.ig_account_insight_daily AS t (
          user_id, social_account_id, metric_date, provider_date, period_start,
          period_end, provider_timezone, reach, views, accounts_engaged,
          total_interactions, likes, comments, saves, shares, status
        )
        VALUES (
          v_job.user_id, v_job.social_account_id, v_metric_date, v_provider_date,
          v_period_start, v_period_end, v_tz,
          public.ig_collection_metric_int(v_metrics, 'reach'),
          public.ig_collection_metric_int(v_metrics, 'views'),
          public.ig_collection_metric_int(v_metrics, 'accounts_engaged'),
          public.ig_collection_metric_int(v_metrics, 'total_interactions'),
          public.ig_collection_metric_int(v_metrics, 'likes'),
          public.ig_collection_metric_int(v_metrics, 'comments'),
          public.ig_collection_metric_int(v_metrics, 'saves'),
          public.ig_collection_metric_int(v_metrics, 'shares'),
          v_status
        )
        ON CONFLICT (social_account_id, metric_date) DO UPDATE
           SET provider_date      = EXCLUDED.provider_date,
               period_start       = EXCLUDED.period_start,
               period_end         = EXCLUDED.period_end,
               provider_timezone  = EXCLUDED.provider_timezone,
               reach              = EXCLUDED.reach,
               views              = EXCLUDED.views,
               accounts_engaged   = EXCLUDED.accounts_engaged,
               total_interactions = EXCLUDED.total_interactions,
               likes              = EXCLUDED.likes,
               comments           = EXCLUDED.comments,
               saves              = EXCLUDED.saves,
               shares             = EXCLUDED.shares,
               status             = EXCLUDED.status;
      ELSE
        -- The follow breakdown writes its own columns only. It never
        -- touches the interaction metrics and never rewrites the row's
        -- capture status.
        INSERT INTO public.ig_account_insight_daily AS t (
          user_id, social_account_id, metric_date, provider_date, follows,
          unfollows, status
        )
        VALUES (
          v_job.user_id, v_job.social_account_id, v_metric_date, v_provider_date,
          public.ig_collection_metric_int(v_metrics, 'follows'),
          public.ig_collection_metric_int(v_metrics, 'unfollows'),
          'pending'
        )
        ON CONFLICT (social_account_id, metric_date) DO UPDATE
           SET follows   = EXCLUDED.follows,
               unfollows = EXCLUDED.unfollows;
      END IF;

      PERFORM public.ig_collection_record_operation(
        p_job_id, v_job.user_id, v_job.job_generation,
        'account_day:' || v_provider_date::text || ':' || v_query_kind,
        'account_day', v_provider_date, v_query_kind, v_op_state, NULL);

    ELSIF v_kind = 'owner_profile_observation' THEN
      v_observed := public.ig_collection_timestamp(v_item, 'observed_at');

      IF v_observed IS NULL THEN
        RAISE EXCEPTION
          'IG_COLLECTION_INVALID_PAYLOAD: an observed_at is required'
          USING ERRCODE = '22023';
      END IF;

      INSERT INTO public.ig_account_profile_observations AS t (
        user_id, social_account_id, observed_at, observed_on, capture_timezone,
        followers_count, media_count, status
      )
      VALUES (
        v_job.user_id, v_job.social_account_id, v_observed,
        (v_observed AT TIME ZONE 'Asia/Kuwait')::date, 'Asia/Kuwait',
        public.ig_collection_metric_int(v_metrics, 'followers_count'),
        public.ig_collection_metric_int(v_metrics, 'media_count'),
        v_status
      )
      ON CONFLICT (social_account_id, observed_at) DO UPDATE
         SET followers_count = EXCLUDED.followers_count,
             media_count     = EXCLUDED.media_count,
             status          = EXCLUDED.status;

      PERFORM public.ig_collection_record_operation(
        p_job_id, v_job.user_id, v_job.job_generation,
        'profile', 'profile', NULL, NULL, v_op_state, NULL);

    ELSIF v_kind = 'competitor_profile' THEN
      v_source := lower(public.ig_collection_text(v_item, 'source', 32));

      IF v_source IS NULL OR v_source NOT IN ('official', 'apify') THEN
        RAISE EXCEPTION
          'IG_COLLECTION_INVALID_PAYLOAD: a competitor source must be official or apify'
          USING ERRCODE = '22023';
      END IF;

      INSERT INTO public.competitor_profile_snapshots AS t (
        watchlist_id, user_id, captured_on, captured_at, capture_timezone,
        followers_count, media_count, source, status
      )
      VALUES (
        v_job.watchlist_id, v_job.user_id, v_job.captured_on, now(), 'Asia/Kuwait',
        public.ig_collection_metric_int(v_metrics, 'followers_count'),
        public.ig_collection_metric_int(v_metrics, 'media_count'),
        v_source, v_status
      )
      ON CONFLICT (watchlist_id, captured_on) DO UPDATE
         SET followers_count = EXCLUDED.followers_count,
             media_count     = EXCLUDED.media_count,
             source          = EXCLUDED.source,
             status          = EXCLUDED.status,
             captured_at     = EXCLUDED.captured_at;

      PERFORM public.ig_collection_record_operation(
        p_job_id, v_job.user_id, v_job.job_generation,
        'profile', 'profile', NULL, NULL, v_op_state, NULL);

    ELSE
      v_source    := lower(public.ig_collection_text(v_item, 'source', 32));
      v_media_id  := public.ig_collection_text(v_item, 'ig_media_id', 255);
      v_product   := public.ig_collection_text(v_item, 'media_product_type', 32);
      v_media_type := public.ig_collection_text(v_item, 'media_type', 32);
      v_thumb     := public.ig_collection_text(v_item, 'thumbnail_url', 2000);
      v_caption   := public.ig_collection_text(v_item, 'caption', 2000);
      v_permalink := public.ig_collection_text(v_item, 'permalink', 2000);
      v_published := public.ig_collection_timestamp(v_item, 'published_at');

      IF v_source IS NULL OR v_source NOT IN ('official', 'apify') THEN
        RAISE EXCEPTION
          'IG_COLLECTION_INVALID_PAYLOAD: a competitor source must be official or apify'
          USING ERRCODE = '22023';
      END IF;

      IF v_media_id IS NULL OR btrim(v_media_id) = '' THEN
        RAISE EXCEPTION
          'IG_COLLECTION_INVALID_PAYLOAD: an ig_media_id is required'
          USING ERRCODE = '22023';
      END IF;

      IF v_published IS NULL THEN
        RAISE EXCEPTION
          'IG_COLLECTION_INVALID_PAYLOAD: a published_at is required'
          USING ERRCODE = '22023';
      END IF;

      INSERT INTO public.competitor_media_snapshots AS t (
        watchlist_id, user_id, ig_media_id, captured_on, captured_at,
        capture_timezone, media_product_type, media_type, thumbnail_url,
        caption, permalink, published_at, like_count, comments_count,
        view_count, source, status
      )
      VALUES (
        v_job.watchlist_id, v_job.user_id, v_media_id, v_job.captured_on, now(),
        'Asia/Kuwait', v_product, v_media_type, v_thumb, v_caption, v_permalink,
        v_published,
        public.ig_collection_metric_int(v_metrics, 'like_count'),
        public.ig_collection_metric_int(v_metrics, 'comments_count'),
        public.ig_collection_metric_int(v_metrics, 'view_count'),
        v_source, v_status
      )
      ON CONFLICT (watchlist_id, ig_media_id, captured_on) DO UPDATE
         SET media_product_type = EXCLUDED.media_product_type,
             media_type         = EXCLUDED.media_type,
             thumbnail_url      = EXCLUDED.thumbnail_url,
             caption            = EXCLUDED.caption,
             permalink          = EXCLUDED.permalink,
             published_at       = EXCLUDED.published_at,
             like_count         = EXCLUDED.like_count,
             comments_count     = EXCLUDED.comments_count,
             view_count         = EXCLUDED.view_count,
             source             = EXCLUDED.source,
             status             = EXCLUDED.status,
             captured_at        = EXCLUDED.captured_at;

      PERFORM public.ig_collection_record_operation(
        p_job_id, v_job.user_id, v_job.job_generation,
        'media:' || v_media_id, 'media', NULL, NULL, v_op_state, NULL);
    END IF;

    v_written := v_written + 1;
  END LOOP;

  UPDATE public.instagram_collection_jobs AS j
     SET last_attempt_at = now(),
         updated_at = now()
   WHERE j.id = p_job_id;

  RETURN jsonb_build_object(
    'job_id', p_job_id,
    'job_generation', v_job.job_generation,
    'written', v_written
  );
END;
$function$;

-- ===========================================================================
-- 15. The operation recorder.
--
-- A tiny internal helper the snapshot writer calls: it marks an operation
-- as finished. It never downgrades an operation that already finished.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.ig_collection_record_operation(
  p_job_id         uuid,
  p_user_id        uuid,
  p_job_generation bigint,
  p_operation_key  text,
  p_operation_kind text,
  p_provider_date  date,
  p_query_kind     text,
  p_state          text,
  p_reason_code    text
)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  INSERT INTO public.instagram_collection_job_operations AS o (
    job_id, user_id, job_generation, operation_key, operation_kind,
    provider_date, query_kind, state, attempts, completed_at, reason_code
  )
  VALUES (
    p_job_id, p_user_id, p_job_generation, p_operation_key, p_operation_kind,
    p_provider_date, p_query_kind, p_state, 1, now(), p_reason_code
  )
  ON CONFLICT (job_id, job_generation, operation_key) DO UPDATE
     SET state        = CASE WHEN o.state IN ('success', 'unavailable') THEN o.state ELSE EXCLUDED.state END,
         attempts     = GREATEST(o.attempts, EXCLUDED.attempts),
         completed_at = CASE WHEN o.state IN ('success', 'unavailable') THEN o.completed_at ELSE EXCLUDED.completed_at END,
         reason_code  = CASE WHEN o.state IN ('success', 'unavailable') THEN o.reason_code ELSE EXCLUDED.reason_code END,
         retry_at     = CASE WHEN o.state IN ('success', 'unavailable') THEN o.retry_at ELSE NULL END,
         updated_at   = now()
    WHERE o.state NOT IN ('success', 'unavailable');
END;
$function$;

-- ===========================================================================
-- 16. The completion.
--
-- complete_instagram_collection_job(job, token, generation, outcome, reason)
--
-- outcome:
--   'completed'  - full success. REFUSED unless every operation of the
--                  current generation is finished, the job has a bound
--                  connection context, and (for an owner job) the media
--                  inventory is neither truncated nor uncovered. A capped
--                  inventory therefore never advances a full success.
--   'partial'    - the slice ran out of budget with useful progress. The
--                  job is queued again and last_partial_at advances.
--   'retry'      - a retryable failure. The job is queued again with the
--                  capped exponential backoff.
--   'unavailable'- a terminal, classified outcome. The data is not
--                  obtainable; the reason code says why.
--   'error'      - a terminal failure.
--
-- A completion never advances last_success_at except for 'completed'.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.complete_instagram_collection_job(
  p_job_id         uuid,
  p_claim_token    uuid,
  p_job_generation bigint,
  p_outcome        text,
  p_reason_code    text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_job        public.instagram_collection_jobs%ROWTYPE;
  v_outcome    text := lower(COALESCE(p_outcome, ''));
  v_reason     text := public.ig_collection_reason_code(p_reason_code);
  v_total      integer;
  v_pending    integer;
  v_failed     integer;
  v_truncated  boolean;
  v_covered    boolean;
  v_backoff    interval;
  v_continuation interval := interval '1 minute';
BEGIN
  PERFORM public.ig_collection_assert_service_caller();

  -- Every outcome is a result. Partial, retry, unavailable and error are
  -- refused by the same fence as a full success, before any timestamp moves.
  v_job := public.ig_collection_load_fenced_job(
    p_job_id, p_claim_token, p_job_generation, true, NULL);

  IF v_outcome NOT IN ('completed', 'partial', 'retry', 'unavailable', 'error') THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_OUTCOME: unknown completion outcome'
      USING ERRCODE = '22023';
  END IF;

  IF v_outcome IN ('unavailable', 'error') AND v_reason IS NULL THEN
    RAISE EXCEPTION
      'IG_COLLECTION_REASON_REQUIRED: a terminal outcome needs a reason code'
      USING ERRCODE = '22023';
  END IF;

  IF v_outcome = 'completed' THEN
    -- The connection context first: without a bound viewer or a captured
    -- credential generation there is nothing that could have been
    -- collected.
    IF v_job.context_viewer_social_account_id IS NULL
       OR v_job.context_credential_generation IS NULL THEN
      RAISE EXCEPTION
        'IG_COLLECTION_CONTEXT_MISSING: the job has no bound connection context'
        USING ERRCODE = '22023';
    END IF;

    -- Then the inventory truth. A capped or uncovered inventory is not a
    -- full success, whatever the operations say.
    IF v_job.target_kind = 'owner' THEN
      SELECT COALESCE(c.inventory_truncated, false),
             COALESCE(c.inventory_window_covered, false)
        INTO v_truncated, v_covered
        FROM public.instagram_collection_job_checkpoints AS c
       WHERE c.job_id = p_job_id
         AND c.job_generation = v_job.job_generation;

      IF v_truncated THEN
        RAISE EXCEPTION
          'IG_COLLECTION_INVENTORY_TRUNCATED: the media inventory was capped, so this is not a full success'
          USING ERRCODE = '22023';
      END IF;

      IF NOT COALESCE(v_covered, false) THEN
        RAISE EXCEPTION
          'IG_COLLECTION_COVERAGE_INCOMPLETE: the media inventory did not establish coverage of the window'
          USING ERRCODE = '22023';
      END IF;
    END IF;

    -- Then the operations of this generation.
    SELECT count(*),
           count(*) FILTER (WHERE o.state IN ('pending', 'failed')),
           count(*) FILTER (WHERE o.state = 'failed')
      INTO v_total, v_pending, v_failed
      FROM public.instagram_collection_job_operations AS o
     WHERE o.job_id = p_job_id
       AND o.job_generation = v_job.job_generation;

    IF v_total = 0 THEN
      RAISE EXCEPTION
        'IG_COLLECTION_NOTHING_CAPTURED: a job cannot complete successfully without a recorded operation'
        USING ERRCODE = '22023';
    END IF;

    IF v_pending > 0 THEN
      RAISE EXCEPTION
        'IG_COLLECTION_INCOMPLETE: % operations of this generation are still open', v_pending
        USING ERRCODE = '22023';
    END IF;

    IF v_failed > 0 THEN
      RAISE EXCEPTION
        'IG_COLLECTION_INCOMPLETE: % operations of this generation failed', v_failed
        USING ERRCODE = '22023';
    END IF;
  END IF;

  v_backoff := public.ig_collection_backoff_interval(v_job.attempts)
               + make_interval(secs => (random() * 60)::integer);

  PERFORM public.ig_collection_assert_lease_live(v_job.lease_expires_at);

  UPDATE public.instagram_collection_jobs AS j
     SET status           = CASE
                             WHEN v_outcome = 'completed'   THEN 'completed'
                             WHEN v_outcome = 'partial'     THEN 'partial'
                             WHEN v_outcome = 'retry'       THEN 'retry'
                             WHEN v_outcome = 'unavailable' THEN 'unavailable'
                             ELSE 'error'
                           END,
         due_at           = CASE
                             WHEN v_outcome = 'completed'   THEN j.due_at
                             WHEN v_outcome = 'partial'     THEN now() + v_continuation
                             WHEN v_outcome = 'retry'       THEN now() + v_backoff
                             ELSE j.due_at
                           END,
         retry_at         = CASE
                             WHEN v_outcome = 'retry'       THEN now() + v_backoff
                             ELSE NULL
                           END,
         lease_token      = NULL,
         lease_expires_at = NULL,
         last_partial_at  = CASE WHEN v_outcome = 'partial' THEN now() ELSE j.last_partial_at END,
         last_success_at  = CASE WHEN v_outcome = 'completed' THEN now() ELSE j.last_success_at END,
         last_reason_code = CASE
                             WHEN v_outcome IN ('unavailable', 'error') THEN v_reason
                             WHEN v_outcome = 'retry' THEN v_reason
                             ELSE NULL
                           END,
         updated_at       = now()
   WHERE j.id = p_job_id;

  RETURN jsonb_build_object(
    'job_id', p_job_id,
    'job_generation', v_job.job_generation,
    'status', CASE
                WHEN v_outcome = 'completed'   THEN 'completed'
                WHEN v_outcome = 'partial'     THEN 'partial'
                WHEN v_outcome = 'retry'       THEN 'retry'
                WHEN v_outcome = 'unavailable' THEN 'unavailable'
                ELSE 'error'
              END,
    'outcome', v_outcome,
    'reason_code', v_reason
  );
END;
$function$;

-- ===========================================================================
-- 17. The provider throttle.
--
-- record_instagram_provider_throttle(bucket_key, usage, until, job, token)
--
-- The shared bucket state a worker records after a provider response. The
-- bucket key is a non-secret hash the worker computes; the database never
-- sees a token.
--
-- When a job is named, the job is put into a fenced retry with the
-- provider's backoff, under the same claim fence as every other write. A
-- stale worker cannot park a job.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.record_instagram_provider_throttle(
  p_bucket_key      text,
  p_usage_percent   integer,
  p_throttled_until timestamptz,
  p_job_id          uuid DEFAULT NULL,
  p_claim_token     uuid DEFAULT NULL,
  p_job_generation  bigint DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_job     public.instagram_collection_jobs%ROWTYPE;
  v_backoff interval;
BEGIN
  PERFORM public.ig_collection_assert_service_caller();

  IF p_bucket_key IS NULL OR p_bucket_key !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_BUCKET_KEY: the bucket key must be a 64 character lower-case hex digest'
      USING ERRCODE = '22023';
  END IF;

  IF p_usage_percent IS NOT NULL AND (p_usage_percent < 0 OR p_usage_percent > 100) THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_USAGE: the usage percent must be between 0 and 100'
      USING ERRCODE = '22023';
  END IF;

  IF p_throttled_until IS NOT NULL AND NOT isfinite(p_throttled_until) THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_THROTTLE: the throttle deadline must be a finite timestamp'
      USING ERRCODE = '22023';
  END IF;

  -- A named job is parked only after the shared fence. The bucket write is
  -- in the same transaction, so a refused claim leaves the bucket untouched
  -- as well.
  IF p_job_id IS NOT NULL THEN
    IF p_claim_token IS NULL OR p_job_generation IS NULL THEN
      RAISE EXCEPTION
        'IG_COLLECTION_CLAIM_REQUIRED: a job-scoped throttle record needs the claim token and the job generation'
        USING ERRCODE = '22023';
    END IF;

    v_job := public.ig_collection_load_fenced_job(
      p_job_id, p_claim_token, p_job_generation, true, NULL);
    PERFORM public.ig_collection_assert_lease_live(v_job.lease_expires_at);
  END IF;

  INSERT INTO public.instagram_provider_throttle_buckets AS b (
    bucket_key, usage_percent, throttled_until, last_reported_at, updated_at
  )
  VALUES (p_bucket_key, p_usage_percent, p_throttled_until, now(), now())
  ON CONFLICT (bucket_key) DO UPDATE
     SET usage_percent   = EXCLUDED.usage_percent,
         throttled_until = GREATEST(
           COALESCE(b.throttled_until, EXCLUDED.throttled_until),
           EXCLUDED.throttled_until),
         last_reported_at = now(),
         updated_at = now();

  -- The upsert above locks the shared bucket and can wait on another
  -- account's transaction. The lease check before that wait is not the
  -- one that counts: re-read the wall clock after the lock is ours and
  -- before the job row changes. Raising here rolls the bucket write back
  -- with the job write, because both are this transaction.
  IF p_job_id IS NOT NULL THEN
    PERFORM public.ig_collection_assert_lease_live(v_job.lease_expires_at);
  END IF;

  IF p_job_id IS NULL THEN
    RETURN jsonb_build_object(
      'bucket_key', p_bucket_key,
      'usage_percent', p_usage_percent,
      'throttled_until', p_throttled_until,
      'job_id', NULL
    );
  END IF;

  v_backoff := public.ig_collection_backoff_interval(v_job.attempts)
               + make_interval(secs => (random() * 60)::integer);

  UPDATE public.instagram_collection_jobs AS j
     SET status           = 'retry',
         due_at           = COALESCE(p_throttled_until, now() + v_backoff),
         retry_at         = COALESCE(p_throttled_until, now() + v_backoff),
         lease_token      = NULL,
         lease_expires_at = NULL,
         last_reason_code = 'provider_throttled',
         updated_at       = now()
   WHERE j.id = p_job_id;

  RETURN jsonb_build_object(
    'bucket_key', p_bucket_key,
    'usage_percent', p_usage_percent,
    'throttled_until', p_throttled_until,
    'job_id', p_job_id,
    'status', 'retry'
  );
END;
$function$;

-- ===========================================================================
-- 18. The job context read.
--
-- read_instagram_collection_job_context(job, token)
--
-- The checkpoint surface for a worker that already holds a lease and needs
-- the current generation's state again - after a partial slice, for
-- instance. It is fenced by the claim exactly like the writes are.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.read_instagram_collection_job_context(
  p_job_id      uuid,
  p_claim_token uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_job public.instagram_collection_jobs%ROWTYPE;
BEGIN
  PERFORM public.ig_collection_assert_service_caller();

  SELECT * INTO v_job
    FROM public.instagram_collection_jobs AS j
   WHERE j.id = p_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'IG_COLLECTION_JOB_NOT_FOUND: no such collection job'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_job.lease_token IS DISTINCT FROM p_claim_token
     OR v_job.status <> 'leased' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_CLAIM_STALE: the claim is no longer valid for this job'
      USING ERRCODE = '40001';
  END IF;

  PERFORM public.ig_collection_assert_lease_live(v_job.lease_expires_at);

  RETURN jsonb_build_object(
    'job_id', v_job.id,
    'user_id', v_job.user_id,
    'target_kind', v_job.target_kind,
    'target_id', v_job.target_id,
    'captured_on', v_job.captured_on,
    'job_generation', v_job.job_generation,
    'context', jsonb_build_object(
      'viewer_social_account_id', v_job.context_viewer_social_account_id,
      'credential_generation', v_job.context_credential_generation,
      'login_kind', v_job.context_login_kind
    ),
    'checkpoint', COALESCE((
      SELECT to_jsonb(c) - 'id' - 'job_id' - 'user_id' - 'job_generation'
        FROM public.instagram_collection_job_checkpoints AS c
       WHERE c.job_id = v_job.id AND c.job_generation = v_job.job_generation
    ), '{}'::jsonb),
    'pending_operations', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
               'operation_key', o.operation_key,
               'operation_kind', o.operation_kind,
               'provider_date', o.provider_date,
               'query_kind', o.query_kind,
               'state', o.state,
               'attempts', o.attempts,
               'retry_at', o.retry_at,
               'reason_code', o.reason_code
             ) ORDER BY o.provider_date NULLS FIRST, o.operation_key)
        FROM public.instagram_collection_job_operations AS o
       WHERE o.job_id = v_job.id
         AND o.job_generation = v_job.job_generation
         AND o.state IN ('pending', 'failed')
    ), '[]'::jsonb)
  );
END;
$function$;

-- ===========================================================================
-- 19. Function grants.
--
-- Named EXPLICITLY. This stack carries ALTER DEFAULT PRIVILEGES ... GRANT
-- ALL ON FUNCTIONS TO anon, authenticated, so "REVOKE ... FROM PUBLIC"
-- alone leaves both roles holding EXECUTE. The anon key alone must not be
-- able to call any of these.
--
-- The owner functions are reachable by 'authenticated' and by nobody else.
-- The service functions are reachable by the service role and by an admin
-- session, and every one of them re-checks the caller inside.
-- ===========================================================================

REVOKE ALL ON FUNCTION public.ig_collection_assert_owner_caller() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_assert_service_caller() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_reason_code(text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_metric_int(jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_text(jsonb, text, integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_timestamp(jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_date(jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_backoff_interval(integer) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_id_array_ok(text[]) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_resolve_target(uuid, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_throttle_accept(text, uuid, text, uuid, interval) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_throttle_last_accepted(text, text, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_record_operation(uuid, uuid, bigint, text, text, date, text, text, text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_lock_accounts(uuid[], boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_lock_watchlist(uuid, boolean) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_assert_lease_live(timestamptz) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_load_fenced_job(uuid, uuid, bigint, boolean, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_try_claim_job(uuid, interval) FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.enqueue_instagram_collection_job(text, uuid, text) FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION public.read_instagram_collection_job_status(text, uuid, date) FROM PUBLIC, anon, service_role;

REVOKE ALL ON FUNCTION public.enqueue_instagram_collection_jobs_service(uuid, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_instagram_collection_jobs(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attach_instagram_collection_job_viewer_context(uuid, uuid, bigint, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_instagram_collection_job_progress(uuid, uuid, bigint, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.persist_instagram_collection_snapshot(uuid, uuid, bigint, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.complete_instagram_collection_job(uuid, uuid, bigint, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_instagram_provider_throttle(text, integer, timestamptz, uuid, uuid, bigint) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.read_instagram_collection_job_context(uuid, uuid) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.enqueue_instagram_collection_job(text, uuid, text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.read_instagram_collection_job_status(text, uuid, date) TO authenticated;

GRANT EXECUTE ON FUNCTION public.enqueue_instagram_collection_jobs_service(uuid, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_instagram_collection_jobs(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.attach_instagram_collection_job_viewer_context(uuid, uuid, bigint, uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_instagram_collection_job_progress(uuid, uuid, bigint, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.persist_instagram_collection_snapshot(uuid, uuid, bigint, jsonb) TO service_role;
GRANT EXECUTE ON FUNCTION public.complete_instagram_collection_job(uuid, uuid, bigint, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_instagram_provider_throttle(text, integer, timestamptz, uuid, uuid, bigint) TO service_role;
GRANT EXECUTE ON FUNCTION public.read_instagram_collection_job_context(uuid, uuid) TO service_role;

COMMENT ON FUNCTION public.enqueue_instagram_collection_job(text, uuid, text) IS
  'Owner-facing enqueue. The owner comes from auth.uid(); the target must '
  'belong to that owner. A normal enqueue is idempotent and never resets a '
  'finished operation or discards a force. A force bumps the job generation '
  'and is accepted only when the 15 minute accepted-request window allows '
  'it.';
COMMENT ON FUNCTION public.read_instagram_collection_job_status(text, uuid, date) IS
  'Owner-facing status projection. Verifies auth.uid() and the target '
  'ownership and exposes no lease token, no lease expiry, no cursor, no '
  'remaining ids and no provider error text.';
COMMENT ON FUNCTION public.enqueue_instagram_collection_jobs_service(uuid, jsonb) IS
  'Service / admin enqueue for the cron and admin boundaries. The owner is '
  'an argument that is verified against the target row, and the batch is '
  'bounded at 50 requests.';
COMMENT ON FUNCTION public.claim_instagram_collection_jobs(text, integer) IS
  'Atomically claims due work with SKIP LOCKED, at most 25 owner jobs and '
  '50 competitor jobs per call. A reserved share of the slots goes to fresh '
  'work so an old persistent failure cannot occupy every tick.';
COMMENT ON FUNCTION public.attach_instagram_collection_job_viewer_context(uuid, uuid, bigint, uuid) IS
  'Binds the owned viewer account and its credential generation to a '
  'competitor job before the provider call. A missing or unusable viewer is '
  'a typed refusal, never a silent completion.';
COMMENT ON FUNCTION public.record_instagram_collection_job_progress(uuid, uuid, bigint, jsonb) IS
  'Records operation failures with their retry time, registers pending '
  'operations and stores the media inventory checkpoint. Never resets a '
  'finished operation.';
COMMENT ON FUNCTION public.persist_instagram_collection_snapshot(uuid, uuid, bigint, jsonb) IS
  'Fenced snapshot write. The claim token, the lease, the job generation, '
  'the live credential generation and the target ownership are all checked '
  'before the first row is touched, in the same transaction as the write.';
COMMENT ON FUNCTION public.complete_instagram_collection_job(uuid, uuid, bigint, text, text) IS
  'Completes a claimed job. A full success is refused unless every '
  'operation of the current generation finished, the connection context is '
  'bound, and the media inventory is neither truncated nor uncovered.';
COMMENT ON FUNCTION public.record_instagram_provider_throttle(text, integer, timestamptz, uuid, uuid, bigint) IS
  'Records the shared provider throttle bucket and, when a job is named, '
  'puts that job into a fenced retry with the provider backoff.';
COMMENT ON FUNCTION public.read_instagram_collection_job_context(uuid, uuid) IS
  'Returns the checkpoint surface of a claimed job for a worker that needs '
  'the current generation state again.';

COMMIT;
