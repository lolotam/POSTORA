# WhatsApp disconnect alerts: implementation and rollout plan

> PR #411. This plan describes the current implementation. It replaces the original
> scaffolding snippets, whose reconnect and query contracts had drifted from the code.
> Behaviour and rationale: [design](../specs/2026-11-13-whatsapp-disconnect-alerts-design.md).
> Architecture: [ARCHITECTURE.md](../../../ARCHITECTURE.md).

## Scope and remaining owner decision

Poll paired Evolution QR accounts directly, debounce outages, flag the dashboard, and email
eligible owners and admins independently. Do not alert deliberate disconnects. The Evolution
webhook and bridge are unchanged.

**Owner decision, review comment 4558985416:** the shipped `whatsapp_meta_connect` target calls
`useWhatsAppConnect` (Embedded Signup). That onboarding flow is not a verified renewal path
for an already-owned WABA. This PR's review-finishing work leaves the implementation and
thread unchanged. Do not treat the documentation of this branch as proof that it repairs
expired Meta credentials. The owner must decide its disposition before merge.

## 1. Database and episode lifecycle

Single unapplied migration:
`supabase/migrations/20261113200000_whatsapp_disconnect_alerts.sql`.
The reviewed inactive-clear and stale-marker fixes are folded into it; no separate cron
migration is required.

- `whatsapp_evolution_instances.last_polled_at` orders polling oldest first, nulls first.
- `social_accounts.account_metadata.whatsapp_disconnect` stores the episode identity,
  continuous terminal streak (`since`), episode anchor (`first_seen`), state, observation time,
  and `flagged_at` when the watcher deactivates the account.
- `whatsapp_disconnect_email_payloads` stores the first rendered payload for each
  `(social_account_id, kind, episode_id)`. It contains recipient addresses and must stay
  backend-only: RLS enabled, no policies, no `PUBLIC`/`anon`/`authenticated` table grants;
  `service_role` receives SELECT, INSERT, DELETE. Its FK cascades on account deletion.
  Browser types do not expose this table; the existing metadata column remains `Json`.
- `observe_whatsapp_disconnect_state(uuid,text,boolean)` locks the row. Terminal observations
  preserve an uninterrupted streak; transient observations clear `since` while keeping
  `first_seen`. An inactive deliberate marker refuses observation. An active marker protects
  teardown for 30 minutes; an older or unreadable active marker is removed under the lock.
- `flag_whatsapp_disconnect_episode(uuid,text,text)` conditionally matches the episode,
  rejects deliberate markers and already-flagged episodes, and first sets `is_active=false`,
  `needs_reauth=true`, and `flagged_at`. Repeated polls preserve the first flag and reason.
  Observation returns completion timestamps for owner/admin groups; completed groups never
  cause another sender invocation once both markers exist. An incomplete group remains retryable.
- `claim_whatsapp_disconnect_email(uuid,text,jsonb) RETURNS jsonb` independently claims each
  recipient group, storing and returning `{ episode_id, payload }`. A live claim blocks a
  duplicate; a claim older than 30 minutes is retaken with the original payload.
- `mark_whatsapp_disconnect_emailed(uuid,text,uuid)` requires the same open episode and claim.
  A late completion cannot silence a later outage.
- On a healthy active row, `clear_whatsapp_disconnect_episode(uuid)` clears the episode,
  payloads, and reconnect state. It refuses inactive rows and fresh deliberate markers;
  stale active markers can recover here too.
- On a healthy inactive row, `restore_whatsapp_disconnect_account(uuid)` reactivates only
  an episode carrying `flagged_at`, no deliberate marker, and no `number_mismatch`. If refused, the watcher calls
  `clear_unflagged_whatsapp_disconnect_episode(uuid)`: clear only an unflagged episode and
  its payloads, retaining `is_active`, `needs_reauth`, and `last_refresh_error`.
- `deactivate_whatsapp_deliberately(uuid,uuid)` locks the workspace-scoped account and
  commits the deliberate marker, episode cleanup, and local deactivation in one transaction
  before remote teardown. The earlier mark/unmark RPCs remain for compatibility. Explicit
  activation, including an already-active row, clears episode state in the same statement.
- `backfill_whatsapp_legacy_disconnects(timestamptz)` conservatively marks inactive,
  unmarked QR accounts. Run it again after deploying every shared teardown consumer.
- New RPCs use SECURITY DEFINER and `search_path = public, pg_temp`; execution is revoked
  from public/browser roles and granted only to `service_role`.

SQL proofs live in `supabase/tests/whatsapp_disconnect_alerts.sql`, registered in
`scripts/db-harness.sh`. They cover episode anchors, claim/payload stability, RLS and grants,
reactivation, stale/fresh markers, unflagged inactive cleanup, and paused cron creation.

## 2. Watcher and teardown

