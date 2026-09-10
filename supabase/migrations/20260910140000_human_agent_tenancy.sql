-- ============================================================================
-- Human-agent tenancy — expand and backfill before deploying assignment writers
--
-- Keep both assignment workspace columns nullable during the rollout. Contract
-- only after both writers are deployed; unattributable legacy history remains
-- excluded from workspace-filtered partner reads (spec section 6, item 3).
-- ============================================================================

alter table public.whatsapp_assignment_history
  add column if not exists workspace_id uuid
  references public.workspaces(id) on delete cascade;

update public.whatsapp_conversation_assignments as assignment
set workspace_id = agent.workspace_id
from public.whatsapp_agents as agent
where assignment.workspace_id is null
  and assignment.agent_id = agent.id;

update public.whatsapp_assignment_history as history
set workspace_id = coalesce(
  (select agent.workspace_id from public.whatsapp_agents as agent
   where agent.id = history.to_agent_id),
  (select agent.workspace_id from public.whatsapp_agents as agent
   where agent.id = history.from_agent_id),
  -- Nothing constrains a user to one personal workspace, and a scalar
  -- subquery returning two would abort the whole migration. Picking the
  -- lowest id keeps this deterministic and re-runnable instead.
  (select personal.id from public.workspaces as personal
   where personal.owner_id = history.performed_by and personal.is_personal
   order by personal.id limit 1)
)
where history.workspace_id is null;

do $$
declare
  unresolved_count bigint;
begin
  select count(*) into unresolved_count
  from public.whatsapp_assignment_history
  where workspace_id is null;

  raise notice 'Human-agent history rows without a resolvable workspace: %', unresolved_count;
end;
$$;

create index if not exists idx_assignment_history_workspace_conversation
  on public.whatsapp_assignment_history (workspace_id, conversation_id);
