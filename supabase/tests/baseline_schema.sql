-- BASELINE_MIGRATION: 20260830120300_partner_api_least_privilege_grants.sql
--
-- PostgreSQL database dump
--

\restrict W1bMlSUm0GFSUUfgv5osPQLUHbRzU9wXeqb1yublg4SHl9u240ffgcHOtqDxQhj

-- Dumped from database version 17.6
-- Dumped by pg_dump version 17.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: auth; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA auth;


--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA public;


--
-- Name: SCHEMA public; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON SCHEMA public IS 'standard public schema';


--
-- Name: realtime; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA realtime;


--
-- Name: storage; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA storage;


--
-- Name: aal_level; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.aal_level AS ENUM (
    'aal1',
    'aal2',
    'aal3'
);


--
-- Name: code_challenge_method; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.code_challenge_method AS ENUM (
    's256',
    'plain'
);


--
-- Name: factor_status; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.factor_status AS ENUM (
    'unverified',
    'verified'
);


--
-- Name: factor_type; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.factor_type AS ENUM (
    'totp',
    'webauthn',
    'phone'
);


--
-- Name: oauth_authorization_status; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.oauth_authorization_status AS ENUM (
    'pending',
    'approved',
    'denied',
    'expired'
);


--
-- Name: oauth_client_type; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.oauth_client_type AS ENUM (
    'public',
    'confidential'
);


--
-- Name: oauth_registration_type; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.oauth_registration_type AS ENUM (
    'dynamic',
    'manual'
);


--
-- Name: oauth_response_type; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.oauth_response_type AS ENUM (
    'code'
);


--
-- Name: one_time_token_type; Type: TYPE; Schema: auth; Owner: -
--

CREATE TYPE auth.one_time_token_type AS ENUM (
    'confirmation_token',
    'reauthentication_token',
    'recovery_token',
    'email_change_token_new',
    'email_change_token_current',
    'phone_change_token'
);


--
-- Name: app_role; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.app_role AS ENUM (
    'user',
    'admin',
    'subscriber',
    'support'
);


--
-- Name: action; Type: TYPE; Schema: realtime; Owner: -
--

CREATE TYPE realtime.action AS ENUM (
    'INSERT',
    'UPDATE',
    'DELETE',
    'TRUNCATE',
    'ERROR'
);


--
-- Name: equality_op; Type: TYPE; Schema: realtime; Owner: -
--

CREATE TYPE realtime.equality_op AS ENUM (
    'eq',
    'neq',
    'lt',
    'lte',
    'gt',
    'gte',
    'in'
);


--
-- Name: user_defined_filter; Type: TYPE; Schema: realtime; Owner: -
--

CREATE TYPE realtime.user_defined_filter AS (
	column_name text,
	op realtime.equality_op,
	value text
);


--
-- Name: wal_column; Type: TYPE; Schema: realtime; Owner: -
--

CREATE TYPE realtime.wal_column AS (
	name text,
	type_name text,
	type_oid oid,
	value jsonb,
	is_pkey boolean,
	is_selectable boolean
);


--
-- Name: wal_rls; Type: TYPE; Schema: realtime; Owner: -
--

CREATE TYPE realtime.wal_rls AS (
	wal jsonb,
	is_rls_enabled boolean,
	subscription_ids uuid[],
	errors text[]
);


--
-- Name: buckettype; Type: TYPE; Schema: storage; Owner: -
--

CREATE TYPE storage.buckettype AS ENUM (
    'STANDARD',
    'ANALYTICS',
    'VECTOR'
);


--
-- Name: email(); Type: FUNCTION; Schema: auth; Owner: -
--

CREATE FUNCTION auth.email() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email')
  )::text
$$;


--
-- Name: FUNCTION email(); Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON FUNCTION auth.email() IS 'Deprecated. Use auth.jwt() -> ''email'' instead.';


--
-- Name: jwt(); Type: FUNCTION; Schema: auth; Owner: -
--

CREATE FUNCTION auth.jwt() RETURNS jsonb
    LANGUAGE sql STABLE
    AS $$
  select 
    coalesce(
        nullif(current_setting('request.jwt.claim', true), ''),
        nullif(current_setting('request.jwt.claims', true), '')
    )::jsonb
$$;


--
-- Name: role(); Type: FUNCTION; Schema: auth; Owner: -
--

CREATE FUNCTION auth.role() RETURNS text
    LANGUAGE sql STABLE
    AS $$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;


--
-- Name: FUNCTION role(); Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON FUNCTION auth.role() IS 'Deprecated. Use auth.jwt() -> ''role'' instead.';


--
-- Name: uid(); Type: FUNCTION; Schema: auth; Owner: -
--

CREATE FUNCTION auth.uid() RETURNS uuid
    LANGUAGE sql STABLE
    AS $$
  select 
  coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;


--
-- Name: FUNCTION uid(); Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON FUNCTION auth.uid() IS 'Deprecated. Use auth.jwt() -> ''sub'' instead.';


--
-- Name: accept_workspace_invitation(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.accept_workspace_invitation(p_token text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: activate_evolution_qr_account(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.activate_evolution_qr_account(p_account_id uuid, p_owner_number text) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $_$
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
$_$;


--
-- Name: add_ticket_message(uuid, text, jsonb, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_ticket_message(p_ticket_id uuid, p_message text, p_attachments jsonb DEFAULT '[]'::jsonb, p_is_internal boolean DEFAULT false) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_message_id UUID;
  v_ticket_user_id UUID;
BEGIN
  -- Verify access/ownership
  SELECT user_id INTO v_ticket_user_id FROM public.support_tickets WHERE id = p_ticket_id;
  
  IF v_ticket_user_id IS NULL THEN
    RAISE EXCEPTION 'Ticket not found';
  END IF;
  
  -- Insert message
  INSERT INTO public.ticket_messages (
    ticket_id, user_id, message, attachments, is_internal
  )
  VALUES (
    p_ticket_id, auth.uid(), p_message, p_attachments, p_is_internal
  )
  RETURNING id INTO v_message_id;
  
  -- Update ticket timestamp
  UPDATE public.support_tickets
  SET updated_at = NOW(),
      last_response_at = NOW()
  WHERE id = p_ticket_id;
  
  RETURN v_message_id;
END;
$$;


--
-- Name: add_user_credits(uuid, integer, text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.add_user_credits(p_user_id uuid, p_amount integer, p_transaction_type text DEFAULT 'purchase'::text, p_description text DEFAULT NULL::text, p_stripe_session_id text DEFAULT NULL::text) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_new_balance INTEGER;
BEGIN
  -- Insert or update user_credits
  INSERT INTO user_credits (user_id, balance, total_purchased)
  VALUES (p_user_id, p_amount, CASE WHEN p_transaction_type = 'purchase' THEN p_amount ELSE 0 END)
  ON CONFLICT (user_id) DO UPDATE SET
    balance = user_credits.balance + p_amount,
    total_purchased = CASE 
      WHEN p_transaction_type = 'purchase' 
      THEN user_credits.total_purchased + p_amount 
      ELSE user_credits.total_purchased 
    END,
    updated_at = now()
  RETURNING balance INTO v_new_balance;

  -- Record transaction
  INSERT INTO credit_transactions (user_id, amount, transaction_type, description, stripe_session_id)
  VALUES (p_user_id, p_amount, p_transaction_type, p_description, p_stripe_session_id);

  RETURN v_new_balance;
END;
$$;


--
-- Name: admin_get_profiles(integer, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.admin_get_profiles(p_limit integer DEFAULT 50, p_offset integer DEFAULT 0, p_search text DEFAULT NULL::text) RETURNS TABLE(id uuid, email text, full_name text, avatar_url text, created_at timestamp with time zone, referral_code text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_admin_id UUID;
  v_log_id UUID;
  v_result_count INTEGER;
BEGIN
  -- Get the current user's ID
  v_admin_id := auth.uid();
  
  -- Verify the user is an admin
  IF NOT has_role(v_admin_id, 'admin'::app_role) THEN
    RAISE EXCEPTION 'Access denied: Admin role required';
  END IF;
  
  -- Log this access attempt BEFORE returning data
  INSERT INTO public.admin_audit_log (admin_id, action, resource_type, details)
  VALUES (
    v_admin_id,
    'bulk_view',
    'profiles',
    jsonb_build_object(
      'limit', p_limit,
      'offset', p_offset,
      'search', p_search,
      'timestamp', now()
    )
  )
  RETURNING id INTO v_log_id;
  
  -- Return the profiles with limited fields
  RETURN QUERY
  SELECT 
    p.id,
    p.email,
    p.full_name,
    p.avatar_url,
    p.created_at,
    p.referral_code
  FROM public.profiles p
  WHERE 
    p_search IS NULL 
    OR p.email ILIKE '%' || p_search || '%'
    OR p.full_name ILIKE '%' || p_search || '%'
  ORDER BY p.created_at DESC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;


--
-- Name: advance_agent_reply(uuid, text, text, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.advance_agent_reply(p_id uuid, p_from text, p_to text, p_generated_reply text DEFAULT NULL::text, p_error text DEFAULT NULL::text, p_tool_calls jsonb DEFAULT NULL::jsonb) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_count INTEGER;
BEGIN
  UPDATE public.pending_agent_replies
     SET status               = p_to,
         generated_reply      = COALESCE(p_generated_reply, generated_reply),
         generated_tool_calls = COALESCE(p_tool_calls, generated_tool_calls),
         error                = COALESCE(p_error, error),
         sent_at         = CASE WHEN p_to = 'sent' THEN now() ELSE sent_at END,
         -- A terminal row holds no lease; leaving one would keep it in the claimable index
         -- for no reason.
         lease_expires_at = CASE WHEN p_to IN ('sent','delivery_unknown','failed','cancelled')
                                 THEN NULL ELSE lease_expires_at END
   WHERE id = p_id AND status = p_from;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count = 1;
END;
$$;


--
-- Name: assign_ticket(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.assign_ticket(p_ticket_id uuid, p_assignee_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE public.support_tickets
  SET assigned_to = p_assignee_id,
      updated_at = NOW()
  WHERE id = p_ticket_id;
  
  -- Log activity
  INSERT INTO public.ticket_activities (ticket_id, actor_id, action, details)
  VALUES (
    p_ticket_id, 
    auth.uid(), 
    'assigned', 
    jsonb_build_object('assigned_to', p_assignee_id)
  );
  
  RETURN TRUE;
END;
$$;


--
-- Name: calculate_health_score(numeric, numeric, integer, numeric); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.calculate_health_score(p_db_query_time numeric, p_api_error_rate numeric, p_edge_function_errors integer, p_storage_percent numeric) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_score INTEGER := 100;
BEGIN
  -- Deduct for slow DB queries (>500ms)
  IF p_db_query_time > 500 THEN
    v_score := v_score - 20;
  ELSIF p_db_query_time > 200 THEN
    v_score := v_score - 10;
  END IF;

  -- Deduct for API errors
  IF p_api_error_rate > 10 THEN
    v_score := v_score - 30;
  ELSIF p_api_error_rate > 5 THEN
    v_score := v_score - 15;
  ELSIF p_api_error_rate > 1 THEN
    v_score := v_score - 5;
  END IF;

  -- Deduct for edge function errors
  IF p_edge_function_errors > 50 THEN
    v_score := v_score - 20;
  ELSIF p_edge_function_errors > 10 THEN
    v_score := v_score - 10;
  END IF;

  -- Deduct for high storage usage
  IF p_storage_percent > 90 THEN
    v_score := v_score - 20;
  ELSIF p_storage_percent > 80 THEN
    v_score := v_score - 10;
  END IF;

  RETURN GREATEST(0, v_score);
END;
$$;


--
-- Name: can_create_post(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_create_post(p_user_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_max_day integer;
  v_max_month integer;
  v_posts_today integer;
  v_posts_month integer;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;

  IF public.has_role(p_user_id, 'admin'::public.app_role) THEN
    RETURN true;
  END IF;

  SELECT e.max_posts_per_day, e.max_posts_per_month
  INTO v_max_day, v_max_month
  FROM public.effective_user_quotas(p_user_id) e;

  SELECT COUNT(*)::integer INTO v_posts_today
  FROM public.posts
  WHERE user_id = p_user_id AND created_at >= date_trunc('day', now());

  SELECT COUNT(*)::integer INTO v_posts_month
  FROM public.posts
  WHERE user_id = p_user_id AND created_at >= date_trunc('month', now());

  IF v_max_day IS DISTINCT FROM -1 AND v_posts_today >= v_max_day THEN
    RETURN false;
  END IF;

  IF v_max_month IS DISTINCT FROM -1 AND v_posts_month >= v_max_month THEN
    RETURN false;
  END IF;

  RETURN true;
END;
$$;


--
-- Name: FUNCTION can_create_post(p_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.can_create_post(p_user_id uuid) IS 'True if under daily/monthly post limits from effective_user_quotas(). Admins always true.';


--
-- Name: can_upload_media(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.can_upload_media(p_user_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_current_uploads integer;
  v_max_uploads integer;
  v_reset_date timestamptz;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;

  IF public.has_role(p_user_id, 'admin'::public.app_role) THEN
    RETURN true;
  END IF;

  SELECT e.max_media_uploads_per_day INTO v_max_uploads
  FROM public.effective_user_quotas(p_user_id) e;

  IF v_max_uploads = -1 THEN
    RETURN true;
  END IF;

  SELECT uq.media_uploads_today, uq.media_daily_reset_date
  INTO v_current_uploads, v_reset_date
  FROM public.user_quotas uq
  WHERE uq.user_id = p_user_id;

  -- No counter row yet, or the daily window has rolled over: nothing consumed.
  IF NOT FOUND OR v_reset_date IS NULL OR v_reset_date <= now() THEN
    RETURN true;
  END IF;

  RETURN COALESCE(v_current_uploads, 0) < v_max_uploads;
END;
$$;


--
-- Name: FUNCTION can_upload_media(p_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.can_upload_media(p_user_id uuid) IS 'True if under the daily media upload limit from effective_user_quotas(). Admins always true.';


--
-- Name: check_rate_limit(text, text, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.check_rate_limit(p_endpoint text, p_identifier text, p_max_requests integer, p_window_seconds integer) RETURNS jsonb
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_bucket_key   TEXT       := p_endpoint || ':' || p_identifier;
    v_now          TIMESTAMPTZ := now();
    v_count        INTEGER;
    v_window_start TIMESTAMPTZ;
    v_window_end   TIMESTAMPTZ;
BEGIN
    -- Step 1: Insert-or-noop. If the row doesn't exist, create it with count 0.
    -- The RETURNING clause gives us the initial values if we won the insert race.
    INSERT INTO public.rate_limit_buckets (bucket_key, count, window_start, expires_at)
    VALUES (v_bucket_key, 0, v_now, v_now + make_interval(secs => p_window_seconds))
    ON CONFLICT (bucket_key) DO NOTHING
    RETURNING count, window_start INTO v_count, v_window_start;

    -- Step 2: If we didn't win the insert (row already existed), lock and read.
    IF v_count IS NULL THEN
        SELECT count, window_start INTO v_count, v_window_start
        FROM public.rate_limit_buckets
        WHERE bucket_key = v_bucket_key
        FOR UPDATE;
    END IF;

    -- Guard: row should exist at this point.
    IF v_count IS NULL THEN
        RETURN jsonb_build_object('allowed', true, 'count', 0, 'remaining', p_max_requests, 'retry_after', 0);
    END IF;

    -- Step 3: Check if the sliding window has expired.
    IF v_now - v_window_start > make_interval(secs => p_window_seconds) THEN
        UPDATE public.rate_limit_buckets
        SET count = 1,
            window_start = v_now,
            expires_at = v_now + make_interval(secs => p_window_seconds)
        WHERE bucket_key = v_bucket_key;
        RETURN jsonb_build_object(
            'allowed', true,
            'count', 1,
            'remaining', p_max_requests - 1,
            'retry_after', 0
        );
    END IF;

    -- Step 4: Check if rate limit is exceeded.
    IF v_count >= p_max_requests THEN
        v_window_end := v_window_start + make_interval(secs => p_window_seconds);
        RETURN jsonb_build_object(
            'allowed', false,
            'count', v_count,
            'remaining', 0,
            'retry_after', GREATEST(1, CEIL(EXTRACT(EPOCH FROM (v_window_end - v_now))))
        );
    END IF;

    -- Step 5: Increment and allow.
    UPDATE public.rate_limit_buckets
    SET count = count + 1
    WHERE bucket_key = v_bucket_key;

    RETURN jsonb_build_object(
        'allowed', true,
        'count', v_count + 1,
        'remaining', p_max_requests - v_count - 1,
        'retry_after', 0
    );
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: pending_agent_replies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.pending_agent_replies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    social_account_id uuid NOT NULL,
    user_id uuid NOT NULL,
    platform text NOT NULL,
    message_id text NOT NULL,
    conversation_id text NOT NULL,
    recipient_id text NOT NULL,
    inbound_text text NOT NULL,
    media_url text,
    media_kind text,
    media_caption text,
    unread_attachments integer DEFAULT 0 NOT NULL,
    language_hint text,
    comment_id text,
    media_expires_at timestamp with time zone,
    inbound_at timestamp with time zone NOT NULL,
    ingress_seq bigint NOT NULL,
    generated_reply text,
    generated_tool_calls jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    attempts integer DEFAULT 0 NOT NULL,
    lease_expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    claimed_at timestamp with time zone,
    sent_at timestamp with time zone,
    error text,
    CONSTRAINT pending_agent_replies_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'ready_to_send'::text, 'sending'::text, 'sent'::text, 'delivery_unknown'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: claim_agent_replies(integer, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_agent_replies(p_limit integer, p_lease_seconds integer, p_max_attempts integer) RETURNS SETOF public.pending_agent_replies
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF p_limit <= 0 OR p_lease_seconds <= 0 OR p_max_attempts <= 0 THEN
    RAISE EXCEPTION 'claim_agent_replies requires positive parameters';
  END IF;

  RETURN QUERY
  WITH claimed AS (
    SELECT p.id FROM public.pending_agent_replies p
     WHERE p.status IN ('pending','running','ready_to_send','sending')
       AND p.attempts < p_max_attempts
       AND (p.lease_expires_at IS NULL OR p.lease_expires_at < now())
     ORDER BY p.inbound_at, p.ingress_seq
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.pending_agent_replies p
     SET attempts         = p.attempts + 1,
         claimed_at       = now(),
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
    FROM claimed
   WHERE p.id = claimed.id
  RETURNING p.*;
END;
$$;


--
-- Name: ai_knowledge_sources; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_knowledge_sources (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    source_type text,
    file_name text,
    file_path text,
    status text DEFAULT 'pending'::text NOT NULL,
    error text,
    chunk_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    visibility text DEFAULT 'shared'::text NOT NULL,
    CONSTRAINT ai_knowledge_sources_source_type_check CHECK ((source_type = ANY (ARRAY['excel'::text, 'csv'::text, 'pdf'::text, 'doc'::text, 'image'::text, 'catalog'::text, 'profile_text'::text]))),
    CONSTRAINT ai_knowledge_sources_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'ready'::text, 'failed'::text]))),
    CONSTRAINT ai_knowledge_sources_visibility_check CHECK ((visibility = ANY (ARRAY['shared'::text, 'restricted'::text])))
);


--
-- Name: claim_ai_knowledge_excel_source(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_ai_knowledge_excel_source() RETURNS SETOF public.ai_knowledge_sources
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  claimed public.ai_knowledge_sources;
BEGIN
  WITH candidate AS (
    SELECT id
    FROM public.ai_knowledge_sources
    WHERE source_type IN ('excel', 'csv')
      AND (
        status = 'pending'
        OR (status = 'processing' AND updated_at < now() - interval '10 minutes')
      )
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  UPDATE public.ai_knowledge_sources source
  SET status = 'processing', error = NULL
  FROM candidate
  WHERE source.id = candidate.id
  RETURNING source.* INTO claimed;

  IF FOUND THEN RETURN NEXT claimed; END IF;
END;
$$;


--
-- Name: claim_partner_idempotency(uuid, text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_partner_idempotency(p_key_id uuid, p_idempotency_key text, p_request_hash text, p_lease_seconds integer DEFAULT 300) RETURNS TABLE(outcome text, http_status integer, response_body jsonb, attempt_token uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_row   public.partner_api_idempotency%ROWTYPE;
  v_token UUID;
BEGIN
  -- Opportunistic pruning: expired rows must not resurrect as false replays.
  DELETE FROM public.partner_api_idempotency
   WHERE key_id = p_key_id AND expires_at < now();

  v_token := gen_random_uuid();

  INSERT INTO public.partner_api_idempotency
    (key_id, idempotency_key, request_hash, state, locked_until, attempt_token)
  VALUES
    (p_key_id, p_idempotency_key, p_request_hash, 'processing',
     now() + make_interval(secs => p_lease_seconds), v_token)
  ON CONFLICT (key_id, idempotency_key) DO NOTHING;

  IF FOUND THEN
    RETURN QUERY SELECT 'claimed'::TEXT, NULL::INTEGER, NULL::JSONB, v_token;
    RETURN;
  END IF;

  -- Lock the existing row so two concurrent duplicates cannot both take over
  -- the same expired lease.
  SELECT * INTO v_row
    FROM public.partner_api_idempotency
   WHERE key_id = p_key_id AND idempotency_key = p_idempotency_key
     FOR UPDATE;

  IF NOT FOUND THEN
    -- Pruned between the insert and the read; retry is safe and cheap.
    RETURN QUERY SELECT 'in_progress'::TEXT, NULL::INTEGER, NULL::JSONB, NULL::UUID;
    RETURN;
  END IF;

  IF v_row.request_hash IS DISTINCT FROM p_request_hash THEN
    RETURN QUERY SELECT 'conflict'::TEXT, NULL::INTEGER, NULL::JSONB, NULL::UUID;
    RETURN;
  END IF;

  IF v_row.state = 'completed' THEN
    RETURN QUERY SELECT 'replay'::TEXT, v_row.http_status, v_row.response_body, NULL::UUID;
    RETURN;
  END IF;

  IF v_row.state = 'indeterminate' THEN
    -- The first attempt may have reached Meta. Never silently re-send.
    RETURN QUERY SELECT 'indeterminate'::TEXT, NULL::INTEGER, NULL::JSONB, NULL::UUID;
    RETURN;
  END IF;

  -- state = 'processing'. A live lease means a genuine concurrent duplicate;
  -- an expired one means the previous attempt died before settling, so this
  -- caller takes it over rather than wedging the key forever.
  IF v_row.locked_until IS NOT NULL AND v_row.locked_until > now() THEN
    RETURN QUERY SELECT 'in_progress'::TEXT, NULL::INTEGER, NULL::JSONB, NULL::UUID;
    RETURN;
  END IF;

  -- Takeover: mint a NEW token so the previous holder can no longer settle.
  UPDATE public.partner_api_idempotency
     SET locked_until  = now() + make_interval(secs => p_lease_seconds),
         attempt_token = v_token
   WHERE key_id = p_key_id AND idempotency_key = p_idempotency_key;

  RETURN QUERY SELECT 'claimed'::TEXT, NULL::INTEGER, NULL::JSONB, v_token;
END;
$$;


--
-- Name: claim_whatsapp_history_sync(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.claim_whatsapp_history_sync(p_social_account_id uuid, p_lease_seconds integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  claimed integer;
begin
  update whatsapp_evolution_instances
     set sync_started_at = now()
   where social_account_id = p_social_account_id
     and (
       sync_started_at is null
       or sync_started_at < now() - make_interval(secs => p_lease_seconds)
     );
  get diagnostics claimed = row_count;
  return claimed > 0;
end;
$$;


--
-- Name: cleanup_expired_otps(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_expired_otps() RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  DELETE FROM public.password_reset_otps 
  WHERE expires_at < now() OR used = true;
END;
$$;


--
-- Name: cleanup_old_health_data(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_old_health_data() RETURNS TABLE(snapshots_deleted bigint, edge_status_deleted bigint, logs_deleted bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_snapshots BIGINT;
  v_edge_status BIGINT;
  v_logs BIGINT;
BEGIN
  -- Delete snapshots older than 90 days
  DELETE FROM public.system_health_snapshots
  WHERE captured_at < NOW() - INTERVAL '90 days';
  GET DIAGNOSTICS v_snapshots = ROW_COUNT;

  -- Delete edge function status older than 30 days
  DELETE FROM public.edge_function_status
  WHERE checked_at < NOW() - INTERVAL '30 days';
  GET DIAGNOSTICS v_edge_status = ROW_COUNT;

  -- Delete logs older than 30 days (except critical errors)
  DELETE FROM public.system_logs
  WHERE created_at < NOW() - INTERVAL '30 days'
    AND level NOT IN ('critical', 'error');
  GET DIAGNOSTICS v_logs = ROW_COUNT;

  RETURN QUERY SELECT v_snapshots, v_edge_status, v_logs;
END;
$$;


--
-- Name: cleanup_old_token_refresh_history(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_old_token_refresh_history() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  deleted_count integer;
BEGIN
  DELETE FROM public.token_refresh_history
  WHERE created_at < NOW() - INTERVAL '7 days';
  
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  
  RETURN deleted_count;
END;
$$;


--
-- Name: cleanup_rate_limit_buckets(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.cleanup_rate_limit_buckets() RETURNS integer
    LANGUAGE plpgsql
    AS $$
DECLARE
    v_deleted INTEGER;
BEGIN
    DELETE FROM public.rate_limit_buckets WHERE expires_at < now();
    GET DIAGNOSTICS v_deleted = ROW_COUNT;
    RETURN v_deleted;
END;
$$;


--
-- Name: consume_partner_rate(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.consume_partner_rate(p_key_id uuid, p_limit integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_count INTEGER;
BEGIN
  INSERT INTO public.partner_api_rate_buckets (key_id, window_start, request_count)
  VALUES (p_key_id, date_trunc('minute', now()), 1)
  ON CONFLICT (key_id, window_start)
  DO UPDATE SET request_count = partner_api_rate_buckets.request_count + 1
  RETURNING request_count INTO v_count;

  RETURN v_count <= p_limit;
END;
$$;


--
-- Name: consume_partner_rate_v2(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.consume_partner_rate_v2(p_key_id uuid, p_limit integer) RETURNS TABLE(allowed boolean, remaining integer, reset_seconds integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_count  INTEGER;
  v_now    TIMESTAMPTZ;
  v_window TIMESTAMPTZ;
BEGIN
  -- Captured once so the bucket that is incremented and the window the reset
  -- is measured against are provably the same instant. now() is stable
  -- within a transaction anyway; the variable makes that invariant explicit
  -- instead of relying on every future reader knowing it.
  v_now    := now();
  v_window := date_trunc('minute', v_now);

  INSERT INTO public.partner_api_rate_buckets (key_id, window_start, request_count)
  VALUES (p_key_id, v_window, 1)
  ON CONFLICT (key_id, window_start)
  DO UPDATE SET request_count = partner_api_rate_buckets.request_count + 1
  RETURNING request_count INTO v_count;

  RETURN QUERY SELECT
    -- Same predicate as consume_partner_rate.
    v_count <= p_limit,
    -- Requests left in THIS window after the one just consumed. Clamped: on
    -- a refused call the arithmetic goes negative, and "remaining" cannot.
    GREATEST(p_limit - v_count, 0),
    -- Seconds until the consumed window ends. v_window + 1 minute > now()
    -- always holds inside the window, so CEIL yields 1..60 and never 0.
    CEIL(EXTRACT(EPOCH FROM (v_window + INTERVAL '1 minute' - v_now)))::INTEGER;
END;
$$;


--
-- Name: count_openinary_backfill_remaining(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.count_openinary_backfill_remaining() RETURNS bigint
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT count(*)
  FROM public.media_file_providers c
  WHERE c.provider = 'cloudinary'
    AND c.status = 'ready'
    AND NOT EXISTS (
      SELECT 1
      FROM public.media_file_providers o
      WHERE o.media_file_id = c.media_file_id
        AND o.object_version = c.object_version
        AND o.provider = 'openinary'
        AND o.status = 'ready'
    );
$$;


--
-- Name: create_ai_knowledge_source(text, text, text, uuid[], text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_ai_knowledge_source(p_source_type text, p_file_name text, p_file_path text, p_social_account_ids uuid[], p_visibility text DEFAULT 'shared'::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_source_id uuid;
  v_owned integer;
  v_account_count integer;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;
  IF p_visibility IS DISTINCT FROM 'shared' AND p_visibility IS DISTINCT FROM 'restricted' THEN
    RAISE EXCEPTION 'visibility must be ''shared'' or ''restricted''';
  END IF;

  -- Distinct on both sides of the comparison, exactly as
  -- set_ai_knowledge_source_visibility collapses duplicates: [A, A] for an
  -- account the caller genuinely owns is a legal input, not an ownership
  -- failure, and re-inserting it would hit the link table's primary key.
  SELECT count(DISTINCT account_id) INTO v_account_count
  FROM unnest(COALESCE(p_social_account_ids, '{}')) AS account_id;
  IF p_visibility = 'restricted' AND v_account_count = 0 THEN
    RAISE EXCEPTION 'A restricted knowledge source must be assigned to at least one account';
  END IF;

  IF v_account_count > 0 THEN
    SELECT count(DISTINCT id) INTO v_owned
    FROM public.social_accounts
    WHERE id = ANY(p_social_account_ids) AND user_id = v_user_id;

    IF v_owned <> v_account_count THEN
      RAISE EXCEPTION 'One or more accounts do not belong to the caller';
    END IF;
  END IF;

  INSERT INTO public.ai_knowledge_sources (user_id, source_type, file_name, file_path, status, visibility)
  VALUES (v_user_id, p_source_type, p_file_name, p_file_path, 'pending', p_visibility)
  RETURNING id INTO v_source_id;

  IF v_account_count > 0 THEN
    INSERT INTO public.ai_knowledge_source_accounts (source_id, social_account_id, user_id)
    SELECT v_source_id, account_id, v_user_id
    FROM (SELECT DISTINCT account_id FROM unnest(p_social_account_ids) AS account_id) AS ids;
  END IF;

  RETURN v_source_id;
END;
$$;


--
-- Name: create_default_whatsapp_pipeline(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_default_whatsapp_pipeline(p_workspace_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: create_support_ticket(text, text, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_support_ticket(p_subject text, p_description text, p_category text, p_priority text DEFAULT 'normal'::text, p_attachments jsonb DEFAULT '[]'::jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_ticket_id UUID;
BEGIN
  INSERT INTO public.support_tickets (
    user_id, subject, description, category, priority, attachments
  )
  VALUES (
    auth.uid(), p_subject, p_description, p_category, p_priority, p_attachments
  )
  RETURNING id INTO v_ticket_id;
  
  -- Log activity
  INSERT INTO public.ticket_activities (ticket_id, actor_id, action, details)
  VALUES (v_ticket_id, auth.uid(), 'created', jsonb_build_object('subject', p_subject));
  
  RETURN v_ticket_id;
END;
$$;


--
-- Name: create_workflow_version(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.create_workflow_version() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_version_number INTEGER;
BEGIN
  -- Only create version if nodes or edges changed
  IF OLD.nodes IS DISTINCT FROM NEW.nodes OR OLD.edges IS DISTINCT FROM NEW.edges THEN
    -- Get next version number
    SELECT COALESCE(MAX(version_number), 0) + 1 INTO v_version_number
    FROM public.workflow_versions
    WHERE workflow_id = NEW.id;
    
    -- Insert new version
    INSERT INTO public.workflow_versions (
      workflow_id, version_number, nodes, edges, viewport, created_by
    ) VALUES (
      NEW.id, v_version_number, OLD.nodes, OLD.edges, OLD.viewport, auth.uid()
    );
    
    -- Keep only last 20 versions
    DELETE FROM public.workflow_versions
    WHERE workflow_id = NEW.id
    AND version_number < v_version_number - 19;
  END IF;
  
  RETURN NEW;
END;
$$;


--
-- Name: effective_user_quotas(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.effective_user_quotas(p_user_id uuid) RETURNS TABLE(max_profiles integer, max_social_accounts integer, max_posts_per_month integer, max_posts_per_day integer, max_media_uploads_per_day integer)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  WITH plan AS (
    SELECT sp.profile_limit, sp.max_social_accounts, sp.max_posts_per_month,
           sp.max_posts_per_day, sp.max_media_uploads_per_day
    FROM public.subscription_plans sp
    WHERE sp.id = (
      SELECT us.plan_id FROM public.user_subscriptions us
      WHERE us.user_id = p_user_id AND us.status IN ('active', 'past_due')
      -- Round-1 amendment A5: full three-part tie-breaker. There is no
      -- uniqueness constraint on active subscriptions, so two active rows
      -- with equal or NULL current_period_end must still resolve
      -- deterministically, or the arbiter and the backfill can disagree.
      ORDER BY us.current_period_end DESC NULLS LAST, us.created_at DESC, us.id DESC
      LIMIT 1
    )
    UNION ALL
    -- Fallback branch: no active/past_due subscription -> the free plan row.
    SELECT sp.profile_limit, sp.max_social_accounts, sp.max_posts_per_month,
           sp.max_posts_per_day, sp.max_media_uploads_per_day
    FROM public.subscription_plans sp
    WHERE sp.slug = 'free'
      AND NOT EXISTS (
        SELECT 1 FROM public.user_subscriptions us
        WHERE us.user_id = p_user_id AND us.status IN ('active', 'past_due')
      )
    LIMIT 1
  ),
  override AS (
    SELECT uq.max_profiles, uq.max_social_accounts, uq.max_posts_per_month,
           uq.max_posts_per_day, uq.max_media_uploads_per_day
    FROM public.user_quotas uq
    WHERE uq.user_id = p_user_id
  )
  SELECT
    COALESCE((SELECT o.max_profiles FROM override o),
             (SELECT p.profile_limit FROM plan p), 2),
    COALESCE((SELECT o.max_social_accounts FROM override o),
             (SELECT p.max_social_accounts FROM plan p), 3),
    COALESCE((SELECT o.max_posts_per_month FROM override o),
             (SELECT p.max_posts_per_month FROM plan p), 30),
    COALESCE((SELECT o.max_posts_per_day FROM override o),
             (SELECT p.max_posts_per_day FROM plan p), 2),
    COALESCE((SELECT o.max_media_uploads_per_day FROM override o),
             (SELECT p.max_media_uploads_per_day FROM plan p), 20);
$$;


--
-- Name: FUNCTION effective_user_quotas(p_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.effective_user_quotas(p_user_id uuid) IS 'Single source of truth for a user''s limits: override -> plan -> free literal. -1 = unlimited.';


--
-- Name: enforce_post_quota_on_insert(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enforce_post_quota_on_insert() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_max_day integer;
  v_max_month integer;
  v_posts_today integer;
  v_posts_month integer;
  v_next_day timestamptz := date_trunc('day', now()) + interval '1 day';
  v_next_month timestamptz := date_trunc('month', now()) + interval '1 month';
BEGIN
  IF NEW.user_id IS NULL THEN
    RAISE EXCEPTION 'POST_QUOTA_DENIED: user_id is required'
      USING ERRCODE = 'check_violation';
  END IF;

  IF public.has_role(NEW.user_id, 'admin'::public.app_role) THEN
    RETURN NEW;
  END IF;

  -- The row exists to be locked and to hold counters. Limits stay NULL.
  INSERT INTO public.user_quotas (
    user_id, posts_this_month, posts_today, quota_reset_date, daily_reset_date,
    max_profiles, max_social_accounts, max_posts_per_month,
    max_posts_per_day, max_media_uploads_per_day
  ) VALUES (
    NEW.user_id, 0, 0, v_next_month, v_next_day,
    NULL, NULL, NULL, NULL, NULL
  )
  ON CONFLICT (user_id) DO NOTHING;

  -- Serialize concurrent inserts for this user.
  PERFORM 1 FROM public.user_quotas WHERE user_id = NEW.user_id FOR UPDATE;

  SELECT e.max_posts_per_day, e.max_posts_per_month
  INTO v_max_day, v_max_month
  FROM public.effective_user_quotas(NEW.user_id) e;

  SELECT COUNT(*)::integer INTO v_posts_today
  FROM public.posts
  WHERE user_id = NEW.user_id AND created_at >= date_trunc('day', now());

  SELECT COUNT(*)::integer INTO v_posts_month
  FROM public.posts
  WHERE user_id = NEW.user_id AND created_at >= date_trunc('month', now());

  IF v_max_day IS DISTINCT FROM -1 AND v_posts_today >= v_max_day THEN
    RAISE EXCEPTION 'POST_QUOTA_DAILY_EXCEEDED: Daily post limit of % reached. Upgrade your plan or try again tomorrow.', v_max_day
      USING ERRCODE = 'check_violation';
  END IF;

  IF v_max_month IS DISTINCT FROM -1 AND v_posts_month >= v_max_month THEN
    RAISE EXCEPTION 'POST_QUOTA_MONTHLY_EXCEEDED: Monthly post limit of % reached. Upgrade your plan or wait until next month.', v_max_month
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.user_quotas
  SET posts_today       = v_posts_today + 1,
      posts_this_month  = v_posts_month + 1,
      daily_reset_date  = v_next_day,
      quota_reset_date  = v_next_month,
      updated_at        = now()
  WHERE user_id = NEW.user_id;

  RETURN NEW;
END;
$$;


--
-- Name: enqueue_agent_reply(uuid, text, text, text, text, text, timestamp with time zone, jsonb, text, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.enqueue_agent_reply(p_social_account_id uuid, p_platform text, p_message_id text, p_conversation_id text, p_recipient_id text, p_inbound_text text, p_inbound_at timestamp with time zone, p_media jsonb DEFAULT '{}'::jsonb, p_language_hint text DEFAULT NULL::text, p_comment_id text DEFAULT NULL::text, p_lease_seconds integer DEFAULT 180) RETURNS TABLE(id uuid, newly_enqueued boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_user_id UUID;
  v_id UUID;
BEGIN
  IF p_lease_seconds <= 0 THEN
    RAISE EXCEPTION 'enqueue_agent_reply requires a positive lease';
  END IF;

  SELECT sa.user_id INTO v_user_id
    FROM public.social_accounts sa WHERE sa.id = p_social_account_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'unknown social account %', p_social_account_id;
  END IF;

  INSERT INTO public.pending_agent_replies (
    social_account_id, user_id, platform, message_id, conversation_id, recipient_id,
    inbound_text, inbound_at, media_url, media_kind, media_caption, unread_attachments,
    media_expires_at, language_hint, comment_id, lease_expires_at
  ) VALUES (
    p_social_account_id, v_user_id, p_platform, p_message_id, p_conversation_id,
    p_recipient_id, p_inbound_text, p_inbound_at,
    p_media->>'url', p_media->>'kind', p_media->>'caption',
    COALESCE((p_media->>'unread')::int, 0),
    (p_media->>'expires_at')::timestamptz, p_language_hint, p_comment_id,
    -- The enqueuing invocation IS the first owner, so it takes the lease here.
    --
    -- Leaving this NULL would make a brand-new row immediately claimable, and the webhook
    -- never calls claim_agent_replies -- it enqueues and then processes inline. A cron tick
    -- landing inside that ~50s window would claim the row and re-run the agent CONCURRENTLY
    -- with the invocation still working on it. 180s exceeds the 60s worker ceiling, so the
    -- lease outlives any living owner; a row whose owner died early becomes claimable when
    -- it lapses.
    now() + make_interval(secs => p_lease_seconds)
  )
  ON CONFLICT ON CONSTRAINT pending_agent_replies_dedup DO NOTHING
  RETURNING pending_agent_replies.id INTO v_id;

  IF v_id IS NOT NULL THEN
    RETURN QUERY SELECT v_id, TRUE;
  ELSE
    RETURN QUERY
      SELECT p.id, FALSE FROM public.pending_agent_replies p
       WHERE p.social_account_id = p_social_account_id AND p.message_id = p_message_id;
  END IF;
END;
$$;


--
-- Name: ensure_personal_workspace(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.ensure_personal_workspace(p_user_id uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: generate_referral_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.generate_referral_code() RETURNS character varying
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
DECLARE
  new_code VARCHAR(20);
  code_exists BOOLEAN;
BEGIN
  LOOP
    -- Generate a random 8-character alphanumeric code
    new_code := UPPER(SUBSTRING(MD5(RANDOM()::TEXT || CLOCK_TIMESTAMP()::TEXT) FROM 1 FOR 8));
    
    -- Check if code already exists
    SELECT EXISTS(SELECT 1 FROM profiles WHERE referral_code = new_code) INTO code_exists;
    
    -- Exit loop if unique
    EXIT WHEN NOT code_exists;
  END LOOP;
  
  RETURN new_code;
END;
$$;


--
-- Name: get_active_ai_model_config(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_active_ai_model_config(p_user_id uuid, p_feature text DEFAULT 'general'::text) RETURNS TABLE(provider_code text, model_id text, model_name text, api_endpoint text, api_key_env_var text, api_type text, supports_streaming boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_pref_model_id UUID;
  v_system_default JSONB;
BEGIN
  SELECT amp.model_id INTO v_pref_model_id
  FROM public.ai_model_preferences amp
  WHERE amp.user_id = p_user_id AND amp.feature = p_feature;

  IF v_pref_model_id IS NOT NULL THEN
    RETURN QUERY
    SELECT ap.provider_code, am.model_id, am.name, ap.api_endpoint, ap.api_key_env_var, ap.api_type, ap.supports_streaming
    FROM public.ai_models am JOIN public.ai_providers ap ON ap.id = am.provider_id
    WHERE am.id = v_pref_model_id AND am.is_active AND ap.is_active LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  SELECT ss.value INTO v_system_default FROM public.system_settings ss WHERE ss.key = 'default_ai_model_' || p_feature;
  IF v_system_default IS NOT NULL THEN
    RETURN QUERY
    SELECT ap.provider_code, am.model_id, am.name, ap.api_endpoint, ap.api_key_env_var, ap.api_type, ap.supports_streaming
    FROM public.ai_models am JOIN public.ai_providers ap ON ap.id = am.provider_id
    WHERE ap.provider_code = (v_system_default->>'provider_code') AND am.model_id = (v_system_default->>'model_id') AND am.is_active AND ap.is_active LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  SELECT ss.value INTO v_system_default FROM public.system_settings ss WHERE ss.key = 'default_ai_model';
  IF v_system_default IS NOT NULL THEN
    RETURN QUERY
    SELECT ap.provider_code, am.model_id, am.name, ap.api_endpoint, ap.api_key_env_var, ap.api_type, ap.supports_streaming
    FROM public.ai_models am JOIN public.ai_providers ap ON ap.id = am.provider_id
    WHERE ap.provider_code = (v_system_default->>'provider_code') AND am.model_id = (v_system_default->>'model_id') AND am.is_active AND ap.is_active LIMIT 1;
    IF FOUND THEN RETURN; END IF;
  END IF;

  RETURN QUERY SELECT 'gemini'::TEXT, 'gemini-2.5-flash'::TEXT, 'Gemini 2.5 Flash (Fallback)'::TEXT,
    'https://generativelanguage.googleapis.com/v1beta'::TEXT, 'GOOGLE_AI_STUDIO_KEY'::TEXT, 'google'::TEXT, true::BOOLEAN;
END;
$$;


--
-- Name: get_cdn_provider_counts(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_cdn_provider_counts() RETURNS TABLE(cloudinary_only bigint, "both" bigint, openinary_only bigint)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  WITH versions AS (
    SELECT media_file_id, object_version,
      bool_or(provider = 'cloudinary') AS has_cloudinary,
      bool_or(provider = 'openinary') AS has_openinary
    FROM public.media_file_providers
    WHERE status = 'ready'
    GROUP BY media_file_id, object_version
  )
  SELECT count(*) FILTER (WHERE has_cloudinary AND NOT has_openinary),
         count(*) FILTER (WHERE has_cloudinary AND has_openinary),
         count(*) FILTER (WHERE has_openinary AND NOT has_cloudinary)
  FROM versions
  WHERE public.has_role(auth.uid(), 'admin');
$$;


--
-- Name: get_checklist_progress(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_checklist_progress() RETURNS TABLE(total_items bigint, completed_items bigint, progress_percentage numeric)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT 
    COUNT(*)::BIGINT,
    COUNT(*) FILTER (WHERE is_completed = true)::BIGINT,
    CASE 
      WHEN COUNT(*) > 0 THEN ROUND((COUNT(*) FILTER (WHERE is_completed = true)::NUMERIC / COUNT(*)) * 100, 1)
      ELSE 0 
    END
  FROM public.launch_checklist;
END;
$$;


--
-- Name: get_coupon_stats(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_coupon_stats(p_coupon_id uuid) RETURNS TABLE(total_redemptions bigint, unique_users bigint, total_discount numeric, avg_discount numeric)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT,
    COUNT(DISTINCT user_id)::BIGINT,
    COALESCE(SUM(discount_applied), 0),
    COALESCE(AVG(discount_applied), 0)
  FROM public.coupon_redemptions
  WHERE coupon_id = p_coupon_id;
END;
$$;


--
-- Name: get_cron_jobs(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_cron_jobs() RETURNS TABLE(jobid bigint, jobname text, schedule text, active boolean, command text, nodename text, nodeport integer, database text, username text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'cron'
    AS $$
  SELECT j.jobid, j.jobname, j.schedule, j.active, j.command,
         j.nodename, j.nodeport, j.database, j.username
  FROM cron.job j
  ORDER BY j.jobname;
$$;


--
-- Name: get_cron_secret(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_cron_secret() RETURNS text
    LANGUAGE sql SECURITY DEFINER
    AS $$ SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='cron_secret' LIMIT 1 $$;


--
-- Name: get_edge_function_statuses(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_edge_function_statuses() RETURNS TABLE(function_name text, status text, checked_at timestamp with time zone, invocations_last_hour integer, avg_execution_time_ms numeric, error_rate numeric, last_error text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT ON (function_name)
    function_name,
    status,
    checked_at,
    invocations_last_hour,
    avg_execution_time_ms,
    error_rate,
    last_error
  FROM public.edge_function_status
  ORDER BY function_name, checked_at DESC;
END;
$$;


--
-- Name: get_email_stats(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_email_stats(p_days integer DEFAULT 30) RETURNS TABLE(total_sent bigint, delivered_rate numeric, open_rate numeric, click_rate numeric)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT,
    CASE 
      WHEN COUNT(*) > 0 THEN ROUND((COUNT(*) FILTER (WHERE status IN ('delivered', 'opened', 'clicked'))::NUMERIC / COUNT(*)) * 100, 2)
      ELSE 0
    END,
    CASE 
      WHEN COUNT(*) FILTER (WHERE status = 'delivered') > 0 THEN 
        ROUND((COUNT(*) FILTER (WHERE status IN ('opened', 'clicked'))::NUMERIC / COUNT(*) FILTER (WHERE status = 'delivered')) * 100, 2)
      ELSE 0
    END,
    CASE 
      WHEN COUNT(*) FILTER (WHERE status = 'opened') > 0 THEN 
        ROUND((COUNT(*) FILTER (WHERE status = 'clicked')::NUMERIC / COUNT(*) FILTER (WHERE status = 'opened')) * 100, 2)
      ELSE 0
    END
  FROM public.email_log
  WHERE created_at > NOW() - MAKE_INTERVAL(days => p_days);
END;
$$;


--
-- Name: get_health_history(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_health_history(p_hours integer DEFAULT 24) RETURNS TABLE(captured_at timestamp with time zone, health_score integer, health_status text, api_requests_per_minute integer, active_sessions integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    captured_at,
    health_score,
    health_status,
    api_requests_per_minute,
    active_sessions
  FROM public.system_health_snapshots
  WHERE captured_at > NOW() - MAKE_INTERVAL(hours => p_hours)
  ORDER BY captured_at ASC;
END;
$$;


--
-- Name: get_latest_health_snapshot(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_latest_health_snapshot() RETURNS TABLE(id uuid, captured_at timestamp with time zone, health_score integer, health_status text, db_connections integer, api_requests_per_minute integer, active_sessions integer, total_users integer, mrr numeric, alerts_active integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    id,
    captured_at,
    health_score,
    health_status,
    db_connections,
    api_requests_per_minute,
    active_sessions,
    total_users,
    mrr,
    alerts_active
  FROM public.system_health_snapshots
  ORDER BY captured_at DESC
  LIMIT 1;
END;
$$;


--
-- Name: get_my_notifications(boolean, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_my_notifications(p_unread_only boolean DEFAULT false, p_limit integer DEFAULT 50) RETURNS TABLE(id uuid, title text, message text, type text, priority text, action_label text, action_url text, published_at timestamp with time zone, expires_at timestamp with time zone, read_at timestamp with time zone, dismissible boolean)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    n.id,
    n.title,
    n.message,
    n.type,
    n.priority,
    n.action_label,
    n.action_url,
    n.published_at,
    n.expires_at,
    nr.read_at,
    n.dismissible
  FROM public.system_notifications n
  LEFT JOIN public.notification_reads nr ON nr.notification_id = n.id AND nr.user_id = auth.uid()
  WHERE n.published_at <= NOW()
    AND (n.expires_at IS NULL OR n.expires_at > NOW())
    AND (
      n.target_type = 'all'
      OR (n.target_type = 'role' AND EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = auth.uid() AND role::text = ANY(n.target_roles) -- Fixed cast
      ))
      OR (n.target_type = 'user' AND auth.uid() = ANY(n.target_users))
      -- Fixed: Territory targeting disabled
      -- OR (n.target_type = 'territory' AND EXISTS (
      --   SELECT 1 FROM public.profiles
      --   WHERE id = auth.uid() AND area = ANY(n.target_territories)
      -- ))
    )
    AND (NOT p_unread_only OR nr.read_at IS NULL)
  ORDER BY
    CASE n.priority
      WHEN 'urgent' THEN 1
      WHEN 'high' THEN 2
      WHEN 'normal' THEN 3
      ELSE 4
    END,
    n.published_at DESC
  LIMIT p_limit;
END;
$$;


--
-- Name: get_notification_stats(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_notification_stats(p_notification_id uuid) RETURNS TABLE(total_reads bigint, unique_readers bigint, read_rate numeric)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    COUNT(*)::BIGINT,
    COUNT(DISTINCT user_id)::BIGINT,
    CASE
      WHEN n.total_recipients > 0 THEN ROUND((COUNT(*)::NUMERIC / NULLIF(n.total_recipients, 0)) * 100, 2)
      ELSE 0
    END
  FROM public.notification_reads nr, public.system_notifications n
  WHERE nr.notification_id = p_notification_id
    AND n.id = p_notification_id;
END;
$$;


--
-- Name: get_openinary_backfill_batch(integer, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_openinary_backfill_batch(p_limit integer, p_retry_failed boolean DEFAULT false) RETURNS TABLE(media_file_id uuid, object_version integer, object_key text, delivery_url text)
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT c.media_file_id, c.object_version, c.object_key, c.delivery_url
  FROM public.media_file_providers c
  WHERE c.provider = 'cloudinary'
    AND c.status = 'ready'
    AND NOT EXISTS (
      SELECT 1
      FROM public.media_file_providers o
      WHERE o.media_file_id = c.media_file_id
        AND o.object_version = c.object_version
        AND o.provider = 'openinary'
        AND (NOT p_retry_failed OR o.status = 'ready')
    )
  ORDER BY c.created_at
  LIMIT GREATEST(p_limit, 0);
$$;


--
-- Name: get_system_logs_filtered(text, text, integer, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_system_logs_filtered(p_level text DEFAULT NULL::text, p_service text DEFAULT NULL::text, p_hours integer DEFAULT 24, p_limit integer DEFAULT 100) RETURNS TABLE(id uuid, created_at timestamp with time zone, level text, service text, component text, message text, error_code text, user_id uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  RETURN QUERY
  SELECT
    id, created_at, level, service, component, message, error_code, user_id
  FROM public.system_logs
  WHERE created_at > NOW() - MAKE_INTERVAL(hours => p_hours)
    AND (p_level IS NULL OR level = p_level)
    AND (p_service IS NULL OR service = p_service)
  ORDER BY created_at DESC
  LIMIT p_limit;
END;
$$;


--
-- Name: get_user_role(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.get_user_role(_user_id uuid) RETURNS public.app_role
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT COALESCE(
    (SELECT role FROM public.user_roles WHERE user_id = _user_id ORDER BY 
      CASE role 
        WHEN 'admin' THEN 1 
        WHEN 'subscriber' THEN 2 
        WHEN 'user' THEN 3 
      END 
      LIMIT 1),
    'user'::app_role
  )
$$;


--
-- Name: handle_new_user(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name, avatar_url, api_key)
  VALUES (
    NEW.id,
    NEW.email,
    COALESCE(NEW.raw_user_meta_data ->> 'full_name', NEW.raw_user_meta_data ->> 'name'),
    NEW.raw_user_meta_data ->> 'avatar_url',
    'postora-' || gen_random_uuid()
  )
  ON CONFLICT (id) DO UPDATE SET
    email = EXCLUDED.email,
    full_name = COALESCE(EXCLUDED.full_name, profiles.full_name),
    avatar_url = COALESCE(EXCLUDED.avatar_url, profiles.avatar_url),
    updated_at = now();

  INSERT INTO public.user_quotas (user_id, max_profiles, max_social_accounts, max_posts_per_month, posts_this_month, quota_reset_date)
  VALUES (
    NEW.id,
    1,
    4,
    30,
    0,
    (date_trunc('month', now()) + interval '1 month')::timestamptz
  )
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$$;


--
-- Name: handle_new_user_quota(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user_quota() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  -- Limits are deliberately NULL: inherit from subscription_plans.
  INSERT INTO public.user_quotas (
    user_id, posts_this_month, quota_reset_date,
    max_profiles, max_social_accounts, max_posts_per_month,
    max_posts_per_day, max_media_uploads_per_day
  )
  VALUES (
    NEW.id, 0, (date_trunc('month', now()) + interval '1 month')::timestamptz,
    NULL, NULL, NULL, NULL, NULL
  )
  ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$;


--
-- Name: handle_new_user_referral_code(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user_referral_code() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  -- Generate and assign a unique referral code
  NEW.referral_code := generate_referral_code();
  RETURN NEW;
END;
$$;


--
-- Name: handle_new_user_role(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_new_user_role() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  INSERT INTO public.user_roles (user_id, role)
  VALUES (NEW.id, 'user');
  RETURN NEW;
END;
$$;


--
-- Name: handle_subscription_change(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.handle_subscription_change() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_plan_slug text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT slug INTO v_plan_slug
    FROM subscription_plans
    WHERE id = NEW.plan_id;

    PERFORM set_user_quotas_for_plan(NEW.user_id, v_plan_slug);
  ELSIF OLD.plan_id IS DISTINCT FROM NEW.plan_id THEN
    SELECT slug INTO v_plan_slug
    FROM subscription_plans
    WHERE id = NEW.plan_id;

    PERFORM set_user_quotas_for_plan(NEW.user_id, v_plan_slug);
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: FUNCTION handle_subscription_change(); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.handle_subscription_change() IS 'Trigger fn: clears per-user quota overrides only on a real plan_id change (INSERT, or UPDATE where the value differs) - branches explicitly on TG_OP so OLD is never referenced on the INSERT path, where it is unassigned.';


--
-- Name: has_role(uuid, public.app_role); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.user_roles
    WHERE user_id = _user_id
      AND role = _role
  )
$$;


--
-- Name: import_whatsapp_contacts(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.import_whatsapp_contacts(p_rows jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: import_whatsapp_contacts_to_workspace(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.import_whatsapp_contacts_to_workspace(p_workspace_id uuid, p_rows jsonb) RETURNS TABLE(imported_phone text, outcome text)
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: import_whatsapp_conversations(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.import_whatsapp_conversations(p_rows jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: import_whatsapp_messages(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.import_whatsapp_messages(p_rows jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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
$$;


--
-- Name: increment_media_uploads(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_media_uploads(p_user_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_current_uploads integer;
  v_reset_date timestamptz;
  v_max_uploads integer;
  v_is_admin boolean;
  v_next_reset timestamptz := (CURRENT_DATE + interval '1 day')::timestamptz;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN false;
  END IF;

  -- Fix round 1: admin bypass parity with can_upload_media/can_create_post
  -- (CLAUDE.md: "Admins bypass all subscription limits"). Only the "at the
  -- limit" block below is skipped for admins - they still fall through to
  -- the same counter update, so counting is never bypassed, only blocking.
  v_is_admin := public.has_role(p_user_id, 'admin'::public.app_role);

  SELECT e.max_media_uploads_per_day INTO v_max_uploads
  FROM public.effective_user_quotas(p_user_id) e;

  -- The row exists to be locked and to hold counters. Limit stays NULL so
  -- it keeps inheriting from the plan through effective_user_quotas().
  INSERT INTO public.user_quotas (
    user_id, media_uploads_today, max_media_uploads_per_day, media_daily_reset_date
  ) VALUES (
    p_user_id, 0, NULL, v_next_reset
  )
  ON CONFLICT (user_id) DO NOTHING;

  -- Serialize concurrent callers for this user.
  PERFORM 1 FROM public.user_quotas WHERE user_id = p_user_id FOR UPDATE;

  SELECT uq.media_uploads_today, uq.media_daily_reset_date
  INTO v_current_uploads, v_reset_date
  FROM public.user_quotas uq
  WHERE uq.user_id = p_user_id;

  -- Reset if past the reset window: nothing consumed yet this window.
  IF v_reset_date IS NULL OR v_reset_date <= now() THEN
    UPDATE public.user_quotas
    SET media_uploads_today = 1,
        media_daily_reset_date = v_next_reset
    WHERE user_id = p_user_id;
    RETURN true;
  END IF;

  -- Unlimited plan/override.
  IF v_max_uploads = -1 THEN
    UPDATE public.user_quotas
    SET media_uploads_today = COALESCE(v_current_uploads, 0) + 1
    WHERE user_id = p_user_id;
    RETURN true;
  END IF;

  -- At the limit: block, do not increment. Admins bypass the block but
  -- still get counted by the increment below.
  IF NOT v_is_admin AND COALESCE(v_current_uploads, 0) >= v_max_uploads THEN
    RETURN false;
  END IF;

  UPDATE public.user_quotas
  SET media_uploads_today = COALESCE(v_current_uploads, 0) + 1
  WHERE user_id = p_user_id;

  RETURN true;
END;
$$;


--
-- Name: FUNCTION increment_media_uploads(p_user_id uuid); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.increment_media_uploads(p_user_id uuid) IS 'Increments and enforces the daily media upload counter against effective_user_quotas(). Returns false without incrementing once the limit is reached; -1 = unlimited.';


--
-- Name: increment_template_use_count(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.increment_template_use_count(p_template_id uuid) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE public.workflow_templates
  SET use_count = use_count + 1
  WHERE id = p_template_id;
END;
$$;


--
-- Name: is_coupon_valid(text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_coupon_valid(p_code text, p_user_id uuid DEFAULT NULL::uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_coupon_id UUID;
  v_user_redemptions INTEGER;
BEGIN
  -- Get coupon ID
  SELECT id INTO v_coupon_id
  FROM public.coupons
  WHERE code = p_code
    AND is_active = true
    AND valid_from <= NOW()
    AND (expires_at IS NULL OR expires_at > NOW())
    AND (max_redemptions IS NULL OR total_redemptions < max_redemptions);

  IF v_coupon_id IS NULL THEN
    RETURN FALSE;
  END IF;

  -- Check per-user limit if user_id provided
  IF p_user_id IS NOT NULL THEN
    SELECT COUNT(*) INTO v_user_redemptions
    FROM public.coupon_redemptions
    WHERE coupon_id = v_coupon_id AND user_id = p_user_id;

    IF EXISTS (
      SELECT 1 FROM public.coupons
      WHERE id = v_coupon_id AND v_user_redemptions >= max_per_user
    ) THEN
      RETURN FALSE;
    END IF;
  END IF;

  RETURN TRUE;
END;
$$;


--
-- Name: is_workspace_member(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.is_workspace_member(p_workspace_id uuid, p_user_id uuid DEFAULT auth.uid()) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select exists (
    select 1
    from public.workspace_members as member
    where member.workspace_id = p_workspace_id
      and member.user_id = p_user_id
  );
$$;


--
-- Name: list_my_webhook_subscriptions(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.list_my_webhook_subscriptions() RETURNS TABLE(registry text, webhook_id text, webhook_url text, events text[], platform text, social_account_id uuid, is_active boolean, failure_count integer, created_at timestamp with time zone)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select
    'n8n'::text,
    s.value->>'webhook_id',
    s.value->>'webhook_url',
    case
      when jsonb_typeof(s.value->'events') = 'array'
        then array(select jsonb_array_elements_text(s.value->'events'))
      else null::text[]
    end,
    s.value->>'platform',
    nullif(s.value->>'social_account_id', '')::uuid,
    (s.value->>'is_active') = 'true',
    coalesce((s.value->>'failure_count')::integer, 0),
    nullif(s.value->>'created_at', '')::timestamptz
  from public.app_settings s
  where auth.uid() is not null
    -- '_' is a single-character LIKE wildcard and a UUID contains none, but escaping it
    -- keeps the prefix a literal rather than a pattern that happens to be harmless today.
    and s.key like 'n8n\_webhook\_' || auth.uid()::text || '\_%' escape '\'
    -- Belt and braces: the key encodes the owner, and so does the value. Both must agree
    -- before a row is returned.
    and s.value->>'user_id' = auth.uid()::text

  union all

  select
    'legacy'::text,
    w.id::text,
    w.url,
    w.events,
    null::text,
    null::uuid,
    w.is_active,
    coalesce(w.failure_count, 0),
    w.created_at
  from public.whatsapp_webhooks w
  where auth.uid() is not null
    and w.user_id = auth.uid();
$$;


--
-- Name: log_admin_action(text, text, text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_admin_action(p_action text, p_resource_type text, p_resource_id text DEFAULT NULL::text, p_details jsonb DEFAULT NULL::jsonb) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_admin_id UUID;
  v_log_id UUID;
BEGIN
  -- Get the current user's ID
  v_admin_id := auth.uid();
  
  -- Verify the user is an admin
  IF NOT has_role(v_admin_id, 'admin'::app_role) THEN
    RAISE EXCEPTION 'Only admins can log admin actions';
  END IF;
  
  -- Insert the audit log entry
  INSERT INTO public.admin_audit_log (admin_id, action, resource_type, resource_id, details)
  VALUES (v_admin_id, p_action, p_resource_type, p_resource_id, p_details)
  RETURNING id INTO v_log_id;
  
  RETURN v_log_id;
END;
$$;


--
-- Name: log_email_sent(text, text, uuid, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_email_sent(p_template_slug text, p_recipient_email text, p_recipient_id uuid, p_subject text, p_provider_id text DEFAULT NULL::text) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_template_id UUID;
  v_log_id UUID;
BEGIN
  SELECT id INTO v_template_id FROM public.email_templates WHERE slug = p_template_slug;
  
  INSERT INTO public.email_log (
    template_id, recipient_email, recipient_id, subject, status, provider_id, sent_at
  )
  VALUES (
    v_template_id, p_recipient_email, p_recipient_id, p_subject, 'sent', p_provider_id, NOW()
  )
  RETURNING id INTO v_log_id;
  
  RETURN v_log_id;
END;
$$;


--
-- Name: log_system_event(text, text, text, jsonb, text, text, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.log_system_event(p_level text, p_service text, p_message text, p_details jsonb DEFAULT NULL::jsonb, p_error_code text DEFAULT NULL::text, p_error_message text DEFAULT NULL::text, p_user_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_log_id UUID;
BEGIN
  INSERT INTO public.system_logs (
    level, service, message, details, error_code, error_message, user_id
  )
  VALUES (
    p_level, p_service, p_message,
    COALESCE(p_details, '{}'::jsonb),
    p_error_code, p_error_message, p_user_id
  )
  RETURNING id INTO v_log_id;

  RETURN v_log_id;
END;
$$;


--
-- Name: mark_all_notifications_read(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_all_notifications_read() RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_count INTEGER;
BEGIN
  -- Insert read records for unread notifications
  INSERT INTO public.notification_reads (notification_id, user_id, read_at)
  SELECT n.id, auth.uid(), NOW()
  FROM public.system_notifications n
  LEFT JOIN public.notification_reads nr ON nr.notification_id = n.id AND nr.user_id = auth.uid()
  WHERE n.published_at <= NOW()
    AND (n.expires_at IS NULL OR n.expires_at > NOW())
    AND (
      n.target_type = 'all'
      OR (n.target_type = 'role' AND EXISTS (
        SELECT 1 FROM public.user_roles
        WHERE user_id = auth.uid() AND role::text = ANY(n.target_roles) -- Fixed cast
      ))
      OR (n.target_type = 'user' AND auth.uid() = ANY(n.target_users))
      -- Fixed: Territory disabled
    )
    AND nr.read_at IS NULL
  ON CONFLICT (notification_id, user_id) DO NOTHING;

  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Update read counts for affected notifications
  UPDATE public.system_notifications
  SET total_reads = total_reads + 1
  WHERE id IN (
    SELECT n.id
    FROM public.system_notifications n
    LEFT JOIN public.notification_reads nr ON nr.notification_id = n.id AND nr.user_id = auth.uid()
    WHERE n.published_at <= NOW()
      AND (n.expires_at IS NULL OR n.expires_at > NOW())
      AND nr.notification_id IS NOT NULL
  );

  RETURN v_count;
END;
$$;


--
-- Name: mark_notification_dismissed(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_notification_dismissed(p_notification_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE public.notification_reads
  SET dismissed_at = NOW()
  WHERE notification_id = p_notification_id AND user_id = auth.uid();

  RETURN TRUE;
EXCEPTION
  WHEN OTHERS THEN
    RETURN FALSE;
END;
$$;


--
-- Name: mark_notification_read(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.mark_notification_read(p_notification_id uuid) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  INSERT INTO public.notification_reads (notification_id, user_id, read_at)
  VALUES (p_notification_id, auth.uid(), NOW())
  ON CONFLICT (notification_id, user_id) DO NOTHING;

  -- Update read count
  UPDATE public.system_notifications
  SET total_reads = total_reads + 1
  WHERE id = p_notification_id;

  RETURN TRUE;
EXCEPTION
  WHEN OTHERS THEN
    RETURN FALSE;
END;
$$;


--
-- Name: match_ai_knowledge_chunks(public.vector, uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_ai_knowledge_chunks(query_embedding public.vector, p_user_id uuid, match_count integer DEFAULT 6) RETURNS TABLE(id uuid, source_id uuid, content text, metadata jsonb, similarity double precision)
    LANGUAGE sql STABLE
    AS $$
  SELECT c.id, c.source_id, c.content, c.metadata,
         1 - (c.embedding <=> query_embedding) AS similarity
  FROM public.ai_knowledge_chunks c
  WHERE c.user_id = p_user_id AND c.embedding IS NOT NULL
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;


--
-- Name: match_ai_knowledge_chunks_bge_m3(public.vector, uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_ai_knowledge_chunks_bge_m3(query_embedding public.vector, p_user_id uuid, match_count integer DEFAULT 6) RETURNS TABLE(id uuid, source_id uuid, content text, metadata jsonb, similarity double precision)
    LANGUAGE sql STABLE
    AS $$ SELECT c.id,c.source_id,c.content,c.metadata,1-(c.embedding_bge_m3 <=> query_embedding) FROM public.ai_knowledge_chunks c WHERE c.user_id=p_user_id AND c.embedding_bge_m3 IS NOT NULL ORDER BY c.embedding_bge_m3 <=> query_embedding LIMIT match_count; $$;


--
-- Name: match_ai_knowledge_chunks_bge_m3_for_account(public.vector, uuid, uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_ai_knowledge_chunks_bge_m3_for_account(query_embedding public.vector, p_user_id uuid, p_social_account_id uuid, match_count integer DEFAULT 6) RETURNS TABLE(id uuid, source_id uuid, content text, metadata jsonb, similarity double precision)
    LANGUAGE sql STABLE
    AS $$
  SELECT c.id, c.source_id, c.content, c.metadata,
         1 - (c.embedding_bge_m3 <=> query_embedding) AS similarity
  FROM public.ai_knowledge_chunks AS c
  JOIN public.ai_knowledge_sources AS s
    ON s.id = c.source_id AND s.user_id = p_user_id
  WHERE c.user_id = p_user_id
    AND c.embedding_bge_m3 IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.social_accounts AS owned
      WHERE owned.id = p_social_account_id
        AND owned.user_id = p_user_id
    )
    AND (
      s.visibility = 'shared'
      OR EXISTS (
        SELECT 1
        FROM public.ai_knowledge_source_accounts AS link
        JOIN public.social_accounts AS account
          ON account.id = link.social_account_id AND account.user_id = p_user_id
        WHERE link.source_id = c.source_id
          AND link.social_account_id = p_social_account_id
      )
    )
  ORDER BY c.embedding_bge_m3 <=> query_embedding
  LIMIT match_count;
$$;


--
-- Name: match_ai_knowledge_chunks_for_account(public.vector, uuid, uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_ai_knowledge_chunks_for_account(query_embedding public.vector, p_user_id uuid, p_social_account_id uuid, match_count integer DEFAULT 6) RETURNS TABLE(id uuid, source_id uuid, content text, metadata jsonb, similarity double precision)
    LANGUAGE sql STABLE
    AS $$
  SELECT c.id, c.source_id, c.content, c.metadata,
         1 - (c.embedding <=> query_embedding) AS similarity
  FROM public.ai_knowledge_chunks AS c
  JOIN public.ai_knowledge_sources AS s
    ON s.id = c.source_id AND s.user_id = p_user_id
  WHERE c.user_id = p_user_id
    AND c.embedding IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM public.social_accounts AS owned
      WHERE owned.id = p_social_account_id
        AND owned.user_id = p_user_id
    )
    AND (
      s.visibility = 'shared'
      OR EXISTS (
        SELECT 1
        FROM public.ai_knowledge_source_accounts AS link
        JOIN public.social_accounts AS account
          ON account.id = link.social_account_id AND account.user_id = p_user_id
        WHERE link.source_id = c.source_id
          AND link.social_account_id = p_social_account_id
      )
    )
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
$$;


--
-- Name: match_ai_knowledge_graph_relations(uuid, uuid[], integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_ai_knowledge_graph_relations(p_user_id uuid, p_source_chunk_ids uuid[], match_count integer DEFAULT 12) RETURNS TABLE(source_name text, source_type text, relation text, target_name text, target_type text)
    LANGUAGE sql STABLE
    AS $$
  WITH seed_entities AS (
    SELECT relation.source_entity_id AS entity_id
    FROM public.ai_knowledge_relations relation
    WHERE relation.user_id = p_user_id
      AND relation.source_chunk_id = ANY(p_source_chunk_ids)
    UNION
    SELECT relation.target_entity_id
    FROM public.ai_knowledge_relations relation
    WHERE relation.user_id = p_user_id
      AND relation.source_chunk_id = ANY(p_source_chunk_ids)
  )
  SELECT source.name, source.type, relation.relation, target.name, target.type
  FROM public.ai_knowledge_relations relation
  JOIN public.ai_knowledge_entities source ON source.id = relation.source_entity_id
  JOIN public.ai_knowledge_entities target ON target.id = relation.target_entity_id
  WHERE relation.user_id = p_user_id
    AND (
      relation.source_entity_id IN (SELECT entity_id FROM seed_entities)
      OR relation.target_entity_id IN (SELECT entity_id FROM seed_entities)
    )
  ORDER BY relation.weight DESC, relation.created_at DESC
  LIMIT match_count;
$$;


--
-- Name: match_ai_knowledge_graph_relations_for_account(uuid, uuid, uuid[], integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.match_ai_knowledge_graph_relations_for_account(p_user_id uuid, p_social_account_id uuid, p_source_chunk_ids uuid[], match_count integer DEFAULT 12) RETURNS TABLE(source_name text, source_type text, relation text, target_name text, target_type text)
    LANGUAGE sql STABLE
    AS $$
  WITH visible_relations AS (
    SELECT relation.*
    FROM public.ai_knowledge_relations AS relation
    JOIN public.ai_knowledge_chunks AS chunk
      ON chunk.id = relation.source_chunk_id
    WHERE relation.user_id = p_user_id
      AND EXISTS (
        SELECT 1
        FROM public.social_accounts AS owned
        WHERE owned.id = p_social_account_id
          AND owned.user_id = p_user_id
      )
      AND (
        EXISTS (
          SELECT 1
          FROM public.ai_knowledge_sources AS source
          WHERE source.id = chunk.source_id
            AND source.user_id = p_user_id
            AND source.visibility = 'shared'
        )
        OR EXISTS (
          SELECT 1
          FROM public.ai_knowledge_source_accounts AS link
          JOIN public.social_accounts AS account
            ON account.id = link.social_account_id AND account.user_id = p_user_id
          WHERE link.source_id = chunk.source_id
            AND link.social_account_id = p_social_account_id
        )
      )
  ),
  seed_entities AS (
    SELECT source_entity_id AS entity_id FROM visible_relations
    WHERE source_chunk_id = ANY(p_source_chunk_ids)
    UNION
    SELECT target_entity_id FROM visible_relations
    WHERE source_chunk_id = ANY(p_source_chunk_ids)
  )
  SELECT source.name, source.type, relation.relation, target.name, target.type
  FROM visible_relations AS relation
  JOIN public.ai_knowledge_entities AS source ON source.id = relation.source_entity_id
  JOIN public.ai_knowledge_entities AS target ON target.id = relation.target_entity_id
  WHERE relation.source_entity_id IN (SELECT entity_id FROM seed_entities)
     OR relation.target_entity_id IN (SELECT entity_id FROM seed_entities)
  ORDER BY relation.weight DESC, relation.created_at DESC
  LIMIT match_count;
$$;


--
-- Name: move_whatsapp_deal(uuid, uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.move_whatsapp_deal(p_deal_id uuid, p_stage_id uuid, p_position integer) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: next_media_seq(uuid, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.next_media_seq(p_user_id uuid, p_upload_date date) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$DECLARE v int;BEGIN IF auth.uid() IS NOT NULL AND auth.uid()<>p_user_id THEN RAISE EXCEPTION 'next_media_seq: forbidden';END IF;INSERT INTO public.media_upload_counters(user_id,upload_date,last_seq)VALUES(p_user_id,p_upload_date,1)ON CONFLICT(user_id,upload_date)DO UPDATE SET last_seq=media_upload_counters.last_seq+1 RETURNING last_seq INTO v;RETURN v;END$$;


--
-- Name: normalize_workspace_invitation_email(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.normalize_workspace_invitation_email() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  new.email := lower(btrim(new.email));
  return new;
end;
$$;


--
-- Name: partner_api_keys_workspace_is_immutable(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.partner_api_keys_workspace_is_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF NEW.workspace_id IS DISTINCT FROM OLD.workspace_id THEN
    RAISE EXCEPTION
      'partner_api_keys_workspace_is_immutable: a partner key cannot change workspace (% -> %); revoke it and mint a new one',
      OLD.workspace_id, NEW.workspace_id
      USING ERRCODE = 'raise_exception';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: partner_audit_logs_assert_tenancy(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.partner_audit_logs_assert_tenancy() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_found BOOLEAN;
BEGIN
  -- FOR KEY SHARE, not a bare EXISTS. A plain read leaves a race a foreign
  -- key does not have: one transaction checks that the key is in workspace A
  -- and inserts the audit row, while a concurrent transaction moves that key
  -- to workspace B; both commit, and the row is left attributed to a
  -- workspace its target no longer belongs to. A real FK coordinates with
  -- updates to the referenced row; this has to ask for that coordination
  -- explicitly.
  --
  -- KEY SHARE is the right strength: workspace_id is part of
  -- partner_api_keys_id_workspace_key, so it IS a key column, and KEY SHARE
  -- blocks exactly the updates that would change it while permitting ordinary
  -- non-key updates such as last_used_at -- which the send path touches on
  -- every request and must not be made to queue behind an audit write.
  SELECT TRUE INTO v_found
    FROM public.partner_api_keys k
   WHERE k.id = NEW.key_id
     AND k.workspace_id = NEW.workspace_id
     FOR KEY SHARE;

  IF v_found IS NULL THEN
    -- The constraint name is repeated in the message text on purpose:
    -- SQLERRM carries only the message, not the CONSTRAINT field, so a caller
    -- or test that wants to prove the rejection came from THIS check rather
    -- than some unrelated failure has nothing else to match on.
    RAISE EXCEPTION
      'partner_audit_logs_assert_tenancy: key % does not belong to workspace % (cross-workspace audit attribution refused)',
      NEW.key_id, NEW.workspace_id
      USING ERRCODE = 'foreign_key_violation',
            CONSTRAINT = 'partner_audit_logs_assert_tenancy';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: patch_account_metadata(uuid, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.patch_account_metadata(p_account_id uuid, p_patch jsonb) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_metadata jsonb;
BEGIN
  -- jsonb || NULL is NULL, so a null patch would erase every key rather than change none.
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'p_patch must be a jsonb object';
  END IF;

  UPDATE public.social_accounts
  SET account_metadata = COALESCE(account_metadata, '{}'::jsonb) || p_patch
  WHERE id = p_account_id AND user_id = auth.uid()
  RETURNING account_metadata INTO v_metadata;

  IF v_metadata IS NULL THEN
    RAISE EXCEPTION 'Account not found or access denied';
  END IF;

  RETURN v_metadata;
END
$$;


--
-- Name: prevent_last_workspace_owner(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prevent_last_workspace_owner() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: prune_ai_knowledge_entities(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prune_ai_knowledge_entities(p_user_id uuid) RETURNS void
    LANGUAGE sql
    AS $$
  DELETE FROM public.ai_knowledge_entities entity
  WHERE entity.user_id = p_user_id
    AND NOT EXISTS (
      SELECT 1
      FROM public.ai_knowledge_relations relation
      WHERE relation.source_entity_id = entity.id
         OR relation.target_entity_id = entity.id
    );
$$;


--
-- Name: prune_all_ai_knowledge_entities(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.prune_all_ai_knowledge_entities() RETURNS integer
    LANGUAGE sql
    AS $$
  WITH deleted AS (
    DELETE FROM public.ai_knowledge_entities entity
    WHERE NOT EXISTS (
      SELECT 1
      FROM public.ai_knowledge_relations relation
      WHERE relation.source_entity_id = entity.id
         OR relation.target_entity_id = entity.id
    )
    RETURNING 1
  )
  SELECT count(*)::integer FROM deleted;
$$;


--
-- Name: reap_exhausted_agent_replies(integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reap_exhausted_agent_replies(p_max_attempts integer) RETURNS SETOF public.pending_agent_replies
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  IF p_max_attempts <= 0 THEN
    RAISE EXCEPTION 'reap_exhausted_agent_replies requires a positive limit';
  END IF;

  RETURN QUERY
  UPDATE public.pending_agent_replies
     SET status = CASE WHEN status IN ('running','sending') THEN 'delivery_unknown'
                       ELSE 'failed' END,
         error  = COALESCE(error, 'attempts exhausted'),
         lease_expires_at = NULL
   WHERE status IN ('pending','running','ready_to_send','sending')
     AND attempts >= p_max_attempts
     AND (lease_expires_at IS NULL OR lease_expires_at < now())
  RETURNING *;
END;
$$;


--
-- Name: record_unmatched_webhook_observations(text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.record_unmatched_webhook_observations(p_platform text, p_observations jsonb) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
declare
  v_today    date := current_date;
  v_cap      constant integer := 2000;
  v_existing integer;
begin
  if p_observations is null or jsonb_typeof(p_observations) <> 'array'
     or jsonb_array_length(p_observations) = 0 then
    return;
  end if;

  -- The cap has to hold under concurrent webhook deliveries, and a counting CTE does not
  -- give that: under READ COMMITTED two sessions inserting different recipients both read
  -- the same pre-cap count. A single statement is atomic but does not serialize the
  -- predicate. This lock serializes only the unmatched path, per platform per day.
  perform pg_advisory_xact_lock(hashtext(p_platform || v_today::text));

  select count(distinct recipient_id)
    into v_existing
    from public.webhook_unmatched_observations
   where platform = p_platform
     and observed_on = v_today;

  with parsed as (
    select
      left(obs->>'recipient_id', 64)              as recipient_id,
      obs->>'event_kind'                          as event_kind,
      obs->>'reason'                              as reason,
      coalesce(obs->'summary', '{}'::jsonb)       as summary,
      nullif(obs->>'social_account_id', '')::uuid as social_account_id,
      nullif(obs->>'user_id', '')::uuid           as user_id
    from jsonb_array_elements(p_observations) as obs
    where coalesce(obs->>'recipient_id', '') <> ''
      and obs->>'event_kind' in ('message', 'comment', 'unknown')
      and obs->>'reason' in ('unknown_recipient', 'account_inactive')
  ),
  -- Collapse duplicates within this one batch first. ON CONFLICT DO UPDATE cannot touch
  -- the same row twice in a single statement, and one request routinely carries several
  -- events for the same recipient.
  grouped as (
    select
      recipient_id,
      event_kind,
      reason,
      count(*)::integer       as attempts,
      (array_agg(summary))[1] as summary,
      -- array_agg + FILTER rather than max(): no uuid aggregate exists, and this also
      -- says what is actually meant -- take any non-null id the batch carried, since
      -- every observation for one recipient resolves to the same account.
      (array_agg(social_account_id) filter (where social_account_id is not null))[1]
        as social_account_id,
      (array_agg(user_id) filter (where user_id is not null))[1]
        as user_id
    from parsed
    group by recipient_id, event_kind, reason
  ),
  -- Rank only recipients not already recorded today, so the cap admits an exact number of
  -- NEW recipients while existing rows keep incrementing however busy they get.
  ranked as (
    select
      g.*,
      case
        when exists (
          select 1
            from public.webhook_unmatched_observations e
           where e.platform = p_platform
             and e.observed_on = v_today
             and e.recipient_id = g.recipient_id
        ) then 0
        else dense_rank() over (
          order by case
            when exists (
              select 1
                from public.webhook_unmatched_observations e2
               where e2.platform = p_platform
                 and e2.observed_on = v_today
                 and e2.recipient_id = g.recipient_id
            ) then null
            else g.recipient_id
          end
        )
      end as new_recipient_rank
    from grouped g
  )
  insert into public.webhook_unmatched_observations as t (
    platform, recipient_id, event_kind, reason, observed_on,
    first_seen_at, last_seen_at, attempts, last_summary,
    social_account_id, user_id
  )
  select
    p_platform, r.recipient_id, r.event_kind, r.reason, v_today,
    now(), now(), r.attempts, r.summary,
    r.social_account_id, r.user_id
  from ranked r
  where r.new_recipient_rank = 0
     or v_existing + r.new_recipient_rank <= v_cap
  on conflict on constraint webhook_unmatched_observations_daily_key
  do update set
    attempts          = t.attempts + excluded.attempts,
    last_seen_at      = now(),
    last_summary      = excluded.last_summary,
    social_account_id = coalesce(excluded.social_account_id, t.social_account_id),
    user_id           = coalesce(excluded.user_id, t.user_id);
end;
$$;


--
-- Name: redeem_coupon(text, uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.redeem_coupon(p_code text, p_user_id uuid, p_subscription_id uuid DEFAULT NULL::uuid) RETURNS uuid
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_coupon_id UUID;
  v_redemption_id UUID;
  v_discount NUMERIC(10, 2);
BEGIN
  -- Validate and lock coupon
  SELECT id INTO v_coupon_id
  FROM public.coupons
  WHERE code = p_code
    AND is_active = true
    AND valid_from <= NOW()
    AND (expires_at IS NULL OR expires_at > NOW())
    AND (max_redemptions IS NULL OR total_redemptions < max_redemptions)
  FOR UPDATE;

  IF v_coupon_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Check per-user limit
  IF EXISTS (
    SELECT 1 FROM public.coupon_redemptions
    WHERE coupon_id = v_coupon_id AND user_id = p_user_id
  ) AND (
    SELECT COUNT(*) FROM public.coupon_redemptions
    WHERE coupon_id = v_coupon_id AND user_id = p_user_id
  ) >= (
    SELECT max_per_user FROM public.coupons WHERE id = v_coupon_id
  ) THEN
    RETURN NULL;
  END IF;

  -- Calculate discount (simplified - app should calculate based on order)
  v_discount := (
    CASE discount_type
      WHEN 'percentage' THEN discount_amount -- Should be calculated by app
      WHEN 'fixed' THEN discount_amount
      ELSE 0
    END
  ) FROM public.coupons WHERE id = v_coupon_id;

  -- Create redemption
  INSERT INTO public.coupon_redemptions (coupon_id, user_id, subscription_id, discount_applied)
  VALUES (v_coupon_id, p_user_id, p_subscription_id, v_discount)
  RETURNING id INTO v_redemption_id;

  -- Update coupon redemption count
  UPDATE public.coupons
  SET total_redemptions = total_redemptions + 1
  WHERE id = v_coupon_id;

  RETURN v_redemption_id;
END;
$$;


--
-- Name: release_ai_generation_quota(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_ai_generation_quota(p_user_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  UPDATE public.user_quotas
     SET ai_generations_today = GREATEST(0, ai_generations_today - 1),
         updated_at = now()
   WHERE user_id = p_user_id
     AND ai_generations_reset_date = CURRENT_DATE;
$$;


--
-- Name: release_partner_quota(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.release_partner_quota(p_key_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  UPDATE public.partner_api_keys
     SET current_usage_count = GREATEST(current_usage_count - 1, 0)
   WHERE id = p_key_id;
$$;


--
-- Name: render_email_template(text, jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.render_email_template(p_slug text, p_variables jsonb) RETURNS TABLE(subject text, html text)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_subject TEXT;
  v_html TEXT;
  v_key TEXT;
  v_value TEXT;
BEGIN
  -- Get template
  SELECT t.subject, t.body_html INTO v_subject, v_html
  FROM public.email_templates t
  WHERE t.slug = p_slug AND t.is_active = true;
  
  IF v_subject IS NULL THEN
    RETURN;
  END IF;
  
  -- Simple variable substitution (Note: Better done in application code)
  -- This is a basic implementation for simple cases
  FOR v_key, v_value IN SELECT * FROM jsonb_each_text(p_variables)
  LOOP
    v_subject := REPLACE(v_subject, '{{' || v_key || '}}', v_value);
    v_html := REPLACE(v_html, '{{' || v_key || '}}', v_value);
  END LOOP;
  
  RETURN QUERY SELECT v_subject, v_html;
END;
$$;


--
-- Name: reserve_ai_generation_quota(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_ai_generation_quota(p_user_id uuid) RETURNS TABLE(allowed boolean, usage_count integer, daily_limit integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_limit integer;
  v_count integer;
BEGIN
  -- Roll the daily window and increment in one statement so concurrent callers
  -- serialise on the row rather than both reading a stale count.
  UPDATE public.user_quotas q
     SET ai_generations_today =
           CASE WHEN q.ai_generations_reset_date IS DISTINCT FROM CURRENT_DATE
                THEN 1 ELSE q.ai_generations_today + 1 END,
         ai_generations_reset_date = CURRENT_DATE,
         updated_at = now()
   WHERE q.user_id = p_user_id
   RETURNING q.max_ai_generations_per_day, q.ai_generations_today
        INTO v_limit, v_count;

  -- No quota row means no plan limits have been provisioned for this user yet;
  -- deny rather than grant unlimited access.
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0, 0;
    RETURN;
  END IF;

  IF v_limit IS NOT NULL AND v_count > v_limit THEN
    UPDATE public.user_quotas SET ai_generations_today = GREATEST(0, ai_generations_today - 1), updated_at = now()
      WHERE user_id = p_user_id;
    v_count := v_count - 1;
    RETURN QUERY SELECT false, v_count, v_limit;
    RETURN;
  END IF;
  RETURN QUERY SELECT true, v_count, v_limit;
END;
$$;


--
-- Name: reserve_media_understanding(uuid, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_media_understanding(p_account_id uuid, p_cap integer) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_count INTEGER;
BEGIN
  INSERT INTO public.media_understanding_usage (social_account_id, usage_date, attempt_count)
  VALUES (p_account_id, (now() AT TIME ZONE 'utc')::date, 1)
  ON CONFLICT (social_account_id, usage_date)
  DO UPDATE SET attempt_count = media_understanding_usage.attempt_count + 1,
                updated_at    = now()
  RETURNING attempt_count INTO v_count;

  RETURN v_count <= p_cap;
END;
$$;


--
-- Name: reserve_media_understanding_attempt(uuid, integer, text, integer); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_media_understanding_attempt(p_account_id uuid, p_cap integer, p_sender_id text, p_sender_cap integer) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_sender_count  INTEGER;
  v_account_count INTEGER;
BEGIN
  INSERT INTO public.media_understanding_sender_usage
    (social_account_id, sender_id, usage_date, attempt_count)
  VALUES (p_account_id, p_sender_id, (now() AT TIME ZONE 'utc')::date, 1)
  ON CONFLICT (social_account_id, sender_id, usage_date)
  DO UPDATE SET attempt_count = media_understanding_sender_usage.attempt_count + 1,
                updated_at    = now()
  RETURNING attempt_count INTO v_sender_count;

  IF v_sender_count > p_sender_cap THEN
    RETURN 'sender_cap';
  END IF;

  INSERT INTO public.media_understanding_usage (social_account_id, usage_date, attempt_count)
  VALUES (p_account_id, (now() AT TIME ZONE 'utc')::date, 1)
  ON CONFLICT (social_account_id, usage_date)
  DO UPDATE SET attempt_count = media_understanding_usage.attempt_count + 1,
                updated_at    = now()
  RETURNING attempt_count INTO v_account_count;

  IF v_account_count > p_cap THEN
    RETURN 'account_cap';
  END IF;

  RETURN 'allowed';
END;
$$;


--
-- Name: reserve_partner_quota(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reserve_partner_quota(p_key_id uuid) RETURNS TABLE(allowed boolean, usage_count integer)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_quota INTEGER;
  v_count INTEGER;
BEGIN
  UPDATE public.partner_api_keys k
     SET current_usage_count =
           CASE WHEN k.last_reset_at < date_trunc('month', now())
                THEN 1 ELSE k.current_usage_count + 1 END,
         last_reset_at = date_trunc('month', now()),
         last_used_at  = now()
   WHERE k.id = p_key_id
   RETURNING k.monthly_quota, k.current_usage_count
        INTO v_quota, v_count;

  IF NOT FOUND THEN
    RETURN QUERY SELECT false, 0;
    RETURN;
  END IF;

  RETURN QUERY SELECT (v_quota IS NULL OR v_count <= v_quota), v_count;
END;
$$;


--
-- Name: retire_expired_workspace_invitations(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.retire_expired_workspace_invitations() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
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


--
-- Name: revoke_partner_key(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.revoke_partner_key(p_key_id uuid, p_reason text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  UPDATE public.partner_api_keys k
     SET revoked_at = now(), revoked_by = auth.uid(), revoked_reason = p_reason
   WHERE k.id = p_key_id
     AND k.revoked_at IS NULL
     AND EXISTS (
       SELECT 1 FROM public.workspace_members m
        WHERE m.workspace_id = k.workspace_id
          AND m.user_id = auth.uid()
          AND m.role IN ('owner','admin'));
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;


--
-- Name: set_ai_knowledge_source_visibility(uuid, uuid, text, uuid[]); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_ai_knowledge_source_visibility(p_user_id uuid, p_source_id uuid, p_visibility text, p_social_account_ids uuid[]) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_owned integer;
  v_requested integer;
BEGIN
  -- IS DISTINCT FROM, not <>: a NULL visibility must fail HERE with a named
  -- message rather than slipping through to the check constraint.
  IF p_visibility IS DISTINCT FROM 'shared' AND p_visibility IS DISTINCT FROM 'restricted' THEN
    RAISE EXCEPTION 'visibility must be ''shared'' or ''restricted''';
  END IF;

  -- Row lock first, so a concurrent visibility change serialises behind this
  -- one instead of interleaving with the link rewrite below. NOT FOUND (not
  -- a silent zero-row UPDATE) so a source the caller does not own is a loud
  -- refusal rather than a no-op that reports success.
  PERFORM 1
  FROM public.ai_knowledge_sources
  WHERE id = p_source_id AND user_id = p_user_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Knowledge source not found for caller';
  END IF;

  -- Duplicate ids are collapsed rather than trusted: counting distinct rows
  -- against a duplicated array would misfire the ownership check, and the
  -- insert would hit the (source_id, social_account_id) primary key anyway.
  SELECT count(DISTINCT account_id) INTO v_requested
  FROM unnest(COALESCE(p_social_account_ids, '{}')) AS account_id;
  IF v_requested > 0 THEN
    SELECT count(DISTINCT id) INTO v_owned
    FROM public.social_accounts
    WHERE id = ANY(p_social_account_ids) AND user_id = p_user_id;
    IF v_owned <> v_requested THEN
      RAISE EXCEPTION 'One or more accounts do not belong to the caller';
    END IF;
  END IF;

  UPDATE public.ai_knowledge_sources
  SET visibility = p_visibility
  WHERE id = p_source_id AND user_id = p_user_id;

  DELETE FROM public.ai_knowledge_source_accounts
  WHERE source_id = p_source_id;

  IF p_visibility = 'restricted' THEN
    INSERT INTO public.ai_knowledge_source_accounts (source_id, social_account_id, user_id)
    SELECT p_source_id, account_id, p_user_id
    FROM (SELECT DISTINCT account_id FROM unnest(COALESCE(p_social_account_ids, '{}')) AS account_id) AS ids;
  END IF;
END;
$$;


--
-- Name: set_user_quotas_for_plan(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_user_quotas_for_plan(p_user_id uuid, p_plan_slug text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  INSERT INTO public.user_quotas (
    user_id, updated_at,
    max_posts_per_day, max_posts_per_month, max_profiles,
    max_social_accounts, max_media_uploads_per_day
  )
  VALUES (
    p_user_id, now(),
    NULL, NULL, NULL, NULL, NULL
  )
  ON CONFLICT (user_id) DO UPDATE SET
    max_posts_per_day         = NULL,
    max_posts_per_month       = NULL,
    max_profiles              = NULL,
    max_social_accounts       = NULL,
    max_media_uploads_per_day = NULL,
    updated_at                = now();
END;
$$;


--
-- Name: FUNCTION set_user_quotas_for_plan(p_user_id uuid, p_plan_slug text); Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON FUNCTION public.set_user_quotas_for_plan(p_user_id uuid, p_plan_slug text) IS 'Clears per-user overrides so the user inherits their plan. p_plan_slug retained for caller compatibility and intentionally unused.';


--
-- Name: set_whatsapp_workspace_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_whatsapp_workspace_updated_at() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
begin
  new.updated_at := now();
  return new;
end;
$$;


--
-- Name: social_account_inbound_activity(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.social_account_inbound_activity() RETURNS TABLE(social_account_id uuid, last_event_at timestamp with time zone, events_7d bigint)
    LANGUAGE sql STABLE
    SET search_path TO 'public', 'pg_temp'
    AS $$
  with combined as (
    select e.social_account_id, e.created_at
      from public.social_inbox_events e
    union all
    -- created_at, not timestamp: we want when Postora received it, which is what makes
    -- this a webhook-delivery diagnostic rather than a message-age one.
    select m.social_account_id, m.created_at
      from public.whatsapp_messages m
     where m.direction = 'inbound'
  )
  select
    c.social_account_id,
    max(c.created_at),
    count(*) filter (where c.created_at >= now() - interval '7 days')
  from combined c
  where c.social_account_id is not null
  group by c.social_account_id;
$$;


--
-- Name: sync_contact_to_conversations(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.sync_contact_to_conversations() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  -- Only sync if display_name or avatar_url actually changed
  IF (NEW.display_name IS DISTINCT FROM OLD.display_name)
     OR (NEW.avatar_url IS DISTINCT FROM OLD.avatar_url) THEN

    UPDATE public.messaging_cache
       SET participant_name   = COALESCE(NEW.display_name, participant_name),
           participant_avatar = COALESCE(NEW.avatar_url, participant_avatar),
           updated_at = now()
     WHERE user_id = NEW.user_id
       AND platform = 'whatsapp'
       AND conversation_id LIKE 'wa_%_' || NEW.phone_number;
  END IF;

  RETURN NEW;
END;
$$;


--
-- Name: toggle_checklist_item(uuid, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.toggle_checklist_item(p_item_id uuid, p_completed boolean) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE public.launch_checklist
  SET is_completed = p_completed,
      completed_at = CASE WHEN p_completed THEN NOW() ELSE NULL END,
      completed_by = CASE WHEN p_completed THEN auth.uid() ELSE NULL END,
      updated_at = NOW()
  WHERE id = p_item_id;
  
  RETURN TRUE;
END;
$$;


--
-- Name: toggle_cron_job(bigint, boolean); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.toggle_cron_job(_jobid bigint, _active boolean) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public', 'cron'
    AS $$
  UPDATE cron.job SET active = _active WHERE jobid = _jobid;
$$;


--
-- Name: touch_partner_key(uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.touch_partner_key(p_key_id uuid) RETURNS void
    LANGUAGE sql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  UPDATE public.partner_api_keys SET last_used_at = now() WHERE id = p_key_id;
$$;


--
-- Name: update_coupons_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_coupons_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_email_status(text, text, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_email_status(p_provider_id text, p_status text, p_error_message text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
BEGIN
  UPDATE public.email_log
  SET status = p_status,
      error_message = p_error_message,
      opened_at = CASE WHEN p_status = 'opened' AND opened_at IS NULL THEN NOW() ELSE opened_at END,
      clicked_at = CASE WHEN p_status = 'clicked' AND clicked_at IS NULL THEN NOW() ELSE clicked_at END
  WHERE provider_id = p_provider_id;
  
  RETURN FOUND;
END;
$$;


--
-- Name: update_ticket_status(uuid, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_ticket_status(p_ticket_id uuid, p_status text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_old_status TEXT;
BEGIN
  SELECT status INTO v_old_status FROM public.support_tickets WHERE id = p_ticket_id;
  
  UPDATE public.support_tickets
  SET status = p_status,
      updated_at = NOW(),
      resolved_at = CASE WHEN p_status IN ('resolved', 'closed') THEN NOW() ELSE resolved_at END
  WHERE id = p_ticket_id;
  
  -- Log activity
  INSERT INTO public.ticket_activities (ticket_id, actor_id, action, details)
  VALUES (
    p_ticket_id, 
    auth.uid(), 
    'status_change', 
    jsonb_build_object('old_status', v_old_status, 'new_status', p_status)
  );
  
  RETURN TRUE;
END;
$$;


--
-- Name: update_tickets_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_tickets_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: use_credits(uuid, integer, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.use_credits(p_user_id uuid, p_amount integer, p_description text DEFAULT NULL::text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
DECLARE
  v_current_balance INTEGER;
BEGIN
  -- Get current balance
  SELECT balance INTO v_current_balance
  FROM user_credits
  WHERE user_id = p_user_id;

  -- Check if user has enough credits
  IF v_current_balance IS NULL OR v_current_balance < p_amount THEN
    RETURN FALSE;
  END IF;

  -- Deduct credits
  UPDATE user_credits
  SET 
    balance = balance - p_amount,
    total_used = total_used + p_amount,
    updated_at = now()
  WHERE user_id = p_user_id;

  -- Record transaction
  INSERT INTO credit_transactions (user_id, amount, transaction_type, description)
  VALUES (p_user_id, -p_amount, 'usage', p_description);

  RETURN TRUE;
END;
$$;


--
-- Name: validate_messaging_cache_platform(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validate_messaging_cache_platform() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
BEGIN
  IF NEW.platform NOT IN ('facebook', 'instagram', 'whatsapp') THEN
    RAISE EXCEPTION 'platform must be facebook, instagram, or whatsapp';
  END IF;
  RETURN NEW;
END;
$$;


--
-- Name: workspace_role(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.workspace_role(p_workspace_id uuid, p_user_id uuid DEFAULT auth.uid()) RETURNS text
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public', 'pg_temp'
    AS $$
  select member.role
  from public.workspace_members as member
  where member.workspace_id = p_workspace_id
    and member.user_id = p_user_id;
$$;


--
-- Name: apply_rls(jsonb, integer); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime.apply_rls(wal jsonb, max_record_bytes integer DEFAULT (1024 * 1024)) RETURNS SETOF realtime.wal_rls
    LANGUAGE plpgsql
    AS $$
declare
-- Regclass of the table e.g. public.notes
entity_ regclass = (quote_ident(wal ->> 'schema') || '.' || quote_ident(wal ->> 'table'))::regclass;

-- I, U, D, T: insert, update ...
action realtime.action = (
    case wal ->> 'action'
        when 'I' then 'INSERT'
        when 'U' then 'UPDATE'
        when 'D' then 'DELETE'
        else 'ERROR'
    end
);

-- Is row level security enabled for the table
is_rls_enabled bool = relrowsecurity from pg_class where oid = entity_;

subscriptions realtime.subscription[] = array_agg(subs)
    from
        realtime.subscription subs
    where
        subs.entity = entity_;

-- Subscription vars
roles regrole[] = array_agg(distinct us.claims_role::text)
    from
        unnest(subscriptions) us;

working_role regrole;
claimed_role regrole;
claims jsonb;

subscription_id uuid;
subscription_has_access bool;
visible_to_subscription_ids uuid[] = '{}';

-- structured info for wal's columns
columns realtime.wal_column[];
-- previous identity values for update/delete
old_columns realtime.wal_column[];

error_record_exceeds_max_size boolean = octet_length(wal::text) > max_record_bytes;

-- Primary jsonb output for record
output jsonb;

begin
perform set_config('role', null, true);

columns =
    array_agg(
        (
            x->>'name',
            x->>'type',
            x->>'typeoid',
            realtime.cast(
                (x->'value') #>> '{}',
                coalesce(
                    (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                    (x->>'type')::regtype
                )
            ),
            (pks ->> 'name') is not null,
            true
        )::realtime.wal_column
    )
    from
        jsonb_array_elements(wal -> 'columns') x
        left join jsonb_array_elements(wal -> 'pk') pks
            on (x ->> 'name') = (pks ->> 'name');

old_columns =
    array_agg(
        (
            x->>'name',
            x->>'type',
            x->>'typeoid',
            realtime.cast(
                (x->'value') #>> '{}',
                coalesce(
                    (x->>'typeoid')::regtype, -- null when wal2json version <= 2.4
                    (x->>'type')::regtype
                )
            ),
            (pks ->> 'name') is not null,
            true
        )::realtime.wal_column
    )
    from
        jsonb_array_elements(wal -> 'identity') x
        left join jsonb_array_elements(wal -> 'pk') pks
            on (x ->> 'name') = (pks ->> 'name');

for working_role in select * from unnest(roles) loop

    -- Update `is_selectable` for columns and old_columns
    columns =
        array_agg(
            (
                c.name,
                c.type_name,
                c.type_oid,
                c.value,
                c.is_pkey,
                pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
            )::realtime.wal_column
        )
        from
            unnest(columns) c;

    old_columns =
            array_agg(
                (
                    c.name,
                    c.type_name,
                    c.type_oid,
                    c.value,
                    c.is_pkey,
                    pg_catalog.has_column_privilege(working_role, entity_, c.name, 'SELECT')
                )::realtime.wal_column
            )
            from
                unnest(old_columns) c;

    if action <> 'DELETE' and count(1) = 0 from unnest(columns) c where c.is_pkey then
        return next (
            jsonb_build_object(
                'schema', wal ->> 'schema',
                'table', wal ->> 'table',
                'type', action
            ),
            is_rls_enabled,
            -- subscriptions is already filtered by entity
            (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
            array['Error 400: Bad Request, no primary key']
        )::realtime.wal_rls;

    -- The claims role does not have SELECT permission to the primary key of entity
    elsif action <> 'DELETE' and sum(c.is_selectable::int) <> count(1) from unnest(columns) c where c.is_pkey then
        return next (
            jsonb_build_object(
                'schema', wal ->> 'schema',
                'table', wal ->> 'table',
                'type', action
            ),
            is_rls_enabled,
            (select array_agg(s.subscription_id) from unnest(subscriptions) as s where claims_role = working_role),
            array['Error 401: Unauthorized']
        )::realtime.wal_rls;

    else
        output = jsonb_build_object(
            'schema', wal ->> 'schema',
            'table', wal ->> 'table',
            'type', action,
            'commit_timestamp', to_char(
                ((wal ->> 'timestamp')::timestamptz at time zone 'utc'),
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
            ),
            'columns', (
                select
                    jsonb_agg(
                        jsonb_build_object(
                            'name', pa.attname,
                            'type', pt.typname
                        )
                        order by pa.attnum asc
                    )
                from
                    pg_attribute pa
                    join pg_type pt
                        on pa.atttypid = pt.oid
                where
                    attrelid = entity_
                    and attnum > 0
                    and pg_catalog.has_column_privilege(working_role, entity_, pa.attname, 'SELECT')
            )
        )
        -- Add "record" key for insert and update
        || case
            when action in ('INSERT', 'UPDATE') then
                jsonb_build_object(
                    'record',
                    (
                        select
                            jsonb_object_agg(
                                -- if unchanged toast, get column name and value from old record
                                coalesce((c).name, (oc).name),
                                case
                                    when (c).name is null then (oc).value
                                    else (c).value
                                end
                            )
                        from
                            unnest(columns) c
                            full outer join unnest(old_columns) oc
                                on (c).name = (oc).name
                        where
                            coalesce((c).is_selectable, (oc).is_selectable)
                            and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                    )
                )
            else '{}'::jsonb
        end
        -- Add "old_record" key for update and delete
        || case
            when action = 'UPDATE' then
                jsonb_build_object(
                        'old_record',
                        (
                            select jsonb_object_agg((c).name, (c).value)
                            from unnest(old_columns) c
                            where
                                (c).is_selectable
                                and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                        )
                    )
            when action = 'DELETE' then
                jsonb_build_object(
                    'old_record',
                    (
                        select jsonb_object_agg((c).name, (c).value)
                        from unnest(old_columns) c
                        where
                            (c).is_selectable
                            and ( not error_record_exceeds_max_size or (octet_length((c).value::text) <= 64))
                            and ( not is_rls_enabled or (c).is_pkey ) -- if RLS enabled, we can't secure deletes so filter to pkey
                    )
                )
            else '{}'::jsonb
        end;

        -- Create the prepared statement
        if is_rls_enabled and action <> 'DELETE' then
            if (select 1 from pg_prepared_statements where name = 'walrus_rls_stmt' limit 1) > 0 then
                deallocate walrus_rls_stmt;
            end if;
            execute realtime.build_prepared_statement_sql('walrus_rls_stmt', entity_, columns);
        end if;

        visible_to_subscription_ids = '{}';

        for subscription_id, claims in (
                select
                    subs.subscription_id,
                    subs.claims
                from
                    unnest(subscriptions) subs
                where
                    subs.entity = entity_
                    and subs.claims_role = working_role
                    and (
                        realtime.is_visible_through_filters(columns, subs.filters)
                        or (
                          action = 'DELETE'
                          and realtime.is_visible_through_filters(old_columns, subs.filters)
                        )
                    )
        ) loop

            if not is_rls_enabled or action = 'DELETE' then
                visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
            else
                -- Check if RLS allows the role to see the record
                perform
                    -- Trim leading and trailing quotes from working_role because set_config
                    -- doesn't recognize the role as valid if they are included
                    set_config('role', trim(both '"' from working_role::text), true),
                    set_config('request.jwt.claims', claims::text, true);

                execute 'execute walrus_rls_stmt' into subscription_has_access;

                if subscription_has_access then
                    visible_to_subscription_ids = visible_to_subscription_ids || subscription_id;
                end if;
            end if;
        end loop;

        perform set_config('role', null, true);

        return next (
            output,
            is_rls_enabled,
            visible_to_subscription_ids,
            case
                when error_record_exceeds_max_size then array['Error 413: Payload Too Large']
                else '{}'
            end
        )::realtime.wal_rls;

    end if;
end loop;

perform set_config('role', null, true);
end;
$$;


--
-- Name: broadcast_changes(text, text, text, text, text, record, record, text); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime.broadcast_changes(topic_name text, event_name text, operation text, table_name text, table_schema text, new record, old record, level text DEFAULT 'ROW'::text) RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
    -- Declare a variable to hold the JSONB representation of the row
    row_data jsonb := '{}'::jsonb;
BEGIN
    IF level = 'STATEMENT' THEN
        RAISE EXCEPTION 'function can only be triggered for each row, not for each statement';
    END IF;
    -- Check the operation type and handle accordingly
    IF operation = 'INSERT' OR operation = 'UPDATE' OR operation = 'DELETE' THEN
        row_data := jsonb_build_object('old_record', OLD, 'record', NEW, 'operation', operation, 'table', table_name, 'schema', table_schema);
        PERFORM realtime.send (row_data, event_name, topic_name);
    ELSE
        RAISE EXCEPTION 'Unexpected operation type: %', operation;
    END IF;
EXCEPTION
    WHEN OTHERS THEN
        RAISE EXCEPTION 'Failed to process the row: %', SQLERRM;
END;

$$;


--
-- Name: build_prepared_statement_sql(text, regclass, realtime.wal_column[]); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime.build_prepared_statement_sql(prepared_statement_name text, entity regclass, columns realtime.wal_column[]) RETURNS text
    LANGUAGE sql
    AS $$
      /*
      Builds a sql string that, if executed, creates a prepared statement to
      tests retrive a row from *entity* by its primary key columns.
      Example
          select realtime.build_prepared_statement_sql('public.notes', '{"id"}'::text[], '{"bigint"}'::text[])
      */
          select
      'prepare ' || prepared_statement_name || ' as
          select
              exists(
                  select
                      1
                  from
                      ' || entity || '
                  where
                      ' || string_agg(quote_ident(pkc.name) || '=' || quote_nullable(pkc.value #>> '{}') , ' and ') || '
              )'
          from
              unnest(columns) pkc
          where
              pkc.is_pkey
          group by
              entity
      $$;


--
-- Name: cast(text, regtype); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime."cast"(val text, type_ regtype) RETURNS jsonb
    LANGUAGE plpgsql IMMUTABLE
    AS $$
    declare
      res jsonb;
    begin
      execute format('select to_jsonb(%L::'|| type_::text || ')', val)  into res;
      return res;
    end
    $$;


--
-- Name: check_equality_op(realtime.equality_op, regtype, text, text); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text) RETURNS boolean
    LANGUAGE plpgsql IMMUTABLE
    AS $$
      /*
      Casts *val_1* and *val_2* as type *type_* and check the *op* condition for truthiness
      */
      declare
          op_symbol text = (
              case
                  when op = 'eq' then '='
                  when op = 'neq' then '!='
                  when op = 'lt' then '<'
                  when op = 'lte' then '<='
                  when op = 'gt' then '>'
                  when op = 'gte' then '>='
                  when op = 'in' then '= any'
                  else 'UNKNOWN OP'
              end
          );
          res boolean;
      begin
          execute format(
              'select %L::'|| type_::text || ' ' || op_symbol
              || ' ( %L::'
              || (
                  case
                      when op = 'in' then type_::text || '[]'
                      else type_::text end
              )
              || ')', val_1, val_2) into res;
          return res;
      end;
      $$;


--
-- Name: is_visible_through_filters(realtime.wal_column[], realtime.user_defined_filter[]); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime.is_visible_through_filters(columns realtime.wal_column[], filters realtime.user_defined_filter[]) RETURNS boolean
    LANGUAGE sql IMMUTABLE
    AS $_$
    /*
    Should the record be visible (true) or filtered out (false) after *filters* are applied
    */
        select
            -- Default to allowed when no filters present
            $2 is null -- no filters. this should not happen because subscriptions has a default
            or array_length($2, 1) is null -- array length of an empty array is null
            or bool_and(
                coalesce(
                    realtime.check_equality_op(
                        op:=f.op,
                        type_:=coalesce(
                            col.type_oid::regtype, -- null when wal2json version <= 2.4
                            col.type_name::regtype
                        ),
                        -- cast jsonb to text
                        val_1:=col.value #>> '{}',
                        val_2:=f.value
                    ),
                    false -- if null, filter does not match
                )
            )
        from
            unnest(filters) f
            join unnest(columns) col
                on f.column_name = col.name;
    $_$;


--
-- Name: list_changes(name, name, integer, integer); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime.list_changes(publication name, slot_name name, max_changes integer, max_record_bytes integer) RETURNS SETOF realtime.wal_rls
    LANGUAGE sql
    SET log_min_messages TO 'fatal'
    AS $$
      with pub as (
        select
          concat_ws(
            ',',
            case when bool_or(pubinsert) then 'insert' else null end,
            case when bool_or(pubupdate) then 'update' else null end,
            case when bool_or(pubdelete) then 'delete' else null end
          ) as w2j_actions,
          coalesce(
            string_agg(
              realtime.quote_wal2json(format('%I.%I', schemaname, tablename)::regclass),
              ','
            ) filter (where ppt.tablename is not null and ppt.tablename not like '% %'),
            ''
          ) w2j_add_tables
        from
          pg_publication pp
          left join pg_publication_tables ppt
            on pp.pubname = ppt.pubname
        where
          pp.pubname = publication
        group by
          pp.pubname
        limit 1
      ),
      w2j as (
        select
          x.*, pub.w2j_add_tables
        from
          pub,
          pg_logical_slot_get_changes(
            slot_name, null, max_changes,
            'include-pk', 'true',
            'include-transaction', 'false',
            'include-timestamp', 'true',
            'include-type-oids', 'true',
            'format-version', '2',
            'actions', pub.w2j_actions,
            'add-tables', pub.w2j_add_tables
          ) x
      )
      select
        xyz.wal,
        xyz.is_rls_enabled,
        xyz.subscription_ids,
        xyz.errors
      from
        w2j,
        realtime.apply_rls(
          wal := w2j.data::jsonb,
          max_record_bytes := max_record_bytes
        ) xyz(wal, is_rls_enabled, subscription_ids, errors)
      where
        w2j.w2j_add_tables <> ''
        and xyz.subscription_ids[1] is not null
    $$;


--
-- Name: quote_wal2json(regclass); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime.quote_wal2json(entity regclass) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
      select
        (
          select string_agg('' || ch,'')
          from unnest(string_to_array(nsp.nspname::text, null)) with ordinality x(ch, idx)
          where
            not (x.idx = 1 and x.ch = '"')
            and not (
              x.idx = array_length(string_to_array(nsp.nspname::text, null), 1)
              and x.ch = '"'
            )
        )
        || '.'
        || (
          select string_agg('' || ch,'')
          from unnest(string_to_array(pc.relname::text, null)) with ordinality x(ch, idx)
          where
            not (x.idx = 1 and x.ch = '"')
            and not (
              x.idx = array_length(string_to_array(nsp.nspname::text, null), 1)
              and x.ch = '"'
            )
          )
      from
        pg_class pc
        join pg_namespace nsp
          on pc.relnamespace = nsp.oid
      where
        pc.oid = entity
    $$;


--
-- Name: send(jsonb, text, text, boolean); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean DEFAULT true) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  BEGIN
    -- Set the topic configuration
    EXECUTE format('SET LOCAL realtime.topic TO %L', topic);

    -- Attempt to insert the message
    INSERT INTO realtime.messages (payload, event, topic, private, extension)
    VALUES (payload, event, topic, private, 'broadcast');
  EXCEPTION
    WHEN OTHERS THEN
      -- Capture and notify the error
      PERFORM pg_notify(
          'realtime:system',
          jsonb_build_object(
              'error', SQLERRM,
              'function', 'realtime.send',
              'event', event,
              'topic', topic,
              'private', private
          )::text
      );
  END;
END;
$$;


--
-- Name: subscription_check_filters(); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime.subscription_check_filters() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    /*
    Validates that the user defined filters for a subscription:
    - refer to valid columns that the claimed role may access
    - values are coercable to the correct column type
    */
    declare
        col_names text[] = coalesce(
                array_agg(c.column_name order by c.ordinal_position),
                '{}'::text[]
            )
            from
                information_schema.columns c
            where
                format('%I.%I', c.table_schema, c.table_name)::regclass = new.entity
                and pg_catalog.has_column_privilege(
                    (new.claims ->> 'role'),
                    format('%I.%I', c.table_schema, c.table_name)::regclass,
                    c.column_name,
                    'SELECT'
                );
        filter realtime.user_defined_filter;
        col_type regtype;

        in_val jsonb;
    begin
        for filter in select * from unnest(new.filters) loop
            -- Filtered column is valid
            if not filter.column_name = any(col_names) then
                raise exception 'invalid column for filter %', filter.column_name;
            end if;

            -- Type is sanitized and safe for string interpolation
            col_type = (
                select atttypid::regtype
                from pg_catalog.pg_attribute
                where attrelid = new.entity
                      and attname = filter.column_name
            );
            if col_type is null then
                raise exception 'failed to lookup type for column %', filter.column_name;
            end if;

            -- Set maximum number of entries for in filter
            if filter.op = 'in'::realtime.equality_op then
                in_val = realtime.cast(filter.value, (col_type::text || '[]')::regtype);
                if coalesce(jsonb_array_length(in_val), 0) > 100 then
                    raise exception 'too many values for `in` filter. Maximum 100';
                end if;
            else
                -- raises an exception if value is not coercable to type
                perform realtime.cast(filter.value, col_type);
            end if;

        end loop;

        -- Apply consistent order to filters so the unique constraint on
        -- (subscription_id, entity, filters) can't be tricked by a different filter order
        new.filters = coalesce(
            array_agg(f order by f.column_name, f.op, f.value),
            '{}'
        ) from unnest(new.filters) f;

        return new;
    end;
    $$;


--
-- Name: to_regrole(text); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime.to_regrole(role_name text) RETURNS regrole
    LANGUAGE sql IMMUTABLE
    AS $$ select role_name::regrole $$;


--
-- Name: topic(); Type: FUNCTION; Schema: realtime; Owner: -
--

CREATE FUNCTION realtime.topic() RETURNS text
    LANGUAGE sql STABLE
    AS $$
select nullif(current_setting('realtime.topic', true), '')::text;
$$;


--
-- Name: add_prefixes(text, text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.add_prefixes(_bucket_id text, _name text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
    prefixes text[];
BEGIN
    prefixes := "storage"."get_prefixes"("_name");

    IF array_length(prefixes, 1) > 0 THEN
        INSERT INTO storage.prefixes (name, bucket_id)
        SELECT UNNEST(prefixes) as name, "_bucket_id" ON CONFLICT DO NOTHING;
    END IF;
END;
$$;


--
-- Name: can_insert_object(text, text, uuid, jsonb); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.can_insert_object(bucketid text, name text, owner uuid, metadata jsonb) RETURNS void
    LANGUAGE plpgsql
    AS $$
BEGIN
  INSERT INTO "storage"."objects" ("bucket_id", "name", "owner", "metadata") VALUES (bucketid, name, owner, metadata);
  -- hack to rollback the successful insert
  RAISE sqlstate 'PT200' using
  message = 'ROLLBACK',
  detail = 'rollback successful insert';
END
$$;


--
-- Name: delete_prefix(text, text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.delete_prefix(_bucket_id text, _name text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
BEGIN
    -- Check if we can delete the prefix
    IF EXISTS(
        SELECT FROM "storage"."prefixes"
        WHERE "prefixes"."bucket_id" = "_bucket_id"
          AND level = "storage"."get_level"("_name") + 1
          AND "prefixes"."name" COLLATE "C" LIKE "_name" || '/%'
        LIMIT 1
    )
    OR EXISTS(
        SELECT FROM "storage"."objects"
        WHERE "objects"."bucket_id" = "_bucket_id"
          AND "storage"."get_level"("objects"."name") = "storage"."get_level"("_name") + 1
          AND "objects"."name" COLLATE "C" LIKE "_name" || '/%'
        LIMIT 1
    ) THEN
    -- There are sub-objects, skip deletion
    RETURN false;
    ELSE
        DELETE FROM "storage"."prefixes"
        WHERE "prefixes"."bucket_id" = "_bucket_id"
          AND level = "storage"."get_level"("_name")
          AND "prefixes"."name" = "_name";
        RETURN true;
    END IF;
END;
$$;


--
-- Name: delete_prefix_hierarchy_trigger(); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.delete_prefix_hierarchy_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    prefix text;
BEGIN
    prefix := "storage"."get_prefix"(OLD."name");

    IF coalesce(prefix, '') != '' THEN
        PERFORM "storage"."delete_prefix"(OLD."bucket_id", prefix);
    END IF;

    RETURN OLD;
END;
$$;


--
-- Name: extension(text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.extension(name text) RETURNS text
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    _parts text[];
    _filename text;
BEGIN
    SELECT string_to_array(name, '/') INTO _parts;
    SELECT _parts[array_length(_parts,1)] INTO _filename;
    RETURN reverse(split_part(reverse(_filename), '.', 1));
END
$$;


--
-- Name: filename(text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.filename(name text) RETURNS text
    LANGUAGE plpgsql
    AS $$
DECLARE
_parts text[];
BEGIN
	select string_to_array(name, '/') into _parts;
	return _parts[array_length(_parts,1)];
END
$$;


--
-- Name: foldername(text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.foldername(name text) RETURNS text[]
    LANGUAGE plpgsql IMMUTABLE
    AS $$
DECLARE
    _parts text[];
BEGIN
    -- Split on "/" to get path segments
    SELECT string_to_array(name, '/') INTO _parts;
    -- Return everything except the last segment
    RETURN _parts[1 : array_length(_parts,1) - 1];
END
$$;


--
-- Name: get_level(text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.get_level(name text) RETURNS integer
    LANGUAGE sql IMMUTABLE STRICT
    AS $$
SELECT array_length(string_to_array("name", '/'), 1);
$$;


--
-- Name: get_prefix(text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.get_prefix(name text) RETURNS text
    LANGUAGE sql IMMUTABLE STRICT
    AS $_$
SELECT
    CASE WHEN strpos("name", '/') > 0 THEN
             regexp_replace("name", '[\/]{1}[^\/]+\/?$', '')
         ELSE
             ''
        END;
$_$;


--
-- Name: get_prefixes(text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.get_prefixes(name text) RETURNS text[]
    LANGUAGE plpgsql IMMUTABLE STRICT
    AS $$
DECLARE
    parts text[];
    prefixes text[];
    prefix text;
BEGIN
    -- Split the name into parts by '/'
    parts := string_to_array("name", '/');
    prefixes := '{}';

    -- Construct the prefixes, stopping one level below the last part
    FOR i IN 1..array_length(parts, 1) - 1 LOOP
            prefix := array_to_string(parts[1:i], '/');
            prefixes := array_append(prefixes, prefix);
    END LOOP;

    RETURN prefixes;
END;
$$;


--
-- Name: get_size_by_bucket(); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.get_size_by_bucket() RETURNS TABLE(size bigint, bucket_id text)
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    return query
        select sum((metadata->>'size')::bigint) as size, obj.bucket_id
        from "storage".objects as obj
        group by obj.bucket_id;
END
$$;


--
-- Name: list_multipart_uploads_with_delimiter(text, text, text, integer, text, text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.list_multipart_uploads_with_delimiter(bucket_id text, prefix_param text, delimiter_param text, max_keys integer DEFAULT 100, next_key_token text DEFAULT ''::text, next_upload_token text DEFAULT ''::text) RETURNS TABLE(key text, id text, created_at timestamp with time zone)
    LANGUAGE plpgsql
    AS $_$
BEGIN
    RETURN QUERY EXECUTE
        'SELECT DISTINCT ON(key COLLATE "C") * from (
            SELECT
                CASE
                    WHEN position($2 IN substring(key from length($1) + 1)) > 0 THEN
                        substring(key from 1 for length($1) + position($2 IN substring(key from length($1) + 1)))
                    ELSE
                        key
                END AS key, id, created_at
            FROM
                storage.s3_multipart_uploads
            WHERE
                bucket_id = $5 AND
                key ILIKE $1 || ''%'' AND
                CASE
                    WHEN $4 != '''' AND $6 = '''' THEN
                        CASE
                            WHEN position($2 IN substring(key from length($1) + 1)) > 0 THEN
                                substring(key from 1 for length($1) + position($2 IN substring(key from length($1) + 1))) COLLATE "C" > $4
                            ELSE
                                key COLLATE "C" > $4
                            END
                    ELSE
                        true
                END AND
                CASE
                    WHEN $6 != '''' THEN
                        id COLLATE "C" > $6
                    ELSE
                        true
                    END
            ORDER BY
                key COLLATE "C" ASC, created_at ASC) as e order by key COLLATE "C" LIMIT $3'
        USING prefix_param, delimiter_param, max_keys, next_key_token, bucket_id, next_upload_token;
END;
$_$;


--
-- Name: list_objects_with_delimiter(text, text, text, integer, text, text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.list_objects_with_delimiter(bucket_id text, prefix_param text, delimiter_param text, max_keys integer DEFAULT 100, start_after text DEFAULT ''::text, next_token text DEFAULT ''::text) RETURNS TABLE(name text, id uuid, metadata jsonb, updated_at timestamp with time zone)
    LANGUAGE plpgsql
    AS $_$
BEGIN
    RETURN QUERY EXECUTE
        'SELECT DISTINCT ON(name COLLATE "C") * from (
            SELECT
                CASE
                    WHEN position($2 IN substring(name from length($1) + 1)) > 0 THEN
                        substring(name from 1 for length($1) + position($2 IN substring(name from length($1) + 1)))
                    ELSE
                        name
                END AS name, id, metadata, updated_at
            FROM
                storage.objects
            WHERE
                bucket_id = $5 AND
                name ILIKE $1 || ''%'' AND
                CASE
                    WHEN $6 != '''' THEN
                    name COLLATE "C" > $6
                ELSE true END
                AND CASE
                    WHEN $4 != '''' THEN
                        CASE
                            WHEN position($2 IN substring(name from length($1) + 1)) > 0 THEN
                                substring(name from 1 for length($1) + position($2 IN substring(name from length($1) + 1))) COLLATE "C" > $4
                            ELSE
                                name COLLATE "C" > $4
                            END
                    ELSE
                        true
                END
            ORDER BY
                name COLLATE "C" ASC) as e order by name COLLATE "C" LIMIT $3'
        USING prefix_param, delimiter_param, max_keys, next_token, bucket_id, start_after;
END;
$_$;


--
-- Name: objects_insert_prefix_trigger(); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.objects_insert_prefix_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM "storage"."add_prefixes"(NEW."bucket_id", NEW."name");
    NEW.level := "storage"."get_level"(NEW."name");

    RETURN NEW;
END;
$$;


--
-- Name: objects_update_prefix_trigger(); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.objects_update_prefix_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
DECLARE
    old_prefixes TEXT[];
BEGIN
    -- Ensure this is an update operation and the name has changed
    IF TG_OP = 'UPDATE' AND (NEW."name" <> OLD."name" OR NEW."bucket_id" <> OLD."bucket_id") THEN
        -- Retrieve old prefixes
        old_prefixes := "storage"."get_prefixes"(OLD."name");

        -- Remove old prefixes that are only used by this object
        WITH all_prefixes as (
            SELECT unnest(old_prefixes) as prefix
        ),
        can_delete_prefixes as (
             SELECT prefix
             FROM all_prefixes
             WHERE NOT EXISTS (
                 SELECT 1 FROM "storage"."objects"
                 WHERE "bucket_id" = OLD."bucket_id"
                   AND "name" <> OLD."name"
                   AND "name" LIKE (prefix || '%')
             )
         )
        DELETE FROM "storage"."prefixes" WHERE name IN (SELECT prefix FROM can_delete_prefixes);

        -- Add new prefixes
        PERFORM "storage"."add_prefixes"(NEW."bucket_id", NEW."name");
    END IF;
    -- Set the new level
    NEW."level" := "storage"."get_level"(NEW."name");

    RETURN NEW;
END;
$$;


--
-- Name: operation(); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.operation() RETURNS text
    LANGUAGE plpgsql STABLE
    AS $$
BEGIN
    RETURN current_setting('storage.operation', true);
END;
$$;


--
-- Name: prefixes_insert_trigger(); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.prefixes_insert_trigger() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    PERFORM "storage"."add_prefixes"(NEW."bucket_id", NEW."name");
    RETURN NEW;
END;
$$;


--
-- Name: search(text, text, integer, integer, integer, text, text, text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.search(prefix text, bucketname text, limits integer DEFAULT 100, levels integer DEFAULT 1, offsets integer DEFAULT 0, search text DEFAULT ''::text, sortcolumn text DEFAULT 'name'::text, sortorder text DEFAULT 'asc'::text) RETURNS TABLE(name text, id uuid, updated_at timestamp with time zone, created_at timestamp with time zone, last_accessed_at timestamp with time zone, metadata jsonb)
    LANGUAGE plpgsql
    AS $$
declare
    can_bypass_rls BOOLEAN;
begin
    SELECT rolbypassrls
    INTO can_bypass_rls
    FROM pg_roles
    WHERE rolname = coalesce(nullif(current_setting('role', true), 'none'), current_user);

    IF can_bypass_rls THEN
        RETURN QUERY SELECT * FROM storage.search_v1_optimised(prefix, bucketname, limits, levels, offsets, search, sortcolumn, sortorder);
    ELSE
        RETURN QUERY SELECT * FROM storage.search_legacy_v1(prefix, bucketname, limits, levels, offsets, search, sortcolumn, sortorder);
    END IF;
end;
$$;


--
-- Name: search_legacy_v1(text, text, integer, integer, integer, text, text, text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.search_legacy_v1(prefix text, bucketname text, limits integer DEFAULT 100, levels integer DEFAULT 1, offsets integer DEFAULT 0, search text DEFAULT ''::text, sortcolumn text DEFAULT 'name'::text, sortorder text DEFAULT 'asc'::text) RETURNS TABLE(name text, id uuid, updated_at timestamp with time zone, created_at timestamp with time zone, last_accessed_at timestamp with time zone, metadata jsonb)
    LANGUAGE plpgsql STABLE
    AS $_$
declare
    v_order_by text;
    v_sort_order text;
begin
    case
        when sortcolumn = 'name' then
            v_order_by = 'name';
        when sortcolumn = 'updated_at' then
            v_order_by = 'updated_at';
        when sortcolumn = 'created_at' then
            v_order_by = 'created_at';
        when sortcolumn = 'last_accessed_at' then
            v_order_by = 'last_accessed_at';
        else
            v_order_by = 'name';
        end case;

    case
        when sortorder = 'asc' then
            v_sort_order = 'asc';
        when sortorder = 'desc' then
            v_sort_order = 'desc';
        else
            v_sort_order = 'asc';
        end case;

    v_order_by = v_order_by || ' ' || v_sort_order;

    return query execute
        'with folders as (
           select path_tokens[$1] as folder
           from storage.objects
             where objects.name ilike $2 || $3 || ''%''
               and bucket_id = $4
               and array_length(objects.path_tokens, 1) <> $1
           group by folder
           order by folder ' || v_sort_order || '
     )
     (select folder as "name",
            null as id,
            null as updated_at,
            null as created_at,
            null as last_accessed_at,
            null as metadata from folders)
     union all
     (select path_tokens[$1] as "name",
            id,
            updated_at,
            created_at,
            last_accessed_at,
            metadata
     from storage.objects
     where objects.name ilike $2 || $3 || ''%''
       and bucket_id = $4
       and array_length(objects.path_tokens, 1) = $1
     order by ' || v_order_by || ')
     limit $5
     offset $6' using levels, prefix, search, bucketname, limits, offsets;
end;
$_$;


--
-- Name: search_v1_optimised(text, text, integer, integer, integer, text, text, text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.search_v1_optimised(prefix text, bucketname text, limits integer DEFAULT 100, levels integer DEFAULT 1, offsets integer DEFAULT 0, search text DEFAULT ''::text, sortcolumn text DEFAULT 'name'::text, sortorder text DEFAULT 'asc'::text) RETURNS TABLE(name text, id uuid, updated_at timestamp with time zone, created_at timestamp with time zone, last_accessed_at timestamp with time zone, metadata jsonb)
    LANGUAGE plpgsql STABLE
    AS $_$
declare
    v_order_by text;
    v_sort_order text;
begin
    case
        when sortcolumn = 'name' then
            v_order_by = 'name';
        when sortcolumn = 'updated_at' then
            v_order_by = 'updated_at';
        when sortcolumn = 'created_at' then
            v_order_by = 'created_at';
        when sortcolumn = 'last_accessed_at' then
            v_order_by = 'last_accessed_at';
        else
            v_order_by = 'name';
        end case;

    case
        when sortorder = 'asc' then
            v_sort_order = 'asc';
        when sortorder = 'desc' then
            v_sort_order = 'desc';
        else
            v_sort_order = 'asc';
        end case;

    v_order_by = v_order_by || ' ' || v_sort_order;

    return query execute
        'with folders as (
           select (string_to_array(name, ''/''))[level] as name
           from storage.prefixes
             where lower(prefixes.name) like lower($2 || $3) || ''%''
               and bucket_id = $4
               and level = $1
           order by name ' || v_sort_order || '
     )
     (select name,
            null as id,
            null as updated_at,
            null as created_at,
            null as last_accessed_at,
            null as metadata from folders)
     union all
     (select path_tokens[level] as "name",
            id,
            updated_at,
            created_at,
            last_accessed_at,
            metadata
     from storage.objects
     where lower(objects.name) like lower($2 || $3) || ''%''
       and bucket_id = $4
       and level = $1
     order by ' || v_order_by || ')
     limit $5
     offset $6' using levels, prefix, search, bucketname, limits, offsets;
end;
$_$;


--
-- Name: search_v2(text, text, integer, integer, text); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.search_v2(prefix text, bucket_name text, limits integer DEFAULT 100, levels integer DEFAULT 1, start_after text DEFAULT ''::text) RETURNS TABLE(key text, name text, id uuid, updated_at timestamp with time zone, created_at timestamp with time zone, metadata jsonb)
    LANGUAGE plpgsql STABLE
    AS $_$
BEGIN
    RETURN query EXECUTE
        $sql$
        SELECT * FROM (
            (
                SELECT
                    split_part(name, '/', $4) AS key,
                    name || '/' AS name,
                    NULL::uuid AS id,
                    NULL::timestamptz AS updated_at,
                    NULL::timestamptz AS created_at,
                    NULL::jsonb AS metadata
                FROM storage.prefixes
                WHERE name COLLATE "C" LIKE $1 || '%'
                AND bucket_id = $2
                AND level = $4
                AND name COLLATE "C" > $5
                ORDER BY prefixes.name COLLATE "C" LIMIT $3
            )
            UNION ALL
            (SELECT split_part(name, '/', $4) AS key,
                name,
                id,
                updated_at,
                created_at,
                metadata
            FROM storage.objects
            WHERE name COLLATE "C" LIKE $1 || '%'
                AND bucket_id = $2
                AND level = $4
                AND name COLLATE "C" > $5
            ORDER BY name COLLATE "C" LIMIT $3)
        ) obj
        ORDER BY name COLLATE "C" LIMIT $3;
        $sql$
        USING prefix, bucket_name, limits, levels, start_after;
END;
$_$;


--
-- Name: update_updated_at_column(); Type: FUNCTION; Schema: storage; Owner: -
--

CREATE FUNCTION storage.update_updated_at_column() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW; 
END;
$$;


--
-- Name: audit_log_entries; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.audit_log_entries (
    instance_id uuid,
    id uuid NOT NULL,
    payload json,
    created_at timestamp with time zone,
    ip_address character varying(64) DEFAULT ''::character varying NOT NULL
);


--
-- Name: TABLE audit_log_entries; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.audit_log_entries IS 'Auth: Audit trail for user actions.';


--
-- Name: flow_state; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.flow_state (
    id uuid NOT NULL,
    user_id uuid,
    auth_code text,
    code_challenge_method auth.code_challenge_method,
    code_challenge text,
    provider_type text NOT NULL,
    provider_access_token text,
    provider_refresh_token text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    authentication_method text NOT NULL,
    auth_code_issued_at timestamp with time zone,
    invite_token text,
    referrer text,
    oauth_client_state_id uuid,
    linking_target_id uuid,
    email_optional boolean DEFAULT false NOT NULL
);


--
-- Name: TABLE flow_state; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.flow_state IS 'stores metadata for pkce logins';


--
-- Name: identities; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.identities (
    provider_id text NOT NULL,
    user_id uuid NOT NULL,
    identity_data jsonb NOT NULL,
    provider text NOT NULL,
    last_sign_in_at timestamp with time zone,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    email text GENERATED ALWAYS AS (lower((identity_data ->> 'email'::text))) STORED,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: TABLE identities; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.identities IS 'Auth: Stores identities associated to a user.';


--
-- Name: COLUMN identities.email; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON COLUMN auth.identities.email IS 'Auth: Email is a generated column that references the optional email property in the identity_data';


--
-- Name: instances; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.instances (
    id uuid NOT NULL,
    uuid uuid,
    raw_base_config text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone
);


--
-- Name: TABLE instances; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.instances IS 'Auth: Manages users across multiple sites.';


--
-- Name: mfa_amr_claims; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.mfa_amr_claims (
    session_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    authentication_method text NOT NULL,
    id uuid NOT NULL
);


--
-- Name: TABLE mfa_amr_claims; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.mfa_amr_claims IS 'auth: stores authenticator method reference claims for multi factor authentication';


--
-- Name: mfa_challenges; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.mfa_challenges (
    id uuid NOT NULL,
    factor_id uuid NOT NULL,
    created_at timestamp with time zone NOT NULL,
    verified_at timestamp with time zone,
    ip_address inet NOT NULL,
    otp_code text,
    web_authn_session_data jsonb
);


--
-- Name: TABLE mfa_challenges; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.mfa_challenges IS 'auth: stores metadata about challenge requests made';


--
-- Name: mfa_factors; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.mfa_factors (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    friendly_name text,
    factor_type auth.factor_type NOT NULL,
    status auth.factor_status NOT NULL,
    created_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone NOT NULL,
    secret text,
    phone text,
    last_challenged_at timestamp with time zone,
    web_authn_credential jsonb,
    web_authn_aaguid uuid,
    last_webauthn_challenge_data jsonb
);


--
-- Name: TABLE mfa_factors; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.mfa_factors IS 'auth: stores metadata about factors';


--
-- Name: oauth_clients; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.oauth_clients (
    id uuid NOT NULL,
    client_secret_hash text,
    registration_type auth.oauth_registration_type NOT NULL,
    redirect_uris text NOT NULL,
    grant_types text NOT NULL,
    client_name text,
    client_uri text,
    logo_uri text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    client_type auth.oauth_client_type DEFAULT 'confidential'::auth.oauth_client_type NOT NULL,
    token_endpoint_auth_method text NOT NULL
);


--
-- Name: oauth_consents; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.oauth_consents (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    client_id uuid NOT NULL,
    scopes text NOT NULL,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone
);


--
-- Name: one_time_tokens; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.one_time_tokens (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    token_type auth.one_time_token_type NOT NULL,
    token_hash text NOT NULL,
    relates_to text NOT NULL,
    created_at timestamp without time zone DEFAULT now() NOT NULL,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    CONSTRAINT one_time_tokens_token_hash_check CHECK ((char_length(token_hash) > 0))
);


--
-- Name: refresh_tokens; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.refresh_tokens (
    instance_id uuid,
    id bigint NOT NULL,
    token character varying(255),
    user_id character varying(255),
    revoked boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    parent character varying(255),
    session_id uuid
);


--
-- Name: TABLE refresh_tokens; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.refresh_tokens IS 'Auth: Store of tokens used to refresh JWT tokens once they expire.';


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE; Schema: auth; Owner: -
--

CREATE SEQUENCE auth.refresh_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: refresh_tokens_id_seq; Type: SEQUENCE OWNED BY; Schema: auth; Owner: -
--

ALTER SEQUENCE auth.refresh_tokens_id_seq OWNED BY auth.refresh_tokens.id;


--
-- Name: saml_providers; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.saml_providers (
    id uuid NOT NULL,
    sso_provider_id uuid NOT NULL,
    entity_id text NOT NULL,
    metadata_xml text NOT NULL,
    metadata_url text,
    attribute_mapping jsonb,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    name_id_format text,
    CONSTRAINT "entity_id not empty" CHECK ((char_length(entity_id) > 0)),
    CONSTRAINT "metadata_url not empty" CHECK (((metadata_url = NULL::text) OR (char_length(metadata_url) > 0))),
    CONSTRAINT "metadata_xml not empty" CHECK ((char_length(metadata_xml) > 0))
);


--
-- Name: TABLE saml_providers; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.saml_providers IS 'Auth: Manages SAML Identity Provider connections.';


--
-- Name: saml_relay_states; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.saml_relay_states (
    id uuid NOT NULL,
    sso_provider_id uuid NOT NULL,
    request_id text NOT NULL,
    for_email text,
    redirect_to text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    flow_state_id uuid,
    CONSTRAINT "request_id not empty" CHECK ((char_length(request_id) > 0))
);


--
-- Name: TABLE saml_relay_states; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.saml_relay_states IS 'Auth: Contains SAML Relay State information for each Service Provider initiated login.';


--
-- Name: schema_migrations; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.schema_migrations (
    version character varying(255) NOT NULL
);


--
-- Name: TABLE schema_migrations; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.schema_migrations IS 'Auth: Manages updates to the auth system.';


--
-- Name: sessions; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.sessions (
    id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    factor_id uuid,
    aal auth.aal_level,
    not_after timestamp with time zone,
    refreshed_at timestamp without time zone,
    user_agent text,
    ip inet,
    tag text
);


--
-- Name: TABLE sessions; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.sessions IS 'Auth: Stores session data associated to a user.';


--
-- Name: COLUMN sessions.not_after; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON COLUMN auth.sessions.not_after IS 'Auth: Not after is a nullable column that contains a timestamp after which the session should be regarded as expired.';


--
-- Name: sso_domains; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.sso_domains (
    id uuid NOT NULL,
    sso_provider_id uuid NOT NULL,
    domain text NOT NULL,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    CONSTRAINT "domain not empty" CHECK ((char_length(domain) > 0))
);


--
-- Name: TABLE sso_domains; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.sso_domains IS 'Auth: Manages SSO email address domain mapping to an SSO Identity Provider.';


--
-- Name: sso_providers; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.sso_providers (
    id uuid NOT NULL,
    resource_id text,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    CONSTRAINT "resource_id not empty" CHECK (((resource_id = NULL::text) OR (char_length(resource_id) > 0)))
);


--
-- Name: TABLE sso_providers; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.sso_providers IS 'Auth: Manages SSO identity provider information; see saml_providers for SAML.';


--
-- Name: COLUMN sso_providers.resource_id; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON COLUMN auth.sso_providers.resource_id IS 'Auth: Uniquely identifies a SSO provider according to a user-chosen resource ID (case insensitive), useful in infrastructure as code.';


--
-- Name: users; Type: TABLE; Schema: auth; Owner: -
--

CREATE TABLE auth.users (
    instance_id uuid,
    id uuid NOT NULL,
    aud character varying(255),
    role character varying(255),
    email character varying(255),
    encrypted_password character varying(255),
    email_confirmed_at timestamp with time zone,
    invited_at timestamp with time zone,
    confirmation_token character varying(255),
    confirmation_sent_at timestamp with time zone,
    recovery_token character varying(255),
    recovery_sent_at timestamp with time zone,
    email_change_token_new character varying(255),
    email_change character varying(255),
    email_change_sent_at timestamp with time zone,
    last_sign_in_at timestamp with time zone,
    raw_app_meta_data jsonb,
    raw_user_meta_data jsonb,
    is_super_admin boolean,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    phone text DEFAULT NULL::character varying,
    phone_confirmed_at timestamp with time zone,
    phone_change text DEFAULT ''::character varying,
    phone_change_token character varying(255) DEFAULT ''::character varying,
    phone_change_sent_at timestamp with time zone,
    confirmed_at timestamp with time zone GENERATED ALWAYS AS (LEAST(email_confirmed_at, phone_confirmed_at)) STORED,
    email_change_token_current character varying(255) DEFAULT ''::character varying,
    email_change_confirm_status smallint DEFAULT 0,
    banned_until timestamp with time zone,
    reauthentication_token character varying(255) DEFAULT ''::character varying,
    reauthentication_sent_at timestamp with time zone,
    is_sso_user boolean DEFAULT false NOT NULL,
    deleted_at timestamp with time zone,
    is_anonymous boolean DEFAULT false NOT NULL,
    CONSTRAINT users_email_change_confirm_status_check CHECK (((email_change_confirm_status >= 0) AND (email_change_confirm_status <= 2)))
);


--
-- Name: TABLE users; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON TABLE auth.users IS 'Auth: Stores user login data within a secure schema.';


--
-- Name: COLUMN users.is_sso_user; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON COLUMN auth.users.is_sso_user IS 'Auth: Set this column to true when the account comes from SSO. These accounts can have duplicate emails.';


--
-- Name: admin_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    admin_id uuid NOT NULL,
    action text NOT NULL,
    resource_type text NOT NULL,
    resource_id text,
    details jsonb,
    ip_address text,
    user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_inbox_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_inbox_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    from_email text NOT NULL,
    to_email text NOT NULL,
    subject text,
    body text,
    html_body text,
    message_type text DEFAULT 'email'::text NOT NULL,
    direction text DEFAULT 'inbound'::text NOT NULL,
    status text DEFAULT 'received'::text NOT NULL,
    is_read boolean DEFAULT false NOT NULL,
    admin_id uuid,
    resend_id text,
    reply_to_id uuid,
    thread_id uuid,
    attachments jsonb DEFAULT '[]'::jsonb,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: admin_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.admin_notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    message text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid
);


--
-- Name: ai_agent_allowed_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_agent_allowed_models (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider text NOT NULL,
    model_id text NOT NULL,
    label text NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    sort_order integer DEFAULT 100 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_agent_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_agent_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    platform text NOT NULL,
    is_enabled boolean DEFAULT false,
    default_mode text DEFAULT 'human_then_ai'::text NOT NULL,
    persona_instructions text,
    business_profile_text text,
    language_mode text DEFAULT 'auto'::text NOT NULL,
    model text DEFAULT 'gpt-4o-mini'::text NOT NULL,
    temperature numeric DEFAULT 0.4,
    admin_phone_numbers text[] DEFAULT '{}'::text[] NOT NULL,
    daily_message_cap integer DEFAULT 50 NOT NULL,
    reply_cooldown_seconds integer DEFAULT 60 NOT NULL,
    max_tool_iterations integer DEFAULT 5 NOT NULL,
    handoff_on_request boolean DEFAULT true,
    handoff_on_low_confidence boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    fallback_model_1 text,
    fallback_model_2 text,
    social_account_id uuid NOT NULL,
    CONSTRAINT ai_agent_configs_default_mode_check CHECK ((default_mode = ANY (ARRAY['ai_first'::text, 'human_first'::text, 'human_then_ai'::text]))),
    CONSTRAINT ai_agent_configs_language_mode_check CHECK ((language_mode = ANY (ARRAY['auto'::text, 'ar'::text, 'en'::text]))),
    CONSTRAINT ai_agent_configs_platform_check CHECK ((platform = ANY (ARRAY['whatsapp'::text, 'facebook'::text, 'instagram'::text, 'threads'::text])))
);


--
-- Name: ai_agent_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_agent_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    platform text,
    conversation_id text,
    inbound_text text,
    reply_text text,
    retrieved_chunk_ids uuid[],
    tool_calls jsonb,
    prompt_tokens integer,
    completion_tokens integer,
    latency_ms integer,
    status text,
    error text,
    created_at timestamp with time zone DEFAULT now(),
    idempotency_key text,
    CONSTRAINT ai_agent_logs_platform_check CHECK ((platform = ANY (ARRAY['whatsapp'::text, 'facebook'::text, 'instagram'::text, 'threads'::text])))
);


--
-- Name: ai_agent_tools; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_agent_tools (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    description text NOT NULL,
    tool_type text DEFAULT 'n8n_webhook'::text NOT NULL,
    url text,
    secret text,
    is_enabled boolean DEFAULT true,
    admin_only boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    connector_type text DEFAULT 'custom_rest'::text NOT NULL,
    permissions jsonb DEFAULT '{"check_stock": false, "lookup_orders": false, "search_products": false}'::jsonb NOT NULL,
    read_only_mode boolean DEFAULT true NOT NULL,
    enable_cache boolean DEFAULT true NOT NULL,
    CONSTRAINT ai_agent_tools_connector_type_check CHECK ((connector_type = ANY (ARRAY['supabase'::text, 'mysql_postgres'::text, 'woocommerce'::text, 'shopify'::text, 'salla'::text, 'zid'::text, 'formula'::text, 'custom_rest'::text]))),
    CONSTRAINT ai_agent_tools_permissions_check CHECK (jsonb_exists_all(permissions, ARRAY['search_products'::text, 'check_stock'::text, 'lookup_orders'::text])),
    CONSTRAINT ai_agent_tools_tool_type_check CHECK ((tool_type = ANY (ARRAY['builtin'::text, 'n8n_webhook'::text])))
);


--
-- Name: ai_conversation_modes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_conversation_modes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    platform text NOT NULL,
    conversation_id text NOT NULL,
    mode text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT ai_conversation_modes_mode_check CHECK ((mode = ANY (ARRAY['ai_first'::text, 'human_first'::text, 'human_then_ai'::text]))),
    CONSTRAINT ai_conversation_modes_platform_check CHECK ((platform = ANY (ARRAY['whatsapp'::text, 'facebook'::text, 'instagram'::text, 'threads'::text])))
);


--
-- Name: ai_generation_jobs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_generation_jobs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    model_id text NOT NULL,
    modality text NOT NULL,
    credential_source text NOT NULL,
    status text DEFAULT 'queued'::text NOT NULL,
    provider_job_id text,
    params jsonb DEFAULT '{}'::jsonb NOT NULL,
    result_url text,
    media_file_id uuid,
    error text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ai_generation_jobs_credential_source_check CHECK ((credential_source = ANY (ARRAY['platform'::text, 'byo'::text]))),
    CONSTRAINT ai_generation_jobs_modality_check CHECK ((modality = ANY (ARRAY['image'::text, 'video'::text])))
);


--
-- Name: ai_knowledge_chunks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_knowledge_chunks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    source_id uuid NOT NULL,
    user_id uuid NOT NULL,
    content text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    embedding public.vector(1536),
    created_at timestamp with time zone DEFAULT now(),
    embedding_bge_m3 public.vector(1024)
);


--
-- Name: COLUMN ai_knowledge_chunks.embedding_bge_m3; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_knowledge_chunks.embedding_bge_m3 IS 'Pilot embedding: bge-m3:latest, 1024 dimensions, internal Ollama, digest 7907646426070047a77226ac3e684fbbe8410524f7b4a74d02837e43f2146bab, migration 2026-07-13.';


--
-- Name: ai_knowledge_entities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_knowledge_entities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    type text NOT NULL,
    description text DEFAULT ''::text NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    normalized_name text GENERATED ALWAYS AS (lower(name)) STORED,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_knowledge_graph_exports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_knowledge_graph_exports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    html_url text,
    vault_url text,
    generated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_knowledge_relations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_knowledge_relations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    source_entity_id uuid NOT NULL,
    target_entity_id uuid NOT NULL,
    relation text NOT NULL,
    weight real DEFAULT 1 NOT NULL,
    source_chunk_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_knowledge_source_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_knowledge_source_accounts (
    source_id uuid NOT NULL,
    social_account_id uuid NOT NULL,
    user_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_model_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_model_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    model_id uuid NOT NULL,
    feature text DEFAULT 'general'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ai_models; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_models (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_id uuid NOT NULL,
    model_id text NOT NULL,
    name text NOT NULL,
    description text,
    capabilities text[] DEFAULT '{chat}'::text[] NOT NULL,
    context_limit integer,
    is_active boolean DEFAULT true NOT NULL,
    cost_per_1m_input_tokens numeric(10,4),
    cost_per_1m_output_tokens numeric(10,4),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    admin_params jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: COLUMN ai_models.metadata; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_models.metadata IS 'Provider-reported model capabilities: parameters, aspect_ratios, durations, medias, tags. Populated by the Higgsfield "Sync models" action. Public config only — never credentials.';


--
-- Name: COLUMN ai_models.admin_params; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.ai_models.admin_params IS 'Administrator-set generation parameters for this model (resolution, quality, style_id, ...). Merged over the model spec defaults and under the user-supplied aspect ratio. Public config only — never credentials.';


--
-- Name: ai_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_code text NOT NULL,
    name text NOT NULL,
    api_endpoint text NOT NULL,
    api_key_env_var text NOT NULL,
    api_type text DEFAULT 'openai'::text NOT NULL,
    supports_streaming boolean DEFAULT true NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    auth_type text DEFAULT 'api_key'::text NOT NULL
);


--
-- Name: ai_thread_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_thread_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    thread_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    content text,
    tool_calls jsonb,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT ai_thread_messages_role_check CHECK ((role = ANY (ARRAY['system'::text, 'user'::text, 'assistant'::text, 'tool'::text])))
);


--
-- Name: ai_threads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ai_threads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    platform text NOT NULL,
    conversation_id text NOT NULL,
    title text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT ai_threads_platform_check CHECK ((platform = ANY (ARRAY['whatsapp'::text, 'facebook'::text, 'instagram'::text, 'threads'::text])))
);


--
-- Name: api_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.api_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid,
    endpoint text NOT NULL,
    method text NOT NULL,
    status_code integer,
    ip_address inet,
    user_agent text,
    request_data jsonb,
    response_data jsonb,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: app_credentials; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_credentials (
    secret_name text NOT NULL,
    secret_value text NOT NULL,
    platform text NOT NULL,
    kind text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_by uuid,
    CONSTRAINT app_credentials_kind_check CHECK ((kind = ANY (ARRAY['client_id'::text, 'client_secret'::text, 'other'::text])))
);


--
-- Name: app_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.app_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    value jsonb NOT NULL,
    description text,
    updated_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: automation_dispatch_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.automation_dispatch_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    social_account_id uuid,
    platform text NOT NULL,
    event text NOT NULL,
    conversation_id text,
    inbound_text text,
    destination_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: backup_codes; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.backup_codes (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    code_hash text NOT NULL,
    used_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: bi_post_content; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.bi_post_content (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    post_id text NOT NULL,
    platform text NOT NULL,
    username text,
    post_data jsonb NOT NULL,
    transcript text,
    transcript_language text,
    transcript_duration numeric,
    captions text[] DEFAULT '{}'::text[],
    image_prompts text[] DEFAULT '{}'::text[],
    video_prompts text[] DEFAULT '{}'::text[],
    generation_language text,
    generation_tone text,
    generation_platform text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: blog_posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.blog_posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    content text NOT NULL,
    excerpt text,
    cover_image_url text,
    status text DEFAULT 'draft'::text NOT NULL,
    author_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    scheduled_at timestamp with time zone,
    CONSTRAINT blog_posts_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'published'::text])))
);


--
-- Name: brand_scrape_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brand_scrape_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    cache_key text NOT NULL,
    platform text NOT NULL,
    username text NOT NULL,
    response_data jsonb NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: brand_scrape_sessions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brand_scrape_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    platform text DEFAULT 'instagram'::text NOT NULL,
    username text NOT NULL,
    profile_data jsonb,
    posts_data jsonb,
    total_posts_fetched integer DEFAULT 0,
    scraped_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    strategy_used text,
    api_endpoint text
);


--
-- Name: brand_search_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brand_search_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    platform text NOT NULL,
    scope text NOT NULL,
    query text NOT NULL,
    use_count integer DEFAULT 1 NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: caption_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.caption_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    caption text NOT NULL,
    language text,
    tone text,
    platform text,
    prompt text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: comment_inbox_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.comment_inbox_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    platform text NOT NULL,
    social_account_id uuid NOT NULL,
    post_id text NOT NULL,
    comment_id text NOT NULL,
    author_name text,
    author_id text,
    message text,
    sentiment text,
    is_hidden boolean DEFAULT false,
    is_reply boolean DEFAULT false,
    parent_comment_id text,
    comment_time timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: coupon_redemptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coupon_redemptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    coupon_id uuid NOT NULL,
    user_id uuid NOT NULL,
    subscription_id uuid,
    discount_applied numeric(10,2) NOT NULL,
    original_amount numeric(10,2),
    redeemed_at timestamp with time zone DEFAULT now() NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb
);


--
-- Name: coupons; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.coupons (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    code text NOT NULL,
    description text,
    discount_type text NOT NULL,
    discount_amount numeric(10,2) NOT NULL,
    trial_days integer,
    max_redemptions integer,
    total_redemptions integer DEFAULT 0 NOT NULL,
    max_per_user integer DEFAULT 1,
    min_plan_value numeric(10,2) DEFAULT NULL::numeric,
    applicable_plans text[],
    valid_from timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT coupons_discount_type_check CHECK ((discount_type = ANY (ARRAY['percentage'::text, 'fixed'::text, 'free_trial'::text]))),
    CONSTRAINT coupons_trial_days_check CHECK ((trial_days > 0))
);


--
-- Name: credit_transactions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.credit_transactions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    amount integer NOT NULL,
    transaction_type text NOT NULL,
    description text,
    stripe_session_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT credit_transactions_transaction_type_check CHECK ((transaction_type = ANY (ARRAY['purchase'::text, 'usage'::text, 'refund'::text, 'bonus'::text])))
);


--
-- Name: deployment_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.deployment_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    environment text DEFAULT 'production'::text NOT NULL,
    version text,
    commit_hash text,
    commit_message text,
    triggered_by uuid,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    duration_ms integer,
    error_message text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: edge_function_status; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.edge_function_status (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    function_name text NOT NULL,
    checked_at timestamp with time zone DEFAULT now() NOT NULL,
    status text DEFAULT 'operational'::text,
    last_invocation timestamp with time zone,
    invocations_last_hour integer DEFAULT 0,
    avg_execution_time_ms numeric(10,2),
    error_rate numeric(5,2),
    last_error text,
    last_error_at timestamp with time zone,
    memory_mb numeric(10,2),
    cpu_percent numeric(5,2),
    version text,
    deployed_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT edge_function_status_status_check CHECK ((status = ANY (ARRAY['operational'::text, 'degraded'::text, 'down'::text, 'unknown'::text])))
);


--
-- Name: email_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    admin_id uuid,
    email text NOT NULL,
    name text,
    last_used_at timestamp with time zone DEFAULT now(),
    use_count integer DEFAULT 1,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_drafts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_drafts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    admin_id uuid NOT NULL,
    from_email text NOT NULL,
    to_emails text[] DEFAULT '{}'::text[],
    cc_emails text[] DEFAULT '{}'::text[],
    bcc_emails text[] DEFAULT '{}'::text[],
    subject text,
    body text,
    html_body text,
    attachments jsonb DEFAULT '[]'::jsonb,
    reply_to_message_id uuid,
    signature_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    template_id uuid,
    recipient_email text NOT NULL,
    recipient_id uuid,
    subject text NOT NULL,
    status text DEFAULT 'queued'::text,
    provider_id text,
    opened_at timestamp with time zone,
    clicked_at timestamp with time zone,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    sent_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT email_log_status_check CHECK ((status = ANY (ARRAY['queued'::text, 'sent'::text, 'failed'::text, 'delivered'::text, 'opened'::text, 'bounced'::text])))
);


--
-- Name: email_signatures; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_signatures (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    admin_id uuid NOT NULL,
    name text NOT NULL,
    content text NOT NULL,
    is_default boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: email_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.email_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    slug text NOT NULL,
    name text NOT NULL,
    subject text NOT NULL,
    body_html text,
    body_text text,
    variables jsonb DEFAULT '[]'::jsonb,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid
);


--
-- Name: feature_flag_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feature_flag_audit_log (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feature_key text NOT NULL,
    old_value boolean,
    new_value boolean NOT NULL,
    changed_by uuid,
    change_type text DEFAULT 'manual'::text NOT NULL,
    notes text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: feature_flag_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.feature_flag_schedules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    feature_key text NOT NULL,
    scheduled_value boolean NOT NULL,
    scheduled_at timestamp with time zone NOT NULL,
    executed_at timestamp with time zone,
    status text DEFAULT 'pending'::text NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: generated_content_collections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.generated_content_collections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    source_post_url text,
    source_username text,
    source_platform text,
    source_caption text,
    transcript text,
    post_prompts jsonb DEFAULT '[]'::jsonb,
    image_prompts jsonb DEFAULT '[]'::jsonb,
    video_prompts jsonb DEFAULT '[]'::jsonb,
    language text DEFAULT 'english'::text,
    tone text DEFAULT 'professional'::text,
    target_platform text DEFAULT 'instagram'::text,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: higgsfield_connections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.higgsfield_connections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    access_token text NOT NULL,
    refresh_token text,
    expires_at timestamp with time zone,
    scope text,
    account_id text,
    account_email text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL
);


--
-- Name: higgsfield_connection_status; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.higgsfield_connection_status WITH (security_invoker='on') AS
 SELECT user_id,
    account_email,
    expires_at,
    true AS connected
   FROM public.higgsfield_connections
  WHERE (user_id = auth.uid());


--
-- Name: image_reference_presets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.image_reference_presets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    reference_images jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: launch_checklist; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.launch_checklist (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    description text,
    category text NOT NULL,
    is_completed boolean DEFAULT false,
    completed_at timestamp with time zone,
    completed_by uuid,
    sort_order integer DEFAULT 0,
    is_required boolean DEFAULT true,
    dependency_id uuid,
    action_url text,
    resources jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT launch_checklist_category_check CHECK ((category = ANY (ARRAY['setup'::text, 'content'::text, 'marketing'::text, 'technical'::text, 'legal'::text])))
);


--
-- Name: lead_forms; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.lead_forms (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    social_account_id uuid NOT NULL,
    page_id text NOT NULL,
    form_id text NOT NULL,
    form_name text,
    form_status text DEFAULT 'active'::text,
    last_synced_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: leads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.leads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    form_id uuid,
    meta_lead_id text,
    lead_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    status text DEFAULT 'new'::text,
    notes text,
    assigned_to uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: log_analyses; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.log_analyses (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    log_id uuid NOT NULL,
    explanation text NOT NULL,
    root_cause text NOT NULL,
    lovable_prompt text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: mcp_oauth_authorizations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_oauth_authorizations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    client_id text NOT NULL,
    user_id uuid,
    redirect_uri text NOT NULL,
    scope text,
    state text,
    code_challenge text NOT NULL,
    code_challenge_method text DEFAULT 'S256'::text NOT NULL,
    code text,
    code_used_at timestamp with time zone,
    consented_at timestamp with time zone,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mcp_oauth_clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_oauth_clients (
    client_id text NOT NULL,
    client_secret_hash text,
    client_name text NOT NULL,
    client_uri text,
    logo_uri text,
    software_id text,
    software_version text,
    redirect_uris text[] DEFAULT '{}'::text[] NOT NULL,
    grant_types text[] DEFAULT ARRAY['authorization_code'::text, 'refresh_token'::text] NOT NULL,
    response_types text[] DEFAULT ARRAY['code'::text] NOT NULL,
    token_endpoint_auth_method text DEFAULT 'none'::text NOT NULL,
    scope text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: mcp_oauth_tokens; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.mcp_oauth_tokens (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    token_hash text NOT NULL,
    refresh_token_hash text,
    client_id text NOT NULL,
    user_id uuid NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    refresh_expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    last_used_at timestamp with time zone,
    last_user_agent text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: media_file_providers; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_file_providers (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    media_file_id uuid NOT NULL,
    provider text NOT NULL,
    object_version integer DEFAULT 1 NOT NULL,
    object_key text NOT NULL,
    delivery_url text,
    status text DEFAULT 'pending'::text NOT NULL,
    bytes bigint,
    mime_type text,
    error text,
    deleted_at timestamp with time zone,
    deleted_reason text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT media_file_providers_provider_check CHECK ((provider = ANY (ARRAY['cloudinary'::text, 'openinary'::text]))),
    CONSTRAINT media_file_providers_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'ready'::text, 'failed'::text, 'deleted'::text])))
);


--
-- Name: media_files; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_files (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    file_path text NOT NULL,
    file_type text NOT NULL,
    file_size integer,
    mime_type text,
    storage_bucket text DEFAULT 'media'::text,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now(),
    cloudinary_public_id text,
    platforms text[] DEFAULT '{}'::text[],
    social_account_ids text[] DEFAULT '{}'::text[],
    upload_date date DEFAULT CURRENT_DATE,
    folder_path text DEFAULT '/'::text,
    current_object_version integer DEFAULT 1 NOT NULL,
    CONSTRAINT media_files_file_type_check CHECK ((file_type = ANY (ARRAY['image'::text, 'video'::text])))
);


--
-- Name: media_folders; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_folders (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    parent_path text DEFAULT '/'::text,
    full_path text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: media_operations_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_operations_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    media_file_id uuid,
    operation_type text NOT NULL,
    status text DEFAULT 'processing'::text NOT NULL,
    source_url text,
    result_url text,
    file_name text,
    operation_details jsonb DEFAULT '{}'::jsonb,
    error_message text,
    duration_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone
);


--
-- Name: media_understanding_sender_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_understanding_sender_usage (
    social_account_id uuid NOT NULL,
    sender_id text NOT NULL,
    usage_date date DEFAULT ((now() AT TIME ZONE 'utc'::text))::date NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: media_understanding_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_understanding_usage (
    social_account_id uuid NOT NULL,
    usage_date date DEFAULT ((now() AT TIME ZONE 'utc'::text))::date NOT NULL,
    attempt_count integer DEFAULT 0 NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: media_upload_counters; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.media_upload_counters (
    user_id uuid NOT NULL,
    upload_date date NOT NULL,
    last_seq integer DEFAULT 0 NOT NULL
);


--
-- Name: messaging_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messaging_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    social_account_id uuid NOT NULL,
    platform text NOT NULL,
    conversation_id text NOT NULL,
    participant_name text,
    participant_avatar text,
    last_message_preview text,
    last_message_at timestamp with time zone,
    unread_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    participant_id text,
    workspace_id uuid NOT NULL
);


--
-- Name: messenger_auto_replies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messenger_auto_replies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    platform text NOT NULL,
    name text NOT NULL,
    rule_type text NOT NULL,
    keywords text[],
    reply_message text NOT NULL,
    is_active boolean DEFAULT true,
    schedule_start time without time zone,
    schedule_end time without time zone,
    schedule_days integer[],
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT messenger_auto_replies_platform_check CHECK ((platform = ANY (ARRAY['facebook'::text, 'instagram'::text, 'threads'::text]))),
    CONSTRAINT messenger_auto_replies_rule_type_check CHECK ((rule_type = ANY (ARRAY['away'::text, 'keyword'::text])))
);


--
-- Name: messenger_auto_reply_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.messenger_auto_reply_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    auto_reply_rule_id uuid NOT NULL,
    conversation_id text,
    triggered_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: node_execution_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.node_execution_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    execution_id uuid NOT NULL,
    node_id text NOT NULL,
    node_type text NOT NULL,
    node_label text,
    status text DEFAULT 'pending'::text NOT NULL,
    input_data jsonb,
    output_data jsonb,
    error_message text,
    duration_ms integer,
    started_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    CONSTRAINT node_execution_logs_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'success'::text, 'error'::text, 'skipped'::text])))
);


--
-- Name: notification_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notification_reads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    notification_id uuid NOT NULL,
    user_id uuid NOT NULL,
    read_at timestamp with time zone DEFAULT now() NOT NULL,
    dismissed_at timestamp with time zone,
    metadata jsonb DEFAULT '{}'::jsonb
);


--
-- Name: oauth_apps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_apps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    client_id text NOT NULL,
    redirect_uris text[] DEFAULT '{}'::text[] NOT NULL,
    description text,
    icon_url text,
    is_active boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: oauth_clients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_clients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_code text NOT NULL,
    issuer text NOT NULL,
    redirect_uri text NOT NULL,
    client_id text NOT NULL,
    client_secret text,
    registration_response jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: oauth_pending_facebook_selections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_pending_facebook_selections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    social_profile_id uuid,
    target_platform text NOT NULL,
    provider_token text NOT NULL,
    pages_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    ig_standalone_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:15:00'::interval) NOT NULL,
    CONSTRAINT oauth_pending_facebook_selections_target_platform_check CHECK ((target_platform = ANY (ARRAY['facebook'::text, 'instagram'::text])))
);


--
-- Name: oauth_pending_instagram_selections; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_pending_instagram_selections (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    social_profile_id uuid,
    ig_candidates_json jsonb DEFAULT '[]'::jsonb NOT NULL,
    long_lived_token text NOT NULL,
    expires_in integer DEFAULT 5184000 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '00:15:00'::interval) NOT NULL
);


--
-- Name: oauth_redirect_requests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_redirect_requests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    oauth_app_id uuid NOT NULL,
    redirect_uri text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    admin_note text,
    reviewed_by uuid,
    reviewed_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: oauth_states; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.oauth_states (
    state text NOT NULL,
    provider_code text NOT NULL,
    code_verifier text NOT NULL,
    redirect_uri text NOT NULL,
    scope_kind text NOT NULL,
    user_id uuid,
    return_to text,
    expires_at timestamp with time zone DEFAULT (now() + '00:10:00'::interval) NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT oauth_states_scope_kind_check CHECK ((scope_kind = ANY (ARRAY['platform'::text, 'user'::text])))
);


--
-- Name: observability_alert_configs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.observability_alert_configs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    trigger_type text NOT NULL,
    metric_type text,
    metric_name text,
    threshold_value numeric NOT NULL,
    threshold_operator text DEFAULT 'gte'::text NOT NULL,
    time_window_minutes integer DEFAULT 5 NOT NULL,
    notification_channels text[] DEFAULT ARRAY['email'::text] NOT NULL,
    notification_emails text[] DEFAULT ARRAY['dr.vet.waleedtam@gmail.com'::text],
    webhook_url text,
    cooldown_minutes integer DEFAULT 30 NOT NULL,
    last_triggered_at timestamp with time zone,
    is_active boolean DEFAULT true NOT NULL,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: observability_alert_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.observability_alert_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    alert_config_id uuid,
    alert_name text NOT NULL,
    trigger_type text NOT NULL,
    triggered_value numeric NOT NULL,
    threshold_value numeric NOT NULL,
    metric_type text,
    metric_name text,
    details jsonb DEFAULT '{}'::jsonb,
    notification_sent boolean DEFAULT false NOT NULL,
    notification_channel text,
    notification_error text,
    is_resolved boolean DEFAULT false NOT NULL,
    resolved_at timestamp with time zone,
    resolved_by uuid,
    resolution_notes text,
    severity text DEFAULT 'warning'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: observability_health_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.observability_health_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    overall_health_score integer NOT NULL,
    edge_functions_health integer,
    database_health integer,
    token_health integer,
    cron_health integer,
    active_errors_count integer DEFAULT 0 NOT NULL,
    failed_functions_count integer DEFAULT 0 NOT NULL,
    slow_queries_count integer DEFAULT 0 NOT NULL,
    unhealthy_tokens_count integer DEFAULT 0 NOT NULL,
    metrics_breakdown jsonb DEFAULT '{}'::jsonb,
    captured_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: observability_metrics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.observability_metrics (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    metric_type text NOT NULL,
    metric_name text NOT NULL,
    metric_category text DEFAULT 'general'::text NOT NULL,
    total_count integer DEFAULT 0 NOT NULL,
    success_count integer DEFAULT 0 NOT NULL,
    error_count integer DEFAULT 0 NOT NULL,
    avg_duration_ms numeric,
    max_duration_ms numeric,
    min_duration_ms numeric,
    window_start timestamp with time zone NOT NULL,
    window_end timestamp with time zone NOT NULL,
    metadata jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: partner_api_idempotency; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_api_idempotency (
    key_id uuid NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    state text NOT NULL,
    attempt_token uuid DEFAULT gen_random_uuid() NOT NULL,
    http_status integer,
    response_body jsonb,
    locked_until timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    expires_at timestamp with time zone DEFAULT (now() + '7 days'::interval) NOT NULL,
    CONSTRAINT partner_api_idempotency_state_check CHECK ((state = ANY (ARRAY['processing'::text, 'completed'::text, 'indeterminate'::text])))
);


--
-- Name: partner_api_key_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_api_key_accounts (
    key_id uuid NOT NULL,
    social_account_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: partner_api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    social_account_id uuid NOT NULL,
    created_by uuid,
    revoked_by uuid,
    revoked_reason text,
    name text NOT NULL,
    key_prefix text NOT NULL,
    key_hash text NOT NULL,
    scopes text[] DEFAULT '{}'::text[] NOT NULL,
    rate_limit_per_min integer DEFAULT 60 NOT NULL,
    monthly_quota integer,
    current_usage_count integer DEFAULT 0 NOT NULL,
    last_reset_at timestamp with time zone DEFAULT date_trunc('month'::text, now()) NOT NULL,
    last_used_at timestamp with time zone,
    expires_at timestamp with time zone,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: partner_api_rate_buckets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_api_rate_buckets (
    key_id uuid NOT NULL,
    window_start timestamp with time zone NOT NULL,
    request_count integer DEFAULT 0 NOT NULL
);


--
-- Name: partner_api_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_api_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key_id uuid NOT NULL,
    workspace_id uuid NOT NULL,
    action text NOT NULL,
    billable boolean DEFAULT false NOT NULL,
    http_status integer NOT NULL,
    error_code text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: partner_audit_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.partner_audit_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    key_id uuid NOT NULL,
    actor_id uuid,
    action text NOT NULL,
    request_id text,
    metadata jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    key_prefix text,
    CONSTRAINT partner_audit_logs_action_check CHECK ((action = ANY (ARRAY['create'::text, 'rotate'::text, 'revoke'::text, 'grant_broaden'::text])))
);


--
-- Name: password_reset_otps; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.password_reset_otps (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    email text NOT NULL,
    code_hash text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    attempts integer DEFAULT 0,
    used boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now(),
    purpose text DEFAULT 'reset'::text NOT NULL,
    CONSTRAINT password_reset_otps_purpose_chk CHECK ((purpose = ANY (ARRAY['reset'::text, 'change_password'::text])))
);

ALTER TABLE ONLY public.password_reset_otps FORCE ROW LEVEL SECURITY;


--
-- Name: pending_agent_replies_ingress_seq_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.pending_agent_replies_ingress_seq_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: pending_agent_replies_ingress_seq_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.pending_agent_replies_ingress_seq_seq OWNED BY public.pending_agent_replies.ingress_seq;


--
-- Name: platform_posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.platform_posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    post_id uuid NOT NULL,
    social_account_id uuid,
    platform text NOT NULL,
    platform_post_id text,
    platform_post_url text,
    status text DEFAULT 'pending'::text,
    error_message text,
    response_data jsonb,
    posted_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT platform_posts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'success'::text, 'failed'::text])))
);


--
-- Name: post_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.post_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    caption text NOT NULL,
    platforms text[] DEFAULT '{}'::text[],
    hashtags text[] DEFAULT '{}'::text[],
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: posts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    caption text,
    platforms text[] NOT NULL,
    media_file_ids uuid[],
    status text DEFAULT 'pending'::text,
    scheduled_at timestamp with time zone,
    posted_at timestamp with time zone,
    metadata jsonb,
    created_at timestamp with time zone DEFAULT now(),
    source text DEFAULT 'manual'::text,
    CONSTRAINT posts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'processing'::text, 'completed'::text, 'failed'::text, 'scheduled'::text])))
);


--
-- Name: profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.profiles (
    id uuid NOT NULL,
    email text NOT NULL,
    full_name text,
    avatar_url text,
    api_key text DEFAULT gen_random_uuid(),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    ai_model text DEFAULT 'google/gemini-2.5-flash'::text,
    preferred_timezone text,
    referral_code character varying(20),
    referred_by uuid,
    email_notifications_enabled boolean DEFAULT false,
    notification_sound_enabled boolean DEFAULT false,
    post_success_notifications_enabled boolean DEFAULT false,
    post_failure_notifications_enabled boolean DEFAULT false,
    admin_notified_at timestamp with time zone
);


--
-- Name: profiles_public; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.profiles_public AS
 SELECT id,
    full_name,
    avatar_url,
    created_at
   FROM public.profiles;


--
-- Name: provider_api_keys; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.provider_api_keys (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    provider_code text NOT NULL,
    api_key text,
    created_by uuid,
    updated_at timestamp with time zone DEFAULT now(),
    auth_type text DEFAULT 'api_key'::text NOT NULL,
    access_token text,
    refresh_token text,
    expires_at timestamp with time zone,
    scope text,
    account_id text,
    meta jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT provider_api_keys_credential_present CHECK (((api_key IS NOT NULL) OR (access_token IS NOT NULL)))
);


--
-- Name: social_accounts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.social_accounts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    platform text NOT NULL,
    platform_user_id text NOT NULL,
    platform_username text,
    access_token text NOT NULL,
    refresh_token text,
    token_expires_at timestamp with time zone,
    account_metadata jsonb,
    avatar_url text,
    is_active boolean DEFAULT true,
    connected_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    social_profile_id uuid,
    needs_reauth boolean DEFAULT false,
    failure_count integer DEFAULT 0,
    last_refresh_error text,
    last_alert_sent_at timestamp with time zone,
    alerts_snoozed boolean DEFAULT false,
    last_refresh_attempt_at timestamp with time zone,
    ig_auth_type text DEFAULT 'facebook_page'::text,
    workspace_id uuid,
    connection_mode text DEFAULT 'cloud_api'::text,
    CONSTRAINT social_accounts_connection_mode_chk CHECK (((platform <> 'whatsapp'::text) OR (connection_mode = ANY (ARRAY['cloud_api'::text, 'coexistence'::text, 'evolution_qr'::text])))),
    CONSTRAINT social_accounts_platform_check CHECK ((platform = ANY (ARRAY['facebook'::text, 'instagram'::text, 'tiktok'::text, 'twitter'::text, 'linkedin'::text, 'youtube'::text, 'pinterest'::text, 'threads'::text, 'bluesky'::text, 'whatsapp'::text, 'reddit'::text]))),
    CONSTRAINT social_accounts_whatsapp_needs_workspace CHECK (((platform <> 'whatsapp'::text) OR (workspace_id IS NOT NULL)))
);


--
-- Name: social_profiles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.social_profiles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    share_token uuid DEFAULT gen_random_uuid(),
    is_public boolean DEFAULT false
);


--
-- Name: public_social_accounts; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.public_social_accounts AS
 SELECT id,
    platform,
    platform_username,
    avatar_url,
    is_active,
    social_profile_id
   FROM public.social_accounts sa
  WHERE (EXISTS ( SELECT 1
           FROM public.social_profiles sp
          WHERE ((sp.id = sa.social_profile_id) AND (sp.is_public = true))));


--
-- Name: rate_limit_buckets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_limit_buckets (
    bucket_key text NOT NULL,
    count integer DEFAULT 0 NOT NULL,
    window_start timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone DEFAULT (now() + '01:00:00'::interval) NOT NULL
);


--
-- Name: rate_limit_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.rate_limit_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    endpoint character varying(100) NOT NULL,
    display_name character varying(100) NOT NULL,
    max_requests integer DEFAULT 10 NOT NULL,
    window_minutes integer DEFAULT 60 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: referrals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.referrals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    referrer_id uuid NOT NULL,
    referred_user_id uuid,
    referral_code character varying(20) NOT NULL,
    status character varying(20) DEFAULT 'pending'::character varying NOT NULL,
    reward_type character varying(20) DEFAULT 'discount'::character varying,
    reward_amount numeric(10,2) DEFAULT 10.00,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    rewarded_at timestamp with time zone,
    CONSTRAINT referrals_reward_type_check CHECK (((reward_type)::text = ANY (ARRAY[('discount'::character varying)::text, ('credit'::character varying)::text, ('free_month'::character varying)::text]))),
    CONSTRAINT referrals_status_check CHECK (((status)::text = ANY (ARRAY[('pending'::character varying)::text, ('completed'::character varying)::text, ('rewarded'::character varying)::text])))
);


--
-- Name: saved_field_suggestions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.saved_field_suggestions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    field_type text NOT NULL,
    value text NOT NULL,
    platform text,
    use_count integer DEFAULT 1 NOT NULL,
    last_used_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: scheduled_emails; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.scheduled_emails (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    admin_id uuid NOT NULL,
    from_email text NOT NULL,
    to_email text NOT NULL,
    cc_email text,
    bcc_email text,
    subject text NOT NULL,
    html_body text NOT NULL,
    text_body text,
    attachments jsonb DEFAULT '[]'::jsonb,
    signature_id uuid,
    scheduled_at timestamp with time zone NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    sent_at timestamp with time zone,
    error_message text,
    reply_to_message_id uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: social_inbox_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.social_inbox_events (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    social_account_id uuid NOT NULL,
    platform text NOT NULL,
    event_type text NOT NULL,
    external_event_id text NOT NULL,
    payload jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT social_inbox_events_event_type_check CHECK ((event_type = ANY (ARRAY['message'::text, 'comment'::text]))),
    CONSTRAINT social_inbox_events_platform_check CHECK ((platform = ANY (ARRAY['facebook'::text, 'instagram'::text, 'threads'::text])))
);


--
-- Name: stripe_webhook_events; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.stripe_webhook_events (
    event_id text NOT NULL,
    event_type text NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    processed_at timestamp with time zone,
    status text DEFAULT 'received'::text NOT NULL,
    error text
);


--
-- Name: subscription_plans; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.subscription_plans (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    price_monthly numeric(10,2),
    price_yearly numeric(10,2),
    features jsonb DEFAULT '[]'::jsonb,
    profile_limit integer DEFAULT 2,
    is_popular boolean DEFAULT false,
    is_active boolean DEFAULT true,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    max_social_accounts integer,
    max_posts_per_month integer,
    max_posts_per_day integer,
    max_media_uploads_per_day integer
);


--
-- Name: COLUMN subscription_plans.max_posts_per_day; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.subscription_plans.max_posts_per_day IS '-1 = unlimited. Resolved through effective_user_quotas(); never read directly.';


--
-- Name: support_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    subject text NOT NULL,
    message text NOT NULL,
    status text DEFAULT 'open'::text,
    admin_reply text,
    replied_at timestamp with time zone,
    replied_by uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    email text,
    mobile text,
    CONSTRAINT support_messages_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'resolved'::text, 'closed'::text])))
);


--
-- Name: support_tickets_ticket_number_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.support_tickets_ticket_number_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: support_tickets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.support_tickets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_number integer DEFAULT nextval('public.support_tickets_ticket_number_seq'::regclass) NOT NULL,
    user_id uuid NOT NULL,
    subject text NOT NULL,
    description text NOT NULL,
    category text NOT NULL,
    priority text DEFAULT 'normal'::text,
    status text DEFAULT 'open'::text,
    assigned_to uuid,
    attachments jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    last_response_at timestamp with time zone,
    resolved_at timestamp with time zone,
    CONSTRAINT support_tickets_category_check CHECK ((category = ANY (ARRAY['technical'::text, 'billing'::text, 'feature_request'::text, 'account'::text, 'other'::text]))),
    CONSTRAINT support_tickets_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text]))),
    CONSTRAINT support_tickets_status_check CHECK ((status = ANY (ARRAY['open'::text, 'in_progress'::text, 'waiting_on_user'::text, 'resolved'::text, 'closed'::text])))
);


--
-- Name: system_health_snapshots; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_health_snapshots (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    captured_at timestamp with time zone DEFAULT now() NOT NULL,
    health_score integer DEFAULT 100,
    health_status text DEFAULT 'healthy'::text,
    db_connections integer,
    db_connections_active integer,
    db_query_time_avg numeric(10,2),
    db_size_gb numeric(10,2),
    api_requests_per_minute integer,
    api_avg_response_time numeric(10,2),
    api_error_rate numeric(5,2),
    storage_used_gb numeric(10,2),
    storage_total_gb numeric(10,2),
    active_sessions integer,
    new_signups_today integer,
    edge_function_invocations integer,
    edge_function_errors integer,
    edge_function_avg_duration numeric(10,2),
    ai_calls_today integer,
    ai_error_rate numeric(5,2),
    ai_avg_response_time numeric(10,2),
    total_users integer,
    active_subscriptions integer,
    mrr numeric(12,2),
    alerts_active integer DEFAULT 0,
    alerts_triggered text[],
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT system_health_snapshots_health_score_check CHECK (((health_score >= 0) AND (health_score <= 100))),
    CONSTRAINT system_health_snapshots_health_status_check CHECK ((health_status = ANY (ARRAY['healthy'::text, 'degraded'::text, 'unhealthy'::text, 'critical'::text])))
);


--
-- Name: system_logs; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_logs (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    level text DEFAULT 'info'::text NOT NULL,
    category text DEFAULT 'system'::text NOT NULL,
    source text NOT NULL,
    message text NOT NULL,
    user_id uuid,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT system_logs_category_check CHECK ((category = ANY (ARRAY['auth'::text, 'edge'::text, 'database'::text, 'token'::text, 'post'::text, 'system'::text, 'ai'::text, 'scheduler'::text, 'webhook'::text, 'payment'::text, 'media'::text]))),
    CONSTRAINT system_logs_level_check CHECK ((level = ANY (ARRAY['debug'::text, 'info'::text, 'warn'::text, 'error'::text])))
);


--
-- Name: system_notifications; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_notifications (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    title text NOT NULL,
    message text NOT NULL,
    type text DEFAULT 'info'::text,
    target_type text DEFAULT 'all'::text,
    target_roles text[],
    target_users uuid[],
    target_territories text[],
    action_label text,
    action_url text,
    priority text DEFAULT 'normal'::text,
    expires_at timestamp with time zone,
    dismissible boolean DEFAULT true,
    published_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    total_recipients integer DEFAULT 0,
    total_reads integer DEFAULT 0,
    metadata jsonb DEFAULT '{}'::jsonb,
    CONSTRAINT system_notifications_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text, 'urgent'::text]))),
    CONSTRAINT system_notifications_target_type_check CHECK ((target_type = ANY (ARRAY['all'::text, 'role'::text, 'user'::text, 'territory'::text]))),
    CONSTRAINT system_notifications_type_check CHECK ((type = ANY (ARRAY['info'::text, 'success'::text, 'warning'::text, 'error'::text, 'announcement'::text])))
);


--
-- Name: system_settings; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.system_settings (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    key text NOT NULL,
    value jsonb DEFAULT '{}'::jsonb NOT NULL,
    description text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: threads_mentions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.threads_mentions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    social_account_id uuid NOT NULL,
    threads_media_id text,
    mention_id text NOT NULL,
    mention_author_id text,
    mention_author_username text,
    mention_text text,
    mention_permalink text,
    mentioned_at timestamp with time zone,
    status text DEFAULT 'new'::text NOT NULL,
    raw_response jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    has_reply boolean DEFAULT false NOT NULL,
    reply_text text,
    reply_platform_post_id text,
    reply_permalink text,
    replied_at timestamp with time zone,
    replied_by uuid,
    reply_error text,
    sentiment text DEFAULT 'unknown'::text NOT NULL,
    labels text[] DEFAULT '{}'::text[] NOT NULL,
    assigned_to uuid,
    assigned_at timestamp with time zone,
    assigned_by uuid,
    last_synced_at timestamp with time zone,
    source text DEFAULT 'manual'::text NOT NULL,
    notified_at timestamp with time zone,
    mention_author_avatar_url text,
    CONSTRAINT threads_mentions_sentiment_check CHECK ((sentiment = ANY (ARRAY['positive'::text, 'neutral'::text, 'negative'::text, 'unknown'::text]))),
    CONSTRAINT threads_mentions_source_check CHECK ((source = ANY (ARRAY['manual'::text, 'webhook'::text]))),
    CONSTRAINT threads_mentions_status_check CHECK ((status = ANY (ARRAY['new'::text, 'read'::text, 'archived'::text, 'replied'::text])))
);


--
-- Name: threads_recent_searches; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.threads_recent_searches (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    query text NOT NULL,
    search_type text DEFAULT 'TOP'::text NOT NULL,
    since_date date,
    until_date date,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: threads_reply_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.threads_reply_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    social_account_id uuid NOT NULL,
    media_id text NOT NULL,
    reply_id text NOT NULL,
    parent_id text,
    root_post_id text,
    username text,
    text text,
    permalink text,
    "timestamp" timestamp with time zone,
    media_type text,
    media_url text,
    thumbnail_url text,
    has_replies boolean DEFAULT false,
    is_reply boolean DEFAULT true,
    is_reply_owned_by_me boolean DEFAULT false,
    hide_status text,
    reply_audience text,
    status text DEFAULT 'visible'::text NOT NULL,
    raw_data jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT threads_reply_cache_status_check CHECK ((status = ANY (ARRAY['visible'::text, 'hidden'::text, 'pending'::text, 'approved'::text, 'rejected'::text])))
);


--
-- Name: ticket_activities; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_activities (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_id uuid NOT NULL,
    actor_id uuid,
    action text NOT NULL,
    details jsonb DEFAULT '{}'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: ticket_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.ticket_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    ticket_id uuid NOT NULL,
    user_id uuid NOT NULL,
    message text NOT NULL,
    is_internal boolean DEFAULT false,
    attachments jsonb DEFAULT '[]'::jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tier_rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tier_rate_limits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    plan_slug text NOT NULL,
    endpoint text NOT NULL,
    max_requests_per_hour integer DEFAULT 10 NOT NULL,
    max_requests_per_day integer DEFAULT 50 NOT NULL,
    is_active boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tiktok_api_analytics_cache; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tiktok_api_analytics_cache (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    social_account_id uuid NOT NULL,
    cache_key text NOT NULL,
    profile_data jsonb,
    posts_data jsonb,
    cursor text,
    has_more boolean DEFAULT false,
    expires_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: token_refresh_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.token_refresh_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    account_id uuid NOT NULL,
    platform text NOT NULL,
    platform_username text,
    status text NOT NULL,
    error_message text,
    trigger_type text DEFAULT 'cron'::text NOT NULL,
    cron_category text,
    duration_ms integer,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_ai_model_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_ai_model_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    provider text NOT NULL,
    model text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    expires_at timestamp with time zone,
    reason text
);


--
-- Name: user_blog_post_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_blog_post_reads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    blog_post_id uuid NOT NULL,
    read_at timestamp with time zone DEFAULT now()
);


--
-- Name: user_connectors; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_connectors (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    connector_type text NOT NULL,
    slack_user_id text,
    workspace_name text,
    is_connected boolean DEFAULT false,
    connected_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: user_credits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_credits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    balance integer DEFAULT 0 NOT NULL,
    total_purchased integer DEFAULT 0 NOT NULL,
    total_used integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_feature_overrides; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_feature_overrides (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    feature_key text NOT NULL,
    enabled boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by uuid,
    expires_at timestamp with time zone
);


--
-- Name: user_notification_preferences; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_notification_preferences (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    slack_notifications boolean DEFAULT false,
    notify_post_success boolean DEFAULT true,
    notify_post_failed boolean DEFAULT true,
    notify_scheduled boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: user_notification_reads; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_notification_reads (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    notification_id uuid NOT NULL,
    read_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_quotas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_quotas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    max_profiles integer,
    max_posts_per_month integer,
    posts_this_month integer DEFAULT 0,
    quota_reset_date timestamp with time zone DEFAULT (date_trunc('month'::text, now()) + '1 mon'::interval),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    max_social_accounts integer,
    max_posts_per_day integer,
    posts_today integer DEFAULT 0,
    daily_reset_date timestamp with time zone DEFAULT ((CURRENT_DATE + '1 day'::interval))::timestamp with time zone,
    media_uploads_today integer DEFAULT 0,
    max_media_uploads_per_day integer,
    media_daily_reset_date timestamp with time zone DEFAULT ((CURRENT_DATE + '1 day'::interval))::timestamp with time zone,
    max_ai_generations_per_day integer DEFAULT 20,
    ai_generations_today integer DEFAULT 0 NOT NULL,
    ai_generations_reset_date date
);


--
-- Name: user_quotas_backup_20260823; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_quotas_backup_20260823 (
    id uuid,
    user_id uuid,
    max_profiles integer,
    max_posts_per_month integer,
    posts_this_month integer,
    quota_reset_date timestamp with time zone,
    created_at timestamp with time zone,
    updated_at timestamp with time zone,
    max_social_accounts integer,
    max_posts_per_day integer,
    posts_today integer,
    daily_reset_date timestamp with time zone,
    media_uploads_today integer,
    max_media_uploads_per_day integer,
    media_daily_reset_date timestamp with time zone,
    max_ai_generations_per_day integer,
    ai_generations_today integer,
    ai_generations_reset_date date
);


--
-- Name: user_rate_limits; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_rate_limits (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    endpoint character varying(100) NOT NULL,
    max_requests integer NOT NULL,
    window_minutes integer DEFAULT 60 NOT NULL,
    reason text,
    created_by uuid,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: user_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_roles (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    role public.app_role DEFAULT 'user'::public.app_role NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: user_subscriptions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.user_subscriptions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    plan_id uuid NOT NULL,
    status text DEFAULT 'active'::text NOT NULL,
    current_period_start timestamp with time zone,
    current_period_end timestamp with time zone,
    cancel_at_period_end boolean DEFAULT false,
    stripe_subscription_id text,
    stripe_customer_id text,
    coupon_id uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT user_subscriptions_status_check CHECK ((status = ANY (ARRAY['active'::text, 'cancelled'::text, 'expired'::text, 'past_due'::text])))
);


--
-- Name: video_processing_presets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.video_processing_presets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    platform text NOT NULL,
    preset_type text NOT NULL,
    crop_aspect_ratio text,
    compress_quality integer,
    compress_max_size_mb integer,
    is_default boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT video_processing_presets_compress_max_size_mb_check CHECK (((compress_max_size_mb IS NULL) OR (compress_max_size_mb > 0))),
    CONSTRAINT video_processing_presets_compress_quality_check CHECK (((compress_quality IS NULL) OR ((compress_quality >= 10) AND (compress_quality <= 100)))),
    CONSTRAINT video_processing_presets_preset_type_check CHECK ((preset_type = ANY (ARRAY['crop'::text, 'compress'::text, 'both'::text])))
);


--
-- Name: webhook_unmatched_observations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.webhook_unmatched_observations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    platform text NOT NULL,
    recipient_id text NOT NULL,
    event_kind text NOT NULL,
    reason text NOT NULL,
    observed_on date DEFAULT CURRENT_DATE NOT NULL,
    first_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    last_seen_at timestamp with time zone DEFAULT now() NOT NULL,
    attempts integer DEFAULT 1 NOT NULL,
    last_summary jsonb DEFAULT '{}'::jsonb NOT NULL,
    social_account_id uuid,
    user_id uuid,
    CONSTRAINT webhook_unmatched_observations_event_kind_check CHECK ((event_kind = ANY (ARRAY['message'::text, 'comment'::text, 'unknown'::text]))),
    CONSTRAINT webhook_unmatched_observations_platform_check CHECK ((platform = ANY (ARRAY['facebook'::text, 'instagram'::text, 'whatsapp'::text]))),
    CONSTRAINT webhook_unmatched_observations_reason_check CHECK ((reason = ANY (ARRAY['unknown_recipient'::text, 'account_inactive'::text]))),
    CONSTRAINT webhook_unmatched_observations_recipient_id_check CHECK ((length(recipient_id) <= 64))
);


--
-- Name: whatsapp_agents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_agents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    display_name text NOT NULL,
    avatar_url text,
    status text DEFAULT 'offline'::text NOT NULL,
    max_conversations integer DEFAULT 10,
    current_conversations integer DEFAULT 0,
    last_seen_at timestamp with time zone DEFAULT now(),
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    workspace_id uuid NOT NULL,
    CONSTRAINT whatsapp_agents_status_check CHECK ((status = ANY (ARRAY['online'::text, 'away'::text, 'offline'::text])))
);


--
-- Name: whatsapp_assignment_history; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_assignment_history (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id text NOT NULL,
    action text NOT NULL,
    from_agent_id uuid,
    to_agent_id uuid,
    performed_by uuid,
    reason text,
    created_at timestamp with time zone DEFAULT now(),
    CONSTRAINT whatsapp_assignment_history_action_check CHECK ((action = ANY (ARRAY['assigned'::text, 'unassigned'::text, 'transferred'::text])))
);


--
-- Name: whatsapp_auto_replies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_auto_replies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    rule_type text NOT NULL,
    keywords text[],
    reply_message text NOT NULL,
    is_active boolean DEFAULT true,
    schedule_start time without time zone,
    schedule_end time without time zone,
    schedule_days integer[],
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    CONSTRAINT whatsapp_auto_replies_rule_type_check CHECK ((rule_type = ANY (ARRAY['away'::text, 'keyword'::text])))
);


--
-- Name: whatsapp_auto_reply_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_auto_reply_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    auto_reply_rule_id uuid NOT NULL,
    conversation_id text,
    triggered_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: whatsapp_broadcast_recipients; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_broadcast_recipients (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    broadcast_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    phone_number text NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    error_message text,
    sent_at timestamp with time zone,
    delivered_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT whatsapp_broadcast_recipients_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'delivered'::text, 'failed'::text])))
);


--
-- Name: whatsapp_broadcasts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_broadcasts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    template_name text NOT NULL,
    template_components jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    recipient_count integer DEFAULT 0 NOT NULL,
    sent_count integer DEFAULT 0 NOT NULL,
    delivered_count integer DEFAULT 0 NOT NULL,
    failed_count integer DEFAULT 0 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT whatsapp_broadcasts_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: whatsapp_contact_group_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_contact_group_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    group_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: whatsapp_contact_groups; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_contact_groups (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    color text DEFAULT '#6366f1'::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: whatsapp_contacts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_contacts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    phone_number text NOT NULL,
    display_name text,
    email text,
    company text,
    notes text,
    tags text[] DEFAULT '{}'::text[],
    avatar_url text,
    last_message_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    first_name text,
    last_name text,
    job_title text,
    phone_secondary text,
    street text,
    city text,
    country text,
    birthday date,
    website text,
    workspace_id uuid NOT NULL
);


--
-- Name: whatsapp_conversation_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_conversation_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    conversation_id text NOT NULL,
    agent_id uuid,
    assigned_by uuid,
    notes text,
    assigned_at timestamp with time zone DEFAULT now(),
    unassigned_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    workspace_id uuid,
    conversation_cache_id uuid
);


--
-- Name: whatsapp_conversation_label_assignments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_conversation_label_assignments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    conversation_id text NOT NULL,
    label_id uuid NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: whatsapp_conversation_labels; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_conversation_labels (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    color text DEFAULT '#6366f1'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now()
);


--
-- Name: whatsapp_deals; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_deals (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    pipeline_id uuid NOT NULL,
    stage_id uuid NOT NULL,
    contact_id uuid NOT NULL,
    conversation_cache_id uuid,
    title text NOT NULL,
    amount numeric(14,2) DEFAULT 0 NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    status text DEFAULT 'open'::text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    assigned_to uuid,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT whatsapp_deals_status_check CHECK ((status = ANY (ARRAY['open'::text, 'won'::text, 'lost'::text])))
);


--
-- Name: whatsapp_evolution_instances; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_evolution_instances (
    social_account_id uuid NOT NULL,
    instance_name text NOT NULL,
    jwt_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    rotated_at timestamp with time zone,
    last_connection_state text,
    last_qr text,
    sync_started_at timestamp with time zone,
    last_sync_at timestamp with time zone
);


--
-- Name: whatsapp_message_analytics; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_message_analytics (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    social_account_id uuid NOT NULL,
    date date NOT NULL,
    messages_sent integer DEFAULT 0 NOT NULL,
    messages_received integer DEFAULT 0 NOT NULL,
    templates_sent integer DEFAULT 0 NOT NULL,
    conversations_opened integer DEFAULT 0 NOT NULL,
    avg_response_time_minutes numeric,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: whatsapp_message_flags; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_message_flags (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    message_row_id uuid NOT NULL,
    pinned_at timestamp with time zone,
    hidden_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: whatsapp_message_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_message_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    social_account_id uuid NOT NULL,
    template_name text NOT NULL,
    template_language text DEFAULT 'en_US'::text NOT NULL,
    template_category text DEFAULT 'UTILITY'::text NOT NULL,
    template_status text DEFAULT 'PENDING'::text NOT NULL,
    components jsonb DEFAULT '[]'::jsonb NOT NULL,
    meta_template_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: whatsapp_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    social_account_id uuid NOT NULL,
    conversation_id text NOT NULL,
    message_id text,
    from_phone text,
    from_name text,
    to_phone text,
    message_text text,
    message_type text DEFAULT 'text'::text NOT NULL,
    media_url text,
    direction text DEFAULT 'inbound'::text NOT NULL,
    status text DEFAULT 'sent'::text NOT NULL,
    "timestamp" timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    media_type text,
    media_metadata jsonb,
    error_code text,
    error_message text,
    media_understanding text,
    media_understanding_meta jsonb,
    revoked_at timestamp with time zone,
    revoked_by uuid
);


--
-- Name: COLUMN whatsapp_messages.media_understanding; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.whatsapp_messages.media_understanding IS 'Transcript (audio) or description+OCR (image) handed to the AI agent in place of the placeholder. NULL when the feature is off or understanding failed.';


--
-- Name: COLUMN whatsapp_messages.media_understanding_meta; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.whatsapp_messages.media_understanding_meta IS 'provider, model, kind, duration_seconds, confidence, extracted_data, attempted_at. Used for cost attribution and for judging transcription quality after the fact.';


--
-- Name: COLUMN whatsapp_messages.revoked_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.whatsapp_messages.revoked_at IS 'Set when delete-for-everyone succeeded on the platform. Visible to every workspace member. No ingest path can clobber it: webhooks conflict to DO NOTHING and the history import updates an explicit two-column list.';


--
-- Name: whatsapp_pipeline_stages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_pipeline_stages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    pipeline_id uuid NOT NULL,
    name text NOT NULL,
    "position" integer DEFAULT 0 NOT NULL,
    stage_type text DEFAULT 'open'::text NOT NULL,
    color text DEFAULT '#3b82f6'::text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT whatsapp_pipeline_stages_stage_type_check CHECK ((stage_type = ANY (ARRAY['open'::text, 'won'::text, 'lost'::text])))
);


--
-- Name: whatsapp_pipelines; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_pipelines (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    name text NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: whatsapp_quick_replies; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_quick_replies (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    title text NOT NULL,
    message text NOT NULL,
    shortcut text,
    sort_order integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: whatsapp_quick_reply_usage; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_quick_reply_usage (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    quick_reply_id uuid NOT NULL,
    conversation_id text,
    used_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: whatsapp_scheduled_messages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_scheduled_messages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    social_account_id uuid NOT NULL,
    recipient_phone text NOT NULL,
    recipient_name text,
    message_text text,
    media_url text,
    media_type text,
    scheduled_at timestamp with time zone NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    sent_at timestamp with time zone,
    error_message text,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: whatsapp_webhooks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.whatsapp_webhooks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    url text NOT NULL,
    secret text,
    events text[] DEFAULT '{message.received}'::text[],
    is_active boolean DEFAULT true,
    last_triggered_at timestamp with time zone,
    last_status_code integer,
    failure_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: workflow_comments; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_comments (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workflow_id uuid NOT NULL,
    user_id uuid NOT NULL,
    node_id text,
    "position" jsonb DEFAULT '{"x": 0, "y": 0}'::jsonb,
    content text NOT NULL,
    is_resolved boolean DEFAULT false,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_executions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_executions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workflow_id uuid NOT NULL,
    user_id uuid NOT NULL,
    status text DEFAULT 'pending'::text NOT NULL,
    started_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    execution_summary jsonb DEFAULT '{}'::jsonb,
    error_message text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workflow_executions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'running'::text, 'completed'::text, 'failed'::text, 'cancelled'::text])))
);


--
-- Name: workflow_schedules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_schedules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workflow_id uuid NOT NULL,
    user_id uuid NOT NULL,
    cron_expression text NOT NULL,
    timezone text DEFAULT 'UTC'::text,
    name text,
    is_active boolean DEFAULT true,
    last_run_at timestamp with time zone,
    next_run_at timestamp with time zone,
    run_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_templates (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    description text,
    category text NOT NULL,
    icon text,
    nodes jsonb DEFAULT '[]'::jsonb NOT NULL,
    edges jsonb DEFAULT '[]'::jsonb NOT NULL,
    preview_image_url text,
    use_count integer DEFAULT 0,
    is_featured boolean DEFAULT false,
    is_active boolean DEFAULT true,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_versions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_versions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workflow_id uuid NOT NULL,
    version_number integer NOT NULL,
    nodes jsonb NOT NULL,
    edges jsonb NOT NULL,
    viewport jsonb,
    change_description text,
    created_by uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflow_webhooks; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflow_webhooks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workflow_id uuid NOT NULL,
    user_id uuid NOT NULL,
    webhook_token text DEFAULT encode(extensions.gen_random_bytes(32), 'hex'::text) NOT NULL,
    name text,
    is_active boolean DEFAULT true,
    last_triggered_at timestamp with time zone,
    trigger_count integer DEFAULT 0,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workflows; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workflows (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    user_id uuid NOT NULL,
    name text NOT NULL,
    description text,
    nodes jsonb DEFAULT '[]'::jsonb NOT NULL,
    edges jsonb DEFAULT '[]'::jsonb NOT NULL,
    viewport jsonb DEFAULT '{"x": 0, "y": 0, "zoom": 1}'::jsonb,
    is_template boolean DEFAULT false,
    is_public boolean DEFAULT false,
    category text,
    tags text[] DEFAULT '{}'::text[],
    thumbnail_url text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: workspace_invitations; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_invitations (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    email text NOT NULL,
    role text NOT NULL,
    token_hash text NOT NULL,
    invited_by uuid,
    expires_at timestamp with time zone NOT NULL,
    accepted_at timestamp with time zone,
    accepted_by uuid,
    revoked_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_invitations_email_check CHECK (((email <> ''::text) AND (email = lower(btrim(email))))),
    CONSTRAINT workspace_invitations_role_check CHECK ((role = ANY (ARRAY['admin'::text, 'agent'::text, 'viewer'::text]))),
    CONSTRAINT workspace_invitations_token_hash_check CHECK ((token_hash ~ '^[0-9a-f]{64}$'::text))
);


--
-- Name: workspace_members; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspace_members (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    workspace_id uuid NOT NULL,
    user_id uuid NOT NULL,
    role text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT workspace_members_role_check CHECK ((role = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text, 'viewer'::text])))
);


--
-- Name: workspaces; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.workspaces (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    owner_id uuid NOT NULL,
    is_personal boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: messages; Type: TABLE; Schema: realtime; Owner: -
--

CREATE TABLE realtime.messages (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL
)
PARTITION BY RANGE (inserted_at);


--
-- Name: messages_2026_08_27; Type: TABLE; Schema: realtime; Owner: -
--

CREATE TABLE realtime.messages_2026_08_27 (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: messages_2026_08_28; Type: TABLE; Schema: realtime; Owner: -
--

CREATE TABLE realtime.messages_2026_08_28 (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: messages_2026_08_29; Type: TABLE; Schema: realtime; Owner: -
--

CREATE TABLE realtime.messages_2026_08_29 (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: messages_2026_08_30; Type: TABLE; Schema: realtime; Owner: -
--

CREATE TABLE realtime.messages_2026_08_30 (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: messages_2026_08_31; Type: TABLE; Schema: realtime; Owner: -
--

CREATE TABLE realtime.messages_2026_08_31 (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: messages_2026_09_01; Type: TABLE; Schema: realtime; Owner: -
--

CREATE TABLE realtime.messages_2026_09_01 (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: messages_2026_09_02; Type: TABLE; Schema: realtime; Owner: -
--

CREATE TABLE realtime.messages_2026_09_02 (
    topic text NOT NULL,
    extension text NOT NULL,
    payload jsonb,
    event text,
    private boolean DEFAULT false,
    updated_at timestamp without time zone DEFAULT now() NOT NULL,
    inserted_at timestamp without time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: schema_migrations; Type: TABLE; Schema: realtime; Owner: -
--

CREATE TABLE realtime.schema_migrations (
    version bigint NOT NULL,
    inserted_at timestamp(0) without time zone
);


--
-- Name: subscription; Type: TABLE; Schema: realtime; Owner: -
--

CREATE TABLE realtime.subscription (
    id bigint NOT NULL,
    subscription_id uuid NOT NULL,
    entity regclass NOT NULL,
    filters realtime.user_defined_filter[] DEFAULT '{}'::realtime.user_defined_filter[] NOT NULL,
    claims jsonb NOT NULL,
    claims_role regrole GENERATED ALWAYS AS (realtime.to_regrole((claims ->> 'role'::text))) STORED NOT NULL,
    created_at timestamp without time zone DEFAULT timezone('utc'::text, now()) NOT NULL
);


--
-- Name: subscription_id_seq; Type: SEQUENCE; Schema: realtime; Owner: -
--

ALTER TABLE realtime.subscription ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME realtime.subscription_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: buckets; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.buckets (
    id text NOT NULL,
    name text NOT NULL,
    owner uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    public boolean DEFAULT false,
    avif_autodetection boolean DEFAULT false,
    file_size_limit bigint,
    allowed_mime_types text[],
    owner_id text,
    type storage.buckettype DEFAULT 'STANDARD'::storage.buckettype NOT NULL
);


--
-- Name: COLUMN buckets.owner; Type: COMMENT; Schema: storage; Owner: -
--

COMMENT ON COLUMN storage.buckets.owner IS 'Field is deprecated, use owner_id instead';


--
-- Name: buckets_analytics; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.buckets_analytics (
    name text NOT NULL,
    type storage.buckettype DEFAULT 'ANALYTICS'::storage.buckettype NOT NULL,
    format text DEFAULT 'ICEBERG'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    deleted_at timestamp with time zone
);


--
-- Name: buckets_vectors; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.buckets_vectors (
    id text NOT NULL,
    type storage.buckettype DEFAULT 'VECTOR'::storage.buckettype NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: migrations; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.migrations (
    id integer NOT NULL,
    name character varying(100) NOT NULL,
    hash character varying(40) NOT NULL,
    executed_at timestamp without time zone DEFAULT CURRENT_TIMESTAMP
);


--
-- Name: objects; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.objects (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    bucket_id text,
    name text,
    owner uuid,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now(),
    last_accessed_at timestamp with time zone DEFAULT now(),
    metadata jsonb,
    path_tokens text[],
    version text,
    owner_id text,
    user_metadata jsonb,
    level integer
);


--
-- Name: COLUMN objects.owner; Type: COMMENT; Schema: storage; Owner: -
--

COMMENT ON COLUMN storage.objects.owner IS 'Field is deprecated, use owner_id instead';


--
-- Name: prefixes; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.prefixes (
    bucket_id text NOT NULL,
    name text NOT NULL COLLATE pg_catalog."C",
    level integer GENERATED ALWAYS AS (storage.get_level(name)) STORED NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: s3_multipart_uploads; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.s3_multipart_uploads (
    id text NOT NULL,
    in_progress_size bigint DEFAULT 0 NOT NULL,
    upload_signature text NOT NULL,
    bucket_id text NOT NULL,
    key text NOT NULL,
    version text NOT NULL,
    owner_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    user_metadata jsonb,
    metadata jsonb
);


--
-- Name: s3_multipart_uploads_parts; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.s3_multipart_uploads_parts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    upload_id text NOT NULL,
    size bigint DEFAULT 0 NOT NULL,
    part_number integer NOT NULL,
    bucket_id text NOT NULL,
    key text NOT NULL,
    etag text NOT NULL,
    owner_id text,
    version text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: vector_indexes; Type: TABLE; Schema: storage; Owner: -
--

CREATE TABLE storage.vector_indexes (
    id text DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    bucket_id text NOT NULL,
    data_type text NOT NULL,
    dimension integer NOT NULL,
    distance_metric text NOT NULL,
    metadata_configuration jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: messages_2026_08_27; Type: TABLE ATTACH; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages ATTACH PARTITION realtime.messages_2026_08_27 FOR VALUES FROM ('2026-08-27 00:00:00') TO ('2026-08-28 00:00:00');


--
-- Name: messages_2026_08_28; Type: TABLE ATTACH; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages ATTACH PARTITION realtime.messages_2026_08_28 FOR VALUES FROM ('2026-08-28 00:00:00') TO ('2026-08-29 00:00:00');


--
-- Name: messages_2026_08_29; Type: TABLE ATTACH; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages ATTACH PARTITION realtime.messages_2026_08_29 FOR VALUES FROM ('2026-08-29 00:00:00') TO ('2026-08-30 00:00:00');


--
-- Name: messages_2026_08_30; Type: TABLE ATTACH; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages ATTACH PARTITION realtime.messages_2026_08_30 FOR VALUES FROM ('2026-08-30 00:00:00') TO ('2026-08-31 00:00:00');


--
-- Name: messages_2026_08_31; Type: TABLE ATTACH; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages ATTACH PARTITION realtime.messages_2026_08_31 FOR VALUES FROM ('2026-08-31 00:00:00') TO ('2026-09-01 00:00:00');


--
-- Name: messages_2026_09_01; Type: TABLE ATTACH; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages ATTACH PARTITION realtime.messages_2026_09_01 FOR VALUES FROM ('2026-09-01 00:00:00') TO ('2026-09-02 00:00:00');


--
-- Name: messages_2026_09_02; Type: TABLE ATTACH; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages ATTACH PARTITION realtime.messages_2026_09_02 FOR VALUES FROM ('2026-09-02 00:00:00') TO ('2026-09-03 00:00:00');


--
-- Name: refresh_tokens id; Type: DEFAULT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.refresh_tokens ALTER COLUMN id SET DEFAULT nextval('auth.refresh_tokens_id_seq'::regclass);


--
-- Name: pending_agent_replies ingress_seq; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_agent_replies ALTER COLUMN ingress_seq SET DEFAULT nextval('public.pending_agent_replies_ingress_seq_seq'::regclass);


--
-- Name: mfa_amr_claims amr_id_pk; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_amr_claims
    ADD CONSTRAINT amr_id_pk PRIMARY KEY (id);


--
-- Name: audit_log_entries audit_log_entries_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.audit_log_entries
    ADD CONSTRAINT audit_log_entries_pkey PRIMARY KEY (id);


--
-- Name: flow_state flow_state_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.flow_state
    ADD CONSTRAINT flow_state_pkey PRIMARY KEY (id);


--
-- Name: identities identities_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.identities
    ADD CONSTRAINT identities_pkey PRIMARY KEY (id);


--
-- Name: identities identities_provider_id_provider_unique; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.identities
    ADD CONSTRAINT identities_provider_id_provider_unique UNIQUE (provider_id, provider);


--
-- Name: instances instances_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.instances
    ADD CONSTRAINT instances_pkey PRIMARY KEY (id);


--
-- Name: mfa_amr_claims mfa_amr_claims_session_id_authentication_method_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_amr_claims
    ADD CONSTRAINT mfa_amr_claims_session_id_authentication_method_pkey UNIQUE (session_id, authentication_method);


--
-- Name: mfa_challenges mfa_challenges_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_challenges
    ADD CONSTRAINT mfa_challenges_pkey PRIMARY KEY (id);


--
-- Name: mfa_factors mfa_factors_last_challenged_at_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_factors
    ADD CONSTRAINT mfa_factors_last_challenged_at_key UNIQUE (last_challenged_at);


--
-- Name: mfa_factors mfa_factors_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_factors
    ADD CONSTRAINT mfa_factors_pkey PRIMARY KEY (id);


--
-- Name: oauth_clients oauth_clients_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.oauth_clients
    ADD CONSTRAINT oauth_clients_pkey PRIMARY KEY (id);


--
-- Name: oauth_consents oauth_consents_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.oauth_consents
    ADD CONSTRAINT oauth_consents_pkey PRIMARY KEY (id);


--
-- Name: one_time_tokens one_time_tokens_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.one_time_tokens
    ADD CONSTRAINT one_time_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.refresh_tokens
    ADD CONSTRAINT refresh_tokens_pkey PRIMARY KEY (id);


--
-- Name: refresh_tokens refresh_tokens_token_unique; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.refresh_tokens
    ADD CONSTRAINT refresh_tokens_token_unique UNIQUE (token);


--
-- Name: saml_providers saml_providers_entity_id_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.saml_providers
    ADD CONSTRAINT saml_providers_entity_id_key UNIQUE (entity_id);


--
-- Name: saml_providers saml_providers_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.saml_providers
    ADD CONSTRAINT saml_providers_pkey PRIMARY KEY (id);


--
-- Name: saml_relay_states saml_relay_states_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.saml_relay_states
    ADD CONSTRAINT saml_relay_states_pkey PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: sso_domains sso_domains_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.sso_domains
    ADD CONSTRAINT sso_domains_pkey PRIMARY KEY (id);


--
-- Name: sso_providers sso_providers_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.sso_providers
    ADD CONSTRAINT sso_providers_pkey PRIMARY KEY (id);


--
-- Name: users users_phone_key; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.users
    ADD CONSTRAINT users_phone_key UNIQUE (phone);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: admin_audit_log admin_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_audit_log
    ADD CONSTRAINT admin_audit_log_pkey PRIMARY KEY (id);


--
-- Name: admin_inbox_messages admin_inbox_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_inbox_messages
    ADD CONSTRAINT admin_inbox_messages_pkey PRIMARY KEY (id);


--
-- Name: admin_notifications admin_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notifications
    ADD CONSTRAINT admin_notifications_pkey PRIMARY KEY (id);


--
-- Name: ai_agent_allowed_models ai_agent_allowed_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agent_allowed_models
    ADD CONSTRAINT ai_agent_allowed_models_pkey PRIMARY KEY (id);


--
-- Name: ai_agent_allowed_models ai_agent_allowed_models_provider_model_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agent_allowed_models
    ADD CONSTRAINT ai_agent_allowed_models_provider_model_id_key UNIQUE (provider, model_id);


--
-- Name: ai_agent_configs ai_agent_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agent_configs
    ADD CONSTRAINT ai_agent_configs_pkey PRIMARY KEY (id);


--
-- Name: ai_agent_logs ai_agent_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agent_logs
    ADD CONSTRAINT ai_agent_logs_pkey PRIMARY KEY (id);


--
-- Name: ai_agent_tools ai_agent_tools_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agent_tools
    ADD CONSTRAINT ai_agent_tools_pkey PRIMARY KEY (id);


--
-- Name: ai_agent_tools ai_agent_tools_user_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agent_tools
    ADD CONSTRAINT ai_agent_tools_user_id_name_key UNIQUE (user_id, name);


--
-- Name: ai_conversation_modes ai_conversation_modes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_conversation_modes
    ADD CONSTRAINT ai_conversation_modes_pkey PRIMARY KEY (id);


--
-- Name: ai_conversation_modes ai_conversation_modes_user_id_platform_conversation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_conversation_modes
    ADD CONSTRAINT ai_conversation_modes_user_id_platform_conversation_id_key UNIQUE (user_id, platform, conversation_id);


--
-- Name: ai_generation_jobs ai_generation_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_generation_jobs
    ADD CONSTRAINT ai_generation_jobs_pkey PRIMARY KEY (id);


--
-- Name: ai_knowledge_chunks ai_knowledge_chunks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_chunks
    ADD CONSTRAINT ai_knowledge_chunks_pkey PRIMARY KEY (id);


--
-- Name: ai_knowledge_entities ai_knowledge_entities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_entities
    ADD CONSTRAINT ai_knowledge_entities_pkey PRIMARY KEY (id);


--
-- Name: ai_knowledge_entities ai_knowledge_entities_user_id_normalized_name_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_entities
    ADD CONSTRAINT ai_knowledge_entities_user_id_normalized_name_type_key UNIQUE (user_id, normalized_name, type);


--
-- Name: ai_knowledge_graph_exports ai_knowledge_graph_exports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_graph_exports
    ADD CONSTRAINT ai_knowledge_graph_exports_pkey PRIMARY KEY (id);


--
-- Name: ai_knowledge_graph_exports ai_knowledge_graph_exports_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_graph_exports
    ADD CONSTRAINT ai_knowledge_graph_exports_user_id_key UNIQUE (user_id);


--
-- Name: ai_knowledge_relations ai_knowledge_relations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_relations
    ADD CONSTRAINT ai_knowledge_relations_pkey PRIMARY KEY (id);


--
-- Name: ai_knowledge_relations ai_knowledge_relations_source_chunk_id_source_entity_id_tar_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_relations
    ADD CONSTRAINT ai_knowledge_relations_source_chunk_id_source_entity_id_tar_key UNIQUE (source_chunk_id, source_entity_id, target_entity_id, relation);


--
-- Name: ai_knowledge_source_accounts ai_knowledge_source_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_source_accounts
    ADD CONSTRAINT ai_knowledge_source_accounts_pkey PRIMARY KEY (source_id, social_account_id);


--
-- Name: ai_knowledge_sources ai_knowledge_sources_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_sources
    ADD CONSTRAINT ai_knowledge_sources_id_user_id_key UNIQUE (id, user_id);


--
-- Name: ai_knowledge_sources ai_knowledge_sources_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_sources
    ADD CONSTRAINT ai_knowledge_sources_pkey PRIMARY KEY (id);


--
-- Name: ai_model_preferences ai_model_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_model_preferences
    ADD CONSTRAINT ai_model_preferences_pkey PRIMARY KEY (id);


--
-- Name: ai_model_preferences ai_model_preferences_user_id_feature_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_model_preferences
    ADD CONSTRAINT ai_model_preferences_user_id_feature_key UNIQUE (user_id, feature);


--
-- Name: ai_models ai_models_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_models
    ADD CONSTRAINT ai_models_pkey PRIMARY KEY (id);


--
-- Name: ai_models ai_models_provider_id_model_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_models
    ADD CONSTRAINT ai_models_provider_id_model_id_key UNIQUE (provider_id, model_id);


--
-- Name: ai_providers ai_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_providers
    ADD CONSTRAINT ai_providers_pkey PRIMARY KEY (id);


--
-- Name: ai_providers ai_providers_provider_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_providers
    ADD CONSTRAINT ai_providers_provider_code_key UNIQUE (provider_code);


--
-- Name: ai_thread_messages ai_thread_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_thread_messages
    ADD CONSTRAINT ai_thread_messages_pkey PRIMARY KEY (id);


--
-- Name: ai_threads ai_threads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_threads
    ADD CONSTRAINT ai_threads_pkey PRIMARY KEY (id);


--
-- Name: ai_threads ai_threads_user_id_platform_conversation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_threads
    ADD CONSTRAINT ai_threads_user_id_platform_conversation_id_key UNIQUE (user_id, platform, conversation_id);


--
-- Name: api_logs api_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_logs
    ADD CONSTRAINT api_logs_pkey PRIMARY KEY (id);


--
-- Name: app_credentials app_credentials_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_credentials
    ADD CONSTRAINT app_credentials_pkey PRIMARY KEY (secret_name);


--
-- Name: app_settings app_settings_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_key_key UNIQUE (key);


--
-- Name: app_settings app_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_pkey PRIMARY KEY (id);


--
-- Name: automation_dispatch_log automation_dispatch_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_dispatch_log
    ADD CONSTRAINT automation_dispatch_log_pkey PRIMARY KEY (id);


--
-- Name: backup_codes backup_codes_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_codes
    ADD CONSTRAINT backup_codes_pkey PRIMARY KEY (id);


--
-- Name: bi_post_content bi_post_content_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bi_post_content
    ADD CONSTRAINT bi_post_content_pkey PRIMARY KEY (id);


--
-- Name: bi_post_content bi_post_content_user_id_post_id_platform_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bi_post_content
    ADD CONSTRAINT bi_post_content_user_id_post_id_platform_key UNIQUE (user_id, post_id, platform);


--
-- Name: blog_posts blog_posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_posts
    ADD CONSTRAINT blog_posts_pkey PRIMARY KEY (id);


--
-- Name: brand_scrape_cache brand_scrape_cache_cache_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_scrape_cache
    ADD CONSTRAINT brand_scrape_cache_cache_key_key UNIQUE (cache_key);


--
-- Name: brand_scrape_cache brand_scrape_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_scrape_cache
    ADD CONSTRAINT brand_scrape_cache_pkey PRIMARY KEY (id);


--
-- Name: brand_scrape_sessions brand_scrape_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_scrape_sessions
    ADD CONSTRAINT brand_scrape_sessions_pkey PRIMARY KEY (id);


--
-- Name: brand_search_history brand_search_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_search_history
    ADD CONSTRAINT brand_search_history_pkey PRIMARY KEY (id);


--
-- Name: caption_history caption_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.caption_history
    ADD CONSTRAINT caption_history_pkey PRIMARY KEY (id);


--
-- Name: comment_inbox_cache comment_inbox_cache_comment_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comment_inbox_cache
    ADD CONSTRAINT comment_inbox_cache_comment_id_key UNIQUE (comment_id);


--
-- Name: comment_inbox_cache comment_inbox_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.comment_inbox_cache
    ADD CONSTRAINT comment_inbox_cache_pkey PRIMARY KEY (id);


--
-- Name: coupon_redemptions coupon_redemptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupon_redemptions
    ADD CONSTRAINT coupon_redemptions_pkey PRIMARY KEY (id);


--
-- Name: coupons coupons_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupons
    ADD CONSTRAINT coupons_code_key UNIQUE (code);


--
-- Name: coupons coupons_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupons
    ADD CONSTRAINT coupons_pkey PRIMARY KEY (id);


--
-- Name: credit_transactions credit_transactions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_transactions
    ADD CONSTRAINT credit_transactions_pkey PRIMARY KEY (id);


--
-- Name: deployment_logs deployment_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployment_logs
    ADD CONSTRAINT deployment_logs_pkey PRIMARY KEY (id);


--
-- Name: edge_function_status edge_function_status_function_name_checked_at_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edge_function_status
    ADD CONSTRAINT edge_function_status_function_name_checked_at_key UNIQUE (function_name, checked_at);


--
-- Name: edge_function_status edge_function_status_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.edge_function_status
    ADD CONSTRAINT edge_function_status_pkey PRIMARY KEY (id);


--
-- Name: email_contacts email_contacts_admin_id_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_contacts
    ADD CONSTRAINT email_contacts_admin_id_email_key UNIQUE (admin_id, email);


--
-- Name: email_contacts email_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_contacts
    ADD CONSTRAINT email_contacts_pkey PRIMARY KEY (id);


--
-- Name: email_drafts email_drafts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_drafts
    ADD CONSTRAINT email_drafts_pkey PRIMARY KEY (id);


--
-- Name: email_log email_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_log
    ADD CONSTRAINT email_log_pkey PRIMARY KEY (id);


--
-- Name: email_signatures email_signatures_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_signatures
    ADD CONSTRAINT email_signatures_pkey PRIMARY KEY (id);


--
-- Name: email_templates email_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_templates
    ADD CONSTRAINT email_templates_pkey PRIMARY KEY (id);


--
-- Name: email_templates email_templates_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_templates
    ADD CONSTRAINT email_templates_slug_key UNIQUE (slug);


--
-- Name: feature_flag_audit_log feature_flag_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flag_audit_log
    ADD CONSTRAINT feature_flag_audit_log_pkey PRIMARY KEY (id);


--
-- Name: feature_flag_schedules feature_flag_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flag_schedules
    ADD CONSTRAINT feature_flag_schedules_pkey PRIMARY KEY (id);


--
-- Name: generated_content_collections generated_content_collections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_content_collections
    ADD CONSTRAINT generated_content_collections_pkey PRIMARY KEY (id);


--
-- Name: higgsfield_connections higgsfield_connections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.higgsfield_connections
    ADD CONSTRAINT higgsfield_connections_pkey PRIMARY KEY (id);


--
-- Name: higgsfield_connections higgsfield_connections_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.higgsfield_connections
    ADD CONSTRAINT higgsfield_connections_user_id_key UNIQUE (user_id);


--
-- Name: image_reference_presets image_reference_presets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.image_reference_presets
    ADD CONSTRAINT image_reference_presets_pkey PRIMARY KEY (id);


--
-- Name: launch_checklist launch_checklist_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.launch_checklist
    ADD CONSTRAINT launch_checklist_pkey PRIMARY KEY (id);


--
-- Name: lead_forms lead_forms_form_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_forms
    ADD CONSTRAINT lead_forms_form_id_key UNIQUE (form_id);


--
-- Name: lead_forms lead_forms_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.lead_forms
    ADD CONSTRAINT lead_forms_pkey PRIMARY KEY (id);


--
-- Name: leads leads_meta_lead_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_meta_lead_id_key UNIQUE (meta_lead_id);


--
-- Name: leads leads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_pkey PRIMARY KEY (id);


--
-- Name: log_analyses log_analyses_log_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_analyses
    ADD CONSTRAINT log_analyses_log_id_key UNIQUE (log_id);


--
-- Name: log_analyses log_analyses_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_analyses
    ADD CONSTRAINT log_analyses_pkey PRIMARY KEY (id);


--
-- Name: mcp_oauth_authorizations mcp_oauth_authorizations_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_authorizations
    ADD CONSTRAINT mcp_oauth_authorizations_code_key UNIQUE (code);


--
-- Name: mcp_oauth_authorizations mcp_oauth_authorizations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_authorizations
    ADD CONSTRAINT mcp_oauth_authorizations_pkey PRIMARY KEY (id);


--
-- Name: mcp_oauth_clients mcp_oauth_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_clients
    ADD CONSTRAINT mcp_oauth_clients_pkey PRIMARY KEY (client_id);


--
-- Name: mcp_oauth_tokens mcp_oauth_tokens_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_tokens
    ADD CONSTRAINT mcp_oauth_tokens_pkey PRIMARY KEY (id);


--
-- Name: mcp_oauth_tokens mcp_oauth_tokens_refresh_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_tokens
    ADD CONSTRAINT mcp_oauth_tokens_refresh_token_hash_key UNIQUE (refresh_token_hash);


--
-- Name: mcp_oauth_tokens mcp_oauth_tokens_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_tokens
    ADD CONSTRAINT mcp_oauth_tokens_token_hash_key UNIQUE (token_hash);


--
-- Name: media_file_providers media_file_providers_media_file_id_provider_object_version_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_file_providers
    ADD CONSTRAINT media_file_providers_media_file_id_provider_object_version_key UNIQUE (media_file_id, provider, object_version);


--
-- Name: media_file_providers media_file_providers_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_file_providers
    ADD CONSTRAINT media_file_providers_pkey PRIMARY KEY (id);


--
-- Name: media_files media_files_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_files
    ADD CONSTRAINT media_files_pkey PRIMARY KEY (id);


--
-- Name: media_folders media_folders_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_folders
    ADD CONSTRAINT media_folders_pkey PRIMARY KEY (id);


--
-- Name: media_folders media_folders_user_id_full_path_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_folders
    ADD CONSTRAINT media_folders_user_id_full_path_key UNIQUE (user_id, full_path);


--
-- Name: media_operations_history media_operations_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_operations_history
    ADD CONSTRAINT media_operations_history_pkey PRIMARY KEY (id);


--
-- Name: media_understanding_sender_usage media_understanding_sender_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_understanding_sender_usage
    ADD CONSTRAINT media_understanding_sender_usage_pkey PRIMARY KEY (social_account_id, sender_id, usage_date);


--
-- Name: media_understanding_usage media_understanding_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_understanding_usage
    ADD CONSTRAINT media_understanding_usage_pkey PRIMARY KEY (social_account_id, usage_date);


--
-- Name: media_upload_counters media_upload_counters_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_upload_counters
    ADD CONSTRAINT media_upload_counters_pkey PRIMARY KEY (user_id, upload_date);


--
-- Name: messaging_cache messaging_cache_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messaging_cache
    ADD CONSTRAINT messaging_cache_id_workspace_id_key UNIQUE (id, workspace_id);


--
-- Name: messaging_cache messaging_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messaging_cache
    ADD CONSTRAINT messaging_cache_pkey PRIMARY KEY (id);


--
-- Name: messaging_cache messaging_cache_user_id_conversation_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messaging_cache
    ADD CONSTRAINT messaging_cache_user_id_conversation_id_key UNIQUE (user_id, conversation_id);


--
-- Name: messenger_auto_replies messenger_auto_replies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messenger_auto_replies
    ADD CONSTRAINT messenger_auto_replies_pkey PRIMARY KEY (id);


--
-- Name: messenger_auto_reply_usage messenger_auto_reply_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messenger_auto_reply_usage
    ADD CONSTRAINT messenger_auto_reply_usage_pkey PRIMARY KEY (id);


--
-- Name: node_execution_logs node_execution_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_execution_logs
    ADD CONSTRAINT node_execution_logs_pkey PRIMARY KEY (id);


--
-- Name: notification_reads notification_reads_notification_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_reads
    ADD CONSTRAINT notification_reads_notification_id_user_id_key UNIQUE (notification_id, user_id);


--
-- Name: notification_reads notification_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_reads
    ADD CONSTRAINT notification_reads_pkey PRIMARY KEY (id);


--
-- Name: oauth_apps oauth_apps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_apps
    ADD CONSTRAINT oauth_apps_pkey PRIMARY KEY (id);


--
-- Name: oauth_clients oauth_clients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT oauth_clients_pkey PRIMARY KEY (id);


--
-- Name: oauth_clients oauth_clients_provider_code_redirect_uri_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_clients
    ADD CONSTRAINT oauth_clients_provider_code_redirect_uri_key UNIQUE (provider_code, redirect_uri);


--
-- Name: oauth_pending_facebook_selections oauth_pending_facebook_selections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_pending_facebook_selections
    ADD CONSTRAINT oauth_pending_facebook_selections_pkey PRIMARY KEY (id);


--
-- Name: oauth_pending_instagram_selections oauth_pending_instagram_selections_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_pending_instagram_selections
    ADD CONSTRAINT oauth_pending_instagram_selections_pkey PRIMARY KEY (id);


--
-- Name: oauth_redirect_requests oauth_redirect_requests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_redirect_requests
    ADD CONSTRAINT oauth_redirect_requests_pkey PRIMARY KEY (id);


--
-- Name: oauth_states oauth_states_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_states
    ADD CONSTRAINT oauth_states_pkey PRIMARY KEY (state);


--
-- Name: observability_alert_configs observability_alert_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.observability_alert_configs
    ADD CONSTRAINT observability_alert_configs_pkey PRIMARY KEY (id);


--
-- Name: observability_alert_history observability_alert_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.observability_alert_history
    ADD CONSTRAINT observability_alert_history_pkey PRIMARY KEY (id);


--
-- Name: observability_health_snapshots observability_health_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.observability_health_snapshots
    ADD CONSTRAINT observability_health_snapshots_pkey PRIMARY KEY (id);


--
-- Name: observability_metrics observability_metrics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.observability_metrics
    ADD CONSTRAINT observability_metrics_pkey PRIMARY KEY (id);


--
-- Name: partner_api_idempotency partner_api_idempotency_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_api_idempotency
    ADD CONSTRAINT partner_api_idempotency_pkey PRIMARY KEY (key_id, idempotency_key);


--
-- Name: partner_api_key_accounts partner_api_key_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_api_key_accounts
    ADD CONSTRAINT partner_api_key_accounts_pkey PRIMARY KEY (key_id, social_account_id);


--
-- Name: partner_api_keys partner_api_keys_id_workspace_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_api_keys
    ADD CONSTRAINT partner_api_keys_id_workspace_key UNIQUE (id, workspace_id);


--
-- Name: partner_api_keys partner_api_keys_key_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_api_keys
    ADD CONSTRAINT partner_api_keys_key_hash_key UNIQUE (key_hash);


--
-- Name: partner_api_keys partner_api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_api_keys
    ADD CONSTRAINT partner_api_keys_pkey PRIMARY KEY (id);


--
-- Name: partner_api_rate_buckets partner_api_rate_buckets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_api_rate_buckets
    ADD CONSTRAINT partner_api_rate_buckets_pkey PRIMARY KEY (key_id, window_start);


--
-- Name: partner_api_usage partner_api_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_api_usage
    ADD CONSTRAINT partner_api_usage_pkey PRIMARY KEY (id);


--
-- Name: partner_audit_logs partner_audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_audit_logs
    ADD CONSTRAINT partner_audit_logs_pkey PRIMARY KEY (id);


--
-- Name: password_reset_otps password_reset_otps_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.password_reset_otps
    ADD CONSTRAINT password_reset_otps_pkey PRIMARY KEY (id);


--
-- Name: pending_agent_replies pending_agent_replies_dedup; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_agent_replies
    ADD CONSTRAINT pending_agent_replies_dedup UNIQUE (social_account_id, message_id);


--
-- Name: pending_agent_replies pending_agent_replies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_agent_replies
    ADD CONSTRAINT pending_agent_replies_pkey PRIMARY KEY (id);


--
-- Name: platform_posts platform_posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_posts
    ADD CONSTRAINT platform_posts_pkey PRIMARY KEY (id);


--
-- Name: post_templates post_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.post_templates
    ADD CONSTRAINT post_templates_pkey PRIMARY KEY (id);


--
-- Name: posts posts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posts
    ADD CONSTRAINT posts_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_api_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_api_key_key UNIQUE (api_key);


--
-- Name: profiles profiles_email_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_email_key UNIQUE (email);


--
-- Name: profiles profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_pkey PRIMARY KEY (id);


--
-- Name: profiles profiles_referral_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_referral_code_key UNIQUE (referral_code);


--
-- Name: provider_api_keys provider_api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_api_keys
    ADD CONSTRAINT provider_api_keys_pkey PRIMARY KEY (id);


--
-- Name: provider_api_keys provider_api_keys_provider_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_api_keys
    ADD CONSTRAINT provider_api_keys_provider_code_key UNIQUE (provider_code);


--
-- Name: rate_limit_buckets rate_limit_buckets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limit_buckets
    ADD CONSTRAINT rate_limit_buckets_pkey PRIMARY KEY (bucket_key);


--
-- Name: rate_limit_settings rate_limit_settings_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limit_settings
    ADD CONSTRAINT rate_limit_settings_endpoint_key UNIQUE (endpoint);


--
-- Name: rate_limit_settings rate_limit_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.rate_limit_settings
    ADD CONSTRAINT rate_limit_settings_pkey PRIMARY KEY (id);


--
-- Name: referrals referrals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_pkey PRIMARY KEY (id);


--
-- Name: referrals referrals_referral_code_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_referral_code_key UNIQUE (referral_code);


--
-- Name: saved_field_suggestions saved_field_suggestions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_field_suggestions
    ADD CONSTRAINT saved_field_suggestions_pkey PRIMARY KEY (id);


--
-- Name: saved_field_suggestions saved_field_suggestions_user_id_field_type_value_platform_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_field_suggestions
    ADD CONSTRAINT saved_field_suggestions_user_id_field_type_value_platform_key UNIQUE (user_id, field_type, value, platform);


--
-- Name: scheduled_emails scheduled_emails_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_emails
    ADD CONSTRAINT scheduled_emails_pkey PRIMARY KEY (id);


--
-- Name: social_accounts social_accounts_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_accounts
    ADD CONSTRAINT social_accounts_id_user_id_key UNIQUE (id, user_id);


--
-- Name: social_accounts social_accounts_id_user_id_platform_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_accounts
    ADD CONSTRAINT social_accounts_id_user_id_platform_key UNIQUE (id, user_id, platform);


--
-- Name: social_accounts social_accounts_id_workspace_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_accounts
    ADD CONSTRAINT social_accounts_id_workspace_key UNIQUE (id, workspace_id);


--
-- Name: social_accounts social_accounts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_accounts
    ADD CONSTRAINT social_accounts_pkey PRIMARY KEY (id);


--
-- Name: social_accounts social_accounts_user_id_platform_platform_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_accounts
    ADD CONSTRAINT social_accounts_user_id_platform_platform_user_id_key UNIQUE (user_id, platform, platform_user_id);


--
-- Name: social_accounts social_accounts_user_platform_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_accounts
    ADD CONSTRAINT social_accounts_user_platform_unique UNIQUE (user_id, platform, platform_user_id);


--
-- Name: social_inbox_events social_inbox_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_inbox_events
    ADD CONSTRAINT social_inbox_events_pkey PRIMARY KEY (id);


--
-- Name: social_inbox_events social_inbox_events_social_account_id_external_event_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_inbox_events
    ADD CONSTRAINT social_inbox_events_social_account_id_external_event_id_key UNIQUE (social_account_id, external_event_id);


--
-- Name: social_profiles social_profiles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_profiles
    ADD CONSTRAINT social_profiles_pkey PRIMARY KEY (id);


--
-- Name: social_profiles social_profiles_share_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_profiles
    ADD CONSTRAINT social_profiles_share_token_key UNIQUE (share_token);


--
-- Name: stripe_webhook_events stripe_webhook_events_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.stripe_webhook_events
    ADD CONSTRAINT stripe_webhook_events_pkey PRIMARY KEY (event_id);


--
-- Name: subscription_plans subscription_plans_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plans
    ADD CONSTRAINT subscription_plans_pkey PRIMARY KEY (id);


--
-- Name: subscription_plans subscription_plans_slug_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.subscription_plans
    ADD CONSTRAINT subscription_plans_slug_key UNIQUE (slug);


--
-- Name: support_messages support_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_messages
    ADD CONSTRAINT support_messages_pkey PRIMARY KEY (id);


--
-- Name: support_tickets support_tickets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_pkey PRIMARY KEY (id);


--
-- Name: support_tickets support_tickets_ticket_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_ticket_number_key UNIQUE (ticket_number);


--
-- Name: system_health_snapshots system_health_snapshots_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_health_snapshots
    ADD CONSTRAINT system_health_snapshots_pkey PRIMARY KEY (id);


--
-- Name: system_logs system_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_logs
    ADD CONSTRAINT system_logs_pkey PRIMARY KEY (id);


--
-- Name: system_notifications system_notifications_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_notifications
    ADD CONSTRAINT system_notifications_pkey PRIMARY KEY (id);


--
-- Name: system_settings system_settings_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_key_key UNIQUE (key);


--
-- Name: system_settings system_settings_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_settings
    ADD CONSTRAINT system_settings_pkey PRIMARY KEY (id);


--
-- Name: threads_mentions threads_mentions_account_mention_unique; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads_mentions
    ADD CONSTRAINT threads_mentions_account_mention_unique UNIQUE (social_account_id, mention_id);


--
-- Name: threads_mentions threads_mentions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads_mentions
    ADD CONSTRAINT threads_mentions_pkey PRIMARY KEY (id);


--
-- Name: threads_recent_searches threads_recent_searches_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads_recent_searches
    ADD CONSTRAINT threads_recent_searches_pkey PRIMARY KEY (id);


--
-- Name: threads_reply_cache threads_reply_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads_reply_cache
    ADD CONSTRAINT threads_reply_cache_pkey PRIMARY KEY (id);


--
-- Name: threads_reply_cache threads_reply_cache_social_account_id_reply_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads_reply_cache
    ADD CONSTRAINT threads_reply_cache_social_account_id_reply_id_key UNIQUE (social_account_id, reply_id);


--
-- Name: ticket_activities ticket_activities_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_activities
    ADD CONSTRAINT ticket_activities_pkey PRIMARY KEY (id);


--
-- Name: ticket_messages ticket_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_messages
    ADD CONSTRAINT ticket_messages_pkey PRIMARY KEY (id);


--
-- Name: tier_rate_limits tier_rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tier_rate_limits
    ADD CONSTRAINT tier_rate_limits_pkey PRIMARY KEY (id);


--
-- Name: tier_rate_limits tier_rate_limits_plan_slug_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tier_rate_limits
    ADD CONSTRAINT tier_rate_limits_plan_slug_endpoint_key UNIQUE (plan_slug, endpoint);


--
-- Name: tiktok_api_analytics_cache tiktok_api_analytics_cache_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tiktok_api_analytics_cache
    ADD CONSTRAINT tiktok_api_analytics_cache_pkey PRIMARY KEY (id);


--
-- Name: tiktok_api_analytics_cache tiktok_api_analytics_cache_social_account_id_cache_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tiktok_api_analytics_cache
    ADD CONSTRAINT tiktok_api_analytics_cache_social_account_id_cache_key_key UNIQUE (social_account_id, cache_key);


--
-- Name: token_refresh_history token_refresh_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.token_refresh_history
    ADD CONSTRAINT token_refresh_history_pkey PRIMARY KEY (id);


--
-- Name: social_profiles unique_profile_name_per_user; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_profiles
    ADD CONSTRAINT unique_profile_name_per_user UNIQUE (user_id, name);


--
-- Name: user_ai_model_overrides user_ai_model_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_ai_model_overrides
    ADD CONSTRAINT user_ai_model_overrides_pkey PRIMARY KEY (id);


--
-- Name: user_ai_model_overrides user_ai_model_overrides_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_ai_model_overrides
    ADD CONSTRAINT user_ai_model_overrides_user_id_key UNIQUE (user_id);


--
-- Name: user_blog_post_reads user_blog_post_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blog_post_reads
    ADD CONSTRAINT user_blog_post_reads_pkey PRIMARY KEY (id);


--
-- Name: user_blog_post_reads user_blog_post_reads_user_id_blog_post_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blog_post_reads
    ADD CONSTRAINT user_blog_post_reads_user_id_blog_post_id_key UNIQUE (user_id, blog_post_id);


--
-- Name: user_connectors user_connectors_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_connectors
    ADD CONSTRAINT user_connectors_pkey PRIMARY KEY (id);


--
-- Name: user_connectors user_connectors_user_id_connector_type_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_connectors
    ADD CONSTRAINT user_connectors_user_id_connector_type_key UNIQUE (user_id, connector_type);


--
-- Name: user_credits user_credits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_credits
    ADD CONSTRAINT user_credits_pkey PRIMARY KEY (id);


--
-- Name: user_credits user_credits_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_credits
    ADD CONSTRAINT user_credits_user_id_key UNIQUE (user_id);


--
-- Name: user_feature_overrides user_feature_overrides_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_feature_overrides
    ADD CONSTRAINT user_feature_overrides_pkey PRIMARY KEY (id);


--
-- Name: user_feature_overrides user_feature_overrides_user_id_feature_key_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_feature_overrides
    ADD CONSTRAINT user_feature_overrides_user_id_feature_key_key UNIQUE (user_id, feature_key);


--
-- Name: user_notification_preferences user_notification_preferences_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notification_preferences
    ADD CONSTRAINT user_notification_preferences_pkey PRIMARY KEY (id);


--
-- Name: user_notification_preferences user_notification_preferences_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notification_preferences
    ADD CONSTRAINT user_notification_preferences_user_id_key UNIQUE (user_id);


--
-- Name: user_notification_reads user_notification_reads_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notification_reads
    ADD CONSTRAINT user_notification_reads_pkey PRIMARY KEY (id);


--
-- Name: user_notification_reads user_notification_reads_user_id_notification_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notification_reads
    ADD CONSTRAINT user_notification_reads_user_id_notification_id_key UNIQUE (user_id, notification_id);


--
-- Name: user_quotas user_quotas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_quotas
    ADD CONSTRAINT user_quotas_pkey PRIMARY KEY (id);


--
-- Name: user_quotas user_quotas_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_quotas
    ADD CONSTRAINT user_quotas_user_id_key UNIQUE (user_id);


--
-- Name: user_rate_limits user_rate_limits_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_rate_limits
    ADD CONSTRAINT user_rate_limits_pkey PRIMARY KEY (id);


--
-- Name: user_rate_limits user_rate_limits_user_id_endpoint_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_rate_limits
    ADD CONSTRAINT user_rate_limits_user_id_endpoint_key UNIQUE (user_id, endpoint);


--
-- Name: user_roles user_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_pkey PRIMARY KEY (id);


--
-- Name: user_roles user_roles_user_id_role_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_role_key UNIQUE (user_id, role);


--
-- Name: user_subscriptions user_subscriptions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_subscriptions
    ADD CONSTRAINT user_subscriptions_pkey PRIMARY KEY (id);


--
-- Name: video_processing_presets video_processing_presets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_processing_presets
    ADD CONSTRAINT video_processing_presets_pkey PRIMARY KEY (id);


--
-- Name: video_processing_presets video_processing_presets_user_id_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_processing_presets
    ADD CONSTRAINT video_processing_presets_user_id_name_key UNIQUE (user_id, name);


--
-- Name: webhook_unmatched_observations webhook_unmatched_observations_daily_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_unmatched_observations
    ADD CONSTRAINT webhook_unmatched_observations_daily_key UNIQUE (platform, recipient_id, event_kind, reason, observed_on);


--
-- Name: webhook_unmatched_observations webhook_unmatched_observations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_unmatched_observations
    ADD CONSTRAINT webhook_unmatched_observations_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_agents whatsapp_agents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_agents
    ADD CONSTRAINT whatsapp_agents_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_agents whatsapp_agents_workspace_id_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_agents
    ADD CONSTRAINT whatsapp_agents_workspace_id_user_id_key UNIQUE (workspace_id, user_id);


--
-- Name: whatsapp_assignment_history whatsapp_assignment_history_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_assignment_history
    ADD CONSTRAINT whatsapp_assignment_history_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_auto_replies whatsapp_auto_replies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_auto_replies
    ADD CONSTRAINT whatsapp_auto_replies_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_auto_reply_usage whatsapp_auto_reply_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_auto_reply_usage
    ADD CONSTRAINT whatsapp_auto_reply_usage_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_broadcast_recipients whatsapp_broadcast_recipients_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_broadcast_recipients
    ADD CONSTRAINT whatsapp_broadcast_recipients_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_broadcasts whatsapp_broadcasts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_broadcasts
    ADD CONSTRAINT whatsapp_broadcasts_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_contact_group_members whatsapp_contact_group_members_group_id_contact_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_contact_group_members
    ADD CONSTRAINT whatsapp_contact_group_members_group_id_contact_id_key UNIQUE (group_id, contact_id);


--
-- Name: whatsapp_contact_group_members whatsapp_contact_group_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_contact_group_members
    ADD CONSTRAINT whatsapp_contact_group_members_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_contact_groups whatsapp_contact_groups_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_contact_groups
    ADD CONSTRAINT whatsapp_contact_groups_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_contacts whatsapp_contacts_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_contacts
    ADD CONSTRAINT whatsapp_contacts_id_workspace_id_key UNIQUE (id, workspace_id);


--
-- Name: whatsapp_contacts whatsapp_contacts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_contacts
    ADD CONSTRAINT whatsapp_contacts_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_contacts whatsapp_contacts_user_id_phone_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_contacts
    ADD CONSTRAINT whatsapp_contacts_user_id_phone_number_key UNIQUE (user_id, phone_number);


--
-- Name: whatsapp_conversation_assignments whatsapp_conversation_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_conversation_assignments
    ADD CONSTRAINT whatsapp_conversation_assignments_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_conversation_label_assignments whatsapp_conversation_label_assign_conversation_id_label_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_conversation_label_assignments
    ADD CONSTRAINT whatsapp_conversation_label_assign_conversation_id_label_id_key UNIQUE (conversation_id, label_id);


--
-- Name: whatsapp_conversation_label_assignments whatsapp_conversation_label_assignments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_conversation_label_assignments
    ADD CONSTRAINT whatsapp_conversation_label_assignments_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_conversation_labels whatsapp_conversation_labels_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_conversation_labels
    ADD CONSTRAINT whatsapp_conversation_labels_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_deals whatsapp_deals_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_deals
    ADD CONSTRAINT whatsapp_deals_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_evolution_instances whatsapp_evolution_instances_instance_name_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_evolution_instances
    ADD CONSTRAINT whatsapp_evolution_instances_instance_name_key UNIQUE (instance_name);


--
-- Name: whatsapp_evolution_instances whatsapp_evolution_instances_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_evolution_instances
    ADD CONSTRAINT whatsapp_evolution_instances_pkey PRIMARY KEY (social_account_id);


--
-- Name: whatsapp_message_analytics whatsapp_message_analytics_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_message_analytics
    ADD CONSTRAINT whatsapp_message_analytics_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_message_analytics whatsapp_message_analytics_user_id_social_account_id_date_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_message_analytics
    ADD CONSTRAINT whatsapp_message_analytics_user_id_social_account_id_date_key UNIQUE (user_id, social_account_id, date);


--
-- Name: whatsapp_message_flags whatsapp_message_flags_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_message_flags
    ADD CONSTRAINT whatsapp_message_flags_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_message_flags whatsapp_message_flags_user_id_message_row_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_message_flags
    ADD CONSTRAINT whatsapp_message_flags_user_id_message_row_id_key UNIQUE (user_id, message_row_id);


--
-- Name: whatsapp_message_templates whatsapp_message_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_message_templates
    ADD CONSTRAINT whatsapp_message_templates_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_messages whatsapp_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_messages
    ADD CONSTRAINT whatsapp_messages_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_pipeline_stages whatsapp_pipeline_stages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_pipeline_stages
    ADD CONSTRAINT whatsapp_pipeline_stages_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_pipelines whatsapp_pipelines_id_workspace_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_pipelines
    ADD CONSTRAINT whatsapp_pipelines_id_workspace_id_key UNIQUE (id, workspace_id);


--
-- Name: whatsapp_pipelines whatsapp_pipelines_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_pipelines
    ADD CONSTRAINT whatsapp_pipelines_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_quick_replies whatsapp_quick_replies_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_quick_replies
    ADD CONSTRAINT whatsapp_quick_replies_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_quick_reply_usage whatsapp_quick_reply_usage_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_quick_reply_usage
    ADD CONSTRAINT whatsapp_quick_reply_usage_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_scheduled_messages whatsapp_scheduled_messages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_scheduled_messages
    ADD CONSTRAINT whatsapp_scheduled_messages_pkey PRIMARY KEY (id);


--
-- Name: whatsapp_pipeline_stages whatsapp_stages_id_pipeline_workspace_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_pipeline_stages
    ADD CONSTRAINT whatsapp_stages_id_pipeline_workspace_key UNIQUE (id, pipeline_id, workspace_id);


--
-- Name: whatsapp_pipeline_stages whatsapp_stages_pipeline_position_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_pipeline_stages
    ADD CONSTRAINT whatsapp_stages_pipeline_position_key UNIQUE (pipeline_id, "position");


--
-- Name: whatsapp_webhooks whatsapp_webhooks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_webhooks
    ADD CONSTRAINT whatsapp_webhooks_pkey PRIMARY KEY (id);


--
-- Name: workflow_comments workflow_comments_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_comments
    ADD CONSTRAINT workflow_comments_pkey PRIMARY KEY (id);


--
-- Name: workflow_executions workflow_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_executions
    ADD CONSTRAINT workflow_executions_pkey PRIMARY KEY (id);


--
-- Name: workflow_schedules workflow_schedules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_schedules
    ADD CONSTRAINT workflow_schedules_pkey PRIMARY KEY (id);


--
-- Name: workflow_templates workflow_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_templates
    ADD CONSTRAINT workflow_templates_pkey PRIMARY KEY (id);


--
-- Name: workflow_versions workflow_versions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_versions
    ADD CONSTRAINT workflow_versions_pkey PRIMARY KEY (id);


--
-- Name: workflow_versions workflow_versions_workflow_id_version_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_versions
    ADD CONSTRAINT workflow_versions_workflow_id_version_number_key UNIQUE (workflow_id, version_number);


--
-- Name: workflow_webhooks workflow_webhooks_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_webhooks
    ADD CONSTRAINT workflow_webhooks_pkey PRIMARY KEY (id);


--
-- Name: workflow_webhooks workflow_webhooks_webhook_token_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_webhooks
    ADD CONSTRAINT workflow_webhooks_webhook_token_key UNIQUE (webhook_token);


--
-- Name: workflows workflows_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflows
    ADD CONSTRAINT workflows_pkey PRIMARY KEY (id);


--
-- Name: workspace_invitations workspace_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_pkey PRIMARY KEY (id);


--
-- Name: workspace_invitations workspace_invitations_token_hash_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_token_hash_key UNIQUE (token_hash);


--
-- Name: workspace_members workspace_members_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_pkey PRIMARY KEY (id);


--
-- Name: workspace_members workspace_members_workspace_user_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_workspace_user_key UNIQUE (workspace_id, user_id);


--
-- Name: workspaces workspaces_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_pkey PRIMARY KEY (id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: messages_2026_08_27 messages_2026_08_27_pkey; Type: CONSTRAINT; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages_2026_08_27
    ADD CONSTRAINT messages_2026_08_27_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: messages_2026_08_28 messages_2026_08_28_pkey; Type: CONSTRAINT; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages_2026_08_28
    ADD CONSTRAINT messages_2026_08_28_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: messages_2026_08_29 messages_2026_08_29_pkey; Type: CONSTRAINT; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages_2026_08_29
    ADD CONSTRAINT messages_2026_08_29_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: messages_2026_08_30 messages_2026_08_30_pkey; Type: CONSTRAINT; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages_2026_08_30
    ADD CONSTRAINT messages_2026_08_30_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: messages_2026_08_31 messages_2026_08_31_pkey; Type: CONSTRAINT; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages_2026_08_31
    ADD CONSTRAINT messages_2026_08_31_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: messages_2026_09_01 messages_2026_09_01_pkey; Type: CONSTRAINT; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages_2026_09_01
    ADD CONSTRAINT messages_2026_09_01_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: messages_2026_09_02 messages_2026_09_02_pkey; Type: CONSTRAINT; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.messages_2026_09_02
    ADD CONSTRAINT messages_2026_09_02_pkey PRIMARY KEY (id, inserted_at);


--
-- Name: subscription pk_subscription; Type: CONSTRAINT; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.subscription
    ADD CONSTRAINT pk_subscription PRIMARY KEY (id);


--
-- Name: schema_migrations schema_migrations_pkey; Type: CONSTRAINT; Schema: realtime; Owner: -
--

ALTER TABLE ONLY realtime.schema_migrations
    ADD CONSTRAINT schema_migrations_pkey PRIMARY KEY (version);


--
-- Name: buckets_analytics buckets_analytics_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.buckets_analytics
    ADD CONSTRAINT buckets_analytics_pkey PRIMARY KEY (id);


--
-- Name: buckets buckets_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.buckets
    ADD CONSTRAINT buckets_pkey PRIMARY KEY (id);


--
-- Name: buckets_vectors buckets_vectors_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.buckets_vectors
    ADD CONSTRAINT buckets_vectors_pkey PRIMARY KEY (id);


--
-- Name: migrations migrations_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.migrations
    ADD CONSTRAINT migrations_pkey PRIMARY KEY (id);


--
-- Name: objects objects_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.objects
    ADD CONSTRAINT objects_pkey PRIMARY KEY (id);


--
-- Name: prefixes prefixes_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.prefixes
    ADD CONSTRAINT prefixes_pkey PRIMARY KEY (bucket_id, level, name);


--
-- Name: s3_multipart_uploads_parts s3_multipart_uploads_parts_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.s3_multipart_uploads_parts
    ADD CONSTRAINT s3_multipart_uploads_parts_pkey PRIMARY KEY (id);


--
-- Name: s3_multipart_uploads s3_multipart_uploads_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.s3_multipart_uploads
    ADD CONSTRAINT s3_multipart_uploads_pkey PRIMARY KEY (id);


--
-- Name: vector_indexes vector_indexes_pkey; Type: CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.vector_indexes
    ADD CONSTRAINT vector_indexes_pkey PRIMARY KEY (id);


--
-- Name: audit_logs_instance_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX audit_logs_instance_id_idx ON auth.audit_log_entries USING btree (instance_id);


--
-- Name: confirmation_token_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX confirmation_token_idx ON auth.users USING btree (confirmation_token) WHERE ((confirmation_token)::text !~ '^[0-9 ]*$'::text);


--
-- Name: email_change_token_current_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX email_change_token_current_idx ON auth.users USING btree (email_change_token_current) WHERE ((email_change_token_current)::text !~ '^[0-9 ]*$'::text);


--
-- Name: email_change_token_new_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX email_change_token_new_idx ON auth.users USING btree (email_change_token_new) WHERE ((email_change_token_new)::text !~ '^[0-9 ]*$'::text);


--
-- Name: factor_id_created_at_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX factor_id_created_at_idx ON auth.mfa_factors USING btree (user_id, created_at);


--
-- Name: flow_state_created_at_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX flow_state_created_at_idx ON auth.flow_state USING btree (created_at DESC);


--
-- Name: identities_email_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX identities_email_idx ON auth.identities USING btree (email text_pattern_ops);


--
-- Name: INDEX identities_email_idx; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON INDEX auth.identities_email_idx IS 'Auth: Ensures indexed queries on the email column';


--
-- Name: identities_user_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX identities_user_id_idx ON auth.identities USING btree (user_id);


--
-- Name: idx_auth_code; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_auth_code ON auth.flow_state USING btree (auth_code);


--
-- Name: idx_user_id_auth_method; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX idx_user_id_auth_method ON auth.flow_state USING btree (user_id, authentication_method);


--
-- Name: mfa_challenge_created_at_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX mfa_challenge_created_at_idx ON auth.mfa_challenges USING btree (created_at DESC);


--
-- Name: mfa_factors_user_friendly_name_unique; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX mfa_factors_user_friendly_name_unique ON auth.mfa_factors USING btree (friendly_name, user_id) WHERE (TRIM(BOTH FROM friendly_name) <> ''::text);


--
-- Name: mfa_factors_user_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX mfa_factors_user_id_idx ON auth.mfa_factors USING btree (user_id);


--
-- Name: one_time_tokens_relates_to_hash_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX one_time_tokens_relates_to_hash_idx ON auth.one_time_tokens USING hash (relates_to);


--
-- Name: one_time_tokens_token_hash_hash_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX one_time_tokens_token_hash_hash_idx ON auth.one_time_tokens USING hash (token_hash);


--
-- Name: one_time_tokens_user_id_token_type_key; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX one_time_tokens_user_id_token_type_key ON auth.one_time_tokens USING btree (user_id, token_type);


--
-- Name: reauthentication_token_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX reauthentication_token_idx ON auth.users USING btree (reauthentication_token) WHERE ((reauthentication_token)::text !~ '^[0-9 ]*$'::text);


--
-- Name: recovery_token_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX recovery_token_idx ON auth.users USING btree (recovery_token) WHERE ((recovery_token)::text !~ '^[0-9 ]*$'::text);


--
-- Name: refresh_tokens_instance_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX refresh_tokens_instance_id_idx ON auth.refresh_tokens USING btree (instance_id);


--
-- Name: refresh_tokens_instance_id_user_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX refresh_tokens_instance_id_user_id_idx ON auth.refresh_tokens USING btree (instance_id, user_id);


--
-- Name: refresh_tokens_parent_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX refresh_tokens_parent_idx ON auth.refresh_tokens USING btree (parent);


--
-- Name: refresh_tokens_session_id_revoked_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX refresh_tokens_session_id_revoked_idx ON auth.refresh_tokens USING btree (session_id, revoked);


--
-- Name: refresh_tokens_updated_at_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX refresh_tokens_updated_at_idx ON auth.refresh_tokens USING btree (updated_at DESC);


--
-- Name: saml_providers_sso_provider_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX saml_providers_sso_provider_id_idx ON auth.saml_providers USING btree (sso_provider_id);


--
-- Name: saml_relay_states_created_at_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX saml_relay_states_created_at_idx ON auth.saml_relay_states USING btree (created_at DESC);


--
-- Name: saml_relay_states_for_email_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX saml_relay_states_for_email_idx ON auth.saml_relay_states USING btree (for_email);


--
-- Name: saml_relay_states_sso_provider_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX saml_relay_states_sso_provider_id_idx ON auth.saml_relay_states USING btree (sso_provider_id);


--
-- Name: sessions_not_after_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX sessions_not_after_idx ON auth.sessions USING btree (not_after DESC);


--
-- Name: sessions_user_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX sessions_user_id_idx ON auth.sessions USING btree (user_id);


--
-- Name: sso_domains_domain_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX sso_domains_domain_idx ON auth.sso_domains USING btree (lower(domain));


--
-- Name: sso_domains_sso_provider_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX sso_domains_sso_provider_id_idx ON auth.sso_domains USING btree (sso_provider_id);


--
-- Name: sso_providers_resource_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX sso_providers_resource_id_idx ON auth.sso_providers USING btree (lower(resource_id));


--
-- Name: unique_phone_factor_per_user; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX unique_phone_factor_per_user ON auth.mfa_factors USING btree (user_id, phone);


--
-- Name: user_id_created_at_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX user_id_created_at_idx ON auth.sessions USING btree (user_id, created_at);


--
-- Name: users_email_partial_key; Type: INDEX; Schema: auth; Owner: -
--

CREATE UNIQUE INDEX users_email_partial_key ON auth.users USING btree (email) WHERE (is_sso_user = false);


--
-- Name: INDEX users_email_partial_key; Type: COMMENT; Schema: auth; Owner: -
--

COMMENT ON INDEX auth.users_email_partial_key IS 'Auth: A partial unique index that applies only when is_sso_user is false';


--
-- Name: users_instance_id_email_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX users_instance_id_email_idx ON auth.users USING btree (instance_id, lower((email)::text));


--
-- Name: users_instance_id_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX users_instance_id_idx ON auth.users USING btree (instance_id);


--
-- Name: users_is_anonymous_idx; Type: INDEX; Schema: auth; Owner: -
--

CREATE INDEX users_is_anonymous_idx ON auth.users USING btree (is_anonymous);


--
-- Name: ai_agent_configs_social_account_id_key; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ai_agent_configs_social_account_id_key ON public.ai_agent_configs USING btree (social_account_id);


--
-- Name: ai_knowledge_source_accounts_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX ai_knowledge_source_accounts_account_idx ON public.ai_knowledge_source_accounts USING btree (social_account_id, source_id);


--
-- Name: app_settings_n8n_webhook_key_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX app_settings_n8n_webhook_key_idx ON public.app_settings USING btree (key) WHERE (key ~~ 'n8n\_webhook\_%'::text);


--
-- Name: backup_codes_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX backup_codes_user_id_idx ON public.backup_codes USING btree (user_id);


--
-- Name: brand_search_history_uniq; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX brand_search_history_uniq ON public.brand_search_history USING btree (user_id, platform, scope, lower(query));


--
-- Name: brand_search_history_user_scope_recent; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX brand_search_history_user_scope_recent ON public.brand_search_history USING btree (user_id, platform, scope, last_used_at DESC);


--
-- Name: idx_active_assignment; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_active_assignment ON public.whatsapp_conversation_assignments USING btree (workspace_id, conversation_id) WHERE (unassigned_at IS NULL);


--
-- Name: idx_admin_audit_log_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_audit_log_admin_id ON public.admin_audit_log USING btree (admin_id);


--
-- Name: idx_admin_audit_log_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_audit_log_created_at ON public.admin_audit_log USING btree (created_at DESC);


--
-- Name: idx_admin_audit_log_resource_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_audit_log_resource_type ON public.admin_audit_log USING btree (resource_type);


--
-- Name: idx_admin_inbox_messages_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_inbox_messages_created_at ON public.admin_inbox_messages USING btree (created_at DESC);


--
-- Name: idx_admin_inbox_messages_direction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_inbox_messages_direction ON public.admin_inbox_messages USING btree (direction);


--
-- Name: idx_admin_inbox_messages_from_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_inbox_messages_from_email ON public.admin_inbox_messages USING btree (from_email);


--
-- Name: idx_admin_inbox_messages_is_read; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_inbox_messages_is_read ON public.admin_inbox_messages USING btree (is_read) WHERE (is_read = false);


--
-- Name: idx_admin_inbox_messages_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_inbox_messages_status ON public.admin_inbox_messages USING btree (status);


--
-- Name: idx_admin_inbox_messages_thread_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_inbox_messages_thread_id ON public.admin_inbox_messages USING btree (thread_id) WHERE (thread_id IS NOT NULL);


--
-- Name: idx_admin_inbox_messages_to_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_admin_inbox_messages_to_email ON public.admin_inbox_messages USING btree (to_email);


--
-- Name: idx_ai_agent_allowed_models_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_agent_allowed_models_active ON public.ai_agent_allowed_models USING btree (is_active, sort_order);


--
-- Name: idx_ai_agent_logs_idempotency_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_agent_logs_idempotency_key ON public.ai_agent_logs USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);


--
-- Name: idx_ai_agent_logs_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_agent_logs_user_created ON public.ai_agent_logs USING btree (user_id, created_at DESC);


--
-- Name: idx_ai_generation_jobs_modality_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_generation_jobs_modality_created ON public.ai_generation_jobs USING btree (modality, created_at DESC);


--
-- Name: idx_ai_generation_jobs_provider_job; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_generation_jobs_provider_job ON public.ai_generation_jobs USING btree (provider_job_id);


--
-- Name: idx_ai_generation_jobs_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_generation_jobs_user_created ON public.ai_generation_jobs USING btree (user_id, created_at DESC);


--
-- Name: idx_ai_knowledge_chunks_embedding; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_knowledge_chunks_embedding ON public.ai_knowledge_chunks USING hnsw (embedding public.vector_cosine_ops);


--
-- Name: idx_ai_knowledge_chunks_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_knowledge_chunks_user_id ON public.ai_knowledge_chunks USING btree (user_id);


--
-- Name: idx_ai_knowledge_entities_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_knowledge_entities_user_id ON public.ai_knowledge_entities USING btree (user_id);


--
-- Name: idx_ai_knowledge_relations_source_chunk; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_knowledge_relations_source_chunk ON public.ai_knowledge_relations USING btree (source_chunk_id);


--
-- Name: idx_ai_knowledge_relations_source_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_knowledge_relations_source_entity ON public.ai_knowledge_relations USING btree (source_entity_id);


--
-- Name: idx_ai_knowledge_relations_target_entity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_knowledge_relations_target_entity ON public.ai_knowledge_relations USING btree (target_entity_id);


--
-- Name: idx_ai_knowledge_relations_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_knowledge_relations_user_id ON public.ai_knowledge_relations USING btree (user_id);


--
-- Name: idx_ai_thread_messages_thread_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ai_thread_messages_thread_created ON public.ai_thread_messages USING btree (thread_id, created_at);


--
-- Name: idx_alert_history_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_alert_history_created ON public.observability_alert_history USING btree (created_at DESC);


--
-- Name: idx_api_logs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_logs_created_at ON public.api_logs USING btree (created_at DESC);


--
-- Name: idx_api_logs_user_endpoint; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_api_logs_user_endpoint ON public.api_logs USING btree (user_id, endpoint, created_at DESC);


--
-- Name: idx_app_credentials_platform; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_app_credentials_platform ON public.app_credentials USING btree (platform);


--
-- Name: idx_ar_usage_rule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ar_usage_rule ON public.whatsapp_auto_reply_usage USING btree (auto_reply_rule_id);


--
-- Name: idx_ar_usage_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ar_usage_user ON public.whatsapp_auto_reply_usage USING btree (user_id);


--
-- Name: idx_audit_log_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_log_created_at ON public.feature_flag_audit_log USING btree (created_at DESC);


--
-- Name: idx_audit_log_feature_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_audit_log_feature_key ON public.feature_flag_audit_log USING btree (feature_key);


--
-- Name: idx_automation_dispatch_log_user_platform; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_automation_dispatch_log_user_platform ON public.automation_dispatch_log USING btree (user_id, platform, created_at DESC);


--
-- Name: idx_blog_posts_scheduled_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blog_posts_scheduled_at ON public.blog_posts USING btree (scheduled_at) WHERE ((scheduled_at IS NOT NULL) AND (status = 'scheduled'::text));


--
-- Name: idx_brand_scrape_cache_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brand_scrape_cache_expires ON public.brand_scrape_cache USING btree (expires_at);


--
-- Name: idx_brand_scrape_cache_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brand_scrape_cache_key ON public.brand_scrape_cache USING btree (cache_key);


--
-- Name: idx_brand_sessions_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brand_sessions_user ON public.brand_scrape_sessions USING btree (user_id);


--
-- Name: idx_caption_history_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_caption_history_user_created ON public.caption_history USING btree (user_id, created_at DESC);


--
-- Name: idx_comment_inbox_post; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_comment_inbox_post ON public.comment_inbox_cache USING btree (post_id);


--
-- Name: idx_comment_inbox_user_platform; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_comment_inbox_user_platform ON public.comment_inbox_cache USING btree (user_id, platform);


--
-- Name: idx_coupon_redemptions_coupon_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coupon_redemptions_coupon_id ON public.coupon_redemptions USING btree (coupon_id);


--
-- Name: idx_coupon_redemptions_unique; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_coupon_redemptions_unique ON public.coupon_redemptions USING btree (coupon_id, user_id, subscription_id);


--
-- Name: idx_coupon_redemptions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coupon_redemptions_user_id ON public.coupon_redemptions USING btree (user_id);


--
-- Name: idx_coupons_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coupons_active ON public.coupons USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_coupons_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coupons_code ON public.coupons USING btree (code);


--
-- Name: idx_coupons_validity; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_coupons_validity ON public.coupons USING btree (valid_from, expires_at);


--
-- Name: idx_credit_transactions_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_credit_transactions_created_at ON public.credit_transactions USING btree (created_at DESC);


--
-- Name: idx_credit_transactions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_credit_transactions_user_id ON public.credit_transactions USING btree (user_id);


--
-- Name: idx_deployment_logs_started_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deployment_logs_started_at ON public.deployment_logs USING btree (started_at DESC);


--
-- Name: idx_deployment_logs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_deployment_logs_status ON public.deployment_logs USING btree (status);


--
-- Name: idx_edge_function_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edge_function_name ON public.edge_function_status USING btree (function_name, checked_at DESC);


--
-- Name: idx_edge_function_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_edge_function_status ON public.edge_function_status USING btree (status);


--
-- Name: idx_email_drafts_admin_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_drafts_admin_id ON public.email_drafts USING btree (admin_id);


--
-- Name: idx_email_drafts_updated_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_drafts_updated_at ON public.email_drafts USING btree (updated_at DESC);


--
-- Name: idx_email_log_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_log_created_at ON public.email_log USING btree (created_at DESC);


--
-- Name: idx_email_log_recipient; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_log_recipient ON public.email_log USING btree (recipient_email);


--
-- Name: idx_email_log_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_log_status ON public.email_log USING btree (status);


--
-- Name: idx_email_log_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_email_log_template ON public.email_log USING btree (template_id);


--
-- Name: idx_health_snapshots_captured; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_health_snapshots_captured ON public.observability_health_snapshots USING btree (captured_at DESC);


--
-- Name: idx_image_reference_presets_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_image_reference_presets_user_id ON public.image_reference_presets USING btree (user_id);


--
-- Name: idx_label_assignments_conv; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_label_assignments_conv ON public.whatsapp_conversation_label_assignments USING btree (conversation_id);


--
-- Name: idx_label_assignments_label; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_label_assignments_label ON public.whatsapp_conversation_label_assignments USING btree (label_id);


--
-- Name: idx_launch_checklist_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_launch_checklist_category ON public.launch_checklist USING btree (category);


--
-- Name: idx_launch_checklist_completed; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_launch_checklist_completed ON public.launch_checklist USING btree (is_completed);


--
-- Name: idx_launch_checklist_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_launch_checklist_order ON public.launch_checklist USING btree (sort_order);


--
-- Name: idx_lead_forms_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_lead_forms_user ON public.lead_forms USING btree (user_id);


--
-- Name: idx_leads_form; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leads_form ON public.leads USING btree (form_id);


--
-- Name: idx_leads_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leads_status ON public.leads USING btree (status);


--
-- Name: idx_leads_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_leads_user ON public.leads USING btree (user_id);


--
-- Name: idx_mcp_oauth_auth_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_oauth_auth_code ON public.mcp_oauth_authorizations USING btree (code);


--
-- Name: idx_mcp_oauth_auth_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_oauth_auth_expires ON public.mcp_oauth_authorizations USING btree (expires_at);


--
-- Name: idx_mcp_oauth_auth_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_oauth_auth_user ON public.mcp_oauth_authorizations USING btree (user_id);


--
-- Name: idx_mcp_oauth_tokens_hash; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_oauth_tokens_hash ON public.mcp_oauth_tokens USING btree (token_hash);


--
-- Name: idx_mcp_oauth_tokens_refresh; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_oauth_tokens_refresh ON public.mcp_oauth_tokens USING btree (refresh_token_hash);


--
-- Name: idx_mcp_oauth_tokens_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_mcp_oauth_tokens_user ON public.mcp_oauth_tokens USING btree (user_id);


--
-- Name: idx_media_files_cloudinary_public_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_files_cloudinary_public_id ON public.media_files USING btree (cloudinary_public_id) WHERE (cloudinary_public_id IS NOT NULL);


--
-- Name: idx_media_files_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_files_created_at ON public.media_files USING btree (created_at DESC);


--
-- Name: idx_media_files_folder; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_files_folder ON public.media_files USING btree (folder_path);


--
-- Name: idx_media_files_folder_path; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_files_folder_path ON public.media_files USING btree (folder_path);


--
-- Name: idx_media_files_platforms; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_files_platforms ON public.media_files USING gin (platforms);


--
-- Name: idx_media_files_social_account_ids; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_files_social_account_ids ON public.media_files USING gin (social_account_ids);


--
-- Name: idx_media_files_upload_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_files_upload_date ON public.media_files USING btree (upload_date);


--
-- Name: idx_media_files_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_files_user_id ON public.media_files USING btree (user_id);


--
-- Name: idx_media_folders_user_path; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_folders_user_path ON public.media_folders USING btree (user_id, parent_path);


--
-- Name: idx_media_operations_history_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_operations_history_created_at ON public.media_operations_history USING btree (created_at DESC);


--
-- Name: idx_media_operations_history_operation_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_operations_history_operation_type ON public.media_operations_history USING btree (operation_type);


--
-- Name: idx_media_operations_history_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_operations_history_status ON public.media_operations_history USING btree (status);


--
-- Name: idx_media_operations_history_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_operations_history_user_id ON public.media_operations_history USING btree (user_id);


--
-- Name: idx_media_understanding_sender_usage_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_understanding_sender_usage_date ON public.media_understanding_sender_usage USING btree (usage_date);


--
-- Name: idx_media_understanding_usage_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_media_understanding_usage_date ON public.media_understanding_usage USING btree (usage_date);


--
-- Name: idx_messaging_cache_social_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messaging_cache_social_account ON public.messaging_cache USING btree (social_account_id);


--
-- Name: idx_messaging_cache_user_participant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messaging_cache_user_participant ON public.messaging_cache USING btree (user_id, participant_id);


--
-- Name: idx_messaging_cache_user_platform; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messaging_cache_user_platform ON public.messaging_cache USING btree (user_id, platform);


--
-- Name: idx_messenger_ar_usage_rule; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messenger_ar_usage_rule ON public.messenger_auto_reply_usage USING btree (auto_reply_rule_id);


--
-- Name: idx_messenger_ar_usage_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_messenger_ar_usage_user ON public.messenger_auto_reply_usage USING btree (user_id);


--
-- Name: idx_metrics_type_name; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_metrics_type_name ON public.observability_metrics USING btree (metric_type, metric_name);


--
-- Name: idx_metrics_window; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_metrics_window ON public.observability_metrics USING btree (window_start, window_end);


--
-- Name: idx_node_execution_logs_execution_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_node_execution_logs_execution_id ON public.node_execution_logs USING btree (execution_id);


--
-- Name: idx_node_execution_logs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_node_execution_logs_status ON public.node_execution_logs USING btree (status);


--
-- Name: idx_notification_reads_notification; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_reads_notification ON public.notification_reads USING btree (notification_id);


--
-- Name: idx_notification_reads_unread; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_reads_unread ON public.notification_reads USING btree (user_id) WHERE (dismissed_at IS NULL);


--
-- Name: idx_notification_reads_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notification_reads_user ON public.notification_reads USING btree (user_id, read_at DESC);


--
-- Name: idx_oauth_pending_fb_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_pending_fb_expires ON public.oauth_pending_facebook_selections USING btree (expires_at);


--
-- Name: idx_oauth_pending_ig_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_pending_ig_expires ON public.oauth_pending_instagram_selections USING btree (expires_at);


--
-- Name: idx_oauth_states_expires_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_oauth_states_expires_at ON public.oauth_states USING btree (expires_at);


--
-- Name: idx_password_reset_otps_email_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_password_reset_otps_email_created_at ON public.password_reset_otps USING btree (email, created_at DESC);


--
-- Name: idx_pending_agent_replies_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pending_agent_replies_account ON public.pending_agent_replies USING btree (social_account_id);


--
-- Name: idx_pending_agent_replies_claimable; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pending_agent_replies_claimable ON public.pending_agent_replies USING btree (lease_expires_at NULLS FIRST, inbound_at, ingress_seq) WHERE (status = ANY (ARRAY['pending'::text, 'running'::text, 'ready_to_send'::text, 'sending'::text]));


--
-- Name: idx_pending_agent_replies_conversation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pending_agent_replies_conversation ON public.pending_agent_replies USING btree (conversation_id, inbound_at, ingress_seq);


--
-- Name: idx_pending_agent_replies_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_pending_agent_replies_user ON public.pending_agent_replies USING btree (user_id);


--
-- Name: idx_platform_posts_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_posts_created_at ON public.platform_posts USING btree (created_at DESC);


--
-- Name: idx_platform_posts_platform; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_posts_platform ON public.platform_posts USING btree (platform);


--
-- Name: idx_platform_posts_post_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_posts_post_id ON public.platform_posts USING btree (post_id);


--
-- Name: idx_platform_posts_post_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_posts_post_status ON public.platform_posts USING btree (post_id, status);


--
-- Name: idx_platform_posts_social_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_posts_social_account ON public.platform_posts USING btree (social_account_id);


--
-- Name: idx_platform_posts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_platform_posts_status ON public.platform_posts USING btree (status);


--
-- Name: idx_posts_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_created_at ON public.posts USING btree (created_at DESC);


--
-- Name: idx_posts_scheduled_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_scheduled_at ON public.posts USING btree (scheduled_at) WHERE (scheduled_at IS NOT NULL);


--
-- Name: idx_posts_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_source ON public.posts USING btree (source);


--
-- Name: idx_posts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_status ON public.posts USING btree (status);


--
-- Name: idx_posts_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_user_created ON public.posts USING btree (user_id, created_at DESC);


--
-- Name: idx_posts_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_user_id ON public.posts USING btree (user_id);


--
-- Name: idx_posts_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_posts_user_status ON public.posts USING btree (user_id, status);


--
-- Name: idx_profiles_admin_notified_pending; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_admin_notified_pending ON public.profiles USING btree (created_at) WHERE (admin_notified_at IS NULL);


--
-- Name: idx_profiles_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_created_at ON public.profiles USING btree (created_at DESC);


--
-- Name: idx_profiles_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_profiles_email ON public.profiles USING btree (email);


--
-- Name: idx_qr_usage_qr_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qr_usage_qr_id ON public.whatsapp_quick_reply_usage USING btree (quick_reply_id);


--
-- Name: idx_qr_usage_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_qr_usage_user ON public.whatsapp_quick_reply_usage USING btree (user_id);


--
-- Name: idx_rate_limit_buckets_expired; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rate_limit_buckets_expired ON public.rate_limit_buckets USING btree (expires_at);


--
-- Name: idx_rate_limit_settings_endpoint; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_rate_limit_settings_endpoint ON public.rate_limit_settings USING btree (endpoint);


--
-- Name: idx_referrals_referral_code; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_referrals_referral_code ON public.referrals USING btree (referral_code);


--
-- Name: idx_referrals_referred_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_referrals_referred_user_id ON public.referrals USING btree (referred_user_id);


--
-- Name: idx_referrals_referrer_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_referrals_referrer_id ON public.referrals USING btree (referrer_id);


--
-- Name: idx_referrals_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_referrals_status ON public.referrals USING btree (status);


--
-- Name: idx_reset_otps_email; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reset_otps_email ON public.password_reset_otps USING btree (email);


--
-- Name: idx_reset_otps_email_purpose; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reset_otps_email_purpose ON public.password_reset_otps USING btree (email, purpose);


--
-- Name: idx_reset_otps_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_reset_otps_expires ON public.password_reset_otps USING btree (expires_at);


--
-- Name: idx_scheduled_msgs_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scheduled_msgs_status ON public.whatsapp_scheduled_messages USING btree (status, scheduled_at) WHERE (status = 'pending'::text);


--
-- Name: idx_scheduled_msgs_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_scheduled_msgs_user ON public.whatsapp_scheduled_messages USING btree (user_id);


--
-- Name: idx_schedules_scheduled_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedules_scheduled_at ON public.feature_flag_schedules USING btree (scheduled_at) WHERE (status = 'pending'::text);


--
-- Name: idx_schedules_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_schedules_status ON public.feature_flag_schedules USING btree (status) WHERE (status = 'pending'::text);


--
-- Name: idx_social_accounts_failure_count; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_social_accounts_failure_count ON public.social_accounts USING btree (failure_count) WHERE (failure_count > 0);


--
-- Name: idx_social_accounts_is_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_social_accounts_is_active ON public.social_accounts USING btree (is_active) WHERE (is_active = true);


--
-- Name: idx_social_accounts_last_refresh_attempt; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_social_accounts_last_refresh_attempt ON public.social_accounts USING btree (last_refresh_attempt_at) WHERE ((is_active = true) AND (needs_reauth = false));


--
-- Name: idx_social_accounts_needs_reauth; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_social_accounts_needs_reauth ON public.social_accounts USING btree (needs_reauth) WHERE (needs_reauth = true);


--
-- Name: idx_social_accounts_platform; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_social_accounts_platform ON public.social_accounts USING btree (platform);


--
-- Name: idx_social_accounts_profile; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_social_accounts_profile ON public.social_accounts USING btree (social_profile_id) WHERE (social_profile_id IS NOT NULL);


--
-- Name: idx_social_accounts_token_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_social_accounts_token_expires ON public.social_accounts USING btree (token_expires_at) WHERE (token_expires_at IS NOT NULL);


--
-- Name: idx_social_accounts_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_social_accounts_user_id ON public.social_accounts USING btree (user_id);


--
-- Name: idx_social_accounts_user_platform; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_social_accounts_user_platform ON public.social_accounts USING btree (user_id, platform);


--
-- Name: idx_social_profiles_share_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_social_profiles_share_token ON public.social_profiles USING btree (share_token) WHERE (is_public = true);


--
-- Name: idx_stripe_webhook_events_received_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_stripe_webhook_events_received_at ON public.stripe_webhook_events USING btree (received_at DESC);


--
-- Name: idx_support_tickets_assigned_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_tickets_assigned_to ON public.support_tickets USING btree (assigned_to);


--
-- Name: idx_support_tickets_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_tickets_created_at ON public.support_tickets USING btree (created_at DESC);


--
-- Name: idx_support_tickets_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_tickets_status ON public.support_tickets USING btree (status);


--
-- Name: idx_support_tickets_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_tickets_user ON public.support_tickets USING btree (user_id, created_at DESC);


--
-- Name: idx_support_tickets_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_support_tickets_user_id ON public.support_tickets USING btree (user_id);


--
-- Name: idx_system_health_captured_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_health_captured_at ON public.system_health_snapshots USING btree (captured_at DESC);


--
-- Name: idx_system_health_score; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_health_score ON public.system_health_snapshots USING btree (health_score);


--
-- Name: idx_system_health_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_health_status ON public.system_health_snapshots USING btree (health_status);


--
-- Name: idx_system_logs_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_logs_category ON public.system_logs USING btree (category);


--
-- Name: idx_system_logs_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_logs_created_at ON public.system_logs USING btree (created_at DESC);


--
-- Name: idx_system_logs_level; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_logs_level ON public.system_logs USING btree (level);


--
-- Name: idx_system_logs_source; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_logs_source ON public.system_logs USING btree (source);


--
-- Name: idx_system_notifications_active; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_notifications_active ON public.system_notifications USING btree (expires_at, published_at);


--
-- Name: idx_system_notifications_published; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_notifications_published ON public.system_notifications USING btree (published_at DESC);


--
-- Name: idx_system_notifications_target; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_notifications_target ON public.system_notifications USING btree (target_type);


--
-- Name: idx_system_notifications_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_system_notifications_type ON public.system_notifications USING btree (type);


--
-- Name: idx_threads_mentions_assigned_to; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_threads_mentions_assigned_to ON public.threads_mentions USING btree (assigned_to) WHERE (assigned_to IS NOT NULL);


--
-- Name: idx_threads_mentions_has_reply; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_threads_mentions_has_reply ON public.threads_mentions USING btree (has_reply);


--
-- Name: idx_threads_mentions_labels; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_threads_mentions_labels ON public.threads_mentions USING gin (labels);


--
-- Name: idx_threads_mentions_mentioned_at_desc; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_threads_mentions_mentioned_at_desc ON public.threads_mentions USING btree (mentioned_at DESC);


--
-- Name: idx_threads_mentions_sentiment; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_threads_mentions_sentiment ON public.threads_mentions USING btree (sentiment);


--
-- Name: idx_threads_mentions_social_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_threads_mentions_social_account_id ON public.threads_mentions USING btree (social_account_id);


--
-- Name: idx_threads_mentions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_threads_mentions_status ON public.threads_mentions USING btree (status);


--
-- Name: idx_threads_mentions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_threads_mentions_user_id ON public.threads_mentions USING btree (user_id);


--
-- Name: idx_threads_mentions_user_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_threads_mentions_user_status ON public.threads_mentions USING btree (user_id, status);


--
-- Name: idx_threads_recent_searches_user_created; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_threads_recent_searches_user_created ON public.threads_recent_searches USING btree (user_id, created_at DESC);


--
-- Name: idx_threads_reply_cache_account_media; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_threads_reply_cache_account_media ON public.threads_reply_cache USING btree (social_account_id, media_id);


--
-- Name: idx_threads_reply_cache_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_threads_reply_cache_user ON public.threads_reply_cache USING btree (user_id);


--
-- Name: idx_ticket_activities_ticket_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_activities_ticket_id ON public.ticket_activities USING btree (ticket_id, created_at DESC);


--
-- Name: idx_ticket_messages_ticket_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_ticket_messages_ticket_id ON public.ticket_messages USING btree (ticket_id, created_at);


--
-- Name: idx_tiktok_cache_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tiktok_cache_account ON public.tiktok_api_analytics_cache USING btree (social_account_id);


--
-- Name: idx_tiktok_cache_expires; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tiktok_cache_expires ON public.tiktok_api_analytics_cache USING btree (expires_at);


--
-- Name: idx_token_refresh_history_account_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_token_refresh_history_account_id ON public.token_refresh_history USING btree (account_id);


--
-- Name: idx_token_refresh_history_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_token_refresh_history_created_at ON public.token_refresh_history USING btree (created_at DESC);


--
-- Name: idx_token_refresh_history_platform; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_token_refresh_history_platform ON public.token_refresh_history USING btree (platform);


--
-- Name: idx_token_refresh_history_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_token_refresh_history_status ON public.token_refresh_history USING btree (status);


--
-- Name: idx_user_ai_model_overrides_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_ai_model_overrides_user_id ON public.user_ai_model_overrides USING btree (user_id);


--
-- Name: idx_user_credits_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_credits_user_id ON public.user_credits USING btree (user_id);


--
-- Name: idx_user_feature_overrides_feature_key; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_feature_overrides_feature_key ON public.user_feature_overrides USING btree (feature_key);


--
-- Name: idx_user_feature_overrides_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_feature_overrides_user_id ON public.user_feature_overrides USING btree (user_id);


--
-- Name: idx_user_rate_limits_endpoint; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_rate_limits_endpoint ON public.user_rate_limits USING btree (endpoint);


--
-- Name: idx_user_rate_limits_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_rate_limits_user_id ON public.user_rate_limits USING btree (user_id);


--
-- Name: idx_user_subscriptions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_subscriptions_status ON public.user_subscriptions USING btree (status);


--
-- Name: idx_user_subscriptions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_user_subscriptions_user_id ON public.user_subscriptions USING btree (user_id);


--
-- Name: idx_video_processing_presets_user_platform; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_video_processing_presets_user_platform ON public.video_processing_presets USING btree (user_id, platform);


--
-- Name: idx_wa_message_flags_pinned; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_wa_message_flags_pinned ON public.whatsapp_message_flags USING btree (user_id, pinned_at) WHERE (pinned_at IS NOT NULL);


--
-- Name: idx_whatsapp_analytics_user_date; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_analytics_user_date ON public.whatsapp_message_analytics USING btree (user_id, date);


--
-- Name: idx_whatsapp_broadcast_recipients_broadcast_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_broadcast_recipients_broadcast_id ON public.whatsapp_broadcast_recipients USING btree (broadcast_id);


--
-- Name: idx_whatsapp_broadcast_recipients_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_broadcast_recipients_status ON public.whatsapp_broadcast_recipients USING btree (status);


--
-- Name: idx_whatsapp_broadcasts_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_broadcasts_status ON public.whatsapp_broadcasts USING btree (status);


--
-- Name: idx_whatsapp_broadcasts_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_broadcasts_user_id ON public.whatsapp_broadcasts USING btree (user_id);


--
-- Name: idx_whatsapp_contacts_phone; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_contacts_phone ON public.whatsapp_contacts USING btree (user_id, phone_number);


--
-- Name: idx_whatsapp_contacts_tags; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_contacts_tags ON public.whatsapp_contacts USING gin (tags);


--
-- Name: idx_whatsapp_contacts_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_contacts_user_id ON public.whatsapp_contacts USING btree (user_id);


--
-- Name: idx_whatsapp_group_members_contact; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_group_members_contact ON public.whatsapp_contact_group_members USING btree (contact_id);


--
-- Name: idx_whatsapp_group_members_group; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_group_members_group ON public.whatsapp_contact_group_members USING btree (group_id);


--
-- Name: idx_whatsapp_messages_account_conv_keyset; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_messages_account_conv_keyset ON public.whatsapp_messages USING btree (social_account_id, conversation_id, "timestamp" DESC, id DESC);


--
-- Name: idx_whatsapp_messages_conversation; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_messages_conversation ON public.whatsapp_messages USING btree (user_id, conversation_id, "timestamp" DESC);


--
-- Name: idx_whatsapp_messages_media_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_messages_media_type ON public.whatsapp_messages USING btree (media_type) WHERE (media_type IS NOT NULL);


--
-- Name: idx_whatsapp_messages_message_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_messages_message_id ON public.whatsapp_messages USING btree (message_id);


--
-- Name: idx_whatsapp_messages_user_message_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_whatsapp_messages_user_message_id ON public.whatsapp_messages USING btree (user_id, message_id);


--
-- Name: idx_whatsapp_templates_account; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_templates_account ON public.whatsapp_message_templates USING btree (social_account_id);


--
-- Name: idx_whatsapp_templates_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_whatsapp_templates_user ON public.whatsapp_message_templates USING btree (user_id);


--
-- Name: idx_workflow_executions_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_executions_created_at ON public.workflow_executions USING btree (created_at DESC);


--
-- Name: idx_workflow_executions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_executions_status ON public.workflow_executions USING btree (status);


--
-- Name: idx_workflow_executions_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_executions_user_id ON public.workflow_executions USING btree (user_id);


--
-- Name: idx_workflow_executions_workflow_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_executions_workflow_id ON public.workflow_executions USING btree (workflow_id);


--
-- Name: idx_workflow_schedules_next_run; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_schedules_next_run ON public.workflow_schedules USING btree (next_run_at) WHERE (is_active = true);


--
-- Name: idx_workflow_schedules_workflow_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_schedules_workflow_id ON public.workflow_schedules USING btree (workflow_id);


--
-- Name: idx_workflow_templates_category; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_templates_category ON public.workflow_templates USING btree (category);


--
-- Name: idx_workflow_templates_is_featured; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_templates_is_featured ON public.workflow_templates USING btree (is_featured) WHERE (is_featured = true);


--
-- Name: idx_workflow_versions_workflow_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_versions_workflow_id ON public.workflow_versions USING btree (workflow_id);


--
-- Name: idx_workflow_webhooks_token; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_webhooks_token ON public.workflow_webhooks USING btree (webhook_token);


--
-- Name: idx_workflow_webhooks_workflow_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflow_webhooks_workflow_id ON public.workflow_webhooks USING btree (workflow_id);


--
-- Name: idx_workflows_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflows_created_at ON public.workflows USING btree (created_at DESC);


--
-- Name: idx_workflows_is_public; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflows_is_public ON public.workflows USING btree (is_public) WHERE (is_public = true);


--
-- Name: idx_workflows_is_template; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflows_is_template ON public.workflows USING btree (is_template) WHERE (is_template = true);


--
-- Name: idx_workflows_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_workflows_user_id ON public.workflows USING btree (user_id);


--
-- Name: media_file_providers_media_file_id_object_version_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX media_file_providers_media_file_id_object_version_idx ON public.media_file_providers USING btree (media_file_id, object_version);


--
-- Name: messaging_cache_workspace_account_last_message_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX messaging_cache_workspace_account_last_message_idx ON public.messaging_cache USING btree (workspace_id, social_account_id, last_message_at DESC);


--
-- Name: partner_api_idempotency_expiry_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX partner_api_idempotency_expiry_idx ON public.partner_api_idempotency USING btree (expires_at);


--
-- Name: partner_api_key_accounts_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX partner_api_key_accounts_account_idx ON public.partner_api_key_accounts USING btree (social_account_id);


--
-- Name: partner_api_keys_hash_active_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX partner_api_keys_hash_active_idx ON public.partner_api_keys USING btree (key_hash) WHERE (revoked_at IS NULL);


--
-- Name: partner_api_keys_workspace_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX partner_api_keys_workspace_idx ON public.partner_api_keys USING btree (workspace_id);


--
-- Name: partner_api_usage_key_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX partner_api_usage_key_time_idx ON public.partner_api_usage USING btree (key_id, created_at DESC);


--
-- Name: partner_api_usage_ws_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX partner_api_usage_ws_time_idx ON public.partner_api_usage USING btree (workspace_id, created_at DESC);


--
-- Name: partner_audit_logs_key_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX partner_audit_logs_key_time_idx ON public.partner_audit_logs USING btree (key_id, created_at DESC);


--
-- Name: partner_audit_logs_ws_time_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX partner_audit_logs_ws_time_idx ON public.partner_audit_logs USING btree (workspace_id, created_at DESC);


--
-- Name: social_accounts_evolution_qr_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX social_accounts_evolution_qr_idx ON public.social_accounts USING btree (user_id, platform) WHERE (connection_mode = 'evolution_qr'::text);


--
-- Name: social_inbox_events_user_account_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX social_inbox_events_user_account_idx ON public.social_inbox_events USING btree (user_id, social_account_id, created_at DESC);


--
-- Name: webhook_unmatched_observations_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX webhook_unmatched_observations_owner_idx ON public.webhook_unmatched_observations USING btree (user_id, observed_on DESC) WHERE (user_id IS NOT NULL);


--
-- Name: webhook_unmatched_observations_recent_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX webhook_unmatched_observations_recent_idx ON public.webhook_unmatched_observations USING btree (observed_on DESC, platform);


--
-- Name: whatsapp_deals_contact_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_deals_contact_id_idx ON public.whatsapp_deals USING btree (contact_id);


--
-- Name: whatsapp_deals_workspace_pipeline_stage_position_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_deals_workspace_pipeline_stage_position_idx ON public.whatsapp_deals USING btree (workspace_id, pipeline_id, stage_id, "position");


--
-- Name: whatsapp_pipeline_stages_pipeline_position_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX whatsapp_pipeline_stages_pipeline_position_idx ON public.whatsapp_pipeline_stages USING btree (pipeline_id, "position");


--
-- Name: whatsapp_pipelines_one_default_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX whatsapp_pipelines_one_default_idx ON public.whatsapp_pipelines USING btree (workspace_id) WHERE is_default;


--
-- Name: workspace_invitations_one_pending_email_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspace_invitations_one_pending_email_idx ON public.workspace_invitations USING btree (workspace_id, lower(email)) WHERE ((accepted_at IS NULL) AND (revoked_at IS NULL));


--
-- Name: workspace_invitations_workspace_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_invitations_workspace_id_idx ON public.workspace_invitations USING btree (workspace_id);


--
-- Name: workspace_members_user_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_members_user_id_idx ON public.workspace_members USING btree (user_id);


--
-- Name: workspace_members_workspace_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX workspace_members_workspace_id_idx ON public.workspace_members USING btree (workspace_id);


--
-- Name: workspaces_one_personal_per_owner_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX workspaces_one_personal_per_owner_idx ON public.workspaces USING btree (owner_id) WHERE is_personal;


--
-- Name: ix_realtime_subscription_entity; Type: INDEX; Schema: realtime; Owner: -
--

CREATE INDEX ix_realtime_subscription_entity ON realtime.subscription USING btree (entity);


--
-- Name: subscription_subscription_id_entity_filters_key; Type: INDEX; Schema: realtime; Owner: -
--

CREATE UNIQUE INDEX subscription_subscription_id_entity_filters_key ON realtime.subscription USING btree (subscription_id, entity, filters);


--
-- Name: bname; Type: INDEX; Schema: storage; Owner: -
--

CREATE UNIQUE INDEX bname ON storage.buckets USING btree (name);


--
-- Name: bucketid_objname; Type: INDEX; Schema: storage; Owner: -
--

CREATE UNIQUE INDEX bucketid_objname ON storage.objects USING btree (bucket_id, name);


--
-- Name: idx_multipart_uploads_list; Type: INDEX; Schema: storage; Owner: -
--

CREATE INDEX idx_multipart_uploads_list ON storage.s3_multipart_uploads USING btree (bucket_id, key COLLATE "C", created_at);


--
-- Name: idx_name_bucket_level_unique; Type: INDEX; Schema: storage; Owner: -
--

CREATE UNIQUE INDEX idx_name_bucket_level_unique ON storage.objects USING btree (name COLLATE "C", bucket_id, level);


--
-- Name: idx_objects_bucket_id_name; Type: INDEX; Schema: storage; Owner: -
--

CREATE INDEX idx_objects_bucket_id_name ON storage.objects USING btree (bucket_id, name COLLATE "C");


--
-- Name: idx_objects_lower_name; Type: INDEX; Schema: storage; Owner: -
--

CREATE INDEX idx_objects_lower_name ON storage.objects USING btree ((path_tokens[level]), lower(name) text_pattern_ops, bucket_id, level);


--
-- Name: idx_prefixes_lower_name; Type: INDEX; Schema: storage; Owner: -
--

CREATE INDEX idx_prefixes_lower_name ON storage.prefixes USING btree (bucket_id, level, ((string_to_array(name, '/'::text))[level]), lower(name) text_pattern_ops);


--
-- Name: name_prefix_search; Type: INDEX; Schema: storage; Owner: -
--

CREATE INDEX name_prefix_search ON storage.objects USING btree (name text_pattern_ops);


--
-- Name: objects_bucket_id_level_idx; Type: INDEX; Schema: storage; Owner: -
--

CREATE UNIQUE INDEX objects_bucket_id_level_idx ON storage.objects USING btree (bucket_id, level, name COLLATE "C");


--
-- Name: messages_2026_08_27_pkey; Type: INDEX ATTACH; Schema: realtime; Owner: -
--

ALTER INDEX realtime.messages_pkey ATTACH PARTITION realtime.messages_2026_08_27_pkey;


--
-- Name: messages_2026_08_28_pkey; Type: INDEX ATTACH; Schema: realtime; Owner: -
--

ALTER INDEX realtime.messages_pkey ATTACH PARTITION realtime.messages_2026_08_28_pkey;


--
-- Name: messages_2026_08_29_pkey; Type: INDEX ATTACH; Schema: realtime; Owner: -
--

ALTER INDEX realtime.messages_pkey ATTACH PARTITION realtime.messages_2026_08_29_pkey;


--
-- Name: messages_2026_08_30_pkey; Type: INDEX ATTACH; Schema: realtime; Owner: -
--

ALTER INDEX realtime.messages_pkey ATTACH PARTITION realtime.messages_2026_08_30_pkey;


--
-- Name: messages_2026_08_31_pkey; Type: INDEX ATTACH; Schema: realtime; Owner: -
--

ALTER INDEX realtime.messages_pkey ATTACH PARTITION realtime.messages_2026_08_31_pkey;


--
-- Name: messages_2026_09_01_pkey; Type: INDEX ATTACH; Schema: realtime; Owner: -
--

ALTER INDEX realtime.messages_pkey ATTACH PARTITION realtime.messages_2026_09_01_pkey;


--
-- Name: messages_2026_09_02_pkey; Type: INDEX ATTACH; Schema: realtime; Owner: -
--

ALTER INDEX realtime.messages_pkey ATTACH PARTITION realtime.messages_2026_09_02_pkey;


--
-- Name: users on_auth_user_created; Type: TRIGGER; Schema: auth; Owner: -
--

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


--
-- Name: users on_auth_user_created_role; Type: TRIGGER; Schema: auth; Owner: -
--

CREATE TRIGGER on_auth_user_created_role AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_role();


--
-- Name: coupons coupons_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER coupons_updated_at BEFORE UPDATE ON public.coupons FOR EACH ROW EXECUTE FUNCTION public.update_coupons_updated_at();


--
-- Name: workflows create_workflow_version_trigger; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER create_workflow_version_trigger AFTER UPDATE ON public.workflows FOR EACH ROW EXECUTE FUNCTION public.create_workflow_version();


--
-- Name: media_file_providers media_file_providers_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER media_file_providers_updated_at BEFORE UPDATE ON public.media_file_providers FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: profiles on_profile_created_quota; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER on_profile_created_quota AFTER INSERT ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.handle_new_user_quota();


--
-- Name: user_subscriptions on_subscription_change; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER on_subscription_change AFTER INSERT OR UPDATE OF plan_id ON public.user_subscriptions FOR EACH ROW EXECUTE FUNCTION public.handle_subscription_change();


--
-- Name: partner_api_keys partner_api_keys_workspace_is_immutable_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER partner_api_keys_workspace_is_immutable_trg BEFORE UPDATE OF workspace_id ON public.partner_api_keys FOR EACH ROW EXECUTE FUNCTION public.partner_api_keys_workspace_is_immutable();


--
-- Name: partner_audit_logs partner_audit_logs_assert_tenancy_trg; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER partner_audit_logs_assert_tenancy_trg BEFORE INSERT ON public.partner_audit_logs FOR EACH ROW EXECUTE FUNCTION public.partner_audit_logs_assert_tenancy();


--
-- Name: ai_model_preferences set_ai_model_preferences_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_ai_model_preferences_updated_at BEFORE UPDATE ON public.ai_model_preferences FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: ai_models set_ai_models_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_ai_models_updated_at BEFORE UPDATE ON public.ai_models FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: ai_providers set_ai_providers_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_ai_providers_updated_at BEFORE UPDATE ON public.ai_providers FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: app_credentials set_app_credentials_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_app_credentials_updated_at BEFORE UPDATE ON public.app_credentials FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: system_settings set_system_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_system_settings_updated_at BEFORE UPDATE ON public.system_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: threads_mentions set_threads_mentions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_threads_mentions_updated_at BEFORE UPDATE ON public.threads_mentions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: profiles set_user_referral_code; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_user_referral_code BEFORE INSERT ON public.profiles FOR EACH ROW WHEN ((new.referral_code IS NULL)) EXECUTE FUNCTION public.handle_new_user_referral_code();


--
-- Name: whatsapp_message_flags set_wa_message_flags_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER set_wa_message_flags_updated_at BEFORE UPDATE ON public.whatsapp_message_flags FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: support_tickets tickets_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER tickets_updated_at BEFORE UPDATE ON public.support_tickets FOR EACH ROW EXECUTE FUNCTION public.update_tickets_updated_at();


--
-- Name: posts trg_enforce_post_quota_on_insert; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_enforce_post_quota_on_insert BEFORE INSERT ON public.posts FOR EACH ROW EXECUTE FUNCTION public.enforce_post_quota_on_insert();


--
-- Name: whatsapp_contacts trg_sync_contact_to_conversations; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_sync_contact_to_conversations AFTER UPDATE OF display_name, avatar_url ON public.whatsapp_contacts FOR EACH ROW EXECUTE FUNCTION public.sync_contact_to_conversations();


--
-- Name: messaging_cache trg_validate_messaging_cache_platform; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_validate_messaging_cache_platform BEFORE INSERT OR UPDATE ON public.messaging_cache FOR EACH ROW EXECUTE FUNCTION public.validate_messaging_cache_platform();


--
-- Name: admin_inbox_messages update_admin_inbox_messages_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_admin_inbox_messages_updated_at BEFORE UPDATE ON public.admin_inbox_messages FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: ai_agent_configs update_ai_agent_configs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_ai_agent_configs_updated_at BEFORE UPDATE ON public.ai_agent_configs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: ai_agent_tools update_ai_agent_tools_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_ai_agent_tools_updated_at BEFORE UPDATE ON public.ai_agent_tools FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: ai_conversation_modes update_ai_conversation_modes_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_ai_conversation_modes_updated_at BEFORE UPDATE ON public.ai_conversation_modes FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: ai_knowledge_sources update_ai_knowledge_sources_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_ai_knowledge_sources_updated_at BEFORE UPDATE ON public.ai_knowledge_sources FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: ai_threads update_ai_threads_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_ai_threads_updated_at BEFORE UPDATE ON public.ai_threads FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: observability_alert_configs update_alert_configs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_alert_configs_updated_at BEFORE UPDATE ON public.observability_alert_configs FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: app_settings update_app_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_app_settings_updated_at BEFORE UPDATE ON public.app_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: blog_posts update_blog_posts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_blog_posts_updated_at BEFORE UPDATE ON public.blog_posts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: caption_history update_caption_history_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_caption_history_updated_at BEFORE UPDATE ON public.caption_history FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: comment_inbox_cache update_comment_inbox_cache_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_comment_inbox_cache_updated_at BEFORE UPDATE ON public.comment_inbox_cache FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: email_drafts update_email_drafts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_email_drafts_updated_at BEFORE UPDATE ON public.email_drafts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: email_signatures update_email_signatures_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_email_signatures_updated_at BEFORE UPDATE ON public.email_signatures FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: image_reference_presets update_image_reference_presets_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_image_reference_presets_updated_at BEFORE UPDATE ON public.image_reference_presets FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: lead_forms update_lead_forms_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_lead_forms_updated_at BEFORE UPDATE ON public.lead_forms FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: leads update_leads_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_leads_updated_at BEFORE UPDATE ON public.leads FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: mcp_oauth_clients update_mcp_oauth_clients_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_mcp_oauth_clients_updated_at BEFORE UPDATE ON public.mcp_oauth_clients FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: messaging_cache update_messaging_cache_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_messaging_cache_updated_at BEFORE UPDATE ON public.messaging_cache FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: messenger_auto_replies update_messenger_auto_replies_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_messenger_auto_replies_updated_at BEFORE UPDATE ON public.messenger_auto_replies FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: oauth_apps update_oauth_apps_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_oauth_apps_updated_at BEFORE UPDATE ON public.oauth_apps FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: partner_api_keys update_partner_api_keys_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_partner_api_keys_updated_at BEFORE UPDATE ON public.partner_api_keys FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: post_templates update_post_templates_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_post_templates_updated_at BEFORE UPDATE ON public.post_templates FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: profiles update_profiles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_profiles_updated_at BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: rate_limit_settings update_rate_limit_settings_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_rate_limit_settings_updated_at BEFORE UPDATE ON public.rate_limit_settings FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: scheduled_emails update_scheduled_emails_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_scheduled_emails_updated_at BEFORE UPDATE ON public.scheduled_emails FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: whatsapp_scheduled_messages update_scheduled_msgs_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_scheduled_msgs_updated_at BEFORE UPDATE ON public.whatsapp_scheduled_messages FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: social_accounts update_social_accounts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_social_accounts_updated_at BEFORE UPDATE ON public.social_accounts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: social_profiles update_social_profiles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_social_profiles_updated_at BEFORE UPDATE ON public.social_profiles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: subscription_plans update_subscription_plans_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_subscription_plans_updated_at BEFORE UPDATE ON public.subscription_plans FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: support_messages update_support_messages_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_support_messages_updated_at BEFORE UPDATE ON public.support_messages FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: threads_reply_cache update_threads_reply_cache_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_threads_reply_cache_updated_at BEFORE UPDATE ON public.threads_reply_cache FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: tier_rate_limits update_tier_rate_limits_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_tier_rate_limits_updated_at BEFORE UPDATE ON public.tier_rate_limits FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: tiktok_api_analytics_cache update_tiktok_cache_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_tiktok_cache_updated_at BEFORE UPDATE ON public.tiktok_api_analytics_cache FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: user_ai_model_overrides update_user_ai_model_overrides_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_user_ai_model_overrides_updated_at BEFORE UPDATE ON public.user_ai_model_overrides FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: user_connectors update_user_connectors_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_user_connectors_updated_at BEFORE UPDATE ON public.user_connectors FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: user_credits update_user_credits_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_user_credits_updated_at BEFORE UPDATE ON public.user_credits FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: user_feature_overrides update_user_feature_overrides_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_user_feature_overrides_updated_at BEFORE UPDATE ON public.user_feature_overrides FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: user_notification_preferences update_user_notification_preferences_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_user_notification_preferences_updated_at BEFORE UPDATE ON public.user_notification_preferences FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: user_quotas update_user_quotas_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_user_quotas_updated_at BEFORE UPDATE ON public.user_quotas FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: user_rate_limits update_user_rate_limits_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_user_rate_limits_updated_at BEFORE UPDATE ON public.user_rate_limits FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: user_roles update_user_roles_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_user_roles_updated_at BEFORE UPDATE ON public.user_roles FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: user_subscriptions update_user_subscriptions_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_user_subscriptions_updated_at BEFORE UPDATE ON public.user_subscriptions FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: video_processing_presets update_video_processing_presets_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_video_processing_presets_updated_at BEFORE UPDATE ON public.video_processing_presets FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: whatsapp_agents update_whatsapp_agents_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_whatsapp_agents_updated_at BEFORE UPDATE ON public.whatsapp_agents FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: whatsapp_conversation_assignments update_whatsapp_assignments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_whatsapp_assignments_updated_at BEFORE UPDATE ON public.whatsapp_conversation_assignments FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: whatsapp_auto_replies update_whatsapp_auto_replies_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_whatsapp_auto_replies_updated_at BEFORE UPDATE ON public.whatsapp_auto_replies FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: whatsapp_broadcasts update_whatsapp_broadcasts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_whatsapp_broadcasts_updated_at BEFORE UPDATE ON public.whatsapp_broadcasts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: whatsapp_contact_groups update_whatsapp_contact_groups_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_whatsapp_contact_groups_updated_at BEFORE UPDATE ON public.whatsapp_contact_groups FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: whatsapp_contacts update_whatsapp_contacts_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_whatsapp_contacts_updated_at BEFORE UPDATE ON public.whatsapp_contacts FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: whatsapp_quick_replies update_whatsapp_quick_replies_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_whatsapp_quick_replies_updated_at BEFORE UPDATE ON public.whatsapp_quick_replies FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: whatsapp_message_templates update_whatsapp_templates_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_whatsapp_templates_updated_at BEFORE UPDATE ON public.whatsapp_message_templates FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: whatsapp_webhooks update_whatsapp_webhooks_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_whatsapp_webhooks_updated_at BEFORE UPDATE ON public.whatsapp_webhooks FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: workflow_comments update_workflow_comments_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_workflow_comments_updated_at BEFORE UPDATE ON public.workflow_comments FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: workflow_templates update_workflow_templates_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_workflow_templates_updated_at BEFORE UPDATE ON public.workflow_templates FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: workflows update_workflows_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER update_workflows_updated_at BEFORE UPDATE ON public.workflows FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();


--
-- Name: whatsapp_deals whatsapp_deals_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER whatsapp_deals_set_updated_at BEFORE UPDATE ON public.whatsapp_deals FOR EACH ROW EXECUTE FUNCTION public.set_whatsapp_workspace_updated_at();


--
-- Name: whatsapp_pipeline_stages whatsapp_pipeline_stages_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER whatsapp_pipeline_stages_set_updated_at BEFORE UPDATE ON public.whatsapp_pipeline_stages FOR EACH ROW EXECUTE FUNCTION public.set_whatsapp_workspace_updated_at();


--
-- Name: whatsapp_pipelines whatsapp_pipelines_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER whatsapp_pipelines_set_updated_at BEFORE UPDATE ON public.whatsapp_pipelines FOR EACH ROW EXECUTE FUNCTION public.set_whatsapp_workspace_updated_at();


--
-- Name: workspace_invitations workspace_invitations_10_normalize_email; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workspace_invitations_10_normalize_email BEFORE INSERT OR UPDATE OF email ON public.workspace_invitations FOR EACH ROW EXECUTE FUNCTION public.normalize_workspace_invitation_email();


--
-- Name: workspace_invitations workspace_invitations_20_retire_expired; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workspace_invitations_20_retire_expired BEFORE INSERT ON public.workspace_invitations FOR EACH ROW EXECUTE FUNCTION public.retire_expired_workspace_invitations();


--
-- Name: workspace_members workspace_members_protect_last_owner; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workspace_members_protect_last_owner BEFORE DELETE OR UPDATE OF role, workspace_id ON public.workspace_members FOR EACH ROW EXECUTE FUNCTION public.prevent_last_workspace_owner();


--
-- Name: workspace_members workspace_members_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workspace_members_set_updated_at BEFORE UPDATE ON public.workspace_members FOR EACH ROW EXECUTE FUNCTION public.set_whatsapp_workspace_updated_at();


--
-- Name: workspaces workspaces_set_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER workspaces_set_updated_at BEFORE UPDATE ON public.workspaces FOR EACH ROW EXECUTE FUNCTION public.set_whatsapp_workspace_updated_at();


--
-- Name: subscription tr_check_filters; Type: TRIGGER; Schema: realtime; Owner: -
--

CREATE TRIGGER tr_check_filters BEFORE INSERT OR UPDATE ON realtime.subscription FOR EACH ROW EXECUTE FUNCTION realtime.subscription_check_filters();


--
-- Name: objects objects_delete_delete_prefix; Type: TRIGGER; Schema: storage; Owner: -
--

CREATE TRIGGER objects_delete_delete_prefix AFTER DELETE ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.delete_prefix_hierarchy_trigger();


--
-- Name: objects objects_insert_create_prefix; Type: TRIGGER; Schema: storage; Owner: -
--

CREATE TRIGGER objects_insert_create_prefix BEFORE INSERT ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.objects_insert_prefix_trigger();


--
-- Name: objects objects_update_create_prefix; Type: TRIGGER; Schema: storage; Owner: -
--

CREATE TRIGGER objects_update_create_prefix BEFORE UPDATE ON storage.objects FOR EACH ROW WHEN (((new.name <> old.name) OR (new.bucket_id <> old.bucket_id))) EXECUTE FUNCTION storage.objects_update_prefix_trigger();


--
-- Name: prefixes prefixes_create_hierarchy; Type: TRIGGER; Schema: storage; Owner: -
--

CREATE TRIGGER prefixes_create_hierarchy BEFORE INSERT ON storage.prefixes FOR EACH ROW WHEN ((pg_trigger_depth() < 1)) EXECUTE FUNCTION storage.prefixes_insert_trigger();


--
-- Name: prefixes prefixes_delete_hierarchy; Type: TRIGGER; Schema: storage; Owner: -
--

CREATE TRIGGER prefixes_delete_hierarchy AFTER DELETE ON storage.prefixes FOR EACH ROW EXECUTE FUNCTION storage.delete_prefix_hierarchy_trigger();


--
-- Name: objects update_objects_updated_at; Type: TRIGGER; Schema: storage; Owner: -
--

CREATE TRIGGER update_objects_updated_at BEFORE UPDATE ON storage.objects FOR EACH ROW EXECUTE FUNCTION storage.update_updated_at_column();


--
-- Name: identities identities_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.identities
    ADD CONSTRAINT identities_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: mfa_amr_claims mfa_amr_claims_session_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_amr_claims
    ADD CONSTRAINT mfa_amr_claims_session_id_fkey FOREIGN KEY (session_id) REFERENCES auth.sessions(id) ON DELETE CASCADE;


--
-- Name: mfa_challenges mfa_challenges_auth_factor_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_challenges
    ADD CONSTRAINT mfa_challenges_auth_factor_id_fkey FOREIGN KEY (factor_id) REFERENCES auth.mfa_factors(id) ON DELETE CASCADE;


--
-- Name: mfa_factors mfa_factors_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.mfa_factors
    ADD CONSTRAINT mfa_factors_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: one_time_tokens one_time_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.one_time_tokens
    ADD CONSTRAINT one_time_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: refresh_tokens refresh_tokens_session_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.refresh_tokens
    ADD CONSTRAINT refresh_tokens_session_id_fkey FOREIGN KEY (session_id) REFERENCES auth.sessions(id) ON DELETE CASCADE;


--
-- Name: saml_providers saml_providers_sso_provider_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.saml_providers
    ADD CONSTRAINT saml_providers_sso_provider_id_fkey FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers(id) ON DELETE CASCADE;


--
-- Name: saml_relay_states saml_relay_states_flow_state_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.saml_relay_states
    ADD CONSTRAINT saml_relay_states_flow_state_id_fkey FOREIGN KEY (flow_state_id) REFERENCES auth.flow_state(id) ON DELETE CASCADE;


--
-- Name: saml_relay_states saml_relay_states_sso_provider_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.saml_relay_states
    ADD CONSTRAINT saml_relay_states_sso_provider_id_fkey FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers(id) ON DELETE CASCADE;


--
-- Name: sessions sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.sessions
    ADD CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: sso_domains sso_domains_sso_provider_id_fkey; Type: FK CONSTRAINT; Schema: auth; Owner: -
--

ALTER TABLE ONLY auth.sso_domains
    ADD CONSTRAINT sso_domains_sso_provider_id_fkey FOREIGN KEY (sso_provider_id) REFERENCES auth.sso_providers(id) ON DELETE CASCADE;


--
-- Name: admin_inbox_messages admin_inbox_messages_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_inbox_messages
    ADD CONSTRAINT admin_inbox_messages_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES auth.users(id);


--
-- Name: admin_inbox_messages admin_inbox_messages_reply_to_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_inbox_messages
    ADD CONSTRAINT admin_inbox_messages_reply_to_id_fkey FOREIGN KEY (reply_to_id) REFERENCES public.admin_inbox_messages(id);


--
-- Name: admin_notifications admin_notifications_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.admin_notifications
    ADD CONSTRAINT admin_notifications_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: ai_agent_configs ai_agent_configs_account_same_owner_platform; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agent_configs
    ADD CONSTRAINT ai_agent_configs_account_same_owner_platform FOREIGN KEY (social_account_id, user_id, platform) REFERENCES public.social_accounts(id, user_id, platform) ON DELETE CASCADE;


--
-- Name: ai_agent_configs ai_agent_configs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agent_configs
    ADD CONSTRAINT ai_agent_configs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: ai_agent_logs ai_agent_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agent_logs
    ADD CONSTRAINT ai_agent_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: ai_agent_tools ai_agent_tools_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_agent_tools
    ADD CONSTRAINT ai_agent_tools_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: ai_conversation_modes ai_conversation_modes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_conversation_modes
    ADD CONSTRAINT ai_conversation_modes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: ai_generation_jobs ai_generation_jobs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_generation_jobs
    ADD CONSTRAINT ai_generation_jobs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: ai_knowledge_chunks ai_knowledge_chunks_source_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_chunks
    ADD CONSTRAINT ai_knowledge_chunks_source_id_fkey FOREIGN KEY (source_id) REFERENCES public.ai_knowledge_sources(id) ON DELETE CASCADE;


--
-- Name: ai_knowledge_chunks ai_knowledge_chunks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_chunks
    ADD CONSTRAINT ai_knowledge_chunks_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: ai_knowledge_entities ai_knowledge_entities_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_entities
    ADD CONSTRAINT ai_knowledge_entities_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: ai_knowledge_graph_exports ai_knowledge_graph_exports_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_graph_exports
    ADD CONSTRAINT ai_knowledge_graph_exports_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: ai_knowledge_relations ai_knowledge_relations_source_chunk_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_relations
    ADD CONSTRAINT ai_knowledge_relations_source_chunk_id_fkey FOREIGN KEY (source_chunk_id) REFERENCES public.ai_knowledge_chunks(id) ON DELETE CASCADE;


--
-- Name: ai_knowledge_relations ai_knowledge_relations_source_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_relations
    ADD CONSTRAINT ai_knowledge_relations_source_entity_id_fkey FOREIGN KEY (source_entity_id) REFERENCES public.ai_knowledge_entities(id) ON DELETE CASCADE;


--
-- Name: ai_knowledge_relations ai_knowledge_relations_target_entity_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_relations
    ADD CONSTRAINT ai_knowledge_relations_target_entity_id_fkey FOREIGN KEY (target_entity_id) REFERENCES public.ai_knowledge_entities(id) ON DELETE CASCADE;


--
-- Name: ai_knowledge_relations ai_knowledge_relations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_relations
    ADD CONSTRAINT ai_knowledge_relations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: ai_knowledge_source_accounts ai_knowledge_source_accounts_social_account_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_source_accounts
    ADD CONSTRAINT ai_knowledge_source_accounts_social_account_id_user_id_fkey FOREIGN KEY (social_account_id, user_id) REFERENCES public.social_accounts(id, user_id) ON DELETE CASCADE;


--
-- Name: ai_knowledge_source_accounts ai_knowledge_source_accounts_source_id_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_source_accounts
    ADD CONSTRAINT ai_knowledge_source_accounts_source_id_user_id_fkey FOREIGN KEY (source_id, user_id) REFERENCES public.ai_knowledge_sources(id, user_id) ON DELETE CASCADE;


--
-- Name: ai_knowledge_source_accounts ai_knowledge_source_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_source_accounts
    ADD CONSTRAINT ai_knowledge_source_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: ai_knowledge_sources ai_knowledge_sources_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_knowledge_sources
    ADD CONSTRAINT ai_knowledge_sources_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: ai_model_preferences ai_model_preferences_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_model_preferences
    ADD CONSTRAINT ai_model_preferences_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.ai_models(id) ON DELETE CASCADE;


--
-- Name: ai_model_preferences ai_model_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_model_preferences
    ADD CONSTRAINT ai_model_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: ai_models ai_models_provider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_models
    ADD CONSTRAINT ai_models_provider_id_fkey FOREIGN KEY (provider_id) REFERENCES public.ai_providers(id) ON DELETE CASCADE;


--
-- Name: ai_thread_messages ai_thread_messages_thread_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_thread_messages
    ADD CONSTRAINT ai_thread_messages_thread_id_fkey FOREIGN KEY (thread_id) REFERENCES public.ai_threads(id) ON DELETE CASCADE;


--
-- Name: ai_thread_messages ai_thread_messages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_thread_messages
    ADD CONSTRAINT ai_thread_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: ai_threads ai_threads_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ai_threads
    ADD CONSTRAINT ai_threads_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: api_logs api_logs_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.api_logs
    ADD CONSTRAINT api_logs_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: app_credentials app_credentials_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_credentials
    ADD CONSTRAINT app_credentials_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: app_settings app_settings_updated_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.app_settings
    ADD CONSTRAINT app_settings_updated_by_fkey FOREIGN KEY (updated_by) REFERENCES auth.users(id);


--
-- Name: automation_dispatch_log automation_dispatch_log_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.automation_dispatch_log
    ADD CONSTRAINT automation_dispatch_log_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: backup_codes backup_codes_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.backup_codes
    ADD CONSTRAINT backup_codes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: bi_post_content bi_post_content_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.bi_post_content
    ADD CONSTRAINT bi_post_content_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: blog_posts blog_posts_author_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.blog_posts
    ADD CONSTRAINT blog_posts_author_id_fkey FOREIGN KEY (author_id) REFERENCES auth.users(id);


--
-- Name: brand_scrape_sessions brand_scrape_sessions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_scrape_sessions
    ADD CONSTRAINT brand_scrape_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);


--
-- Name: brand_search_history brand_search_history_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_search_history
    ADD CONSTRAINT brand_search_history_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: coupon_redemptions coupon_redemptions_coupon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupon_redemptions
    ADD CONSTRAINT coupon_redemptions_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES public.coupons(id) ON DELETE CASCADE;


--
-- Name: coupon_redemptions coupon_redemptions_subscription_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupon_redemptions
    ADD CONSTRAINT coupon_redemptions_subscription_id_fkey FOREIGN KEY (subscription_id) REFERENCES public.user_subscriptions(id) ON DELETE SET NULL;


--
-- Name: coupon_redemptions coupon_redemptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupon_redemptions
    ADD CONSTRAINT coupon_redemptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: coupons coupons_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.coupons
    ADD CONSTRAINT coupons_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: credit_transactions credit_transactions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.credit_transactions
    ADD CONSTRAINT credit_transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: deployment_logs deployment_logs_triggered_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.deployment_logs
    ADD CONSTRAINT deployment_logs_triggered_by_fkey FOREIGN KEY (triggered_by) REFERENCES public.profiles(id);


--
-- Name: email_contacts email_contacts_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_contacts
    ADD CONSTRAINT email_contacts_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: email_drafts email_drafts_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_drafts
    ADD CONSTRAINT email_drafts_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: email_drafts email_drafts_reply_to_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_drafts
    ADD CONSTRAINT email_drafts_reply_to_message_id_fkey FOREIGN KEY (reply_to_message_id) REFERENCES public.admin_inbox_messages(id) ON DELETE SET NULL;


--
-- Name: email_drafts email_drafts_signature_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_drafts
    ADD CONSTRAINT email_drafts_signature_id_fkey FOREIGN KEY (signature_id) REFERENCES public.email_signatures(id) ON DELETE SET NULL;


--
-- Name: email_log email_log_recipient_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_log
    ADD CONSTRAINT email_log_recipient_id_fkey FOREIGN KEY (recipient_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: email_log email_log_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_log
    ADD CONSTRAINT email_log_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.email_templates(id) ON DELETE SET NULL;


--
-- Name: email_signatures email_signatures_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_signatures
    ADD CONSTRAINT email_signatures_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: email_templates email_templates_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.email_templates
    ADD CONSTRAINT email_templates_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: feature_flag_audit_log feature_flag_audit_log_changed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flag_audit_log
    ADD CONSTRAINT feature_flag_audit_log_changed_by_fkey FOREIGN KEY (changed_by) REFERENCES auth.users(id);


--
-- Name: feature_flag_schedules feature_flag_schedules_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.feature_flag_schedules
    ADD CONSTRAINT feature_flag_schedules_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: generated_content_collections generated_content_collections_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.generated_content_collections
    ADD CONSTRAINT generated_content_collections_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);


--
-- Name: higgsfield_connections higgsfield_connections_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.higgsfield_connections
    ADD CONSTRAINT higgsfield_connections_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: launch_checklist launch_checklist_completed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.launch_checklist
    ADD CONSTRAINT launch_checklist_completed_by_fkey FOREIGN KEY (completed_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: launch_checklist launch_checklist_dependency_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.launch_checklist
    ADD CONSTRAINT launch_checklist_dependency_id_fkey FOREIGN KEY (dependency_id) REFERENCES public.launch_checklist(id) ON DELETE SET NULL;


--
-- Name: leads leads_form_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.leads
    ADD CONSTRAINT leads_form_id_fkey FOREIGN KEY (form_id) REFERENCES public.lead_forms(id) ON DELETE CASCADE;


--
-- Name: log_analyses log_analyses_log_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.log_analyses
    ADD CONSTRAINT log_analyses_log_id_fkey FOREIGN KEY (log_id) REFERENCES public.system_logs(id) ON DELETE CASCADE;


--
-- Name: mcp_oauth_authorizations mcp_oauth_authorizations_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_authorizations
    ADD CONSTRAINT mcp_oauth_authorizations_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.mcp_oauth_clients(client_id) ON DELETE CASCADE;


--
-- Name: mcp_oauth_authorizations mcp_oauth_authorizations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_authorizations
    ADD CONSTRAINT mcp_oauth_authorizations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: mcp_oauth_tokens mcp_oauth_tokens_client_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_tokens
    ADD CONSTRAINT mcp_oauth_tokens_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.mcp_oauth_clients(client_id) ON DELETE CASCADE;


--
-- Name: mcp_oauth_tokens mcp_oauth_tokens_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.mcp_oauth_tokens
    ADD CONSTRAINT mcp_oauth_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: media_file_providers media_file_providers_media_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_file_providers
    ADD CONSTRAINT media_file_providers_media_file_id_fkey FOREIGN KEY (media_file_id) REFERENCES public.media_files(id) ON DELETE CASCADE;


--
-- Name: media_files media_files_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_files
    ADD CONSTRAINT media_files_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: media_folders media_folders_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_folders
    ADD CONSTRAINT media_folders_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: media_operations_history media_operations_history_media_file_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_operations_history
    ADD CONSTRAINT media_operations_history_media_file_id_fkey FOREIGN KEY (media_file_id) REFERENCES public.media_files(id) ON DELETE SET NULL;


--
-- Name: media_upload_counters media_upload_counters_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.media_upload_counters
    ADD CONSTRAINT media_upload_counters_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: messaging_cache messaging_cache_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messaging_cache
    ADD CONSTRAINT messaging_cache_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: messaging_cache messaging_cache_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messaging_cache
    ADD CONSTRAINT messaging_cache_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: messenger_auto_replies messenger_auto_replies_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.messenger_auto_replies
    ADD CONSTRAINT messenger_auto_replies_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: node_execution_logs node_execution_logs_execution_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.node_execution_logs
    ADD CONSTRAINT node_execution_logs_execution_id_fkey FOREIGN KEY (execution_id) REFERENCES public.workflow_executions(id) ON DELETE CASCADE;


--
-- Name: notification_reads notification_reads_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_reads
    ADD CONSTRAINT notification_reads_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.system_notifications(id) ON DELETE CASCADE;


--
-- Name: notification_reads notification_reads_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notification_reads
    ADD CONSTRAINT notification_reads_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: oauth_pending_facebook_selections oauth_pending_facebook_selections_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_pending_facebook_selections
    ADD CONSTRAINT oauth_pending_facebook_selections_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: oauth_pending_instagram_selections oauth_pending_instagram_selections_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_pending_instagram_selections
    ADD CONSTRAINT oauth_pending_instagram_selections_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: oauth_redirect_requests oauth_redirect_requests_oauth_app_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_redirect_requests
    ADD CONSTRAINT oauth_redirect_requests_oauth_app_id_fkey FOREIGN KEY (oauth_app_id) REFERENCES public.oauth_apps(id) ON DELETE CASCADE;


--
-- Name: oauth_redirect_requests oauth_redirect_requests_reviewed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_redirect_requests
    ADD CONSTRAINT oauth_redirect_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id);


--
-- Name: oauth_redirect_requests oauth_redirect_requests_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_redirect_requests
    ADD CONSTRAINT oauth_redirect_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: oauth_states oauth_states_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.oauth_states
    ADD CONSTRAINT oauth_states_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: observability_alert_configs observability_alert_configs_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.observability_alert_configs
    ADD CONSTRAINT observability_alert_configs_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: observability_alert_history observability_alert_history_alert_config_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.observability_alert_history
    ADD CONSTRAINT observability_alert_history_alert_config_id_fkey FOREIGN KEY (alert_config_id) REFERENCES public.observability_alert_configs(id) ON DELETE SET NULL;


--
-- Name: observability_alert_history observability_alert_history_resolved_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.observability_alert_history
    ADD CONSTRAINT observability_alert_history_resolved_by_fkey FOREIGN KEY (resolved_by) REFERENCES auth.users(id);


--
-- Name: partner_api_idempotency partner_api_idempotency_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_api_idempotency
    ADD CONSTRAINT partner_api_idempotency_key_id_fkey FOREIGN KEY (key_id) REFERENCES public.partner_api_keys(id) ON DELETE CASCADE;


--
-- Name: partner_api_key_accounts partner_api_key_accounts_account_in_workspace; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_api_key_accounts
    ADD CONSTRAINT partner_api_key_accounts_account_in_workspace FOREIGN KEY (social_account_id, workspace_id) REFERENCES public.social_accounts(id, workspace_id) ON DELETE CASCADE;


--
-- Name: partner_api_key_accounts partner_api_key_accounts_key_in_workspace; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_api_key_accounts
    ADD CONSTRAINT partner_api_key_accounts_key_in_workspace FOREIGN KEY (key_id, workspace_id) REFERENCES public.partner_api_keys(id, workspace_id) ON DELETE CASCADE;


--
-- Name: partner_api_key_accounts partner_api_key_accounts_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_api_key_accounts
    ADD CONSTRAINT partner_api_key_accounts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: partner_api_keys partner_api_keys_account_in_workspace; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_api_keys
    ADD CONSTRAINT partner_api_keys_account_in_workspace FOREIGN KEY (social_account_id, workspace_id) REFERENCES public.social_accounts(id, workspace_id) ON DELETE CASCADE;


--
-- Name: partner_api_keys partner_api_keys_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_api_keys
    ADD CONSTRAINT partner_api_keys_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: partner_api_keys partner_api_keys_revoked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_api_keys
    ADD CONSTRAINT partner_api_keys_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: partner_api_keys partner_api_keys_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_api_keys
    ADD CONSTRAINT partner_api_keys_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: partner_api_rate_buckets partner_api_rate_buckets_key_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_api_rate_buckets
    ADD CONSTRAINT partner_api_rate_buckets_key_id_fkey FOREIGN KEY (key_id) REFERENCES public.partner_api_keys(id) ON DELETE CASCADE;


--
-- Name: partner_api_usage partner_api_usage_key_in_workspace; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_api_usage
    ADD CONSTRAINT partner_api_usage_key_in_workspace FOREIGN KEY (key_id, workspace_id) REFERENCES public.partner_api_keys(id, workspace_id) ON DELETE RESTRICT;


--
-- Name: partner_api_usage partner_api_usage_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_api_usage
    ADD CONSTRAINT partner_api_usage_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: partner_audit_logs partner_audit_logs_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_audit_logs
    ADD CONSTRAINT partner_audit_logs_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: partner_audit_logs partner_audit_logs_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.partner_audit_logs
    ADD CONSTRAINT partner_audit_logs_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: pending_agent_replies pending_agent_replies_social_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_agent_replies
    ADD CONSTRAINT pending_agent_replies_social_account_id_fkey FOREIGN KEY (social_account_id) REFERENCES public.social_accounts(id) ON DELETE CASCADE;


--
-- Name: pending_agent_replies pending_agent_replies_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.pending_agent_replies
    ADD CONSTRAINT pending_agent_replies_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: platform_posts platform_posts_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_posts
    ADD CONSTRAINT platform_posts_post_id_fkey FOREIGN KEY (post_id) REFERENCES public.posts(id) ON DELETE CASCADE;


--
-- Name: platform_posts platform_posts_social_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.platform_posts
    ADD CONSTRAINT platform_posts_social_account_id_fkey FOREIGN KEY (social_account_id) REFERENCES public.social_accounts(id) ON DELETE CASCADE;


--
-- Name: posts posts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.posts
    ADD CONSTRAINT posts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: profiles profiles_referred_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.profiles
    ADD CONSTRAINT profiles_referred_by_fkey FOREIGN KEY (referred_by) REFERENCES auth.users(id);


--
-- Name: provider_api_keys provider_api_keys_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.provider_api_keys
    ADD CONSTRAINT provider_api_keys_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: referrals referrals_referred_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_referred_user_id_fkey FOREIGN KEY (referred_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: referrals referrals_referrer_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.referrals
    ADD CONSTRAINT referrals_referrer_id_fkey FOREIGN KEY (referrer_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: saved_field_suggestions saved_field_suggestions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.saved_field_suggestions
    ADD CONSTRAINT saved_field_suggestions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: scheduled_emails scheduled_emails_admin_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_emails
    ADD CONSTRAINT scheduled_emails_admin_id_fkey FOREIGN KEY (admin_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: scheduled_emails scheduled_emails_reply_to_message_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_emails
    ADD CONSTRAINT scheduled_emails_reply_to_message_id_fkey FOREIGN KEY (reply_to_message_id) REFERENCES public.admin_inbox_messages(id) ON DELETE SET NULL;


--
-- Name: scheduled_emails scheduled_emails_signature_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.scheduled_emails
    ADD CONSTRAINT scheduled_emails_signature_id_fkey FOREIGN KEY (signature_id) REFERENCES public.email_signatures(id) ON DELETE SET NULL;


--
-- Name: social_accounts social_accounts_social_profile_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_accounts
    ADD CONSTRAINT social_accounts_social_profile_id_fkey FOREIGN KEY (social_profile_id) REFERENCES public.social_profiles(id) ON DELETE CASCADE;


--
-- Name: social_accounts social_accounts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_accounts
    ADD CONSTRAINT social_accounts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: social_accounts social_accounts_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_accounts
    ADD CONSTRAINT social_accounts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: social_inbox_events social_inbox_events_social_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_inbox_events
    ADD CONSTRAINT social_inbox_events_social_account_id_fkey FOREIGN KEY (social_account_id) REFERENCES public.social_accounts(id) ON DELETE CASCADE;


--
-- Name: social_inbox_events social_inbox_events_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.social_inbox_events
    ADD CONSTRAINT social_inbox_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: support_messages support_messages_replied_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_messages
    ADD CONSTRAINT support_messages_replied_by_fkey FOREIGN KEY (replied_by) REFERENCES auth.users(id);


--
-- Name: support_messages support_messages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_messages
    ADD CONSTRAINT support_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: support_tickets support_tickets_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: support_tickets support_tickets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.support_tickets
    ADD CONSTRAINT support_tickets_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: system_notifications system_notifications_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.system_notifications
    ADD CONSTRAINT system_notifications_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: threads_mentions threads_mentions_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads_mentions
    ADD CONSTRAINT threads_mentions_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: threads_mentions threads_mentions_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads_mentions
    ADD CONSTRAINT threads_mentions_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: threads_mentions threads_mentions_replied_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads_mentions
    ADD CONSTRAINT threads_mentions_replied_by_fkey FOREIGN KEY (replied_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: threads_mentions threads_mentions_social_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads_mentions
    ADD CONSTRAINT threads_mentions_social_account_id_fkey FOREIGN KEY (social_account_id) REFERENCES public.social_accounts(id) ON DELETE CASCADE;


--
-- Name: threads_mentions threads_mentions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads_mentions
    ADD CONSTRAINT threads_mentions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: threads_reply_cache threads_reply_cache_social_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads_reply_cache
    ADD CONSTRAINT threads_reply_cache_social_account_id_fkey FOREIGN KEY (social_account_id) REFERENCES public.social_accounts(id) ON DELETE CASCADE;


--
-- Name: threads_reply_cache threads_reply_cache_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.threads_reply_cache
    ADD CONSTRAINT threads_reply_cache_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: ticket_activities ticket_activities_actor_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_activities
    ADD CONSTRAINT ticket_activities_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: ticket_activities ticket_activities_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_activities
    ADD CONSTRAINT ticket_activities_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.support_tickets(id) ON DELETE CASCADE;


--
-- Name: ticket_messages ticket_messages_ticket_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_messages
    ADD CONSTRAINT ticket_messages_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES public.support_tickets(id) ON DELETE CASCADE;


--
-- Name: ticket_messages ticket_messages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.ticket_messages
    ADD CONSTRAINT ticket_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: token_refresh_history token_refresh_history_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.token_refresh_history
    ADD CONSTRAINT token_refresh_history_account_id_fkey FOREIGN KEY (account_id) REFERENCES public.social_accounts(id) ON DELETE CASCADE;


--
-- Name: user_ai_model_overrides user_ai_model_overrides_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_ai_model_overrides
    ADD CONSTRAINT user_ai_model_overrides_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);


--
-- Name: user_ai_model_overrides user_ai_model_overrides_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_ai_model_overrides
    ADD CONSTRAINT user_ai_model_overrides_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_blog_post_reads user_blog_post_reads_blog_post_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blog_post_reads
    ADD CONSTRAINT user_blog_post_reads_blog_post_id_fkey FOREIGN KEY (blog_post_id) REFERENCES public.blog_posts(id) ON DELETE CASCADE;


--
-- Name: user_blog_post_reads user_blog_post_reads_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_blog_post_reads
    ADD CONSTRAINT user_blog_post_reads_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_connectors user_connectors_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_connectors
    ADD CONSTRAINT user_connectors_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_credits user_credits_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_credits
    ADD CONSTRAINT user_credits_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_feature_overrides user_feature_overrides_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_feature_overrides
    ADD CONSTRAINT user_feature_overrides_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: user_feature_overrides user_feature_overrides_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_feature_overrides
    ADD CONSTRAINT user_feature_overrides_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_notification_preferences user_notification_preferences_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notification_preferences
    ADD CONSTRAINT user_notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_notification_reads user_notification_reads_notification_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_notification_reads
    ADD CONSTRAINT user_notification_reads_notification_id_fkey FOREIGN KEY (notification_id) REFERENCES public.admin_notifications(id) ON DELETE CASCADE;


--
-- Name: user_quotas user_quotas_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_quotas
    ADD CONSTRAINT user_quotas_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_rate_limits user_rate_limits_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_rate_limits
    ADD CONSTRAINT user_rate_limits_created_by_fkey FOREIGN KEY (created_by) REFERENCES public.profiles(id);


--
-- Name: user_rate_limits user_rate_limits_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_rate_limits
    ADD CONSTRAINT user_rate_limits_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;


--
-- Name: user_roles user_roles_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_roles
    ADD CONSTRAINT user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: user_subscriptions user_subscriptions_coupon_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_subscriptions
    ADD CONSTRAINT user_subscriptions_coupon_id_fkey FOREIGN KEY (coupon_id) REFERENCES public.coupons(id) ON DELETE SET NULL;


--
-- Name: user_subscriptions user_subscriptions_plan_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_subscriptions
    ADD CONSTRAINT user_subscriptions_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES public.subscription_plans(id);


--
-- Name: user_subscriptions user_subscriptions_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.user_subscriptions
    ADD CONSTRAINT user_subscriptions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: video_processing_presets video_processing_presets_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.video_processing_presets
    ADD CONSTRAINT video_processing_presets_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: webhook_unmatched_observations webhook_unmatched_observations_social_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_unmatched_observations
    ADD CONSTRAINT webhook_unmatched_observations_social_account_id_fkey FOREIGN KEY (social_account_id) REFERENCES public.social_accounts(id) ON DELETE SET NULL;


--
-- Name: webhook_unmatched_observations webhook_unmatched_observations_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.webhook_unmatched_observations
    ADD CONSTRAINT webhook_unmatched_observations_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_agents whatsapp_agents_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_agents
    ADD CONSTRAINT whatsapp_agents_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_agents whatsapp_agents_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_agents
    ADD CONSTRAINT whatsapp_agents_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: whatsapp_assignment_history whatsapp_assignment_history_from_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_assignment_history
    ADD CONSTRAINT whatsapp_assignment_history_from_agent_id_fkey FOREIGN KEY (from_agent_id) REFERENCES public.whatsapp_agents(id) ON DELETE SET NULL;


--
-- Name: whatsapp_assignment_history whatsapp_assignment_history_performed_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_assignment_history
    ADD CONSTRAINT whatsapp_assignment_history_performed_by_fkey FOREIGN KEY (performed_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: whatsapp_assignment_history whatsapp_assignment_history_to_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_assignment_history
    ADD CONSTRAINT whatsapp_assignment_history_to_agent_id_fkey FOREIGN KEY (to_agent_id) REFERENCES public.whatsapp_agents(id) ON DELETE SET NULL;


--
-- Name: whatsapp_conversation_assignments whatsapp_assignments_conversation_workspace_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_conversation_assignments
    ADD CONSTRAINT whatsapp_assignments_conversation_workspace_fkey FOREIGN KEY (conversation_cache_id, workspace_id) REFERENCES public.messaging_cache(id, workspace_id) ON DELETE CASCADE;


--
-- Name: whatsapp_auto_replies whatsapp_auto_replies_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_auto_replies
    ADD CONSTRAINT whatsapp_auto_replies_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_broadcast_recipients whatsapp_broadcast_recipients_broadcast_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_broadcast_recipients
    ADD CONSTRAINT whatsapp_broadcast_recipients_broadcast_id_fkey FOREIGN KEY (broadcast_id) REFERENCES public.whatsapp_broadcasts(id) ON DELETE CASCADE;


--
-- Name: whatsapp_broadcast_recipients whatsapp_broadcast_recipients_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_broadcast_recipients
    ADD CONSTRAINT whatsapp_broadcast_recipients_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.whatsapp_contacts(id) ON DELETE CASCADE;


--
-- Name: whatsapp_broadcasts whatsapp_broadcasts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_broadcasts
    ADD CONSTRAINT whatsapp_broadcasts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_contact_group_members whatsapp_contact_group_members_contact_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_contact_group_members
    ADD CONSTRAINT whatsapp_contact_group_members_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES public.whatsapp_contacts(id) ON DELETE CASCADE;


--
-- Name: whatsapp_contact_group_members whatsapp_contact_group_members_group_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_contact_group_members
    ADD CONSTRAINT whatsapp_contact_group_members_group_id_fkey FOREIGN KEY (group_id) REFERENCES public.whatsapp_contact_groups(id) ON DELETE CASCADE;


--
-- Name: whatsapp_contact_groups whatsapp_contact_groups_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_contact_groups
    ADD CONSTRAINT whatsapp_contact_groups_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_contacts whatsapp_contacts_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_contacts
    ADD CONSTRAINT whatsapp_contacts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_contacts whatsapp_contacts_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_contacts
    ADD CONSTRAINT whatsapp_contacts_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: whatsapp_conversation_assignments whatsapp_conversation_assignments_agent_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_conversation_assignments
    ADD CONSTRAINT whatsapp_conversation_assignments_agent_id_fkey FOREIGN KEY (agent_id) REFERENCES public.whatsapp_agents(id) ON DELETE SET NULL;


--
-- Name: whatsapp_conversation_assignments whatsapp_conversation_assignments_assigned_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_conversation_assignments
    ADD CONSTRAINT whatsapp_conversation_assignments_assigned_by_fkey FOREIGN KEY (assigned_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: whatsapp_conversation_assignments whatsapp_conversation_assignments_conversation_cache_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_conversation_assignments
    ADD CONSTRAINT whatsapp_conversation_assignments_conversation_cache_id_fkey FOREIGN KEY (conversation_cache_id) REFERENCES public.messaging_cache(id) ON DELETE CASCADE;


--
-- Name: whatsapp_conversation_assignments whatsapp_conversation_assignments_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_conversation_assignments
    ADD CONSTRAINT whatsapp_conversation_assignments_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: whatsapp_conversation_label_assignments whatsapp_conversation_label_assignments_label_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_conversation_label_assignments
    ADD CONSTRAINT whatsapp_conversation_label_assignments_label_id_fkey FOREIGN KEY (label_id) REFERENCES public.whatsapp_conversation_labels(id) ON DELETE CASCADE;


--
-- Name: whatsapp_conversation_label_assignments whatsapp_conversation_label_assignments_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_conversation_label_assignments
    ADD CONSTRAINT whatsapp_conversation_label_assignments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_conversation_labels whatsapp_conversation_labels_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_conversation_labels
    ADD CONSTRAINT whatsapp_conversation_labels_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_deals whatsapp_deals_assigned_to_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_deals
    ADD CONSTRAINT whatsapp_deals_assigned_to_fkey FOREIGN KEY (assigned_to) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: whatsapp_deals whatsapp_deals_contact_workspace_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_deals
    ADD CONSTRAINT whatsapp_deals_contact_workspace_fkey FOREIGN KEY (contact_id, workspace_id) REFERENCES public.whatsapp_contacts(id, workspace_id) ON DELETE CASCADE;


--
-- Name: whatsapp_deals whatsapp_deals_conversation_workspace_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_deals
    ADD CONSTRAINT whatsapp_deals_conversation_workspace_fkey FOREIGN KEY (conversation_cache_id, workspace_id) REFERENCES public.messaging_cache(id, workspace_id) ON DELETE SET NULL (conversation_cache_id);


--
-- Name: whatsapp_deals whatsapp_deals_created_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_deals
    ADD CONSTRAINT whatsapp_deals_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: whatsapp_deals whatsapp_deals_pipeline_workspace_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_deals
    ADD CONSTRAINT whatsapp_deals_pipeline_workspace_fkey FOREIGN KEY (pipeline_id, workspace_id) REFERENCES public.whatsapp_pipelines(id, workspace_id) ON DELETE CASCADE;


--
-- Name: whatsapp_deals whatsapp_deals_stage_pipeline_workspace_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_deals
    ADD CONSTRAINT whatsapp_deals_stage_pipeline_workspace_fkey FOREIGN KEY (stage_id, pipeline_id, workspace_id) REFERENCES public.whatsapp_pipeline_stages(id, pipeline_id, workspace_id) ON DELETE RESTRICT;


--
-- Name: whatsapp_deals whatsapp_deals_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_deals
    ADD CONSTRAINT whatsapp_deals_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: whatsapp_evolution_instances whatsapp_evolution_instances_social_account_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_evolution_instances
    ADD CONSTRAINT whatsapp_evolution_instances_social_account_id_fkey FOREIGN KEY (social_account_id) REFERENCES public.social_accounts(id) ON DELETE CASCADE;


--
-- Name: whatsapp_message_analytics whatsapp_message_analytics_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_message_analytics
    ADD CONSTRAINT whatsapp_message_analytics_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_message_flags whatsapp_message_flags_message_row_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_message_flags
    ADD CONSTRAINT whatsapp_message_flags_message_row_id_fkey FOREIGN KEY (message_row_id) REFERENCES public.whatsapp_messages(id) ON DELETE CASCADE;


--
-- Name: whatsapp_message_flags whatsapp_message_flags_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_message_flags
    ADD CONSTRAINT whatsapp_message_flags_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_message_templates whatsapp_message_templates_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_message_templates
    ADD CONSTRAINT whatsapp_message_templates_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_messages whatsapp_messages_revoked_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_messages
    ADD CONSTRAINT whatsapp_messages_revoked_by_fkey FOREIGN KEY (revoked_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: whatsapp_messages whatsapp_messages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_messages
    ADD CONSTRAINT whatsapp_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_pipelines whatsapp_pipelines_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_pipelines
    ADD CONSTRAINT whatsapp_pipelines_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: whatsapp_quick_replies whatsapp_quick_replies_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_quick_replies
    ADD CONSTRAINT whatsapp_quick_replies_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_quick_reply_usage whatsapp_quick_reply_usage_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_quick_reply_usage
    ADD CONSTRAINT whatsapp_quick_reply_usage_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_scheduled_messages whatsapp_scheduled_messages_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_scheduled_messages
    ADD CONSTRAINT whatsapp_scheduled_messages_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: whatsapp_pipeline_stages whatsapp_stages_pipeline_workspace_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_pipeline_stages
    ADD CONSTRAINT whatsapp_stages_pipeline_workspace_fkey FOREIGN KEY (pipeline_id, workspace_id) REFERENCES public.whatsapp_pipelines(id, workspace_id) ON DELETE CASCADE;


--
-- Name: whatsapp_webhooks whatsapp_webhooks_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.whatsapp_webhooks
    ADD CONSTRAINT whatsapp_webhooks_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: workflow_comments workflow_comments_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_comments
    ADD CONSTRAINT workflow_comments_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON DELETE CASCADE;


--
-- Name: workflow_executions workflow_executions_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_executions
    ADD CONSTRAINT workflow_executions_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON DELETE CASCADE;


--
-- Name: workflow_schedules workflow_schedules_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_schedules
    ADD CONSTRAINT workflow_schedules_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON DELETE CASCADE;


--
-- Name: workflow_versions workflow_versions_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_versions
    ADD CONSTRAINT workflow_versions_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON DELETE CASCADE;


--
-- Name: workflow_webhooks workflow_webhooks_workflow_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workflow_webhooks
    ADD CONSTRAINT workflow_webhooks_workflow_id_fkey FOREIGN KEY (workflow_id) REFERENCES public.workflows(id) ON DELETE CASCADE;


--
-- Name: workspace_invitations workspace_invitations_accepted_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_accepted_by_fkey FOREIGN KEY (accepted_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: workspace_invitations workspace_invitations_invited_by_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_invited_by_fkey FOREIGN KEY (invited_by) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: workspace_invitations workspace_invitations_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_invitations
    ADD CONSTRAINT workspace_invitations_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspace_members workspace_members_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: workspace_members workspace_members_workspace_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspace_members
    ADD CONSTRAINT workspace_members_workspace_id_fkey FOREIGN KEY (workspace_id) REFERENCES public.workspaces(id) ON DELETE CASCADE;


--
-- Name: workspaces workspaces_owner_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.workspaces
    ADD CONSTRAINT workspaces_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES auth.users(id) ON DELETE CASCADE;


--
-- Name: prefixes prefixes_bucketId_fkey; Type: FK CONSTRAINT; Schema: storage; Owner: -
--

ALTER TABLE ONLY storage.prefixes
    ADD CONSTRAINT "prefixes_bucketId_fkey" FOREIGN KEY (bucket_id) REFERENCES storage.buckets(id);


--
-- Name: audit_log_entries; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.audit_log_entries ENABLE ROW LEVEL SECURITY;

--
-- Name: flow_state; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.flow_state ENABLE ROW LEVEL SECURITY;

--
-- Name: identities; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.identities ENABLE ROW LEVEL SECURITY;

--
-- Name: instances; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.instances ENABLE ROW LEVEL SECURITY;

--
-- Name: mfa_amr_claims; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.mfa_amr_claims ENABLE ROW LEVEL SECURITY;

--
-- Name: mfa_challenges; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.mfa_challenges ENABLE ROW LEVEL SECURITY;

--
-- Name: mfa_factors; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.mfa_factors ENABLE ROW LEVEL SECURITY;

--
-- Name: oauth_clients; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.oauth_clients ENABLE ROW LEVEL SECURITY;

--
-- Name: oauth_consents; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.oauth_consents ENABLE ROW LEVEL SECURITY;

--
-- Name: one_time_tokens; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.one_time_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: refresh_tokens; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.refresh_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: saml_providers; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.saml_providers ENABLE ROW LEVEL SECURITY;

--
-- Name: saml_relay_states; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.saml_relay_states ENABLE ROW LEVEL SECURITY;

--
-- Name: schema_migrations; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.schema_migrations ENABLE ROW LEVEL SECURITY;

--
-- Name: sessions; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: sso_domains; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.sso_domains ENABLE ROW LEVEL SECURITY;

--
-- Name: sso_providers; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.sso_providers ENABLE ROW LEVEL SECURITY;

--
-- Name: users; Type: ROW SECURITY; Schema: auth; Owner: -
--

ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;

--
-- Name: email_drafts Admins can create their own drafts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can create their own drafts" ON public.email_drafts FOR INSERT WITH CHECK (((auth.uid() = admin_id) AND (EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role))))));


--
-- Name: app_credentials Admins can delete app credentials; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete app credentials" ON public.app_credentials FOR DELETE TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: coupons Admins can delete coupons; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete coupons" ON public.coupons FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: admin_inbox_messages Admins can delete inbox messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete inbox messages" ON public.admin_inbox_messages FOR DELETE USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: launch_checklist Admins can delete items; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete items" ON public.launch_checklist FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: media_file_providers Admins can delete media file providers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete media file providers" ON public.media_file_providers FOR DELETE USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: system_notifications Admins can delete notifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete notifications" ON public.system_notifications FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: user_roles Admins can delete roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete roles" ON public.user_roles FOR DELETE USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: email_drafts Admins can delete their own drafts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can delete their own drafts" ON public.email_drafts FOR DELETE USING (((auth.uid() = admin_id) AND (EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role))))));


--
-- Name: app_credentials Admins can insert app credentials; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert app credentials" ON public.app_credentials FOR INSERT TO authenticated WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: feature_flag_audit_log Admins can insert audit log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert audit log" ON public.feature_flag_audit_log FOR INSERT WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: coupons Admins can insert coupons; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert coupons" ON public.coupons FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: deployment_logs Admins can insert deployment logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert deployment logs" ON public.deployment_logs FOR INSERT WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: admin_inbox_messages Admins can insert inbox messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert inbox messages" ON public.admin_inbox_messages FOR INSERT WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: launch_checklist Admins can insert items; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert items" ON public.launch_checklist FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: media_file_providers Admins can insert media file providers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert media file providers" ON public.media_file_providers FOR INSERT WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: system_notifications Admins can insert notifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert notifications" ON public.system_notifications FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: user_roles Admins can insert roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can insert roles" ON public.user_roles FOR INSERT WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: observability_alert_configs Admins can manage alert configs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage alert configs" ON public.observability_alert_configs USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: user_feature_overrides Admins can manage all feature overrides; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage all feature overrides" ON public.user_feature_overrides USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: threads_mentions Admins can manage all threads mentions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage all threads mentions" ON public.threads_mentions TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: blog_posts Admins can manage blog posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage blog posts" ON public.blog_posts USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: email_contacts Admins can manage contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage contacts" ON public.email_contacts USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: log_analyses Admins can manage log analyses; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage log analyses" ON public.log_analyses TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: support_messages Admins can manage messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage messages" ON public.support_messages USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: observability_metrics Admins can manage metrics; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage metrics" ON public.observability_metrics USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: admin_notifications Admins can manage notifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage notifications" ON public.admin_notifications USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: oauth_apps Admins can manage oauth_apps; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage oauth_apps" ON public.oauth_apps TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: subscription_plans Admins can manage plans; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage plans" ON public.subscription_plans USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: provider_api_keys Admins can manage provider_api_keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage provider_api_keys" ON public.provider_api_keys TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: user_quotas Admins can manage quotas; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage quotas" ON public.user_quotas USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: rate_limit_settings Admins can manage rate limit settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage rate limit settings" ON public.rate_limit_settings TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: scheduled_emails Admins can manage scheduled emails; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage scheduled emails" ON public.scheduled_emails USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: feature_flag_schedules Admins can manage schedules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage schedules" ON public.feature_flag_schedules USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: app_settings Admins can manage settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage settings" ON public.app_settings USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: email_signatures Admins can manage signatures; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage signatures" ON public.email_signatures USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: user_subscriptions Admins can manage subscriptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage subscriptions" ON public.user_subscriptions USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: email_templates Admins can manage templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage templates" ON public.email_templates TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: workflow_templates Admins can manage templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage templates" ON public.workflow_templates USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: tier_rate_limits Admins can manage tier rate limits; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage tier rate limits" ON public.tier_rate_limits USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: user_ai_model_overrides Admins can manage user AI model overrides; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage user AI model overrides" ON public.user_ai_model_overrides USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: user_rate_limits Admins can manage user rate limits; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can manage user rate limits" ON public.user_rate_limits TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: ticket_messages Admins can post messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can post messages" ON public.ticket_messages FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = ANY (ARRAY['admin'::public.app_role, 'support'::public.app_role]))))));


--
-- Name: system_logs Admins can read system logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can read system logs" ON public.system_logs FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: app_credentials Admins can update app credentials; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update app credentials" ON public.app_credentials FOR UPDATE TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: launch_checklist Admins can update checklist; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update checklist" ON public.launch_checklist FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: coupons Admins can update coupons; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update coupons" ON public.coupons FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: deployment_logs Admins can update deployment logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update deployment logs" ON public.deployment_logs FOR UPDATE USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: admin_inbox_messages Admins can update inbox messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update inbox messages" ON public.admin_inbox_messages FOR UPDATE USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: media_file_providers Admins can update media file providers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update media file providers" ON public.media_file_providers FOR UPDATE USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: system_notifications Admins can update notifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update notifications" ON public.system_notifications FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: user_roles Admins can update roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update roles" ON public.user_roles FOR UPDATE USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: email_drafts Admins can update their own drafts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update their own drafts" ON public.email_drafts FOR UPDATE USING (((auth.uid() = admin_id) AND (EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role))))));


--
-- Name: support_tickets Admins can update tickets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can update tickets" ON public.support_tickets FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = ANY (ARRAY['admin'::public.app_role, 'support'::public.app_role]))))));


--
-- Name: ticket_activities Admins can view activities; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view activities" ON public.ticket_activities FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = ANY (ARRAY['admin'::public.app_role, 'support'::public.app_role]))))));


--
-- Name: observability_alert_history Admins can view alert history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view alert history" ON public.observability_alert_history USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: comment_inbox_cache Admins can view all comments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all comments" ON public.comment_inbox_cache FOR SELECT USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: coupons Admins can view all coupons; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all coupons" ON public.coupons FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: workflow_executions Admins can view all executions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all executions" ON public.workflow_executions FOR SELECT USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: admin_inbox_messages Admins can view all inbox messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all inbox messages" ON public.admin_inbox_messages FOR SELECT USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: lead_forms Admins can view all lead forms; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all lead forms" ON public.lead_forms FOR SELECT USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: leads Admins can view all leads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all leads" ON public.leads FOR SELECT USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: email_log Admins can view all logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all logs" ON public.email_log FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: media_file_providers Admins can view all media file providers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all media file providers" ON public.media_file_providers FOR SELECT USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: media_files Admins can view all media files; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all media files" ON public.media_files FOR SELECT USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: media_folders Admins can view all media folders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all media folders" ON public.media_folders FOR SELECT USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: media_operations_history Admins can view all media operations history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all media operations history" ON public.media_operations_history FOR SELECT USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: ticket_messages Admins can view all messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all messages" ON public.ticket_messages FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = ANY (ARRAY['admin'::public.app_role, 'support'::public.app_role]))))));


--
-- Name: node_execution_logs Admins can view all node logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all node logs" ON public.node_execution_logs FOR SELECT USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: system_notifications Admins can view all notifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all notifications" ON public.system_notifications FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: platform_posts Admins can view all platform posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all platform posts" ON public.platform_posts FOR SELECT USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: posts Admins can view all posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all posts" ON public.posts FOR SELECT USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: profiles Admins can view all profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all profiles" ON public.profiles FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: notification_reads Admins can view all read status; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all read status" ON public.notification_reads FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: coupon_redemptions Admins can view all redemptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all redemptions" ON public.coupon_redemptions FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: token_refresh_history Admins can view all refresh history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all refresh history" ON public.token_refresh_history FOR SELECT USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: threads_reply_cache Admins can view all reply cache; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all reply cache" ON public.threads_reply_cache FOR SELECT USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: user_roles Admins can view all roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all roles" ON public.user_roles FOR SELECT USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: social_accounts Admins can view all social accounts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all social accounts" ON public.social_accounts FOR SELECT USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: social_profiles Admins can view all social profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all social profiles" ON public.social_profiles FOR SELECT USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: support_tickets Admins can view all tickets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all tickets" ON public.support_tickets FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = ANY (ARRAY['admin'::public.app_role, 'support'::public.app_role]))))));


--
-- Name: user_quotas Admins can view all user quotas; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all user quotas" ON public.user_quotas FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: user_rate_limits Admins can view all user rate limits; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all user rate limits" ON public.user_rate_limits FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: workflows Admins can view all workflows; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view all workflows" ON public.workflows FOR SELECT USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: app_credentials Admins can view app credentials; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view app credentials" ON public.app_credentials FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: feature_flag_audit_log Admins can view audit log; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view audit log" ON public.feature_flag_audit_log FOR SELECT USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: admin_audit_log Admins can view audit logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view audit logs" ON public.admin_audit_log FOR SELECT USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: launch_checklist Admins can view checklist; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view checklist" ON public.launch_checklist FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: deployment_logs Admins can view deployment logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view deployment logs" ON public.deployment_logs FOR SELECT USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: edge_function_status Admins can view edge function status; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view edge function status" ON public.edge_function_status FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: observability_health_snapshots Admins can view health snapshots; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view health snapshots" ON public.observability_health_snapshots USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: system_health_snapshots Admins can view health snapshots; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view health snapshots" ON public.system_health_snapshots FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: system_logs Admins can view system logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view system logs" ON public.system_logs FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: email_drafts Admins can view their own drafts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins can view their own drafts" ON public.email_drafts FOR SELECT USING (((auth.uid() = admin_id) AND (EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role))))));


--
-- Name: bi_post_content Admins full access bi_post_content; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins full access bi_post_content" ON public.bi_post_content TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: oauth_redirect_requests Admins full access on redirect requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins full access on redirect requests" ON public.oauth_redirect_requests TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: ai_knowledge_entities Admins manage all ai knowledge entities; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage all ai knowledge entities" ON public.ai_knowledge_entities TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: ai_knowledge_graph_exports Admins manage all ai knowledge graph exports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage all ai knowledge graph exports" ON public.ai_knowledge_graph_exports TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: ai_knowledge_relations Admins manage all ai knowledge relations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins manage all ai knowledge relations" ON public.ai_knowledge_relations TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: ai_providers Admins read AI providers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins read AI providers" ON public.ai_providers FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: system_settings Admins read system settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins read system settings" ON public.system_settings FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: webhook_unmatched_observations Admins view unmatched observations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Admins view unmatched observations" ON public.webhook_unmatched_observations FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: whatsapp_conversation_assignments Agents can create assignments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Agents can create assignments" ON public.whatsapp_conversation_assignments FOR INSERT TO authenticated WITH CHECK ((auth.uid() = assigned_by));


--
-- Name: system_notifications All users can view active notifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "All users can view active notifications" ON public.system_notifications FOR SELECT TO authenticated USING (((published_at <= now()) AND ((expires_at IS NULL) OR (expires_at > now())) AND ((target_type = 'all'::text) OR ((target_type = 'role'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND ((user_roles.role)::text = ANY (system_notifications.target_roles)))))) OR ((target_type = 'user'::text) AND (auth.uid() = ANY (target_users))))));


--
-- Name: subscription_plans Anyone can view active plans; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view active plans" ON public.subscription_plans FOR SELECT USING ((is_active = true));


--
-- Name: workflow_templates Anyone can view active templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view active templates" ON public.workflow_templates FOR SELECT USING ((is_active = true));


--
-- Name: social_profiles Anyone can view public profiles by share token; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view public profiles by share token" ON public.social_profiles FOR SELECT USING ((is_public = true));


--
-- Name: blog_posts Anyone can view published blog posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Anyone can view published blog posts" ON public.blog_posts FOR SELECT USING ((status = 'published'::text));


--
-- Name: whatsapp_conversation_assignments Assigners can update assignments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Assigners can update assignments" ON public.whatsapp_conversation_assignments FOR UPDATE TO authenticated USING (((auth.uid() = assigned_by) OR (agent_id IN ( SELECT whatsapp_agents.id
   FROM public.whatsapp_agents
  WHERE (whatsapp_agents.user_id = auth.uid())))));


--
-- Name: mcp_oauth_clients Authenticated can read mcp clients; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated can read mcp clients" ON public.mcp_oauth_clients FOR SELECT TO authenticated USING (true);


--
-- Name: app_settings Authenticated can read public settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated can read public settings" ON public.app_settings FOR SELECT TO authenticated USING (((key = ANY (ARRAY['app_name'::text, 'app_logo'::text, 'app_favicon'::text, 'default_plan'::text, 'feature_flag_categories'::text, 'META_WHATSAPP_CONFIG_ID'::text, 'META_WHATSAPP_COEXISTENCE_CONFIG_ID'::text, 'WHATSAPP_TP_STATUS'::text, 'app_theme'::text, 'dark_theme_variant'::text])) OR (key ~~ like_escape('feature\_%'::text, '\'::text))));


--
-- Name: tier_rate_limits Authenticated users can read tier limits; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can read tier limits" ON public.tier_rate_limits FOR SELECT USING ((auth.uid() IS NOT NULL));


--
-- Name: oauth_apps Authenticated users can view active oauth apps; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view active oauth apps" ON public.oauth_apps FOR SELECT TO authenticated USING ((is_active = true));


--
-- Name: admin_notifications Authenticated users can view notifications; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view notifications" ON public.admin_notifications FOR SELECT USING ((auth.uid() IS NOT NULL));


--
-- Name: rate_limit_settings Authenticated users can view rate limit settings; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Authenticated users can view rate limit settings" ON public.rate_limit_settings FOR SELECT TO authenticated USING (true);


--
-- Name: email_templates Everyone can view active templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Everyone can view active templates" ON public.email_templates FOR SELECT TO authenticated USING ((is_active = true));


--
-- Name: whatsapp_agents Read own agent profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Read own agent profile" ON public.whatsapp_agents FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR public.has_role(auth.uid(), 'admin'::public.app_role)));


--
-- Name: whatsapp_assignment_history Read own assignment history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Read own assignment history" ON public.whatsapp_assignment_history FOR SELECT TO authenticated USING (((performed_by = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.whatsapp_agents a
  WHERE (((a.id = whatsapp_assignment_history.from_agent_id) OR (a.id = whatsapp_assignment_history.to_agent_id)) AND (a.user_id = auth.uid())))) OR public.has_role(auth.uid(), 'admin'::public.app_role)));


--
-- Name: whatsapp_conversation_assignments Read own conversation assignments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Read own conversation assignments" ON public.whatsapp_conversation_assignments FOR SELECT TO authenticated USING (((assigned_by = auth.uid()) OR (EXISTS ( SELECT 1
   FROM public.whatsapp_agents a
  WHERE ((a.id = whatsapp_conversation_assignments.agent_id) AND (a.user_id = auth.uid())))) OR public.has_role(auth.uid(), 'admin'::public.app_role)));


--
-- Name: messenger_auto_reply_usage Service role can insert messenger auto reply usage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Service role can insert messenger auto reply usage" ON public.messenger_auto_reply_usage FOR INSERT WITH CHECK (true);


--
-- Name: edge_function_status System can insert edge function status; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "System can insert edge function status" ON public.edge_function_status FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: system_health_snapshots System can insert health snapshots; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "System can insert health snapshots" ON public.system_health_snapshots FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role)))));


--
-- Name: whatsapp_contact_group_members Users can add to own groups; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can add to own groups" ON public.whatsapp_contact_group_members FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.whatsapp_contact_groups g
  WHERE ((g.id = whatsapp_contact_group_members.group_id) AND (g.user_id = auth.uid())))));


--
-- Name: workflow_comments Users can create comments on own workflows; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create comments on own workflows" ON public.workflow_comments FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.workflows w
  WHERE ((w.id = workflow_comments.workflow_id) AND (w.user_id = auth.uid())))));


--
-- Name: whatsapp_assignment_history Users can create history entries; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create history entries" ON public.whatsapp_assignment_history FOR INSERT TO authenticated WITH CHECK ((auth.uid() = performed_by));


--
-- Name: support_messages Users can create messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create messages" ON public.support_messages FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: whatsapp_broadcasts Users can create own broadcasts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create own broadcasts" ON public.whatsapp_broadcasts FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));


--
-- Name: user_connectors Users can create own connectors; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create own connectors" ON public.user_connectors FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: workflow_executions Users can create own executions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create own executions" ON public.workflow_executions FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: whatsapp_contact_groups Users can create own groups; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create own groups" ON public.whatsapp_contact_groups FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: user_notification_preferences Users can create own notification prefs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create own notification prefs" ON public.user_notification_preferences FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: workflow_schedules Users can create own schedules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create own schedules" ON public.workflow_schedules FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: post_templates Users can create own templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create own templates" ON public.post_templates FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: workflow_webhooks Users can create own webhooks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create own webhooks" ON public.workflow_webhooks FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: workflow_versions Users can create own workflow versions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create own workflow versions" ON public.workflow_versions FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.workflows w
  WHERE ((w.id = workflow_versions.workflow_id) AND (w.user_id = auth.uid())))));


--
-- Name: workflows Users can create own workflows; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create own workflows" ON public.workflows FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: oauth_redirect_requests Users can create requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create requests" ON public.oauth_redirect_requests FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));


--
-- Name: media_folders Users can create their own folders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create their own folders" ON public.media_folders FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: video_processing_presets Users can create their own presets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create their own presets" ON public.video_processing_presets FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: image_reference_presets Users can create their own reference presets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create their own reference presets" ON public.image_reference_presets FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: referrals Users can create their own referral codes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create their own referral codes" ON public.referrals FOR INSERT WITH CHECK ((auth.uid() = referrer_id));


--
-- Name: whatsapp_message_templates Users can create their own templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create their own templates" ON public.whatsapp_message_templates FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: whatsapp_webhooks Users can create their own webhooks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create their own webhooks" ON public.whatsapp_webhooks FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: support_tickets Users can create tickets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can create tickets" ON public.support_tickets FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));


--
-- Name: whatsapp_broadcasts Users can delete own broadcasts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own broadcasts" ON public.whatsapp_broadcasts FOR DELETE TO authenticated USING ((auth.uid() = user_id));


--
-- Name: workflow_comments Users can delete own comments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own comments" ON public.workflow_comments FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: user_connectors Users can delete own connectors; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own connectors" ON public.user_connectors FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: whatsapp_contact_groups Users can delete own groups; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own groups" ON public.whatsapp_contact_groups FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: media_file_providers Users can delete own media file providers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own media file providers" ON public.media_file_providers FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.media_files
  WHERE ((media_files.id = media_file_providers.media_file_id) AND (auth.uid() = media_files.user_id)))));


--
-- Name: media_files Users can delete own media files; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own media files" ON public.media_files FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: user_notification_preferences Users can delete own notification prefs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own notification prefs" ON public.user_notification_preferences FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: platform_posts Users can delete own platform posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own platform posts" ON public.platform_posts FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.posts
  WHERE ((posts.id = platform_posts.post_id) AND (posts.user_id = auth.uid())))));


--
-- Name: posts Users can delete own posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own posts" ON public.posts FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: workflow_schedules Users can delete own schedules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own schedules" ON public.workflow_schedules FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: social_accounts Users can delete own social accounts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own social accounts" ON public.social_accounts FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: social_profiles Users can delete own social profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own social profiles" ON public.social_profiles FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: saved_field_suggestions Users can delete own suggestions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own suggestions" ON public.saved_field_suggestions FOR DELETE TO authenticated USING ((auth.uid() = user_id));


--
-- Name: post_templates Users can delete own templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own templates" ON public.post_templates FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: threads_mentions Users can delete own threads mentions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own threads mentions" ON public.threads_mentions FOR DELETE TO authenticated USING ((auth.uid() = user_id));


--
-- Name: workflow_webhooks Users can delete own webhooks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own webhooks" ON public.workflow_webhooks FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: workflows Users can delete own workflows; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete own workflows" ON public.workflows FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: whatsapp_broadcast_recipients Users can delete recipients of own broadcasts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete recipients of own broadcasts" ON public.whatsapp_broadcast_recipients FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.whatsapp_broadcasts
  WHERE ((whatsapp_broadcasts.id = whatsapp_broadcast_recipients.broadcast_id) AND (whatsapp_broadcasts.user_id = auth.uid())))));


--
-- Name: caption_history Users can delete their own caption history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own caption history" ON public.caption_history FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: comment_inbox_cache Users can delete their own comments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own comments" ON public.comment_inbox_cache FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: media_folders Users can delete their own folders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own folders" ON public.media_folders FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: lead_forms Users can delete their own lead forms; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own lead forms" ON public.lead_forms FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: leads Users can delete their own leads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own leads" ON public.leads FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: media_operations_history Users can delete their own media operations history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own media operations history" ON public.media_operations_history FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: video_processing_presets Users can delete their own presets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own presets" ON public.video_processing_presets FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: threads_recent_searches Users can delete their own recent searches; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own recent searches" ON public.threads_recent_searches FOR DELETE TO authenticated USING ((user_id = auth.uid()));


--
-- Name: image_reference_presets Users can delete their own reference presets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own reference presets" ON public.image_reference_presets FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: threads_reply_cache Users can delete their own reply cache; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own reply cache" ON public.threads_reply_cache FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: whatsapp_message_templates Users can delete their own templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own templates" ON public.whatsapp_message_templates FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: whatsapp_webhooks Users can delete their own webhooks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can delete their own webhooks" ON public.whatsapp_webhooks FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: whatsapp_message_analytics Users can insert own analytics; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own analytics" ON public.whatsapp_message_analytics FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: api_logs Users can insert own api logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own api logs" ON public.api_logs FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: user_blog_post_reads Users can insert own blog reads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own blog reads" ON public.user_blog_post_reads FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: media_file_providers Users can insert own media file providers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own media file providers" ON public.media_file_providers FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.media_files
  WHERE ((media_files.id = media_file_providers.media_file_id) AND (auth.uid() = media_files.user_id)))));


--
-- Name: media_files Users can insert own media files; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own media files" ON public.media_files FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: platform_posts Users can insert own platform posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own platform posts" ON public.platform_posts FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
   FROM public.posts
  WHERE ((posts.id = platform_posts.post_id) AND (posts.user_id = auth.uid())))));


--
-- Name: posts Users can insert own posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own posts" ON public.posts FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: profiles Users can insert own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK ((auth.uid() = id));


--
-- Name: whatsapp_quick_reply_usage Users can insert own quick reply usage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own quick reply usage" ON public.whatsapp_quick_reply_usage FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: user_notification_reads Users can insert own reads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own reads" ON public.user_notification_reads FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: social_accounts Users can insert own social accounts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own social accounts" ON public.social_accounts FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: social_profiles Users can insert own social profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own social profiles" ON public.social_profiles FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: saved_field_suggestions Users can insert own suggestions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own suggestions" ON public.saved_field_suggestions FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));


--
-- Name: threads_mentions Users can insert own threads mentions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert own threads mentions" ON public.threads_mentions FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));


--
-- Name: whatsapp_broadcast_recipients Users can insert recipients for own broadcasts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert recipients for own broadcasts" ON public.whatsapp_broadcast_recipients FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
   FROM public.whatsapp_broadcasts
  WHERE ((whatsapp_broadcasts.id = whatsapp_broadcast_recipients.broadcast_id) AND (whatsapp_broadcasts.user_id = auth.uid())))));


--
-- Name: caption_history Users can insert their own caption history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own caption history" ON public.caption_history FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: comment_inbox_cache Users can insert their own comments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own comments" ON public.comment_inbox_cache FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: lead_forms Users can insert their own lead forms; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own lead forms" ON public.lead_forms FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: leads Users can insert their own leads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own leads" ON public.leads FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: media_operations_history Users can insert their own media operations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own media operations" ON public.media_operations_history FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: whatsapp_messages Users can insert their own messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own messages" ON public.whatsapp_messages FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: notification_reads Users can insert their own read status; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own read status" ON public.notification_reads FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));


--
-- Name: threads_recent_searches Users can insert their own recent searches; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own recent searches" ON public.threads_recent_searches FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));


--
-- Name: threads_reply_cache Users can insert their own reply cache; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can insert their own reply cache" ON public.threads_reply_cache FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: ticket_messages Users can post messages on their tickets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can post messages on their tickets" ON public.ticket_messages FOR INSERT TO authenticated WITH CHECK (((user_id = auth.uid()) AND (EXISTS ( SELECT 1
   FROM public.support_tickets
  WHERE ((support_tickets.id = ticket_messages.ticket_id) AND (support_tickets.user_id = auth.uid()))))));


--
-- Name: whatsapp_contact_group_members Users can remove from own groups; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can remove from own groups" ON public.whatsapp_contact_group_members FOR DELETE USING ((EXISTS ( SELECT 1
   FROM public.whatsapp_contact_groups g
  WHERE ((g.id = whatsapp_contact_group_members.group_id) AND (g.user_id = auth.uid())))));


--
-- Name: mcp_oauth_tokens Users can revoke their own mcp tokens; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can revoke their own mcp tokens" ON public.mcp_oauth_tokens FOR UPDATE TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: whatsapp_message_analytics Users can update own analytics; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own analytics" ON public.whatsapp_message_analytics FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: whatsapp_broadcasts Users can update own broadcasts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own broadcasts" ON public.whatsapp_broadcasts FOR UPDATE TO authenticated USING ((auth.uid() = user_id));


--
-- Name: workflow_comments Users can update own comments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own comments" ON public.workflow_comments FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: user_connectors Users can update own connectors; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own connectors" ON public.user_connectors FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: workflow_executions Users can update own executions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own executions" ON public.workflow_executions FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: whatsapp_contact_groups Users can update own groups; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own groups" ON public.whatsapp_contact_groups FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: media_file_providers Users can update own media file providers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own media file providers" ON public.media_file_providers FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.media_files
  WHERE ((media_files.id = media_file_providers.media_file_id) AND (auth.uid() = media_files.user_id))))) WITH CHECK ((EXISTS ( SELECT 1
   FROM public.media_files
  WHERE ((media_files.id = media_file_providers.media_file_id) AND (auth.uid() = media_files.user_id)))));


--
-- Name: media_files Users can update own media files; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own media files" ON public.media_files FOR UPDATE USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: user_notification_preferences Users can update own notification prefs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own notification prefs" ON public.user_notification_preferences FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: platform_posts Users can update own platform posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own platform posts" ON public.platform_posts FOR UPDATE USING ((EXISTS ( SELECT 1
   FROM public.posts
  WHERE ((posts.id = platform_posts.post_id) AND (posts.user_id = auth.uid())))));


--
-- Name: posts Users can update own posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own posts" ON public.posts FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: profiles Users can update own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE TO authenticated USING ((auth.uid() = id)) WITH CHECK ((auth.uid() = id));


--
-- Name: workflow_schedules Users can update own schedules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own schedules" ON public.workflow_schedules FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: social_accounts Users can update own social accounts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own social accounts" ON public.social_accounts FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: social_profiles Users can update own social profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own social profiles" ON public.social_profiles FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: saved_field_suggestions Users can update own suggestions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own suggestions" ON public.saved_field_suggestions FOR UPDATE TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: post_templates Users can update own templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own templates" ON public.post_templates FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: threads_mentions Users can update own threads mentions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own threads mentions" ON public.threads_mentions FOR UPDATE TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: workflow_webhooks Users can update own webhooks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own webhooks" ON public.workflow_webhooks FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: workflows Users can update own workflows; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update own workflows" ON public.workflows FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: whatsapp_broadcast_recipients Users can update recipients of own broadcasts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update recipients of own broadcasts" ON public.whatsapp_broadcast_recipients FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.whatsapp_broadcasts
  WHERE ((whatsapp_broadcasts.id = whatsapp_broadcast_recipients.broadcast_id) AND (whatsapp_broadcasts.user_id = auth.uid())))));


--
-- Name: caption_history Users can update their own caption history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own caption history" ON public.caption_history FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: comment_inbox_cache Users can update their own comments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own comments" ON public.comment_inbox_cache FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: media_folders Users can update their own folders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own folders" ON public.media_folders FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: lead_forms Users can update their own lead forms; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own lead forms" ON public.lead_forms FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: leads Users can update their own leads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own leads" ON public.leads FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: media_operations_history Users can update their own media operations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own media operations" ON public.media_operations_history FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: video_processing_presets Users can update their own presets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own presets" ON public.video_processing_presets FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: notification_reads Users can update their own read status; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own read status" ON public.notification_reads FOR UPDATE TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: image_reference_presets Users can update their own reference presets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own reference presets" ON public.image_reference_presets FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: referrals Users can update their own referrals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own referrals" ON public.referrals FOR UPDATE USING ((auth.uid() = referrer_id)) WITH CHECK ((auth.uid() = referrer_id));


--
-- Name: threads_reply_cache Users can update their own reply cache; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own reply cache" ON public.threads_reply_cache FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: whatsapp_message_templates Users can update their own templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own templates" ON public.whatsapp_message_templates FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: whatsapp_webhooks Users can update their own webhooks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update their own webhooks" ON public.whatsapp_webhooks FOR UPDATE USING ((auth.uid() = user_id));


--
-- Name: support_tickets Users can update ticket status to closed; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can update ticket status to closed" ON public.support_tickets FOR UPDATE TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((status = 'closed'::text));


--
-- Name: coupons Users can view active coupons; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view active coupons" ON public.coupons FOR SELECT TO authenticated USING (((is_active = true) AND (valid_from <= now()) AND ((expires_at IS NULL) OR (expires_at > now()))));


--
-- Name: ticket_activities Users can view activities on their tickets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view activities on their tickets" ON public.ticket_activities FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.support_tickets
  WHERE ((support_tickets.id = ticket_activities.ticket_id) AND (support_tickets.user_id = auth.uid())))));


--
-- Name: ticket_messages Users can view messages on their tickets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view messages on their tickets" ON public.ticket_messages FOR SELECT TO authenticated USING (((is_internal = false) AND (EXISTS ( SELECT 1
   FROM public.support_tickets
  WHERE ((support_tickets.id = ticket_messages.ticket_id) AND (support_tickets.user_id = auth.uid()))))));


--
-- Name: whatsapp_message_analytics Users can view own analytics; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own analytics" ON public.whatsapp_message_analytics FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: api_logs Users can view own api logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own api logs" ON public.api_logs FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: whatsapp_auto_reply_usage Users can view own auto reply usage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own auto reply usage" ON public.whatsapp_auto_reply_usage FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: user_blog_post_reads Users can view own blog reads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own blog reads" ON public.user_blog_post_reads FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: whatsapp_broadcasts Users can view own broadcasts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own broadcasts" ON public.whatsapp_broadcasts FOR SELECT TO authenticated USING ((auth.uid() = user_id));


--
-- Name: user_connectors Users can view own connectors; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own connectors" ON public.user_connectors FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: workflow_executions Users can view own executions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own executions" ON public.workflow_executions FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: whatsapp_contact_group_members Users can view own group members; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own group members" ON public.whatsapp_contact_group_members FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.whatsapp_contact_groups g
  WHERE ((g.id = whatsapp_contact_group_members.group_id) AND (g.user_id = auth.uid())))));


--
-- Name: whatsapp_contact_groups Users can view own groups; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own groups" ON public.whatsapp_contact_groups FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: media_file_providers Users can view own media file providers; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own media file providers" ON public.media_file_providers FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.media_files
  WHERE ((media_files.id = media_file_providers.media_file_id) AND (auth.uid() = media_files.user_id)))));


--
-- Name: media_files Users can view own media files; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own media files" ON public.media_files FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: support_messages Users can view own messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own messages" ON public.support_messages FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: messenger_auto_reply_usage Users can view own messenger auto reply usage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own messenger auto reply usage" ON public.messenger_auto_reply_usage FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: node_execution_logs Users can view own node logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own node logs" ON public.node_execution_logs FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.workflow_executions we
  WHERE ((we.id = node_execution_logs.execution_id) AND (we.user_id = auth.uid())))));


--
-- Name: user_notification_preferences Users can view own notification prefs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own notification prefs" ON public.user_notification_preferences FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: platform_posts Users can view own platform posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own platform posts" ON public.platform_posts FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.posts
  WHERE ((posts.id = platform_posts.post_id) AND (posts.user_id = auth.uid())))));


--
-- Name: posts Users can view own posts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own posts" ON public.posts FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: profiles Users can view own profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own profile" ON public.profiles FOR SELECT TO authenticated USING ((auth.uid() = id));


--
-- Name: whatsapp_quick_reply_usage Users can view own quick reply usage; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own quick reply usage" ON public.whatsapp_quick_reply_usage FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: user_quotas Users can view own quotas; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own quotas" ON public.user_quotas FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: user_notification_reads Users can view own reads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own reads" ON public.user_notification_reads FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: oauth_redirect_requests Users can view own requests; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own requests" ON public.oauth_redirect_requests FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: user_roles Users can view own roles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own roles" ON public.user_roles FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: workflow_schedules Users can view own schedules; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own schedules" ON public.workflow_schedules FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: social_accounts Users can view own social accounts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own social accounts" ON public.social_accounts FOR SELECT TO authenticated USING ((user_id = ( SELECT auth.uid() AS uid)));


--
-- Name: social_inbox_events Users can view own social inbox events; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own social inbox events" ON public.social_inbox_events FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: social_profiles Users can view own social profiles; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own social profiles" ON public.social_profiles FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: user_subscriptions Users can view own subscriptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own subscriptions" ON public.user_subscriptions FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: saved_field_suggestions Users can view own suggestions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own suggestions" ON public.saved_field_suggestions FOR SELECT TO authenticated USING ((auth.uid() = user_id));


--
-- Name: post_templates Users can view own templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own templates" ON public.post_templates FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: threads_mentions Users can view own threads mentions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own threads mentions" ON public.threads_mentions FOR SELECT TO authenticated USING ((auth.uid() = user_id));


--
-- Name: workflow_webhooks Users can view own webhooks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own webhooks" ON public.workflow_webhooks FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: workflow_comments Users can view own workflow comments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own workflow comments" ON public.workflow_comments FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.workflows w
  WHERE ((w.id = workflow_comments.workflow_id) AND (w.user_id = auth.uid())))));


--
-- Name: workflow_versions Users can view own workflow versions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own workflow versions" ON public.workflow_versions FOR SELECT USING ((EXISTS ( SELECT 1
   FROM public.workflows w
  WHERE ((w.id = workflow_versions.workflow_id) AND (w.user_id = auth.uid())))));


--
-- Name: workflows Users can view own workflows; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view own workflows" ON public.workflows FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: workflows Users can view public workflows; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view public workflows" ON public.workflows FOR SELECT USING ((is_public = true));


--
-- Name: whatsapp_broadcast_recipients Users can view recipients of own broadcasts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view recipients of own broadcasts" ON public.whatsapp_broadcast_recipients FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.whatsapp_broadcasts
  WHERE ((whatsapp_broadcasts.id = whatsapp_broadcast_recipients.broadcast_id) AND (whatsapp_broadcasts.user_id = auth.uid())))));


--
-- Name: user_ai_model_overrides Users can view their own AI model override; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own AI model override" ON public.user_ai_model_overrides FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: caption_history Users can view their own caption history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own caption history" ON public.caption_history FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: comment_inbox_cache Users can view their own comments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own comments" ON public.comment_inbox_cache FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: user_credits Users can view their own credits; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own credits" ON public.user_credits FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: email_log Users can view their own email logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own email logs" ON public.email_log FOR SELECT TO authenticated USING ((recipient_id = auth.uid()));


--
-- Name: user_feature_overrides Users can view their own feature overrides; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own feature overrides" ON public.user_feature_overrides FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: media_folders Users can view their own folders; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own folders" ON public.media_folders FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: lead_forms Users can view their own lead forms; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own lead forms" ON public.lead_forms FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: leads Users can view their own leads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own leads" ON public.leads FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: mcp_oauth_tokens Users can view their own mcp tokens; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own mcp tokens" ON public.mcp_oauth_tokens FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: media_operations_history Users can view their own media operations history; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own media operations history" ON public.media_operations_history FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: whatsapp_messages Users can view their own messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own messages" ON public.whatsapp_messages FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: video_processing_presets Users can view their own presets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own presets" ON public.video_processing_presets FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: user_rate_limits Users can view their own rate limits; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own rate limits" ON public.user_rate_limits FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: notification_reads Users can view their own read status; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own read status" ON public.notification_reads FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: threads_recent_searches Users can view their own recent searches; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own recent searches" ON public.threads_recent_searches FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: coupon_redemptions Users can view their own redemptions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own redemptions" ON public.coupon_redemptions FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: image_reference_presets Users can view their own reference presets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own reference presets" ON public.image_reference_presets FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: referrals Users can view their own referrals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own referrals" ON public.referrals FOR SELECT USING ((auth.uid() = referrer_id));


--
-- Name: threads_reply_cache Users can view their own reply cache; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own reply cache" ON public.threads_reply_cache FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: subscription_plans Users can view their own subscribed plan; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own subscribed plan" ON public.subscription_plans FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_subscriptions us
  WHERE ((us.user_id = auth.uid()) AND (us.status = ANY (ARRAY['active'::text, 'past_due'::text])) AND (us.plan_id = subscription_plans.id)))));


--
-- Name: whatsapp_message_templates Users can view their own templates; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own templates" ON public.whatsapp_message_templates FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: support_tickets Users can view their own tickets; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own tickets" ON public.support_tickets FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: credit_transactions Users can view their own transactions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own transactions" ON public.credit_transactions FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: whatsapp_webhooks Users can view their own webhooks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their own webhooks" ON public.whatsapp_webhooks FOR SELECT USING ((auth.uid() = user_id));


--
-- Name: mcp_oauth_authorizations Users can view their pending authorizations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users can view their pending authorizations" ON public.mcp_oauth_authorizations FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR (user_id IS NULL)));


--
-- Name: password_reset_otps Users cannot access OTPs directly; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users cannot access OTPs directly" ON public.password_reset_otps FOR SELECT TO authenticated, anon USING (false);


--
-- Name: tiktok_api_analytics_cache Users delete own tiktok cache; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users delete own tiktok cache" ON public.tiktok_api_analytics_cache FOR DELETE USING ((auth.uid() = user_id));


--
-- Name: whatsapp_message_flags Users delete their own message flags; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users delete their own message flags" ON public.whatsapp_message_flags FOR DELETE TO authenticated USING ((auth.uid() = user_id));


--
-- Name: tiktok_api_analytics_cache Users insert own tiktok cache; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users insert own tiktok cache" ON public.tiktok_api_analytics_cache FOR INSERT WITH CHECK ((auth.uid() = user_id));


--
-- Name: whatsapp_message_flags Users insert their own message flags; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users insert their own message flags" ON public.whatsapp_message_flags FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));


--
-- Name: ai_agent_configs Users manage own ai agent configs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own ai agent configs" ON public.ai_agent_configs TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: ai_agent_logs Users manage own ai agent logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own ai agent logs" ON public.ai_agent_logs TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: ai_agent_tools Users manage own ai agent tools; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own ai agent tools" ON public.ai_agent_tools TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: ai_conversation_modes Users manage own ai conversation modes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own ai conversation modes" ON public.ai_conversation_modes TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: ai_knowledge_chunks Users manage own ai knowledge chunks; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own ai knowledge chunks" ON public.ai_knowledge_chunks TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: ai_knowledge_entities Users manage own ai knowledge entities; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own ai knowledge entities" ON public.ai_knowledge_entities TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: ai_knowledge_graph_exports Users manage own ai knowledge graph exports; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own ai knowledge graph exports" ON public.ai_knowledge_graph_exports TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: ai_knowledge_relations Users manage own ai knowledge relations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own ai knowledge relations" ON public.ai_knowledge_relations TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: ai_knowledge_sources Users manage own ai knowledge sources; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own ai knowledge sources" ON public.ai_knowledge_sources TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: ai_thread_messages Users manage own ai thread messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own ai thread messages" ON public.ai_thread_messages TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: ai_threads Users manage own ai threads; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own ai threads" ON public.ai_threads TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: whatsapp_auto_replies Users manage own auto replies; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own auto replies" ON public.whatsapp_auto_replies TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: brand_scrape_sessions Users manage own brand sessions; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own brand sessions" ON public.brand_scrape_sessions USING ((auth.uid() = user_id));


--
-- Name: bi_post_content Users manage own content; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own content" ON public.bi_post_content TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));


--
-- Name: generated_content_collections Users manage own content collections; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own content collections" ON public.generated_content_collections USING ((auth.uid() = user_id));


--
-- Name: whatsapp_conversation_label_assignments Users manage own label assignments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own label assignments" ON public.whatsapp_conversation_label_assignments USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: whatsapp_conversation_labels Users manage own labels; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own labels" ON public.whatsapp_conversation_labels USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: messenger_auto_replies Users manage own messenger auto replies; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own messenger auto replies" ON public.messenger_auto_replies TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: whatsapp_quick_replies Users manage own quick replies; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own quick replies" ON public.whatsapp_quick_replies TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: whatsapp_scheduled_messages Users manage own scheduled messages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage own scheduled messages" ON public.whatsapp_scheduled_messages USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: ai_knowledge_source_accounts Users manage their own knowledge source links; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users manage their own knowledge source links" ON public.ai_knowledge_source_accounts USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: whatsapp_message_flags Users read their own message flags; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users read their own message flags" ON public.whatsapp_message_flags FOR SELECT TO authenticated USING ((auth.uid() = user_id));


--
-- Name: tiktok_api_analytics_cache Users update own tiktok cache; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users update own tiktok cache" ON public.tiktok_api_analytics_cache FOR UPDATE USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: whatsapp_message_flags Users update their own message flags; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users update their own message flags" ON public.whatsapp_message_flags FOR UPDATE TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: tiktok_api_analytics_cache Users view own tiktok cache; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users view own tiktok cache" ON public.tiktok_api_analytics_cache FOR SELECT USING (((auth.uid() = user_id) OR public.has_role(auth.uid(), 'admin'::public.app_role)));


--
-- Name: webhook_unmatched_observations Users view own unmatched observations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Users view own unmatched observations" ON public.webhook_unmatched_observations FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: partner_audit_logs Workspace admins read partner audit logs; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace admins read partner audit logs" ON public.partner_audit_logs FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.workspace_members m
  WHERE ((m.workspace_id = partner_audit_logs.workspace_id) AND (m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: partner_api_keys Workspace admins read partner keys; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace admins read partner keys" ON public.partner_api_keys FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.workspace_members m
  WHERE ((m.workspace_id = partner_api_keys.workspace_id) AND (m.user_id = auth.uid()) AND (m.role = ANY (ARRAY['owner'::text, 'admin'::text]))))));


--
-- Name: messaging_cache Workspace members can read WhatsApp conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can read WhatsApp conversations" ON public.messaging_cache FOR SELECT TO authenticated USING (((user_id = auth.uid()) OR ((platform = 'whatsapp'::text) AND public.is_workspace_member(workspace_id))));


--
-- Name: whatsapp_agents Workspace members can read agents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can read agents" ON public.whatsapp_agents FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));


--
-- Name: whatsapp_conversation_assignments Workspace members can read assignments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can read assignments" ON public.whatsapp_conversation_assignments FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));


--
-- Name: whatsapp_contacts Workspace members can read contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can read contacts" ON public.whatsapp_contacts FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));


--
-- Name: whatsapp_deals Workspace members can read deals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can read deals" ON public.whatsapp_deals FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));


--
-- Name: workspace_invitations Workspace members can read invitations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can read invitations" ON public.workspace_invitations FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));


--
-- Name: workspace_members Workspace members can read memberships; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can read memberships" ON public.workspace_members FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));


--
-- Name: whatsapp_pipeline_stages Workspace members can read pipeline stages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can read pipeline stages" ON public.whatsapp_pipeline_stages FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));


--
-- Name: whatsapp_pipelines Workspace members can read pipelines; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can read pipelines" ON public.whatsapp_pipelines FOR SELECT TO authenticated USING (public.is_workspace_member(workspace_id));


--
-- Name: workspaces Workspace members can read workspaces; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace members can read workspaces" ON public.workspaces FOR SELECT TO authenticated USING (public.is_workspace_member(id));


--
-- Name: workspace_members Workspace owners and admins can add memberships; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace owners and admins can add memberships" ON public.workspace_members FOR INSERT TO authenticated WITH CHECK ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text])));


--
-- Name: workspace_invitations Workspace owners and admins can create invitations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace owners and admins can create invitations" ON public.workspace_invitations FOR INSERT TO authenticated WITH CHECK (((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text])) AND (invited_by = auth.uid())));


--
-- Name: whatsapp_pipeline_stages Workspace owners and admins can create pipeline stages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace owners and admins can create pipeline stages" ON public.whatsapp_pipeline_stages FOR INSERT TO authenticated WITH CHECK ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text])));


--
-- Name: whatsapp_pipelines Workspace owners and admins can create pipelines; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace owners and admins can create pipelines" ON public.whatsapp_pipelines FOR INSERT TO authenticated WITH CHECK ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text])));


--
-- Name: whatsapp_agents Workspace owners and admins can delete agents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace owners and admins can delete agents" ON public.whatsapp_agents FOR DELETE TO authenticated USING ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text])));


--
-- Name: workspace_invitations Workspace owners and admins can delete invitations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace owners and admins can delete invitations" ON public.workspace_invitations FOR DELETE TO authenticated USING ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text])));


--
-- Name: whatsapp_pipeline_stages Workspace owners and admins can delete pipeline stages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace owners and admins can delete pipeline stages" ON public.whatsapp_pipeline_stages FOR DELETE TO authenticated USING ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text])));


--
-- Name: whatsapp_pipelines Workspace owners and admins can delete pipelines; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace owners and admins can delete pipelines" ON public.whatsapp_pipelines FOR DELETE TO authenticated USING ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text])));


--
-- Name: workspace_members Workspace owners and admins can remove memberships; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace owners and admins can remove memberships" ON public.workspace_members FOR DELETE TO authenticated USING ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text])));


--
-- Name: workspace_invitations Workspace owners and admins can update invitations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace owners and admins can update invitations" ON public.workspace_invitations FOR UPDATE TO authenticated USING ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text]))) WITH CHECK ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text])));


--
-- Name: workspace_members Workspace owners and admins can update memberships; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace owners and admins can update memberships" ON public.workspace_members FOR UPDATE TO authenticated USING ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text]))) WITH CHECK ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text])));


--
-- Name: whatsapp_pipeline_stages Workspace owners and admins can update pipeline stages; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace owners and admins can update pipeline stages" ON public.whatsapp_pipeline_stages FOR UPDATE TO authenticated USING ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text]))) WITH CHECK ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text])));


--
-- Name: whatsapp_pipelines Workspace owners and admins can update pipelines; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace owners and admins can update pipelines" ON public.whatsapp_pipelines FOR UPDATE TO authenticated USING ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text]))) WITH CHECK ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text])));


--
-- Name: workspaces Workspace owners and admins can update workspaces; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace owners and admins can update workspaces" ON public.workspaces FOR UPDATE TO authenticated USING ((public.workspace_role(id) = ANY (ARRAY['owner'::text, 'admin'::text]))) WITH CHECK ((public.workspace_role(id) = ANY (ARRAY['owner'::text, 'admin'::text])));


--
-- Name: workspaces Workspace owners can delete workspaces; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace owners can delete workspaces" ON public.workspaces FOR DELETE TO authenticated USING ((public.workspace_role(id) = 'owner'::text));


--
-- Name: whatsapp_agents Workspace writers can create agents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace writers can create agents" ON public.whatsapp_agents FOR INSERT TO authenticated WITH CHECK (((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text])) AND public.is_workspace_member(workspace_id, user_id)));


--
-- Name: whatsapp_conversation_assignments Workspace writers can create assignments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace writers can create assignments" ON public.whatsapp_conversation_assignments FOR INSERT TO authenticated WITH CHECK ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text])));


--
-- Name: whatsapp_contacts Workspace writers can create contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace writers can create contacts" ON public.whatsapp_contacts FOR INSERT TO authenticated WITH CHECK ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text])));


--
-- Name: whatsapp_deals Workspace writers can create deals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace writers can create deals" ON public.whatsapp_deals FOR INSERT TO authenticated WITH CHECK ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text])));


--
-- Name: messaging_cache Workspace writers can delete WhatsApp conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace writers can delete WhatsApp conversations" ON public.messaging_cache FOR DELETE TO authenticated USING (((user_id = auth.uid()) OR ((platform = 'whatsapp'::text) AND (public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text])))));


--
-- Name: whatsapp_conversation_assignments Workspace writers can delete assignments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace writers can delete assignments" ON public.whatsapp_conversation_assignments FOR DELETE TO authenticated USING ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text])));


--
-- Name: whatsapp_contacts Workspace writers can delete contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace writers can delete contacts" ON public.whatsapp_contacts FOR DELETE TO authenticated USING ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text])));


--
-- Name: whatsapp_deals Workspace writers can delete deals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace writers can delete deals" ON public.whatsapp_deals FOR DELETE TO authenticated USING ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text])));


--
-- Name: messaging_cache Workspace writers can insert WhatsApp conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace writers can insert WhatsApp conversations" ON public.messaging_cache FOR INSERT TO authenticated WITH CHECK (((user_id = auth.uid()) OR ((platform = 'whatsapp'::text) AND (public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text])))));


--
-- Name: messaging_cache Workspace writers can update WhatsApp conversations; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace writers can update WhatsApp conversations" ON public.messaging_cache FOR UPDATE TO authenticated USING (((user_id = auth.uid()) OR ((platform = 'whatsapp'::text) AND (public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text]))))) WITH CHECK (((user_id = auth.uid()) OR ((platform = 'whatsapp'::text) AND (public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text])))));


--
-- Name: whatsapp_agents Workspace writers can update agents; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace writers can update agents" ON public.whatsapp_agents FOR UPDATE TO authenticated USING ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text]))) WITH CHECK (((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text])) AND public.is_workspace_member(workspace_id, user_id)));


--
-- Name: whatsapp_conversation_assignments Workspace writers can update assignments; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace writers can update assignments" ON public.whatsapp_conversation_assignments FOR UPDATE TO authenticated USING ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text]))) WITH CHECK ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text])));


--
-- Name: whatsapp_contacts Workspace writers can update contacts; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace writers can update contacts" ON public.whatsapp_contacts FOR UPDATE TO authenticated USING ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text]))) WITH CHECK ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text])));


--
-- Name: whatsapp_deals Workspace writers can update deals; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "Workspace writers can update deals" ON public.whatsapp_deals FOR UPDATE TO authenticated USING ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text]))) WITH CHECK ((public.workspace_role(workspace_id) = ANY (ARRAY['owner'::text, 'admin'::text, 'agent'::text])));


--
-- Name: admin_audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_audit_log admin_audit_log_admin_read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY admin_audit_log_admin_read ON public.admin_audit_log FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.user_roles ur
  WHERE ((ur.user_id = auth.uid()) AND (ur.role = 'admin'::public.app_role)))));


--
-- Name: admin_inbox_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_inbox_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: admin_notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.admin_notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_agent_allowed_models; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_agent_allowed_models ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_agent_allowed_models ai_agent_allowed_models_admin_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ai_agent_allowed_models_admin_all ON public.ai_agent_allowed_models TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role)) WITH CHECK (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: ai_agent_allowed_models ai_agent_allowed_models_read_active; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ai_agent_allowed_models_read_active ON public.ai_agent_allowed_models FOR SELECT TO authenticated USING (((is_active = true) OR public.has_role(auth.uid(), 'admin'::public.app_role)));


--
-- Name: ai_agent_configs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_agent_configs ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_agent_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_agent_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_agent_tools; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_agent_tools ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_conversation_modes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_conversation_modes ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_generation_jobs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_generation_jobs ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_generation_jobs ai_generation_jobs_owner_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ai_generation_jobs_owner_select ON public.ai_generation_jobs FOR SELECT TO authenticated USING ((auth.uid() = user_id));


--
-- Name: ai_knowledge_chunks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_knowledge_chunks ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_knowledge_entities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_knowledge_entities ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_knowledge_graph_exports; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_knowledge_graph_exports ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_knowledge_relations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_knowledge_relations ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_knowledge_source_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_knowledge_source_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_knowledge_sources; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_knowledge_sources ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_model_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_model_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_model_preferences ai_model_preferences_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ai_model_preferences_own ON public.ai_model_preferences TO authenticated USING ((auth.uid() = user_id));


--
-- Name: ai_models; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_models ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_models ai_models_admin_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ai_models_admin_all ON public.ai_models TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: ai_models ai_models_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ai_models_select ON public.ai_models FOR SELECT TO authenticated USING (true);


--
-- Name: ai_providers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_providers ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_providers ai_providers_admin_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY ai_providers_admin_all ON public.ai_providers TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: ai_thread_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_thread_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: ai_threads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ai_threads ENABLE ROW LEVEL SECURITY;

--
-- Name: api_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.api_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: api_logs api_logs_no_anon; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY api_logs_no_anon ON public.api_logs TO anon USING (false) WITH CHECK (false);


--
-- Name: api_logs api_logs_no_client_writes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY api_logs_no_client_writes ON public.api_logs FOR INSERT TO authenticated WITH CHECK (false);


--
-- Name: api_logs api_logs_owner_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY api_logs_owner_select ON public.api_logs FOR SELECT TO authenticated USING ((auth.uid() = user_id));


--
-- Name: app_credentials; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_credentials ENABLE ROW LEVEL SECURITY;

--
-- Name: app_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.app_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: app_settings app_settings_admin_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY app_settings_admin_select ON public.app_settings FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: app_settings app_settings_no_anon; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY app_settings_no_anon ON public.app_settings TO anon USING (false) WITH CHECK (false);


--
-- Name: app_settings app_settings_no_client_writes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY app_settings_no_client_writes ON public.app_settings FOR INSERT TO authenticated WITH CHECK (false);


--
-- Name: automation_dispatch_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.automation_dispatch_log ENABLE ROW LEVEL SECURITY;

--
-- Name: automation_dispatch_log automation_dispatch_log_read_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY automation_dispatch_log_read_own ON public.automation_dispatch_log FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: backup_codes; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.backup_codes ENABLE ROW LEVEL SECURITY;

--
-- Name: bi_post_content; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.bi_post_content ENABLE ROW LEVEL SECURITY;

--
-- Name: blog_posts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.blog_posts ENABLE ROW LEVEL SECURITY;

--
-- Name: brand_scrape_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.brand_scrape_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: brand_scrape_sessions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.brand_scrape_sessions ENABLE ROW LEVEL SECURITY;

--
-- Name: brand_search_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.brand_search_history ENABLE ROW LEVEL SECURITY;

--
-- Name: brand_search_history bsh_delete_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bsh_delete_own ON public.brand_search_history FOR DELETE TO authenticated USING ((auth.uid() = user_id));


--
-- Name: brand_search_history bsh_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bsh_insert_own ON public.brand_search_history FOR INSERT TO authenticated WITH CHECK ((auth.uid() = user_id));


--
-- Name: brand_search_history bsh_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bsh_select_own ON public.brand_search_history FOR SELECT TO authenticated USING ((auth.uid() = user_id));


--
-- Name: brand_search_history bsh_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY bsh_update_own ON public.brand_search_history FOR UPDATE TO authenticated USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));


--
-- Name: caption_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.caption_history ENABLE ROW LEVEL SECURITY;

--
-- Name: comment_inbox_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.comment_inbox_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: coupon_redemptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.coupon_redemptions ENABLE ROW LEVEL SECURITY;

--
-- Name: coupons; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.coupons ENABLE ROW LEVEL SECURITY;

--
-- Name: credit_transactions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.credit_transactions ENABLE ROW LEVEL SECURITY;

--
-- Name: deployment_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.deployment_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: edge_function_status; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.edge_function_status ENABLE ROW LEVEL SECURITY;

--
-- Name: email_contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: email_drafts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_drafts ENABLE ROW LEVEL SECURITY;

--
-- Name: email_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_log ENABLE ROW LEVEL SECURITY;

--
-- Name: email_signatures; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_signatures ENABLE ROW LEVEL SECURITY;

--
-- Name: email_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.email_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: feature_flag_audit_log; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.feature_flag_audit_log ENABLE ROW LEVEL SECURITY;

--
-- Name: feature_flag_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.feature_flag_schedules ENABLE ROW LEVEL SECURITY;

--
-- Name: generated_content_collections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.generated_content_collections ENABLE ROW LEVEL SECURITY;

--
-- Name: higgsfield_connections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.higgsfield_connections ENABLE ROW LEVEL SECURITY;

--
-- Name: higgsfield_connections higgsfield_connections_client_delete; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY higgsfield_connections_client_delete ON public.higgsfield_connections FOR DELETE TO authenticated USING ((auth.uid() = user_id));


--
-- Name: higgsfield_connections higgsfield_connections_client_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY higgsfield_connections_client_select ON public.higgsfield_connections FOR SELECT TO authenticated USING ((auth.uid() = user_id));


--
-- Name: image_reference_presets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.image_reference_presets ENABLE ROW LEVEL SECURITY;

--
-- Name: launch_checklist; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.launch_checklist ENABLE ROW LEVEL SECURITY;

--
-- Name: lead_forms; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.lead_forms ENABLE ROW LEVEL SECURITY;

--
-- Name: leads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.leads ENABLE ROW LEVEL SECURITY;

--
-- Name: log_analyses; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.log_analyses ENABLE ROW LEVEL SECURITY;

--
-- Name: mcp_oauth_authorizations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mcp_oauth_authorizations ENABLE ROW LEVEL SECURITY;

--
-- Name: mcp_oauth_clients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mcp_oauth_clients ENABLE ROW LEVEL SECURITY;

--
-- Name: mcp_oauth_tokens; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.mcp_oauth_tokens ENABLE ROW LEVEL SECURITY;

--
-- Name: media_file_providers; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_file_providers ENABLE ROW LEVEL SECURITY;

--
-- Name: media_files; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_files ENABLE ROW LEVEL SECURITY;

--
-- Name: media_folders; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_folders ENABLE ROW LEVEL SECURITY;

--
-- Name: media_operations_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_operations_history ENABLE ROW LEVEL SECURITY;

--
-- Name: media_understanding_sender_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_understanding_sender_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: media_understanding_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_understanding_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: media_upload_counters; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.media_upload_counters ENABLE ROW LEVEL SECURITY;

--
-- Name: messaging_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.messaging_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: messenger_auto_replies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.messenger_auto_replies ENABLE ROW LEVEL SECURITY;

--
-- Name: messenger_auto_reply_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.messenger_auto_reply_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: node_execution_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.node_execution_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: notification_reads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notification_reads ENABLE ROW LEVEL SECURITY;

--
-- Name: oauth_apps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.oauth_apps ENABLE ROW LEVEL SECURITY;

--
-- Name: oauth_clients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.oauth_clients ENABLE ROW LEVEL SECURITY;

--
-- Name: oauth_clients oauth_clients_deny; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY oauth_clients_deny ON public.oauth_clients TO authenticated, anon USING (false) WITH CHECK (false);


--
-- Name: oauth_pending_facebook_selections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.oauth_pending_facebook_selections ENABLE ROW LEVEL SECURITY;

--
-- Name: oauth_pending_instagram_selections; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.oauth_pending_instagram_selections ENABLE ROW LEVEL SECURITY;

--
-- Name: oauth_redirect_requests; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.oauth_redirect_requests ENABLE ROW LEVEL SECURITY;

--
-- Name: oauth_states; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.oauth_states ENABLE ROW LEVEL SECURITY;

--
-- Name: oauth_states oauth_states_deny; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY oauth_states_deny ON public.oauth_states TO authenticated, anon USING (false) WITH CHECK (false);


--
-- Name: observability_alert_configs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.observability_alert_configs ENABLE ROW LEVEL SECURITY;

--
-- Name: observability_alert_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.observability_alert_history ENABLE ROW LEVEL SECURITY;

--
-- Name: observability_health_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.observability_health_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: observability_metrics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.observability_metrics ENABLE ROW LEVEL SECURITY;

--
-- Name: oauth_pending_facebook_selections own pending fb selection read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "own pending fb selection read" ON public.oauth_pending_facebook_selections FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: oauth_pending_instagram_selections own pending ig selection read; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "own pending ig selection read" ON public.oauth_pending_instagram_selections FOR SELECT TO authenticated USING ((user_id = auth.uid()));


--
-- Name: partner_api_idempotency; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.partner_api_idempotency ENABLE ROW LEVEL SECURITY;

--
-- Name: partner_api_key_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.partner_api_key_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: partner_api_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.partner_api_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: partner_api_rate_buckets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.partner_api_rate_buckets ENABLE ROW LEVEL SECURITY;

--
-- Name: partner_api_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.partner_api_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: partner_audit_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.partner_audit_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: password_reset_otps; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.password_reset_otps ENABLE ROW LEVEL SECURITY;

--
-- Name: password_reset_otps password_reset_otps_no_anon_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY password_reset_otps_no_anon_access ON public.password_reset_otps TO anon USING (false) WITH CHECK (false);


--
-- Name: password_reset_otps password_reset_otps_no_authenticated_access; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY password_reset_otps_no_authenticated_access ON public.password_reset_otps TO authenticated USING (false) WITH CHECK (false);


--
-- Name: pending_agent_replies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.pending_agent_replies ENABLE ROW LEVEL SECURITY;

--
-- Name: platform_posts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.platform_posts ENABLE ROW LEVEL SECURITY;

--
-- Name: post_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.post_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: posts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;

--
-- Name: profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: provider_api_keys; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.provider_api_keys ENABLE ROW LEVEL SECURITY;

--
-- Name: rate_limit_buckets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rate_limit_buckets ENABLE ROW LEVEL SECURITY;

--
-- Name: rate_limit_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.rate_limit_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: referrals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.referrals ENABLE ROW LEVEL SECURITY;

--
-- Name: saved_field_suggestions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.saved_field_suggestions ENABLE ROW LEVEL SECURITY;

--
-- Name: scheduled_emails; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.scheduled_emails ENABLE ROW LEVEL SECURITY;

--
-- Name: social_accounts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.social_accounts ENABLE ROW LEVEL SECURITY;

--
-- Name: social_inbox_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.social_inbox_events ENABLE ROW LEVEL SECURITY;

--
-- Name: social_profiles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.social_profiles ENABLE ROW LEVEL SECURITY;

--
-- Name: stripe_webhook_events; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.stripe_webhook_events ENABLE ROW LEVEL SECURITY;

--
-- Name: subscription_plans; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.subscription_plans ENABLE ROW LEVEL SECURITY;

--
-- Name: support_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.support_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: support_tickets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.support_tickets ENABLE ROW LEVEL SECURITY;

--
-- Name: system_health_snapshots; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.system_health_snapshots ENABLE ROW LEVEL SECURITY;

--
-- Name: system_logs; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.system_logs ENABLE ROW LEVEL SECURITY;

--
-- Name: system_notifications; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.system_notifications ENABLE ROW LEVEL SECURITY;

--
-- Name: system_settings; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.system_settings ENABLE ROW LEVEL SECURITY;

--
-- Name: system_settings system_settings_admin_all; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY system_settings_admin_all ON public.system_settings TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: threads_mentions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.threads_mentions ENABLE ROW LEVEL SECURITY;

--
-- Name: threads_recent_searches; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.threads_recent_searches ENABLE ROW LEVEL SECURITY;

--
-- Name: threads_reply_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.threads_reply_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: ticket_activities; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ticket_activities ENABLE ROW LEVEL SECURITY;

--
-- Name: ticket_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.ticket_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: tier_rate_limits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tier_rate_limits ENABLE ROW LEVEL SECURITY;

--
-- Name: tiktok_api_analytics_cache; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.tiktok_api_analytics_cache ENABLE ROW LEVEL SECURITY;

--
-- Name: token_refresh_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.token_refresh_history ENABLE ROW LEVEL SECURITY;

--
-- Name: user_ai_model_overrides; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_ai_model_overrides ENABLE ROW LEVEL SECURITY;

--
-- Name: user_blog_post_reads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_blog_post_reads ENABLE ROW LEVEL SECURITY;

--
-- Name: user_connectors; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_connectors ENABLE ROW LEVEL SECURITY;

--
-- Name: user_credits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_credits ENABLE ROW LEVEL SECURITY;

--
-- Name: user_feature_overrides; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_feature_overrides ENABLE ROW LEVEL SECURITY;

--
-- Name: user_notification_preferences; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_notification_preferences ENABLE ROW LEVEL SECURITY;

--
-- Name: user_notification_reads; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_notification_reads ENABLE ROW LEVEL SECURITY;

--
-- Name: user_quotas; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_quotas ENABLE ROW LEVEL SECURITY;

--
-- Name: user_rate_limits; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_rate_limits ENABLE ROW LEVEL SECURITY;

--
-- Name: user_roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: user_roles user_roles_admin_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_roles_admin_select ON public.user_roles FOR SELECT TO authenticated USING (public.has_role(auth.uid(), 'admin'::public.app_role));


--
-- Name: user_roles user_roles_no_anon; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_roles_no_anon ON public.user_roles TO anon USING (false) WITH CHECK (false);


--
-- Name: user_roles user_roles_no_client_writes; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_roles_no_client_writes ON public.user_roles FOR INSERT TO authenticated WITH CHECK (false);


--
-- Name: user_roles user_roles_owner_select; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY user_roles_owner_select ON public.user_roles FOR SELECT TO authenticated USING ((auth.uid() = user_id));


--
-- Name: user_subscriptions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.user_subscriptions ENABLE ROW LEVEL SECURITY;

--
-- Name: video_processing_presets; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.video_processing_presets ENABLE ROW LEVEL SECURITY;

--
-- Name: webhook_unmatched_observations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.webhook_unmatched_observations ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_agents; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_agents ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_assignment_history; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_assignment_history ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_auto_replies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_auto_replies ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_auto_reply_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_auto_reply_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_broadcast_recipients; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_broadcast_recipients ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_broadcasts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_broadcasts ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_contact_group_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_contact_group_members ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_contact_groups; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_contact_groups ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_contacts; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_contacts ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_conversation_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_conversation_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_conversation_label_assignments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_conversation_label_assignments ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_conversation_labels; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_conversation_labels ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_deals; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_deals ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_evolution_instances; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_evolution_instances ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_message_analytics; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_message_analytics ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_message_flags; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_message_flags ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_message_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_message_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_pipeline_stages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_pipeline_stages ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_pipelines; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_pipelines ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_quick_replies; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_quick_replies ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_quick_reply_usage; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_quick_reply_usage ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_scheduled_messages; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_scheduled_messages ENABLE ROW LEVEL SECURITY;

--
-- Name: whatsapp_webhooks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.whatsapp_webhooks ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_comments; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workflow_comments ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_executions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workflow_executions ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_schedules; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workflow_schedules ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_templates; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workflow_templates ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_versions; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workflow_versions ENABLE ROW LEVEL SECURITY;

--
-- Name: workflow_webhooks; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workflow_webhooks ENABLE ROW LEVEL SECURITY;

--
-- Name: workflows; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workflows ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_invitations; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspace_invitations ENABLE ROW LEVEL SECURITY;

--
-- Name: workspace_members; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspace_members ENABLE ROW LEVEL SECURITY;

--
-- Name: workspaces; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.workspaces ENABLE ROW LEVEL SECURITY;

--
-- Name: messages; Type: ROW SECURITY; Schema: realtime; Owner: -
--

ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;

--
-- Name: objects Admins can delete email attachments; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Admins can delete email attachments" ON storage.objects FOR DELETE USING (((bucket_id = 'email-attachments'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role))))));


--
-- Name: objects Admins can upload email attachments; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Admins can upload email attachments" ON storage.objects FOR INSERT WITH CHECK (((bucket_id = 'email-attachments'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role))))));


--
-- Name: objects Admins can view email attachments; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Admins can view email attachments" ON storage.objects FOR SELECT USING (((bucket_id = 'email-attachments'::text) AND (EXISTS ( SELECT 1
   FROM public.user_roles
  WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'admin'::public.app_role))))));


--
-- Name: objects Users can delete own AI knowledge files; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Users can delete own AI knowledge files" ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'ai-knowledge'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));


--
-- Name: objects Users can delete own media; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Users can delete own media" ON storage.objects FOR DELETE USING (((bucket_id = 'media'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));


--
-- Name: objects Users can update own media; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Users can update own media" ON storage.objects FOR UPDATE USING (((bucket_id = 'media'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));


--
-- Name: objects Users can upload media; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Users can upload media" ON storage.objects FOR INSERT WITH CHECK (((bucket_id = 'media'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));


--
-- Name: objects Users can upload own AI knowledge files; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Users can upload own AI knowledge files" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'ai-knowledge'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));


--
-- Name: objects Users can upload own media; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Users can upload own media" ON storage.objects FOR INSERT WITH CHECK (((bucket_id = 'media'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));


--
-- Name: objects Users can view own AI knowledge files; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Users can view own AI knowledge files" ON storage.objects FOR SELECT TO authenticated USING (((bucket_id = 'ai-knowledge'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));


--
-- Name: objects Users can view own media; Type: POLICY; Schema: storage; Owner: -
--

CREATE POLICY "Users can view own media" ON storage.objects FOR SELECT USING (((bucket_id = 'media'::text) AND ((auth.uid())::text = (storage.foldername(name))[1])));


--
-- Name: buckets; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;

--
-- Name: migrations; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.migrations ENABLE ROW LEVEL SECURITY;

--
-- Name: objects; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

--
-- Name: prefixes; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.prefixes ENABLE ROW LEVEL SECURITY;

--
-- Name: s3_multipart_uploads; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.s3_multipart_uploads ENABLE ROW LEVEL SECURITY;

--
-- Name: s3_multipart_uploads_parts; Type: ROW SECURITY; Schema: storage; Owner: -
--

ALTER TABLE storage.s3_multipart_uploads_parts ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA auth; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA auth TO anon;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT USAGE ON SCHEMA auth TO service_role;
GRANT ALL ON SCHEMA auth TO supabase_auth_admin;
GRANT ALL ON SCHEMA auth TO dashboard_user;
GRANT USAGE ON SCHEMA auth TO postgres;


--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: SCHEMA realtime; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA realtime TO postgres;
GRANT USAGE ON SCHEMA realtime TO anon;
GRANT USAGE ON SCHEMA realtime TO authenticated;
GRANT USAGE ON SCHEMA realtime TO service_role;
GRANT ALL ON SCHEMA realtime TO supabase_realtime_admin;


--
-- Name: SCHEMA storage; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA storage TO postgres WITH GRANT OPTION;
GRANT USAGE ON SCHEMA storage TO anon;
GRANT USAGE ON SCHEMA storage TO authenticated;
GRANT USAGE ON SCHEMA storage TO service_role;
GRANT ALL ON SCHEMA storage TO supabase_storage_admin WITH GRANT OPTION;
GRANT ALL ON SCHEMA storage TO dashboard_user;


--
-- Name: FUNCTION email(); Type: ACL; Schema: auth; Owner: -
--

GRANT ALL ON FUNCTION auth.email() TO dashboard_user;


--
-- Name: FUNCTION jwt(); Type: ACL; Schema: auth; Owner: -
--

GRANT ALL ON FUNCTION auth.jwt() TO postgres;
GRANT ALL ON FUNCTION auth.jwt() TO dashboard_user;


--
-- Name: FUNCTION role(); Type: ACL; Schema: auth; Owner: -
--

GRANT ALL ON FUNCTION auth.role() TO dashboard_user;


--
-- Name: FUNCTION uid(); Type: ACL; Schema: auth; Owner: -
--

GRANT ALL ON FUNCTION auth.uid() TO dashboard_user;


--
-- Name: FUNCTION accept_workspace_invitation(p_token text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.accept_workspace_invitation(p_token text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.accept_workspace_invitation(p_token text) TO anon;
GRANT ALL ON FUNCTION public.accept_workspace_invitation(p_token text) TO authenticated;
GRANT ALL ON FUNCTION public.accept_workspace_invitation(p_token text) TO service_role;


--
-- Name: FUNCTION activate_evolution_qr_account(p_account_id uuid, p_owner_number text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.activate_evolution_qr_account(p_account_id uuid, p_owner_number text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.activate_evolution_qr_account(p_account_id uuid, p_owner_number text) TO postgres;
GRANT ALL ON FUNCTION public.activate_evolution_qr_account(p_account_id uuid, p_owner_number text) TO service_role;


--
-- Name: FUNCTION add_ticket_message(p_ticket_id uuid, p_message text, p_attachments jsonb, p_is_internal boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.add_ticket_message(p_ticket_id uuid, p_message text, p_attachments jsonb, p_is_internal boolean) TO anon;
GRANT ALL ON FUNCTION public.add_ticket_message(p_ticket_id uuid, p_message text, p_attachments jsonb, p_is_internal boolean) TO authenticated;
GRANT ALL ON FUNCTION public.add_ticket_message(p_ticket_id uuid, p_message text, p_attachments jsonb, p_is_internal boolean) TO service_role;


--
-- Name: FUNCTION add_user_credits(p_user_id uuid, p_amount integer, p_transaction_type text, p_description text, p_stripe_session_id text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.add_user_credits(p_user_id uuid, p_amount integer, p_transaction_type text, p_description text, p_stripe_session_id text) TO anon;
GRANT ALL ON FUNCTION public.add_user_credits(p_user_id uuid, p_amount integer, p_transaction_type text, p_description text, p_stripe_session_id text) TO authenticated;
GRANT ALL ON FUNCTION public.add_user_credits(p_user_id uuid, p_amount integer, p_transaction_type text, p_description text, p_stripe_session_id text) TO service_role;


--
-- Name: FUNCTION admin_get_profiles(p_limit integer, p_offset integer, p_search text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.admin_get_profiles(p_limit integer, p_offset integer, p_search text) TO anon;
GRANT ALL ON FUNCTION public.admin_get_profiles(p_limit integer, p_offset integer, p_search text) TO authenticated;
GRANT ALL ON FUNCTION public.admin_get_profiles(p_limit integer, p_offset integer, p_search text) TO service_role;


--
-- Name: FUNCTION advance_agent_reply(p_id uuid, p_from text, p_to text, p_generated_reply text, p_error text, p_tool_calls jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.advance_agent_reply(p_id uuid, p_from text, p_to text, p_generated_reply text, p_error text, p_tool_calls jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.advance_agent_reply(p_id uuid, p_from text, p_to text, p_generated_reply text, p_error text, p_tool_calls jsonb) TO service_role;


--
-- Name: FUNCTION assign_ticket(p_ticket_id uuid, p_assignee_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.assign_ticket(p_ticket_id uuid, p_assignee_id uuid) TO anon;
GRANT ALL ON FUNCTION public.assign_ticket(p_ticket_id uuid, p_assignee_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.assign_ticket(p_ticket_id uuid, p_assignee_id uuid) TO service_role;


--
-- Name: FUNCTION calculate_health_score(p_db_query_time numeric, p_api_error_rate numeric, p_edge_function_errors integer, p_storage_percent numeric); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.calculate_health_score(p_db_query_time numeric, p_api_error_rate numeric, p_edge_function_errors integer, p_storage_percent numeric) TO anon;
GRANT ALL ON FUNCTION public.calculate_health_score(p_db_query_time numeric, p_api_error_rate numeric, p_edge_function_errors integer, p_storage_percent numeric) TO authenticated;
GRANT ALL ON FUNCTION public.calculate_health_score(p_db_query_time numeric, p_api_error_rate numeric, p_edge_function_errors integer, p_storage_percent numeric) TO service_role;


--
-- Name: FUNCTION can_create_post(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.can_create_post(p_user_id uuid) TO anon;
GRANT ALL ON FUNCTION public.can_create_post(p_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.can_create_post(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION can_upload_media(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.can_upload_media(p_user_id uuid) TO anon;
GRANT ALL ON FUNCTION public.can_upload_media(p_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.can_upload_media(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION check_rate_limit(p_endpoint text, p_identifier text, p_max_requests integer, p_window_seconds integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.check_rate_limit(p_endpoint text, p_identifier text, p_max_requests integer, p_window_seconds integer) TO postgres;
GRANT ALL ON FUNCTION public.check_rate_limit(p_endpoint text, p_identifier text, p_max_requests integer, p_window_seconds integer) TO anon;
GRANT ALL ON FUNCTION public.check_rate_limit(p_endpoint text, p_identifier text, p_max_requests integer, p_window_seconds integer) TO authenticated;
GRANT ALL ON FUNCTION public.check_rate_limit(p_endpoint text, p_identifier text, p_max_requests integer, p_window_seconds integer) TO service_role;


--
-- Name: TABLE pending_agent_replies; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.pending_agent_replies TO anon;
GRANT ALL ON TABLE public.pending_agent_replies TO authenticated;
GRANT ALL ON TABLE public.pending_agent_replies TO service_role;


--
-- Name: FUNCTION claim_agent_replies(p_limit integer, p_lease_seconds integer, p_max_attempts integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_agent_replies(p_limit integer, p_lease_seconds integer, p_max_attempts integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_agent_replies(p_limit integer, p_lease_seconds integer, p_max_attempts integer) TO service_role;


--
-- Name: TABLE ai_knowledge_sources; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_knowledge_sources TO anon;
GRANT ALL ON TABLE public.ai_knowledge_sources TO authenticated;
GRANT ALL ON TABLE public.ai_knowledge_sources TO service_role;


--
-- Name: FUNCTION claim_ai_knowledge_excel_source(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_ai_knowledge_excel_source() FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_ai_knowledge_excel_source() TO anon;
GRANT ALL ON FUNCTION public.claim_ai_knowledge_excel_source() TO authenticated;
GRANT ALL ON FUNCTION public.claim_ai_knowledge_excel_source() TO service_role;


--
-- Name: FUNCTION claim_partner_idempotency(p_key_id uuid, p_idempotency_key text, p_request_hash text, p_lease_seconds integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_partner_idempotency(p_key_id uuid, p_idempotency_key text, p_request_hash text, p_lease_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_partner_idempotency(p_key_id uuid, p_idempotency_key text, p_request_hash text, p_lease_seconds integer) TO service_role;


--
-- Name: FUNCTION claim_whatsapp_history_sync(p_social_account_id uuid, p_lease_seconds integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.claim_whatsapp_history_sync(p_social_account_id uuid, p_lease_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.claim_whatsapp_history_sync(p_social_account_id uuid, p_lease_seconds integer) TO postgres;
GRANT ALL ON FUNCTION public.claim_whatsapp_history_sync(p_social_account_id uuid, p_lease_seconds integer) TO service_role;


--
-- Name: FUNCTION cleanup_expired_otps(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.cleanup_expired_otps() TO anon;
GRANT ALL ON FUNCTION public.cleanup_expired_otps() TO authenticated;
GRANT ALL ON FUNCTION public.cleanup_expired_otps() TO service_role;


--
-- Name: FUNCTION cleanup_old_health_data(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.cleanup_old_health_data() TO anon;
GRANT ALL ON FUNCTION public.cleanup_old_health_data() TO authenticated;
GRANT ALL ON FUNCTION public.cleanup_old_health_data() TO service_role;


--
-- Name: FUNCTION cleanup_old_token_refresh_history(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.cleanup_old_token_refresh_history() TO anon;
GRANT ALL ON FUNCTION public.cleanup_old_token_refresh_history() TO authenticated;
GRANT ALL ON FUNCTION public.cleanup_old_token_refresh_history() TO service_role;


--
-- Name: FUNCTION cleanup_rate_limit_buckets(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.cleanup_rate_limit_buckets() TO postgres;
GRANT ALL ON FUNCTION public.cleanup_rate_limit_buckets() TO anon;
GRANT ALL ON FUNCTION public.cleanup_rate_limit_buckets() TO authenticated;
GRANT ALL ON FUNCTION public.cleanup_rate_limit_buckets() TO service_role;


--
-- Name: FUNCTION consume_partner_rate(p_key_id uuid, p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.consume_partner_rate(p_key_id uuid, p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.consume_partner_rate(p_key_id uuid, p_limit integer) TO service_role;


--
-- Name: FUNCTION consume_partner_rate_v2(p_key_id uuid, p_limit integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.consume_partner_rate_v2(p_key_id uuid, p_limit integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.consume_partner_rate_v2(p_key_id uuid, p_limit integer) TO postgres;
GRANT ALL ON FUNCTION public.consume_partner_rate_v2(p_key_id uuid, p_limit integer) TO service_role;


--
-- Name: FUNCTION count_openinary_backfill_remaining(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.count_openinary_backfill_remaining() FROM PUBLIC;
GRANT ALL ON FUNCTION public.count_openinary_backfill_remaining() TO service_role;


--
-- Name: FUNCTION create_ai_knowledge_source(p_source_type text, p_file_name text, p_file_path text, p_social_account_ids uuid[], p_visibility text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_ai_knowledge_source(p_source_type text, p_file_name text, p_file_path text, p_social_account_ids uuid[], p_visibility text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_ai_knowledge_source(p_source_type text, p_file_name text, p_file_path text, p_social_account_ids uuid[], p_visibility text) TO anon;
GRANT ALL ON FUNCTION public.create_ai_knowledge_source(p_source_type text, p_file_name text, p_file_path text, p_social_account_ids uuid[], p_visibility text) TO authenticated;
GRANT ALL ON FUNCTION public.create_ai_knowledge_source(p_source_type text, p_file_name text, p_file_path text, p_social_account_ids uuid[], p_visibility text) TO service_role;


--
-- Name: FUNCTION create_default_whatsapp_pipeline(p_workspace_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.create_default_whatsapp_pipeline(p_workspace_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.create_default_whatsapp_pipeline(p_workspace_id uuid) TO anon;
GRANT ALL ON FUNCTION public.create_default_whatsapp_pipeline(p_workspace_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.create_default_whatsapp_pipeline(p_workspace_id uuid) TO service_role;


--
-- Name: FUNCTION create_support_ticket(p_subject text, p_description text, p_category text, p_priority text, p_attachments jsonb); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.create_support_ticket(p_subject text, p_description text, p_category text, p_priority text, p_attachments jsonb) TO anon;
GRANT ALL ON FUNCTION public.create_support_ticket(p_subject text, p_description text, p_category text, p_priority text, p_attachments jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.create_support_ticket(p_subject text, p_description text, p_category text, p_priority text, p_attachments jsonb) TO service_role;


--
-- Name: FUNCTION create_workflow_version(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.create_workflow_version() TO anon;
GRANT ALL ON FUNCTION public.create_workflow_version() TO authenticated;
GRANT ALL ON FUNCTION public.create_workflow_version() TO service_role;


--
-- Name: FUNCTION effective_user_quotas(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.effective_user_quotas(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.effective_user_quotas(p_user_id uuid) TO postgres;
GRANT ALL ON FUNCTION public.effective_user_quotas(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION enforce_post_quota_on_insert(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.enforce_post_quota_on_insert() TO anon;
GRANT ALL ON FUNCTION public.enforce_post_quota_on_insert() TO authenticated;
GRANT ALL ON FUNCTION public.enforce_post_quota_on_insert() TO service_role;


--
-- Name: FUNCTION enqueue_agent_reply(p_social_account_id uuid, p_platform text, p_message_id text, p_conversation_id text, p_recipient_id text, p_inbound_text text, p_inbound_at timestamp with time zone, p_media jsonb, p_language_hint text, p_comment_id text, p_lease_seconds integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.enqueue_agent_reply(p_social_account_id uuid, p_platform text, p_message_id text, p_conversation_id text, p_recipient_id text, p_inbound_text text, p_inbound_at timestamp with time zone, p_media jsonb, p_language_hint text, p_comment_id text, p_lease_seconds integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.enqueue_agent_reply(p_social_account_id uuid, p_platform text, p_message_id text, p_conversation_id text, p_recipient_id text, p_inbound_text text, p_inbound_at timestamp with time zone, p_media jsonb, p_language_hint text, p_comment_id text, p_lease_seconds integer) TO service_role;


--
-- Name: FUNCTION ensure_personal_workspace(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.ensure_personal_workspace(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.ensure_personal_workspace(p_user_id uuid) TO anon;
GRANT ALL ON FUNCTION public.ensure_personal_workspace(p_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.ensure_personal_workspace(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION generate_referral_code(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.generate_referral_code() TO anon;
GRANT ALL ON FUNCTION public.generate_referral_code() TO authenticated;
GRANT ALL ON FUNCTION public.generate_referral_code() TO service_role;


--
-- Name: FUNCTION get_active_ai_model_config(p_user_id uuid, p_feature text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_active_ai_model_config(p_user_id uuid, p_feature text) TO anon;
GRANT ALL ON FUNCTION public.get_active_ai_model_config(p_user_id uuid, p_feature text) TO authenticated;
GRANT ALL ON FUNCTION public.get_active_ai_model_config(p_user_id uuid, p_feature text) TO service_role;


--
-- Name: FUNCTION get_cdn_provider_counts(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_cdn_provider_counts() TO anon;
GRANT ALL ON FUNCTION public.get_cdn_provider_counts() TO authenticated;
GRANT ALL ON FUNCTION public.get_cdn_provider_counts() TO service_role;


--
-- Name: FUNCTION get_checklist_progress(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_checklist_progress() TO anon;
GRANT ALL ON FUNCTION public.get_checklist_progress() TO authenticated;
GRANT ALL ON FUNCTION public.get_checklist_progress() TO service_role;


--
-- Name: FUNCTION get_coupon_stats(p_coupon_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_coupon_stats(p_coupon_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_coupon_stats(p_coupon_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_coupon_stats(p_coupon_id uuid) TO service_role;


--
-- Name: FUNCTION get_cron_jobs(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_cron_jobs() TO anon;
GRANT ALL ON FUNCTION public.get_cron_jobs() TO authenticated;
GRANT ALL ON FUNCTION public.get_cron_jobs() TO service_role;


--
-- Name: FUNCTION get_cron_secret(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_cron_secret() FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_cron_secret() TO service_role;
GRANT ALL ON FUNCTION public.get_cron_secret() TO supabase_admin;


--
-- Name: FUNCTION get_edge_function_statuses(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_edge_function_statuses() TO anon;
GRANT ALL ON FUNCTION public.get_edge_function_statuses() TO authenticated;
GRANT ALL ON FUNCTION public.get_edge_function_statuses() TO service_role;


--
-- Name: FUNCTION get_email_stats(p_days integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_email_stats(p_days integer) TO anon;
GRANT ALL ON FUNCTION public.get_email_stats(p_days integer) TO authenticated;
GRANT ALL ON FUNCTION public.get_email_stats(p_days integer) TO service_role;


--
-- Name: FUNCTION get_health_history(p_hours integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_health_history(p_hours integer) TO anon;
GRANT ALL ON FUNCTION public.get_health_history(p_hours integer) TO authenticated;
GRANT ALL ON FUNCTION public.get_health_history(p_hours integer) TO service_role;


--
-- Name: FUNCTION get_latest_health_snapshot(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_latest_health_snapshot() TO anon;
GRANT ALL ON FUNCTION public.get_latest_health_snapshot() TO authenticated;
GRANT ALL ON FUNCTION public.get_latest_health_snapshot() TO service_role;


--
-- Name: FUNCTION get_my_notifications(p_unread_only boolean, p_limit integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_my_notifications(p_unread_only boolean, p_limit integer) TO anon;
GRANT ALL ON FUNCTION public.get_my_notifications(p_unread_only boolean, p_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.get_my_notifications(p_unread_only boolean, p_limit integer) TO service_role;


--
-- Name: FUNCTION get_notification_stats(p_notification_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_notification_stats(p_notification_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_notification_stats(p_notification_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_notification_stats(p_notification_id uuid) TO service_role;


--
-- Name: FUNCTION get_openinary_backfill_batch(p_limit integer, p_retry_failed boolean); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.get_openinary_backfill_batch(p_limit integer, p_retry_failed boolean) FROM PUBLIC;
GRANT ALL ON FUNCTION public.get_openinary_backfill_batch(p_limit integer, p_retry_failed boolean) TO service_role;


--
-- Name: FUNCTION get_system_logs_filtered(p_level text, p_service text, p_hours integer, p_limit integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_system_logs_filtered(p_level text, p_service text, p_hours integer, p_limit integer) TO anon;
GRANT ALL ON FUNCTION public.get_system_logs_filtered(p_level text, p_service text, p_hours integer, p_limit integer) TO authenticated;
GRANT ALL ON FUNCTION public.get_system_logs_filtered(p_level text, p_service text, p_hours integer, p_limit integer) TO service_role;


--
-- Name: FUNCTION get_user_role(_user_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.get_user_role(_user_id uuid) TO anon;
GRANT ALL ON FUNCTION public.get_user_role(_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.get_user_role(_user_id uuid) TO service_role;


--
-- Name: FUNCTION handle_new_user(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.handle_new_user() TO anon;
GRANT ALL ON FUNCTION public.handle_new_user() TO authenticated;
GRANT ALL ON FUNCTION public.handle_new_user() TO service_role;


--
-- Name: FUNCTION handle_new_user_quota(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.handle_new_user_quota() TO anon;
GRANT ALL ON FUNCTION public.handle_new_user_quota() TO authenticated;
GRANT ALL ON FUNCTION public.handle_new_user_quota() TO service_role;


--
-- Name: FUNCTION handle_new_user_referral_code(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.handle_new_user_referral_code() TO anon;
GRANT ALL ON FUNCTION public.handle_new_user_referral_code() TO authenticated;
GRANT ALL ON FUNCTION public.handle_new_user_referral_code() TO service_role;


--
-- Name: FUNCTION handle_new_user_role(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.handle_new_user_role() TO anon;
GRANT ALL ON FUNCTION public.handle_new_user_role() TO authenticated;
GRANT ALL ON FUNCTION public.handle_new_user_role() TO service_role;


--
-- Name: FUNCTION handle_subscription_change(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.handle_subscription_change() TO anon;
GRANT ALL ON FUNCTION public.handle_subscription_change() TO authenticated;
GRANT ALL ON FUNCTION public.handle_subscription_change() TO service_role;


--
-- Name: FUNCTION has_role(_user_id uuid, _role public.app_role); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.has_role(_user_id uuid, _role public.app_role) TO anon;
GRANT ALL ON FUNCTION public.has_role(_user_id uuid, _role public.app_role) TO authenticated;
GRANT ALL ON FUNCTION public.has_role(_user_id uuid, _role public.app_role) TO service_role;


--
-- Name: FUNCTION import_whatsapp_contacts(p_rows jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.import_whatsapp_contacts(p_rows jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.import_whatsapp_contacts(p_rows jsonb) TO postgres;
GRANT ALL ON FUNCTION public.import_whatsapp_contacts(p_rows jsonb) TO service_role;


--
-- Name: FUNCTION import_whatsapp_contacts_to_workspace(p_workspace_id uuid, p_rows jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.import_whatsapp_contacts_to_workspace(p_workspace_id uuid, p_rows jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.import_whatsapp_contacts_to_workspace(p_workspace_id uuid, p_rows jsonb) TO anon;
GRANT ALL ON FUNCTION public.import_whatsapp_contacts_to_workspace(p_workspace_id uuid, p_rows jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.import_whatsapp_contacts_to_workspace(p_workspace_id uuid, p_rows jsonb) TO service_role;


--
-- Name: FUNCTION import_whatsapp_conversations(p_rows jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.import_whatsapp_conversations(p_rows jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.import_whatsapp_conversations(p_rows jsonb) TO postgres;
GRANT ALL ON FUNCTION public.import_whatsapp_conversations(p_rows jsonb) TO service_role;


--
-- Name: FUNCTION import_whatsapp_messages(p_rows jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.import_whatsapp_messages(p_rows jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.import_whatsapp_messages(p_rows jsonb) TO postgres;
GRANT ALL ON FUNCTION public.import_whatsapp_messages(p_rows jsonb) TO service_role;


--
-- Name: FUNCTION increment_media_uploads(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.increment_media_uploads(p_user_id uuid) TO anon;
GRANT ALL ON FUNCTION public.increment_media_uploads(p_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.increment_media_uploads(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION increment_template_use_count(p_template_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.increment_template_use_count(p_template_id uuid) TO anon;
GRANT ALL ON FUNCTION public.increment_template_use_count(p_template_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.increment_template_use_count(p_template_id uuid) TO service_role;


--
-- Name: FUNCTION is_coupon_valid(p_code text, p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.is_coupon_valid(p_code text, p_user_id uuid) TO anon;
GRANT ALL ON FUNCTION public.is_coupon_valid(p_code text, p_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_coupon_valid(p_code text, p_user_id uuid) TO service_role;


--
-- Name: FUNCTION is_workspace_member(p_workspace_id uuid, p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.is_workspace_member(p_workspace_id uuid, p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.is_workspace_member(p_workspace_id uuid, p_user_id uuid) TO anon;
GRANT ALL ON FUNCTION public.is_workspace_member(p_workspace_id uuid, p_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.is_workspace_member(p_workspace_id uuid, p_user_id uuid) TO service_role;


--
-- Name: FUNCTION list_my_webhook_subscriptions(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.list_my_webhook_subscriptions() FROM PUBLIC;
GRANT ALL ON FUNCTION public.list_my_webhook_subscriptions() TO postgres;
GRANT ALL ON FUNCTION public.list_my_webhook_subscriptions() TO authenticated;
GRANT ALL ON FUNCTION public.list_my_webhook_subscriptions() TO service_role;


--
-- Name: FUNCTION log_admin_action(p_action text, p_resource_type text, p_resource_id text, p_details jsonb); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.log_admin_action(p_action text, p_resource_type text, p_resource_id text, p_details jsonb) TO anon;
GRANT ALL ON FUNCTION public.log_admin_action(p_action text, p_resource_type text, p_resource_id text, p_details jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.log_admin_action(p_action text, p_resource_type text, p_resource_id text, p_details jsonb) TO service_role;


--
-- Name: FUNCTION log_email_sent(p_template_slug text, p_recipient_email text, p_recipient_id uuid, p_subject text, p_provider_id text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.log_email_sent(p_template_slug text, p_recipient_email text, p_recipient_id uuid, p_subject text, p_provider_id text) TO anon;
GRANT ALL ON FUNCTION public.log_email_sent(p_template_slug text, p_recipient_email text, p_recipient_id uuid, p_subject text, p_provider_id text) TO authenticated;
GRANT ALL ON FUNCTION public.log_email_sent(p_template_slug text, p_recipient_email text, p_recipient_id uuid, p_subject text, p_provider_id text) TO service_role;


--
-- Name: FUNCTION log_system_event(p_level text, p_service text, p_message text, p_details jsonb, p_error_code text, p_error_message text, p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.log_system_event(p_level text, p_service text, p_message text, p_details jsonb, p_error_code text, p_error_message text, p_user_id uuid) TO anon;
GRANT ALL ON FUNCTION public.log_system_event(p_level text, p_service text, p_message text, p_details jsonb, p_error_code text, p_error_message text, p_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.log_system_event(p_level text, p_service text, p_message text, p_details jsonb, p_error_code text, p_error_message text, p_user_id uuid) TO service_role;


--
-- Name: FUNCTION mark_all_notifications_read(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.mark_all_notifications_read() TO anon;
GRANT ALL ON FUNCTION public.mark_all_notifications_read() TO authenticated;
GRANT ALL ON FUNCTION public.mark_all_notifications_read() TO service_role;


--
-- Name: FUNCTION mark_notification_dismissed(p_notification_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.mark_notification_dismissed(p_notification_id uuid) TO anon;
GRANT ALL ON FUNCTION public.mark_notification_dismissed(p_notification_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.mark_notification_dismissed(p_notification_id uuid) TO service_role;


--
-- Name: FUNCTION mark_notification_read(p_notification_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.mark_notification_read(p_notification_id uuid) TO anon;
GRANT ALL ON FUNCTION public.mark_notification_read(p_notification_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.mark_notification_read(p_notification_id uuid) TO service_role;


--
-- Name: FUNCTION match_ai_knowledge_chunks(query_embedding public.vector, p_user_id uuid, match_count integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.match_ai_knowledge_chunks(query_embedding public.vector, p_user_id uuid, match_count integer) TO anon;
GRANT ALL ON FUNCTION public.match_ai_knowledge_chunks(query_embedding public.vector, p_user_id uuid, match_count integer) TO authenticated;
GRANT ALL ON FUNCTION public.match_ai_knowledge_chunks(query_embedding public.vector, p_user_id uuid, match_count integer) TO service_role;


--
-- Name: FUNCTION match_ai_knowledge_chunks_bge_m3(query_embedding public.vector, p_user_id uuid, match_count integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.match_ai_knowledge_chunks_bge_m3(query_embedding public.vector, p_user_id uuid, match_count integer) TO postgres;
GRANT ALL ON FUNCTION public.match_ai_knowledge_chunks_bge_m3(query_embedding public.vector, p_user_id uuid, match_count integer) TO anon;
GRANT ALL ON FUNCTION public.match_ai_knowledge_chunks_bge_m3(query_embedding public.vector, p_user_id uuid, match_count integer) TO authenticated;
GRANT ALL ON FUNCTION public.match_ai_knowledge_chunks_bge_m3(query_embedding public.vector, p_user_id uuid, match_count integer) TO service_role;


--
-- Name: FUNCTION match_ai_knowledge_chunks_bge_m3_for_account(query_embedding public.vector, p_user_id uuid, p_social_account_id uuid, match_count integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.match_ai_knowledge_chunks_bge_m3_for_account(query_embedding public.vector, p_user_id uuid, p_social_account_id uuid, match_count integer) TO anon;
GRANT ALL ON FUNCTION public.match_ai_knowledge_chunks_bge_m3_for_account(query_embedding public.vector, p_user_id uuid, p_social_account_id uuid, match_count integer) TO authenticated;
GRANT ALL ON FUNCTION public.match_ai_knowledge_chunks_bge_m3_for_account(query_embedding public.vector, p_user_id uuid, p_social_account_id uuid, match_count integer) TO service_role;


--
-- Name: FUNCTION match_ai_knowledge_chunks_for_account(query_embedding public.vector, p_user_id uuid, p_social_account_id uuid, match_count integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.match_ai_knowledge_chunks_for_account(query_embedding public.vector, p_user_id uuid, p_social_account_id uuid, match_count integer) TO anon;
GRANT ALL ON FUNCTION public.match_ai_knowledge_chunks_for_account(query_embedding public.vector, p_user_id uuid, p_social_account_id uuid, match_count integer) TO authenticated;
GRANT ALL ON FUNCTION public.match_ai_knowledge_chunks_for_account(query_embedding public.vector, p_user_id uuid, p_social_account_id uuid, match_count integer) TO service_role;


--
-- Name: FUNCTION match_ai_knowledge_graph_relations(p_user_id uuid, p_source_chunk_ids uuid[], match_count integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.match_ai_knowledge_graph_relations(p_user_id uuid, p_source_chunk_ids uuid[], match_count integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.match_ai_knowledge_graph_relations(p_user_id uuid, p_source_chunk_ids uuid[], match_count integer) TO postgres;
GRANT ALL ON FUNCTION public.match_ai_knowledge_graph_relations(p_user_id uuid, p_source_chunk_ids uuid[], match_count integer) TO anon;
GRANT ALL ON FUNCTION public.match_ai_knowledge_graph_relations(p_user_id uuid, p_source_chunk_ids uuid[], match_count integer) TO authenticated;
GRANT ALL ON FUNCTION public.match_ai_knowledge_graph_relations(p_user_id uuid, p_source_chunk_ids uuid[], match_count integer) TO service_role;


--
-- Name: FUNCTION match_ai_knowledge_graph_relations_for_account(p_user_id uuid, p_social_account_id uuid, p_source_chunk_ids uuid[], match_count integer); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.match_ai_knowledge_graph_relations_for_account(p_user_id uuid, p_social_account_id uuid, p_source_chunk_ids uuid[], match_count integer) TO anon;
GRANT ALL ON FUNCTION public.match_ai_knowledge_graph_relations_for_account(p_user_id uuid, p_social_account_id uuid, p_source_chunk_ids uuid[], match_count integer) TO authenticated;
GRANT ALL ON FUNCTION public.match_ai_knowledge_graph_relations_for_account(p_user_id uuid, p_social_account_id uuid, p_source_chunk_ids uuid[], match_count integer) TO service_role;


--
-- Name: FUNCTION move_whatsapp_deal(p_deal_id uuid, p_stage_id uuid, p_position integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.move_whatsapp_deal(p_deal_id uuid, p_stage_id uuid, p_position integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.move_whatsapp_deal(p_deal_id uuid, p_stage_id uuid, p_position integer) TO anon;
GRANT ALL ON FUNCTION public.move_whatsapp_deal(p_deal_id uuid, p_stage_id uuid, p_position integer) TO authenticated;
GRANT ALL ON FUNCTION public.move_whatsapp_deal(p_deal_id uuid, p_stage_id uuid, p_position integer) TO service_role;


--
-- Name: FUNCTION next_media_seq(p_user_id uuid, p_upload_date date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.next_media_seq(p_user_id uuid, p_upload_date date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.next_media_seq(p_user_id uuid, p_upload_date date) TO authenticated;
GRANT ALL ON FUNCTION public.next_media_seq(p_user_id uuid, p_upload_date date) TO service_role;


--
-- Name: FUNCTION normalize_workspace_invitation_email(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.normalize_workspace_invitation_email() TO anon;
GRANT ALL ON FUNCTION public.normalize_workspace_invitation_email() TO authenticated;
GRANT ALL ON FUNCTION public.normalize_workspace_invitation_email() TO service_role;


--
-- Name: FUNCTION partner_api_keys_workspace_is_immutable(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.partner_api_keys_workspace_is_immutable() TO postgres;
GRANT ALL ON FUNCTION public.partner_api_keys_workspace_is_immutable() TO anon;
GRANT ALL ON FUNCTION public.partner_api_keys_workspace_is_immutable() TO authenticated;
GRANT ALL ON FUNCTION public.partner_api_keys_workspace_is_immutable() TO service_role;


--
-- Name: FUNCTION partner_audit_logs_assert_tenancy(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.partner_audit_logs_assert_tenancy() FROM PUBLIC;
GRANT ALL ON FUNCTION public.partner_audit_logs_assert_tenancy() TO postgres;
GRANT ALL ON FUNCTION public.partner_audit_logs_assert_tenancy() TO authenticated;
GRANT ALL ON FUNCTION public.partner_audit_logs_assert_tenancy() TO service_role;


--
-- Name: FUNCTION patch_account_metadata(p_account_id uuid, p_patch jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.patch_account_metadata(p_account_id uuid, p_patch jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.patch_account_metadata(p_account_id uuid, p_patch jsonb) TO postgres;
GRANT ALL ON FUNCTION public.patch_account_metadata(p_account_id uuid, p_patch jsonb) TO anon;
GRANT ALL ON FUNCTION public.patch_account_metadata(p_account_id uuid, p_patch jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.patch_account_metadata(p_account_id uuid, p_patch jsonb) TO service_role;


--
-- Name: FUNCTION prevent_last_workspace_owner(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.prevent_last_workspace_owner() TO anon;
GRANT ALL ON FUNCTION public.prevent_last_workspace_owner() TO authenticated;
GRANT ALL ON FUNCTION public.prevent_last_workspace_owner() TO service_role;


--
-- Name: FUNCTION prune_ai_knowledge_entities(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.prune_ai_knowledge_entities(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.prune_ai_knowledge_entities(p_user_id uuid) TO postgres;
GRANT ALL ON FUNCTION public.prune_ai_knowledge_entities(p_user_id uuid) TO anon;
GRANT ALL ON FUNCTION public.prune_ai_knowledge_entities(p_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.prune_ai_knowledge_entities(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION prune_all_ai_knowledge_entities(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.prune_all_ai_knowledge_entities() FROM PUBLIC;
GRANT ALL ON FUNCTION public.prune_all_ai_knowledge_entities() TO postgres;
GRANT ALL ON FUNCTION public.prune_all_ai_knowledge_entities() TO anon;
GRANT ALL ON FUNCTION public.prune_all_ai_knowledge_entities() TO authenticated;
GRANT ALL ON FUNCTION public.prune_all_ai_knowledge_entities() TO service_role;


--
-- Name: FUNCTION reap_exhausted_agent_replies(p_max_attempts integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reap_exhausted_agent_replies(p_max_attempts integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reap_exhausted_agent_replies(p_max_attempts integer) TO service_role;


--
-- Name: FUNCTION record_unmatched_webhook_observations(p_platform text, p_observations jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.record_unmatched_webhook_observations(p_platform text, p_observations jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.record_unmatched_webhook_observations(p_platform text, p_observations jsonb) TO postgres;
GRANT ALL ON FUNCTION public.record_unmatched_webhook_observations(p_platform text, p_observations jsonb) TO service_role;


--
-- Name: FUNCTION redeem_coupon(p_code text, p_user_id uuid, p_subscription_id uuid); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.redeem_coupon(p_code text, p_user_id uuid, p_subscription_id uuid) TO anon;
GRANT ALL ON FUNCTION public.redeem_coupon(p_code text, p_user_id uuid, p_subscription_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.redeem_coupon(p_code text, p_user_id uuid, p_subscription_id uuid) TO service_role;


--
-- Name: FUNCTION release_ai_generation_quota(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.release_ai_generation_quota(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.release_ai_generation_quota(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION release_partner_quota(p_key_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.release_partner_quota(p_key_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.release_partner_quota(p_key_id uuid) TO service_role;


--
-- Name: FUNCTION render_email_template(p_slug text, p_variables jsonb); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.render_email_template(p_slug text, p_variables jsonb) TO anon;
GRANT ALL ON FUNCTION public.render_email_template(p_slug text, p_variables jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.render_email_template(p_slug text, p_variables jsonb) TO service_role;


--
-- Name: FUNCTION reserve_ai_generation_quota(p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reserve_ai_generation_quota(p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reserve_ai_generation_quota(p_user_id uuid) TO service_role;


--
-- Name: FUNCTION reserve_media_understanding(p_account_id uuid, p_cap integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reserve_media_understanding(p_account_id uuid, p_cap integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reserve_media_understanding(p_account_id uuid, p_cap integer) TO postgres;
GRANT ALL ON FUNCTION public.reserve_media_understanding(p_account_id uuid, p_cap integer) TO service_role;


--
-- Name: FUNCTION reserve_media_understanding_attempt(p_account_id uuid, p_cap integer, p_sender_id text, p_sender_cap integer); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reserve_media_understanding_attempt(p_account_id uuid, p_cap integer, p_sender_id text, p_sender_cap integer) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reserve_media_understanding_attempt(p_account_id uuid, p_cap integer, p_sender_id text, p_sender_cap integer) TO postgres;
GRANT ALL ON FUNCTION public.reserve_media_understanding_attempt(p_account_id uuid, p_cap integer, p_sender_id text, p_sender_cap integer) TO service_role;


--
-- Name: FUNCTION reserve_partner_quota(p_key_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reserve_partner_quota(p_key_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reserve_partner_quota(p_key_id uuid) TO service_role;


--
-- Name: FUNCTION retire_expired_workspace_invitations(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.retire_expired_workspace_invitations() TO anon;
GRANT ALL ON FUNCTION public.retire_expired_workspace_invitations() TO authenticated;
GRANT ALL ON FUNCTION public.retire_expired_workspace_invitations() TO service_role;


--
-- Name: FUNCTION revoke_partner_key(p_key_id uuid, p_reason text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.revoke_partner_key(p_key_id uuid, p_reason text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.revoke_partner_key(p_key_id uuid, p_reason text) TO authenticated;
GRANT ALL ON FUNCTION public.revoke_partner_key(p_key_id uuid, p_reason text) TO service_role;


--
-- Name: FUNCTION set_ai_knowledge_source_visibility(p_user_id uuid, p_source_id uuid, p_visibility text, p_social_account_ids uuid[]); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.set_ai_knowledge_source_visibility(p_user_id uuid, p_source_id uuid, p_visibility text, p_social_account_ids uuid[]) FROM PUBLIC;
GRANT ALL ON FUNCTION public.set_ai_knowledge_source_visibility(p_user_id uuid, p_source_id uuid, p_visibility text, p_social_account_ids uuid[]) TO anon;
GRANT ALL ON FUNCTION public.set_ai_knowledge_source_visibility(p_user_id uuid, p_source_id uuid, p_visibility text, p_social_account_ids uuid[]) TO authenticated;
GRANT ALL ON FUNCTION public.set_ai_knowledge_source_visibility(p_user_id uuid, p_source_id uuid, p_visibility text, p_social_account_ids uuid[]) TO service_role;


--
-- Name: FUNCTION set_user_quotas_for_plan(p_user_id uuid, p_plan_slug text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_user_quotas_for_plan(p_user_id uuid, p_plan_slug text) TO anon;
GRANT ALL ON FUNCTION public.set_user_quotas_for_plan(p_user_id uuid, p_plan_slug text) TO authenticated;
GRANT ALL ON FUNCTION public.set_user_quotas_for_plan(p_user_id uuid, p_plan_slug text) TO service_role;


--
-- Name: FUNCTION set_whatsapp_workspace_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.set_whatsapp_workspace_updated_at() TO anon;
GRANT ALL ON FUNCTION public.set_whatsapp_workspace_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.set_whatsapp_workspace_updated_at() TO service_role;


--
-- Name: FUNCTION social_account_inbound_activity(); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.social_account_inbound_activity() FROM PUBLIC;
GRANT ALL ON FUNCTION public.social_account_inbound_activity() TO postgres;
GRANT ALL ON FUNCTION public.social_account_inbound_activity() TO authenticated;
GRANT ALL ON FUNCTION public.social_account_inbound_activity() TO service_role;


--
-- Name: FUNCTION sync_contact_to_conversations(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.sync_contact_to_conversations() TO anon;
GRANT ALL ON FUNCTION public.sync_contact_to_conversations() TO authenticated;
GRANT ALL ON FUNCTION public.sync_contact_to_conversations() TO service_role;


--
-- Name: FUNCTION toggle_checklist_item(p_item_id uuid, p_completed boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.toggle_checklist_item(p_item_id uuid, p_completed boolean) TO anon;
GRANT ALL ON FUNCTION public.toggle_checklist_item(p_item_id uuid, p_completed boolean) TO authenticated;
GRANT ALL ON FUNCTION public.toggle_checklist_item(p_item_id uuid, p_completed boolean) TO service_role;


--
-- Name: FUNCTION toggle_cron_job(_jobid bigint, _active boolean); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.toggle_cron_job(_jobid bigint, _active boolean) TO anon;
GRANT ALL ON FUNCTION public.toggle_cron_job(_jobid bigint, _active boolean) TO authenticated;
GRANT ALL ON FUNCTION public.toggle_cron_job(_jobid bigint, _active boolean) TO service_role;


--
-- Name: FUNCTION touch_partner_key(p_key_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.touch_partner_key(p_key_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.touch_partner_key(p_key_id uuid) TO service_role;


--
-- Name: FUNCTION update_coupons_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_coupons_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_coupons_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_coupons_updated_at() TO service_role;


--
-- Name: FUNCTION update_email_status(p_provider_id text, p_status text, p_error_message text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_email_status(p_provider_id text, p_status text, p_error_message text) TO anon;
GRANT ALL ON FUNCTION public.update_email_status(p_provider_id text, p_status text, p_error_message text) TO authenticated;
GRANT ALL ON FUNCTION public.update_email_status(p_provider_id text, p_status text, p_error_message text) TO service_role;


--
-- Name: FUNCTION update_ticket_status(p_ticket_id uuid, p_status text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_ticket_status(p_ticket_id uuid, p_status text) TO anon;
GRANT ALL ON FUNCTION public.update_ticket_status(p_ticket_id uuid, p_status text) TO authenticated;
GRANT ALL ON FUNCTION public.update_ticket_status(p_ticket_id uuid, p_status text) TO service_role;


--
-- Name: FUNCTION update_tickets_updated_at(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_tickets_updated_at() TO anon;
GRANT ALL ON FUNCTION public.update_tickets_updated_at() TO authenticated;
GRANT ALL ON FUNCTION public.update_tickets_updated_at() TO service_role;


--
-- Name: FUNCTION update_updated_at_column(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.update_updated_at_column() TO anon;
GRANT ALL ON FUNCTION public.update_updated_at_column() TO authenticated;
GRANT ALL ON FUNCTION public.update_updated_at_column() TO service_role;


--
-- Name: FUNCTION use_credits(p_user_id uuid, p_amount integer, p_description text); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.use_credits(p_user_id uuid, p_amount integer, p_description text) TO anon;
GRANT ALL ON FUNCTION public.use_credits(p_user_id uuid, p_amount integer, p_description text) TO authenticated;
GRANT ALL ON FUNCTION public.use_credits(p_user_id uuid, p_amount integer, p_description text) TO service_role;


--
-- Name: FUNCTION validate_messaging_cache_platform(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.validate_messaging_cache_platform() TO anon;
GRANT ALL ON FUNCTION public.validate_messaging_cache_platform() TO authenticated;
GRANT ALL ON FUNCTION public.validate_messaging_cache_platform() TO service_role;


--
-- Name: FUNCTION workspace_role(p_workspace_id uuid, p_user_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.workspace_role(p_workspace_id uuid, p_user_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.workspace_role(p_workspace_id uuid, p_user_id uuid) TO anon;
GRANT ALL ON FUNCTION public.workspace_role(p_workspace_id uuid, p_user_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.workspace_role(p_workspace_id uuid, p_user_id uuid) TO service_role;


--
-- Name: FUNCTION apply_rls(wal jsonb, max_record_bytes integer); Type: ACL; Schema: realtime; Owner: -
--

GRANT ALL ON FUNCTION realtime.apply_rls(wal jsonb, max_record_bytes integer) TO postgres;
GRANT ALL ON FUNCTION realtime.apply_rls(wal jsonb, max_record_bytes integer) TO dashboard_user;
GRANT ALL ON FUNCTION realtime.apply_rls(wal jsonb, max_record_bytes integer) TO anon;
GRANT ALL ON FUNCTION realtime.apply_rls(wal jsonb, max_record_bytes integer) TO authenticated;
GRANT ALL ON FUNCTION realtime.apply_rls(wal jsonb, max_record_bytes integer) TO service_role;
GRANT ALL ON FUNCTION realtime.apply_rls(wal jsonb, max_record_bytes integer) TO supabase_realtime_admin;


--
-- Name: FUNCTION broadcast_changes(topic_name text, event_name text, operation text, table_name text, table_schema text, new record, old record, level text); Type: ACL; Schema: realtime; Owner: -
--

GRANT ALL ON FUNCTION realtime.broadcast_changes(topic_name text, event_name text, operation text, table_name text, table_schema text, new record, old record, level text) TO postgres;
GRANT ALL ON FUNCTION realtime.broadcast_changes(topic_name text, event_name text, operation text, table_name text, table_schema text, new record, old record, level text) TO dashboard_user;


--
-- Name: FUNCTION build_prepared_statement_sql(prepared_statement_name text, entity regclass, columns realtime.wal_column[]); Type: ACL; Schema: realtime; Owner: -
--

GRANT ALL ON FUNCTION realtime.build_prepared_statement_sql(prepared_statement_name text, entity regclass, columns realtime.wal_column[]) TO postgres;
GRANT ALL ON FUNCTION realtime.build_prepared_statement_sql(prepared_statement_name text, entity regclass, columns realtime.wal_column[]) TO dashboard_user;
GRANT ALL ON FUNCTION realtime.build_prepared_statement_sql(prepared_statement_name text, entity regclass, columns realtime.wal_column[]) TO anon;
GRANT ALL ON FUNCTION realtime.build_prepared_statement_sql(prepared_statement_name text, entity regclass, columns realtime.wal_column[]) TO authenticated;
GRANT ALL ON FUNCTION realtime.build_prepared_statement_sql(prepared_statement_name text, entity regclass, columns realtime.wal_column[]) TO service_role;
GRANT ALL ON FUNCTION realtime.build_prepared_statement_sql(prepared_statement_name text, entity regclass, columns realtime.wal_column[]) TO supabase_realtime_admin;


--
-- Name: FUNCTION "cast"(val text, type_ regtype); Type: ACL; Schema: realtime; Owner: -
--

GRANT ALL ON FUNCTION realtime."cast"(val text, type_ regtype) TO postgres;
GRANT ALL ON FUNCTION realtime."cast"(val text, type_ regtype) TO dashboard_user;
GRANT ALL ON FUNCTION realtime."cast"(val text, type_ regtype) TO anon;
GRANT ALL ON FUNCTION realtime."cast"(val text, type_ regtype) TO authenticated;
GRANT ALL ON FUNCTION realtime."cast"(val text, type_ regtype) TO service_role;
GRANT ALL ON FUNCTION realtime."cast"(val text, type_ regtype) TO supabase_realtime_admin;


--
-- Name: FUNCTION check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text); Type: ACL; Schema: realtime; Owner: -
--

GRANT ALL ON FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text) TO postgres;
GRANT ALL ON FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text) TO dashboard_user;
GRANT ALL ON FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text) TO anon;
GRANT ALL ON FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text) TO authenticated;
GRANT ALL ON FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text) TO service_role;
GRANT ALL ON FUNCTION realtime.check_equality_op(op realtime.equality_op, type_ regtype, val_1 text, val_2 text) TO supabase_realtime_admin;


--
-- Name: FUNCTION is_visible_through_filters(columns realtime.wal_column[], filters realtime.user_defined_filter[]); Type: ACL; Schema: realtime; Owner: -
--

GRANT ALL ON FUNCTION realtime.is_visible_through_filters(columns realtime.wal_column[], filters realtime.user_defined_filter[]) TO postgres;
GRANT ALL ON FUNCTION realtime.is_visible_through_filters(columns realtime.wal_column[], filters realtime.user_defined_filter[]) TO dashboard_user;
GRANT ALL ON FUNCTION realtime.is_visible_through_filters(columns realtime.wal_column[], filters realtime.user_defined_filter[]) TO anon;
GRANT ALL ON FUNCTION realtime.is_visible_through_filters(columns realtime.wal_column[], filters realtime.user_defined_filter[]) TO authenticated;
GRANT ALL ON FUNCTION realtime.is_visible_through_filters(columns realtime.wal_column[], filters realtime.user_defined_filter[]) TO service_role;
GRANT ALL ON FUNCTION realtime.is_visible_through_filters(columns realtime.wal_column[], filters realtime.user_defined_filter[]) TO supabase_realtime_admin;


--
-- Name: FUNCTION list_changes(publication name, slot_name name, max_changes integer, max_record_bytes integer); Type: ACL; Schema: realtime; Owner: -
--

GRANT ALL ON FUNCTION realtime.list_changes(publication name, slot_name name, max_changes integer, max_record_bytes integer) TO postgres;
GRANT ALL ON FUNCTION realtime.list_changes(publication name, slot_name name, max_changes integer, max_record_bytes integer) TO dashboard_user;
GRANT ALL ON FUNCTION realtime.list_changes(publication name, slot_name name, max_changes integer, max_record_bytes integer) TO anon;
GRANT ALL ON FUNCTION realtime.list_changes(publication name, slot_name name, max_changes integer, max_record_bytes integer) TO authenticated;
GRANT ALL ON FUNCTION realtime.list_changes(publication name, slot_name name, max_changes integer, max_record_bytes integer) TO service_role;
GRANT ALL ON FUNCTION realtime.list_changes(publication name, slot_name name, max_changes integer, max_record_bytes integer) TO supabase_realtime_admin;


--
-- Name: FUNCTION quote_wal2json(entity regclass); Type: ACL; Schema: realtime; Owner: -
--

GRANT ALL ON FUNCTION realtime.quote_wal2json(entity regclass) TO postgres;
GRANT ALL ON FUNCTION realtime.quote_wal2json(entity regclass) TO dashboard_user;
GRANT ALL ON FUNCTION realtime.quote_wal2json(entity regclass) TO anon;
GRANT ALL ON FUNCTION realtime.quote_wal2json(entity regclass) TO authenticated;
GRANT ALL ON FUNCTION realtime.quote_wal2json(entity regclass) TO service_role;
GRANT ALL ON FUNCTION realtime.quote_wal2json(entity regclass) TO supabase_realtime_admin;


--
-- Name: FUNCTION send(payload jsonb, event text, topic text, private boolean); Type: ACL; Schema: realtime; Owner: -
--

GRANT ALL ON FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean) TO postgres;
GRANT ALL ON FUNCTION realtime.send(payload jsonb, event text, topic text, private boolean) TO dashboard_user;


--
-- Name: FUNCTION subscription_check_filters(); Type: ACL; Schema: realtime; Owner: -
--

GRANT ALL ON FUNCTION realtime.subscription_check_filters() TO postgres;
GRANT ALL ON FUNCTION realtime.subscription_check_filters() TO dashboard_user;
GRANT ALL ON FUNCTION realtime.subscription_check_filters() TO anon;
GRANT ALL ON FUNCTION realtime.subscription_check_filters() TO authenticated;
GRANT ALL ON FUNCTION realtime.subscription_check_filters() TO service_role;
GRANT ALL ON FUNCTION realtime.subscription_check_filters() TO supabase_realtime_admin;


--
-- Name: FUNCTION to_regrole(role_name text); Type: ACL; Schema: realtime; Owner: -
--

GRANT ALL ON FUNCTION realtime.to_regrole(role_name text) TO postgres;
GRANT ALL ON FUNCTION realtime.to_regrole(role_name text) TO dashboard_user;
GRANT ALL ON FUNCTION realtime.to_regrole(role_name text) TO anon;
GRANT ALL ON FUNCTION realtime.to_regrole(role_name text) TO authenticated;
GRANT ALL ON FUNCTION realtime.to_regrole(role_name text) TO service_role;
GRANT ALL ON FUNCTION realtime.to_regrole(role_name text) TO supabase_realtime_admin;


--
-- Name: FUNCTION topic(); Type: ACL; Schema: realtime; Owner: -
--

GRANT ALL ON FUNCTION realtime.topic() TO postgres;
GRANT ALL ON FUNCTION realtime.topic() TO dashboard_user;


--
-- Name: TABLE audit_log_entries; Type: ACL; Schema: auth; Owner: -
--

GRANT ALL ON TABLE auth.audit_log_entries TO dashboard_user;
GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.audit_log_entries TO postgres;
GRANT SELECT ON TABLE auth.audit_log_entries TO postgres WITH GRANT OPTION;


--
-- Name: TABLE flow_state; Type: ACL; Schema: auth; Owner: -
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.flow_state TO postgres;
GRANT SELECT ON TABLE auth.flow_state TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.flow_state TO dashboard_user;


--
-- Name: TABLE identities; Type: ACL; Schema: auth; Owner: -
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.identities TO postgres;
GRANT SELECT ON TABLE auth.identities TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.identities TO dashboard_user;


--
-- Name: TABLE instances; Type: ACL; Schema: auth; Owner: -
--

GRANT ALL ON TABLE auth.instances TO dashboard_user;
GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.instances TO postgres;
GRANT SELECT ON TABLE auth.instances TO postgres WITH GRANT OPTION;


--
-- Name: TABLE mfa_amr_claims; Type: ACL; Schema: auth; Owner: -
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.mfa_amr_claims TO postgres;
GRANT SELECT ON TABLE auth.mfa_amr_claims TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.mfa_amr_claims TO dashboard_user;


--
-- Name: TABLE mfa_challenges; Type: ACL; Schema: auth; Owner: -
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.mfa_challenges TO postgres;
GRANT SELECT ON TABLE auth.mfa_challenges TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.mfa_challenges TO dashboard_user;


--
-- Name: TABLE mfa_factors; Type: ACL; Schema: auth; Owner: -
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.mfa_factors TO postgres;
GRANT SELECT ON TABLE auth.mfa_factors TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.mfa_factors TO dashboard_user;


--
-- Name: TABLE one_time_tokens; Type: ACL; Schema: auth; Owner: -
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.one_time_tokens TO postgres;
GRANT SELECT ON TABLE auth.one_time_tokens TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.one_time_tokens TO dashboard_user;


--
-- Name: TABLE refresh_tokens; Type: ACL; Schema: auth; Owner: -
--

GRANT ALL ON TABLE auth.refresh_tokens TO dashboard_user;
GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.refresh_tokens TO postgres;
GRANT SELECT ON TABLE auth.refresh_tokens TO postgres WITH GRANT OPTION;


--
-- Name: SEQUENCE refresh_tokens_id_seq; Type: ACL; Schema: auth; Owner: -
--

GRANT ALL ON SEQUENCE auth.refresh_tokens_id_seq TO dashboard_user;
GRANT ALL ON SEQUENCE auth.refresh_tokens_id_seq TO postgres;


--
-- Name: TABLE saml_providers; Type: ACL; Schema: auth; Owner: -
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.saml_providers TO postgres;
GRANT SELECT ON TABLE auth.saml_providers TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.saml_providers TO dashboard_user;


--
-- Name: TABLE saml_relay_states; Type: ACL; Schema: auth; Owner: -
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.saml_relay_states TO postgres;
GRANT SELECT ON TABLE auth.saml_relay_states TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.saml_relay_states TO dashboard_user;


--
-- Name: TABLE schema_migrations; Type: ACL; Schema: auth; Owner: -
--

GRANT SELECT ON TABLE auth.schema_migrations TO postgres WITH GRANT OPTION;


--
-- Name: TABLE sessions; Type: ACL; Schema: auth; Owner: -
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.sessions TO postgres;
GRANT SELECT ON TABLE auth.sessions TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.sessions TO dashboard_user;


--
-- Name: TABLE sso_domains; Type: ACL; Schema: auth; Owner: -
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.sso_domains TO postgres;
GRANT SELECT ON TABLE auth.sso_domains TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.sso_domains TO dashboard_user;


--
-- Name: TABLE sso_providers; Type: ACL; Schema: auth; Owner: -
--

GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.sso_providers TO postgres;
GRANT SELECT ON TABLE auth.sso_providers TO postgres WITH GRANT OPTION;
GRANT ALL ON TABLE auth.sso_providers TO dashboard_user;


--
-- Name: TABLE users; Type: ACL; Schema: auth; Owner: -
--

GRANT ALL ON TABLE auth.users TO dashboard_user;
GRANT INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,MAINTAIN,UPDATE ON TABLE auth.users TO postgres;
GRANT SELECT ON TABLE auth.users TO postgres WITH GRANT OPTION;


--
-- Name: TABLE admin_audit_log; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admin_audit_log TO anon;
GRANT ALL ON TABLE public.admin_audit_log TO authenticated;
GRANT ALL ON TABLE public.admin_audit_log TO service_role;


--
-- Name: TABLE admin_inbox_messages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admin_inbox_messages TO anon;
GRANT ALL ON TABLE public.admin_inbox_messages TO authenticated;
GRANT ALL ON TABLE public.admin_inbox_messages TO service_role;


--
-- Name: TABLE admin_notifications; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.admin_notifications TO anon;
GRANT ALL ON TABLE public.admin_notifications TO authenticated;
GRANT ALL ON TABLE public.admin_notifications TO service_role;


--
-- Name: TABLE ai_agent_allowed_models; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_agent_allowed_models TO postgres;
GRANT ALL ON TABLE public.ai_agent_allowed_models TO anon;
GRANT ALL ON TABLE public.ai_agent_allowed_models TO authenticated;
GRANT ALL ON TABLE public.ai_agent_allowed_models TO service_role;


--
-- Name: TABLE ai_agent_configs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_agent_configs TO anon;
GRANT ALL ON TABLE public.ai_agent_configs TO authenticated;
GRANT ALL ON TABLE public.ai_agent_configs TO service_role;


--
-- Name: TABLE ai_agent_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_agent_logs TO anon;
GRANT ALL ON TABLE public.ai_agent_logs TO authenticated;
GRANT ALL ON TABLE public.ai_agent_logs TO service_role;


--
-- Name: TABLE ai_agent_tools; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_agent_tools TO anon;
GRANT ALL ON TABLE public.ai_agent_tools TO authenticated;
GRANT ALL ON TABLE public.ai_agent_tools TO service_role;


--
-- Name: TABLE ai_conversation_modes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_conversation_modes TO anon;
GRANT ALL ON TABLE public.ai_conversation_modes TO authenticated;
GRANT ALL ON TABLE public.ai_conversation_modes TO service_role;


--
-- Name: TABLE ai_generation_jobs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_generation_jobs TO anon;
GRANT ALL ON TABLE public.ai_generation_jobs TO authenticated;
GRANT ALL ON TABLE public.ai_generation_jobs TO service_role;


--
-- Name: TABLE ai_knowledge_chunks; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_knowledge_chunks TO anon;
GRANT ALL ON TABLE public.ai_knowledge_chunks TO authenticated;
GRANT ALL ON TABLE public.ai_knowledge_chunks TO service_role;


--
-- Name: TABLE ai_knowledge_entities; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_knowledge_entities TO postgres;
GRANT ALL ON TABLE public.ai_knowledge_entities TO anon;
GRANT ALL ON TABLE public.ai_knowledge_entities TO authenticated;
GRANT ALL ON TABLE public.ai_knowledge_entities TO service_role;


--
-- Name: TABLE ai_knowledge_graph_exports; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_knowledge_graph_exports TO postgres;
GRANT ALL ON TABLE public.ai_knowledge_graph_exports TO anon;
GRANT ALL ON TABLE public.ai_knowledge_graph_exports TO authenticated;
GRANT ALL ON TABLE public.ai_knowledge_graph_exports TO service_role;


--
-- Name: TABLE ai_knowledge_relations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_knowledge_relations TO postgres;
GRANT ALL ON TABLE public.ai_knowledge_relations TO anon;
GRANT ALL ON TABLE public.ai_knowledge_relations TO authenticated;
GRANT ALL ON TABLE public.ai_knowledge_relations TO service_role;


--
-- Name: TABLE ai_knowledge_source_accounts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_knowledge_source_accounts TO anon;
GRANT ALL ON TABLE public.ai_knowledge_source_accounts TO authenticated;
GRANT ALL ON TABLE public.ai_knowledge_source_accounts TO service_role;


--
-- Name: TABLE ai_model_preferences; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_model_preferences TO anon;
GRANT ALL ON TABLE public.ai_model_preferences TO authenticated;
GRANT ALL ON TABLE public.ai_model_preferences TO service_role;


--
-- Name: TABLE ai_models; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_models TO anon;
GRANT ALL ON TABLE public.ai_models TO authenticated;
GRANT ALL ON TABLE public.ai_models TO service_role;


--
-- Name: TABLE ai_providers; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_providers TO anon;
GRANT ALL ON TABLE public.ai_providers TO authenticated;
GRANT ALL ON TABLE public.ai_providers TO service_role;


--
-- Name: TABLE ai_thread_messages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_thread_messages TO anon;
GRANT ALL ON TABLE public.ai_thread_messages TO authenticated;
GRANT ALL ON TABLE public.ai_thread_messages TO service_role;


--
-- Name: TABLE ai_threads; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ai_threads TO anon;
GRANT ALL ON TABLE public.ai_threads TO authenticated;
GRANT ALL ON TABLE public.ai_threads TO service_role;


--
-- Name: TABLE api_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.api_logs TO anon;
GRANT ALL ON TABLE public.api_logs TO authenticated;
GRANT ALL ON TABLE public.api_logs TO service_role;


--
-- Name: TABLE app_credentials; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.app_credentials TO anon;
GRANT ALL ON TABLE public.app_credentials TO authenticated;
GRANT ALL ON TABLE public.app_credentials TO service_role;


--
-- Name: TABLE app_settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.app_settings TO anon;
GRANT ALL ON TABLE public.app_settings TO authenticated;
GRANT ALL ON TABLE public.app_settings TO service_role;


--
-- Name: TABLE automation_dispatch_log; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.automation_dispatch_log TO postgres;
GRANT ALL ON TABLE public.automation_dispatch_log TO anon;
GRANT ALL ON TABLE public.automation_dispatch_log TO authenticated;
GRANT ALL ON TABLE public.automation_dispatch_log TO service_role;


--
-- Name: TABLE backup_codes; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.backup_codes TO service_role;


--
-- Name: TABLE bi_post_content; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.bi_post_content TO anon;
GRANT ALL ON TABLE public.bi_post_content TO authenticated;
GRANT ALL ON TABLE public.bi_post_content TO service_role;


--
-- Name: TABLE blog_posts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.blog_posts TO anon;
GRANT ALL ON TABLE public.blog_posts TO authenticated;
GRANT ALL ON TABLE public.blog_posts TO service_role;


--
-- Name: TABLE brand_scrape_cache; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.brand_scrape_cache TO anon;
GRANT ALL ON TABLE public.brand_scrape_cache TO authenticated;
GRANT ALL ON TABLE public.brand_scrape_cache TO service_role;


--
-- Name: TABLE brand_scrape_sessions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.brand_scrape_sessions TO anon;
GRANT ALL ON TABLE public.brand_scrape_sessions TO authenticated;
GRANT ALL ON TABLE public.brand_scrape_sessions TO service_role;


--
-- Name: TABLE brand_search_history; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.brand_search_history TO postgres;
GRANT ALL ON TABLE public.brand_search_history TO anon;
GRANT ALL ON TABLE public.brand_search_history TO authenticated;
GRANT ALL ON TABLE public.brand_search_history TO service_role;


--
-- Name: TABLE caption_history; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.caption_history TO anon;
GRANT ALL ON TABLE public.caption_history TO authenticated;
GRANT ALL ON TABLE public.caption_history TO service_role;


--
-- Name: TABLE comment_inbox_cache; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.comment_inbox_cache TO anon;
GRANT ALL ON TABLE public.comment_inbox_cache TO authenticated;
GRANT ALL ON TABLE public.comment_inbox_cache TO service_role;


--
-- Name: TABLE coupon_redemptions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.coupon_redemptions TO anon;
GRANT ALL ON TABLE public.coupon_redemptions TO authenticated;
GRANT ALL ON TABLE public.coupon_redemptions TO service_role;


--
-- Name: TABLE coupons; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.coupons TO anon;
GRANT ALL ON TABLE public.coupons TO authenticated;
GRANT ALL ON TABLE public.coupons TO service_role;


--
-- Name: TABLE credit_transactions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.credit_transactions TO anon;
GRANT ALL ON TABLE public.credit_transactions TO authenticated;
GRANT ALL ON TABLE public.credit_transactions TO service_role;


--
-- Name: TABLE deployment_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.deployment_logs TO anon;
GRANT ALL ON TABLE public.deployment_logs TO authenticated;
GRANT ALL ON TABLE public.deployment_logs TO service_role;


--
-- Name: TABLE edge_function_status; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.edge_function_status TO anon;
GRANT ALL ON TABLE public.edge_function_status TO authenticated;
GRANT ALL ON TABLE public.edge_function_status TO service_role;


--
-- Name: TABLE email_contacts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.email_contacts TO anon;
GRANT ALL ON TABLE public.email_contacts TO authenticated;
GRANT ALL ON TABLE public.email_contacts TO service_role;


--
-- Name: TABLE email_drafts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.email_drafts TO anon;
GRANT ALL ON TABLE public.email_drafts TO authenticated;
GRANT ALL ON TABLE public.email_drafts TO service_role;


--
-- Name: TABLE email_log; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.email_log TO anon;
GRANT ALL ON TABLE public.email_log TO authenticated;
GRANT ALL ON TABLE public.email_log TO service_role;


--
-- Name: TABLE email_signatures; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.email_signatures TO anon;
GRANT ALL ON TABLE public.email_signatures TO authenticated;
GRANT ALL ON TABLE public.email_signatures TO service_role;


--
-- Name: TABLE email_templates; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.email_templates TO anon;
GRANT ALL ON TABLE public.email_templates TO authenticated;
GRANT ALL ON TABLE public.email_templates TO service_role;


--
-- Name: TABLE feature_flag_audit_log; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.feature_flag_audit_log TO anon;
GRANT ALL ON TABLE public.feature_flag_audit_log TO authenticated;
GRANT ALL ON TABLE public.feature_flag_audit_log TO service_role;


--
-- Name: TABLE feature_flag_schedules; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.feature_flag_schedules TO anon;
GRANT ALL ON TABLE public.feature_flag_schedules TO authenticated;
GRANT ALL ON TABLE public.feature_flag_schedules TO service_role;


--
-- Name: TABLE generated_content_collections; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.generated_content_collections TO anon;
GRANT ALL ON TABLE public.generated_content_collections TO authenticated;
GRANT ALL ON TABLE public.generated_content_collections TO service_role;


--
-- Name: TABLE higgsfield_connections; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.higgsfield_connections TO service_role;
GRANT DELETE ON TABLE public.higgsfield_connections TO authenticated;


--
-- Name: COLUMN higgsfield_connections.user_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(user_id) ON TABLE public.higgsfield_connections TO authenticated;


--
-- Name: COLUMN higgsfield_connections.expires_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(expires_at) ON TABLE public.higgsfield_connections TO authenticated;


--
-- Name: COLUMN higgsfield_connections.account_email; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(account_email) ON TABLE public.higgsfield_connections TO authenticated;


--
-- Name: TABLE higgsfield_connection_status; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.higgsfield_connection_status TO anon;
GRANT ALL ON TABLE public.higgsfield_connection_status TO authenticated;
GRANT ALL ON TABLE public.higgsfield_connection_status TO service_role;


--
-- Name: TABLE image_reference_presets; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.image_reference_presets TO anon;
GRANT ALL ON TABLE public.image_reference_presets TO authenticated;
GRANT ALL ON TABLE public.image_reference_presets TO service_role;


--
-- Name: TABLE launch_checklist; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.launch_checklist TO anon;
GRANT ALL ON TABLE public.launch_checklist TO authenticated;
GRANT ALL ON TABLE public.launch_checklist TO service_role;


--
-- Name: TABLE lead_forms; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.lead_forms TO anon;
GRANT ALL ON TABLE public.lead_forms TO authenticated;
GRANT ALL ON TABLE public.lead_forms TO service_role;


--
-- Name: TABLE leads; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.leads TO anon;
GRANT ALL ON TABLE public.leads TO authenticated;
GRANT ALL ON TABLE public.leads TO service_role;


--
-- Name: TABLE log_analyses; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.log_analyses TO anon;
GRANT ALL ON TABLE public.log_analyses TO authenticated;
GRANT ALL ON TABLE public.log_analyses TO service_role;


--
-- Name: TABLE mcp_oauth_authorizations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.mcp_oauth_authorizations TO anon;
GRANT ALL ON TABLE public.mcp_oauth_authorizations TO authenticated;
GRANT ALL ON TABLE public.mcp_oauth_authorizations TO service_role;


--
-- Name: TABLE mcp_oauth_clients; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.mcp_oauth_clients TO anon;
GRANT ALL ON TABLE public.mcp_oauth_clients TO authenticated;
GRANT ALL ON TABLE public.mcp_oauth_clients TO service_role;


--
-- Name: TABLE mcp_oauth_tokens; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.mcp_oauth_tokens TO anon;
GRANT ALL ON TABLE public.mcp_oauth_tokens TO authenticated;
GRANT ALL ON TABLE public.mcp_oauth_tokens TO service_role;


--
-- Name: TABLE media_file_providers; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.media_file_providers TO anon;
GRANT ALL ON TABLE public.media_file_providers TO authenticated;
GRANT ALL ON TABLE public.media_file_providers TO service_role;


--
-- Name: TABLE media_files; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.media_files TO anon;
GRANT ALL ON TABLE public.media_files TO authenticated;
GRANT ALL ON TABLE public.media_files TO service_role;


--
-- Name: TABLE media_folders; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.media_folders TO anon;
GRANT ALL ON TABLE public.media_folders TO authenticated;
GRANT ALL ON TABLE public.media_folders TO service_role;


--
-- Name: TABLE media_operations_history; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.media_operations_history TO anon;
GRANT ALL ON TABLE public.media_operations_history TO authenticated;
GRANT ALL ON TABLE public.media_operations_history TO service_role;


--
-- Name: TABLE media_understanding_sender_usage; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.media_understanding_sender_usage TO postgres;
GRANT ALL ON TABLE public.media_understanding_sender_usage TO anon;
GRANT ALL ON TABLE public.media_understanding_sender_usage TO authenticated;
GRANT ALL ON TABLE public.media_understanding_sender_usage TO service_role;


--
-- Name: TABLE media_understanding_usage; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.media_understanding_usage TO postgres;
GRANT ALL ON TABLE public.media_understanding_usage TO anon;
GRANT ALL ON TABLE public.media_understanding_usage TO authenticated;
GRANT ALL ON TABLE public.media_understanding_usage TO service_role;


--
-- Name: TABLE media_upload_counters; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.media_upload_counters TO anon;
GRANT ALL ON TABLE public.media_upload_counters TO authenticated;
GRANT ALL ON TABLE public.media_upload_counters TO service_role;


--
-- Name: TABLE messaging_cache; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.messaging_cache TO anon;
GRANT ALL ON TABLE public.messaging_cache TO authenticated;
GRANT ALL ON TABLE public.messaging_cache TO service_role;


--
-- Name: TABLE messenger_auto_replies; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.messenger_auto_replies TO anon;
GRANT ALL ON TABLE public.messenger_auto_replies TO authenticated;
GRANT ALL ON TABLE public.messenger_auto_replies TO service_role;


--
-- Name: TABLE messenger_auto_reply_usage; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.messenger_auto_reply_usage TO anon;
GRANT ALL ON TABLE public.messenger_auto_reply_usage TO authenticated;
GRANT ALL ON TABLE public.messenger_auto_reply_usage TO service_role;


--
-- Name: TABLE node_execution_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.node_execution_logs TO anon;
GRANT ALL ON TABLE public.node_execution_logs TO authenticated;
GRANT ALL ON TABLE public.node_execution_logs TO service_role;


--
-- Name: TABLE notification_reads; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.notification_reads TO anon;
GRANT ALL ON TABLE public.notification_reads TO authenticated;
GRANT ALL ON TABLE public.notification_reads TO service_role;


--
-- Name: TABLE oauth_apps; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.oauth_apps TO anon;
GRANT ALL ON TABLE public.oauth_apps TO authenticated;
GRANT ALL ON TABLE public.oauth_apps TO service_role;


--
-- Name: TABLE oauth_clients; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.oauth_clients TO anon;
GRANT ALL ON TABLE public.oauth_clients TO authenticated;
GRANT ALL ON TABLE public.oauth_clients TO service_role;


--
-- Name: TABLE oauth_pending_facebook_selections; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.oauth_pending_facebook_selections TO postgres;
GRANT ALL ON TABLE public.oauth_pending_facebook_selections TO anon;
GRANT ALL ON TABLE public.oauth_pending_facebook_selections TO authenticated;
GRANT ALL ON TABLE public.oauth_pending_facebook_selections TO service_role;


--
-- Name: TABLE oauth_pending_instagram_selections; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.oauth_pending_instagram_selections TO postgres;
GRANT ALL ON TABLE public.oauth_pending_instagram_selections TO anon;
GRANT ALL ON TABLE public.oauth_pending_instagram_selections TO authenticated;
GRANT ALL ON TABLE public.oauth_pending_instagram_selections TO service_role;


--
-- Name: TABLE oauth_redirect_requests; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.oauth_redirect_requests TO anon;
GRANT ALL ON TABLE public.oauth_redirect_requests TO authenticated;
GRANT ALL ON TABLE public.oauth_redirect_requests TO service_role;


--
-- Name: TABLE oauth_states; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.oauth_states TO anon;
GRANT ALL ON TABLE public.oauth_states TO authenticated;
GRANT ALL ON TABLE public.oauth_states TO service_role;


--
-- Name: TABLE observability_alert_configs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.observability_alert_configs TO anon;
GRANT ALL ON TABLE public.observability_alert_configs TO authenticated;
GRANT ALL ON TABLE public.observability_alert_configs TO service_role;


--
-- Name: TABLE observability_alert_history; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.observability_alert_history TO anon;
GRANT ALL ON TABLE public.observability_alert_history TO authenticated;
GRANT ALL ON TABLE public.observability_alert_history TO service_role;


--
-- Name: TABLE observability_health_snapshots; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.observability_health_snapshots TO anon;
GRANT ALL ON TABLE public.observability_health_snapshots TO authenticated;
GRANT ALL ON TABLE public.observability_health_snapshots TO service_role;


--
-- Name: TABLE observability_metrics; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.observability_metrics TO anon;
GRANT ALL ON TABLE public.observability_metrics TO authenticated;
GRANT ALL ON TABLE public.observability_metrics TO service_role;


--
-- Name: TABLE partner_api_idempotency; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,UPDATE ON TABLE public.partner_api_idempotency TO service_role;


--
-- Name: TABLE partner_api_key_accounts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.partner_api_key_accounts TO postgres;
GRANT ALL ON TABLE public.partner_api_key_accounts TO service_role;


--
-- Name: TABLE partner_api_keys; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT ON TABLE public.partner_api_keys TO service_role;


--
-- Name: COLUMN partner_api_keys.id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(id) ON TABLE public.partner_api_keys TO authenticated;


--
-- Name: COLUMN partner_api_keys.workspace_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(workspace_id) ON TABLE public.partner_api_keys TO authenticated;


--
-- Name: COLUMN partner_api_keys.social_account_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(social_account_id) ON TABLE public.partner_api_keys TO authenticated;


--
-- Name: COLUMN partner_api_keys.created_by; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(created_by) ON TABLE public.partner_api_keys TO authenticated;


--
-- Name: COLUMN partner_api_keys.revoked_by; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(revoked_by) ON TABLE public.partner_api_keys TO authenticated;


--
-- Name: COLUMN partner_api_keys.revoked_reason; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(revoked_reason) ON TABLE public.partner_api_keys TO authenticated;


--
-- Name: COLUMN partner_api_keys.name; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(name) ON TABLE public.partner_api_keys TO authenticated;


--
-- Name: COLUMN partner_api_keys.key_prefix; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(key_prefix) ON TABLE public.partner_api_keys TO authenticated;


--
-- Name: COLUMN partner_api_keys.scopes; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(scopes) ON TABLE public.partner_api_keys TO authenticated;


--
-- Name: COLUMN partner_api_keys.rate_limit_per_min; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(rate_limit_per_min) ON TABLE public.partner_api_keys TO authenticated;


--
-- Name: COLUMN partner_api_keys.monthly_quota; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(monthly_quota) ON TABLE public.partner_api_keys TO authenticated;


--
-- Name: COLUMN partner_api_keys.current_usage_count; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(current_usage_count) ON TABLE public.partner_api_keys TO authenticated;


--
-- Name: COLUMN partner_api_keys.last_reset_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(last_reset_at) ON TABLE public.partner_api_keys TO authenticated;


--
-- Name: COLUMN partner_api_keys.last_used_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(last_used_at) ON TABLE public.partner_api_keys TO authenticated;


--
-- Name: COLUMN partner_api_keys.expires_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(expires_at) ON TABLE public.partner_api_keys TO authenticated;


--
-- Name: COLUMN partner_api_keys.revoked_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(revoked_at) ON TABLE public.partner_api_keys TO authenticated;


--
-- Name: COLUMN partner_api_keys.created_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(created_at) ON TABLE public.partner_api_keys TO authenticated;


--
-- Name: COLUMN partner_api_keys.updated_at; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(updated_at) ON TABLE public.partner_api_keys TO authenticated;


--
-- Name: TABLE partner_api_usage; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT ON TABLE public.partner_api_usage TO service_role;


--
-- Name: TABLE partner_audit_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.partner_audit_logs TO postgres;
GRANT SELECT ON TABLE public.partner_audit_logs TO authenticated;
GRANT SELECT,INSERT ON TABLE public.partner_audit_logs TO service_role;


--
-- Name: TABLE password_reset_otps; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.password_reset_otps TO anon;
GRANT ALL ON TABLE public.password_reset_otps TO authenticated;
GRANT ALL ON TABLE public.password_reset_otps TO service_role;


--
-- Name: SEQUENCE pending_agent_replies_ingress_seq_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.pending_agent_replies_ingress_seq_seq TO anon;
GRANT ALL ON SEQUENCE public.pending_agent_replies_ingress_seq_seq TO authenticated;
GRANT ALL ON SEQUENCE public.pending_agent_replies_ingress_seq_seq TO service_role;


--
-- Name: TABLE platform_posts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.platform_posts TO anon;
GRANT ALL ON TABLE public.platform_posts TO authenticated;
GRANT ALL ON TABLE public.platform_posts TO service_role;


--
-- Name: TABLE post_templates; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.post_templates TO anon;
GRANT ALL ON TABLE public.post_templates TO authenticated;
GRANT ALL ON TABLE public.post_templates TO service_role;


--
-- Name: TABLE posts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.posts TO anon;
GRANT ALL ON TABLE public.posts TO authenticated;
GRANT ALL ON TABLE public.posts TO service_role;


--
-- Name: TABLE profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.profiles TO anon;
GRANT ALL ON TABLE public.profiles TO authenticated;
GRANT ALL ON TABLE public.profiles TO service_role;


--
-- Name: TABLE profiles_public; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.profiles_public TO anon;
GRANT ALL ON TABLE public.profiles_public TO authenticated;
GRANT ALL ON TABLE public.profiles_public TO service_role;


--
-- Name: TABLE provider_api_keys; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.provider_api_keys TO anon;
GRANT ALL ON TABLE public.provider_api_keys TO authenticated;
GRANT ALL ON TABLE public.provider_api_keys TO service_role;


--
-- Name: TABLE social_accounts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.social_accounts TO anon;
GRANT ALL ON TABLE public.social_accounts TO authenticated;
GRANT ALL ON TABLE public.social_accounts TO service_role;


--
-- Name: TABLE social_profiles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.social_profiles TO anon;
GRANT ALL ON TABLE public.social_profiles TO authenticated;
GRANT ALL ON TABLE public.social_profiles TO service_role;


--
-- Name: TABLE public_social_accounts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.public_social_accounts TO anon;
GRANT ALL ON TABLE public.public_social_accounts TO authenticated;
GRANT ALL ON TABLE public.public_social_accounts TO service_role;


--
-- Name: TABLE rate_limit_buckets; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.rate_limit_buckets TO postgres;
GRANT ALL ON TABLE public.rate_limit_buckets TO service_role;


--
-- Name: TABLE rate_limit_settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.rate_limit_settings TO anon;
GRANT ALL ON TABLE public.rate_limit_settings TO authenticated;
GRANT ALL ON TABLE public.rate_limit_settings TO service_role;


--
-- Name: TABLE referrals; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.referrals TO anon;
GRANT ALL ON TABLE public.referrals TO authenticated;
GRANT ALL ON TABLE public.referrals TO service_role;


--
-- Name: TABLE saved_field_suggestions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.saved_field_suggestions TO anon;
GRANT ALL ON TABLE public.saved_field_suggestions TO authenticated;
GRANT ALL ON TABLE public.saved_field_suggestions TO service_role;


--
-- Name: TABLE scheduled_emails; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.scheduled_emails TO anon;
GRANT ALL ON TABLE public.scheduled_emails TO authenticated;
GRANT ALL ON TABLE public.scheduled_emails TO service_role;


--
-- Name: TABLE social_inbox_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.social_inbox_events TO postgres;
GRANT ALL ON TABLE public.social_inbox_events TO anon;
GRANT ALL ON TABLE public.social_inbox_events TO authenticated;
GRANT ALL ON TABLE public.social_inbox_events TO service_role;


--
-- Name: TABLE stripe_webhook_events; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.stripe_webhook_events TO postgres;
GRANT ALL ON TABLE public.stripe_webhook_events TO service_role;


--
-- Name: TABLE subscription_plans; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.subscription_plans TO anon;
GRANT ALL ON TABLE public.subscription_plans TO authenticated;
GRANT ALL ON TABLE public.subscription_plans TO service_role;


--
-- Name: TABLE support_messages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.support_messages TO anon;
GRANT ALL ON TABLE public.support_messages TO authenticated;
GRANT ALL ON TABLE public.support_messages TO service_role;


--
-- Name: SEQUENCE support_tickets_ticket_number_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.support_tickets_ticket_number_seq TO anon;
GRANT ALL ON SEQUENCE public.support_tickets_ticket_number_seq TO authenticated;
GRANT ALL ON SEQUENCE public.support_tickets_ticket_number_seq TO service_role;


--
-- Name: TABLE support_tickets; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.support_tickets TO anon;
GRANT ALL ON TABLE public.support_tickets TO authenticated;
GRANT ALL ON TABLE public.support_tickets TO service_role;


--
-- Name: TABLE system_health_snapshots; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.system_health_snapshots TO anon;
GRANT ALL ON TABLE public.system_health_snapshots TO authenticated;
GRANT ALL ON TABLE public.system_health_snapshots TO service_role;


--
-- Name: TABLE system_logs; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.system_logs TO anon;
GRANT ALL ON TABLE public.system_logs TO authenticated;
GRANT ALL ON TABLE public.system_logs TO service_role;


--
-- Name: TABLE system_notifications; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.system_notifications TO anon;
GRANT ALL ON TABLE public.system_notifications TO authenticated;
GRANT ALL ON TABLE public.system_notifications TO service_role;


--
-- Name: TABLE system_settings; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.system_settings TO anon;
GRANT ALL ON TABLE public.system_settings TO authenticated;
GRANT ALL ON TABLE public.system_settings TO service_role;


--
-- Name: TABLE threads_mentions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.threads_mentions TO anon;
GRANT ALL ON TABLE public.threads_mentions TO authenticated;
GRANT ALL ON TABLE public.threads_mentions TO service_role;


--
-- Name: TABLE threads_recent_searches; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.threads_recent_searches TO anon;
GRANT ALL ON TABLE public.threads_recent_searches TO authenticated;
GRANT ALL ON TABLE public.threads_recent_searches TO service_role;


--
-- Name: TABLE threads_reply_cache; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.threads_reply_cache TO anon;
GRANT ALL ON TABLE public.threads_reply_cache TO authenticated;
GRANT ALL ON TABLE public.threads_reply_cache TO service_role;


--
-- Name: TABLE ticket_activities; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ticket_activities TO anon;
GRANT ALL ON TABLE public.ticket_activities TO authenticated;
GRANT ALL ON TABLE public.ticket_activities TO service_role;


--
-- Name: TABLE ticket_messages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.ticket_messages TO anon;
GRANT ALL ON TABLE public.ticket_messages TO authenticated;
GRANT ALL ON TABLE public.ticket_messages TO service_role;


--
-- Name: TABLE tier_rate_limits; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.tier_rate_limits TO anon;
GRANT ALL ON TABLE public.tier_rate_limits TO authenticated;
GRANT ALL ON TABLE public.tier_rate_limits TO service_role;


--
-- Name: TABLE tiktok_api_analytics_cache; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.tiktok_api_analytics_cache TO anon;
GRANT ALL ON TABLE public.tiktok_api_analytics_cache TO authenticated;
GRANT ALL ON TABLE public.tiktok_api_analytics_cache TO service_role;


--
-- Name: TABLE token_refresh_history; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.token_refresh_history TO anon;
GRANT ALL ON TABLE public.token_refresh_history TO authenticated;
GRANT ALL ON TABLE public.token_refresh_history TO service_role;


--
-- Name: TABLE user_ai_model_overrides; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_ai_model_overrides TO anon;
GRANT ALL ON TABLE public.user_ai_model_overrides TO authenticated;
GRANT ALL ON TABLE public.user_ai_model_overrides TO service_role;


--
-- Name: TABLE user_blog_post_reads; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_blog_post_reads TO anon;
GRANT ALL ON TABLE public.user_blog_post_reads TO authenticated;
GRANT ALL ON TABLE public.user_blog_post_reads TO service_role;


--
-- Name: TABLE user_connectors; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_connectors TO anon;
GRANT ALL ON TABLE public.user_connectors TO authenticated;
GRANT ALL ON TABLE public.user_connectors TO service_role;


--
-- Name: TABLE user_credits; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_credits TO anon;
GRANT ALL ON TABLE public.user_credits TO authenticated;
GRANT ALL ON TABLE public.user_credits TO service_role;


--
-- Name: TABLE user_feature_overrides; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_feature_overrides TO anon;
GRANT ALL ON TABLE public.user_feature_overrides TO authenticated;
GRANT ALL ON TABLE public.user_feature_overrides TO service_role;


--
-- Name: TABLE user_notification_preferences; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_notification_preferences TO anon;
GRANT ALL ON TABLE public.user_notification_preferences TO authenticated;
GRANT ALL ON TABLE public.user_notification_preferences TO service_role;


--
-- Name: TABLE user_notification_reads; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_notification_reads TO anon;
GRANT ALL ON TABLE public.user_notification_reads TO authenticated;
GRANT ALL ON TABLE public.user_notification_reads TO service_role;


--
-- Name: TABLE user_quotas; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_quotas TO anon;
GRANT ALL ON TABLE public.user_quotas TO authenticated;
GRANT ALL ON TABLE public.user_quotas TO service_role;


--
-- Name: TABLE user_quotas_backup_20260823; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_quotas_backup_20260823 TO postgres;
GRANT ALL ON TABLE public.user_quotas_backup_20260823 TO anon;
GRANT ALL ON TABLE public.user_quotas_backup_20260823 TO authenticated;
GRANT ALL ON TABLE public.user_quotas_backup_20260823 TO service_role;


--
-- Name: TABLE user_rate_limits; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_rate_limits TO anon;
GRANT ALL ON TABLE public.user_rate_limits TO authenticated;
GRANT ALL ON TABLE public.user_rate_limits TO service_role;


--
-- Name: TABLE user_roles; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_roles TO anon;
GRANT ALL ON TABLE public.user_roles TO authenticated;
GRANT ALL ON TABLE public.user_roles TO service_role;


--
-- Name: TABLE user_subscriptions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.user_subscriptions TO anon;
GRANT ALL ON TABLE public.user_subscriptions TO authenticated;
GRANT ALL ON TABLE public.user_subscriptions TO service_role;


--
-- Name: TABLE video_processing_presets; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.video_processing_presets TO anon;
GRANT ALL ON TABLE public.video_processing_presets TO authenticated;
GRANT ALL ON TABLE public.video_processing_presets TO service_role;


--
-- Name: TABLE webhook_unmatched_observations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.webhook_unmatched_observations TO postgres;
GRANT ALL ON TABLE public.webhook_unmatched_observations TO anon;
GRANT ALL ON TABLE public.webhook_unmatched_observations TO authenticated;
GRANT ALL ON TABLE public.webhook_unmatched_observations TO service_role;


--
-- Name: TABLE whatsapp_agents; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_agents TO anon;
GRANT ALL ON TABLE public.whatsapp_agents TO authenticated;
GRANT ALL ON TABLE public.whatsapp_agents TO service_role;


--
-- Name: TABLE whatsapp_assignment_history; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_assignment_history TO anon;
GRANT ALL ON TABLE public.whatsapp_assignment_history TO authenticated;
GRANT ALL ON TABLE public.whatsapp_assignment_history TO service_role;


--
-- Name: TABLE whatsapp_auto_replies; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_auto_replies TO anon;
GRANT ALL ON TABLE public.whatsapp_auto_replies TO authenticated;
GRANT ALL ON TABLE public.whatsapp_auto_replies TO service_role;


--
-- Name: TABLE whatsapp_auto_reply_usage; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_auto_reply_usage TO anon;
GRANT ALL ON TABLE public.whatsapp_auto_reply_usage TO authenticated;
GRANT ALL ON TABLE public.whatsapp_auto_reply_usage TO service_role;


--
-- Name: TABLE whatsapp_broadcast_recipients; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_broadcast_recipients TO anon;
GRANT ALL ON TABLE public.whatsapp_broadcast_recipients TO authenticated;
GRANT ALL ON TABLE public.whatsapp_broadcast_recipients TO service_role;


--
-- Name: TABLE whatsapp_broadcasts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_broadcasts TO anon;
GRANT ALL ON TABLE public.whatsapp_broadcasts TO authenticated;
GRANT ALL ON TABLE public.whatsapp_broadcasts TO service_role;


--
-- Name: TABLE whatsapp_contact_group_members; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_contact_group_members TO anon;
GRANT ALL ON TABLE public.whatsapp_contact_group_members TO authenticated;
GRANT ALL ON TABLE public.whatsapp_contact_group_members TO service_role;


--
-- Name: TABLE whatsapp_contact_groups; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_contact_groups TO anon;
GRANT ALL ON TABLE public.whatsapp_contact_groups TO authenticated;
GRANT ALL ON TABLE public.whatsapp_contact_groups TO service_role;


--
-- Name: TABLE whatsapp_contacts; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_contacts TO anon;
GRANT ALL ON TABLE public.whatsapp_contacts TO authenticated;
GRANT ALL ON TABLE public.whatsapp_contacts TO service_role;


--
-- Name: TABLE whatsapp_conversation_assignments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_conversation_assignments TO anon;
GRANT ALL ON TABLE public.whatsapp_conversation_assignments TO authenticated;
GRANT ALL ON TABLE public.whatsapp_conversation_assignments TO service_role;


--
-- Name: TABLE whatsapp_conversation_label_assignments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_conversation_label_assignments TO anon;
GRANT ALL ON TABLE public.whatsapp_conversation_label_assignments TO authenticated;
GRANT ALL ON TABLE public.whatsapp_conversation_label_assignments TO service_role;


--
-- Name: TABLE whatsapp_conversation_labels; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_conversation_labels TO anon;
GRANT ALL ON TABLE public.whatsapp_conversation_labels TO authenticated;
GRANT ALL ON TABLE public.whatsapp_conversation_labels TO service_role;


--
-- Name: TABLE whatsapp_deals; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_deals TO anon;
GRANT ALL ON TABLE public.whatsapp_deals TO authenticated;
GRANT ALL ON TABLE public.whatsapp_deals TO service_role;


--
-- Name: TABLE whatsapp_evolution_instances; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_evolution_instances TO postgres;
GRANT ALL ON TABLE public.whatsapp_evolution_instances TO service_role;


--
-- Name: TABLE whatsapp_message_analytics; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_message_analytics TO anon;
GRANT ALL ON TABLE public.whatsapp_message_analytics TO authenticated;
GRANT ALL ON TABLE public.whatsapp_message_analytics TO service_role;


--
-- Name: TABLE whatsapp_message_flags; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_message_flags TO postgres;
GRANT ALL ON TABLE public.whatsapp_message_flags TO anon;
GRANT ALL ON TABLE public.whatsapp_message_flags TO authenticated;
GRANT ALL ON TABLE public.whatsapp_message_flags TO service_role;


--
-- Name: TABLE whatsapp_message_templates; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_message_templates TO anon;
GRANT ALL ON TABLE public.whatsapp_message_templates TO authenticated;
GRANT ALL ON TABLE public.whatsapp_message_templates TO service_role;


--
-- Name: TABLE whatsapp_messages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_messages TO anon;
GRANT ALL ON TABLE public.whatsapp_messages TO authenticated;
GRANT ALL ON TABLE public.whatsapp_messages TO service_role;


--
-- Name: TABLE whatsapp_pipeline_stages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_pipeline_stages TO anon;
GRANT ALL ON TABLE public.whatsapp_pipeline_stages TO authenticated;
GRANT ALL ON TABLE public.whatsapp_pipeline_stages TO service_role;


--
-- Name: TABLE whatsapp_pipelines; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_pipelines TO anon;
GRANT ALL ON TABLE public.whatsapp_pipelines TO authenticated;
GRANT ALL ON TABLE public.whatsapp_pipelines TO service_role;


--
-- Name: TABLE whatsapp_quick_replies; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_quick_replies TO anon;
GRANT ALL ON TABLE public.whatsapp_quick_replies TO authenticated;
GRANT ALL ON TABLE public.whatsapp_quick_replies TO service_role;


--
-- Name: TABLE whatsapp_quick_reply_usage; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_quick_reply_usage TO anon;
GRANT ALL ON TABLE public.whatsapp_quick_reply_usage TO authenticated;
GRANT ALL ON TABLE public.whatsapp_quick_reply_usage TO service_role;


--
-- Name: TABLE whatsapp_scheduled_messages; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_scheduled_messages TO anon;
GRANT ALL ON TABLE public.whatsapp_scheduled_messages TO authenticated;
GRANT ALL ON TABLE public.whatsapp_scheduled_messages TO service_role;


--
-- Name: TABLE whatsapp_webhooks; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.whatsapp_webhooks TO anon;
GRANT ALL ON TABLE public.whatsapp_webhooks TO authenticated;
GRANT ALL ON TABLE public.whatsapp_webhooks TO service_role;


--
-- Name: TABLE workflow_comments; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.workflow_comments TO anon;
GRANT ALL ON TABLE public.workflow_comments TO authenticated;
GRANT ALL ON TABLE public.workflow_comments TO service_role;


--
-- Name: TABLE workflow_executions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.workflow_executions TO anon;
GRANT ALL ON TABLE public.workflow_executions TO authenticated;
GRANT ALL ON TABLE public.workflow_executions TO service_role;


--
-- Name: TABLE workflow_schedules; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.workflow_schedules TO anon;
GRANT ALL ON TABLE public.workflow_schedules TO authenticated;
GRANT ALL ON TABLE public.workflow_schedules TO service_role;


--
-- Name: TABLE workflow_templates; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.workflow_templates TO anon;
GRANT ALL ON TABLE public.workflow_templates TO authenticated;
GRANT ALL ON TABLE public.workflow_templates TO service_role;


--
-- Name: TABLE workflow_versions; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.workflow_versions TO anon;
GRANT ALL ON TABLE public.workflow_versions TO authenticated;
GRANT ALL ON TABLE public.workflow_versions TO service_role;


--
-- Name: TABLE workflow_webhooks; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.workflow_webhooks TO anon;
GRANT ALL ON TABLE public.workflow_webhooks TO authenticated;
GRANT ALL ON TABLE public.workflow_webhooks TO service_role;


--
-- Name: TABLE workflows; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.workflows TO anon;
GRANT ALL ON TABLE public.workflows TO authenticated;
GRANT ALL ON TABLE public.workflows TO service_role;


--
-- Name: TABLE workspace_invitations; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.workspace_invitations TO anon;
GRANT ALL ON TABLE public.workspace_invitations TO authenticated;
GRANT ALL ON TABLE public.workspace_invitations TO service_role;


--
-- Name: TABLE workspace_members; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.workspace_members TO anon;
GRANT ALL ON TABLE public.workspace_members TO authenticated;
GRANT ALL ON TABLE public.workspace_members TO service_role;


--
-- Name: TABLE workspaces; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON TABLE public.workspaces TO anon;
GRANT ALL ON TABLE public.workspaces TO authenticated;
GRANT ALL ON TABLE public.workspaces TO service_role;


--
-- Name: TABLE messages; Type: ACL; Schema: realtime; Owner: -
--

GRANT ALL ON TABLE realtime.messages TO postgres;
GRANT ALL ON TABLE realtime.messages TO dashboard_user;
GRANT SELECT,INSERT,UPDATE ON TABLE realtime.messages TO anon;
GRANT SELECT,INSERT,UPDATE ON TABLE realtime.messages TO authenticated;
GRANT SELECT,INSERT,UPDATE ON TABLE realtime.messages TO service_role;


--
-- Name: TABLE messages_2026_08_27; Type: ACL; Schema: realtime; Owner: -
--

GRANT ALL ON TABLE realtime.messages_2026_08_27 TO postgres;
GRANT ALL ON TABLE realtime.messages_2026_08_27 TO dashboard_user;


--
-- Name: TABLE messages_2026_08_28; Type: ACL; Schema: realtime; Owner: -
--

GRANT ALL ON TABLE realtime.messages_2026_08_28 TO postgres;
GRANT ALL ON TABLE realtime.messages_2026_08_28 TO dashboard_user;


--
-- Name: TABLE messages_2026_08_29; Type: ACL; Schema: realtime; Owner: -
--

GRANT ALL ON TABLE realtime.messages_2026_08_29 TO postgres;
GRANT ALL ON TABLE realtime.messages_2026_08_29 TO dashboard_user;


--
-- Name: TABLE messages_2026_08_30; Type: ACL; Schema: realtime; Owner: -
--

GRANT ALL ON TABLE realtime.messages_2026_08_30 TO postgres;
GRANT ALL ON TABLE realtime.messages_2026_08_30 TO dashboard_user;


--
-- Name: TABLE messages_2026_08_31; Type: ACL; Schema: realtime; Owner: -
--

GRANT ALL ON TABLE realtime.messages_2026_08_31 TO postgres;
GRANT ALL ON TABLE realtime.messages_2026_08_31 TO dashboard_user;


--
-- Name: TABLE messages_2026_09_01; Type: ACL; Schema: realtime; Owner: -
--

GRANT ALL ON TABLE realtime.messages_2026_09_01 TO postgres;
GRANT ALL ON TABLE realtime.messages_2026_09_01 TO dashboard_user;


--
-- Name: TABLE messages_2026_09_02; Type: ACL; Schema: realtime; Owner: -
--

GRANT ALL ON TABLE realtime.messages_2026_09_02 TO postgres;
GRANT ALL ON TABLE realtime.messages_2026_09_02 TO dashboard_user;


--
-- Name: TABLE schema_migrations; Type: ACL; Schema: realtime; Owner: -
--

GRANT ALL ON TABLE realtime.schema_migrations TO postgres;
GRANT ALL ON TABLE realtime.schema_migrations TO dashboard_user;
GRANT SELECT ON TABLE realtime.schema_migrations TO anon;
GRANT SELECT ON TABLE realtime.schema_migrations TO authenticated;
GRANT SELECT ON TABLE realtime.schema_migrations TO service_role;
GRANT ALL ON TABLE realtime.schema_migrations TO supabase_realtime_admin;


--
-- Name: TABLE subscription; Type: ACL; Schema: realtime; Owner: -
--

GRANT ALL ON TABLE realtime.subscription TO postgres;
GRANT ALL ON TABLE realtime.subscription TO dashboard_user;
GRANT SELECT ON TABLE realtime.subscription TO anon;
GRANT SELECT ON TABLE realtime.subscription TO authenticated;
GRANT SELECT ON TABLE realtime.subscription TO service_role;
GRANT ALL ON TABLE realtime.subscription TO supabase_realtime_admin;


--
-- Name: SEQUENCE subscription_id_seq; Type: ACL; Schema: realtime; Owner: -
--

GRANT ALL ON SEQUENCE realtime.subscription_id_seq TO postgres;
GRANT ALL ON SEQUENCE realtime.subscription_id_seq TO dashboard_user;
GRANT USAGE ON SEQUENCE realtime.subscription_id_seq TO anon;
GRANT USAGE ON SEQUENCE realtime.subscription_id_seq TO authenticated;
GRANT USAGE ON SEQUENCE realtime.subscription_id_seq TO service_role;
GRANT ALL ON SEQUENCE realtime.subscription_id_seq TO supabase_realtime_admin;


--
-- Name: TABLE buckets; Type: ACL; Schema: storage; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE storage.buckets TO service_role;


--
-- Name: TABLE objects; Type: ACL; Schema: storage; Owner: -
--

GRANT SELECT,INSERT,DELETE,UPDATE ON TABLE storage.objects TO service_role;


--
-- Name: TABLE prefixes; Type: ACL; Schema: storage; Owner: -
--

GRANT ALL ON TABLE storage.prefixes TO service_role;
GRANT ALL ON TABLE storage.prefixes TO authenticated;
GRANT ALL ON TABLE storage.prefixes TO anon;


--
-- Name: TABLE s3_multipart_uploads; Type: ACL; Schema: storage; Owner: -
--

GRANT ALL ON TABLE storage.s3_multipart_uploads TO service_role;
GRANT SELECT ON TABLE storage.s3_multipart_uploads TO authenticated;
GRANT SELECT ON TABLE storage.s3_multipart_uploads TO anon;


--
-- Name: TABLE s3_multipart_uploads_parts; Type: ACL; Schema: storage; Owner: -
--

GRANT ALL ON TABLE storage.s3_multipart_uploads_parts TO service_role;
GRANT SELECT ON TABLE storage.s3_multipart_uploads_parts TO authenticated;
GRANT SELECT ON TABLE storage.s3_multipart_uploads_parts TO anon;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: auth; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON SEQUENCES TO dashboard_user;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: auth; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON FUNCTIONS TO dashboard_user;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: auth; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_auth_admin IN SCHEMA auth GRANT ALL ON TABLES TO dashboard_user;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: realtime; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime GRANT ALL ON SEQUENCES TO dashboard_user;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: realtime; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime GRANT ALL ON FUNCTIONS TO dashboard_user;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: realtime; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA realtime GRANT ALL ON TABLES TO dashboard_user;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: storage; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: storage; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: storage; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA storage GRANT ALL ON TABLES TO service_role;


--
-- PostgreSQL database dump complete
--

\unrestrict W1bMlSUm0GFSUUfgv5osPQLUHbRzU9wXeqb1yublg4SHl9u240ffgcHOtqDxQhj

