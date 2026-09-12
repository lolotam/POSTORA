create extension if not exists pgtap with schema extensions;
begin;

set local search_path = public, extensions, auth, pg_temp;
select plan(61);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('00000000-0000-0000-0000-000000000000', '10000000-0000-0000-0000-000000000001',
   'authenticated', 'authenticated', 'rehearsal-a@example.test', '', now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '20000000-0000-0000-0000-000000000002',
   'authenticated', 'authenticated', 'rehearsal-b@example.test', '', now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '30000000-0000-0000-0000-000000000003',
   'authenticated', 'authenticated', 'rehearsal-c@example.test', '', now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now());

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated","email":"rehearsal-a@example.test"}';

select lives_ok(
  $$select public.ensure_personal_workspace('10000000-0000-0000-0000-000000000001')$$,
  'ensure_personal_workspace creates the caller personal workspace'
);
select is(
  public.ensure_personal_workspace('10000000-0000-0000-0000-000000000001'),
  public.ensure_personal_workspace('10000000-0000-0000-0000-000000000001'),
  'ensure_personal_workspace returns the same workspace on repeated calls'
);
select is(
  (select count(*) from public.workspaces
   where owner_id = '10000000-0000-0000-0000-000000000001' and is_personal),
  1::bigint,
  'the caller has exactly one personal workspace'
);
select is(
  (select count(*) from public.workspace_members
   where user_id = '10000000-0000-0000-0000-000000000001' and role = 'owner'),
  1::bigint,
  'the personal workspace has exactly one owner membership'
);

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated","email":"rehearsal-b@example.test"}';
do $$ begin
  perform public.ensure_personal_workspace('20000000-0000-0000-0000-000000000002');
end $$;
reset role;

do $$ begin
  perform set_config('test.workspace_a', (
    select id::text from public.workspaces
    where owner_id = '10000000-0000-0000-0000-000000000001' and is_personal
  ), true);
  perform set_config('test.workspace_b', (
    select id::text from public.workspaces
    where owner_id = '20000000-0000-0000-0000-000000000002' and is_personal
  ), true);
end $$;

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated","email":"rehearsal-a@example.test"}';

select throws_ok(
  $sql$insert into public.workspace_members (workspace_id, user_id, role)
       values (current_setting('test.workspace_a')::uuid,
               '30000000-0000-0000-0000-000000000003', 'superadmin')$sql$,
  '23514', null,
  'workspace membership rejects an unknown role'
);
select throws_ok(
  $sql$insert into public.workspace_invitations
       (workspace_id, email, role, token_hash, invited_by, expires_at)
       values (current_setting('test.workspace_a')::uuid, 'rehearsal-c@example.test',
               'owner', encode(extensions.digest('owner-role-token', 'sha256'), 'hex'),
               '10000000-0000-0000-0000-000000000001', now() + interval '1 day')$sql$,
  '23514', null,
  'workspace invitations cannot grant the owner role'
);

insert into public.workspace_invitations
  (workspace_id, email, role, token_hash, invited_by, expires_at)
values
  (current_setting('test.workspace_a')::uuid, 'REHEARSAL-B@EXAMPLE.TEST', 'agent',
   encode(extensions.digest('expired-token', 'sha256'), 'hex'),
   '10000000-0000-0000-0000-000000000001', now() - interval '1 minute');

set local request.jwt.claims =
  '{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated","email":"rehearsal-b@example.test"}';
select throws_ok(
  $$select public.accept_workspace_invitation('expired-token')$$,
  'P0001', 'Invalid workspace invitation',
  'an expired invitation cannot be accepted'
);

set local request.jwt.claims =
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated","email":"rehearsal-a@example.test"}';
select lives_ok(
  $sql$insert into public.workspace_invitations
       (workspace_id, email, role, token_hash, invited_by, expires_at)
       values (current_setting('test.workspace_a')::uuid, 'rehearsal-b@example.test',
               'agent', encode(extensions.digest('single-use-token', 'sha256'), 'hex'),
               '10000000-0000-0000-0000-000000000001', now() + interval '1 day')$sql$,
  'a new invitation replaces an expired pending invitation for the same email'
);

