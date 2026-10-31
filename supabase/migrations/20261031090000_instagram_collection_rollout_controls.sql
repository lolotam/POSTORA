-- ===========================================================================
-- 20261031090000_instagram_collection_rollout_controls.sql
--
-- R1 - the rollout admission authority for Instagram collection.
--
-- Plan:  docs/plans/2026-10-30-instagram-collection-rollout-controls.md
-- Spec:  docs/specs/2026-10-30-instagram-collection-rollout-controls.md
--
-- APPLY AS supabase_admin. It owns the functions below; postgres is not a
-- superuser on this stack and a REVOKE by a non-owner is a WARNING that
-- changes nothing.
--
-- ===========================================================================
--
-- WHAT THIS IS
--
--   The gate that decides WHICH Instagram accounts may be collected for,
--   independent of the global credential mode, the OAuth pilot list and the
--   master kill switch.
--
--   One private `app_settings` key, `collection_instagram_rollout_policy`,
--   holds the populations that are approved. SQL owns the decision: the
--   enqueue, every claim pass, the viewer attachment, the common write
--   fence and the provider permit all ask the SAME evaluator, so a policy
--   that excludes an account excludes it everywhere. TypeScript consumes the
--   typed decisions; it never decides membership from a copied array.
--
--   This migration is additive. It changes no existing table, no existing
--   function signature, no global credential mode, no OAuth pilot list and
--   no token storage. It replaces the bodies of the collection routines
--   whose behaviour the rollout requires, and it adds one new service RPC.
--
-- WHAT THIS IS NOT
--
--   * Not an activation. The default policy admits nobody, the master
--     switch is still the first kill switch, and no schedule is created.
--   * Not a credential store. It reads the frozen capability relation and
--     the existing fenced job; it never writes a credential.
--   * Not a second policy system. The master kill switch stays exactly
--     where it is, and a missing or malformed configuration fails closed.
--
-- THE POLICY
--
--   {
--     "version": 1,
--     "owners":      { "mode": "off", "account_ids": [] },
--     "competitors": { "mode": "off", "targets": [] }
--   }
--
--   * `owners.account_ids` are internal `social_accounts.id` UUIDs. Never
--     provider ids, never usernames, never user UUIDs.
--   * `competitors.targets` entries are exactly
--     `{ "watchlist_id": "<uuid>", "viewer_social_account_id": "<uuid>" }`:
--     one owned watchlist and the ONE viewer approved for it.
--   * Each mode is exactly `off | allowlist | all`.
--   * `off` admits nobody. A list may be retained for rollback bookkeeping,
--     but it confers no access and is not read as one.
--   * `allowlist` admits exactly the listed ids. An empty allowlist admits
--     nobody.
--   * `all` admits every otherwise eligible owned target of that kind,
--     including future ones. Its list must be EMPTY, so a pin can never be
--     ambiguous.
--   * Both lists are capped at 500 entries. UUIDs are validated and
--     canonicalized, duplicates are rejected, unknown keys are rejected and
--     a malformed section invalidates the WHOLE policy.
--
--   There is no "empty means all" and no "missing viewer means choose
--   anyone". Owner eligibility never grants competitor eligibility and a
--   viewer permission never grants owner-insights collection for that
--   viewer.
--
-- THE DECISION
--
--   The effective permission is the intersection of
--
--     1. the master kill switch `collection_instagram_insights_enabled`,
--     2. a valid policy membership, and
--     3. the live target / credential eligibility the existing fences
--        already prove.
--
--   The master switch is read FIRST and ALONE. A master that is missing or
--   false refuses before any rollout, job or credential schema is touched.
--   A master that is malformed or unreadable refuses with
--   `settings_unavailable` - never with "off, so everything is fine" and
--   never with "all".
--
--   A MISSING policy means off: nobody is admitted. A MALFORMED or
--   UNREADABLE policy means the configuration is unavailable, which is a
--   different refusal with a different meaning. The two are never
--   confused, because confusing them is how a broken configuration turns
--   into a silent no-op - or into an open door.
--
-- THE REASON CODES
--
--   collection_disabled      the master switch is missing or false
--   settings_unavailable     the master or the policy cannot be read, or
--                            the policy is malformed
--   collection_not_eligible  the target (or the viewer) is not admitted
--   collection_queue_empty   audit only: the claim found no due work at
--                            all, which is not the same as an exclusion
--
--   A refusal is a refusal. It never marks a target unavailable, never
--   revokes a credential, never advances a success timestamp and never
--   consumes the 15 minute force throttle window.
--
-- THE AUDIT
--
--   A normal refusal RETURNS, and its `system_logs` row is written in the
--   same transaction, so the row and the refusal commit together.
--
--   An exception-path refusal ROLLS BACK, and a log written before the
--   raise would roll back with it. The Edge adapter audits those in a
--   separate bounded call after the rollback. This migration never writes a
--   log row it then throws away, and never reports a row that did not
--   commit.
--
--   The rows are bounded and sanitized: an event, a reason code, the
--   owned target and job ids and small counts. No policy list, no token,
--   no header, no provider URL, no claim token and no provider payload.
--   A broad scan writes ONE aggregate row per invocation, not one row per
--   excluded job.
--
-- THE PERMIT
--
--   `authorize_instagram_collection_provider_call(job, token, generation)`
--   is the per-request gate. It derives the scope from the LIVE fenced
--   job, checks the current policy and the captured credential generation,
--   and returns either
--
--     { "allowed": true, "job_id", "target_kind", "target_id",
--       "viewer_social_account_id", "job_generation",
--       "credential_generation", "policy_fingerprint" }
--
--   or
--
--     { "allowed": false, "reason_code": "..." }
--
--   and nothing else. It never returns a token, and the fingerprint is
--   audit evidence, never a reusable authorization token.
--
--   The AUTHORIZATION INSTANT is the last permit immediately preceding a
--   provider request. A policy change observed BEFORE that instant
--   produces zero requests. A change observed AFTER it may leave one
--   already-authorized request per active transport in flight, and that
--   request's result can no longer persist, because every write goes
--   through the same fence. There is no physical cancellation of an HTTP
--   call that was already sent, and this migration does not pretend
--   otherwise.
--
-- THE LOCK ORDER (do not invert this)
--
--   The existing order is unchanged:
--
--     1. social_accounts FOR UPDATE, id order,
--     2. the social_account_guard advisory, then the instagram_capability
--        advisory,
--     3. competitor_watchlist FOR UPDATE, when the job has one,
--     4. instagram_collection_jobs FOR UPDATE.
--
--   The policy is READ, never locked. The evaluator takes no row lock on
--   `app_settings`, so a policy writer can never introduce a
--   settings -> account inversion against this order. A plain SELECT does
--   not block on a row lock, so reading the policy while holding the
--   account locks cannot deadlock against a concurrent policy UPDATE.
--
--   The candidate queries of the claim read the policy ONCE, before their
--   candidate scans, and carry the approved ids as a parameter. The
--   eligibility is rechecked under the parent -> job locks in
--   `ig_collection_try_claim_job`, which is the authority.
--
-- ===========================================================================

