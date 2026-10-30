-- Tenant-checked insert of the pending row a deferred publish leaves behind.
--
-- Review follow-up to 20261029180000_deferred_publishes.sql; design:
-- docs/superpowers/specs/2026-10-30-hardening-review-followups-design.md, F6.
--
-- WHY
-- process-post records a Meta container it is still waiting for as a `pending`
-- platform_posts row, written with the service role, which bypasses RLS. Nothing
-- in SQL then checked that the account belongs to the post's owner: only the
-- caller paired them. partner_settle_platform_post checks it in SQL; this does
-- the same for the one insert that did not go through it (AGENTS.md: ownership
-- is enforced structurally, never left to the caller).
--
-- The check and the insert are ONE statement (an INSERT ... SELECT over posts
-- joined to social_accounts on user_id), so the pairing cannot change between
-- the two. The platform comes from the account row, not from the caller.
--
-- Additive and safe to apply before the Edge Function deploys: a new function that
-- nothing calls until process-post does. No BEGIN/COMMIT of its own.

CREATE OR REPLACE FUNCTION public.record_deferred_platform_post(
  p_post_id uuid,
  p_social_account_id uuid,
  p_response_data jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
BEGIN
  INSERT INTO public.platform_posts (post_id, social_account_id, platform, status, response_data)
  SELECT p.id, a.id, a.platform, 'pending', coalesce(p_response_data, '{}'::jsonb)
    FROM public.posts p
    JOIN public.social_accounts a
      ON a.id = p_social_account_id
     AND a.user_id = p.user_id
   WHERE p.id = p_post_id
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    -- Say which refusal it was; the insert wrote nothing either way.
    IF EXISTS (SELECT 1 FROM public.posts WHERE id = p_post_id)
       AND EXISTS (SELECT 1 FROM public.social_accounts WHERE id = p_social_account_id) THEN
      RAISE EXCEPTION
        'record_deferred_platform_post: account % does not belong to the owner of post % (cross-tenant pairing refused)',
        p_social_account_id, p_post_id
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    RAISE EXCEPTION
      'record_deferred_platform_post: post % or account % does not exist', p_post_id, p_social_account_id
      USING ERRCODE = 'foreign_key_violation';
  END IF;

  RETURN v_id;
END;
$$;

-- Same grant convention as the other publish-path functions: service role only.
REVOKE ALL ON FUNCTION public.record_deferred_platform_post(uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_deferred_platform_post(uuid, uuid, jsonb) TO service_role;