set local request.jwt.claims =
  '{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated","email":"rehearsal-b@example.test"}';
select is(
  public.accept_workspace_invitation('single-use-token'),
  current_setting('test.workspace_a')::uuid,
  'a valid invitation adds the matching user to the workspace'
);
select throws_ok(
  $$select public.accept_workspace_invitation('single-use-token')$$,
  'P0001', 'Invalid workspace invitation',
  'an accepted invitation cannot be replayed'
);

set local request.jwt.claims =
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated","email":"rehearsal-a@example.test"}';
insert into public.workspace_invitations
  (workspace_id, email, role, token_hash, invited_by, expires_at)
values
  (current_setting('test.workspace_a')::uuid, 'rehearsal-c@example.test', 'viewer',
   encode(extensions.digest('mismatched-email-token', 'sha256'), 'hex'),
   '10000000-0000-0000-0000-000000000001', now() + interval '1 day');

set local request.jwt.claims =
  '{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated","email":"rehearsal-b@example.test"}';
select throws_ok(
  $$select public.accept_workspace_invitation('mismatched-email-token')$$,
  'P0001', 'Invalid workspace invitation',
  'an invitation cannot be accepted by a different email address'
);

set local request.jwt.claims =
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated","email":"rehearsal-a@example.test"}';
select ok(
  public.create_default_whatsapp_pipeline(current_setting('test.workspace_a')::uuid) is not null,
  'create_default_whatsapp_pipeline returns a pipeline id'
);
do $$ begin
  perform set_config('test.pipeline_a', (
    select id::text from public.whatsapp_pipelines
    where workspace_id = current_setting('test.workspace_a')::uuid and is_default
  ), true);
  perform set_config('test.stage_a_new', (
    select id::text from public.whatsapp_pipeline_stages
    where pipeline_id = current_setting('test.pipeline_a')::uuid and position = 0
  ), true);
  perform set_config('test.stage_a_won', (
    select id::text from public.whatsapp_pipeline_stages
    where pipeline_id = current_setting('test.pipeline_a')::uuid and stage_type = 'won'
  ), true);
end $$;
select is(
  (select count(*) from public.whatsapp_pipelines
   where workspace_id = current_setting('test.workspace_a')::uuid and is_default),
  1::bigint, 'a workspace has one default pipeline'
);
select is(
  (select count(*) from public.whatsapp_pipeline_stages
   where pipeline_id = current_setting('test.pipeline_a')::uuid),
  5::bigint, 'the default pipeline contains five stages'
);
select is(
  (select array_agg(stage_type order by position) from public.whatsapp_pipeline_stages
   where pipeline_id = current_setting('test.pipeline_a')::uuid),
  array['open', 'open', 'open', 'won', 'lost']::text[],
  'the default stages have semantic open, won, and lost types'
);
select is(
  public.create_default_whatsapp_pipeline(current_setting('test.workspace_a')::uuid),
  current_setting('test.pipeline_a')::uuid,
  'creating the default pipeline twice returns the existing pipeline'
);
select is(
  (select count(*) from public.whatsapp_pipeline_stages
   where pipeline_id = current_setting('test.pipeline_a')::uuid),
  5::bigint, 'creating the default pipeline twice does not duplicate stages'
);

set local request.jwt.claims =
  '{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated","email":"rehearsal-b@example.test"}';
do $$ begin
  perform public.create_default_whatsapp_pipeline(current_setting('test.workspace_b')::uuid);
  perform set_config('test.pipeline_b', (
    select id::text from public.whatsapp_pipelines
    where workspace_id = current_setting('test.workspace_b')::uuid and is_default
  ), true);
  perform set_config('test.stage_b_new', (
    select id::text from public.whatsapp_pipeline_stages
    where pipeline_id = current_setting('test.pipeline_b')::uuid and position = 0
  ), true);
