-- Two read functions backing the user-facing half of the webhook observability work.
-- See docs/specs/2026-08-25-webhook-silent-failure-observability.md (R2, R3).

-- R2. The user's registered webhook subscriptions.
--
-- Why a SECURITY DEFINER function instead of an RLS policy on app_settings: those rows
-- carry webhook_secret in the same jsonb value, and RLS is row-level. No policy can hide
-- a column, so opening app_settings to its owner would hand them (and anything that can
-- read as them) the signing secret. The function projects explicitly instead, and the
-- secret is simply never in the select list.
--
-- It UNIONs both registries because dispatch does: loadDestinations in
-- _shared/n8nMessagingDispatch.ts reads app_settings AND whatsapp_webhooks. A card built
-- on app_settings alone would tell a user with a legacy WhatsApp destination that they
-- have no subscriptions at all -- the same false-negative this feature exists to kill.
create or replace function public.list_my_webhook_subscriptions()
returns table (
  registry          text,
  webhook_id        text,
  webhook_url       text,
  events            text[],
  platform          text,
  social_account_id uuid,
  is_active         boolean,
  failure_count     integer,
  created_at        timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
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

revoke execute on function public.list_my_webhook_subscriptions() from public;
revoke execute on function public.list_my_webhook_subscriptions() from anon;
grant  execute on function public.list_my_webhook_subscriptions() to authenticated;

-- R3. When each of the caller's accounts last received an inbound event.
--
-- SECURITY INVOKER on purpose: both source tables already carry a user_id = auth.uid()
-- SELECT policy, so the caller's own RLS does the scoping. A definer function here would
-- take on the job of re-implementing that correctly, for no gain.
--
-- The UNION is the whole point. WhatsApp inbound messages are written to
-- whatsapp_messages (whatsapp-webhook/index.ts), never to social_inbox_events, so a
-- single-source query would report "Never received an inbound event" for every WhatsApp
-- account -- a diagnostic that is not merely unhelpful but actively misleading, which is
-- worse than the silence it replaces.
create or replace function public.social_account_inbound_activity()
returns table (
  social_account_id uuid,
  last_event_at     timestamptz,
  events_7d         bigint
)
language sql
stable
security invoker
set search_path = public, pg_temp
as $$
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

revoke execute on function public.social_account_inbound_activity() from public;
revoke execute on function public.social_account_inbound_activity() from anon;
grant  execute on function public.social_account_inbound_activity() to authenticated;

-- Self-hosted PostgREST caches the schema; a new RPC stays invisible to the API until it
-- is told to reload. Without this the frontend would ship and fail on arrival.
notify pgrst, 'reload schema';
