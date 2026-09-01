-- Partner API v1 read surface (deliverables 2.4-2.6): the index
-- GET /v1/conversations/{id}/messages needs.
--
-- WHY THE EXISTING INDEX DOES NOT SERVE THIS QUERY
-- ------------------------------------------------
-- whatsapp_messages already has
--     idx_whatsapp_messages_conversation (user_id, conversation_id, timestamp DESC)
-- and its leading column is the problem. The partner path knows the ACCOUNT,
-- because that is what the key's binding proves (partner_api_key_accounts); it
-- never resolves a user_id, and it must not -- deriving one would mean trusting
-- a column the binding does not cover. A filter on
-- (social_account_id, conversation_id) therefore cannot use an index led by
-- user_id, and the listing degrades to a sequential scan over every WhatsApp
-- message in the deployment. That is a class-A endpoint by D7's definition
-- (bounded local read) whose cost would not actually be bounded.
--
-- The trailing (timestamp DESC, id DESC) matches the keyset cursor's ordering
-- exactly, so a page is an index range scan rather than a sort: the cursor
-- compares the pair (timestamp, id) precisely because timestamps collide
-- during history sync, and an index that stopped at timestamp would leave the
-- tiebreak to a sort node.
--
-- Additive and reversible: one index, no data change, no constraint. Safe to
-- re-run.
--
-- Lock note: plain CREATE INDEX, not CONCURRENTLY. CONCURRENTLY cannot run
-- inside a transaction block, and this repo's migrations are applied as one.
-- The SHARE lock blocks writes to whatsapp_messages while the index builds --
-- seconds at the current table size, and inbound webhooks retry.

CREATE INDEX IF NOT EXISTS whatsapp_messages_account_conversation_timestamp_idx
  ON public.whatsapp_messages (social_account_id, conversation_id, timestamp DESC, id DESC);

-- GET /v1/messages/{id} resolves a message's surrogate conversation id by
-- looking messaging_cache up on its natural key. messaging_cache is unique on
-- (user_id, conversation_id), and again the partner path has no user_id -- it
-- filters (conversation_id, social_account_id, workspace_id). No existing
-- index leads with conversation_id.
CREATE INDEX IF NOT EXISTS messaging_cache_conversation_account_idx
  ON public.messaging_cache (conversation_id, social_account_id);