end $$;
select lives_ok(
  $sql$insert into public.whatsapp_agents
       (id, workspace_id, user_id, display_name, status)
       values
       ('61000000-0000-0000-0000-000000000001', current_setting('test.workspace_a')::uuid,
        '20000000-0000-0000-0000-000000000002', 'Rehearsal B in workspace A', 'online'),
       ('61000000-0000-0000-0000-000000000002', current_setting('test.workspace_b')::uuid,
        '20000000-0000-0000-0000-000000000002', 'Rehearsal B in workspace B', 'online')$sql$,
  'one user can have an agent record in more than one workspace'
);
select is(
  (select count(*) from public.whatsapp_agents
   where user_id = '20000000-0000-0000-0000-000000000002'),
  2::bigint, 'agent uniqueness is scoped by workspace and user'
);

reset role;
insert into public.social_accounts
  (id, user_id, workspace_id, platform, platform_user_id, platform_username, access_token)
values
  ('41000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
   current_setting('test.workspace_a')::uuid, 'whatsapp', 'rehearsal-account-a', 'rehearsal_a', 'rehearsal-token-a'),
  ('41000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002',
   current_setting('test.workspace_b')::uuid, 'whatsapp', 'rehearsal-account-b', 'rehearsal_b', 'rehearsal-token-b');
insert into public.whatsapp_contacts
  (id, user_id, workspace_id, phone_number, display_name)
values
  ('51000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
   current_setting('test.workspace_a')::uuid, '+15550000001', 'Rehearsal Contact A'),
  ('51000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002',
   current_setting('test.workspace_b')::uuid, '+15550000002', 'Rehearsal Contact B');
insert into public.messaging_cache
  (id, user_id, workspace_id, social_account_id, platform, conversation_id,
   participant_name, participant_id)
values
  ('91000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001',
   current_setting('test.workspace_a')::uuid, '41000000-0000-0000-0000-000000000001',
   'whatsapp', 'wa_rehearsal_a_15550000001', 'Rehearsal Contact A', '15550000001'),
  ('91000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000002',
   current_setting('test.workspace_b')::uuid, '41000000-0000-0000-0000-000000000002',
   'whatsapp', 'wa_rehearsal_b_15550000002', 'Rehearsal Contact B', '15550000002');

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated","email":"rehearsal-a@example.test"}';
insert into public.whatsapp_pipelines (id, workspace_id, name, is_default)
values ('81000000-0000-0000-0000-000000000001',
        current_setting('test.workspace_a')::uuid, 'Alternate Pipeline', false);
insert into public.whatsapp_pipeline_stages
  (id, workspace_id, pipeline_id, name, position, stage_type)
values ('82000000-0000-0000-0000-000000000001',
        current_setting('test.workspace_a')::uuid,
        '81000000-0000-0000-0000-000000000001', 'Alternate Stage', 0, 'open');

select throws_ok(
  $sql$insert into public.whatsapp_deals
       (workspace_id, pipeline_id, stage_id, contact_id, title)
       values (current_setting('test.workspace_a')::uuid,
               current_setting('test.pipeline_a')::uuid,
               current_setting('test.stage_a_new')::uuid,
               '51000000-0000-0000-0000-000000000002',
               'Cross-workspace contact must fail')$sql$,
  '23503', null,
  'a deal cannot reference a contact from another workspace'
);
select throws_ok(
  $sql$insert into public.whatsapp_deals
       (workspace_id, pipeline_id, stage_id, title)
       values (current_setting('test.workspace_a')::uuid,
               current_setting('test.pipeline_a')::uuid,
               current_setting('test.stage_a_new')::uuid,
               'Missing contact must fail')$sql$,
  '23502', null,
  'a deal cannot be created without contact_id'
);

reset role;
insert into public.whatsapp_deals
  (id, workspace_id, pipeline_id, stage_id, contact_id, conversation_cache_id, title, position)