BEGIN;

-- ===========================================================================
-- 1. The policy setting.
--
-- Inserted only when it is absent. An operator's value is never
-- overwritten by a migration.
-- ===========================================================================

INSERT INTO public.app_settings (key, value, description)
VALUES (
  'collection_instagram_rollout_policy',
  '{"version":1,"owners":{"mode":"off","account_ids":[]},"competitors":{"mode":"off","targets":[]}}'::jsonb,
  'Instagram collection rollout admission policy. Private: admins and the service role only. Owner entries are internal social_accounts.id values; a competitor entry pins one watchlist to exactly one approved viewer. Missing means off; malformed means the configuration is unavailable.'
)
ON CONFLICT (key) DO NOTHING;

-- The description of the row carries the contract. A COMMENT ON COLUMN
-- would apply to the column, not to this one key, so it is not used here.

-- ===========================================================================
-- 2. The policy is private.
--
-- The existing policies already keep an ordinary client away from this key
-- (it is not in the public read list and it is not `feature_`-prefixed),
-- but that is a LIST, not a boundary: one more entry in that list would
-- publish the policy. These RESTRICTIVE policies make the boundary
-- structural, so the row stays unreadable to anon and to an ordinary
-- authenticated session whatever the permissive policies say.
--
-- The admin escape is deliberate: an admin IS the trusted configuration
-- path the spec names, and the admin surface must keep working. The
-- service role bypasses RLS entirely.
-- ===========================================================================

DROP POLICY IF EXISTS app_settings_rollout_policy_private ON public.app_settings;

CREATE POLICY app_settings_rollout_policy_private
ON public.app_settings
AS RESTRICTIVE
FOR ALL
TO anon, authenticated
USING (
  key <> 'collection_instagram_rollout_policy'
  OR public.has_role(auth.uid(), 'admin')
)
WITH CHECK (
  key <> 'collection_instagram_rollout_policy'
  OR public.has_role(auth.uid(), 'admin')
);

-- ===========================================================================
-- 3. The canonical policy reader.
--
-- The fingerprint is computed by the DATABASE. A caller may not supply
-- one, and one that a caller does supply is never read.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.ig_collection_rollout_policy_fingerprint(
  p_policy jsonb
)
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $function$
  -- jsonb is already canonical: object keys are sorted and duplicate keys
  -- are impossible, so the text form is a stable serialization of the
  -- document. sha256() is a builtin, so the fingerprint does not depend on
  -- an extension being installed in a particular schema.
  SELECT encode(sha256(convert_to(COALESCE(p_policy, '{}'::jsonb)::text, 'utf8')), 'hex');
$function$;

COMMENT ON FUNCTION public.ig_collection_rollout_policy_fingerprint(jsonb) IS
  'Server-computed sha256 fingerprint of a canonical rollout policy '
  'document. Audit evidence only: it is never an authorization token and a '
  'caller may not supply one.';

