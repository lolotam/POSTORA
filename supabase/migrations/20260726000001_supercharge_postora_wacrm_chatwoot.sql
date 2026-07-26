begin;

-- 1. Workspace tenancy core.
create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  owner_id uuid not null references auth.users(id) on delete cascade,
  is_personal boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists workspaces_one_personal_per_owner_idx
  on public.workspaces (owner_id)
  where is_personal;

create table if not exists public.workspace_members (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'admin', 'agent', 'viewer')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint workspace_members_workspace_user_key unique (workspace_id, user_id)
);

create table if not exists public.workspace_invitations (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces(id) on delete cascade,
  email text not null check (email <> '' and email = lower(btrim(email))),
  role text not null check (role in ('admin', 'agent', 'viewer')),
  token_hash text not null unique
    check (token_hash ~ '^[0-9a-f]{64}$'),
  invited_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_by uuid references auth.users(id) on delete set null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create or replace function public.normalize_workspace_invitation_email()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.email := lower(btrim(new.email));
  return new;
end;
$$;

create or replace function public.retire_expired_workspace_invitations()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.workspace_invitations
  set revoked_at = now()
  where workspace_id = new.workspace_id
    and email = new.email
    and accepted_at is null
    and revoked_at is null
    and expires_at <= now();
  return new;
end;
$$;

drop trigger if exists workspace_invitations_10_normalize_email
  on public.workspace_invitations;
create trigger workspace_invitations_10_normalize_email
before insert or update of email on public.workspace_invitations
for each row execute function public.normalize_workspace_invitation_email();

drop trigger if exists workspace_invitations_20_retire_expired
  on public.workspace_invitations;
create trigger workspace_invitations_20_retire_expired
before insert on public.workspace_invitations
for each row execute function public.retire_expired_workspace_invitations();

-- PostgreSQL index predicates cannot depend on now(). The preceding trigger marks
-- expired rows revoked before each insert, making this immutable predicate enforce
-- one currently usable invitation per workspace and normalized email.
create unique index if not exists workspace_invitations_one_pending_email_idx
  on public.workspace_invitations (workspace_id, lower(email))
  where accepted_at is null and revoked_at is null;

-- 2. Backfill one personal workspace and owner membership per existing user.
insert into public.workspaces (name, owner_id, is_personal)
select
  coalesce(nullif(split_part(coalesce(users.email, ''), '@', 1), ''), 'My Workspace'),
  users.id,
  true
from auth.users as users
where not exists (
  select 1
  from public.workspaces as existing
  where existing.owner_id = users.id
    and existing.is_personal
)
on conflict do nothing;

insert into public.workspace_members (workspace_id, user_id, role)
select personal.id, personal.owner_id, 'owner'
from public.workspaces as personal
where personal.is_personal
on conflict (workspace_id, user_id) do update
set role = 'owner', updated_at = now()
where public.workspace_members.role <> 'owner';

-- 3. Add and backfill workspace_id on existing WhatsApp-related tables.
alter table public.social_accounts
  add column if not exists workspace_id uuid
  references public.workspaces(id) on delete cascade;
alter table public.whatsapp_contacts
  add column if not exists workspace_id uuid
  references public.workspaces(id) on delete cascade;
alter table public.messaging_cache
  add column if not exists workspace_id uuid
  references public.workspaces(id) on delete cascade;
alter table public.whatsapp_agents
  add column if not exists workspace_id uuid
  references public.workspaces(id) on delete cascade;
alter table public.whatsapp_conversation_assignments
  add column if not exists workspace_id uuid
  references public.workspaces(id) on delete cascade;

update public.social_accounts as account
set workspace_id = personal.id
from public.workspaces as personal
where account.workspace_id is null
  and personal.owner_id = account.user_id
  and personal.is_personal;

update public.whatsapp_contacts as contact
set workspace_id = personal.id
from public.workspaces as personal
where contact.workspace_id is null
  and personal.owner_id = contact.user_id
  and personal.is_personal;

update public.messaging_cache as conversation
set workspace_id = personal.id
from public.workspaces as personal
where conversation.workspace_id is null
  and personal.owner_id = conversation.user_id
  and personal.is_personal;

update public.whatsapp_agents as agent
set workspace_id = personal.id
from public.workspaces as personal
where agent.workspace_id is null
  and personal.owner_id = agent.user_id
  and personal.is_personal;

update public.whatsapp_conversation_assignments as assignment
set workspace_id = agent.workspace_id
from public.whatsapp_agents as agent
where assignment.workspace_id is null
  and assignment.agent_id = agent.id;

alter table public.whatsapp_contacts alter column workspace_id set not null;
alter table public.messaging_cache alter column workspace_id set not null;
alter table public.whatsapp_agents alter column workspace_id set not null;

-- Composite keys are prerequisites for tenant-preserving foreign keys.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.whatsapp_contacts'::regclass
      and conname = 'whatsapp_contacts_id_workspace_id_key'
  ) then
    alter table public.whatsapp_contacts
      add constraint whatsapp_contacts_id_workspace_id_key
      unique (id, workspace_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.messaging_cache'::regclass
      and conname = 'messaging_cache_id_workspace_id_key'
  ) then
    alter table public.messaging_cache
      add constraint messaging_cache_id_workspace_id_key
      unique (id, workspace_id);
  end if;
