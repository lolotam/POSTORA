-- WhatsApp account continuity, PR-BC follow-up (Codex review round 4 on PR #263).
--
-- The owner-bound interactive mover (20261004112000) now
-- 1. refuses a source that is connected again (live and not retired), checked under the
--    same row locks the mover takes: a candidate reconnected in another tab after the
--    preview loaded keeps its setup (source_still_connected);
-- 2. records the pair as handled after a successful move, the way "Not now" does. Items
--    the owner chose to leave behind (the source's agent when this account keeps its own,
--    skipped connectors, partner credentials) would otherwise re-offer the same banner on
--    every reload.
-- Signature, owner and grants are unchanged and restated below.

CREATE OR REPLACE FUNCTION public.move_owned_whatsapp_account_setup(
  p_user_id uuid,
  p_from uuid,
  p_to uuid,
  p_choices jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_owned integer;
  v_result jsonb;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'move_owned_whatsapp_account_setup: a user scope is required' USING errcode = '22023';
  END IF;
  -- The mover's own lock order: the per-owner advisory lock, then both rows in id order.
  -- Both locks are re-entrant, so the mover takes them again without waiting.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_user_id::text || ':wa-setup', 0));
  SELECT count(*) INTO v_owned FROM (
    SELECT 1 FROM social_accounts
     WHERE id IN (p_from, p_to) AND user_id = p_user_id AND platform = 'whatsapp'
     ORDER BY id FOR UPDATE
  ) owned;
  IF p_from IS NULL OR p_to IS NULL OR p_from = p_to OR v_owned <> 2 THEN
    RAISE EXCEPTION 'move_owned_whatsapp_account_setup: accounts_not_compatible' USING errcode = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM social_accounts
              WHERE id = p_from AND is_active IS TRUE AND platform_user_id NOT LIKE 'retired\_%') THEN
    RAISE EXCEPTION 'move_owned_whatsapp_account_setup: source_still_connected' USING errcode = '22023';
  END IF;
  v_result := public.move_whatsapp_account_setup(p_from, p_to, 'interactive', p_choices);
  PERFORM public.dismiss_whatsapp_setup_move(p_to, p_from);
  RETURN v_result;
END;
$$;
REVOKE ALL ON FUNCTION public.move_owned_whatsapp_account_setup(uuid, uuid, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.move_owned_whatsapp_account_setup(uuid, uuid, uuid, jsonb) TO service_role;
