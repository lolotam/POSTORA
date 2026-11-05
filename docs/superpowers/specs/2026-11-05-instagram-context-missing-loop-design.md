# Instagram owner collection: settle a context-less job once, enqueue only collectable accounts

Date: 2026-11-05. Status: design, owner approved on a card ("narrow the rollout to xsellpoint now + fix PR through the pipeline"). Evidence record: `docs/journeys/2026-11-05-analytics-section-state.md` §3.1.

## 1. The defect (production, 2026-11-04 → 2026-11-05)

`ig_collection_try_claim_job` binds an owner job's connection context (`context_viewer_social_account_id`, `context_credential_generation`, `context_login_kind`) from `instagram_account_capabilities` at claim time. An Instagram account connected before capability probing existed has no capability row, so its claimed job has no context. The worker (`instagram-insights-sync/worker.ts`, `readJobContext`) abandons such a job to its lease with `context_missing` and writes nothing; the lease expires two minutes later; the next drain claims it again. On 2026-11-05 29 jobs for 21 accounts had been re-claimed every 2 minutes for up to 19 hours (`attempts` 573) with zero operations, 720 wasted claim cycles per day, and the Instagram page showed "Instagram temporary service issue. Next attempt is scheduled."

Migration `20261104150000_instagram_owner_enqueue_reconnect_required.sql` already refuses the owner's own sync request (`enqueue_instagram_collection_job_for_user`) with `reconnect_required` for such an account, and deliberately left the daily service enqueue and the worker unchanged. This design closes those two.

Operator action already taken (2026-11-05 18:14 UTC, owner card): `collection_instagram_rollout_policy` set to `owners: allowlist [9df1c79a-46b5-4d06-aea5-42905aea0931]` (the one account with a capability row); the 29 leased jobs released as `unavailable` / `capability_missing`; backup `/root/backup-ig_rollout_and_leased_jobs-20261105T181417Z.sql`. The next drain claimed nothing.

## 2. Goal

A claimed owner job with no bound context, whose account has no capability row, is settled `unavailable` / `capability_missing` on its first claim and never re-leased. The daily service enqueue does not create a job for such an account at all, and says how many it skipped. The report then maps `capability_missing` to `scope_missing` ("Required Instagram Insights permissions are missing. Reconnecting your account may resolve this.") through the existing `reportStore.ts` mapping, so no UI change is needed.

## 3. Non-goals

- Backfilling capability rows for the 21 accounts (they enrol by reconnecting through the OAuth lifecycle, which writes the row with `generation_reason = oauth_lifecycle_commit`).
- Changing the rollout policy modes, the claim fence, the competitor path, or the owner's own enqueue (already handled by 20261104150000).
- The competitor drain's empty-queue warning noise (journey §3.2); separate change.

## 4. Design

### 4.1 Migration `20261105200000_instagram_context_missing_settlement.sql`

**(a) `complete_instagram_collection_job_capability_unavailable(p_job_id, p_claim_token, p_job_generation)`** — `CREATE OR REPLACE`, byte-identical to `20261104120000_instagram_capability_unavailable_settlement.sql` except that the `IG_COLLECTION_CONTEXT_MISSING` refusal becomes a branch:

- The job is loaded through the same fence (`ig_collection_load_fenced_job(..., false, NULL)`).
- If the context is NULL (any of the three columns) **and** `v_job.target_kind = 'owner'` **and** no `instagram_account_capabilities` row exists for `v_job.social_account_id`: the job is settled by the same UPDATE as the existing success branch (`status='unavailable'`, `retry_at=NULL`, lease cleared, `last_reason_code='capability_missing'`, `updated_at=now()`), after `ig_collection_assert_lease_live`, and the same JSON is returned.
- If the context is NULL for any other reason (a competitor job, or an owner whose account *has* a capability row — the claim would have bound it, so this is a stale claim): refuse with `IG_COLLECTION_CONTEXT_MISSING` exactly as today.
- Every other branch (viewer inactive / needs reauth / credential changed / capability resolved / the bound-context settlement) is unchanged. Grants, `SECURITY DEFINER`, `search_path`, and the `_http` wrapper are unchanged.