-- ===========================================================================
-- 4. The strict policy normalizer.
--
-- One document in, one normalized document out, or a refusal. The refusal
-- marker is IG_ROLLOUT_POLICY_INVALID, and it invalidates the WHOLE
-- policy: a malformed section is not a partially valid policy.
--
-- The function is IMMUTABLE and reads no table, so the same document
-- always produces the same answer.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.ig_collection_rollout_normalize_policy(
  p_policy jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_top_keys     text[];
  v_owner_keys   text[];
  v_comp_keys    text[];
  v_entry_keys   text[];
  v_owner_mode   text;
  v_comp_mode    text;
  v_owner_ids    uuid[] := ARRAY[]::uuid[];
  v_seen         uuid[] := ARRAY[]::uuid[];
  v_comp_seen    uuid[] := ARRAY[]::uuid[];
  v_comp_targets jsonb := '[]'::jsonb;
  v_comp_pins    jsonb := '{}'::jsonb;
  v_item         jsonb;
  v_uuid         uuid;
  v_watchlist    uuid;
  v_viewer       uuid;
BEGIN
  IF p_policy IS NULL OR jsonb_typeof(p_policy) <> 'object' THEN
    RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: the policy must be a JSON object';
  END IF;

  SELECT array_agg(k ORDER BY k) INTO v_top_keys
    FROM jsonb_object_keys(p_policy) AS k;

  IF v_top_keys IS DISTINCT FROM ARRAY['competitors', 'owners', 'version'] THEN
    RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: the policy carries exactly version, owners and competitors';
  END IF;

  -- Nested IFs, never one OR of a cast: SQL does not promise short-circuit
  -- evaluation, so a cast inside an OR may raise the wrong error.
  IF jsonb_typeof(p_policy -> 'version') <> 'number' THEN
    RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: the policy version must be a number';
  END IF;

  IF (p_policy ->> 'version')::numeric <> 1 THEN
    RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: the policy version must be 1';
  END IF;

  -- --- owners ------------------------------------------------------------
  IF jsonb_typeof(p_policy -> 'owners') <> 'object' THEN
    RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: the owners section must be an object';
  END IF;

  SELECT array_agg(k ORDER BY k) INTO v_owner_keys
    FROM jsonb_object_keys(p_policy -> 'owners') AS k;

  IF v_owner_keys IS DISTINCT FROM ARRAY['account_ids', 'mode'] THEN
    RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: the owners section carries exactly mode and account_ids';
  END IF;

  v_owner_mode := p_policy -> 'owners' ->> 'mode';

  IF v_owner_mode IS NULL OR v_owner_mode NOT IN ('off', 'allowlist', 'all') THEN
    RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: the owners mode must be off, allowlist or all';
  END IF;

  IF jsonb_typeof(p_policy -> 'owners' -> 'account_ids') <> 'array' THEN
    RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: the owners account_ids must be an array';
  END IF;

  IF jsonb_array_length(p_policy -> 'owners' -> 'account_ids') > 500 THEN
    RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: the owners list holds more than 500 entries';
  END IF;

  IF v_owner_mode = 'all'
     AND jsonb_array_length(p_policy -> 'owners' -> 'account_ids') > 0 THEN
    RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: the owners list must be empty in the all mode';
  END IF;

  FOR v_item IN
    SELECT t.value FROM jsonb_array_elements(p_policy -> 'owners' -> 'account_ids') AS t(value)
  LOOP
    IF jsonb_typeof(v_item) <> 'string' THEN
      RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: an owners entry must be a UUID string';
    END IF;

    BEGIN
      v_uuid := (v_item #>> '{}')::uuid;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: an owners entry is not a UUID';
    END;

    IF v_uuid = ANY(v_seen) THEN
      RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: the owners list holds a duplicate entry';
    END IF;

    v_seen := v_seen || v_uuid;
    v_owner_ids := v_owner_ids || v_uuid;
  END LOOP;

  -- --- competitors -------------------------------------------------------
  IF jsonb_typeof(p_policy -> 'competitors') <> 'object' THEN
    RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: the competitors section must be an object';
  END IF;

  SELECT array_agg(k ORDER BY k) INTO v_comp_keys
    FROM jsonb_object_keys(p_policy -> 'competitors') AS k;

  IF v_comp_keys IS DISTINCT FROM ARRAY['mode', 'targets'] THEN
    RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: the competitors section carries exactly mode and targets';
  END IF;

  v_comp_mode := p_policy -> 'competitors' ->> 'mode';

  IF v_comp_mode IS NULL OR v_comp_mode NOT IN ('off', 'allowlist', 'all') THEN
    RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: the competitors mode must be off, allowlist or all';
  END IF;

  IF jsonb_typeof(p_policy -> 'competitors' -> 'targets') <> 'array' THEN
    RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: the competitors targets must be an array';
  END IF;

  IF jsonb_array_length(p_policy -> 'competitors' -> 'targets') > 500 THEN
    RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: the competitors list holds more than 500 entries';
  END IF;

  IF v_comp_mode = 'all'
     AND jsonb_array_length(p_policy -> 'competitors' -> 'targets') > 0 THEN
    RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: the competitors list must be empty in the all mode';
  END IF;

  FOR v_item IN
    SELECT t.value FROM jsonb_array_elements(p_policy -> 'competitors' -> 'targets') AS t(value)
  LOOP
    IF jsonb_typeof(v_item) <> 'object' THEN
      RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: a competitors entry must be an object';
    END IF;

    SELECT array_agg(k ORDER BY k) INTO v_entry_keys
      FROM jsonb_object_keys(v_item) AS k;

    IF v_entry_keys IS DISTINCT FROM ARRAY['viewer_social_account_id', 'watchlist_id'] THEN
      RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: a competitors entry carries exactly watchlist_id and viewer_social_account_id';
    END IF;

    IF jsonb_typeof(v_item -> 'watchlist_id') <> 'string'
       OR jsonb_typeof(v_item -> 'viewer_social_account_id') <> 'string' THEN
      RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: a competitors entry carries two UUID strings';
    END IF;

    BEGIN
      v_watchlist := (v_item ->> 'watchlist_id')::uuid;
      v_viewer    := (v_item ->> 'viewer_social_account_id')::uuid;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: a competitors entry holds a malformed UUID';
    END;

    -- One watchlist, ONE viewer. A second entry for the same watchlist is
    -- an ambiguous pin, and an ambiguous pin is refused, never resolved.
    IF v_watchlist = ANY(v_comp_seen) THEN
      RAISE EXCEPTION 'IG_ROLLOUT_POLICY_INVALID: the competitors list holds a duplicate watchlist';
    END IF;

    v_comp_seen := v_comp_seen || v_watchlist;

    v_comp_targets := v_comp_targets || jsonb_build_array(jsonb_build_object(
      'watchlist_id', v_watchlist::text,
      'viewer_social_account_id', v_viewer::text
    ));

    v_comp_pins := v_comp_pins || jsonb_build_object(v_watchlist::text, v_viewer::text);
  END LOOP;

  RETURN jsonb_build_object(
    'owner_mode', v_owner_mode,
    'owner_ids', to_jsonb(v_owner_ids),
    'competitor_mode', v_comp_mode,
    'competitor_targets', v_comp_targets,
    'competitor_pins', v_comp_pins
  );
END;
$function$;

COMMENT ON FUNCTION public.ig_collection_rollout_normalize_policy(jsonb) IS
  'Strict reader of the rollout policy document. Returns the normalized '
  'populations, or raises IG_ROLLOUT_POLICY_INVALID, which invalidates the '
  'whole policy. Duplicate ids, unknown keys, wrong types, a non-empty list '
  'in the all mode and more than 500 entries are all invalid.';

-- ===========================================================================
-- 5. The state reader.
--
-- ONE read of the master switch and ONE read of the policy, per call. The
-- result carries everything the callers need, so no caller ever reads the
-- settings table on its own and no caller can disagree with another about
-- what the policy says.
--
-- The status is one of
--
--   ok                    the policy is valid, decide per target
--   collection_disabled   the master switch is missing or false
--   settings_unavailable  the master or the policy is unreadable or
--                         malformed
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.ig_collection_rollout_state()
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_master        jsonb := NULL;
  v_master_found  boolean := false;
  v_master_failed boolean := false;
  v_policy        jsonb := NULL;
  v_policy_found  boolean := false;
  v_policy_failed boolean := false;
  v_status        text := 'ok';
  v_reason        text := NULL;
  v_norm          jsonb;
  v_owner_mode    text := 'off';
  v_comp_mode     text := 'off';
  v_owner_ids     uuid[] := ARRAY[]::uuid[];
  v_comp_ids      uuid[] := ARRAY[]::uuid[];
  v_comp_pins     jsonb := '{}'::jsonb;
  v_fingerprint   text := NULL;
  v_default       jsonb := '{"version":1,"owners":{"mode":"off","account_ids":[]},"competitors":{"mode":"off","targets":[]}}'::jsonb;
BEGIN
  -- --- the master kill switch, read first and alone ----------------------
  BEGIN
    SELECT s.value INTO v_master
      FROM public.app_settings AS s
     WHERE s.key = 'collection_instagram_insights_enabled';
    v_master_found := FOUND;
  EXCEPTION WHEN others THEN
    v_master_failed := true;
  END;

  IF v_master_failed
     OR (v_master_found AND jsonb_typeof(v_master) <> 'boolean') THEN
    v_status := 'settings_unavailable';
    v_reason := 'settings_unavailable';
  ELSIF NOT v_master_found OR v_master <> 'true'::jsonb THEN
    v_status := 'collection_disabled';
    v_reason := 'collection_disabled';
  END IF;

  -- --- the policy --------------------------------------------------------
  IF v_status = 'ok' THEN
    BEGIN
      SELECT s.value INTO v_policy
        FROM public.app_settings AS s
       WHERE s.key = 'collection_instagram_rollout_policy';
      v_policy_found := FOUND;
    EXCEPTION WHEN others THEN
      v_policy_failed := true;
    END;

    IF v_policy_failed THEN
      v_status := 'settings_unavailable';
      v_reason := 'settings_unavailable';
    ELSIF NOT v_policy_found THEN
      -- A MISSING policy means off. The effective policy is the default
      -- document, so nobody is admitted - and the fingerprint still
      -- identifies the effective configuration.
      v_policy := v_default;
    END IF;
  END IF;

  IF v_status = 'ok' THEN
    BEGIN
      v_norm := public.ig_collection_rollout_normalize_policy(v_policy);
    EXCEPTION WHEN others THEN
      IF SQLERRM NOT LIKE 'IG_ROLLOUT_POLICY_INVALID%' THEN
        RAISE;
      END IF;

      v_status := 'settings_unavailable';
      v_reason := 'settings_unavailable';
      v_norm := NULL;
    END;
  END IF;

  IF v_status = 'ok' THEN
    v_fingerprint := public.ig_collection_rollout_policy_fingerprint(v_policy);

    v_owner_mode := v_norm ->> 'owner_mode';
    v_comp_mode  := v_norm ->> 'competitor_mode';

    IF v_owner_mode = 'allowlist' THEN
      v_owner_ids := ARRAY(
        SELECT (jsonb_array_elements_text(v_norm -> 'owner_ids'))::uuid
      );
    END IF;

    IF v_comp_mode = 'allowlist' THEN
      SELECT ARRAY_AGG((t.entry ->> 'watchlist_id')::uuid)
        INTO v_comp_ids
        FROM jsonb_array_elements(v_norm -> 'competitor_targets') AS t(entry);

      v_comp_pins := v_norm -> 'competitor_pins';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'status', v_status,
    'reason_code', v_reason,
    'fingerprint', v_fingerprint,
    'owner_mode', v_owner_mode,
    'owner_ids', to_jsonb(v_owner_ids),
    'competitor_mode', v_comp_mode,
    'competitor_ids', to_jsonb(v_comp_ids),
    'competitor_pins', v_comp_pins
  );
END;
$function$;

COMMENT ON FUNCTION public.ig_collection_rollout_state() IS
  'Reads the master kill switch and the rollout policy exactly once and '
  'returns the effective admission state: the status, the reason code, the '
  'policy fingerprint and the approved populations. A missing master refuses '
  'with collection_disabled, an unreadable or malformed configuration '
  'refuses with settings_unavailable, and a missing policy means off.';

-- ===========================================================================
-- 6. The evaluator.
--
-- One question, one answer: may this owner collect for this target, with
-- this viewer?
--
-- The ownership is checked HERE, structurally, on every use: the target
-- must belong to the owner, and in allowlist mode the pinned viewer must
-- belong to the owner as well. A readable id is not authority.
--
-- A null viewer asks the weaker question - "is this target admitted at
-- all?" - which is what a job asks before it has a viewer bound.
--
-- The two target kinds are decided by their own helpers, so neither of
-- them carries the other's branches.
-- ===========================================================================

-- The owner population. The target is an internal social_accounts.id and
-- it must belong to the owner.
CREATE OR REPLACE FUNCTION public.ig_collection_rollout_owner_allowed(
  p_user_id   uuid,
  p_target_id uuid,
  p_state     jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_mode text;
  v_ids  uuid[];
BEGIN
  v_mode := p_state ->> 'owner_mode';

  IF v_mode = 'off' THEN
    RETURN jsonb_build_object('allowed', false, 'reason_code', 'collection_not_eligible',
                              'fingerprint', p_state ->> 'fingerprint');
  END IF;

  IF v_mode = 'allowlist' THEN
    v_ids := ARRAY(
      SELECT (jsonb_array_elements_text(p_state -> 'owner_ids'))::uuid
    );

    IF NOT (p_target_id = ANY(v_ids)) THEN
      RETURN jsonb_build_object('allowed', false, 'reason_code', 'collection_not_eligible',
                                'fingerprint', p_state ->> 'fingerprint');
    END IF;
  END IF;

  -- The target must belong to the owner. Structurally, every time.
  IF NOT EXISTS (
    SELECT 1
      FROM public.social_accounts AS sa
     WHERE sa.id = p_target_id
       AND sa.user_id = p_user_id
       AND sa.platform = 'instagram'
  ) THEN
    RETURN jsonb_build_object('allowed', false, 'reason_code', 'collection_not_eligible',
                              'fingerprint', p_state ->> 'fingerprint');
  END IF;

  RETURN jsonb_build_object('allowed', true, 'reason_code', NULL,
                            'fingerprint', p_state ->> 'fingerprint');
END;
$function$;

-- The competitor population. The target is an owned watchlist and, in
-- allowlist mode, it has exactly ONE approved viewer.
CREATE OR REPLACE FUNCTION public.ig_collection_rollout_competitor_allowed(
  p_user_id                  uuid,
  p_target_id                uuid,
  p_viewer_social_account_id uuid,
  p_state                    jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_mode   text;
  v_ids    uuid[];
  v_pins   jsonb;
  v_pinned text;
BEGIN
  v_mode := p_state ->> 'competitor_mode';

  IF v_mode = 'off' THEN
    RETURN jsonb_build_object('allowed', false, 'reason_code', 'collection_not_eligible',
                              'fingerprint', p_state ->> 'fingerprint');
  END IF;

  IF v_mode = 'allowlist' THEN
    v_ids := ARRAY(
      SELECT (jsonb_array_elements_text(p_state -> 'competitor_ids'))::uuid
    );

    IF NOT (p_target_id = ANY(v_ids)) THEN
      RETURN jsonb_build_object('allowed', false, 'reason_code', 'collection_not_eligible',
                                'fingerprint', p_state ->> 'fingerprint');
    END IF;

    -- The pin. There is exactly one approved viewer for this watchlist
    -- and no substitution is ever possible.
    v_pins := p_state -> 'competitor_pins';
    v_pinned := v_pins ->> p_target_id::text;

    IF v_pinned IS NULL THEN
      RETURN jsonb_build_object('allowed', false, 'reason_code', 'collection_not_eligible',
                                'fingerprint', p_state ->> 'fingerprint');
    END IF;

    IF p_viewer_social_account_id IS NOT NULL
       AND p_viewer_social_account_id::text <> v_pinned THEN
      RETURN jsonb_build_object('allowed', false, 'reason_code', 'collection_not_eligible',
                                'fingerprint', p_state ->> 'fingerprint');
    END IF;

    -- The pinned viewer must belong to the SAME owner as the watchlist.
    IF NOT EXISTS (
      SELECT 1
        FROM public.social_accounts AS sa
       WHERE sa.id = v_pinned::uuid
         AND sa.user_id = p_user_id
         AND sa.platform = 'instagram'
    ) THEN
      RETURN jsonb_build_object('allowed', false, 'reason_code', 'collection_not_eligible',
                                'fingerprint', p_state ->> 'fingerprint');
    END IF;
  END IF;

  -- The watchlist must belong to the owner.
  IF NOT EXISTS (
    SELECT 1
      FROM public.competitor_watchlist AS cw
     WHERE cw.id = p_target_id
       AND cw.user_id = p_user_id
       AND cw.platform = 'instagram'
  ) THEN
    RETURN jsonb_build_object('allowed', false, 'reason_code', 'collection_not_eligible',
                              'fingerprint', p_state ->> 'fingerprint');
  END IF;

  RETURN jsonb_build_object('allowed', true, 'reason_code', NULL,
                            'fingerprint', p_state ->> 'fingerprint');
END;
$function$;

CREATE OR REPLACE FUNCTION public.ig_collection_rollout_target_allowed(
  p_user_id                 uuid,
  p_target_kind             text,
  p_target_id               uuid,
  p_viewer_social_account_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_state  jsonb;
  v_status text;
BEGIN
  IF p_user_id IS NULL OR p_target_id IS NULL OR p_target_kind IS NULL THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason_code', 'collection_not_eligible',
      'fingerprint', NULL);
  END IF;

  v_state := public.ig_collection_rollout_state();
  v_status := v_state ->> 'status';

  IF v_status <> 'ok' THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason_code', v_state ->> 'reason_code',
      'fingerprint', v_state ->> 'fingerprint');
  END IF;

  IF p_target_kind = 'owner' THEN
    RETURN public.ig_collection_rollout_owner_allowed(p_user_id, p_target_id, v_state);
  ELSIF p_target_kind = 'competitor' THEN
    RETURN public.ig_collection_rollout_competitor_allowed(
      p_user_id, p_target_id, p_viewer_social_account_id, v_state);
  END IF;

  -- An unknown target kind is never admitted.
  RETURN jsonb_build_object('allowed', false, 'reason_code', 'collection_not_eligible',
                            'fingerprint', v_state ->> 'fingerprint');
END;
$function$;

COMMENT ON FUNCTION public.ig_collection_rollout_target_allowed(uuid, text, uuid, uuid) IS
  'The canonical rollout decision for one target and one viewer. The owner '
  'and the target are checked structurally on every use, the policy '
  'membership is checked against the effective populations, and a pinned '
  'competitor viewer may never be substituted. Returns the decision, the '
  'reason code and the policy fingerprint.';

-- ===========================================================================
-- 7. The audit writer.
--
-- One bounded, sanitized row. It never carries a policy list, a token, a
-- header, a provider URL, a claim token or a provider payload.
--
-- The event is ONE document, not seven arguments: the row is the contract
-- and the document keeps the call sites readable.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.ig_collection_rollout_audit(p_event jsonb)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  INSERT INTO public.system_logs (source, category, level, message, user_id, metadata)
  VALUES (
    'instagram-collection-rollout',
    'database',
    'warn',
    'Instagram collection rollout refusal',
    (p_event ->> 'user_id')::uuid,
    jsonb_build_object(
      'event', left(COALESCE(p_event ->> 'event', 'unknown'), 64),
      'reason_code', left(COALESCE(p_event ->> 'reason_code', 'unknown'), 64),
      'job_id', p_event -> 'job_id',
      'target_kind', left(COALESCE(p_event ->> 'target_kind', ''), 16),
      'target_id', p_event -> 'target_id',
      'details', COALESCE(p_event -> 'details', '{}'::jsonb)
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.ig_collection_rollout_audit(jsonb) IS
  'Writes one bounded, sanitized refusal row to system_logs. Used by the '
  'normal refusal paths, whose row commits with the refusal itself. The '
  'exception paths are audited by the Edge adapter after the rollback, '
  'because a row written before a raise does not survive it.';

-- ===========================================================================
-- 8. The common fence, amended.
--
-- The fence is the single place every result-bearing write passes through:
-- progress, snapshots, completion, provider-throttle parking, the direct
-- credential read, the competitor v1 and v2 result writes and the viewer
-- attachment. Adding the rollout decision HERE is what makes the exclusion
-- impossible to bypass by calling a different routine.
--
-- The decision is made AFTER the target is known to be active and owned,
-- so a deactivated or foreign target keeps its own, more specific refusal.
--
-- A refusal here RAISES. The row it would have written does not commit, so
-- this path never writes an audit row: the Edge adapter audits it after
-- the rollback. Rolling refusal never marks a target unavailable, never
-- revokes a credential and never advances a success.
-- ===========================================================================

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
  v_allowed jsonb;
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

      -- The rollout decision. The BOUND viewer is checked against the
      -- policy pin; the viewer an attachment is about to bind is checked
      -- by the attachment itself, which can name the exact refusal.
      v_allowed := public.ig_collection_rollout_target_allowed(
        v_job.user_id,
        v_job.target_kind,
        v_job.target_id,
        v_job.context_viewer_social_account_id);

      IF NOT COALESCE((v_allowed ->> 'allowed')::boolean, false) THEN
        IF v_allowed ->> 'reason_code' = 'settings_unavailable' THEN
          RAISE EXCEPTION
            'IG_COLLECTION_SETTINGS_UNAVAILABLE: the rollout configuration cannot be read'
            USING ERRCODE = '55000';
        ELSIF v_allowed ->> 'reason_code' = 'collection_disabled' THEN
          RAISE EXCEPTION
            'IG_COLLECTION_DISABLED: Instagram collection is disabled'
            USING ERRCODE = '22023';
        END IF;

        RAISE EXCEPTION
          'IG_COLLECTION_NOT_ELIGIBLE: the target is not admitted by the rollout policy'
          USING ERRCODE = '22023';
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

COMMENT ON FUNCTION public.ig_collection_load_fenced_job(uuid, uuid, bigint, boolean, uuid) IS
  'The common write and context fence. It locks the parents in the '
  'established order, checks the claim, the lease, the generation, the '
  'target and the bound connection context, AND the rollout admission of '
  'the target and of the bound viewer. A currently excluded target cannot '
  'be written, parked, completed or read.';

-- ===========================================================================
-- 9. The locked claim, amended.
--
-- The candidate queries of the claim are a FILTER; this is the AUTHORITY.
-- The eligibility is rechecked here, under the parent -> job locks, so a
-- candidate that was admitted a moment ago and excluded a moment later is
-- refused here rather than claimed.
--
-- The check runs after the parents are locked and before the job row is
-- changed, so an excluded job keeps its attempts, its generation and its
-- timestamps exactly as they were.
-- ===========================================================================

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
  v_allowed jsonb;
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

    -- The rollout decision, under the locks. A refused candidate is skipped
    -- exactly like a busy parent: it is not claimed, and nothing about it
    -- changes.
    v_allowed := public.ig_collection_rollout_target_allowed(
      v_job.user_id,
      v_job.target_kind,
      v_job.target_id,
      v_job.context_viewer_social_account_id);

    IF NOT COALESCE((v_allowed ->> 'allowed')::boolean, false) THEN
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
-- 10. The owner enqueue, amended.
--
-- The eligibility is resolved BEFORE the throttle, the force and the
-- insert:
--
--   * a refused force consumes NO 15 minute window,
--   * a refused force does not bump a generation,
--   * a refused enqueue inserts nothing.
--
-- The refusal RETURNS, so its audit row commits with it.
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
  v_allowed     jsonb;
  v_reason      text;
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

  -- The owner is verified against the target row first. A foreign or
  -- missing target is indistinguishable from one that never existed.
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

  -- The rollout decision. It comes before the throttle, so a refusal
  -- never spends the accepted-request window.
  v_allowed := public.ig_collection_rollout_target_allowed(
    v_owner, p_target_kind, p_target_id, NULL);

  IF NOT COALESCE((v_allowed ->> 'allowed')::boolean, false) THEN
    v_reason := v_allowed ->> 'reason_code';

    PERFORM public.ig_collection_rollout_audit(jsonb_build_object(
      'event', 'collection_enqueue_refused',
      'reason_code', v_reason,
      'user_id', v_owner,
      'target_kind', p_target_kind,
      'target_id', p_target_id,
      'details', jsonb_build_object('actor', 'owner', 'mode', v_mode)));

    RETURN jsonb_build_object(
      'accepted', false,
      'refused', true,
      'reason_code', v_reason,
      'captured_on', v_captured_on
    );
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

COMMENT ON FUNCTION public.enqueue_instagram_collection_job(text, uuid, text) IS
  'Owner-facing enqueue. The owner comes from auth.uid(); the target must '
  'belong to that owner. The rollout admission is decided before the '
  'throttle, the force and the insert, so a refused force spends no '
  'accepted-request window and changes no generation. A refusal returns '
  '{accepted:false,refused:true,reason_code} and commits its audit row.';

-- ===========================================================================
-- 11. The service enqueue, amended.
--
-- Every element of the batch is decided on its own: (owner, target kind,
-- target id). A forged owner cannot obtain a usable job, because the
-- target must belong to that owner in the database, and an excluded target
-- is refused per element rather than aborting the batch.
--
-- The accepted count EXCLUDES the refused elements.
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
  v_refused    integer := 0;
  v_allowed    jsonb;
  v_reason     text;
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

    -- The rollout decision, per element and before the throttle.
    v_allowed := public.ig_collection_rollout_target_allowed(
      p_owner_id, v_kind, v_target_id, NULL);

    IF NOT COALESCE((v_allowed ->> 'allowed')::boolean, false) THEN
      v_reason := v_allowed ->> 'reason_code';
      v_refused := v_refused + 1;

      PERFORM public.ig_collection_rollout_audit(jsonb_build_object(
        'event', 'collection_enqueue_refused',
        'reason_code', v_reason,
        'user_id', p_owner_id,
        'target_kind', v_kind,
        'target_id', v_target_id,
        'details', jsonb_build_object('actor', 'service', 'mode', v_mode)));

      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'target_kind', v_kind,
        'target_id', v_target_id,
        'accepted', false,
        'refused', true,
        'reason_code', v_reason
      ));
      CONTINUE;
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
    'refused', v_refused,
    'results', v_results
  );
END;
$function$;

COMMENT ON FUNCTION public.enqueue_instagram_collection_jobs_service(uuid, jsonb) IS
  'Service / admin enqueue for the cron and admin boundaries. The owner is '
  'an argument that is verified against the target row, and the batch is '
  'bounded at 50 requests. Every element is decided against the rollout '
  'policy on its own: an excluded element is refused per element with '
  '{accepted:false,refused:true,reason_code} and is excluded from the '
  'accepted count.';

-- ===========================================================================
-- 12. The claim, amended.
--
-- The eligibility is applied to EVERY candidate query: the reserved fresh
-- share, the recovery discovery, the oldest open work and the
-- finalization pass. The filter is applied BEFORE the candidate limit, so
-- a pilot with one eligible account cannot be starved by the excluded jobs
-- in front of it.
--
-- The recheck under the parent -> job locks is in
-- `ig_collection_try_claim_job` and is the authority.
--
-- An empty claim is NOT silently empty: one bounded aggregate row records
-- whether the queue was empty or whether the candidates were excluded.
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
  v_state       jsonb;
  v_status      text;
  v_mode        text;
  v_restrict    boolean := false;
  v_allowed_ids uuid[] := ARRAY[]::uuid[];
  v_due_total   bigint := 0;
  v_excluded    bigint := 0;
BEGIN
  PERFORM public.ig_collection_assert_service_caller();

  IF p_target_kind IS NULL OR p_target_kind NOT IN ('owner', 'competitor') THEN
    RAISE EXCEPTION
      'IG_COLLECTION_INVALID_TARGET_KIND: target kind must be owner or competitor'
      USING ERRCODE = '22023';
  END IF;

  -- The rollout state, read ONCE. A configuration that cannot be read is a
  -- typed failure, never an empty set: an empty set would look like an
  -- empty queue.
  v_state := public.ig_collection_rollout_state();
  v_status := v_state ->> 'status';

  IF v_status = 'settings_unavailable' THEN
    RAISE EXCEPTION
      'IG_COLLECTION_SETTINGS_UNAVAILABLE: the rollout configuration cannot be read'
      USING ERRCODE = '55000';
  END IF;

  IF v_status = 'collection_disabled' THEN
    PERFORM public.ig_collection_rollout_audit(jsonb_build_object(
      'event', 'collection_claim_refused',
      'reason_code', 'collection_disabled',
      'target_kind', p_target_kind,
      'details', jsonb_build_object('action', 'claim', 'mode', p_target_kind)));
    RETURN;
  END IF;

  IF p_target_kind = 'owner' THEN
    v_mode := v_state ->> 'owner_mode';
    v_allowed_ids := ARRAY(
      SELECT (jsonb_array_elements_text(v_state -> 'owner_ids'))::uuid);
  ELSE
    v_mode := v_state ->> 'competitor_mode';
    v_allowed_ids := ARRAY(
      SELECT (jsonb_array_elements_text(v_state -> 'competitor_ids'))::uuid);
  END IF;

  -- `all` admits every otherwise eligible target of that kind, so it
  -- carries no id filter. `off` and `allowlist` carry one, and `off`'s
  -- list is empty, so `off` admits nobody.
  v_restrict := (v_mode <> 'all');

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
           AND (NOT v_restrict OR j.target_id = ANY(v_allowed_ids))
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
       AND (NOT v_restrict OR j.target_id = ANY(v_allowed_ids))
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
       AND (NOT v_restrict OR j.target_id = ANY(v_allowed_ids))
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
       AND (NOT v_restrict OR j.target_id = ANY(v_allowed_ids))
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

  -- An empty claim is not silently empty. One bounded aggregate row says
  -- whether the queue held no due work at all, or whether the due work was
  -- excluded by the policy. The counts are the distinction; there is never
  -- one row per excluded job.
  IF COALESCE(array_length(v_ids, 1), 0) = 0 THEN
    SELECT count(*),
           count(*) FILTER (
             WHERE v_restrict AND NOT (j.target_id = ANY(v_allowed_ids)))
      INTO v_due_total, v_excluded
      FROM public.instagram_collection_jobs AS j
     WHERE j.target_kind = p_target_kind
       AND j.status IN ('queued', 'retry', 'partial', 'leased')
       AND j.due_at <= now()
       AND (j.lease_token IS NULL OR j.lease_expires_at IS NULL
            OR j.lease_expires_at <= clock_timestamp());

    PERFORM public.ig_collection_rollout_audit(jsonb_build_object(
      'event', 'collection_claim_refused',
      'reason_code', CASE WHEN v_excluded > 0 THEN 'collection_not_eligible' ELSE 'collection_queue_empty' END,
      'target_kind', p_target_kind,
      'details', jsonb_build_object(
        'action', 'claim',
        'mode', p_target_kind,
        'due_candidates', v_due_total,
        'excluded_candidates', v_excluded)));
  END IF;

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

COMMENT ON FUNCTION public.claim_instagram_collection_jobs(text, integer) IS
  'Atomically claims due work with SKIP LOCKED, at most 25 owner jobs and '
  '50 competitor jobs per call. A reserved share of the slots goes to fresh '
  'work so an old persistent failure cannot occupy every tick. Every '
  'candidate pass applies the rollout admission BEFORE its candidate '
  'limit, so excluded work cannot starve an eligible job, and the '
  'admission is rechecked under the parent -> job locks before the claim.';

-- ===========================================================================
-- 13. The viewer attachment, amended.
--
-- The target admission is proved by the common fence. The PIN is proved
-- here, where the refusal can be exact: a viewer that is not the approved
-- one is refused, and there is no substitution path.
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
  v_allowed     jsonb;
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

  -- The rollout decision, with the viewer this call is about to bind. In
  -- allowlist mode only the pinned viewer is approved, and the pinned
  -- viewer must belong to this owner.
  v_allowed := public.ig_collection_rollout_target_allowed(
    v_job.user_id,
    v_job.target_kind,
    v_job.target_id,
    p_viewer_social_account_id);

  IF NOT COALESCE((v_allowed ->> 'allowed')::boolean, false) THEN
    IF v_allowed ->> 'reason_code' = 'settings_unavailable' THEN
      RAISE EXCEPTION
        'IG_COLLECTION_SETTINGS_UNAVAILABLE: the rollout configuration cannot be read'
        USING ERRCODE = '55000';
    ELSIF v_allowed ->> 'reason_code' = 'collection_disabled' THEN
      RAISE EXCEPTION
        'IG_COLLECTION_DISABLED: Instagram collection is disabled'
        USING ERRCODE = '22023';
    END IF;

    RAISE EXCEPTION
      'IG_COLLECTION_VIEWER_NOT_APPROVED: the rollout policy does not approve this viewer for this target'
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

COMMENT ON FUNCTION public.attach_instagram_collection_job_viewer_context(uuid, uuid, bigint, uuid) IS
  'Binds the owned viewer account and its credential generation to a '
  'competitor job before the provider call. The rollout policy is checked '
  'here: in allowlist mode only the pinned viewer is approved, and there '
  'is no substitution path. A missing or unusable viewer is a typed '
  'refusal, never a silent completion.';

-- ===========================================================================
-- 14. The job context read, amended.
--
-- A worker that re-reads the checkpoint surface of a claimed job must not
-- be told to keep working for a target the policy has since excluded.
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
  v_allowed jsonb;
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

  v_allowed := public.ig_collection_rollout_target_allowed(
    v_job.user_id,
    v_job.target_kind,
    v_job.target_id,
    v_job.context_viewer_social_account_id);

  IF NOT COALESCE((v_allowed ->> 'allowed')::boolean, false) THEN
    IF v_allowed ->> 'reason_code' = 'settings_unavailable' THEN
      RAISE EXCEPTION
        'IG_COLLECTION_SETTINGS_UNAVAILABLE: the rollout configuration cannot be read'
        USING ERRCODE = '55000';
    ELSIF v_allowed ->> 'reason_code' = 'collection_disabled' THEN
      RAISE EXCEPTION
        'IG_COLLECTION_DISABLED: Instagram collection is disabled'
        USING ERRCODE = '22023';
    END IF;

    RAISE EXCEPTION
      'IG_COLLECTION_NOT_ELIGIBLE: the target is not admitted by the rollout policy'
      USING ERRCODE = '22023';
  END IF;

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
-- 15. The provider permit.
--
-- The per-request gate. It derives the scope from the LIVE fenced job, so
-- the caller cannot name an owner, an account or a viewer. It returns the
-- exact union the contract names, and nothing else.
--
--   allowed : { allowed, job_id, target_kind, target_id,
--               viewer_social_account_id, job_generation,
--               credential_generation, policy_fingerprint }
--   refused : { allowed, reason_code }
--
-- A refusal is a RETURN, so its audit row commits with it.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.authorize_instagram_collection_provider_call(
  p_job_id         uuid,
  p_claim_token    uuid,
  p_job_generation bigint
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
DECLARE
  v_job     public.instagram_collection_jobs%ROWTYPE;
  v_allowed jsonb;
  v_reason  text;
BEGIN
  PERFORM public.ig_collection_assert_service_caller();

  IF p_job_id IS NULL OR p_claim_token IS NULL OR p_job_generation IS NULL THEN
    PERFORM public.ig_collection_rollout_audit(jsonb_build_object(
      'event', 'collection_provider_call_refused',
      'reason_code', 'invalid_request',
      'job_id', p_job_id,
      'details', jsonb_build_object('action', 'authorize_provider_call')));

    RETURN jsonb_build_object('allowed', false, 'reason_code', 'invalid_request');
  END IF;

  -- The fenced job. Every identity in the answer comes from it, and a
  -- caller that names nothing else cannot redirect it.
  BEGIN
    v_job := public.ig_collection_load_fenced_job(
      p_job_id, p_claim_token, p_job_generation, true, NULL);
  EXCEPTION WHEN others THEN
    -- A timeout, a deadlock or a lost connection is NOT a refusal: it is
    -- an operational failure and it must not be swallowed into a tidy
    -- "not allowed" answer.
    IF SQLSTATE IN ('57014', '40P01', '08006', '08003', '08001', '57P01', '57P02', '57P03') THEN
      RAISE;
    END IF;

    v_reason := CASE
      WHEN SQLERRM LIKE 'IG_COLLECTION_JOB_NOT_FOUND%'      THEN 'job_not_found'
      WHEN SQLERRM LIKE 'IG_COLLECTION_CLAIM_STALE%'         THEN 'claim_stale'
      WHEN SQLERRM LIKE 'IG_COLLECTION_CREDENTIAL_CHANGED%'  THEN 'credential_changed'
      WHEN SQLERRM LIKE 'IG_COLLECTION_TARGET_INACTIVE%'     THEN 'target_inactive'
      WHEN SQLERRM LIKE 'IG_COLLECTION_CONTEXT_MISSING%'     THEN 'context_missing'
      WHEN SQLERRM LIKE 'IG_COLLECTION_VIEWER_%'             THEN 'context_unusable'
      WHEN SQLERRM LIKE 'IG_COLLECTION_CAPABILITY_MISSING%'  THEN 'context_unusable'
      WHEN SQLERRM LIKE 'IG_COLLECTION_NOT_ELIGIBLE%'        THEN 'collection_not_eligible'
      WHEN SQLERRM LIKE 'IG_COLLECTION_DISABLED%'            THEN 'collection_disabled'
      WHEN SQLERRM LIKE 'IG_COLLECTION_SETTINGS_UNAVAILABLE%' THEN 'settings_unavailable'
      ELSE 'not_authorized'
    END;

    PERFORM public.ig_collection_rollout_audit(jsonb_build_object(
      'event', 'collection_provider_call_refused',
      'reason_code', v_reason,
      'job_id', p_job_id,
      'details', jsonb_build_object('action', 'authorize_provider_call')));

    RETURN jsonb_build_object('allowed', false, 'reason_code', v_reason);
  END;

  -- The current policy, once more, at the authorization instant. The
  -- fence already refused an excluded target; this call is what produces
  -- the fingerprint the permit carries, and it is the LAST decision
  -- before the request goes out.
  v_allowed := public.ig_collection_rollout_target_allowed(
    v_job.user_id,
    v_job.target_kind,
    v_job.target_id,
    v_job.context_viewer_social_account_id);

  IF NOT COALESCE((v_allowed ->> 'allowed')::boolean, false) THEN
    v_reason := v_allowed ->> 'reason_code';

    PERFORM public.ig_collection_rollout_audit(jsonb_build_object(
      'event', 'collection_provider_call_refused',
      'reason_code', v_reason,
      'user_id', v_job.user_id,
      'job_id', p_job_id,
      'target_kind', v_job.target_kind,
      'target_id', v_job.target_id,
      'details', jsonb_build_object('action', 'authorize_provider_call')));

    RETURN jsonb_build_object('allowed', false, 'reason_code', v_reason);
  END IF;

  RETURN jsonb_build_object(
    'allowed', true,
    'job_id', v_job.id,
    'target_kind', v_job.target_kind,
    'target_id', v_job.target_id,
    'viewer_social_account_id', v_job.context_viewer_social_account_id,
    'job_generation', v_job.job_generation,
    'credential_generation', v_job.context_credential_generation,
    'policy_fingerprint', v_allowed ->> 'fingerprint'
  );
END;
$function$;

COMMENT ON FUNCTION public.authorize_instagram_collection_provider_call(uuid, uuid, bigint) IS
  'Service-only. The per-request admission gate for Instagram collection. '
  'It derives every identity from the live fenced job, checks the current '
  'policy and the captured credential generation, and returns exactly '
  '{allowed:true, job_id, target_kind, target_id, '
  'viewer_social_account_id, job_generation, credential_generation, '
  'policy_fingerprint} or {allowed:false, reason_code}. It never returns a '
  'token, and the fingerprint is audit evidence, not a reusable '
  'authorization token.';

-- ===========================================================================
-- 16. The policy audit trigger.
--
-- A policy change is audited with the actor, the timestamp and the
-- server-computed fingerprint. A caller may not supply a fingerprint and
-- may not supply an eligibility boolean: the trigger computes the
-- fingerprint from the stored document.
--
-- The trigger does NOT rewrite and does NOT reject the operator's value.
-- The read-time validation is the authority, and a write path that this
-- migration cannot see must keep working.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.ig_collection_rollout_policy_audit_trigger()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  IF NEW.key = 'collection_instagram_rollout_policy' THEN
    INSERT INTO public.system_logs (source, category, level, message, user_id, metadata)
    VALUES (
      'instagram-collection-rollout',
      'database',
      'info',
      'Instagram collection rollout policy changed',
      COALESCE(auth.uid(), NEW.updated_by),
      jsonb_build_object(
        'event', 'rollout_policy_changed',
        'operation', lower(TG_OP),
        'policy_fingerprint', public.ig_collection_rollout_policy_fingerprint(NEW.value)
      )
    );
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS app_settings_rollout_policy_audit ON public.app_settings;

CREATE TRIGGER app_settings_rollout_policy_audit
AFTER INSERT OR UPDATE ON public.app_settings
FOR EACH ROW EXECUTE FUNCTION public.ig_collection_rollout_policy_audit_trigger();

-- ===========================================================================
-- 17. The grants.
--
-- Named EXPLICITLY. This stack carries ALTER DEFAULT PRIVILEGES ... GRANT
-- ALL ON FUNCTIONS TO anon, authenticated, so "REVOKE ... FROM PUBLIC"
-- alone leaves both browser roles holding EXECUTE.
--
-- The internal helpers are nobody's business: the definer's own functions
-- are the only callers, and they run as the definer.
--
-- The new service RPC is the service role's alone. An admin JWT may
-- invoke a privileged drain, but it may not bypass the policy - and it
-- cannot reach this function either, because the grant is the tighter of
-- the two layers.
-- ===========================================================================

REVOKE ALL ON FUNCTION public.ig_collection_rollout_policy_fingerprint(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_rollout_normalize_policy(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_rollout_state() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_rollout_target_allowed(uuid, text, uuid, uuid) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_rollout_owner_allowed(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_rollout_competitor_allowed(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_rollout_audit(jsonb) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.ig_collection_rollout_policy_audit_trigger() FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.authorize_instagram_collection_provider_call(uuid, uuid, bigint) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.authorize_instagram_collection_provider_call(uuid, uuid, bigint) TO service_role;

COMMIT;