values
  ('71000000-0000-0000-0000-000000000001', current_setting('test.workspace_a')::uuid,
   current_setting('test.pipeline_a')::uuid, current_setting('test.stage_a_new')::uuid,
   '51000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', 'Move me', 1),
  ('71000000-0000-0000-0000-000000000002', current_setting('test.workspace_a')::uuid,
   current_setting('test.pipeline_a')::uuid, current_setting('test.stage_a_new')::uuid,
   '51000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', 'Source zero', 0),
  ('71000000-0000-0000-0000-000000000003', current_setting('test.workspace_a')::uuid,
   current_setting('test.pipeline_a')::uuid, current_setting('test.stage_a_new')::uuid,
   '51000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', 'Source two', 2),
  ('71000000-0000-0000-0000-000000000004', current_setting('test.workspace_a')::uuid,
   current_setting('test.pipeline_a')::uuid, current_setting('test.stage_a_won')::uuid,
   '51000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', 'Won zero', 0),
  ('71000000-0000-0000-0000-000000000005', current_setting('test.workspace_a')::uuid,
   current_setting('test.pipeline_a')::uuid, current_setting('test.stage_a_won')::uuid,
   '51000000-0000-0000-0000-000000000001', '91000000-0000-0000-0000-000000000001', 'Won one', 1),
  ('71000000-0000-0000-0000-000000000006', current_setting('test.workspace_b')::uuid,
   current_setting('test.pipeline_b')::uuid, current_setting('test.stage_b_new')::uuid,
   '51000000-0000-0000-0000-000000000002', '91000000-0000-0000-0000-000000000002', 'Workspace B hidden deal', 0);

select is(
  (select count(*) from public.whatsapp_deals
   where workspace_id = current_setting('test.workspace_b')::uuid),
  1::bigint,
  'the cross-workspace RLS fixture exists before assuming authenticated'
);
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated","email":"rehearsal-a@example.test"}';
set local row_security = on;
select is(
  (select count(*) from public.whatsapp_deals
   where workspace_id = current_setting('test.workspace_b')::uuid),
  0::bigint,
  'a real authenticated member of workspace A cannot select workspace B deals'
);

select lives_ok(
  $$select public.move_whatsapp_deal(
       '71000000-0000-0000-0000-000000000001',
       current_setting('test.stage_a_won')::uuid, 1)$$,
  'move_whatsapp_deal moves a deal atomically'
);
select is(
  (select stage_id from public.whatsapp_deals
   where id = '71000000-0000-0000-0000-000000000001'),
  current_setting('test.stage_a_won')::uuid,
  'the moved deal points at the destination stage'
);
select is(
  (select position from public.whatsapp_deals
   where id = '71000000-0000-0000-0000-000000000001'),
  1,
  'the moved deal receives the requested destination position'
);
select is(
  (select status from public.whatsapp_deals
   where id = '71000000-0000-0000-0000-000000000001'),
  'won',
  'the moved deal status follows the destination semantic stage type'
);
select is(
  (select array_agg(position order by position) from public.whatsapp_deals
   where stage_id = current_setting('test.stage_a_new')::uuid),
  array[0, 1]::integer[],
  'the source stage positions are contiguous after a move'
);
select is(
  (select array_agg(position order by position) from public.whatsapp_deals
   where stage_id = current_setting('test.stage_a_won')::uuid),
  array[0, 1, 2]::integer[],
  'the destination stage positions are contiguous after a move'
);
select is(
  (select position from public.whatsapp_deals
   where id = '71000000-0000-0000-0000-000000000005'),
  2,
  'a destination sibling is shifted to make room for the moved deal'
);
select throws_ok(
  $$select public.move_whatsapp_deal(
       '71000000-0000-0000-0000-000000000001',
       '82000000-0000-0000-0000-000000000001', 0)$$,
  'P0001', 'Target stage must belong to the deal pipeline and workspace',
  'a deal cannot move to a stage from another pipeline'
);

set local request.jwt.claims =
  '{"sub":"20000000-0000-0000-0000-000000000002","role":"authenticated","email":"rehearsal-b@example.test"}';
