-- Escalation overrides expire, and the timeout is per agent config.
-- Additive on purpose: code deployed before this migration ignores both
-- columns, and the default keeps every existing config save valid
-- (ARCHITECTURE.md §36).

alter table public.ai_conversation_modes
  add column if not exists expires_at timestamptz;

comment on column public.ai_conversation_modes.expires_at is
  'When an escalation-written override stops applying. NULL = until released. Set only by escalate_to_human; manual overrides write NULL.';

alter table public.ai_agent_configs
  add column if not exists escalation_timeout_minutes integer not null default 240;

alter table public.ai_agent_configs
  drop constraint if exists ai_agent_configs_escalation_timeout_minutes_check;
alter table public.ai_agent_configs
  add constraint ai_agent_configs_escalation_timeout_minutes_check
  check (escalation_timeout_minutes between 1 and 10080);

comment on column public.ai_agent_configs.escalation_timeout_minutes is
  'Minutes an escalated conversation stays with humans before the override expires and the account default applies again. 1..10080.';

-- Remediation of the failure population this change exists for: overrides an
-- escalation demonstrably wrote (its assignment note starts with
-- "AI escalation:") and that nothing ever expired. Manual overrides carry no
-- such note and are left alone; a person decides those at release.
update public.ai_conversation_modes m
   set expires_at = now() + interval '240 minutes'
 where m.mode = 'human_first'
   and m.expires_at is null
   and exists (
     select 1
       from public.whatsapp_conversation_assignments a
      where a.conversation_id = m.conversation_id
        and a.notes like 'AI escalation:%'
   );

-- PostgREST caches the column list; without this a write naming the new
-- column is rejected with PGRST204 until the next restart.
notify pgrst, 'reload schema';
