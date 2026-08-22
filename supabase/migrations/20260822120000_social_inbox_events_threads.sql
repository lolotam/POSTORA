-- Threads replies and mentions are deduplicated through the same inbox-events table as
-- Facebook/Instagram comments before being forwarded to n8n, so the platform CHECK has to
-- admit 'threads'. The constraint is dropped by lookup rather than by name: it was created
-- inline with the table, so its generated name is not guaranteed across environments.
DO $migration$
DECLARE
  v_conname text;
BEGIN
  SELECT conname INTO v_conname
  FROM pg_constraint
  WHERE conrelid = 'public.social_inbox_events'::regclass
    AND contype = 'c'
    AND pg_get_constraintdef(oid) ILIKE '%platform%';

  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.social_inbox_events DROP CONSTRAINT %I', v_conname);
  END IF;
END
$migration$;

ALTER TABLE public.social_inbox_events
  ADD CONSTRAINT social_inbox_events_platform_check
  CHECK (platform IN ('facebook', 'instagram', 'threads'));

-- Atomic metadata patch. A read-merge-write from an edge function loses concurrent updates
-- to other account_metadata keys (ig_igid, flow, token_type); the || merge happens inside
-- the row lock instead.
--
-- SECURITY DEFINER but self-scoped on auth.uid(): callers must use a user-scoped client, so
-- this can never patch another user's account even though messaging-api also holds a
-- service-role client.
CREATE OR REPLACE FUNCTION public.patch_account_metadata(
  p_account_id uuid,
  p_patch jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_metadata jsonb;
BEGIN
  -- jsonb || NULL is NULL, so a null patch would erase every key rather than change none.
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'p_patch must be a jsonb object';
  END IF;

  UPDATE public.social_accounts
  SET account_metadata = COALESCE(account_metadata, '{}'::jsonb) || p_patch
  WHERE id = p_account_id AND user_id = auth.uid()
  RETURNING account_metadata INTO v_metadata;

  IF v_metadata IS NULL THEN
    RAISE EXCEPTION 'Account not found or access denied';
  END IF;

  RETURN v_metadata;
END
$function$;

REVOKE ALL ON FUNCTION public.patch_account_metadata(uuid, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.patch_account_metadata(uuid, jsonb) TO authenticated;
