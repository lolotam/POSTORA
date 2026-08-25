-- whatsapp_get_messages filters (social_account_id, conversation_id) and pages on
-- (timestamp DESC, id DESC). None of the four existing indexes serves that combination:
-- idx_whatsapp_messages_conversation leads with user_id, which this query never filters on,
-- so a keyset walk over a 707-message thread would fall back to a scan and sort.
--
-- CONCURRENTLY cannot run inside a transaction block, so this migration deliberately
-- contains exactly one statement and nothing else.
create index concurrently if not exists idx_whatsapp_messages_account_conv_keyset
  on public.whatsapp_messages (social_account_id, conversation_id, "timestamp" desc, id desc);