select throws_ok(
  $sql$update public.workspace_members set role = 'agent'
       where workspace_id = current_setting('test.workspace_b')::uuid
         and user_id = '20000000-0000-0000-0000-000000000002'$sql$,
  'P0001', 'A workspace must retain at least one owner',
  'the only owner cannot be demoted'
);
select throws_ok(
  $sql$delete from public.workspace_members
       where workspace_id = current_setting('test.workspace_b')::uuid
         and user_id = '20000000-0000-0000-0000-000000000002'$sql$,
  'P0001', 'A workspace must retain at least one owner',
  'the only owner cannot be removed'
);

-- ---------------------------------------------------------------------------
-- Cross-workspace isolation matrix.
--
-- Until now only whatsapp_deals had a negative authenticated-role test. Tenancy
-- is load-bearing on production data, so every RLS-protected table gets one.
--
-- Each pair asserts twice: first as the table owner (RLS bypassed) that the
-- workspace-B row genuinely EXISTS, then as authenticated user A that it is
-- invisible. Without the first assertion a typo'd id would make the second pass
-- for the wrong reason.
-- ---------------------------------------------------------------------------
reset role;

-- Agent 61000000-...-0002 (user B in workspace B) already exists from the
-- workspace-scoped uniqueness test above; reuse it rather than colliding with
-- the UNIQUE (workspace_id, user_id) constraint.
insert into public.whatsapp_conversation_assignments
  (id, workspace_id, conversation_id, conversation_cache_id, agent_id)
values ('a3000000-0000-0000-0000-000000000002', current_setting('test.workspace_b')::uuid,
        'wa_rehearsal_b_15550000002', '91000000-0000-0000-0000-000000000002',
        '61000000-0000-0000-0000-000000000002');
insert into public.workspace_invitations
  (id, workspace_id, email, role, token_hash, expires_at)
values ('a4000000-0000-0000-0000-000000000002', current_setting('test.workspace_b')::uuid,
        'outsider-b@example.test', 'agent', repeat('b', 64), now() + interval '7 days');

-- Superuser preconditions: prove each workspace-B row is really there.
select is((select count(*) from public.workspaces
           where id = current_setting('test.workspace_b')::uuid), 1::bigint,
          'precondition: workspace B exists');
select is((select count(*) from public.workspace_members
           where workspace_id = current_setting('test.workspace_b')::uuid), 1::bigint,
          'precondition: workspace B has a member');
select is((select count(*) from public.workspace_invitations
           where workspace_id = current_setting('test.workspace_b')::uuid), 1::bigint,
          'precondition: workspace B has a pending invitation');
select is((select count(*) from public.whatsapp_pipelines
           where workspace_id = current_setting('test.workspace_b')::uuid), 1::bigint,
          'precondition: workspace B has a pipeline');
select is((select count(*) from public.whatsapp_pipeline_stages
           where workspace_id = current_setting('test.workspace_b')::uuid) > 0, true,
          'precondition: workspace B has stages');
select is((select count(*) from public.whatsapp_contacts
           where workspace_id = current_setting('test.workspace_b')::uuid), 1::bigint,
          'precondition: workspace B has a contact');
select is((select count(*) from public.messaging_cache
           where workspace_id = current_setting('test.workspace_b')::uuid), 1::bigint,
          'precondition: workspace B has a conversation');
select is((select count(*) from public.whatsapp_agents
           where workspace_id = current_setting('test.workspace_b')::uuid), 1::bigint,
          'precondition: workspace B has an agent');
select is((select count(*) from public.whatsapp_conversation_assignments
           where workspace_id = current_setting('test.workspace_b')::uuid), 1::bigint,
          'precondition: workspace B has an assignment');

-- Now become user A, an outsider to workspace B.
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated","email":"rehearsal-a@example.test"}';
set local row_security = on;

select is((select count(*) from public.workspaces
           where id = current_setting('test.workspace_b')::uuid), 0::bigint,
          'an outsider cannot read another workspace');
select is((select count(*) from public.workspace_members
           where workspace_id = current_setting('test.workspace_b')::uuid), 0::bigint,
          'an outsider cannot enumerate another workspace member list');
select is((select count(*) from public.workspace_invitations
           where workspace_id = current_setting('test.workspace_b')::uuid), 0::bigint,
          'an outsider cannot read another workspace invitations');
