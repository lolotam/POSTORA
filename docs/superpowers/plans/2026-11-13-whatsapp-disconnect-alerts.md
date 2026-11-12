# WhatsApp disconnect alerts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a WhatsApp account connected through the self-hosted Evolution API
(`connection_mode = 'evolution_qr'`) loses its Baileys session, Postora must (1) raise the **existing**
dashboard red flag, (2) email the account owner **and** the admins, and (3) not do any of that for a
transient reconnect flap or a disconnect the user performed on purpose.

**Architecture:**
- A new cron edge function `whatsapp-disconnect-watch` polls Evolution's `connectionState` every five
  minutes and is the **only** authority on whether an account is disconnected. The webhook is untouched.
- One disconnection *episode* per account lives in `social_accounts.account_metadata`
  (`whatsapp_disconnect`), so no new table, no new RLS surface and **no regenerated database types**.
- A new edge function `send-whatsapp-disconnect-alert` renders and sends the two emails, each claimed
  atomically per recipient through a SECURITY DEFINER RPC.
- The dashboard reuses `TokenReauthBanner` by extending its query and routing the WhatsApp button to
  the QR setup page.

**Tech Stack:** Deno edge functions, Zod, Supabase Postgres (SECURITY DEFINER RPCs), pg_cron, Resend,
React 18 + TanStack Query, Vitest, Deno test.

**Spec:** `docs/superpowers/specs/2026-11-13-whatsapp-disconnect-alerts-design.md`. **Read it in full
before writing code** — §3 (the debounce rule), §5 (exactly what the banner needs), §7 (idempotency)
and §9 (the in-app notification decision) are the parts that are easy to get subtly wrong.

## Global Constraints

- Read `ARCHITECTURE.md` §1 (zero dead modules), §3–4 (feature structure, dependency direction),
  §9–11 (component, hook and Supabase frontend rules), §12–17 (edge function shape, auth, Zod
  validation, sanitised errors, logging), §23 (database and migration rules), §26 (external HTTP),
  §27 (background work), §28 (scheduling) before writing code.
- **Do not** add a second banner component. `TokenReauthBanner` is the banner system; extend it.
- **Do not** add a raw Supabase query to a visual component (§11). The banner's query moves into a hook.
- **Do not** add a new table. Everything new is `account_metadata` JSONB plus five RPCs. `types.ts`
  does not change.
- **Do not** flip `social_accounts.is_active` for a disconnected account. It must stay `false`: the
  reconnectable list (`src/hooks/useReconnectableQrAccounts.ts:27`) and the webhook's account lookup
  (`supabase/functions/whatsapp-evolution-webhook/index.ts`, `findAccount`) both depend on it.
- The debounce constants live in exactly one place: `supabase/functions/whatsapp-disconnect-watch/run.ts`.
  `DISCONNECT_GRACE_MINUTES = 10`, `DISCONNECT_BACKSTOP_MINUTES = 60`.
- Never put a phone number in an email, a log line or an error message. The display name is the only
  identity an email may carry (`supabase/functions/send-undelivered-store-alerts/handler.ts:66-75`).
- Never log the recipient address, the Resend API key or the service-role key. Log the account id.
- Every new SECURITY DEFINER function: `SET search_path = public, pg_temp`, `REVOKE ALL … FROM PUBLIC,
  anon, authenticated`, `GRANT EXECUTE … TO service_role`.
- No `git stash`. Commit with explicit paths: `git commit -- <paths>`. Never commit `graphify-out/`,
  `.env*`, logs or secrets.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Migration filename: `supabase/migrations/20261113200000_whatsapp_disconnect_alerts.sql` (timestamped
  `20261113200000` or later).
- The SQL harness **fails before running anything** if a `supabase/tests/*.sql` file is not listed in
  `SUITES` (`scripts/db-harness.sh:714-720`). Register the new suite in the same commit that adds it.
