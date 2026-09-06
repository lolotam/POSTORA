-- 20260906120000_whatsapp_evolution_sync_outcome.sql
-- The history sweep runs in the background and used to report nothing. The setup page
-- polls this column to tell the user how many chats and messages landed, whether the
-- sweep was cut short by its budget (run again), and how many LID chats still wait for
-- a first live message. Shape: SyncOutcome from _shared/whatsappSyncEngine.ts plus
-- finished_at, or { finished_at, error } when the sweep threw.
alter table public.whatsapp_evolution_instances
  add column if not exists last_sync_outcome jsonb;
