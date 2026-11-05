# Meta owned-analytics completion: accept a day whose cells another job of the same account captured

Date: 2026-11-05. Status: design, owner approved the approach on a card ("unblock now + root fix through the pipeline").

## 1. The defect (production, 2026-11-05)

`complete_fb_analytics_collection_job` (and its Threads twin) refuse `p_outcome='success'` with `MAH05 META_ANALYTICS_INCOMPLETE_COLLECTION` unless, for the job's two closed days and every post in its checkpoint, an `available` metric cell exists **whose `capture_id` belongs to this job and generation** (`c.job_id=p_job_id AND c.job_generation=p_job_generation`, migration `20261101144500_meta_owned_analytics_capture_failures.sql` lines ~17–29 and ~57–72).

Daily jobs overlap: job *D* owns days *D−1* and *D−2*, job *D+1* owns *D* and *D−1*; both inventory the same posts. `persist_*_analytics_capture` upserts metric cells with `capture_id=EXCLUDED.capture_id` (`20261101130000…sql` lines 1083–1114, 1258–1269), so the **later writer takes the cell's `capture_id`**. Once two jobs interleave, the earlier job can never satisfy the rule:

- Page `8d1872d2` (pilot), job `b22ce0ec` due 2026-11-04: inventory complete, 171 post operations and 2 day operations all `success` by 10:30 UTC; the rule found 4 day-cells (2026-11-03) and 124 posts "missing" because job due 2026-11-05 had re-captured them.
- `OwnedAnalyticsStore.call` maps every `MAH05` to `AnalyticsWorkerStopped("configuration_unavailable")` (`meta-owned-analytics-sync/store.ts:69`), which aborts the **whole drain** and leaves the job `running` with a live lease. From 10:35 to 13:20 UTC every 5-minute drain visited that one job, failed, and nothing else on Facebook was collected (29 consecutive `{"ok":false,"reason":"configuration_unavailable"}` receipts). Threads happened not to interleave yet (24 jobs `success`), but its rule is identical.

Unblock applied on prod at 13:23 UTC (owner card): job `b22ce0ec` set to `failed` / `completion_rule_overlap` with its claim released; backup `/root/backup-fb_job_b22ce0ec-20261105T132341Z.sql` (0600). The next drain returned `ok:true` and the 2026-11-05 job resumed.

## 2. Goal

A job whose own checkpoint and operations are complete reaches `success` when every required cell for its days and posts is `available` for **this account**, whichever job captured it. A completion the database still refuses must release the job and let the drain continue, never wedge the platform.

## 3. Non-goals

- Changing which metrics are required for `success`, the retention rules, or the per-job operation/checkpoint rules (first `MAH05` block stays byte-identical).
- Re-running or repairing the pilot's 2026-11-04 job (its data is present via the 2026-11-05 job; the next-day enqueue is unaffected).
- Touching `persist_*_analytics_capture` or the `capture_id` ownership of cells.

## 4. Design

### 4.1 Migration `20261105160000_meta_owned_analytics_completion_overlap.sql`

`CREATE OR REPLACE` of `complete_fb_analytics_collection_job` and `complete_threads_analytics_collection_job`, byte-identical to their definitions in `20261101144500_meta_owned_analytics_capture_failures.sql` except in the **second** `p_outcome='success'` block (the metric-coverage block):

- Facebook day cells and post cells, Threads day cells and post cells: drop the join to `*_analytics_captures` and the predicates `c.job_id=p_job_id AND c.job_generation=p_job_generation`. The cell must still be for the same `user_id`, `social_account_id`, `metric_date`/`platform_post_id`, `metric_key`, and `m.status='available'`.
- Threads followers: the point-in-time `followers` cell must still exist for this account, `available`, from any capture of this account.
- The header comment states the overlap fact and the pilot job id as the regression source.
- Grants/ownership unchanged: `SECURITY DEFINER`, `search_path=public,pg_temp`, `lock_timeout='3s'`, service-role EXECUTE as today.

Why the subject, not the job: the stored cell is the account's truth for that day/post; which job wrote it last is bookkeeping. The first block still proves the job itself finished its inventory and operations.

### 4.2 Worker: a refused completion releases the job instead of stopping the drain

`supabase/functions/meta-owned-analytics-sync/store.ts`: `OwnedAnalyticsStore.complete(...)` catches the `MAH05` refusal **only for `complete_*` RPCs** and throws a new `CompletionRefused` error (`deadline.ts`, carrying `sqlstate: "MAH05"`). `MAH05` from any other RPC keeps meaning `configuration_unavailable` (that is what `claim_*` raises for an unconfigured platform, `20261101141000…sql:13`).

`worker.ts` `collectJob`: when the `success` completion throws `CompletionRefused`, complete the job as `failed` with reason `completion_refused` (claim released, no retry; the next due date enqueues normally) and return `"refused"`. The drain continues with the next job. A `partial`/`retry`/`failed` completion that is refused is a contract bug and still propagates as `invalid_contract`.

### 4.3 Observability

The `failed`/`completion_refused` job row is the durable evidence (same place `reauth_required`/`permission_missing` land today). No new log sink.

## 5. Security

No new RPC, no new grant. The functions keep `meta_analytics_assert_service()` and the fenced-job check. The worker change touches no credential path.

## 6. Tests

- SQL (`supabase/tests/meta_owned_analytics_capture_failures.sql`, new DO block per platform, registered already): job A (due *D*) claims and persists every required day and post cell as `available`, is **not** completed; job B (due *D+1*, enqueued with `p_force=true` is not needed — a later `due_on`) claims and re-persists the same day *D−1* and the same posts so the cells' `capture_id` now belongs to B; then `complete_*(A, 'success')` **succeeds** (today: `MAH05`), and a job whose cells are genuinely `unavailable` is still refused with `MAH05`.
- Deno (`meta-owned-analytics-sync/termination.test.ts` or `collection.test.ts`, whichever already fakes `complete_*`): a `complete_fb_analytics_collection_job` RPC answering `{ error: { code: "MAH05" } }` for `success` makes the worker call it again with `("failed", "completion_refused")`, return `"refused"`, and the drain visits the next job; a `MAH05` from `claim_*` still stops with `configuration_unavailable`.
- Existing suites stay green: `meta_owned_analytics_history.sql`, `…_worker_progress.sql`, `…_truncation.sql`, `…_inventory.sql`, `…_retention.sql`; Deno `composition/dispatch/collection/retention/truncation/termination`.

## 7. Deploy and verification

Migration applied on prod before merge (owner card), with a 0600 backup of both functions; edge sync of `meta-owned-analytics-sync` from `main`. Verification: the pilot's 2026-11-05 job reaches `success` on its own (it will overlap with the 2026-11-06 job after 00:30 UTC enqueue), `fb_analytics_collection_jobs` shows no `running` row older than one lease, and the drain receipts stay `ok:true`.