**(b) `enqueue_instagram_collection_daily_page(...)`** — `CREATE OR REPLACE`, byte-identical to `20261031091000_instagram_collection_daily_dispatch.sql` except in the owner candidate query: the inner SELECT over `public.social_accounts AS sa` gains

```sql
AND EXISTS (SELECT 1 FROM public.instagram_account_capabilities AS c
             WHERE c.social_account_id = sa.id)
```

placed with the other `sa` predicates (before the anti-join on existing jobs). Filtering in the WHERE keeps the keyset scan bounded: the page still reads at most `v_page_limit` ids strictly after the cursor in id order, and a skipped account simply never becomes a candidate (it is not a refused candidate that consumes a slot, because the evaluator never sees it). The function additionally returns `'skipped_reconnect_required'`: the count of active Instagram accounts after the cursor, within the same page window, that have no capability row — computed by one bounded COUNT with the same predicates minus the EXISTS and with `NOT EXISTS` instead, so operators can see the enrolment gap in the receipt. The competitor branch is unchanged.

### 4.2 Worker (`instagram-insights-sync/worker.ts`)

`readJobContext`: when `verifyBoundContext(job)` is false, instead of `abandon(context, "context_missing")` the step calls the existing `settleCapabilityMissing(context)`. That helper already asks the store's `settleCapabilityUnavailable` once, logs `owner_capture` with outcome `unavailable` / `capability_missing` on success, and on a database refusal logs `owner_capability_settlement_refused` and abandons — so a context-less job whose settlement the database refuses (4.1a's "any other reason") behaves exactly as today. The `OwnerReasonCode` `context_missing` stays for that refusal log and the type; no new reason code.

### 4.3 Report / UI

No change. `instagram-insights-report/reportStore.ts` maps `capability_missing` → `scope_missing`, and `formatReasonExplanation("scope_missing")` already says reconnecting may resolve it.

## 5. Security

No new RPC or grant. The settlement keeps `ig_collection_assert_service_caller()`, the fence, and the lease check; the new branch settles only an owner job whose account provably has no capability row, which is the single condition the claim could not bind. The enqueue change only narrows the candidate set.

## 6. Tests

- SQL, appended to `supabase/tests/instagram_owner_enqueue_reconnect_required.sql` (same fixture style: synthetic user, two Instagram accounts, one with a capability row written through `write_instagram_account_capability` or a direct insert as the existing suites do): (1) `enqueue_instagram_collection_daily_page('owner', …)` enqueues the account with a capability row, skips the one without, returns `skipped_reconnect_required = 1`, and the skipped account has no job; (2) a context-less owner job claimed through the real claim path is settled by `complete_instagram_collection_job_capability_unavailable` as `unavailable` / `capability_missing` with the lease cleared; (3) the same call for a context-less job whose account *has* a capability row is still refused with `IG_COLLECTION_CONTEXT_MISSING`.
- Deno, `instagram-insights-sync/worker.test.ts`: the existing "a job without a bound context does not stall the next owner" test now expects `summary.unavailable === 1`, `jobs[0].outcome === "unavailable"`, `reasonCode === "capability_missing"`, and one `settleCapabilityUnavailable` call; a second test makes the fake store refuse the settlement and expects `abandoned` / `context_missing` with the refusal logged.
- Existing suites stay green: `instagram_collection_daily_dispatch.sql`, `instagram_capabilities.sql`, `instagram_durable_collection_jobs.sql`, the `instagram-insights-sync` Deno tests.

## 7. Deploy and verification

Migration applied on prod before merge after an owner card (0600 backup of both function definitions via `pg_get_functiondef`); `instagram-insights-sync` syncs from `main`. Verification: with the rollout policy widened back to `owners: all` (owner decision), the 00:30 UTC daily enqueue reports `skipped_reconnect_required = 21` and creates no job for those accounts; no `owner_job_abandoned` with `context_missing` appears in the edge log; the Instagram page for a non-enrolled account shows the reconnect wording.