select is((select count(*) from public.whatsapp_pipelines
           where workspace_id = current_setting('test.workspace_b')::uuid), 0::bigint,
          'an outsider cannot read another workspace pipelines');
select is((select count(*) from public.whatsapp_pipeline_stages
           where workspace_id = current_setting('test.workspace_b')::uuid), 0::bigint,
          'an outsider cannot read another workspace pipeline stages');
select is((select count(*) from public.whatsapp_contacts
           where workspace_id = current_setting('test.workspace_b')::uuid), 0::bigint,
          'an outsider cannot read another workspace contacts');
select is((select count(*) from public.messaging_cache
           where workspace_id = current_setting('test.workspace_b')::uuid), 0::bigint,
          'an outsider cannot read another workspace conversations');
select is((select count(*) from public.whatsapp_agents
           where workspace_id = current_setting('test.workspace_b')::uuid), 0::bigint,
          'an outsider cannot read another workspace agents');
select is((select count(*) from public.whatsapp_conversation_assignments
           where workspace_id = current_setting('test.workspace_b')::uuid), 0::bigint,
          'an outsider cannot read another workspace assignments');

-- Writes must be refused too, not merely hidden. A silently-swallowed insert
-- would let an outsider seed rows into a tenant they cannot see.
select throws_ok(
  $sql$insert into public.whatsapp_contacts
         (user_id, workspace_id, phone_number, display_name)
       values ('10000000-0000-0000-0000-000000000001',
               current_setting('test.workspace_b')::uuid, '+15550009999', 'Intruder')$sql$,
  '42501', null,
  'an outsider cannot insert a contact into another workspace'
);

reset role;

-- ---------------------------------------------------------------------------
-- Backfill reconcile + agent FK action (20260910140000 defect B,
-- 20260910160000 defect C).
--
-- Defect B shape: two agents in workspace A, two ACTIVE NULL-workspace
-- assignments on one conversation. Legal before the backfill (NULLs are
-- distinct in idx_active_assignment), a 23505 after it. The migration is
-- already applied by the time suites run, so the reconcile+backfill
-- statements are re-executed here verbatim (copied from the migration) and
-- the outcome is asserted: one row closed, one backfilled, index holds.
-- ---------------------------------------------------------------------------
insert into public.whatsapp_agents
  (id, workspace_id, user_id, display_name, status)
values
  ('62000000-0000-0000-0000-000000000001', current_setting('test.workspace_a')::uuid,
   '10000000-0000-0000-0000-000000000001', 'Backfill Agent One', 'online'),
  ('62000000-0000-0000-0000-000000000002', current_setting('test.workspace_a')::uuid,
   '30000000-0000-0000-0000-000000000003', 'Backfill Agent Two', 'online');
insert into public.whatsapp_conversation_assignments
  (id, workspace_id, conversation_id, agent_id, assigned_at, notes)
values
  ('b1000000-0000-0000-0000-000000000001', NULL, 'wa_backfill_dup_rehearsal',
   '62000000-0000-0000-0000-000000000001', now() - interval '1 hour', NULL),
  ('b1000000-0000-0000-0000-000000000002', NULL, 'wa_backfill_dup_rehearsal',
   '62000000-0000-0000-0000-000000000002', now(), NULL);

-- Re-executed verbatim from 20260910140000_human_agent_tenancy.sql.
do $$
declare
  closed_count bigint;
begin
  with target as (
    select assignment.id,
      agent.workspace_id as target_workspace_id,
      assignment.conversation_id,
      row_number() over (
        partition by agent.workspace_id, assignment.conversation_id
        order by assignment.assigned_at desc nulls last, assignment.id desc
      ) as recency_rank,
      exists (
        select 1 from public.whatsapp_conversation_assignments as attributed
        where attributed.workspace_id = agent.workspace_id
          and attributed.conversation_id = assignment.conversation_id
          and attributed.unassigned_at is null
      ) as collides_with_attributed
    from public.whatsapp_conversation_assignments as assignment
    join public.whatsapp_agents as agent on agent.id = assignment.agent_id
    where assignment.workspace_id is null
      and assignment.unassigned_at is null
      and assignment.agent_id is not null
  ),
  closed as (
    update public.whatsapp_conversation_assignments as assignment
    set unassigned_at = now(),
        notes = coalesce(assignment.notes, 'backfill_duplicate')
    from target
    where assignment.id = target.id
      and (target.recency_rank > 1 or target.collides_with_attributed)
    returning assignment.id
  )
  select count(*) into closed_count from closed;

  raise notice 'Human-agent backfill: closed % duplicate NULL-workspace active assignment(s)', closed_count;
