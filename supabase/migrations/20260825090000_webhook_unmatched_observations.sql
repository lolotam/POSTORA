-- Inbound webhook events that could not be routed to a connected account.
--
-- Why this exists: on 2026-08-24 a Business-plan user's Instagram DMs never reached their
-- n8n trigger. Meta delivered every event and Postora verified every signature, but
-- findAccountForRecipient matched no social_accounts row, so the handler logged one
-- console.warn and dropped it. Diagnosing that took an hour of `docker logs` archaeology
-- because nothing was persisted. See
-- docs/investigations/2026-08-24-autoverse-instagram-n8n-trigger-no-events.md
--
-- Shape: a daily rollup, not a row per event. Cardinality is then bounded by distinct
-- recipients x kinds x reasons x days regardless of how much traffic a stranger id
-- generates, which an append-only table is not.

create table if not exists public.webhook_unmatched_observations (
  id                uuid        primary key default gen_random_uuid(),
  platform          text        not null check (platform in ('facebook', 'instagram', 'whatsapp')),
  recipient_id      text        not null check (length(recipient_id) <= 64),
  event_kind        text        not null check (event_kind in ('message', 'comment', 'unknown')),
  reason            text        not null check (reason in ('unknown_recipient', 'account_inactive')),
  observed_on       date        not null default current_date,
  first_seen_at     timestamptz not null default now(),
  last_seen_at      timestamptz not null default now(),
  -- Delivery ATTEMPTS observed, not distinct events. One entry carrying three unroutable
  -- messages counts three, and a Meta redelivery of that entry counts three more. The
  -- unique key below deduplicates rows, never events; deduplicating events would need a
  -- seven-day event-id claim table, which would reintroduce exactly the unbounded
  -- cardinality this rollup exists to avoid. What an operator needs here is which
  -- recipient is unroutable, not a precise count -- so the column is named for what it
  -- actually measures.
  attempts          integer     not null default 1,
  -- Envelope shape only: entry_keys, messaging_kinds, change_fields, change_field,
  -- entry_time. Never message text, media URLs, profile names, or ANY sender identifier.
  -- The no-sender-id rule is what makes the user-facing policy below safe by
  -- construction rather than by a sanitizing projection that a later reader could bypass.
  last_summary      jsonb       not null default '{}'::jsonb,
  -- Set only when the diagnostic lookup found an inactive row for this recipient.
  -- unknown_recipient observations have no owner, which is the whole point of them.
  social_account_id uuid        references public.social_accounts(id) on delete set null,
  user_id           uuid        references auth.users(id) on delete cascade,
  -- Every column here is NOT NULL on purpose: a nullable column in a unique key does not
  -- deduplicate, and the upsert below depends on this constraint being total.
  constraint webhook_unmatched_observations_daily_key
    unique (platform, recipient_id, event_kind, reason, observed_on)
);

create index if not exists webhook_unmatched_observations_recent_idx
  on public.webhook_unmatched_observations (observed_on desc, platform);

create index if not exists webhook_unmatched_observations_owner_idx
  on public.webhook_unmatched_observations (user_id, observed_on desc)
  where user_id is not null;

alter table public.webhook_unmatched_observations enable row level security;

-- The two policies are deliberately asymmetric.
--
-- Admins see everything, including recipients that belong to no Postora user -- which is
-- the incident's case and cannot be scoped to a user by any means.
drop policy if exists "Admins view unmatched observations" on public.webhook_unmatched_observations;
create policy "Admins view unmatched observations"
  on public.webhook_unmatched_observations
  for select to authenticated
  using (public.has_role(auth.uid(), 'admin'));

-- A user sees only observations the diagnostic lookup tied to an account they own, i.e.
-- reason = 'account_inactive'. There is deliberately no user policy reaching
-- unknown_recipient rows: they carry no user_id, so nothing user-scoped could show them.
drop policy if exists "Users view own unmatched observations" on public.webhook_unmatched_observations;
create policy "Users view own unmatched observations"
  on public.webhook_unmatched_observations
  for select to authenticated
  using (user_id = auth.uid());

-- Batched writer. One call per webhook request, not one per event: runInBackground's
-- degraded path awaits up to 2s per invocation (_shared/background.ts), so a per-event
-- call would put that cost on the Meta acknowledgement N times over.
create or replace function public.record_unmatched_webhook_observations(
  p_platform text,
  p_observations jsonb
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
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
      left(obs->>'recipient_id', 64)                      as recipient_id,
      obs->>'event_kind'                                  as event_kind,
      obs->>'reason'                                      as reason,
      coalesce(obs->'summary', '{}'::jsonb)               as summary,
      nullif(obs->>'social_account_id', '')::uuid         as social_account_id,
      nullif(obs->>'user_id', '')::uuid                   as user_id
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
      count(*)::integer                as attempts,
      (array_agg(summary))[1]          as summary,
      max(social_account_id)           as social_account_id,
      max(user_id)                     as user_id
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

-- Revoking from PUBLIC also strips what service_role inherited through it. Without the
-- grant that follows, the only intended caller loses access -- and because the call is
-- best-effort inside runInBackground, that failure would be completely silent, which is
-- the exact bug class this table exists to eliminate.
revoke execute on function public.record_unmatched_webhook_observations(text, jsonb) from public;
revoke execute on function public.record_unmatched_webhook_observations(text, jsonb) from anon;
revoke execute on function public.record_unmatched_webhook_observations(text, jsonb) from authenticated;
grant  execute on function public.record_unmatched_webhook_observations(text, jsonb) to service_role;

-- Retention: 7 days. Same unschedule-then-schedule idempotency shape as
-- 20260823090000_threads_reply_poller_cron.sql.
do $$
begin
  perform cron.unschedule('purge-webhook-unmatched-observations');
exception when others then
  null;
end $$;

select cron.schedule(
  'purge-webhook-unmatched-observations',
  '17 3 * * *',
  $$
  delete from public.webhook_unmatched_observations
   where observed_on < current_date - 7;
  $$
);
