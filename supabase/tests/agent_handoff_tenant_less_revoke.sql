-- supabase/tests/agent_handoff_tenant_less_revoke.sql
-- The two tenant-less transitions are off the service-role surface
-- (migration 20261113300000_agent_handoff_revoke_tenant_less_transitions.sql).
-- One transaction, no fixtures needed, labelled ASSERTs, ROLLBACK, sentinel last. Assumes
-- the migrations are applied. No secrets and no real accounts.
--
-- `advance_agent_reply_kind` and `claim_agent_reply_for_delivery` name no tenant. The
-- tenant they act for is DERIVED from the row they are given: the wrapper reads the owner
-- of that row's own social account and hands it to the tenant-bound function. So the
-- check they make is a consistency one -- "the row's user_id is the owner of the row's own
-- account" -- and not an authorisation one. A caller that names the wrong row derives
-- that row's owner and satisfies the check, so a row id of another tenant could still be
-- moved through them.
--
-- Nothing calls them: the build that lands with this branch calls the `*_for_owner`
-- transitions, which take the tenant FROM THE CALLER, and the build that is live today
-- calls `advance_agent_reply` and `enqueue_agent_reply`. So the privilege is revoked from
-- the service role, which is the role the edge functions run as.
--
-- `advance_agent_reply` keeps its privilege on purpose: the build that is live today calls
-- it, and it is dropped by the retirement step in the plan's rollout checklist once the
-- old edge instances have drained.
BEGIN;
DO $privileges$
BEGIN

-- T1: the service role can no longer reach the two tenant-less transitions.
ASSERT NOT has_function_privilege('service_role', 'public.advance_agent_reply_kind(uuid, text, text, text, text, jsonb, text)', 'EXECUTE'),
  'T1 service_role cannot call the tenant-less kind-aware transition';
ASSERT NOT has_function_privilege('service_role', 'public.claim_agent_reply_for_delivery(uuid, text, text, text, text)', 'EXECUTE'),
  'T1 service_role cannot call the tenant-less delivery claim';

-- T2: and neither can any other role that reaches the database from the outside.
ASSERT NOT has_function_privilege('anon', 'public.advance_agent_reply_kind(uuid, text, text, text, text, jsonb, text)', 'EXECUTE'),
  'T2 anon cannot call the tenant-less kind-aware transition';
ASSERT NOT has_function_privilege('authenticated', 'public.advance_agent_reply_kind(uuid, text, text, text, text, jsonb, text)', 'EXECUTE'),
  'T2 authenticated cannot call the tenant-less kind-aware transition';
ASSERT NOT has_function_privilege('anon', 'public.claim_agent_reply_for_delivery(uuid, text, text, text, text)', 'EXECUTE'),
  'T2 anon cannot call the tenant-less delivery claim';
ASSERT NOT has_function_privilege('authenticated', 'public.claim_agent_reply_for_delivery(uuid, text, text, text, text)', 'EXECUTE'),
  'T2 authenticated cannot call the tenant-less delivery claim';

-- T3: the transitions the new build uses are untouched. These take the tenant from the
-- caller, so they are the real boundary and they must keep working.
ASSERT has_function_privilege('service_role', 'public.advance_agent_reply_for_owner(uuid, uuid, text, text, text, text, jsonb)', 'EXECUTE'),
  'T3 service_role can still advance a reply for its tenant';
ASSERT has_function_privilege('service_role', 'public.advance_agent_reply_kind_for_owner(uuid, uuid, text, text, text, text, jsonb, text)', 'EXECUTE'),
  'T3 service_role can still advance a kind-aware reply for its tenant';
ASSERT has_function_privilege('service_role', 'public.claim_agent_reply_for_delivery_for_owner(uuid, uuid, text, text, text, text)', 'EXECUTE'),
  'T3 service_role can still claim a delivery for its tenant';

-- T4: and the arity the build that is live today calls keeps its privilege, so applying
-- this migration while that build keeps running changes nothing for it.
ASSERT has_function_privilege('service_role', 'public.advance_agent_reply(uuid, text, text, text, text, jsonb)', 'EXECUTE'),
  'T4 service_role can still advance a reply the live way';

-- T5: the refusal is a real one, not only a cleared privilege bit: calling the function
-- AS the service role raises insufficient_privilege. The role change is a statement, so
-- it cannot live inside a DO block.
END
$privileges$;

SET ROLE service_role;
DO $revoke_service$
BEGIN
  BEGIN
    PERFORM public.advance_agent_reply_kind(
      '00000000-0000-4000-8000-000000000000'::uuid, 'running', 'ready_to_send');
    RAISE EXCEPTION 'FAIL: the tenant-less kind-aware transition was ACCEPTED for service_role';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: the tenant-less kind-aware transition is refused for service_role';
  END;
  BEGIN
    PERFORM public.claim_agent_reply_for_delivery(
      '00000000-0000-4000-8000-000000000000'::uuid, 'ready_to_send', 'sending', 'x', NULL);
    RAISE EXCEPTION 'FAIL: the tenant-less delivery claim was ACCEPTED for service_role';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS: the tenant-less delivery claim is refused for service_role';
  END;
END
$revoke_service$;
RESET ROLE;

ROLLBACK;
\echo '=== agent_handoff_tenant_less_revoke: ALL CHECKS PASSED ==='