- `npm run check:edge-env` **already fails on this branch** with 24 pre-existing findings (including
  `EVOLUTION_API_URL` / `EVOLUTION_API_KEY`). Do not add a 25th. The new code must only read env vars
  that are already in `infra/edge-runtime.required-env.json`: `RESEND_API_KEY`, `CRON_SECRET`,
  `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `SITE_URL`.

## File map

| File | Status | Responsibility |
|---|---|---|
| `supabase/migrations/20261113200000_whatsapp_disconnect_alerts.sql` | create | `last_polled_at` column + index, five RPCs, the cron job |
| `supabase/tests/whatsapp_disconnect_alerts.sql` | create | SQL proof of the episode state machine and the claims |
| `scripts/db-harness.sh` | modify | register `whatsapp_disconnect_alerts.sql` in `SUITES` |
| `supabase/functions/whatsapp-disconnect-watch/run.ts` | create | the pure state machine and the per-account orchestration |
| `supabase/functions/whatsapp-disconnect-watch/run.test.ts` | create | Deno tests for the state machine |
| `supabase/functions/whatsapp-disconnect-watch/index.ts` | create | the cron adapter (auth, deps, JSON summary) |
| `supabase/functions/send-whatsapp-disconnect-alert/handler.ts` | create | the pure selection, the HTML templates, the per-recipient send |
| `supabase/functions/send-whatsapp-disconnect-alert/handler.test.ts` | create | Deno tests for selection, escaping, claim/send/mark order |
| `supabase/functions/send-whatsapp-disconnect-alert/index.ts` | create | the service-role adapter (Zod validation, deps) |
| `supabase/functions/_shared/evolutionQrAccount.ts` | modify | clear the episode and the red flag on the `"open"` branch |
| `supabase/functions/_shared/whatsappDisconnect.ts` | modify | stamp the deliberate-disconnect marker |
| `src/lib/reconnectTarget.ts` | create | the pure "how do I reconnect this account" rule |
| `src/lib/__tests__/reconnectTarget.test.ts` | create | Vitest tests for that rule |
| `src/hooks/useAccountsNeedingReconnect.ts` | create | the banner's data hook (moves the query out of the component) |
| `src/hooks/__tests__/useAccountsNeedingReconnect.test.tsx` | create | Vitest tests for the hook |
| `src/components/dashboard/TokenReauthBanner.tsx` | modify | consume the hook; route WhatsApp to the QR page |
| `src/i18n/locales/ar/dashboard.json` | modify | the new banner strings |
| `src/components/admin/AdminNotificationSettings.tsx` | modify | the new admin email toggle |
| `supabase/config.toml` | modify | `verify_jwt = false` for the two new functions |
| `.github/workflows/ci.yml` | modify | a Deno check/test step for the new functions |

**Not touched:** the Evolution webhook, the Evolution bridge, `social_accounts`'s column set,
`src/integrations/supabase/types.ts`, `src/components/messaging/WhatsAppSetup.tsx`.

---

### Task 1: The migration and its SQL proof

**Files:**
- Create: `supabase/tests/whatsapp_disconnect_alerts.sql`
- Create: `supabase/migrations/20261113200000_whatsapp_disconnect_alerts.sql`
- Modify: `scripts/db-harness.sh` (append `whatsapp_disconnect_alerts.sql` to the `SUITES=(` array —
  the array starts at line 107 and ends at line 188; insert after `whatsapp_account_setup_move.sql`
  on line 148)

**Interfaces — Produces:**
- Column `whatsapp_evolution_instances.last_polled_at timestamptz`
- RPC `public.observe_whatsapp_disconnect_state(p_account_id uuid, p_state text, p_terminal boolean) → jsonb`
- RPC `public.claim_whatsapp_disconnect_email(p_account_id uuid, p_kind text) → boolean`
- RPC `public.mark_whatsapp_disconnect_emailed(p_account_id uuid, p_kind text) → boolean`
- RPC `public.clear_whatsapp_disconnect_episode(p_account_id uuid) → boolean`
- RPC `public.mark_whatsapp_user_disconnected(p_account_id uuid) → boolean`
- pg_cron job `whatsapp-disconnect-watch`

- [ ] **Step 1: Write the SQL proof first** (`supabase/tests/whatsapp_disconnect_alerts.sql`). Copy the
  header, transaction, labelled-`ASSERT` and sentinel style from `supabase/tests/whatsapp_number_mismatch.sql`.
  The suite must assert:

  1. **E0 — the episode opens once.** `observe_whatsapp_disconnect_state(acc, 'close', true)` returns a
     jsonb with `since`, `first_seen`, `state = 'close'` and `observed_at`; the row's
     `account_metadata->'whatsapp_disconnect'` equals it.
  2. **E1 — a second terminal observation keeps the anchors.** Capture `since` and `first_seen` from E0,
     call `observe_whatsapp_disconnect_state(acc, 'timeout', true)` again, and assert `since` and
     `first_seen` are unchanged while `state` became `'timeout'`.
  3. **E2 — a transient observation restarts the streak but keeps the episode.** After E1, call
     `observe_whatsapp_disconnect_state(acc, 'connecting', false)`; assert `since` moved forward,
     `first_seen` did **not** change, and the episode still exists.
  4. **E3 — a transient observation never opens an episode.** On a second account with no episode,
     `observe_whatsapp_disconnect_state(acc2, 'connecting', false)` returns `NULL` and writes nothing.
  5. **E4 — other metadata keys survive.** Write `automation_handler` into `account_metadata` before
     E0 and assert it is still there afterwards.
  6. **E5 — the claim is once-only per recipient.** `claim_whatsapp_disconnect_email(acc, 'user')` is
     `true`; a second call with the same kind is `false`; `claim_whatsapp_disconnect_email(acc, 'admin')`
     is `true` (the two recipients are independent).
  7. **E6 — a stale claim is retaken.** Push `whatsapp_disconnect_claimed_at` back 31 minutes and assert
     the claim succeeds again.
  8. **E7 — a claim needs an open episode.** On an account with no episode,
     `claim_whatsapp_disconnect_email(acc2, 'user')` is `false`.
  9. **E8 — an unknown kind is refused.** `claim_whatsapp_disconnect_email(acc, 'nobody')` raises.
  10. **E9 — marking records the recipient.** `mark_whatsapp_disconnect_emailed(acc, 'user')` is `true`;
      `account_metadata->>'whatsapp_disconnect_user_email_at'` is not null and
      `account_metadata->>'whatsapp_disconnect_admin_email_at'` is null.
  11. **E10 — the deliberate-disconnect marker.** `mark_whatsapp_user_disconnected(acc)` is `true` and
      sets `whatsapp_user_disconnected_at`.
  12. **E11 — clearing removes everything.** Set `needs_reauth = true` and `last_refresh_error = 'x'` on
      the account, then `clear_whatsapp_disconnect_episode(acc)` is `true`; assert the episode, both
      email markers, the claim marker, the deliberate marker, `needs_reauth` and `last_refresh_error` are
      all gone. A second call is `false`.
  13. **E12 — a foreign account is untouched.** The RPCs only ever act on `platform = 'whatsapp'` and
      `connection_mode = 'evolution_qr'` rows: a `cloud_api` WhatsApp row and a Meta row are not opened,
      not claimed and not cleared.
  14. **E13 — grants.** `has_function_privilege('authenticated', …, 'EXECUTE')` is false for all five
      RPCs, and false for `anon` too.
  15. **E14 — the poll column exists** and the index exists:
      `whatsapp_evolution_instances.last_polled_at` is present and
      `pg_indexes` contains `whatsapp_evolution_instances_last_polled_at_idx`.

- [ ] **Step 2: Register the suite and confirm the harness refuses to run without it.** Add
  `whatsapp_disconnect_alerts.sql` to the `SUITES=(` array in `scripts/db-harness.sh`. Run
  `bash scripts/db-harness.sh`. Expected: FAIL — relation or function does not exist (the migration has
  not been written yet).

- [ ] **Step 3: Write the migration.**

```sql
-- WhatsApp disconnect alerts (spec 2026-11-13-whatsapp-disconnect-alerts-design.md).
--
-- One disconnection episode per Evolution QR account. The episode lives in
-- social_accounts.account_metadata, so there is no new table, no new RLS surface and no
-- regenerated database types: account_metadata is already Json in types.ts.
--
-- Keys on social_accounts.account_metadata:
--   whatsapp_disconnect                = {since, first_seen, state, observed_at}
--   whatsapp_disconnect_user_email_at  = the owner email for this episode has been sent
--   whatsapp_disconnect_admin_email_at = the admin email for this episode has been sent
--   whatsapp_disconnect_claimed_at      = an in-flight claim (30 minute stale window)
--   whatsapp_user_disconnected_at       = the owner disconnected this account on purpose

-- 1. Poll freshness for the watch function's round robin.
--    whatsapp_evolution_instances is absent from src/integrations/supabase/types.ts (its RLS
--    revokes anon and authenticated), so this column needs no type regeneration.
ALTER TABLE public.whatsapp_evolution_instances
  ADD COLUMN IF NOT EXISTS last_polled_at timestamptz;

CREATE INDEX IF NOT EXISTS whatsapp_evolution_instances_last_polled_at_idx
  ON public.whatsapp_evolution_instances (last_polled_at)
  WHERE last_polled_at IS NOT NULL;

-- 2. Observe one Evolution connection state.
--    terminal = true  : the session is gone. Opens the episode, or keeps since/first_seen.
--    terminal = false : the session is reconnecting. Restarts the streak (since), keeps the
--                       episode and first_seen, and never opens an episode.
--    Returns the resulting episode, or NULL when there is nothing to record.
CREATE OR REPLACE FUNCTION public.observe_whatsapp_disconnect_state(
  p_account_id uuid,
  p_state text,
  p_terminal boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_meta jsonb;
  v_episode jsonb;
  v_now timestamptz := clock_timestamp();
BEGIN
  SELECT COALESCE(account_metadata, '{}'::jsonb) INTO v_meta
    FROM public.social_accounts
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr'
   FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF NOT p_terminal THEN
    -- A transient observation only restarts an episode that is already open. It never opens
    -- one: an account that is merely reconnecting is not an outage.
    IF NOT (v_meta ? 'whatsapp_disconnect') THEN
      RETURN NULL;
    END IF;
    v_episode := COALESCE(v_meta->'whatsapp_disconnect', '{}'::jsonb)
      || jsonb_build_object('since', v_now, 'state', p_state, 'observed_at', v_now);
  ELSIF NOT (v_meta ? 'whatsapp_disconnect') THEN
    v_episode := jsonb_build_object(
      'since', v_now, 'first_seen', v_now, 'state', p_state, 'observed_at', v_now);
  ELSE
    -- A terminal observation keeps since and first_seen: the streak anchor and the episode
    -- anchor must not move once they are set.
    v_episode := COALESCE(v_meta->'whatsapp_disconnect', '{}'::jsonb)
      || jsonb_build_object('state', p_state, 'observed_at', v_now);
  END IF;

  UPDATE public.social_accounts
     SET account_metadata = jsonb_set(
           COALESCE(account_metadata, '{}'::jsonb), '{whatsapp_disconnect}', v_episode)
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr';

  RETURN v_episode;
END;
$fn$;
REVOKE ALL ON FUNCTION public.observe_whatsapp_disconnect_state(uuid, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.observe_whatsapp_disconnect_state(uuid, text, boolean) TO service_role;

-- 3. Reserve the alert for one recipient before sending it, so two overlapping runs cannot
--    both send. A claim older than 30 minutes is treated as a failed send and may be retaken.
CREATE OR REPLACE FUNCTION public.claim_whatsapp_disconnect_email(
  p_account_id uuid,
  p_kind text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_marker text;
BEGIN
  v_marker := CASE p_kind
    WHEN 'user'  THEN 'whatsapp_disconnect_user_email_at'
    WHEN 'admin' THEN 'whatsapp_disconnect_admin_email_at'
    ELSE NULL
  END;
  IF v_marker IS NULL THEN
    RAISE EXCEPTION 'unknown whatsapp disconnect alert kind: %', p_kind
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.social_accounts
     SET account_metadata = jsonb_set(
           COALESCE(account_metadata, '{}'::jsonb),
           '{whatsapp_disconnect_claimed_at}',
           to_jsonb(clock_timestamp()::text))
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr'
     AND COALESCE(account_metadata, '{}'::jsonb) ? 'whatsapp_disconnect'
     AND NOT (COALESCE(account_metadata, '{}'::jsonb) ? v_marker)
     AND (CASE
             WHEN NOT (COALESCE(account_metadata, '{}'::jsonb) ? 'whatsapp_disconnect_claimed_at') THEN true
             WHEN (account_metadata->>'whatsapp_disconnect_claimed_at') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2} '
               THEN (account_metadata->>'whatsapp_disconnect_claimed_at')::timestamptz
                      < clock_timestamp() - interval '30 minutes'
             ELSE true
           END);

  RETURN FOUND;
END;
$fn$;
REVOKE ALL ON FUNCTION public.claim_whatsapp_disconnect_email(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_whatsapp_disconnect_email(uuid, text) TO service_role;

-- 4. Record that a recipient's email went out for this episode.
CREATE OR REPLACE FUNCTION public.mark_whatsapp_disconnect_emailed(
  p_account_id uuid,
  p_kind text
) RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_marker text;
BEGIN
  v_marker := CASE p_kind
    WHEN 'user'  THEN 'whatsapp_disconnect_user_email_at'
    WHEN 'admin' THEN 'whatsapp_disconnect_admin_email_at'
    ELSE NULL
  END;
  IF v_marker IS NULL THEN
    RAISE EXCEPTION 'unknown whatsapp disconnect alert kind: %', p_kind
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.social_accounts
     SET account_metadata = jsonb_set(
           COALESCE(account_metadata, '{}'::jsonb),
           ARRAY['whatsapp_disconnect_' || p_kind || '_email_at'],
           to_jsonb(clock_timestamp()::text))
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr';

  RETURN FOUND;
END;
$fn$;
REVOKE ALL ON FUNCTION public.mark_whatsapp_disconnect_emailed(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_whatsapp_disconnect_emailed(uuid, text) TO service_role;

-- 5. Close the episode: the account is healthy again, or it has been reconnected. The red
--    flag goes with it. Only evolution_qr rows are touched: on every other platform
--    needs_reauth and last_refresh_error belong to the token-refresh path.
CREATE OR REPLACE FUNCTION public.clear_whatsapp_disconnect_episode(p_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  UPDATE public.social_accounts
     SET account_metadata = COALESCE(account_metadata, '{}'::jsonb)
                             - 'whatsapp_disconnect'
                             - 'whatsapp_disconnect_claimed_at'
                             - 'whatsapp_disconnect_user_email_at'
                             - 'whatsapp_disconnect_admin_email_at'
                             - 'whatsapp_user_disconnected_at',
         needs_reauth = false,
         last_refresh_error = NULL
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr'
     AND (COALESCE(account_metadata, '{}'::jsonb) ? 'whatsapp_disconnect'
          OR COALESCE(account_metadata, '{}'::jsonb) ? 'whatsapp_disconnect_user_email_at'
          OR COALESCE(account_metadata, '{}'::jsonb) ? 'whatsapp_disconnect_admin_email_at'
          OR COALESCE(account_metadata, '{}'::jsonb) ? 'whatsapp_user_disconnected_at'
          OR needs_reauth = true
          OR last_refresh_error IS NOT NULL);

  RETURN FOUND;
END;
$fn$;
REVOKE ALL ON FUNCTION public.clear_whatsapp_disconnect_episode(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.clear_whatsapp_disconnect_episode(uuid) TO service_role;

-- 6. The owner disconnected this account on purpose. The watch function skips any account
--    carrying this marker: a deliberate disconnect is not an outage.
CREATE OR REPLACE FUNCTION public.mark_whatsapp_user_disconnected(p_account_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
BEGIN
  UPDATE public.social_accounts
     SET account_metadata = jsonb_set(
           COALESCE(account_metadata, '{}'::jsonb),
           '{whatsapp_user_disconnected_at}',
           to_jsonb(clock_timestamp()::text))
   WHERE id = p_account_id
     AND platform = 'whatsapp'
     AND connection_mode = 'evolution_qr';

  RETURN FOUND;
END;
$fn$;
REVOKE ALL ON FUNCTION public.mark_whatsapp_user_disconnected(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_whatsapp_user_disconnected(uuid) TO service_role;

-- 7. Every five minutes: poll Evolution for the state of every paired WhatsApp QR account and
--    alert the ones that have been gone long enough. The minutes are offset from the top of the
--    hour so this run does not land on */5 with the other jobs. The cron secret is resolved at
--    run time through public.get_cron_secret(); no credential is stored in this file.
DO $do_cron_whatsapp_disconnect_watch$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron')
     OR to_regprocedure('public.get_cron_secret()') IS NULL THEN
    RAISE NOTICE 'whatsapp-disconnect-watch cron not scheduled: pg_cron or get_cron_secret() is missing';
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'whatsapp-disconnect-watch') THEN
    PERFORM cron.schedule(
      'whatsapp-disconnect-watch',
      '2,7,12,17,22,27,32,37,42,47,52,57 * * * *',
      $$
      SELECT net.http_post(url := 'https://api.postora.cloud/functions/v1/whatsapp-disconnect-watch', headers := jsonb_build_object('Content-Type','application/json','Authorization','Bearer ' || get_cron_secret()), body := '{}'::jsonb);
      $$
    );
  END IF;
END $do_cron_whatsapp_disconnect_watch$;
```

- [ ] **Step 4: Run the harness.** `bash scripts/db-harness.sh`. Expected: the
  `whatsapp_disconnect_alerts` suite passes and every other suite still passes. If a pre-existing
  suite fails, record it before continuing — do not "fix" an unrelated suite.

- [ ] **Step 5: Commit.**

```bash
git commit -- supabase/migrations/20261113200000_whatsapp_disconnect_alerts.sql supabase/tests/whatsapp_disconnect_alerts.sql scripts/db-harness.sh
```

---

### Task 2: The watch function's state machine

**Files:**
- Create: `supabase/functions/whatsapp-disconnect-watch/run.ts`
- Create: `supabase/functions/whatsapp-disconnect-watch/run.test.ts`

**Interfaces — Produces:**
- `classifyState(state: string | null): ConnectionClass` — `"healthy" | "transient" | "terminal" | "unknown"`
- `isAlertDue(episode: Episode, now: Date): boolean`
- `runWatch(deps: WatchDeps): Promise<WatchSummary>`
- Constants `DISCONNECT_GRACE_MINUTES = 10`, `DISCONNECT_BACKSTOP_MINUTES = 60`,
  `DISCONNECT_REASON`, `MAX_ACCOUNTS_PER_RUN = 50`

- [ ] **Step 1: Write the Deno tests first** (`supabase/functions/whatsapp-disconnect-watch/run.test.ts`).
  Model the file on `supabase/functions/sweep-pending-whatsapp-qr/run.test.ts`. The tests must cover:

  1. `classifyState("open")` → `"healthy"`; `classifyState("OPEN")` → `"healthy"` (case-insensitive);
     `classifyState("connecting")` → `"transient"`; `classifyState("close")` → `"terminal"`;
     `classifyState("timeout")` → `"terminal"`; `classifyState("unpaired")` → `"terminal"`;
     `classifyState("qr")` → `"terminal"`; `classifyState("some-future-state")` → `"terminal"`
     (fail-safe); `classifyState(null)` → `"unknown"`; `classifyState("")` → `"unknown"`.
  2. `isAlertDue` is `false` at 9 minutes of a continuous terminal streak and `true` at exactly 10.
  3. `isAlertDue` is `false` at 59 minutes of an episode whose streak keeps restarting, and `true` at
     exactly 60 (the backstop).
  4. `isAlertDue` is `false` for an episode with an unparsable `since` or `first_seen`.
  5. `runWatch` with a healthy account calls `clear` and nothing else.
  6. `runWatch` with a transient account calls `observe(..., terminal = false)` and does **not** flag
     or dispatch.
  7. `runWatch` with an unknown state (the read returned `null`) skips the account entirely: no
     `observe`, no `clear`, no flag, no dispatch.
  8. `runWatch` with a terminal account whose episode is not yet due flags nothing and dispatches
     nothing.
  9. `runWatch` with a terminal account whose episode is due calls `markFlagged` and `dispatchAlert`
     exactly once, in that order.
  10. `runWatch` isolates a failing account: a `readState` that throws for one account does not stop
      the others, and the run still returns a summary.
  11. `runWatch` never exceeds `MAX_ACCOUNTS_PER_RUN` — `listCandidates` is called with the limit.
  12. `runWatch` records the poll time for every account it read, including the skipped ones.

- [ ] **Step 2: Run the tests and confirm they fail.**
  `deno test --node-modules-dir=none supabase/functions/whatsapp-disconnect-watch/run.test.ts`.
  Expected: FAIL — `run.ts` does not exist.

- [ ] **Step 3: Write `run.ts`.**

```ts
// The pure state machine of the WhatsApp disconnect watcher. Everything the watcher decides
// lives here so it can be tested without Evolution, without Postgres and without a network.

export type ConnectionClass = "healthy" | "transient" | "terminal" | "unknown";

/** How long a terminal state must persist before the account is alerted. */
export const DISCONNECT_GRACE_MINUTES = 10;
/** How long an episode may last, flapping or not, before the account is alerted. */
export const DISCONNECT_BACKSTOP_MINUTES = 60;
/** How many accounts one run polls. */
export const MAX_ACCOUNTS_PER_RUN = 50;
/** The message the dashboard banner shows under the headline. No phone number, ever. */
export const DISCONNECT_REASON = "WhatsApp session disconnected. Scan a new QR code to reconnect.";

export interface Episode {
  since: string;
  first_seen: string;
  state: string;
  observed_at: string;
}

export interface WatchCandidate {
  id: string;
  instance_name: string;
}

/**
 * open is healthy, connecting is the transient flap Baileys emits during a normal reconnect,
 * and everything else is terminal: the session is gone and the phone must scan a new QR code.
 * An unknown (empty) state is neither: an unverifiable state is not evidence, so the caller
 * skips the account entirely rather than alerting or clearing on it.
 */
export function classifyState(state: string | null): ConnectionClass {
  const normalized = (state ?? "").trim().toLowerCase();
  if (!normalized) return "unknown";
  if (normalized === "open") return "healthy";
  if (normalized === "connecting") return "transient";
  return "terminal";
}

/**
 * The alert fires when the terminal state has persisted for the grace window, or when the
 * episode has lasted the backstop window however much it flapped.
 */
export function isAlertDue(episode: Episode, now: Date): boolean {
  const since = Date.parse(episode.since);
  const firstSeen = Date.parse(episode.first_seen);
  if (!Number.isFinite(since) || !Number.isFinite(firstSeen)) return false;
  const nowMs = now.getTime();
  const continuous = nowMs - since >= DISCONNECT_GRACE_MINUTES * 60_000;
  const backstop = nowMs - firstSeen >= DISCONNECT_BACKSTOP_MINUTES * 60_000;
  return continuous || backstop;
}

export interface WatchDeps {
  listCandidates(limit: number): Promise<WatchCandidate[]>;
  /** The live Evolution state, or null when Evolution cannot answer. */
  readState(instanceName: string): Promise<string | null>;
  observe(accountId: string, state: string, terminal: boolean): Promise<Episode | null>;
  clear(accountId: string): Promise<void>;
  markFlagged(accountId: string, reason: string): Promise<void>;
  dispatchAlert(accountId: string): Promise<void>;
  markPolled(instanceName: string, at: Date): Promise<void>;
  now(): Date;
}

export interface WatchSummary {
  polled: number;
  skipped: number;
  episodes: number;
  flagged: number;
  alerted: number;
  failed: string[];
}

export async function runWatch(deps: WatchDeps): Promise<WatchSummary> {
  const summary: WatchSummary = { polled: 0, skipped: 0, episodes: 0, flagged: 0, alerted: 0, failed: [] };
  const candidates = await deps.listCandidates(MAX_ACCOUNTS_PER_RUN);

  for (const candidate of candidates) {
    let state: string | null = null;
    try {
      state = await deps.readState(candidate.instance_name);
      await deps.markPolled(candidate.instance_name, deps.now());
    } catch (error) {
      // One broken account must never stop the others. The account id identifies the row.
      console.error(`[whatsapp-disconnect-watch] account ${candidate.id}: state read failed`);
      summary.failed.push(candidate.id);
      continue;
    }

    summary.polled += 1;
    const classification = classifyState(state);

    if (classification === "unknown") {
      // Evolution could not tell us. Never open an episode and never clear one on an
      // unverifiable state.
      summary.skipped += 1;
      continue;
    }

    try {
      if (classification === "healthy") {
        await deps.clear(candidate.id);
        continue;
      }

      const terminal = classification === "terminal";
      const episode = await deps.observe(candidate.id, state ?? "", terminal);
      if (!episode) continue;

      if (terminal) summary.episodes += 1;
      if (!isAlertDue(episode, deps.now())) continue;

      await deps.markFlagged(candidate.id, DISCONNECT_REASON);
      summary.flagged += 1;
      await deps.dispatchAlert(candidate.id);
      summary.alerted += 1;
    } catch (error) {
      console.error(`[whatsapp-disconnect-watch] account ${candidate.id}: handling failed`);
      summary.failed.push(candidate.id);
    }
  }

  return summary;
}
```

- [ ] **Step 4: Run the tests.** `deno test --node-modules-dir=none supabase/functions/whatsapp-disconnect-watch/run.test.ts`.
  Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git commit -- supabase/functions/whatsapp-disconnect-watch/run.ts supabase/functions/whatsapp-disconnect-watch/run.test.ts
```

---

### Task 3: The watch function's edge entrypoint

**Files:**
- Create: `supabase/functions/whatsapp-disconnect-watch/index.ts`

**Interfaces — Consumes:** `runWatch` from Task 2.
**Interfaces — Produces:** the `whatsapp-disconnect-watch` edge function.

- [ ] **Step 1: Write `index.ts`.** Copy the adapter shape of
  `supabase/functions/sweep-pending-whatsapp-qr/index.ts`: `restrictedCorsHeaders` for CORS,
  `verifyCronAuth` for authentication, `Deno.env` only for the vars already in
  `infra/edge-runtime.required-env.json`.

```ts
// Cron entrypoint for the WhatsApp disconnect watcher (spec
// 2026-11-13-whatsapp-disconnect-alerts-design.md). The watcher is the authority on whether an
// Evolution WhatsApp session is gone: it polls Evolution directly, so it works even when the
// connection.update webhook never fires.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { restrictedCorsHeaders } from "../_shared/cors.ts";
import { createEvolutionApi } from "../_shared/evolutionApi.ts";
import { extractState } from "../whatsapp-evolution-bridge/qr.ts";
import { runWatch, type Episode, type WatchCandidate } from "./run.ts";

const POLL_FRESHNESS_MINUTES = 5;

Deno.serve(async (req) => {
  const corsHeaders = restrictedCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const cronAuth = verifyCronAuth(req);
  if (!cronAuth.ok) return cronAuth.response;

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      console.error("[whatsapp-disconnect-watch] Supabase configuration missing");
      return new Response(
        JSON.stringify({ error: "watcher not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const admin = createClient(supabaseUrl, serviceRoleKey);
    const api = createEvolutionApi();

    const summary = await runWatch({
      async listCandidates(limit: number): Promise<WatchCandidate[]> {
        const { data, error } = await admin
          .from("social_accounts")
          .select("id, whatsapp_evolution_instances!inner(instance_name, last_polled_at)")
          .eq("platform", "whatsapp")
          .eq("connection_mode", "evolution_qr")
          .eq("is_active", true)
          .not("platform_user_id", "like", "pending_%")
          .not("platform_user_id", "like", "retired_%")
          .is("account_metadata->whatsapp_user_disconnected_at", null)
          .order("last_polled_at", { ascending: true, nullsFirst: true })
          .limit(limit);
        if (error) throw error;
        return (data ?? []).map((row: any) => ({
          id: row.id as string,
          instance_name: (row.whatsapp_evolution_instances as any[])[0]?.instance_name as string,
        }));
      },
      async readState(instanceName: string): Promise<string | null> {
        try {
          return extractState(await api.connectionState(instanceName));
        } catch {
          // An unreachable Evolution is not evidence about the account.
          return null;
        }
      },
      async observe(accountId: string, state: string, terminal: boolean): Promise<Episode | null> {
        const { data, error } = await admin.rpc("observe_whatsapp_disconnect_state", {
          p_account_id: accountId,
          p_state: state,
          p_terminal: terminal,
        });
        if (error) throw error;
        return (data as Episode | null) ?? null;
      },
      async clear(accountId: string): Promise<void> {
        const { error } = await admin.rpc("clear_whatsapp_disconnect_episode", {
          p_account_id: accountId,
        });
        if (error) throw error;
      },
      async markFlagged(accountId: string, reason: string): Promise<void> {
        const { error } = await admin
          .from("social_accounts")
          .update({ needs_reauth: true, last_refresh_error: reason })
          .eq("id", accountId);
        if (error) throw error;
      },
      async dispatchAlert(accountId: string): Promise<void> {
        const { error } = await admin.functions.invoke("send-whatsapp-disconnect-alert", {
          body: { account_id: accountId },
        });
        if (error) throw error;
      },
      async markPolled(instanceName: string, at: Date): Promise<void> {
        const { error } = await admin
          .from("whatsapp_evolution_instances")
          .update({ last_polled_at: at.toISOString() })
          .eq("instance_name", instanceName);
        if (error) throw error;
      },
      now: () => new Date(),
    });

    console.log(`[whatsapp-disconnect-watch] ${JSON.stringify(summary)}`);
    return new Response(
      JSON.stringify({ ok: true, ...summary }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    // Raw provider errors stay in the log; the response is generic.
    console.error(
      "[whatsapp-disconnect-watch] run failed:",
      error instanceof Error ? error.message : String(error),
    );
    return new Response(
      JSON.stringify({ error: "watcher run failed" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
```

  Two things to settle while writing this, and to fix if the deployed PostgREST rejects them:

  - **The embedded resource filter.** `select("id, whatsapp_evolution_instances!inner(...)")` requires a
    embedded relationship between `social_accounts` and `whatsapp_evolution_instances`. If PostgREST
    cannot resolve it (the FK is `social_accounts.id → whatsapp_evolution_instances.social_account_id`,
    i.e. the relationship exists but points the other way), **do not** embed. Run two queries instead:
    select the candidate `social_accounts` rows, then select the matching instance rows by
    `social_account_id` and join them in TypeScript. The `!inner` form is the nicer query; the two-query
    form is the safe fallback. Prove whichever one you ship against the live API before committing.
  - **The staleness filter.** The `.order("last_polled_at", …)` on an embedded resource orders by the
    embedded row. If the embedded form is not used, order by the instance row in the second query and
    apply the freshness cut in TypeScript: skip a candidate whose `last_polled_at` is newer than
    `POLL_FRESHNESS_MINUTES`. The constant must be used — an unused constant is a lint failure.

  `POLL_FRESHNESS_MINUTES` must actually filter candidates. A candidate polled less than five minutes
  ago is skipped (it was already checked) rather than polled again.

- [ ] **Step 2: Typecheck.**
  `deno check --node-modules-dir=none supabase/functions/whatsapp-disconnect-watch/index.ts`.
  Expected: PASS. If `admin.functions.invoke` is not on the untyped client, use
  `admin.rpc` or a `fetch` to `${SUPABASE_URL}/functions/v1/send-whatsapp-disconnect-alert` with
  `Authorization: Bearer <service role>` — the same call `refresh-tokens` makes to
  `send-token-failure-alert`.

- [ ] **Step 3: Commit.**

```bash
git commit -- supabase/functions/whatsapp-disconnect-watch/index.ts
```

---

### Task 4: The sender's pure handler

**Files:**
- Create: `supabase/functions/send-whatsapp-disconnect-alert/handler.ts`
- Create: `supabase/functions/send-whatsapp-disconnect-alert/handler.test.ts`

**Interfaces — Produces:**
- `buildOwnerEmail(account, fullName): string`
- `buildAdminEmail(account, ownerName): string`
- `sendDisconnectAlerts(deps, accountId): Promise<SendSummary>`
- Constants `OWNER_SUBJECT`, `ADMIN_SUBJECT`, `RECONNECT_URL`

- [ ] **Step 1: Write the Deno tests first** (`handler.test.ts`). The tests must cover:

  1. `buildOwnerEmail` contains the reconnect URL `https://postora.cloud/messaging/whatsapp/setup`.
  2. `buildOwnerEmail` contains the account display name.
  3. `buildOwnerEmail` never contains a phone number: pass an account whose `platform_user_id` is
     `"96566600001"` and assert the rendered HTML does not contain `96566600001`.
  4. `buildOwnerEmail` escapes the display name: a name of `<script>alert(1)</script>` must not appear
     verbatim in the output.
  5. `buildAdminEmail` contains the account display name and the owner name, and the reconnect URL.
  6. `sendDisconnectAlerts` sends **one** owner email when the owner has notifications enabled.
  7. `sendDisconnectAlerts` sends **no** owner email when `email_notifications_enabled` is false, and
     still sends the admin email.
  8. `sendDisconnectAlerts` claims before sending and marks after sending — assert the call order with
     a recording fake: `claim`, `send`, `mark`.
  9. `sendDisconnectAlerts` does not send when the claim is refused.
  10. `sendDisconnectAlerts` sends the admin email to **all** admins in one `to` array.
  11. `sendDisconnectAlerts` sends no admin email when the admin toggle is off.
  12. `sendDisconnectAlerts` isolates the two recipients: a failing owner `send` still lets the admin
      email go out.
  13. `sendDisconnectAlerts` sends nothing when the global email flag is off.

- [ ] **Step 2: Run the tests and confirm they fail.**
  `deno test --node-modules-dir=none supabase/functions/send-whatsapp-disconnect-alert/handler.test.ts`.
  Expected: FAIL — `handler.ts` does not exist.

- [ ] **Step 3: Write `handler.ts`.** Model the templates on
  `supabase/functions/send-undelivered-store-alerts/handler.ts:57-118` — the same product, the same page,
  the same layout — and the claim/send/mark order on `:142-159`.

```ts
// Pure selection, HTML rendering and the per-recipient send for the WhatsApp disconnect
// alert. The Deno.serve entrypoint builds the deps; everything here is I/O free so the
// behaviour is testable without Supabase or Resend.

export const OWNER_SUBJECT = "Your WhatsApp account needs to be reconnected";
export const ADMIN_SUBJECT = "A Postora user's WhatsApp account needs to be reconnected";
export const RECONNECT_URL = "https://postora.cloud/messaging/whatsapp/setup";

export type AlertKind = "user" | "admin";

export interface AlertAccount {
  id: string;
  user_id: string;
  platform_username: string | null;
  /** The owner's phone number. It must never reach an email. */
  platform_user_id: string;
}

export interface OwnerProfile {
  email: string;
  full_name: string | null;
  email_notifications_enabled: boolean | null;
}

export interface AdminProfile {
  email: string;
  full_name: string | null;
}

export interface SendAlertsDeps {
  loadAccount(accountId: string): Promise<AlertAccount | null>;
  loadOwnerProfile(userId: string): Promise<OwnerProfile | null>;
  loadAdmins(): Promise<AdminProfile[]>;
  isGlobalEmailEnabled(): Promise<boolean>;
  isAdminAlertEnabled(): Promise<boolean>;
  claim(accountId: string, kind: AlertKind): Promise<boolean>;
  send(payload: { to: string[]; subject: string; html: string }): Promise<void>;
  mark(accountId: string, kind: AlertKind): Promise<boolean>;
}

export interface SendSummary {
  ownerSent: boolean;
  adminSent: boolean;
  skipped: string | null;
  failed: string[];
}

// HTML emails interpolate user-controlled values (account name, profile name); every one of
// them goes through this before it reaches the template.
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * The account name is the only identity this email may carry: the row also holds the owner's
 * phone number, and a notification email is forwarded, quoted and searched — never a place
 * for it.
 */
function accountLabel(account: AlertAccount): string {
  return escapeHtml(account.platform_username || "WhatsApp");
}

function emailShell(headerGradient: string, headline: string, body: string, cta: string): string {
  return `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="margin: 0; padding: 0; background-color: #f3f4f6; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;">
      <table cellpadding="0" cellspacing="0" width="100%" style="max-width: 600px; margin: 0 auto; background-color: #ffffff;">
        <tr>
          <td style="padding: 32px 24px; background: ${headerGradient};">
            <h1 style="margin: 0; color: #ffffff; font-size: 22px; font-weight: 700;">
              ${headline}
            </h1>
          </td>
        </tr>
        <tr>
          <td style="padding: 24px;">
            ${body}
            <div style="margin: 24px 0; text-align: center;">
              <a href="${RECONNECT_URL}" style="display: inline-block; padding: 14px 32px; background-color: #ef4444; color: #ffffff; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 16px;">
                ${cta}
              </a>
            </div>
          </td>
        </tr>
        <tr>
          <td style="padding: 24px; background-color: #f9fafb; border-top: 1px solid #e5e7eb;">
            <p style="margin: 0; color: #6b7280; font-size: 12px; text-align: center;">
              This is an automated alert from Postora.
            </p>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;
}

export function buildOwnerEmail(account: AlertAccount, fullName: string | null): string {
  const body = `
            <p style="margin: 0 0 16px 0; color: #374151; font-size: 16px; line-height: 1.6;">
              Hi ${escapeHtml(fullName || "there")},
            </p>
            <p style="margin: 0 0 16px 0; color: #374151; font-size: 16px; line-height: 1.6;">
              Your WhatsApp account <strong>${accountLabel(account)}</strong> is no longer connected.
              Messages sent to it are not being delivered until you scan a new QR code.
            </p>`;
  return emailShell(
    "linear-gradient(135deg, #ef4444 0%, #d97706 100%)",
    "WhatsApp needs reconnecting",
    body,
    "Reconnect WhatsApp",
  );
}

export function buildAdminEmail(account: AlertAccount, ownerName: string | null): string {
  const owner = escapeHtml(ownerName || "a Postora user");
  const body = `
            <p style="margin: 0 0 16px 0; color: #374151; font-size: 16px; line-height: 1.6;">
              The WhatsApp account <strong>${accountLabel(account)}</strong> of ${owner} is no longer
              connected and needs a new QR code before it can receive messages again.
            </p>`;
  return emailShell(
    "linear-gradient(135deg, #334155 0%, #0f172a 100%)",
    "WhatsApp account needs reconnecting",
    body,
    "Reconnect WhatsApp",
  );
}

/**
 * Claim before send, mark after send. The owner and the admins are claimed independently, so a
 * failure on one side never blocks the other: each records its own outcome.
 */
export async function sendDisconnectAlerts(
  deps: SendAlertsDeps,
  accountId: string,
): Promise<SendSummary> {
  const summary: SendSummary = { ownerSent: false, adminSent: false, skipped: null, failed: [] };

  const account = await deps.loadAccount(accountId);
  if (!account) {
    summary.skipped = "account not found";
    return summary;
  }
  if (!(await deps.isGlobalEmailEnabled())) {
    summary.skipped = "email notifications disabled";
    return summary;
  }

  const owner = await deps.loadOwnerProfile(account.user_id);

  if (owner && owner.email_notifications_enabled === true) {
    try {
      const claimed = await deps.claim(accountId, "user");
      if (claimed) {
        await deps.send({
          to: [owner.email],
          subject: OWNER_SUBJECT,
          html: buildOwnerEmail(account, owner.full_name),
        });
        const marked = await deps.mark(accountId, "user");
        if (!marked) {
          console.error(`[send-whatsapp-disconnect-alert] account ${accountId}: owner mark refused`);
          summary.failed.push(accountId);
        } else {
          summary.ownerSent = true;
        }
      }
    } catch {
      // Logged with the account id only: never the recipient address or a phone number.
      console.error(`[send-whatsapp-disconnect-alert] account ${accountId}: owner email failed`);
      summary.failed.push(accountId);
    }
  }

  if (await deps.isAdminAlertEnabled()) {
    try {
      const admins = await deps.loadAdmins();
      if (admins.length > 0) {
        const claimed = await deps.claim(accountId, "admin");
        if (claimed) {
          await deps.send({
            to: admins.map((admin) => admin.email),
            subject: ADMIN_SUBJECT,
            html: buildAdminEmail(account, owner?.full_name ?? null),
          });
          const marked = await deps.mark(accountId, "admin");
          if (!marked) {
            console.error(`[send-whatsapp-disconnect-alert] account ${accountId}: admin mark refused`);
            summary.failed.push(accountId);
          } else {
            summary.adminSent = true;
          }
        }
      }
    } catch {
      console.error(`[send-whatsapp-disconnect-alert] account ${accountId}: admin email failed`);
      summary.failed.push(accountId);
    }
  }

  return summary;
}
```

- [ ] **Step 4: Run the tests.**
  `deno test --node-modules-dir=none supabase/functions/send-whatsapp-disconnect-alert/handler.test.ts`.
  Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git commit -- supabase/functions/send-whatsapp-disconnect-alert/handler.ts supabase/functions/send-whatsapp-disconnect-alert/handler.test.ts
```

---

### Task 5: The sender's edge entrypoint

**Files:**
- Create: `supabase/functions/send-whatsapp-disconnect-alert/index.ts`

**Interfaces — Consumes:** `sendDisconnectAlerts` from Task 4.
**Interfaces — Produces:** the `send-whatsapp-disconnect-alert` edge function.

- [ ] **Step 1: Write `index.ts`.** The sender is called by the watch function with the **service-role
  key** as a bearer token — the same relationship `refresh-tokens` has with
  `send-token-failure-alert`. Validate the body with Zod (ARCHITECTURE.md §15).

```ts
// Service-role entrypoint for the WhatsApp disconnect alert emails (spec
// 2026-11-13-whatsapp-disconnect-alerts-design.md). Modelled on send-token-expiry-notifications:
// the caller authenticates with the service role, Resend and a service-role client implement the
// deps, and every PostgREST result is checked explicitly.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { z } from "https://esm.sh/zod@3.23.8";
import { restrictedCorsHeaders } from "../_shared/cors.ts";
import { sendDisconnectAlerts, type AdminProfile, type AlertAccount, type OwnerProfile, type SendAlertsDeps } from "./handler.ts";

const FROM_SENDER = "Postora <notifications@postora.cloud>";

const BodySchema = z.object({
  account_id: z.string().uuid(),
});

Deno.serve(async (req) => {
  const corsHeaders = restrictedCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authorization = req.headers.get("Authorization") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!serviceRoleKey || !authorization.endsWith(serviceRoleKey)) {
      return new Response(
        JSON.stringify({ error: "unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const parsed = BodySchema.safeParse(await req.json());
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ error: "invalid request" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    if (!resendApiKey || !supabaseUrl) {
      console.error("[send-whatsapp-disconnect-alert] email not configured");
      return new Response(
        JSON.stringify({ error: "email not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const resend = new Resend(resendApiKey);
    const admin = createClient(supabaseUrl, serviceRoleKey);

    const deps: SendAlertsDeps = {
      async loadAccount(accountId) {
        const { data, error } = await admin
          .from("social_accounts")
          .select("id, user_id, platform_username, platform_user_id")
          .eq("id", accountId)
          .eq("platform", "whatsapp")
          .eq("connection_mode", "evolution_qr")
          .maybeSingle();
        if (error) throw error;
        return (data as AlertAccount | null) ?? null;
      },
      async loadOwnerProfile(userId) {
        const { data, error } = await admin
          .from("profiles")
          .select("email, full_name, email_notifications_enabled")
          .eq("id", userId)
          .maybeSingle();
        if (error) throw error;
        return (data as OwnerProfile | null) ?? null;
      },
      async loadAdmins() {
        const { data: roles, error: roleError } = await admin
          .from("user_roles")
          .select("user_id")
          .eq("role", "admin");
        if (roleError) throw roleError;
        const ids = (roles ?? []).map((role) => role.user_id as string);
        if (ids.length === 0) return [];
        const { data, error } = await admin
          .from("profiles")
          .select("email, full_name")
          .in("id", ids)
          .eq("email_notifications_enabled", true);
        if (error) throw error;
        return (data ?? []) as AdminProfile[];
      },
      async isGlobalEmailEnabled() {
        const { data, error } = await admin
          .from("app_settings")
          .select("value")
          .eq("key", "feature_email_notifications")
          .maybeSingle();
        if (error) throw error;
        if (!data) return true;
        const value = typeof data.value === "string" ? JSON.parse(data.value) : data.value;
        return value !== false;
      },
      async isAdminAlertEnabled() {
        const { data, error } = await admin
          .from("app_settings")
          .select("value")
          .eq("key", "admin_email_whatsapp_disconnect_alerts")
          .maybeSingle();
        if (error) throw error;
        if (!data) return true;
        const value = typeof data.value === "string" ? JSON.parse(data.value) : data.value;
        return value !== false;
      },
      async claim(accountId, kind) {
        const { data, error } = await admin.rpc("claim_whatsapp_disconnect_email", {
          p_account_id: accountId,
          p_kind: kind,
        });
        if (error) throw error;
        return data === true;
      },
      async send(payload) {
        const { error } = await resend.emails.send({
          from: FROM_SENDER,
          to: payload.to,
          subject: payload.subject,
          html: payload.html,
        });
        if (error) throw new Error(error.message);
      },
      async mark(accountId, kind) {
        const { data, error } = await admin.rpc("mark_whatsapp_disconnect_emailed", {
          p_account_id: accountId,
          p_kind: kind,
        });
        if (error) throw error;
        return data === true;
      },
    };

    const summary = await sendDisconnectAlerts(deps, parsed.data.account_id);
    return new Response(
      JSON.stringify({ ok: true, ...summary }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    // Raw database/provider errors stay in the log; the response is generic.
    console.error(
      "[send-whatsapp-disconnect-alert] run failed:",
      error instanceof Error ? error.message : String(error),
    );
    return new Response(
      JSON.stringify({ error: "alert run failed" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
```

- [ ] **Step 2: Typecheck.**
  `deno check --node-modules-dir=none supabase/functions/send-whatsapp-disconnect-alert/index.ts`.
  Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git commit -- supabase/functions/send-whatsapp-disconnect-alert/index.ts
```

---

### Task 6: The shared modules — clear on reconnect, mark on deliberate disconnect

**Files:**
- Modify: `supabase/functions/_shared/evolutionQrAccount.ts` (the `"open"` branch, around line 224)
- Modify: `supabase/functions/_shared/whatsappDisconnect.ts` (inside `disconnectWhatsAppAccount`)

**Interfaces — Consumes:** `clear_whatsapp_disconnect_episode`, `mark_whatsapp_user_disconnected` from Task 1.

- [ ] **Step 1: Clear the episode and the red flag when the account comes back.**
  In `supabase/functions/_shared/evolutionQrAccount.ts`, the `"open"` branch builds
  `updates = { is_active: true }` (line 224) and later applies them. Add the clear there, as a
  best-effort RPC call right after the account update succeeds — a failed clear must never undo the
  activation, exactly like `clearUndeliveredSafely` at line 185.

  The call must be added to the `"open"` branch only. The `"close"` branch (line 206) must not clear
  anything: it is the disconnection itself.

- [ ] **Step 2: Mark the deliberate disconnect.**
  In `supabase/functions/_shared/whatsappDisconnect.ts`, inside `disconnectWhatsAppAccount`, after the
  deactivation succeeds, stamp `whatsapp_user_disconnected_at` through the RPC — but **only** for
  `connection_mode === 'evolution_qr'`. A Meta-mode disconnect has no QR to rescan and must not be
  marked. The mark is best effort: a failure must not turn a completed disconnect into an error for the
  user (same rule as the warnings above it).

- [ ] **Step 3: Typecheck both modules.**
  `deno check --node-modules-dir=none supabase/functions/_shared/evolutionQrAccount.ts supabase/functions/_shared/whatsappDisconnect.ts`.
  Expected: PASS.

- [ ] **Step 4: Run the existing tests for the modules you touched.**
  `deno test --node-modules-dir=none supabase/functions/_shared/evolutionQrAccount.test.ts supabase/functions/_shared/whatsappDisconnect.test.ts`
  (drop any file that does not exist — check with `git ls-files` first). Expected: PASS. If a test
  asserts the exact set of writes on the account row, update it to include the new call and keep the
  assertion about the *outcome*, not the call count.

- [ ] **Step 5: Commit.**

```bash
git commit -- supabase/functions/_shared/evolutionQrAccount.ts supabase/functions/_shared/whatsappDisconnect.ts
```

---

### Task 7: The frontend — the pure rule and the hook

**Files:**
- Create: `src/lib/reconnectTarget.ts`
- Create: `src/lib/__tests__/reconnectTarget.test.ts`
- Create: `src/hooks/useAccountsNeedingReconnect.ts`
- Create: `src/hooks/__tests__/useAccountsNeedingReconnect.test.tsx`

**Interfaces — Produces:**
- `reconnectTargetFor(account): { kind: "oauth" } | { kind: "link"; path: string }`
- `useAccountsNeedingReconnect()` — a React Query hook returning the accounts the banner must render.

- [ ] **Step 1: Write the Vitest tests first.**
  `src/lib/__tests__/reconnectTarget.test.ts`:
  1. A WhatsApp `evolution_qr` account resolves to `{ kind: "link", path: "/messaging/whatsapp/setup" }`.
  2. A Meta account (facebook, instagram, …) resolves to `{ kind: "oauth" }`.
  3. A WhatsApp account that is **not** `evolution_qr` resolves to `{ kind: "oauth" }` — the Meta
     WhatsApp modes do reconnect through OAuth.

  `src/hooks/__tests__/useAccountsNeedingReconnect.test.tsx`:
  1. The hook queries `social_accounts` twice: once for `is_active = true` rows with
     `needs_reauth = true`, and once for `is_active = false` rows with `platform = 'whatsapp'`,
     `connection_mode = 'evolution_qr'` and `needs_reauth = true`.
  2. The results of both queries are merged into one list.
  3. Every query is scoped to the signed-in user's id.
  4. A query error is thrown (not swallowed), so React Query can retry.

- [ ] **Step 2: Run the tests and confirm they fail.** `npm test -- src/lib/__tests__/reconnectTarget.test.ts src/hooks/__tests__/useAccountsNeedingReconnect.test.tsx`.
  Expected: FAIL — the modules do not exist.

- [ ] **Step 3: Write `src/lib/reconnectTarget.ts`.**

```ts
// How an account is reconnected. A WhatsApp account paired through the Evolution API reconnects
// by scanning a new QR code on the WhatsApp setup page; every other platform reconnects through
// the OAuth flow that useProfileOAuth drives.
//
// The OAuth flow has no WhatsApp branch (src/hooks/useProfileOAuth.tsx), so routing a WhatsApp
// account into it would strand the owner on a redirect that cannot happen.

export const WHATSAPP_QR_SETUP_PATH = "/messaging/whatsapp/setup";

export interface ReconnectableAccount {
  platform: string;
  connection_mode: string | null;
}

export type ReconnectTarget = { kind: "oauth" } | { kind: "link"; path: string };

export function reconnectTargetFor(account: ReconnectableAccount): ReconnectTarget {
  if (account.platform === "whatsapp" && account.connection_mode === "evolution_qr") {
    return { kind: "link", path: WHATSAPP_QR_SETUP_PATH };
  }
  return { kind: "oauth" };
}
```

- [ ] **Step 4: Write `src/hooks/useAccountsNeedingReconnect.ts`.** The query leaves the visual
  component (ARCHITECTURE.md §11). Build the two queries separately — supabase-js builders are
  mutable, so one builder must not be reused for two chains.

```ts
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";

export interface AccountNeedingReconnect {
  id: string;
  platform: string;
  platform_username: string | null;
  needs_reauth: boolean;
  last_refresh_error: string | null;
  social_profile_id: string | null;
  connection_mode: string | null;
  is_active: boolean;
}

const COLUMNS =
  "id, platform, platform_username, needs_reauth, last_refresh_error, social_profile_id, connection_mode, is_active";

/**
 * The accounts the dashboard banner must render.
 *
 * Two sets, because a disconnected WhatsApp account is inactive by design: the OAuth platforms
 * stay active and carry needs_reauth, while an Evolution QR account is deactivated the moment
 * its session dies (see _shared/evolutionQrAccount.ts) and is found by platform and connection
 * mode instead. is_active must not be flipped to make it fit the first query: the reconnectable
 * list and the webhook's account lookup both depend on it.
 */
export function useAccountsNeedingReconnect() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["accounts-needing-reauth", user?.id],
    enabled: !!user,
    refetchInterval: 60000, // Check every minute
    queryFn: async () => {
      if (!user) return [];

      const activeQuery = supabase
        .from("social_accounts")
        .select(COLUMNS)
        .eq("user_id", user.id)
        .eq("is_active", true)
        .eq("needs_reauth", true);

      const whatsappQrQuery = supabase
        .from("social_accounts")
        .select(COLUMNS)
        .eq("user_id", user.id)
        .eq("is_active", false)
        .eq("platform", "whatsapp")
        .eq("connection_mode", "evolution_qr")
        .eq("needs_reauth", true);

      const [active, whatsappQr] = await Promise.all([activeQuery, whatsappQrQuery]);
      if (active.error) throw active.error;
      if (whatsappQr.error) throw whatsappQr.error;

      const merged = [...(active.data ?? []), ...(whatsappQr.data ?? [])];
      const seen = new Set<string>();
      return merged.filter((account) => {
        if (seen.has(account.id)) return false;
        seen.add(account.id);
        return true;
      }) as AccountNeedingReconnect[];
    },
  });
}
```

- [ ] **Step 5: Run the tests.** `npm test -- src/lib/__tests__/reconnectTarget.test.ts src/hooks/__tests__/useAccountsNeedingReconnect.test.tsx`.
  Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git commit -- src/lib/reconnectTarget.ts src/lib/__tests__/reconnectTarget.test.ts src/hooks/useAccountsNeedingReconnect.ts src/hooks/__tests__/useAccountsNeedingReconnect.test.tsx
```

---

### Task 8: The banner and the strings

**Files:**
- Modify: `src/components/dashboard/TokenReauthBanner.tsx`
- Modify: `src/i18n/locales/ar/dashboard.json`

- [ ] **Step 1: Replace the inline query with the hook.** In `TokenReauthBanner.tsx`, delete the
  `useQuery` block (lines 35-52) and its `supabase` import, and consume the hook:

```ts
const { data: accountsNeedingReauth = [] } = useAccountsNeedingReconnect();
```

  The component's local `AccountNeedingReauth` interface (lines 14-21) is replaced by the hook's
  exported type.

- [ ] **Step 2: Route the WhatsApp button to the QR page.** The banner's `handleReconnect`
  (lines 63-72) calls `handleReconnectPlatform`, which has no WhatsApp branch. Use the pure rule:

```ts
const target = reconnectTargetFor(account);
```

  and render a `Link` to `target.path` when `target.kind === "link"`, keeping the existing
  `handleReconnectPlatform` call for `target.kind === "oauth"`. The link button must read
  `t("reauth.reconnectWhatsapp", "Reconnect WhatsApp")`; the OAuth button keeps
  `t("reauth.reconnect", "Reconnect")`.

  The headline must also stop saying "Connection Expired" for a dropped session. Use a new key
  `reauth.disconnected` with the default `"{{platform}} Disconnected"`, and keep
  `reauth.connectionExpired` for the OAuth platforms.

- [ ] **Step 3: Add the Arabic strings.** In `src/i18n/locales/ar/dashboard.json`, inside the
  existing `reauth` block, add:

```json
    "disconnected": "{{platform}} غير متصل",
    "reconnectWhatsapp": "إعادة ربط واتساب"
```

  Keep the keys sorted the way the file already is, and keep the English defaults in the code
  (`t(key, "default")`) so the English build needs no bundle entry.

- [ ] **Step 4: Run the i18n gate.** `npm run check:i18n`. Expected: PASS. The check runs **both**
  directions — a key used in code but missing from the bundle fails, and a bundle key no longer
  used in code fails. Removing `reauth.connectionExpired` from the code while it stays in the
  bundle is a failure.

- [ ] **Step 5: Typecheck and lint.**
  `npm run typecheck` and `npm run lint`. Expected: PASS.

- [ ] **Step 6: Commit.**

```bash
git commit -- src/components/dashboard/TokenReauthBanner.tsx src/i18n/locales/ar/dashboard.json
```

---

### Task 9: The admin toggle, the function config and the CI step

**Files:**
- Modify: `src/components/admin/AdminNotificationSettings.tsx` (the `ADMIN_EMAIL_TOGGLES` array, line 15)
- Modify: `supabase/config.toml`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: Add the admin toggle.** In `ADMIN_EMAIL_TOGGLES`, add one entry:

```ts
  { key: "admin_email_whatsapp_disconnect_alerts", label: "WhatsApp Disconnect Alerts", description: "A user's WhatsApp account lost its connection and needs a new QR code", defaultValue: true },
```

  No migration seed is needed: the readers treat a missing `app_settings` row as enabled.

- [ ] **Step 2: Declare the two functions in `supabase/config.toml`.**

```toml
[functions.whatsapp-disconnect-watch]
verify_jwt = false

[functions.send-whatsapp-disconnect-alert]
verify_jwt = false
```

  Both are behind the cron secret / the service role. This matches
  `[functions.sweep-pending-whatsapp-qr] verify_jwt = false`.

- [ ] **Step 3: Add the CI step.** In `.github/workflows/ci.yml`, next to the
  "Typecheck and test the unpaired WhatsApp QR cleanup" step (line 295), add:

```yaml
      - name: Typecheck and test the WhatsApp disconnect alerts
        run: |
          set -euo pipefail
          fn="supabase/functions"
          deno check --node-modules-dir=none "${fn}/whatsapp-disconnect-watch/index.ts" "${fn}/send-whatsapp-disconnect-alert/index.ts"
          deno test --node-modules-dir=none "${fn}/whatsapp-disconnect-watch/run.test.ts" "${fn}/send-whatsapp-disconnect-alert/handler.test.ts"
```

- [ ] **Step 4: Verify the whole gate set.**
  `npm run typecheck`, `npm run lint`, `npm test`, `npm run check:i18n`,
  `npm run check:edge-env` (24 pre-existing findings are expected — **25 is a regression**),
  `bash scripts/db-harness.sh`.

- [ ] **Step 5: Commit.**

```bash
git commit -- src/components/admin/AdminNotificationSettings.tsx supabase/config.toml .github/workflows/ci.yml
```

---

### Task 10: Guard pass, commit and deploy

- [ ] **Step 1: Run the guards.** `clean-code-guard` on the changed production code and `test-guard`
  on the changed and added tests. Fix what they report. The guards are the same ones the repo's
  workflow requires before a commit.

- [ ] **Step 2: Check for dead modules (ARCHITECTURE.md §1).** Name the production call site of every
  new module. If a module has no non-test caller, it is not done:

  | Module | Production caller |
  |---|---|
  | `supabase/functions/whatsapp-disconnect-watch/run.ts` | `supabase/functions/whatsapp-disconnect-watch/index.ts` |
  | `supabase/functions/send-whatsapp-disconnect-alert/handler.ts` | `supabase/functions/send-whatsapp-disconnect-alert/index.ts` |
  | `src/lib/reconnectTarget.ts` | `src/components/dashboard/TokenReauthBanner.tsx` |
  | `src/hooks/useAccountsNeedingReconnect.ts` | `src/components/dashboard/TokenReauthBanner.tsx` |

- [ ] **Step 3: Update the knowledge graph.** `graphify update .` if `graphify-out/` exists in this
  worktree. Do **not** commit `graphify-out/` (the dirty files are expected; the rule is not to commit
  them).

- [ ] **Step 4: Commit anything still outstanding** with explicit paths. Never commit `graphify-out/`,
  `.env*`, logs or secrets.

- [ ] **Step 5: Deploy.** Three deployables, in this order:

  1. **The migration.** Apply it to the self-hosted Postgres as `supabase_admin` **before** the
     functions are deployed, then reload PostgREST so the new RPCs are visible. The cron job is
     created by the migration, so it will start calling the function before it exists — the
     function returns 401 without the cron secret and the run fails harmlessly. Apply the migration
     and deploy the function in the same window.
  2. **The edge functions.** Copy the changed files into the functions volume
     `/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions/`, verify the
     SHA256 hashes, then `docker compose up -d --no-deps functions` from the stack dir
     (`docs/runbooks/deploy-edge-function.md`). Read each file from `git show <ref>:<path>` of the
     pushed ref — **never** from `/root/postora-runtime`'s working tree.
     Deploy: `whatsapp-disconnect-watch`, `send-whatsapp-disconnect-alert`,
     `_shared/evolutionQrAccount.ts`, `_shared/whatsappDisconnect.ts`.
     ⚠️ Do **not** use `npx supabase functions deploy` — that targets Supabase Cloud and fails here.
  3. **The frontend.** Push the branch and open a PR. The frontend deploys automatically when `main`
     is merged.

- [ ] **Step 6: Verify.**
  - Boot probe: `curl -s -o /dev/null -w '%{http_code}' https://api.postora.cloud/functions/v1/whatsapp-disconnect-watch`
    — expect 401 without the cron secret.
  - Cron: `SELECT jobname, schedule FROM cron.job WHERE jobname = 'whatsapp-disconnect-watch';` —
    expect one row on `2,7,12,…`.
  - End to end: set a test account's Evolution instance to a terminal state, wait one cron cycle
    plus the ten-minute grace, and confirm **one** owner email, **one** admin email, the dashboard
    banner, and `account_metadata.whatsapp_disconnect_user_email_at` set. A second cycle must send
    nothing.
  - Reconnect the account and confirm the banner disappears, `needs_reauth` is false, and the
    episode is cleared.

---

## Notes and traps

- **The debounce lives in the watch function, not in the sender.** The sender decides *who* to email;
  the watch function decides *whether* it is an outage. Do not move the grace window into the sender.
- **The webhook is not modified.** It already records `last_connection_state` and deactivates the
  account. The watcher does not need it, and the webhook must not start sending emails: the webhook
  fires per event, and one outage can produce many events.
- **`needs_reauth` on an `evolution_qr` row belongs to this feature.** The token-refresh sweep never
  selects those rows (no `token_expires_at`, `auth_provider = 'native'`), so there is no collision. If
  someone later gives Evolution QR accounts a refresh token, this assumption breaks — say so in the
  migration comment.
- **`clear_whatsapp_disconnect_episode` clears `needs_reauth` on `evolution_qr` rows only.** On every
  other platform those two columns belong to the token-refresh path.
- **Never put a phone number in an email or a log.** `platform_user_id` holds it.
- **`supabase/tests/*.sql` must be in `SUITES`** or the harness fails before it runs anything.
- **The SQL harness applies migrations newer than the baseline.** The baseline marker is
  `20260830120300_partner_api_least_privilege_grants.sql` with `BASELINE_COUNT: 253`
  (`supabase/tests/baseline_schema.sql:1`), so this migration is applied by the harness. If the
  harness fails with a checksum complaint, run `scripts/regenerate-baseline.sh` as the harness header
  instructs — and do not hand-edit `baseline_schema.sql`.
- **A watch run that polls 50 accounts sequentially can take a while.** The Evolution call has a
  10-second timeout (`supabase/functions/_shared/evolutionApi.ts:149`). If a run exceeds the cron
  interval, two runs may overlap — the row lock and the conditional claim make that safe, but raise
  `MAX_ACCOUNTS_PER_RUN` only with the fleet size in mind.
