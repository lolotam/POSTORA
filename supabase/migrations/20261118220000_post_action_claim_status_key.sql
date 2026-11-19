-- The claim answers with one status, and says which one.
--
-- WHY THIS EXISTS. `claim_post_action_processing` refused a post that was not
-- finished, and it said so in one object:
--
--   jsonb_build_object('status', 'refused', 'reason', 'not_terminal', 'status', v_post.status)
--
-- Two keys with the same name in one jsonb object do not both survive: the
-- LAST one wins. The answer therefore carried the status of the POST and not
-- the status of the ANSWER, so the 'refused' discriminator was gone and a
-- caller could not tell a refusal from a claim.
--
-- The status of the post is reported under its own name now. The refusal
-- itself, its reason and its blocked destinations are unchanged, and the
-- accepted retry contract is unchanged.
--
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.claim_post_action_processing(
  p_post_id uuid,
  p_user_id uuid,
  p_action_claim_id uuid,
  p_target_account_ids uuid[]
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_post public.posts%ROWTYPE;
  v_targets uuid[];
  v_blocked jsonb;
  v_processing_started_at timestamptz := clock_timestamp();
BEGIN
  IF p_post_id IS NULL OR p_user_id IS NULL OR p_action_claim_id IS NULL THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'missing_argument');
  END IF;

  -- THE PARENT LOCK. Everything below is read under it, so a durable writer
  -- that marks a destination while this call waits cannot be invisible: the
  -- two are ordered, not racing.
  SELECT * INTO v_post
    FROM public.posts
   WHERE id = p_post_id AND user_id = p_user_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'not_found');
  END IF;

  -- THE EXACT LIVE LEASE. The lease is the identity of the run that asked
  -- for this publish: a claim that is not the one on the row, or one whose
  -- lease has run out, is not allowed to publish. The lease is fifteen
  -- minutes, the length `mcp_claim_post_action` takes.
  IF v_post.action_claim_id IS DISTINCT FROM p_action_claim_id
     OR v_post.action_claimed_at IS NULL
     OR v_post.action_claimed_at <= now() - interval '15 minutes' THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'claim_not_live');
  END IF;

  -- A post that has not finished is being published by somebody else. An
  -- expired lease does not change that: the claim proves that an agent
  -- stopped, not that the publish stopped.
  IF v_post.status IS NULL OR v_post.status NOT IN ('failed', 'completed') THEN
    --
    -- The status of the post is reported under its OWN name. Two keys with
    -- the same name in one object keep the LAST one, so the refusal used to
    -- be read as the status of the post, and a caller could not tell a
    -- refusal from a claim.
    RETURN jsonb_build_object('status', 'refused', 'reason', 'not_terminal', 'current_status', v_post.status);
  END IF;

  -- The targets are the caller's own accounts. A target of somebody else is
  -- not a target at all.
  SELECT array_agg(DISTINCT sa.id ORDER BY sa.id) INTO v_targets
    FROM public.social_accounts sa
   WHERE sa.id = ANY (p_target_account_ids)
     AND sa.user_id = p_user_id;

  IF v_targets IS NULL OR cardinality(v_targets) = 0 THEN
    RETURN jsonb_build_object('status', 'refused', 'reason', 'no_targets');
  END IF;

  -- THE DURABLE ADMISSIBILITY OF EVERY TARGET, read under the parent lock.
  -- The caller's snapshot was taken before this call, and a marker may have
  -- been written since: that marker is what this read finds.
  WITH reasons AS (
    SELECT t AS account_id,
           public.post_retry_block_reason(p_post_id, t) AS reason
      FROM unnest(v_targets) AS t
  )
  SELECT jsonb_agg(jsonb_build_object('account_id', s.account_id, 'reason', s.reason) ORDER BY s.account_id)
    INTO v_blocked
    FROM (
      SELECT r.account_id,
             COALESCE(
               r.reason,
               CASE WHEN EXISTS (
                 SELECT 1 FROM public.platform_posts pp
                  WHERE pp.post_id = p_post_id
                    AND pp.social_account_id = r.account_id
                    AND pp.status = 'success'
               ) THEN 'already_published' END
             ) AS reason
        FROM reasons r
    ) s
   WHERE s.reason IS NOT NULL;

  IF v_blocked IS NOT NULL THEN
    RETURN jsonb_build_object(
      'status', 'refused',
      'reason', 'targets_not_admissible',
      'blocked', v_blocked
    );
  END IF;

  -- The whole gate passed. Only now does the parent move to `processing`.
  UPDATE public.posts
     SET status = 'processing',
         processing_started_at = v_processing_started_at
   WHERE id = p_post_id AND user_id = p_user_id;

  RETURN jsonb_build_object(
    'status', 'claimed',
    'processing_started_at', v_processing_started_at,
    'account_ids', to_jsonb(v_targets)
  );
END;
$$;
