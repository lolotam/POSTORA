-- Conflict rules for the history sweep.
--
-- These were previously expressed as read-then-upsert in the edge function, which lost
-- three ways: the read could not see a row in another workspace, a live webhook could
-- advance a conversation between the read and the write, and a blanket merge overwrote
-- richer live values with the nulls a historical record carries. Postgres can express all
-- three conditions directly on the conflict, so it does.

create or replace function public.import_whatsapp_conversations(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $function$
declare
  affected integer;
begin
  insert into messaging_cache (
    user_id, workspace_id, social_account_id, conversation_id, platform,
    participant_name, participant_avatar, last_message_preview, last_message_at,
    unread_count, updated_at
  )
  select r.user_id, r.workspace_id, r.social_account_id, r.conversation_id, 'whatsapp',
         r.participant_name, r.participant_avatar, r.last_message_preview, r.last_message_at,
         r.unread_count, now()
    from jsonb_to_recordset(p_rows) as r(
      user_id uuid, workspace_id uuid, social_account_id uuid, conversation_id text,
      participant_name text, participant_avatar text, last_message_preview text,
      last_message_at timestamptz, unread_count integer
    )
  on conflict (user_id, conversation_id) do update
    set participant_name = coalesce(excluded.participant_name, messaging_cache.participant_name),
        participant_avatar = coalesce(excluded.participant_avatar, messaging_cache.participant_avatar),
        last_message_preview = excluded.last_message_preview,
        last_message_at = excluded.last_message_at,
        social_account_id = excluded.social_account_id,
        updated_at = now()
    -- Only a genuinely newer record may advance a conversation, so a sweep running
    -- alongside live traffic cannot walk the inbox backwards. unread_count is absent on
    -- purpose: Evolution reports zero for every chat and must never clear real unread state.
    where excluded.last_message_at > messaging_cache.last_message_at;
  get diagnostics affected = row_count;
  return affected;
end;
$function$;

create or replace function public.import_whatsapp_contacts(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $function$
declare
  affected integer;
begin
  insert into whatsapp_contacts (
    user_id, workspace_id, phone_number, display_name, avatar_url, last_message_at
  )
  select r.user_id, r.workspace_id, r.phone_number, r.display_name, r.avatar_url, r.last_message_at
    from jsonb_to_recordset(p_rows) as r(
      user_id uuid, workspace_id uuid, phone_number text, display_name text,
      avatar_url text, last_message_at timestamptz
    )
  -- The uniqueness key is (user_id, phone_number), which spans workspaces. Matching that
  -- exactly is what stops a sweep from adopting the same user's contact out of another
  -- workspace. workspace_id is deliberately not updated for the same reason.
  on conflict (user_id, phone_number) do update
    set display_name = excluded.display_name,
        avatar_url = coalesce(excluded.avatar_url, whatsapp_contacts.avatar_url),
        last_message_at = greatest(excluded.last_message_at, whatsapp_contacts.last_message_at),
        updated_at = now()
    -- A name the user typed outranks whatever WhatsApp reports.
    where whatsapp_contacts.display_name is null
       or whatsapp_contacts.display_name = whatsapp_contacts.phone_number;
  get diagnostics affected = row_count;
  return affected;
end;
$function$;

create or replace function public.import_whatsapp_messages(p_rows jsonb)
returns integer
language plpgsql
security definer
set search_path = public
as $function$
declare
  affected integer;
begin
  insert into whatsapp_messages (
    user_id, social_account_id, conversation_id, message_id, from_phone, from_name,
    to_phone, message_text, message_type, media_url, media_type, media_metadata,
    direction, status, timestamp
  )
  select r.user_id, r.social_account_id, r.conversation_id, r.message_id, r.from_phone,
         r.from_name, r.to_phone, r.message_text, r.message_type, r.media_url, r.media_type,
         r.media_metadata, r.direction, r.status, r.timestamp
    from jsonb_to_recordset(p_rows) as r(
      user_id uuid, social_account_id uuid, conversation_id text, message_id text,
      from_phone text, from_name text, to_phone text, message_text text, message_type text,
      media_url text, media_type text, media_metadata jsonb, direction text, status text,
      timestamp timestamptz
    )
  -- Rebinding only. Relinking the same WhatsApp identity under a new social_accounts row
  -- has to move its history onto the new account, or the inbox -- which filters messages by
  -- account -- shows the rebuilt conversations as empty. Nothing else is touched: a stored
  -- message may already carry values a historical record does not, such as the media_url an
  -- outbound send recorded, and a sweep must not erase them.
  on conflict (user_id, message_id) do update
    set social_account_id = excluded.social_account_id,
        conversation_id = excluded.conversation_id;
  get diagnostics affected = row_count;
  return affected;
end;
$function$;

do $grants$
declare
  fn text;
begin
  foreach fn in array array[
    'public.import_whatsapp_conversations(jsonb)',
    'public.import_whatsapp_contacts(jsonb)',
    'public.import_whatsapp_messages(jsonb)'
  ] loop
    execute format('revoke all on function %s from public', fn);
    execute format('revoke all on function %s from anon', fn);
    execute format('revoke all on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end;
$grants$;
