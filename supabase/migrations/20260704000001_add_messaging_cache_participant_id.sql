-- Adds a participant_id column to messaging_cache so other features (Instagram
-- comment-manager avatars) can look up a person's already-cached DM avatar by
-- their Meta-scoped ID, without a new table. Additive and nullable: existing
-- rows are untouched, and messaging-api starts populating it going forward.
ALTER TABLE public.messaging_cache
  ADD COLUMN IF NOT EXISTS participant_id text;

CREATE INDEX IF NOT EXISTS idx_messaging_cache_user_participant
  ON public.messaging_cache (user_id, participant_id);
