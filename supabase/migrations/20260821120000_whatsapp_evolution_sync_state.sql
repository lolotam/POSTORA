-- History sync state for Direct QR instances.
--
-- sync_started_at is a lease: three triggers (the connection webhook, the status poller
-- and the manual action) can all decide to sweep, and without a claim they would run
-- concurrent full imports of the same 300+ chats.
--
-- last_sync_at records a sweep that actually imported something. It is deliberately not
-- written by an empty sweep, because Baileys may still be pulling history off the phone
-- when the connection first opens and a later attempt has to be allowed to retry.
alter table public.whatsapp_evolution_instances
  add column if not exists sync_started_at timestamptz,
  add column if not exists last_sync_at timestamptz;
