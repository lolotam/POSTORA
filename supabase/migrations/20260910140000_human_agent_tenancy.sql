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

-- Reconcile BEFORE the backfill. idx_active_assignment is
-- UNIQUE (workspace_id, conversation_id) WHERE unassigned_at IS NULL, and
-- NULL workspace_ids are distinct -- so two active NULL-workspace rows for
-- one conversation whose agents share a workspace are legal today and
-- collide (23505) the moment the backfill below stamps both with that
-- workspace. For each (agent workspace, conversation) group with more than
-- one NULL-workspace active row, keep the newest by assigned_at (tie-break
-- by id) and close the rest; a NULL-workspace row whose target already
-- carries an attributed active row is closed too, since the backfill would
-- collide with that row as well. The assignments table carries notes (no
-- dedicated reason column), so the closure is marked there without
-- overwriting existing notes. Plain UPDATEs plus a counting block: a second
-- run finds nothing to close, so the migration stays re-runnable.
do $$
declare
  closed_count bigint;
begin
  with target as (
    select assignment.id,
      agent.workspace_id as target_workspace_id,
      assignment.conversation_id,
      row_number() over (
        partition by agent.workspace_id, assignment.conversation_id
        order by assignment.assigned_at desc nulls last, assignment.id desc
      ) as recency_rank,
      exists (
        select 1 from public.whatsapp_conversation_assignments as attributed
        where attributed.workspace_id = agent.workspace_id
          and attributed.conversation_id = assignment.conversation_id
          and attributed.unassigned_at is null
      ) as collides_with_attributed
    from public.whatsapp_conversation_assignments as assignment
    join public.whatsapp_agents as agent on agent.id = assignment.agent_id
    where assignment.workspace_id is null
      and assignment.unassigned_at is null
      and assignment.agent_id is not null
  ),
  closed as (
    update public.whatsapp_conversation_assignments as assignment
    set unassigned_at = now(),
        notes = coalesce(assignment.notes, 'backfill_duplicate')
    from target
    where assignment.id = target.id
      and (target.recency_rank > 1 or target.collides_with_attributed)
    returning assignment.id
  )
  select count(*) into closed_count from closed;

  raise notice 'Human-agent backfill: closed % duplicate NULL-workspace active assignment(s)', closed_count;
end;
$$;

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

-- The INSERT policy on whatsapp_assignment_history only checked
-- performed_by = auth.uid(). With workspace_id now a column that the partner
-- assignment-history endpoint filters on, that let any authenticated user
-- insert a history row attributed to an arbitrary workspace, which the
-- endpoint would then serve as that workspace's history. A row may name a
-- workspace only when its author is a member of it; unattributed legacy
-- rows (NULL) stay insertable as before.
drop policy if exists "Users can create history entries" on public.whatsapp_assignment_history;
create policy "Users can create history entries"
  on public.whatsapp_assignment_history for insert to authenticated
  with check (
    auth.uid() = performed_by
    and (
      workspace_id is null
      or exists (
        select 1 from public.workspace_members m
        where m.workspace_id = whatsapp_assignment_history.workspace_id
          and m.user_id = auth.uid()
      )
    )
  );
