-- Per-message state for the WhatsApp inbox, split by who owns it.
--
-- Revocation is PLATFORM state: once a message is revoked on WhatsApp it is gone for
-- everyone, so it belongs on the message row and is visible to every workspace member.
-- Storing it there is safe against ingest -- every writer of whatsapp_messages was audited:
-- both webhooks upsert with ignoreDuplicates (a DO NOTHING), and import_whatsapp_messages
-- uses an explicit two-column `do update set social_account_id, conversation_id`.
alter table public.whatsapp_messages
  add column if not exists revoked_at timestamptz,
  add column if not exists revoked_by uuid references auth.users(id) on delete set null;

comment on column public.whatsapp_messages.revoked_at is
  'Set when delete-for-everyone succeeded on the platform. Visible to every workspace member. No ingest path can clobber it: webhooks conflict to DO NOTHING and the history import updates an explicit two-column list.';

-- Pin and delete-for-me are PER-VIEWER state and deliberately do NOT live on the message row:
-- whatsapp_messages.user_id is the ACCOUNT OWNER, not the viewer, so a column there would make
-- one agent's pin or hide apply to every member of the workspace. localStorage is also wrong --
-- a delete whose effect vanishes in another browser is worse than no delete at all.
create table if not exists public.whatsapp_message_flags (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  -- No social_account_id / conversation_id copy on purpose: import_whatsapp_messages rewrites
  -- both of those columns in place on a QR re-pair, so a denormalised copy would silently go
  -- stale and pins would point at a dead account. Scope by joining through whatsapp_messages.
  --
  -- ON DELETE CASCADE is correct for the runtime, where nothing deletes message rows -- but a
  -- dedupe migration has done so before (20260710100000:5-17), so any future dedupe must be
  -- written knowing it takes the user's pins with it.
  message_row_id  uuid not null references public.whatsapp_messages(id) on delete cascade,
  pinned_at       timestamptz,
  hidden_at       timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (user_id, message_row_id)
);

-- The unique constraint above already indexes (user_id, message_row_id); a second identical
-- index would be dead weight. Only the pinned-bar lookup needs its own.
create index if not exists idx_wa_message_flags_pinned
  on public.whatsapp_message_flags (user_id, pinned_at)
  where pinned_at is not null;

alter table public.whatsapp_message_flags enable row level security;

create policy "Users read their own message flags"
  on public.whatsapp_message_flags for select to authenticated
  using (auth.uid() = user_id);

create policy "Users insert their own message flags"
  on public.whatsapp_message_flags for insert to authenticated
  with check (auth.uid() = user_id);

create policy "Users update their own message flags"
  on public.whatsapp_message_flags for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Users delete their own message flags"
  on public.whatsapp_message_flags for delete to authenticated
  using (auth.uid() = user_id);

drop trigger if exists set_wa_message_flags_updated_at on public.whatsapp_message_flags;
create trigger set_wa_message_flags_updated_at
  before update on public.whatsapp_message_flags
  for each row execute function public.update_updated_at_column();
