-- Fixes 20260825090000_webhook_unmatched_observations.sql, which shipped a writer that
-- could never run: it aggregated the optional owner columns with max(uuid), and
-- PostgreSQL has no max/min aggregate for uuid. (uuid has btree operators, so it sorts
-- and indexes fine -- which is exactly why the mistake type-checks at authoring time and
-- only fails when the function body is executed.) Every call raised
--   ERROR: function max(uuid) does not exist
-- and, because the caller runs this inside runInBackground, that error would have been
-- swallowed and logged: the table would have stayed empty while looking healthy.
--
-- The original migration is left untouched (ARCHITECTURE.md 23: never edit an applied
-- migration). Only the two aggregates change; the cap, the advisory lock, the grouping
-- and the upsert are identical.

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

-- CREATE OR REPLACE resets nothing about privileges, but restate them so applying this
-- file alone on a fresh database still lands the intended grants.
revoke execute on function public.record_unmatched_webhook_observations(text, jsonb) from public;
revoke execute on function public.record_unmatched_webhook_observations(text, jsonb) from anon;
revoke execute on function public.record_unmatched_webhook_observations(text, jsonb) from authenticated;
grant  execute on function public.record_unmatched_webhook_observations(text, jsonb) to service_role;