end;
$$;

-- Re-executed verbatim from 20260910140000_human_agent_tenancy.sql.
update public.whatsapp_conversation_assignments as assignment
set workspace_id = agent.workspace_id
from public.whatsapp_agents as agent
where assignment.workspace_id is null
  and assignment.agent_id = agent.id;

select is(
  (select count(*) from public.whatsapp_conversation_assignments
   where conversation_id = 'wa_backfill_dup_rehearsal' and unassigned_at is not null),
  1::bigint,
  'the reconcile closes exactly one duplicate NULL-workspace assignment'
);
select is(
  (select workspace_id from public.whatsapp_conversation_assignments
   where id = 'b1000000-0000-0000-0000-000000000002'),
  current_setting('test.workspace_a')::uuid,
  'the surviving (newest) assignment is backfilled to the agents workspace'
);
select is(
  (select notes from public.whatsapp_conversation_assignments
   where id = 'b1000000-0000-0000-0000-000000000001'),
  'backfill_duplicate',
  'the closed duplicate is marked without touching other columns'
);
select is(
  (select count(*) from (
    select workspace_id, conversation_id
    from public.whatsapp_conversation_assignments
    where unassigned_at is null and workspace_id is not null
    group by workspace_id, conversation_id having count(*) > 1
  ) t),
  0::bigint,
  'post-migration invariant: no (workspace, conversation) pair has two active rows'
);

-- Defect C: the assignments agent FK must be ON DELETE NO ACTION
-- (confdeltype 'a'); the two history FKs stay SET NULL ('n').
select is(
  (select confdeltype::text from pg_constraint
   where conrelid = 'public.whatsapp_conversation_assignments'::regclass
     and confrelid = 'public.whatsapp_agents'::regclass
     and contype = 'f'),
  'a',
  'the conversation-assignment agent FK is ON DELETE NO ACTION'
);
select is(
  (select confdeltype::text from pg_constraint
   where conname = 'whatsapp_assignment_history_from_agent_id_fkey'),
  'n',
  'the history from_agent FK stays ON DELETE SET NULL'
);
select is(
  (select confdeltype::text from pg_constraint
   where conname = 'whatsapp_assignment_history_to_agent_id_fkey'),
  'n',
  'the history to_agent FK stays ON DELETE SET NULL'
);
insert into public.whatsapp_agents
  (id, workspace_id, user_id, display_name, status)
values
  ('63000000-0000-0000-0000-000000000001', current_setting('test.workspace_b')::uuid,
   '10000000-0000-0000-0000-000000000001', 'Nodelete Agent', 'online');
insert into public.whatsapp_conversation_assignments
  (workspace_id, conversation_id, agent_id)
values
  (current_setting('test.workspace_b')::uuid, 'wa_nodelete_rehearsal',
   '63000000-0000-0000-0000-000000000001');
select throws_ok(
  $sql$delete from public.whatsapp_agents
       where id = '63000000-0000-0000-0000-000000000001'$sql$,
  '23503', null,
  'deleting an agent with an active assignment is refused'
);

-- 61. The history INSERT policy binds a named workspace to the author's
-- membership (20260910140000): performed_by alone let any user stamp any
-- workspace_id, which the partner assignment-history endpoint then served.
select ok(
  (select with_check from pg_policies
    where schemaname = 'public' and tablename = 'whatsapp_assignment_history'
      and policyname = 'Users can create history entries' and cmd = 'INSERT')
    ~* 'workspace_members',
  'history INSERT policy requires membership of the named workspace'
);

select * from finish();
rollback;
