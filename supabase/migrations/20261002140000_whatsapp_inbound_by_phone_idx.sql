-- Index for the n8n opt-out gate's 24 h inbound lookup (n8n-api/optOutGate.ts):
--   social_account_id = ? AND direction = 'inbound' AND from_phone = ? AND timestamp >= ?  LIMIT 1
-- The existing indexes lead with (social_account_id, conversation_id), which this
-- query does not filter on. whatsapp_messages is small today (~8k rows), so a plain
-- CREATE INDEX takes a moment; IF NOT EXISTS keeps the file re-runnable.

CREATE INDEX IF NOT EXISTS whatsapp_messages_inbound_by_phone_idx
  ON public.whatsapp_messages (social_account_id, from_phone, "timestamp" DESC)
  WHERE direction = 'inbound';
