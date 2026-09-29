-- Keep an in-flight WhatsApp scheduled row when its account is deleted.
--
-- WHY
-- whatsapp_scheduled_messages.social_account_id used to reference
-- social_accounts ON DELETE CASCADE. Deleting the account while a row was
-- claimed or sending erased the only record of a provider call still in
-- progress, so the later sent-write lost its compare-and-set.
--
-- Resting rows (anything other than claimed/sending) are still removed, by
-- a BEFORE DELETE trigger, so pending, sent, failed, cancelled and skipped
-- keep the old cascade behaviour. The FK is then ON DELETE SET NULL, which
-- only the surviving in-flight rows reach. social_account_id is nullable
-- for that.
--
-- Lease cleanup does not need the account row. claim_whatsapp_scheduled_messages
-- (b) and (c) update expired sending/claimed rows with no join to
-- social_accounts, so a nulled in-flight row still becomes indeterminate or
-- is released. Step (d) claims only through a join on social_accounts, so a
-- NULL account is never claimed. A released row that is due again fails
-- closed in step (a) as account_not_owned.
--
-- Clients still cannot write a NULL account. The INSERT and UPDATE RLS
-- policies require an owned whatsapp social_accounts row
-- (s.id = social_account_id); NULL never matches, so the write is rejected.
-- The client guard is unchanged.
--
-- Idempotent: DROP NOT NULL is a no-op once nullable, the FK is dropped
-- before re-adding, and the function/trigger are replaced. Runs as
-- supabase_admin. No BEGIN/COMMIT of its own (the harness wraps the file).

ALTER TABLE public.whatsapp_scheduled_messages
  ALTER COLUMN social_account_id DROP NOT NULL;

ALTER TABLE public.whatsapp_scheduled_messages
  DROP CONSTRAINT IF EXISTS whatsapp_scheduled_messages_social_account_id_fkey;

ALTER TABLE public.whatsapp_scheduled_messages
  ADD CONSTRAINT whatsapp_scheduled_messages_social_account_id_fkey
  FOREIGN KEY (social_account_id)
  REFERENCES public.social_accounts(id)
  ON DELETE SET NULL;

CREATE OR REPLACE FUNCTION public.whatsapp_scheduled_drop_resting_on_account_delete()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $function$
BEGIN
  DELETE FROM public.whatsapp_scheduled_messages
  WHERE social_account_id = OLD.id
    AND status NOT IN ('claimed', 'sending');
  RETURN OLD;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.whatsapp_scheduled_drop_resting_on_account_delete()
  FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS whatsapp_scheduled_drop_resting_on_account_delete
  ON public.social_accounts;

CREATE TRIGGER whatsapp_scheduled_drop_resting_on_account_delete
  BEFORE DELETE ON public.social_accounts
  FOR EACH ROW EXECUTE FUNCTION public.whatsapp_scheduled_drop_resting_on_account_delete();