`whatsapp-disconnect-watch/index.ts` verifies cron auth, composes the Supabase and Evolution
adapters, and invokes `runWatch` under the existing `acquire_cron_run_lease` /
`release_cron_run_lease` protocol. One ten-minute lease serializes cron and manual invocations;
database requests share a 150-second deadline, inside that lease. A crashed holder blocks
until expiry; a successful or failed run releases its own holder in `finally`. Candidate selection starts at the instance table, includes
inactive outage rows, excludes inactive deliberately disconnected rows, and includes active
marked rows so SQL can recover a stale teardown marker. Pending and retired identities are
excluded. The freshness window is four minutes; cron runs every five minutes.

`run.ts` polls at most 50 accounts, sequentially, with a 50-second run budget checked between
accounts. Failed state reads still write the poll-attempt timestamp, remain failures, and
never open, clear, flag, or dispatch an episode. This rotates persistent failures out of the
oldest-first limit. A failed timestamp write also records failure and leaves state untouched.
Unreached accounts keep their timestamps for the next run.

Alert after 10 continuous terminal minutes or 60 minutes of an unhealthy episode, including
flapping or persistent `connecting`. Undocumented states are skipped without changing the account; malformed successful responses
are failures. A first flag must succeed before dispatch; a flagged episode dispatches only while
an owner/admin completion marker is missing. The dispatch deadline is 50 seconds, covering
both groups' Resend retry budgets plus overhead. `dispatch.ts` validates the sender's complete summary; HTTP
200 alone is not evidence of delivery. `stateReader.ts` raises failed provider reads.

The shared `_shared/whatsappDisconnect.ts` commits deliberate intent and local deactivation
atomically before attempting remote cleanup. A failure before this commit preserves the
previous episode and banner, including on an inactive account. Remote lookup/logout/delete
failures leave the local account disconnected and report partial cleanup. The owner is told
to remove the linked device on their phone. Inactive accounts cannot ingest incoming webhooks
because the webhook account lookup requires `is_active=true`. Remote cleanup retry scheduling
is outside this alert feature. `_shared/evolutionQrAccount.ts` treats both returned RPC errors
and rejected cleanup transports as best effort after a successful pairing.

## 3. Sender and privacy

`send-whatsapp-disconnect-alert/index.ts` verifies the service-role bearer, validates
`account_id` with Zod, checks every database read, and calls `sendDisconnectAlerts`.
`handler.ts` applies the global email switch, owner opt-in, and admin switch/opt-ins.
Owner and admin failures are independent and include sanitized operational codes.

Claim before send, mark after confirmed provider success. Stable payloads survive a stale
claim retry even if account names change. Every stored recipient must still be currently
eligible before replay; removed admins and old owner addresses cause `recipient_changed`
without a send. Newly added admins do not alter an existing idempotent payload. `resend.ts` uses the
same idempotency key and body on both bounded attempts, each with a 10-second timeout.
`concurrent_idempotent_requests` 409 is retried; exhaustion leaves the recipient unmarked.
`invalid_idempotent_request` fails permanently. Unknown/malformed 409 responses fail with
`idempotency_conflict`; free-text provider names never become log codes. Network errors,
timeouts, 429, and 5xx receive the bounded retry; other client failures do not.

Account and owner display fields share phone normalization and redaction before HTML
escaping. Phone-only labels use `WhatsApp`, `there`, or `a Postora user`; embedded phone
runs are removed while keeping surrounding words. Emails and recipient-failure logs never
include the owner's phone or raw provider text. The owner CTA opens WhatsApp setup. Admins
receive instructions for contacting the owner, not a link to an account they cannot rescan.

## 4. Frontend contracts

`src/lib/reconnectTarget.ts` exports all four `ReconnectTarget` cases:

```ts
import type { WhatsAppConnectionMode } from "@/lib/whatsappEmbeddedSignup";

type ReconnectTarget =
  | { kind: "oauth" }
  | { kind: "link"; path: string }
  | { kind: "whatsapp_meta" }
  | { kind: "whatsapp_meta_connect"; mode: WhatsAppConnectionMode };
```

Evolution QR uses `link` to `/messaging/whatsapp/setup`. Unflagged Meta WhatsApp uses
`whatsapp_meta` through `useWhatsAppReconnect`, which resubscribes with the stored token.
Flagged Meta WhatsApp uses `whatsapp_meta_connect` through `useWhatsAppConnect`, retaining
`coexistence` or defaulting to `cloud_api`; the owner decision above remains open. Other
platforms use `oauth`. WhatsApp never falls through to `useProfileOAuth`.

`useAccountsNeedingReconnect` returns React Query data shaped as:

```ts
interface AccountsNeedingReconnectResult {
  accounts: AccountNeedingReconnect[];
  partialError: { scope: "active" | "whatsapp_qr" } | null;
}
```

