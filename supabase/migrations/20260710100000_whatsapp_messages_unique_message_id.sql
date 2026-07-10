-- Meta redelivers webhooks and coexistence history arrives in chunks, so the same
-- wamid can be posted more than once. Dedupe existing rows (keep the oldest), then
-- enforce uniqueness per user so handlers can upsert with ignoreDuplicates instead
-- of blind inserts.
DELETE FROM public.whatsapp_messages
WHERE id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (
             PARTITION BY user_id, message_id
             ORDER BY created_at ASC, id ASC
           ) AS rn
    FROM public.whatsapp_messages
    WHERE message_id IS NOT NULL
  ) ranked
  WHERE rn > 1
);

-- Non-partial on purpose: PostgREST's ON CONFLICT (user_id, message_id) cannot infer
-- a partial index, and NULL message_ids remain unrestricted (NULLs are distinct).
CREATE UNIQUE INDEX IF NOT EXISTS idx_whatsapp_messages_user_message_id
  ON public.whatsapp_messages (user_id, message_id);