end;
$$;

-- 4. Replace global agent uniqueness with workspace-scoped uniqueness.
alter table public.whatsapp_agents
  drop constraint if exists whatsapp_agents_user_id_key;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.whatsapp_agents'::regclass
      and conname = 'whatsapp_agents_workspace_id_user_id_key'
  ) then
    alter table public.whatsapp_agents
      add constraint whatsapp_agents_workspace_id_user_id_key
      unique (workspace_id, user_id);
  end if;
end;
$$;

-- 5. Link assignments to messaging_cache while retaining the external text key.
alter table public.whatsapp_conversation_assignments
  add column if not exists conversation_cache_id uuid
  references public.messaging_cache(id) on delete cascade;

do $$
begin
  if exists (
    select assignment.id
    from public.whatsapp_conversation_assignments as assignment
    join public.messaging_cache as conversation
      on conversation.workspace_id = assignment.workspace_id
     and conversation.conversation_id = assignment.conversation_id
     and conversation.platform = 'whatsapp'
    where assignment.conversation_cache_id is null
    group by assignment.id
    having count(*) > 1
  ) then
    raise exception
      'Ambiguous WhatsApp conversation_id while backfilling assignment cache ids';
  end if;
end;
$$;

update public.whatsapp_conversation_assignments as assignment
set conversation_cache_id = conversation.id
from public.messaging_cache as conversation
where assignment.conversation_cache_id is null
  and assignment.workspace_id = conversation.workspace_id
  and assignment.conversation_id = conversation.conversation_id
  and conversation.platform = 'whatsapp';

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.whatsapp_conversation_assignments'::regclass
      and conname = 'whatsapp_assignments_conversation_workspace_fkey'
  ) then
    alter table public.whatsapp_conversation_assignments
      add constraint whatsapp_assignments_conversation_workspace_fkey
      foreign key (conversation_cache_id, workspace_id)
      references public.messaging_cache(id, workspace_id)
      on delete cascade;
  end if;
end;
$$;

drop index if exists public.idx_active_assignment;
create unique index idx_active_assignment
  on public.whatsapp_conversation_assignments (workspace_id, conversation_id)
  where unassigned_at is null;

-- 6. Workspace-scoped WhatsApp CRM tables.
create table if not exists public.whatsapp_pipelines (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  name text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.whatsapp_pipeline_stages (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  pipeline_id uuid not null,
  name text not null,
  position integer not null default 0,
  stage_type text not null default 'open'
    check (stage_type in ('open', 'won', 'lost')),
  color text default '#3b82f6',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.whatsapp_deals (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  pipeline_id uuid not null,
  stage_id uuid not null,
  contact_id uuid not null,
  conversation_cache_id uuid,
  title text not null,
  amount numeric(14, 2) not null default 0,
  currency text not null default 'USD',
  status text not null default 'open'
    check (status in ('open', 'won', 'lost')),
  position integer not null default 0,
  assigned_to uuid references auth.users(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists whatsapp_pipelines_one_default_idx
  on public.whatsapp_pipelines (workspace_id)
  where is_default;

-- 7. Composite foreign keys enforce workspace agreement across CRM relations.
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.whatsapp_pipelines'::regclass
      and conname = 'whatsapp_pipelines_workspace_id_fkey'
  ) then
    alter table public.whatsapp_pipelines
      add constraint whatsapp_pipelines_workspace_id_fkey
      foreign key (workspace_id)
      references public.workspaces(id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.whatsapp_deals'::regclass
      and conname = 'whatsapp_deals_workspace_id_fkey'
  ) then
    alter table public.whatsapp_deals
      add constraint whatsapp_deals_workspace_id_fkey
      foreign key (workspace_id)
      references public.workspaces(id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.whatsapp_pipelines'::regclass
      and conname = 'whatsapp_pipelines_id_workspace_id_key'
  ) then
    alter table public.whatsapp_pipelines
      add constraint whatsapp_pipelines_id_workspace_id_key
      unique (id, workspace_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.whatsapp_pipeline_stages'::regclass
      and conname = 'whatsapp_stages_id_pipeline_workspace_key'
  ) then
    alter table public.whatsapp_pipeline_stages
      add constraint whatsapp_stages_id_pipeline_workspace_key
      unique (id, pipeline_id, workspace_id);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.whatsapp_pipeline_stages'::regclass
      and conname = 'whatsapp_stages_pipeline_position_key'
  ) then
    alter table public.whatsapp_pipeline_stages
      add constraint whatsapp_stages_pipeline_position_key
      unique (pipeline_id, position);
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.whatsapp_pipeline_stages'::regclass
      and conname = 'whatsapp_stages_pipeline_workspace_fkey'
  ) then
    alter table public.whatsapp_pipeline_stages
      add constraint whatsapp_stages_pipeline_workspace_fkey
      foreign key (pipeline_id, workspace_id)
      references public.whatsapp_pipelines(id, workspace_id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.whatsapp_deals'::regclass
      and conname = 'whatsapp_deals_pipeline_workspace_fkey'
  ) then
    alter table public.whatsapp_deals
      add constraint whatsapp_deals_pipeline_workspace_fkey
      foreign key (pipeline_id, workspace_id)
      references public.whatsapp_pipelines(id, workspace_id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.whatsapp_deals'::regclass
      and conname = 'whatsapp_deals_stage_pipeline_workspace_fkey'
  ) then
    alter table public.whatsapp_deals
      add constraint whatsapp_deals_stage_pipeline_workspace_fkey
      foreign key (stage_id, pipeline_id, workspace_id)
      references public.whatsapp_pipeline_stages(id, pipeline_id, workspace_id)
      on delete restrict;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.whatsapp_deals'::regclass
      and conname = 'whatsapp_deals_contact_workspace_fkey'
  ) then
    alter table public.whatsapp_deals
      add constraint whatsapp_deals_contact_workspace_fkey
      foreign key (contact_id, workspace_id)
      references public.whatsapp_contacts(id, workspace_id)
      on delete cascade;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.whatsapp_deals'::regclass
      and conname = 'whatsapp_deals_conversation_workspace_fkey'
  ) then
    alter table public.whatsapp_deals
      add constraint whatsapp_deals_conversation_workspace_fkey
      foreign key (conversation_cache_id, workspace_id)
      references public.messaging_cache(id, workspace_id)
      on delete set null (conversation_cache_id);
  end if;