Two independently scoped queries fetch active reauth rows and inactive Evolution QR reauth
rows. Active Evolution QR rows are filtered out of the first result: their stray marker must
not show a disconnect banner. Results are deduplicated by account id. A single read failure
retains the successful half and reports `partialError`; both failing throws for Query retry.

`TokenReauthBanner` consumes the object, not an account array:

```ts
const { data, isError, isFetching, refetch } = useAccountsNeedingReconnect();
const accountsNeedingReauth = data?.accounts ?? [];
const checkFailed = isError || data?.partialError != null;
```

The banner renders retry feedback for incomplete reads and routes each of the four targets.
`AdminNotificationSettings` exposes `admin_email_whatsapp_disconnect_alerts`; Arabic banner
strings live in `src/i18n/locales/ar/dashboard.json` with English defaults at call sites.

## 5. Validation and review gates

Run from the worktree before pushing:

```bash
npx tsc --noEmit -p tsconfig.app.json
npx eslint <changed .ts/.tsx files>
npx vitest run src/hooks/__tests__/useAccountsNeedingReconnect.test.tsx src/lib/__tests__/reconnectTarget.test.ts src/components/dashboard/__tests__/TokenReauthBanner.whatsapp.test.tsx src/components/dashboard/__tests__/TokenReauthBanner.instagram.test.tsx
deno check --node-modules-dir=none supabase/functions/whatsapp-disconnect-watch/index.ts supabase/functions/send-whatsapp-disconnect-alert/index.ts supabase/functions/_shared/evolutionQrAccount.ts supabase/functions/_shared/whatsappDisconnect.ts
deno test --allow-all --node-modules-dir=none supabase/functions/whatsapp-disconnect-watch/ supabase/functions/send-whatsapp-disconnect-alert/ supabase/functions/_shared/whatsappDisconnect.test.ts supabase/functions/_shared/evolutionQrAccount.test.ts
bash scripts/db-harness.sh
```

The database harness needs a disposable Supabase Postgres container configured as in CI;
never point it at production. `.github/workflows/ci.yml` runs the whole watcher and sender
test directories, including dispatch, state-reader, and Resend tests, plus shared module tests.
Review evidence includes `clean-code-guard`, `test-guard`, and `docs-guard` checks.
Graphify outputs are local navigation artifacts and are excluded from the PR. Review-thread
resolution and CI status are recorded in the PR; the Meta renewal decision remains open.

## 6. Safe production rollout

Operational checklist: [WhatsApp disconnect alerts rollout](../../runbooks/whatsapp-disconnect-alerts-rollout.md).

No migrations from this PR have been applied by this task. The following is a deployment
runbook, not a record of execution. Follow `docs/runbooks/deploy-edge-function.md` after owner
approval. Read deployment files from the verified pushed Git ref, never from the server's
working tree.

1. If a watcher job already exists, pause it with `cron.alter_job(jobid, active := false)`
   and wait for any active invocation to finish before rollout. Apply
   `20261113200000_whatsapp_disconnect_alerts.sql`; it creates or leaves exactly one watcher
   job **paused** in the same transaction. Reload PostgREST so all new RPCs are visible.
   Do not enable cron yet. This also handles a bulk migration runner: applying the schema
   alone cannot start alerts.
2. Deploy `whatsapp-disconnect-watch/`, `send-whatsapp-disconnect-alert/`, and the changed
   `_shared/evolutionQrAccount.ts`, `_shared/whatsappDisconnect.ts`, and `_shared/errorContext.ts`
   into the functions volume. Confirm both `whatsapp-oauth` and `whatsapp-evolution-bridge`
   execute the new shared teardown before proceeding. Verify SHA256 hashes and restart
   the functions service per the deployment runbook.
3. With cron still paused and old invocations finished, rerun
   `SELECT public.backfill_whatsapp_legacy_disconnects(clock_timestamp());`.
   The migration's first backfill cannot cover deliberate disconnects in the deployment
   gap; this second pass does. Confirm the updated teardown is in use for every entrypoint.
4. Verify `get_cron_functions_base_url()` resolves the trusted local API URL and that cron
   and service-role authentication are configured. Boot-probe both new endpoints without
   credentials and expect 401. Do not print secrets.
5. Only now enable the existing job:

   ```sql
   SELECT cron.alter_job(jobid, active := true)
     FROM cron.job WHERE jobname = 'whatsapp-disconnect-watch';
   SELECT jobname, schedule, active
     FROM cron.job WHERE jobname = 'whatsapp-disconnect-watch';
   ```

   Expect one active row scheduled at minutes `2,7,12,17,22,27,32,37,42,47,52,57`.
6. Coordinate the frontend merge/deploy with these backend prerequisites; frontend deploys
   automatically from `main`. Verify on a designated test account that one outage produces
   one eligible owner email and one admin email, repeated runs produce no duplicate,
   deliberate disconnect produces none, and reconnect clears the banner and episode.
   Do not use a customer's account for this rehearsal.
