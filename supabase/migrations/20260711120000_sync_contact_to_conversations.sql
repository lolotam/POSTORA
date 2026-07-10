-- Sync whatsapp_contacts display_name and avatar_url changes to messaging_cache
-- so that editing a contact in /contacts reflects in /conversations

CREATE OR REPLACE FUNCTION public.sync_contact_to_conversations()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  -- Only sync if display_name or avatar_url actually changed
  IF (NEW.display_name IS DISTINCT FROM OLD.display_name)
     OR (NEW.avatar_url IS DISTINCT FROM OLD.avatar_url) THEN

    UPDATE public.messaging_cache
       SET participant_name   = COALESCE(NEW.display_name, participant_name),
           participant_avatar = COALESCE(NEW.avatar_url, participant_avatar),
           updated_at = now()
     WHERE user_id = NEW.user_id
       AND platform = 'whatsapp'
       AND conversation_id LIKE 'wa_%_' || NEW.phone_number;
  END IF;

  RETURN NEW;
END;
$$;

-- Drop existing trigger if it exists (idempotent)
DROP TRIGGER IF EXISTS trg_sync_contact_to_conversations ON public.whatsapp_contacts;

CREATE TRIGGER trg_sync_contact_to_conversations
AFTER UPDATE OF display_name, avatar_url ON public.whatsapp_contacts
FOR EACH ROW EXECUTE FUNCTION public.sync_contact_to_conversations();