end;
$$;

-- 8. Security-definer helpers and atomic workspace/CRM operations.
create or replace function public.set_whatsapp_workspace_updated_at()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.is_workspace_member(
  p_workspace_id uuid,
  p_user_id uuid default auth.uid()
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1
    from public.workspace_members as member
    where member.workspace_id = p_workspace_id
      and member.user_id = p_user_id
  );
$$;

create or replace function public.workspace_role(
  p_workspace_id uuid,
  p_user_id uuid default auth.uid()
)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select member.role
  from public.workspace_members as member
  where member.workspace_id = p_workspace_id
    and member.user_id = p_user_id;
$$;

create or replace function public.ensure_personal_workspace(p_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  personal_workspace_id uuid;
  personal_workspace_name text;
begin
  if auth.uid() is null or auth.uid() <> p_user_id then
    raise exception using
      errcode = '42501',
      message = 'Cannot create a personal workspace for another user';
  end if;

  select workspace.id
  into personal_workspace_id
  from public.workspaces as workspace
  where workspace.owner_id = p_user_id
    and workspace.is_personal
  order by workspace.created_at, workspace.id
  limit 1;

  if personal_workspace_id is null then
    select coalesce(
      nullif(split_part(coalesce(users.email, ''), '@', 1), ''),
      'My Workspace'
    )
    into personal_workspace_name
    from auth.users as users
    where users.id = p_user_id;

    if not found then
      raise exception using
        errcode = 'P0001',
        message = 'Cannot create a personal workspace for an unknown user';
    end if;

    insert into public.workspaces (name, owner_id, is_personal)
    values (personal_workspace_name, p_user_id, true)
    on conflict do nothing
    returning id into personal_workspace_id;

    if personal_workspace_id is null then
      select workspace.id
      into strict personal_workspace_id
      from public.workspaces as workspace
      where workspace.owner_id = p_user_id
        and workspace.is_personal;
    end if;
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (personal_workspace_id, p_user_id, 'owner')
  on conflict (workspace_id, user_id) do update
  set role = 'owner', updated_at = now()
  where public.workspace_members.role <> 'owner';

  return personal_workspace_id;
end;
$$;

create or replace function public.accept_workspace_invitation(p_token text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  invitation_id uuid;
  invitation_workspace_id uuid;
  invitation_email text;
  invitation_role text;
  invitation_accepted_at timestamptz;
  invitation_revoked_at timestamptz;
  invitation_expires_at timestamptz;
  caller_email text;
begin
  select
    invitation.id,
    invitation.workspace_id,
    invitation.email,
    invitation.role,
    invitation.accepted_at,
    invitation.revoked_at,
    invitation.expires_at,
    lower(users.email)
  into
    invitation_id,
    invitation_workspace_id,
    invitation_email,
    invitation_role,
    invitation_accepted_at,
    invitation_revoked_at,
    invitation_expires_at,
    caller_email
  from public.workspace_invitations as invitation
  join auth.users as users
    on users.id = auth.uid()
  where invitation.token_hash = encode(
    extensions.digest(p_token, 'sha256'),
    'hex'
  )
  for update of invitation;

  if not found
     or invitation_accepted_at is not null
     or invitation_revoked_at is not null
     or invitation_expires_at <= now()
     or invitation_email <> caller_email then
    raise exception using
      errcode = 'P0001',
      message = 'Invalid workspace invitation';
  end if;

  insert into public.workspace_members (workspace_id, user_id, role)
  values (invitation_workspace_id, auth.uid(), invitation_role)
  on conflict (workspace_id, user_id) do update
  set
    role = case
      when public.workspace_members.role = 'owner'
        then public.workspace_members.role
      else excluded.role
    end,
    updated_at = now();

  update public.workspace_invitations
  set accepted_at = now(), accepted_by = auth.uid()
  where id = invitation_id;

  return invitation_workspace_id;
end;
$$;

create or replace function public.create_default_whatsapp_pipeline(
  p_workspace_id uuid
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  default_pipeline_id uuid;
  caller_role text;
begin
  caller_role := public.workspace_role(p_workspace_id);
  if caller_role is null or caller_role not in ('owner', 'admin') then
    raise exception using
      errcode = '42501',
      message = 'Only workspace owners and admins can create pipelines';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('whatsapp-pipeline:' || p_workspace_id::text, 0)
  );

  select pipeline.id
  into default_pipeline_id
  from public.whatsapp_pipelines as pipeline
  where pipeline.workspace_id = p_workspace_id
    and pipeline.is_default
  limit 1;

  if default_pipeline_id is null then
    insert into public.whatsapp_pipelines (workspace_id, name, is_default)
    values (p_workspace_id, 'Sales Pipeline', true)
    returning id into default_pipeline_id;
  end if;

  insert into public.whatsapp_pipeline_stages
    (workspace_id, pipeline_id, name, position, stage_type, color)
  values
    (p_workspace_id, default_pipeline_id, 'New Lead', 0, 'open', '#3b82f6'),
    (p_workspace_id, default_pipeline_id, 'Qualified', 1, 'open', '#6366f1'),
    (p_workspace_id, default_pipeline_id, 'Negotiation', 2, 'open', '#f59e0b'),
    (p_workspace_id, default_pipeline_id, 'Won', 3, 'won', '#10b981'),
    (p_workspace_id, default_pipeline_id, 'Lost', 4, 'lost', '#ef4444')
  on conflict (pipeline_id, position) do nothing;

  return default_pipeline_id;
end;
$$;

create or replace function public.move_whatsapp_deal(
  p_deal_id uuid,
  p_stage_id uuid,
  p_position integer
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  expected_pipeline_id uuid;
  deal_workspace_id uuid;
  deal_pipeline_id uuid;
  source_stage_id uuid;
  destination_stage_type text;
  destination_deal_count integer;
  destination_position integer;
  caller_role text;
begin
  if p_position is null or p_position < 0 then
    raise exception using
      errcode = 'P0001',
      message = 'Deal position must be a non-negative integer';
  end if;

  select deal.pipeline_id
  into expected_pipeline_id
  from public.whatsapp_deals as deal
  where deal.id = p_deal_id;

  if expected_pipeline_id is null then
    raise exception using errcode = 'P0001', message = 'Deal not found';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('whatsapp-pipeline:' || expected_pipeline_id::text, 0)
  );

  select deal.workspace_id, deal.pipeline_id, deal.stage_id
  into deal_workspace_id, deal_pipeline_id, source_stage_id
  from public.whatsapp_deals as deal
  where deal.id = p_deal_id
  for update;

  if deal_pipeline_id is distinct from expected_pipeline_id then
    raise exception using
      errcode = '40001',
      message = 'Deal changed during move; retry the operation';
  end if;

  caller_role := public.workspace_role(deal_workspace_id);
  if caller_role is null or caller_role not in ('owner', 'admin', 'agent') then
    raise exception using
      errcode = '42501',
      message = 'Workspace membership does not allow moving deals';
  end if;

  select stage.stage_type
  into destination_stage_type
  from public.whatsapp_pipeline_stages as stage
  where stage.id = p_stage_id
    and stage.pipeline_id = deal_pipeline_id
    and stage.workspace_id = deal_workspace_id
  for update;

  if destination_stage_type is null then
    raise exception using
      errcode = 'P0001',
      message = 'Target stage must belong to the deal pipeline and workspace';
  end if;

  perform deal.id
  from public.whatsapp_deals as deal
  where deal.pipeline_id = deal_pipeline_id
    and deal.workspace_id = deal_workspace_id
    and deal.stage_id in (source_stage_id, p_stage_id)
  order by deal.id
  for update;

  with ranked_source as (
    select
      deal.id,
      row_number() over (order by deal.position, deal.id)::integer - 1
        as new_position
    from public.whatsapp_deals as deal
    where deal.pipeline_id = deal_pipeline_id
      and deal.workspace_id = deal_workspace_id
      and deal.stage_id = source_stage_id
      and deal.id <> p_deal_id
  )
  update public.whatsapp_deals as deal
  set position = ranked_source.new_position
  from ranked_source
  where deal.id = ranked_source.id;

  select count(*)::integer
  into destination_deal_count
  from public.whatsapp_deals as deal
  where deal.pipeline_id = deal_pipeline_id
    and deal.workspace_id = deal_workspace_id
    and deal.stage_id = p_stage_id
    and deal.id <> p_deal_id;

  destination_position := least(p_position, destination_deal_count);

  with ranked_destination as (
    select
      deal.id,
      row_number() over (order by deal.position, deal.id)::integer - 1
        as base_position
    from public.whatsapp_deals as deal
    where deal.pipeline_id = deal_pipeline_id
      and deal.workspace_id = deal_workspace_id
      and deal.stage_id = p_stage_id
      and deal.id <> p_deal_id
  )
  update public.whatsapp_deals as deal
  set position = case
    when ranked_destination.base_position >= destination_position
      then ranked_destination.base_position + 1
    else ranked_destination.base_position
  end
  from ranked_destination
  where deal.id = ranked_destination.id;

  update public.whatsapp_deals
  set
    stage_id = p_stage_id,
    position = destination_position,
    status = destination_stage_type,
    updated_at = now()
  where id = p_deal_id;
end;
$$;

create or replace function public.prevent_last_workspace_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.role <> 'owner' then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if tg_op = 'UPDATE'
     and new.role = 'owner'
     and new.workspace_id = old.workspace_id then
    return new;
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended('workspace-owner:' || old.workspace_id::text, 0)
  );

  -- A cascading workspace delete has no remaining owner to preserve.
  if not exists (
    select 1 from public.workspaces as workspace
    where workspace.id = old.workspace_id
  ) then
    if tg_op = 'DELETE' then
      return old;
    end if;
    return new;
  end if;

  if not exists (
    select 1
    from public.workspace_members as other_owner
    where other_owner.workspace_id = old.workspace_id
      and other_owner.role = 'owner'
      and other_owner.id <> old.id
  ) then
    raise exception using
      errcode = 'P0001',
      message = 'A workspace must retain at least one owner';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- 9. Indexes, triggers, row-level security, owner protection, and Realtime.
create index if not exists workspace_members_user_id_idx
  on public.workspace_members (user_id);
create index if not exists workspace_members_workspace_id_idx
  on public.workspace_members (workspace_id);
create index if not exists workspace_invitations_workspace_id_idx
  on public.workspace_invitations (workspace_id);
create index if not exists messaging_cache_workspace_account_last_message_idx
  on public.messaging_cache (workspace_id, social_account_id, last_message_at desc);
create index if not exists whatsapp_deals_workspace_pipeline_stage_position_idx
  on public.whatsapp_deals (workspace_id, pipeline_id, stage_id, position);
create index if not exists whatsapp_deals_contact_id_idx
  on public.whatsapp_deals (contact_id);
create index if not exists whatsapp_pipeline_stages_pipeline_position_idx
  on public.whatsapp_pipeline_stages (pipeline_id, position);

alter table public.workspaces enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invitations enable row level security;
alter table public.whatsapp_pipelines enable row level security;
alter table public.whatsapp_pipeline_stages enable row level security;
alter table public.whatsapp_deals enable row level security;

drop trigger if exists workspaces_set_updated_at on public.workspaces;
create trigger workspaces_set_updated_at
before update on public.workspaces
for each row execute function public.set_whatsapp_workspace_updated_at();

drop trigger if exists workspace_members_set_updated_at on public.workspace_members;
create trigger workspace_members_set_updated_at
before update on public.workspace_members
for each row execute function public.set_whatsapp_workspace_updated_at();

drop trigger if exists whatsapp_pipelines_set_updated_at on public.whatsapp_pipelines;
create trigger whatsapp_pipelines_set_updated_at
before update on public.whatsapp_pipelines
for each row execute function public.set_whatsapp_workspace_updated_at();

drop trigger if exists whatsapp_pipeline_stages_set_updated_at
  on public.whatsapp_pipeline_stages;
create trigger whatsapp_pipeline_stages_set_updated_at
before update on public.whatsapp_pipeline_stages
for each row execute function public.set_whatsapp_workspace_updated_at();

drop trigger if exists whatsapp_deals_set_updated_at on public.whatsapp_deals;
create trigger whatsapp_deals_set_updated_at
before update on public.whatsapp_deals
for each row execute function public.set_whatsapp_workspace_updated_at();

drop trigger if exists workspace_members_protect_last_owner
  on public.workspace_members;
create trigger workspace_members_protect_last_owner
before delete or update of role, workspace_id on public.workspace_members
for each row execute function public.prevent_last_workspace_owner();

-- Workspace policies use SECURITY DEFINER helpers so workspace_members does not
-- recursively invoke its own RLS policy.
drop policy if exists "Workspace members can read workspaces" on public.workspaces;
create policy "Workspace members can read workspaces"
on public.workspaces for select to authenticated
using (public.is_workspace_member(id));

drop policy if exists "Workspace owners and admins can update workspaces" on public.workspaces;
create policy "Workspace owners and admins can update workspaces"
on public.workspaces for update to authenticated
using (public.workspace_role(id) in ('owner', 'admin'))
with check (public.workspace_role(id) in ('owner', 'admin'));

drop policy if exists "Workspace owners can delete workspaces" on public.workspaces;
create policy "Workspace owners can delete workspaces"
on public.workspaces for delete to authenticated
using (public.workspace_role(id) = 'owner');

drop policy if exists "Workspace members can read memberships" on public.workspace_members;
create policy "Workspace members can read memberships"
on public.workspace_members for select to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists "Workspace owners and admins can add memberships" on public.workspace_members;
create policy "Workspace owners and admins can add memberships"
on public.workspace_members for insert to authenticated
with check (public.workspace_role(workspace_id) in ('owner', 'admin'));

drop policy if exists "Workspace owners and admins can update memberships" on public.workspace_members;
create policy "Workspace owners and admins can update memberships"
on public.workspace_members for update to authenticated
using (public.workspace_role(workspace_id) in ('owner', 'admin'))
with check (public.workspace_role(workspace_id) in ('owner', 'admin'));

drop policy if exists "Workspace owners and admins can remove memberships" on public.workspace_members;
create policy "Workspace owners and admins can remove memberships"
on public.workspace_members for delete to authenticated
using (public.workspace_role(workspace_id) in ('owner', 'admin'));

drop policy if exists "Workspace members can read invitations" on public.workspace_invitations;
create policy "Workspace members can read invitations"
on public.workspace_invitations for select to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists "Workspace owners and admins can create invitations" on public.workspace_invitations;
create policy "Workspace owners and admins can create invitations"
on public.workspace_invitations for insert to authenticated
with check (
  public.workspace_role(workspace_id) in ('owner', 'admin')
  and invited_by = auth.uid()
);

drop policy if exists "Workspace owners and admins can update invitations" on public.workspace_invitations;
create policy "Workspace owners and admins can update invitations"
on public.workspace_invitations for update to authenticated
using (public.workspace_role(workspace_id) in ('owner', 'admin'))
with check (public.workspace_role(workspace_id) in ('owner', 'admin'));

drop policy if exists "Workspace owners and admins can delete invitations" on public.workspace_invitations;
create policy "Workspace owners and admins can delete invitations"
on public.workspace_invitations for delete to authenticated
using (public.workspace_role(workspace_id) in ('owner', 'admin'));

drop policy if exists "Workspace members can read pipelines" on public.whatsapp_pipelines;
create policy "Workspace members can read pipelines"
on public.whatsapp_pipelines for select to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists "Workspace owners and admins can create pipelines" on public.whatsapp_pipelines;
create policy "Workspace owners and admins can create pipelines"
on public.whatsapp_pipelines for insert to authenticated
with check (public.workspace_role(workspace_id) in ('owner', 'admin'));

drop policy if exists "Workspace owners and admins can update pipelines" on public.whatsapp_pipelines;
create policy "Workspace owners and admins can update pipelines"
on public.whatsapp_pipelines for update to authenticated
using (public.workspace_role(workspace_id) in ('owner', 'admin'))
with check (public.workspace_role(workspace_id) in ('owner', 'admin'));

drop policy if exists "Workspace owners and admins can delete pipelines" on public.whatsapp_pipelines;
create policy "Workspace owners and admins can delete pipelines"
on public.whatsapp_pipelines for delete to authenticated
using (public.workspace_role(workspace_id) in ('owner', 'admin'));

drop policy if exists "Workspace members can read pipeline stages" on public.whatsapp_pipeline_stages;
create policy "Workspace members can read pipeline stages"
on public.whatsapp_pipeline_stages for select to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists "Workspace owners and admins can create pipeline stages" on public.whatsapp_pipeline_stages;
create policy "Workspace owners and admins can create pipeline stages"
on public.whatsapp_pipeline_stages for insert to authenticated
with check (public.workspace_role(workspace_id) in ('owner', 'admin'));

drop policy if exists "Workspace owners and admins can update pipeline stages" on public.whatsapp_pipeline_stages;
create policy "Workspace owners and admins can update pipeline stages"
on public.whatsapp_pipeline_stages for update to authenticated
using (public.workspace_role(workspace_id) in ('owner', 'admin'))
with check (public.workspace_role(workspace_id) in ('owner', 'admin'));

drop policy if exists "Workspace owners and admins can delete pipeline stages" on public.whatsapp_pipeline_stages;
create policy "Workspace owners and admins can delete pipeline stages"
on public.whatsapp_pipeline_stages for delete to authenticated
using (public.workspace_role(workspace_id) in ('owner', 'admin'));

drop policy if exists "Workspace members can read deals" on public.whatsapp_deals;
create policy "Workspace members can read deals"
on public.whatsapp_deals for select to authenticated
using (public.is_workspace_member(workspace_id));

drop policy if exists "Workspace writers can create deals" on public.whatsapp_deals;
create policy "Workspace writers can create deals"
on public.whatsapp_deals for insert to authenticated
with check (public.workspace_role(workspace_id) in ('owner', 'admin', 'agent'));

drop policy if exists "Workspace writers can update deals" on public.whatsapp_deals;
create policy "Workspace writers can update deals"
on public.whatsapp_deals for update to authenticated
using (public.workspace_role(workspace_id) in ('owner', 'admin', 'agent'))
with check (public.workspace_role(workspace_id) in ('owner', 'admin', 'agent'));

drop policy if exists "Workspace writers can delete deals" on public.whatsapp_deals;
create policy "Workspace writers can delete deals"
on public.whatsapp_deals for delete to authenticated
using (public.workspace_role(workspace_id) in ('owner', 'admin', 'agent'));

-- Replace globally permissive legacy WhatsApp policies with workspace-aware rules.
drop policy if exists "Users can manage own messaging cache" on public.messaging_cache;
drop policy if exists "Workspace members can read WhatsApp conversations" on public.messaging_cache;
create policy "Workspace members can read WhatsApp conversations"
on public.messaging_cache for select to authenticated
using (
  user_id = auth.uid()
  or (platform = 'whatsapp' and public.is_workspace_member(workspace_id))
);
drop policy if exists "Workspace writers can insert WhatsApp conversations" on public.messaging_cache;
create policy "Workspace writers can insert WhatsApp conversations"
on public.messaging_cache for insert to authenticated
with check (
  user_id = auth.uid()
  or (
    platform = 'whatsapp'
    and public.workspace_role(workspace_id) in ('owner', 'admin', 'agent')
  )
);
drop policy if exists "Workspace writers can update WhatsApp conversations" on public.messaging_cache;
create policy "Workspace writers can update WhatsApp conversations"
on public.messaging_cache for update to authenticated
using (
  user_id = auth.uid()
  or (
    platform = 'whatsapp'
    and public.workspace_role(workspace_id) in ('owner', 'admin', 'agent')
  )
)
with check (
  user_id = auth.uid()
  or (
    platform = 'whatsapp'
    and public.workspace_role(workspace_id) in ('owner', 'admin', 'agent')
  )
);
drop policy if exists "Workspace writers can delete WhatsApp conversations" on public.messaging_cache;
create policy "Workspace writers can delete WhatsApp conversations"
on public.messaging_cache for delete to authenticated
using (
  user_id = auth.uid()
  or (
    platform = 'whatsapp'
    and public.workspace_role(workspace_id) in ('owner', 'admin', 'agent')
  )
);

drop policy if exists "Users can view own contacts" on public.whatsapp_contacts;
drop policy if exists "Users can create own contacts" on public.whatsapp_contacts;
drop policy if exists "Users can update own contacts" on public.whatsapp_contacts;
drop policy if exists "Users can delete own contacts" on public.whatsapp_contacts;
drop policy if exists "Workspace members can read contacts" on public.whatsapp_contacts;
create policy "Workspace members can read contacts"
on public.whatsapp_contacts for select to authenticated
using (public.is_workspace_member(workspace_id));
drop policy if exists "Workspace writers can create contacts" on public.whatsapp_contacts;
create policy "Workspace writers can create contacts"
on public.whatsapp_contacts for insert to authenticated
with check (public.workspace_role(workspace_id) in ('owner', 'admin', 'agent'));
drop policy if exists "Workspace writers can update contacts" on public.whatsapp_contacts;
create policy "Workspace writers can update contacts"
on public.whatsapp_contacts for update to authenticated
using (public.workspace_role(workspace_id) in ('owner', 'admin', 'agent'))
with check (public.workspace_role(workspace_id) in ('owner', 'admin', 'agent'));
drop policy if exists "Workspace writers can delete contacts" on public.whatsapp_contacts;
create policy "Workspace writers can delete contacts"
on public.whatsapp_contacts for delete to authenticated
using (public.workspace_role(workspace_id) in ('owner', 'admin', 'agent'));

drop policy if exists "Authenticated users can view agents" on public.whatsapp_agents;
drop policy if exists "Users can manage own agent profile" on public.whatsapp_agents;
drop policy if exists "Users can update own agent profile" on public.whatsapp_agents;
drop policy if exists "Workspace members can read agents" on public.whatsapp_agents;
create policy "Workspace members can read agents"
on public.whatsapp_agents for select to authenticated
using (public.is_workspace_member(workspace_id));
drop policy if exists "Workspace writers can create agents" on public.whatsapp_agents;
create policy "Workspace writers can create agents"
on public.whatsapp_agents for insert to authenticated
with check (
  public.workspace_role(workspace_id) in ('owner', 'admin', 'agent')
  and public.is_workspace_member(workspace_id, user_id)
);
drop policy if exists "Workspace writers can update agents" on public.whatsapp_agents;
create policy "Workspace writers can update agents"
on public.whatsapp_agents for update to authenticated
using (public.workspace_role(workspace_id) in ('owner', 'admin', 'agent'))
with check (
  public.workspace_role(workspace_id) in ('owner', 'admin', 'agent')
  and public.is_workspace_member(workspace_id, user_id)
);
drop policy if exists "Workspace owners and admins can delete agents" on public.whatsapp_agents;
create policy "Workspace owners and admins can delete agents"
on public.whatsapp_agents for delete to authenticated
using (public.workspace_role(workspace_id) in ('owner', 'admin'));

drop policy if exists "Authenticated users can view assignments"
  on public.whatsapp_conversation_assignments;
drop policy if exists "Authenticated users can create assignments"
  on public.whatsapp_conversation_assignments;
drop policy if exists "Authenticated users can update assignments"
  on public.whatsapp_conversation_assignments;
drop policy if exists "Workspace members can read assignments"
  on public.whatsapp_conversation_assignments;
create policy "Workspace members can read assignments"
on public.whatsapp_conversation_assignments for select to authenticated
using (public.is_workspace_member(workspace_id));
drop policy if exists "Workspace writers can create assignments"
  on public.whatsapp_conversation_assignments;
create policy "Workspace writers can create assignments"
on public.whatsapp_conversation_assignments for insert to authenticated
with check (public.workspace_role(workspace_id) in ('owner', 'admin', 'agent'));
drop policy if exists "Workspace writers can update assignments"
  on public.whatsapp_conversation_assignments;
create policy "Workspace writers can update assignments"
on public.whatsapp_conversation_assignments for update to authenticated
using (public.workspace_role(workspace_id) in ('owner', 'admin', 'agent'))
with check (public.workspace_role(workspace_id) in ('owner', 'admin', 'agent'));
drop policy if exists "Workspace writers can delete assignments"
  on public.whatsapp_conversation_assignments;
create policy "Workspace writers can delete assignments"
on public.whatsapp_conversation_assignments for delete to authenticated
using (public.workspace_role(workspace_id) in ('owner', 'admin', 'agent'));

grant select, insert, update, delete on public.workspaces to authenticated;
grant select, insert, update, delete on public.workspace_members to authenticated;
grant select, insert, update, delete on public.workspace_invitations to authenticated;
grant select, insert, update, delete on public.whatsapp_pipelines to authenticated;
grant select, insert, update, delete on public.whatsapp_pipeline_stages to authenticated;
grant select, insert, update, delete on public.whatsapp_deals to authenticated;

revoke all on function public.is_workspace_member(uuid, uuid) from public;
revoke all on function public.workspace_role(uuid, uuid) from public;
revoke all on function public.ensure_personal_workspace(uuid) from public;
revoke all on function public.accept_workspace_invitation(text) from public;
revoke all on function public.create_default_whatsapp_pipeline(uuid) from public;
revoke all on function public.move_whatsapp_deal(uuid, uuid, integer) from public;
grant execute on function public.is_workspace_member(uuid, uuid) to authenticated;
grant execute on function public.workspace_role(uuid, uuid) to authenticated;
grant execute on function public.ensure_personal_workspace(uuid) to authenticated;
grant execute on function public.accept_workspace_invitation(text) to authenticated;
grant execute on function public.create_default_whatsapp_pipeline(uuid) to authenticated;
grant execute on function public.move_whatsapp_deal(uuid, uuid, integer) to authenticated;

do $$
declare
  realtime_table text;
begin
  if not exists (
    select 1 from pg_publication where pubname = 'supabase_realtime'
  ) then
    raise exception 'Publication supabase_realtime does not exist';
  end if;

  foreach realtime_table in array array[
    'whatsapp_pipelines',
    'whatsapp_pipeline_stages',
    'whatsapp_deals'
  ]
  loop
    if not exists (
      select 1
      from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = realtime_table
    ) then
      execute format(
        'alter publication supabase_realtime add table public.%I',
        realtime_table
      );
    end if;
  end loop;
end;
$$;

commit;
