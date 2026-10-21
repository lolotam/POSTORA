-- MCP post actions: an atomic per-post claim with a lease, and the database
-- clock for the cancel and reschedule deadlines (issue #281).
--
-- WHY this exists. The agent tools that drive Postora from an MCP client run a
-- post action (a retry, a delete) on a row that another tool may be working on
-- at the same time. Two retries of the same post, or a retry and a delete of
-- the same post, must never both run. The edge function cannot make that safe
-- on its own: two edge invocations share no process and no lock, so a check
-- followed by a write is a check and a write, not one decision. The claim
-- therefore lives in the posts row and is taken by Postgres under a row lock
-- (SELECT ... FOR UPDATE), so the two callers serialize on the row itself.
-- The claim is a lease: a caller that dies leaves a claim that runs out, so a
-- crashed run cannot block its post forever.
--
-- The cancel and reschedule deadlines move into the database as well. The
-- deadline was read from the clock of the edge worker that answered the
-- request, while the post is published by the scheduler on the clock of
-- Postgres: the two clocks can disagree about whether a post is still in the
-- future, and the clock that decides is the one the scheduler reads. Both
-- writes are now one RPC each, and both compare the deadline with now()
-- inside the database.
--
-- This migration is ADDITIVE ONLY: two nullable columns on posts (no default,
-- nothing that exists is changed) and five new functions. No existing column,
-- policy, trigger or function is touched. The dashboard is unaffected: it
-- never writes the two new columns, and no rule it depends on changed.

BEGIN;

-- ---------------------------------------------------------------------------
-- 1. The claim columns.
-- ---------------------------------------------------------------------------

-- Both are nullable and have no default: a post that nobody claimed has no
-- claim, and the rows that already exist keep exactly the shape they had.
ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS action_claim_id uuid;
ALTER TABLE public.posts
  ADD COLUMN IF NOT EXISTS action_claimed_at timestamptz;

COMMENT ON COLUMN public.posts.action_claim_id IS
  'The id of the agent action that currently holds this post (a retry or a delete). NULL when no action holds it. Paired with action_claimed_at.';
COMMENT ON COLUMN public.posts.action_claimed_at IS
  'When the current action claim on this post was taken, on the database clock. The claim is a lease: it runs out this many minutes after it, and an expired claim may be taken again.';

-- ---------------------------------------------------------------------------
-- 2. The claim.
-- ---------------------------------------------------------------------------

-- SECURITY DEFINER: the caller runs with the service role, and the ownership
-- check below (id + user_id) is what keeps the claim inside the caller's own
-- posts. The claim never changes posts.status: it says who is working on the
-- post, not what the post is.
CREATE OR REPLACE FUNCTION public.mcp_claim_post_action(
  p_user_id uuid,
  p_post_id uuid,
  p_action text,
  p_lease_minutes integer DEFAULT 15
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_status text;
  v_source text;
  v_claim_id uuid;
  v_claimed_at timestamptz;
  v_lease integer;
BEGIN
  IF p_user_id IS NULL OR p_post_id IS NULL THEN
    RAISE EXCEPTION 'MISSING_ARGUMENT' USING ERRCODE = '22023';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('retry', 'delete') THEN
    RAISE EXCEPTION 'MISSING_ARGUMENT' USING ERRCODE = '22023';
  END IF;

  -- A lease of zero would expire the claim the moment it is taken, so a
  -- nonsensical length falls back to the default.
  v_lease := COALESCE(p_lease_minutes, 15);
  IF v_lease <= 0 THEN
    v_lease := 15;
  END IF;

  -- The row lock is the whole point: two callers that arrive at the same time
  -- queue here, and the second one reads the claim the first one wrote.
  SELECT p.status, p.source, p.action_claim_id, p.action_claimed_at
  INTO v_status, v_source, v_claim_id, v_claimed_at
  FROM public.posts p
  WHERE p.id = p_post_id AND p.user_id = p_user_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'not_found');
  END IF;

  -- A TikTok review post that is mid-publish may not be deleted. The trigger
  -- (tiktok_review_guard_post) refuses the delete too, but it refuses it
  -- after the claim was taken, and the caller is told the same thing either
  -- way: this post is being published right now.
  IF p_action = 'delete'
     AND v_source = 'tiktok_review'
     AND public.tiktok_review_post_in_flight(p_post_id) THEN
    RAISE EXCEPTION 'This TikTok post is being published right now and can''t be deleted. Try again in a few minutes.'
      USING ERRCODE = 'P0001', DETAIL = 'TIKTOK_REVIEW_POST_LOCKED';
  END IF;

  -- A live claim of somebody else's action: the post is being worked on. The
  -- claim is a lease, so a claim whose lease has run out is not live any more
  -- and may be taken again.
  IF v_claim_id IS NOT NULL
     AND v_claimed_at IS NOT NULL
     AND v_claimed_at > now() - make_interval(mins => v_lease) THEN
    RETURN jsonb_build_object('outcome', 'busy');
  END IF;

  -- Only a post that finished may be retried or deleted by an agent. A
  -- scheduled or pending post is the cancel path's business, and a
  -- processing post is publishing right now.
  --
  -- A processing post is a bad_status for BOTH actions, and an expired claim
  -- does not change that: the claim proves that an agent action stopped, not
  -- that the publish stopped. Another path (the dashboard, the scheduler) can
  -- be publishing the very same post, and a stale claim of ours says nothing
  -- about it. A retry that ran on such a post would publish it a second
  -- time, and a delete would remove the Postora row while the copy is still
  -- on its way out.
  IF v_status IS NULL OR v_status NOT IN ('failed', 'completed') THEN
    RETURN jsonb_build_object('outcome', 'bad_status', 'status', v_status);
  END IF;

  -- gen_random_uuid() is built into pg_catalog (PG13+), which is always on the
  -- search path, so the pinned search_path needs no extensions schema.
  v_claim_id := gen_random_uuid();
  UPDATE public.posts p
  SET action_claim_id = v_claim_id,
      action_claimed_at = now()
  WHERE p.id = p_post_id AND p.user_id = p_user_id;

  RETURN jsonb_build_object(
    'outcome', 'claimed',
    'claim_id', v_claim_id,
    'status', v_status
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_claim_post_action(uuid, uuid, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_claim_post_action(uuid, uuid, text, integer)
  TO service_role;

COMMENT ON FUNCTION public.mcp_claim_post_action(uuid, uuid, text, integer) IS
  'Takes an atomic lease on one of the caller''s own posts for an agent action. Returns the outcome: not_found, busy (a live claim), bad_status (the post is not finished), or claimed with the claim id.';

-- ---------------------------------------------------------------------------
-- 3. The release.
-- ---------------------------------------------------------------------------

-- The claim is given back when the action is over, so the next tool call is
-- not told the post is busy for the rest of the lease. The claim id has to
-- match: a release that arrives after somebody else took the post must not
-- clear the new claim.
CREATE OR REPLACE FUNCTION public.mcp_release_post_action(
  p_user_id uuid,
  p_post_id uuid,
  p_claim_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_user_id IS NULL OR p_post_id IS NULL OR p_claim_id IS NULL THEN
    RAISE EXCEPTION 'MISSING_ARGUMENT' USING ERRCODE = '22023';
  END IF;

  UPDATE public.posts p
  SET action_claim_id = NULL,
      action_claimed_at = NULL
  WHERE p.id = p_post_id
    AND p.user_id = p_user_id
    AND p.action_claim_id = p_claim_id;

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_release_post_action(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_release_post_action(uuid, uuid, uuid)
  TO service_role;

COMMENT ON FUNCTION public.mcp_release_post_action(uuid, uuid, uuid) IS
  'Gives the claim on one of the caller''s own posts back. Returns true when that claim was the one on the row, false when it was not (somebody else holds it now).';

-- ---------------------------------------------------------------------------
-- 4. The delete under a claim.
-- ---------------------------------------------------------------------------

-- The delete only lands while the caller still holds the claim, so a delete
-- that arrives after the lease ran out (and somebody else took the post)
-- finds no row and answers false instead of deleting somebody else's work.
-- The status is part of the predicate as well: the claim says who is working
-- on the post, not that the post is still the finished post the claim was
-- taken on. Another path (the dashboard retry) can put the post back into
-- publishing between the claim and this delete, and a post that is publishing
-- again is NOT deleted -- the caller is told the post changed and can look at
-- it again.
-- The tiktok_review_guard_post trigger still applies: a review post that is
-- mid-publish raises P0001 with the DETAIL TIKTOK_REVIEW_POST_LOCKED, and
-- that refusal is let through to the caller.
CREATE OR REPLACE FUNCTION public.mcp_delete_claimed_post(
  p_user_id uuid,
  p_post_id uuid,
  p_claim_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_user_id IS NULL OR p_post_id IS NULL OR p_claim_id IS NULL THEN
    RAISE EXCEPTION 'MISSING_ARGUMENT' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.posts p
  WHERE p.id = p_post_id
    AND p.user_id = p_user_id
    AND p.action_claim_id = p_claim_id
    AND p.status IN ('failed', 'completed');

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_delete_claimed_post(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_delete_claimed_post(uuid, uuid, uuid)
  TO service_role;

COMMENT ON FUNCTION public.mcp_delete_claimed_post(uuid, uuid, uuid) IS
  'Deletes one of the caller''s own posts while the caller still holds the claim and the post is still a finished post (completed or failed). Returns true when the row was deleted, false when the claim was not the one on the row or the post went back to publishing.';

-- ---------------------------------------------------------------------------
-- 5. The cancel, on the database clock.
-- ---------------------------------------------------------------------------

-- Compare-and-set against the scheduler: the scheduler claims the same row by
-- flipping it to processing, so the row is only deleted while it is still
-- scheduled for the future. The deadline is now() on the database clock, the
-- same clock the scheduler reads.
CREATE OR REPLACE FUNCTION public.mcp_cancel_scheduled_post(
  p_user_id uuid,
  p_post_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_user_id IS NULL OR p_post_id IS NULL THEN
    RAISE EXCEPTION 'MISSING_ARGUMENT' USING ERRCODE = '22023';
  END IF;

  DELETE FROM public.posts p
  WHERE p.id = p_post_id
    AND p.user_id = p_user_id
    AND p.status IN ('scheduled', 'pending')
    AND p.scheduled_at > now();

  RETURN FOUND;
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_cancel_scheduled_post(uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_cancel_scheduled_post(uuid, uuid)
  TO service_role;

COMMENT ON FUNCTION public.mcp_cancel_scheduled_post(uuid, uuid) IS
  'Cancels one of the caller''s own scheduled posts while it is still in the future, judged on the database clock. Returns true when the row was deleted, false when it was no longer a scheduled post in the future.';

-- ---------------------------------------------------------------------------
-- 6. The reschedule, on the database clock.
-- ---------------------------------------------------------------------------

-- Only the instant is written. The timezone is a label for the UI, and the
-- metadata is not rebuilt from an earlier read: that would overwrite a
-- dashboard edit that landed in the meantime.
CREATE OR REPLACE FUNCTION public.mcp_reschedule_post(
  p_user_id uuid,
  p_post_id uuid,
  p_scheduled_at timestamptz
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_status text;
  v_scheduled_at timestamptz;
BEGIN
  IF p_user_id IS NULL OR p_post_id IS NULL OR p_scheduled_at IS NULL THEN
    RAISE EXCEPTION 'MISSING_ARGUMENT' USING ERRCODE = '22023';
  END IF;

  -- An instant that has already come cannot be scheduled, on the database
  -- clock: the edge clock that read the request may be behind.
  IF p_scheduled_at <= now() THEN
    RETURN jsonb_build_object('outcome', 'in_past');
  END IF;

  UPDATE public.posts p
  SET scheduled_at = p_scheduled_at
  WHERE p.id = p_post_id
    AND p.user_id = p_user_id
    AND p.status IN ('scheduled', 'pending')
    AND p.scheduled_at > now()
  RETURNING id, status, scheduled_at
  INTO v_id, v_status, v_scheduled_at;

  -- Nothing was updated: the post is no longer a scheduled post in the future
  -- (the scheduler claimed it, or its time came).
  IF NOT FOUND THEN
    RETURN jsonb_build_object('outcome', 'unchanged');
  END IF;

  RETURN jsonb_build_object(
    'outcome', 'updated',
    'post', jsonb_build_object(
      'id', v_id,
      'status', v_status,
      'scheduled_at', v_scheduled_at
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_reschedule_post(uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_reschedule_post(uuid, uuid, timestamptz)
  TO service_role;

COMMENT ON FUNCTION public.mcp_reschedule_post(uuid, uuid, timestamptz) IS
  'Moves one of the caller''s own scheduled posts to a new instant, judged on the database clock. Returns the outcome: in_past (the instant has come), unchanged (the post is no longer scheduled for the future), or updated with the post.';

COMMIT;
