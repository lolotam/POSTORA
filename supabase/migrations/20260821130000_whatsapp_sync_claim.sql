-- Atomic claim for the history sweep.
--
-- Three triggers (the connection webhook, the status poller and the manual action) can all
-- decide to import at once. Expressing the compare-and-set as a PostgREST or() filter meant
-- encoding an ISO timestamp into a filter string that splits on ".", which the client got
-- wrong; a single UPDATE ... WHERE is both unambiguous and atomic on its own.
create or replace function public.claim_whatsapp_history_sync(
  p_social_account_id uuid,
  p_lease_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $function$
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
$function$;

revoke all on function public.claim_whatsapp_history_sync(uuid, integer) from public;
revoke all on function public.claim_whatsapp_history_sync(uuid, integer) from anon;
revoke all on function public.claim_whatsapp_history_sync(uuid, integer) from authenticated;
grant execute on function public.claim_whatsapp_history_sync(uuid, integer) to service_role;
