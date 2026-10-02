-- WhatsApp account continuity, PR-BC (spec 2026-10-01 §5.4). Redefines
-- activate_evolution_qr_account from 20260824000000 verbatim except:
--   1. the per-user ':wa-setup' advisory lock is taken before the per-number lock;
--   2. the retired duplicate keeps its number in account_metadata.retired_number;
--   3. the surviving row claims the number before the setup mover runs (the mover
--      refuses a pending_ destination);
--   4. move_whatsapp_account_setup(duplicate, survivor, 'auto') carries the AI agent setup;
--   5. the final claim runs only when there was no duplicate (it already ran above).
-- Requires 20261004110500_move_whatsapp_account_setup.sql.

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
  v_workspace_id uuid;
  v_duplicate_id uuid;
  v_duplicate_workspace_id uuid;
begin
  -- Every other connection mode stores digits, and the inbox parses that form back out of
  -- the conversation id. A malformed value would be unparseable rather than merely wrong.
  if p_owner_number !~ '^\d{5,}$' then
    raise exception 'activate_evolution_qr_account: owner number must be digits only'
      using errcode = '22023';
  end if;

  -- The owner is read WITHOUT a row lock first, only to key the advisory lock below. Taking
  -- any row lock before the advisory lock would give the two locks no fixed order across
  -- concurrent claims, and an ordering that depends on which rows a claim happens to touch is
  -- how 40P01 deadlocks appear later, when the duplicate lookup's filter changes and starts
  -- matching rows another claimant already holds.
  select user_id
    into v_user_id
    from social_accounts
   where id = p_account_id
     and platform = 'whatsapp';

  if not found then
    raise exception 'activate_evolution_qr_account: whatsapp account % not found', p_account_id
      using errcode = 'P0002';
  end if;

  -- WhatsApp account continuity: the per-user setup lock comes first, before the per-number
  -- lock and any row lock, matching move_whatsapp_account_setup's order, so a re-pair and a
  -- "bring over my setup" move for the same owner serialize instead of deadlocking.
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':wa-setup', 0));

  -- Two claims for the same number, from two provisional rows of the same user, would
  -- otherwise each hold only its own row lock, each find no duplicate, and the second final
  -- update would fail with 23505 -- the very collision this function exists to resolve. The
  -- claim is therefore serialized per (user, number), and this is the FIRST lock every claim
  -- takes. hashtextextended is used rather than hashtext because the single-argument advisory
  -- lock takes a bigint. The loser of the race runs second, finds the winner as its duplicate
  -- and retires it: newest pairing wins, which is the same rule the merge below applies.
  perform pg_advisory_xact_lock(hashtextextended(v_user_id::text || ':' || p_owner_number, 0));

  -- Re-read under the row lock: the winner of the advisory lock may have just changed this
  -- row, and the unlocked read above is only trusted for the user it belongs to.
  select platform_user_id, workspace_id
    into v_current, v_workspace_id
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

  select id, workspace_id
    into v_duplicate_id, v_duplicate_workspace_id
    from social_accounts
   where user_id = v_user_id
     and platform = 'whatsapp'
     and platform_user_id = p_owner_number
     and id <> p_account_id
   for update;

  if v_duplicate_id is not null then
    -- social_accounts is unique on (user_id, platform, platform_user_id) with no workspace
    -- term, so one user genuinely cannot hold the same number in two workspaces and the merge
    -- is forced. But messaging_cache rows carry their own workspace_id, the inbox filters on
    -- it, and its dependants (whatsapp_conversation_assignments, whatsapp_deals) reference
    -- (id, workspace_id) with no ON UPDATE rule -- so moving the rows across a workspace
    -- boundary would either strand them behind the inbox filter or break those keys. Callers
    -- can reach this state: whatsapp-evolution-bridge takes an explicit workspace_id. Failing
    -- loudly here leaves the pairing inactive with a diagnosable error, which is recoverable;
    -- a silently half-visible inbox is not.
    if v_duplicate_workspace_id is distinct from v_workspace_id then
      raise exception
        'activate_evolution_qr_account: account % and its duplicate % are in different workspaces',
        p_account_id, v_duplicate_id
        using errcode = '22023';
    end if;

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
    -- The retired id no longer carries the number; keep it where the setup mover can match
    -- numbers after retirement.
    update social_accounts
       set account_metadata = coalesce(account_metadata, '{}'::jsonb) || jsonb_build_object('retired_number', p_owner_number)
     where id = v_duplicate_id;

    update social_accounts
       set platform_user_id = 'retired_' || v_duplicate_id::text,
           is_active = false
     where id = v_duplicate_id;

    -- Claim the number on the surviving row now (its key is free since the duplicate just
    -- retired): the setup mover refuses a pending_ destination.
    update social_accounts
       set platform_user_id = p_owner_number,
           is_active = true
     where id = p_account_id;

    -- Carry the AI agent setup across with the messages. A conflict (an existing config, a
    -- connector-name clash, an order being sent) defers the store group as a whole and flags
    -- setup_move_pending instead of failing the activation; an unexpected database error
    -- still aborts the whole activation, which leaves both rows as they were.
    perform public.move_whatsapp_account_setup(v_duplicate_id, p_account_id, 'auto');
  end if;

  if v_duplicate_id is null then
    update social_accounts
       set platform_user_id = p_owner_number,
           is_active = true
     where id = p_account_id;
  end if;

  return p_owner_number;
end;
$$;

-- Activation runs only from the service-role edge functions (the connection.update webhook
-- and the QR status poller). No end-user role may claim an identity or retire a sibling row.
revoke all on function public.activate_evolution_qr_account(uuid, text) from public;
revoke all on function public.activate_evolution_qr_account(uuid, text) from anon;
revoke all on function public.activate_evolution_qr_account(uuid, text) from authenticated;
grant execute on function public.activate_evolution_qr_account(uuid, text) to service_role;
