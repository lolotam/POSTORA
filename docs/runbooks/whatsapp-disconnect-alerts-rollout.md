# WhatsApp disconnect alerts rollout

Candidate: PR #411. These are operator steps for the approved rollout, not evidence of
production execution. Runtime copy, SHA256 verification, restart, and boot-probe procedures
remain in [deploy-edge-function.md](deploy-edge-function.md).

1. Pause an existing `whatsapp-disconnect-watch` job and wait for active invocations to finish.
   Apply `supabase/migrations/20261113200000_whatsapp_disconnect_alerts.sql` before deploying
   dependent code. Reload PostgREST's schema cache. Confirm the watcher job is paused.
   **Reapplying this migration pauses the job again**, even if it was previously active.
2. Deploy `whatsapp-disconnect-watch/`, `send-whatsapp-disconnect-alert/`, and the changed
   `_shared/evolutionQrAccount.ts`, `_shared/whatsappDisconnect.ts`, and `_shared/errorContext.ts`
   from the verified pushed ref. Verify hashes and restart per the deployment runbook.
   Confirm both `whatsapp-oauth` and `whatsapp-evolution-bridge` use the new shared teardown.
3. With cron still paused, wait for old invocations to finish, then run the final backfill:

   ```sql
   SELECT public.backfill_whatsapp_legacy_disconnects(clock_timestamp());
   ```

   This covers deliberate disconnects during the migration-to-runtime deployment gap.
4. Confirm `public.get_cron_functions_base_url()` resolves the trusted deployment URL and
   cron/service-role authentication is configured. Unauthenticated probes to both new
   endpoints must return 401. Keep credentials out of logs and command output.
5. Activate the existing job explicitly:

   ```sql
   SELECT cron.alter_job(jobid, active := true)
     FROM cron.job WHERE jobname = 'whatsapp-disconnect-watch';
   SELECT jobname, schedule, active
     FROM cron.job WHERE jobname = 'whatsapp-disconnect-watch';
   ```

   Expect exactly one active row, schedule `2,7,12,17,22,27,32,37,42,47,52,57 * * * *`.
6. On a designated test account, verify one outage flags once, emails eligible owner/admin
   groups, and stops dispatching after both completion markers exist. An unfinished group
   remains retryable. Reconnection clears the episode/banner; deliberate disconnect sends
   no outage alert. A failed remote logout reports partial cleanup and requires removing
   the linked device on the phone. Do not use a customer's account for this rehearsal.

If rollout validation fails, pause the job with `cron.alter_job(jobid, active := false)` and
inspect sanitized watcher/sender error codes. Preserve episodes and claims for diagnosis.
The provider's idempotency window limits duplicate suppression; persistent marker failures
need repair before retrying beyond that window. See the
[delivery contract](../superpowers/specs/2026-11-13-whatsapp-disconnect-alerts-design.md#73-what-once-only-means-precisely).
