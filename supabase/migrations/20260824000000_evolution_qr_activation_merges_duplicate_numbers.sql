-- A QR connection is created before the phone is known, so its row starts life with a
-- provisional platform_user_id of 'pending_<uuid>' and only takes on the real number when
-- Evolution reports the session open. social_accounts is UNIQUE on
-- (user_id, platform, platform_user_id), so re-pairing a phone that already has a row for
-- the same user made that claim raise 23505. The edge function discarded the error, and the
-- connection stayed inactive on a pending_ id forever with nothing logged.
--
-- Resolving the collision means moving the older session's messages, releasing its key and
-- claiming the number, which must be one transaction: a half-applied merge would leave two
-- rows fighting over the same conversation ids (whatsapp_messages.conversation_id is
-- 'wa_<owner>_<contact>', derived from the number, not from the account id). PostgREST
-- cannot express that, so the rule lives here.

create or replace function public.activate_evolution_qr_account(
  p_account_id uuid,
  p_owner_number text
) returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_current text;
  v_duplicate_id uuid;
begin
  -- Every other connection mode stores digits, and the inbox parses that form back out of
  -- the conversation id. A malformed value would be unparseable rather than merely wrong.
  if p_owner_number !~ '^\d{5,}$' then
    raise exception 'activate_evolution_qr_account: owner number must be digits only'
      using errcode = '22023';
  end if;

  select user_id, platform_user_id
    into v_user_id, v_current
    from social_accounts
   where id = p_account_id
     and platform = 'whatsapp'
   for update;

  if not found then
    raise exception 'activate_evolution_qr_account: whatsapp account % not found', p_account_id
      using errcode = 'P0002';
  end if;

  -- A reconnect of the session that already owns this number: nothing to reconcile.
  if v_current = p_owner_number then
    update social_accounts set is_active = true where id = p_account_id;
    return p_owner_number;
  end if;

  -- Re-pairing a *different* number onto an established row is a separate hazard: the
  -- conversations already written under the old number would be orphaned by a silent
  -- rewrite. The caller flags account_metadata.number_mismatch for that case; identity is
  -- deliberately left alone here.
  if v_current not like 'pending\_%' then
    update social_accounts set is_active = true where id = p_account_id;
    return v_current;
  end if;

  -- Two provisional rows for the same user can reach this point at the same moment, each
  -- holding only its own row lock, each finding no duplicate, and the second final update
  -- would then fail with 23505 -- the very collision this function exists to resolve. The
  -- claim is therefore serialized per (user, number). hashtextextended is used rather than
  -- hashtext because the single-argument advisory lock takes a bigint. The loser of the race
  -- runs second, finds the winner as its duplicate and retires it: newest pairing wins, which
  -- is the same rule the merge below applies.
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':' || p_owner_number, 0));

  select id
    into v_duplicate_id
    from social_accounts
   where user_id = v_user_id
     and platform = 'whatsapp'
     and platform_user_id = p_owner_number
     and id <> p_account_id
   for update;

  if v_duplicate_id is not null then
    -- whatsapp_messages is unique on (user_id, message_id), not on the account, so moving a
    -- sibling row's messages within the same user cannot conflict. The freshly paired row is
    -- the one that survives: it holds the live Evolution instance and the name the user chose.
    update whatsapp_messages
       set social_account_id = p_account_id
     where social_account_id = v_duplicate_id;

    -- The inbox lists conversations by social_account_id, so leaving messaging_cache behind
    -- strands every imported chat on the retired row: the account shows an empty inbox even
    -- though its messages moved. A re-sweep cannot repair it either, because
    -- import_whatsapp_conversations only advances a row when the incoming last_message_at is
    -- strictly newer, and re-importing unchanged history never is. Moving the rows rather than
    -- replacing them is what keeps their deals, assignments and labels attached: those foreign
    -- keys reference (id, workspace_id), neither of which this touches. No collision is
    -- possible -- messaging_cache is unique on (user_id, conversation_id) and both rows belong
    -- to the same user, so a conversation exists on exactly one of them.
    update messaging_cache
       set social_account_id = p_account_id
     where social_account_id = v_duplicate_id;

    -- Same defect class, same fix: whatsapp-scheduled-sender joins social_accounts through
    -- this column for the sending platform_user_id, and a retired row hands it
    -- 'retired_<uuid>' -- not a number anything can send from.
    update whatsapp_scheduled_messages
       set social_account_id = p_account_id
     where social_account_id = v_duplicate_id;

    -- whatsapp_evolution_instances is keyed by social_account_id, one session per account.
    -- The merged-away row must not keep a pointer to a session it no longer owns.
    delete from whatsapp_evolution_instances where social_account_id = v_duplicate_id;

    -- The row is retired rather than deleted: social_accounts is the cascade parent of
    -- platform_posts, social_inbox_events and partner_api_keys, so deleting it to free the
    -- unique key would destroy history that has nothing to do with this pairing. The
    -- 'retired_' prefix mirrors the existing 'pending_' placeholder and never parses as a
    -- phone number.
    update social_accounts
       set platform_user_id = 'retired_' || v_duplicate_id::text,
           is_active = false
     where id = v_duplicate_id;
  end if;

  update social_accounts
     set platform_user_id = p_owner_number,
         is_active = true
   where id = p_account_id;

  return p_owner_number;
end;
$$;

-- Activation runs only from the service-role edge functions (the connection.update webhook
-- and the QR status poller). No end-user role may claim an identity or retire a sibling row.
revoke all on function public.activate_evolution_qr_account(uuid, text) from public;
revoke all on function public.activate_evolution_qr_account(uuid, text) from anon;
revoke all on function public.activate_evolution_qr_account(uuid, text) from authenticated;
grant execute on function public.activate_evolution_qr_account(uuid, text) to service_role;
