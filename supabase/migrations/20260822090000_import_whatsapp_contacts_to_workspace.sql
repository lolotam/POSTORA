-- CSV contact import, decided on the conflict instead of read-then-write.
--
-- The uniqueness key on whatsapp_contacts is (user_id, phone_number), which spans
-- workspaces. A client-side "look up, then upsert" could not be made safe: between the
-- two requests another import could move the row, and the upsert would then silently
-- update a contact that belongs to a different workspace. Expressing the rule on the
-- conflict itself makes the whole batch one statement, so there is no window.
--
-- Output columns are named imported_phone/outcome rather than phone_number so they do not
-- shadow the table column inside the plpgsql body.
--
-- Runs as the caller (security invoker): the insert and update policies on
-- whatsapp_contacts still apply, so a viewer cannot import and a member cannot write into
-- a workspace they do not belong to.

create or replace function public.import_whatsapp_contacts_to_workspace(
  p_workspace_id uuid,
  p_rows jsonb
)
returns table(imported_phone text, outcome text)
language plpgsql
security invoker
set search_path = public
as $function$
begin
  return query
  with incoming as (
    select r.*
      from jsonb_to_recordset(p_rows) as r(
        phone_number text, display_name text, first_name text, last_name text,
        email text, company text, job_title text, phone_secondary text,
        street text, city text, country text, birthday text, website text,
        notes text, tags text[], avatar_url text
      )
  ),
  written as (
    insert into whatsapp_contacts (
      user_id, workspace_id, phone_number, display_name, first_name, last_name,
      email, company, job_title, phone_secondary, street, city, country, birthday,
      website, notes, tags, avatar_url
    )
    select auth.uid(), p_workspace_id, i.phone_number, i.display_name, i.first_name, i.last_name,
           i.email, i.company, i.job_title, i.phone_secondary, i.street, i.city, i.country,
           nullif(i.birthday, '')::date, i.website, i.notes, coalesce(i.tags, '{}'), i.avatar_url
      from incoming i
    on conflict (user_id, phone_number) do update
      set display_name = excluded.display_name,
          first_name = excluded.first_name,
          last_name = excluded.last_name,
          email = excluded.email,
          company = excluded.company,
          job_title = excluded.job_title,
          phone_secondary = excluded.phone_secondary,
          street = excluded.street,
          city = excluded.city,
          country = excluded.country,
          birthday = excluded.birthday,
          website = excluded.website,
          notes = excluded.notes,
          tags = excluded.tags,
          avatar_url = coalesce(excluded.avatar_url, whatsapp_contacts.avatar_url),
          updated_at = now()
      -- A row held by another workspace is left untouched and, because the update is
      -- skipped, is absent from RETURNING — that absence is what marks it rejected below.
      where whatsapp_contacts.workspace_id = excluded.workspace_id
    returning whatsapp_contacts.phone_number as written_phone
  )
  select i.phone_number,
         case when w.written_phone is null then 'other_workspace' else 'imported' end
    from incoming i
    left join written w on w.written_phone = i.phone_number;
end;
$function$;

revoke all on function public.import_whatsapp_contacts_to_workspace(uuid, jsonb) from public;
grant execute on function public.import_whatsapp_contacts_to_workspace(uuid, jsonb) to authenticated;
