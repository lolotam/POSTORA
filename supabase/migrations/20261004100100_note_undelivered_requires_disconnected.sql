-- WhatsApp account continuity, PR-D follow-up (Codex review on PR #261).
--
-- note_undelivered_store_event raised the "orders on hold" flag unconditionally. If the
-- account reconnected between the caller's connection check and this call, the reconnect
-- path could clear the flag first and this update would then recreate it on an active
-- account: a false banner, and possibly an email. The update now requires the row to
-- still be unable to send (inactive, or retired by a re-pair) in the same statement.
-- 20261004100000 is already applied, so the change lives here.
CREATE OR REPLACE FUNCTION public.note_undelivered_store_event(p_account_id uuid)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE social_accounts
     SET account_metadata = coalesce(account_metadata, '{}'::jsonb) || jsonb_build_object(
           'undelivered_store_events', jsonb_build_object(
             'since', coalesce(account_metadata->'undelivered_store_events'->>'since', clock_timestamp()::text),
             'last_at', clock_timestamp()::text))
   WHERE id = p_account_id
     AND (is_active IS NOT TRUE OR platform_user_id LIKE 'retired\_%');
$$;
REVOKE ALL ON FUNCTION public.note_undelivered_store_event(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.note_undelivered_store_event(uuid) TO service_role;
