-- Apply before deploying the partner agent routes. Auth identities are minted
-- through the Auth admin API; only the two public rows belong in this transaction.
CREATE OR REPLACE FUNCTION public.provision_partner_agent(
  p_workspace_id UUID,
  p_user_id UUID,
  p_display_name TEXT,
  p_max_conversations INTEGER
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_agent public.whatsapp_agents;
BEGIN
  IF p_display_name IS NULL OR length(btrim(p_display_name)) NOT BETWEEN 1 AND 200
     OR p_max_conversations IS NULL OR p_max_conversations < 1 THEN
    RAISE EXCEPTION 'Invalid agent fields' USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.workspace_members (workspace_id, user_id, role)
  VALUES (p_workspace_id, p_user_id, 'agent');

  INSERT INTO public.whatsapp_agents (workspace_id, user_id, display_name, max_conversations)
  VALUES (p_workspace_id, p_user_id, btrim(p_display_name), p_max_conversations)
  RETURNING * INTO v_agent;

  RETURN to_jsonb(v_agent);
END;
$$;

-- PUBLIC alone does not remove this database's direct default role grants.
REVOKE ALL ON FUNCTION public.provision_partner_agent(UUID, UUID, TEXT, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provision_partner_agent(UUID, UUID, TEXT, INTEGER) TO service_role;

-- The agent FK on whatsapp_conversation_assignments must be ON DELETE
-- NO ACTION (docs/superpowers/plans/2026-09-10-human-agent-crud.md,
-- deleteAgent in docs/api/openapi.yaml): deleting an agent with an active
-- assignment is refused instead of silently orphaning the row. The baseline
-- carries ON DELETE SET NULL (from 20260413234250), and the two
-- whatsapp_assignment_history FKs (from_agent_id, to_agent_id) STAY
-- SET NULL per the same OpenAPI contract -- this block touches only the
-- assignments table. The constraint name is looked up from pg_constraint by
-- (agent_id column, whatsapp_agents target) rather than hardcoded, because
-- the 20260726 migration rebuilt this table. Idempotent: a constraint that
-- already deletes NO ACTION (confdeltype 'a') is left alone, so a second
-- run is a NOTICE, not an error.
do $$
declare
  v_conname name;
  v_deltype "char";
  v_agent_attnum smallint;
begin
  select a.attnum into v_agent_attnum
  from pg_attribute as a
  where a.attrelid = 'public.whatsapp_conversation_assignments'::regclass
    and a.attname = 'agent_id';

  select c.conname, c.confdeltype into v_conname, v_deltype
  from pg_constraint as c
  where c.conrelid = 'public.whatsapp_conversation_assignments'::regclass
    and c.confrelid = 'public.whatsapp_agents'::regclass
    and c.contype = 'f'
    and array_length(c.conkey, 1) = 1
    and c.conkey[1] = v_agent_attnum;

  if v_conname is null then
    raise exception 'expected agent FK on whatsapp_conversation_assignments(agent_id) not found';
  end if;

  if v_deltype = 'a' then
    raise notice 'agent FK % is already ON DELETE NO ACTION, skipping', v_conname;
    return;
  end if;

  execute format(
    'alter table public.whatsapp_conversation_assignments drop constraint %I',
    v_conname
  );
  alter table public.whatsapp_conversation_assignments
    add foreign key (agent_id) references public.whatsapp_agents(id)
    on delete no action;
  raise notice 'agent FK % changed to ON DELETE NO ACTION', v_conname;
end;
$$;
