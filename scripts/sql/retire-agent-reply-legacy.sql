-- Run only after the tenant-bound edge build is deployed and old workers have drained.
-- Deliberately outside migrations/: applying the migration before merge must preserve main.
\set ON_ERROR_STOP on
\if :{?old_edge_workers_drained}
\else
  \echo 'Refusing retirement: verify old workers drained, then set old_edge_workers_drained=true.'
  \quit 3
\endif
\if :old_edge_workers_drained
  REVOKE ALL ON FUNCTION public.advance_agent_reply(uuid, text, text, text, text, jsonb)
    FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION public.advance_agent_reply_kind(uuid, text, text, text, text, jsonb, text)
    FROM PUBLIC, anon, authenticated, service_role;
  REVOKE ALL ON FUNCTION public.claim_agent_reply_for_delivery(uuid, text, text, text, text)
    FROM PUBLIC, anon, authenticated, service_role;
  NOTIFY pgrst, 'reload schema';
\else
  \echo 'Refusing retirement: old workers have not drained.'
  \quit 3
\endif
