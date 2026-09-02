# Runbook — the partner webhook delivery worker

Deliverable 5.4 ("deployment verification", "redrive/replay tooling"). Design record:
`docs/decisions/2026-09-02-d5-webhook-substrate.md`.

**What this covers:** `process-partner-webhooks`, the cron worker that drains
`partner_webhook_deliveries`. Deploying the function itself follows the general procedure in
[`deploy-edge-function.md`](deploy-edge-function.md); this document is the part that is specific
to a *queue* — how to tell whether it is draining, and what to do when it is not.

**The thing to internalise:** a correct outbox accumulates undelivered rows in perfect silence.
Nothing 500s, nothing pages, nothing looks broken. The only symptom is backlog age, so the checks
below are not optional decoration — they are the entire failure detector.

---

## 0. Prerequisites the function will not tell you about

| Requirement | Why | How it fails if missing |
|---|---|---|
| `20260902120000_partner_webhooks.sql` applied | The tables and the four functions | Every tick 500s on `claim_partner_webhook_deliveries` not existing |
| `20260902120100_partner_webhook_cron.sql` applied | The `* * * * *` schedule and the retention job | **Silence.** The function deploys fine and is simply never called |
| `get_cron_secret()` returns non-null | `verifyCronAuth` | Every tick 401s |

That middle row is the one that bites: an un-scheduled worker is indistinguishable from a healthy
idle one until a partner asks where their events went.

---

## 1. Deploy

Follow `deploy-edge-function.md` §0 (fetch on the server, copy into the volume, verify SHA256,
`docker compose restart functions`). Two files, plus the two shared modules:

```bash
VOL=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/files/volumes/functions
STACK=/etc/dokploy/compose/postorasupabase-supabase-j8axyh/code

# process-partner-webhooks/{index.ts,worker.ts}
# _shared/{partnerWebhookDelivery.ts,partnerWebhookEvents.ts,webhookSecurity.ts}
# partner-api/{router.ts,v1/router.ts,v1/webhooks.ts}
```

`webhookSecurity.ts` is shared with `n8n-api` and `process-post`. Its signature changed in Phase 5
(the fourth argument became an options object), so deploying it **without** redeploying
`_shared/n8nMessagingDispatch.ts` leaves a caller passing a number where an object is expected —
which in Deno is not a crash, it is a silently ignored timeout. Copy both.

---

## 2. Verify the deploy

```bash
# The function exists and rejects an unauthenticated call. 401 is the PASS here:
# a 404 means it was not copied, a 200 means cron auth is not being enforced.
curl -s -o /dev/null -w '%{http_code}\n' -X POST \
  https://api.postora.cloud/functions/v1/process-partner-webhooks
# expect 401
```

```sql
-- The schedule exists and is active.
SELECT jobname, schedule, active FROM cron.job
 WHERE jobname IN ('process-partner-webhooks', 'purge-partner-webhook-deliveries');
-- expect two rows, active = t, schedules '* * * * *' and '37 4 * * *'

-- It is actually running. Look at the last few invocations, not just the schedule.
SELECT status, return_message, start_time
  FROM cron.job_run_details
 WHERE jobid = (SELECT jobid FROM cron.job WHERE jobname = 'process-partner-webhooks')
 ORDER BY start_time DESC LIMIT 5;
```

An end-to-end proof, which is worth doing once after the first deploy: create a subscription
pointing at a request-bin you control, `POST /v1/webhooks/{id}/test`, and confirm the request
arrives within ~60s carrying `X-Postora-Event: webhook.test` and a verifiable
`X-Postora-Signature`.

---

## 3. Is it draining?

```sql
SELECT * FROM partner_webhook_backlog();
```

| Column | Healthy | What a bad value means |
|---|---|---|
| `pending_count` | Small and moving | Large and static: the worker is not running, or every endpoint is failing |
| `delivering_count` | Near zero between ticks | Persistently high: rows are being claimed and not settled |
| `stuck_lease_count` | **0** | A worker was killed mid-delivery. Rows recover on the next tick; a *persistent* non-zero means the worker dies every tick |
| `oldest_pending_age_secs` | < 60 | The single most useful number here. Over 900 the worker writes a `system_logs` row itself |
| `exhausted_count` | Grows only with real endpoint outages | Endpoints have been auto-disabled; see §4 |

The worker's own warning:

```sql
SELECT created_at, message, metadata FROM system_logs
 WHERE source = 'process-partner-webhooks' ORDER BY created_at DESC LIMIT 10;
```

**This is a log row, not an alert.** Postora has no alerting stack and Phase 5 deliberately did not
invent one. Nothing pages anybody; someone has to look.

---

## 4. An endpoint was auto-disabled

D5 disables a subscription only when a delivery **exhausts the whole ladder** (6 attempts across
~8h36m). That is a real, sustained outage on the partner's side, not a blip.

```sql
SELECT id, url, disabled_at, disabled_reason, consecutive_failures, last_error
  FROM partner_webhooks WHERE NOT is_active;
```

Two ways back, and they are not equivalent:

- **The partner fixes their endpoint and re-enables it themselves** —
  `PATCH /v1/webhooks/{id}` with `{"is_active": true}`. This clears the disabled reason and the
  failure count, and *resumes* the queue. It does **not** replay what already exhausted.
- **Operator redrive**, when the exhausted events matter:

```sql
-- Re-enables the endpoint AND resets its exhausted rows to pending.
SELECT * FROM redrive_partner_webhook_deliveries('<webhook uuid>'::uuid, 100);
```

`redrive` touches **exhausted rows only** — a delivered row was not lost and must not be re-sent, a
pending row is already queued. It re-enables the subscription as part of the same call, because the
claim requires an active webhook: resetting rows alone returns an encouraging count and delivers
nothing.

Confirm the partner has actually fixed their endpoint before redriving. Redriving into a still-broken
endpoint just spends the ladder again.

---

## 5. Stop deliveries during an incident

```sql
SELECT cron.unschedule('process-partner-webhooks');
```

Nothing is lost — that is what the outbox is for. Rows accumulate as `pending` and drain when the
job is re-scheduled by re-applying `20260902120100_partner_webhook_cron.sql`.

Do **not** reach for `DELETE FROM partner_webhook_deliveries` to quiet things down. Those rows are
a partner's undelivered events, and unlike a retry, a deletion is not something the ladder can
recover from.

---

## 6. Sizing, and when to revisit it

The defaults (60s cadence, 20 rows per tick, concurrency 5, 45s budget) imply a ceiling of roughly
**1,200 deliveries/hour**. They were chosen with zero partners live and are written down precisely
so the first partner who exceeds them is a known event rather than a mystery backlog.

The signal to revisit is `oldest_pending_age_secs` rising while `pending_count` stays high across
consecutive ticks — the queue arriving faster than one tick drains it. Raise `claimLimit` and
`concurrency` in `process-partner-webhooks/worker.ts` together, and keep
`claimLimit / concurrency × 25s` inside the 45s budget.
