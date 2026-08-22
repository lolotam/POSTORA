create extension if not exists pgtap with schema extensions;

begin;
set local search_path = public, extensions, auth, pg_temp;
select plan(8);

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
values
  ('00000000-0000-0000-0000-000000000000', '40000000-0000-0000-0000-000000000004',
   'authenticated', 'authenticated', 'import-a@example.test', '', now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now()),
  ('00000000-0000-0000-0000-000000000000', '50000000-0000-0000-0000-000000000005',
   'authenticated', 'authenticated', 'import-viewer@example.test', '', now(),
   '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb, now(), now());

-- User A owns two workspaces; the viewer is a read-only member of the second.
insert into public.workspaces (id, name, owner_id, is_personal) values
  ('a0000000-0000-0000-0000-00000000000a', 'Workspace A', '40000000-0000-0000-0000-000000000004', true),
  ('b0000000-0000-0000-0000-00000000000b', 'Workspace B', '40000000-0000-0000-0000-000000000004', false);
insert into public.workspace_members (workspace_id, user_id, role) values
  ('a0000000-0000-0000-0000-00000000000a', '40000000-0000-0000-0000-000000000004', 'owner'),
  ('b0000000-0000-0000-0000-00000000000b', '40000000-0000-0000-0000-000000000004', 'owner'),
  ('b0000000-0000-0000-0000-00000000000b', '50000000-0000-0000-0000-000000000005', 'viewer')
on conflict do nothing;

set local role authenticated;
set local request.jwt.claims =
  '{"sub":"40000000-0000-0000-0000-000000000004","role":"authenticated","email":"import-a@example.test"}';

select results_eq(
  $$select imported_phone, outcome from public.import_whatsapp_contacts_to_workspace(
      'a0000000-0000-0000-0000-00000000000a',
      '[{"phone_number":"96500000001","display_name":"Abu Tork","tags":["vip"]},
        {"phone_number":"96500000002","display_name":"Noor"}]'::jsonb) order by 1$$,
  $$values ('96500000001', 'imported'), ('96500000002', 'imported')$$,
  'a fresh batch is imported into the target workspace'
);
select is(
  (select workspace_id from public.whatsapp_contacts where phone_number = '96500000001'),
  'a0000000-0000-0000-0000-00000000000a'::uuid,
  'the imported contact belongs to the target workspace'
);

select results_eq(
  $$select imported_phone, outcome from public.import_whatsapp_contacts_to_workspace(
      'a0000000-0000-0000-0000-00000000000a',
      '[{"phone_number":"96500000001","display_name":"Abu Tork (updated)"}]'::jsonb)$$,
  $$values ('96500000001', 'imported')$$,
  're-importing into the same workspace updates the existing contact'
);
select is(
  (select display_name from public.whatsapp_contacts where phone_number = '96500000001'),
  'Abu Tork (updated)',
  'the same-workspace re-import applied the new display name'
);

select results_eq(
  $$select imported_phone, outcome from public.import_whatsapp_contacts_to_workspace(
      'b0000000-0000-0000-0000-00000000000b',
      '[{"phone_number":"96500000001","display_name":"Hijacked"},
        {"phone_number":"96500000003","display_name":"Only in B"}]'::jsonb) order by 1$$,
  $$values ('96500000001', 'other_workspace'), ('96500000003', 'imported')$$,
  'a phone already held by another workspace is rejected while the rest import'
);
select is(
  (select workspace_id || '|' || display_name from public.whatsapp_contacts where phone_number = '96500000001'),
  'a0000000-0000-0000-0000-00000000000a|Abu Tork (updated)',
  'the rejected row was neither moved nor modified'
);

reset role;
set local role authenticated;
set local request.jwt.claims =
  '{"sub":"50000000-0000-0000-0000-000000000005","role":"authenticated","email":"import-viewer@example.test"}';

select throws_ok(
  $$select * from public.import_whatsapp_contacts_to_workspace(
      'b0000000-0000-0000-0000-00000000000b',
      '[{"phone_number":"96500000009","display_name":"Viewer"}]'::jsonb)$$,
  '42501', null,
  'a viewer cannot import because the insert policy still applies (security invoker)'
);
select throws_ok(
  $$select * from public.import_whatsapp_contacts_to_workspace(
      'a0000000-0000-0000-0000-00000000000a',
      '[{"phone_number":"96500000009","display_name":"Outsider"}]'::jsonb)$$,
  '42501', null,
  'a non-member cannot import into a workspace they do not belong to'
);

select * from finish();
rollback;
