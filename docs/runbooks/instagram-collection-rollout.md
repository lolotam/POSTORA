# Instagram collection rollout runbook

Date: 2026-10-30. Candidate: branch `feat/collection-rollout-controls`, base
`ea846bdaaaff1c8ba4b1ff16aad15aa60ea78155` (C1), plus the Task 6 evidence
files listed in [§9](#9-what-this-runbook-does-not-authorize).

> **This runbook authorizes NOTHING.** Every production step below is listed
> so it can be reviewed, not so it can be run. Gates **B**, **C**, **D** and
> **E** of the [Task 11 release-gates spec](../specs/2026-10-30-instagram-release-gates.md#6-activation-gates-be--approval-required-at-every-step)
> each need **Waleed's own separate approval**, recorded in that document's
> ledger. Nothing in this file, in the plan, in the spec or in the test
> suites substitutes for that approval, and a green local suite is not an
> approval.

The operational procedure for copying a runtime to the server, the SHA256
comparison, the container restart and the boot probe live in
[deploy-edge-function.md](deploy-edge-function.md). This runbook does **not**
repeat the host paths, the stack commands or any secret handling; it states
*what* must be deployed and *what must be true* afterwards.

---

## 1. The order: SQL before runtime

The runtime is useless without the schema, and the schema is useless without
the runtime. Only one order is safe, because the Edge functions are served
from a volume that the reconciler refreshes on its own schedule and never
waits for a migration.

| Order | Migration | Owns | State on this branch |
|---|---|---|---|
| 1 | `20261031090000_instagram_collection_rollout_controls.sql` | R1 — the default-off policy, the canonical evaluator, the SQL admission in the enqueue/claim/attach/write fences, `authorize_instagram_collection_provider_call`, the refusal audit | implemented, rehearsed |
| 2 | `20261031091000_instagram_collection_daily_dispatch.sql` | R2 — `instagram_collection_enqueue_sweeps`, `enqueue_instagram_collection_daily_page`, its ACL | implemented, rehearsed |
| 3 | `20261031092000_instagram_collection_cron.sql` | C1 — the four collection schedules, installed **inactive** | implemented, rehearsed |

**R1 → R2 → C1, and the runtime after C1.** The runtime calls
`authorize_instagram_collection_provider_call` (R1) and
`enqueue_instagram_collection_daily_page` (R2); both are service-only
routines. A runtime deployed before its migration boots and then fails on the
first request, which is exactly the failure the "migration first" rule
exists to prevent.

C1 creates no job that could reach the runtime before it is deployed, because
all four jobs are installed **inactive**. That is the reason the schedule may
be applied before the runtime — not a reason to apply it early.

**R1, R2 and C1 were applied to production on 2026-10-31**, in that order,
as `supabase_admin`, with Waleed's approval, before PR #317 merged. The
files were read from the pushed branch (`25b1ea83`) and their SHA-256
matched the reviewed copies. A full dump was taken first
(`/root/backups/pre-rollout-controls-20261031.dump`). The state recorded
right after the application:

- `collection_instagram_rollout_policy` holds the default: owners `off`,
  competitors `off`;
- `collection_instagram_insights_enabled` does not exist, which the
  evaluator reads as `collection_disabled`;
- the four schedules of §3.3 exist and are all **inactive**;
- `authorize_instagram_collection_provider_call` and
  `enqueue_instagram_collection_daily_page` are executable by
  `service_role` only (not `anon`, not `authenticated`).

The application changed no activation state. Task 11 gate **B1** still owns
the reconciliation of the full applied ledger; production keeps no
migration-history table, so "applied" is proven from the objects above.

### 1.1 The manual-racing prerequisite

The SQL suite proves the admission in one session. The interleavings need
two. Before any production application, rehearse the two race fixtures
against the same candidate and keep both sessions' output:

```bash
# inside the disposable container, against the harness database
psql "$DB_URL" -v ON_ERROR_STOP=1 -v disposable=1 -v prepare=1 \
  -f supabase/tests/instagram_collection_rollout_race_fixture.sql
# session A: hold the exclusion open; session B: probe; then assert and clean up
```

The fixture headers document the exact sessions, the wait observations and
the cleanup. See [supabase/tests/README.md](../../supabase/tests/README.md).

---

## 2. The runtime import closure

The functions are served as **source**, not as a bundle, so the deployed unit
is the entrypoint **plus its whole recursive local import closure**. Deploying
an entrypoint whose siblings are missing produces a function that answers 5xx
on its own path while the rest of the stack stays healthy.

The lists below are the closure of the two collection composition roots as
they stand on this branch. The SHA256 values are computed from the **working
tree** of the candidate; the candidate SHA is recorded in
[§9](#9-what-this-runbook-does-not-authorize). A deployed file whose hash
differs from the table is a different runtime, and a different runtime is a
different rollback candidate.

### 2.1 `instagram-insights-sync` (16 files)

| SHA256 (working tree) | File |
|---|---|
| `f9a04a1da03137c4ccebd2caf28ec1c88ef7bd7a0c6af1d04aedddcf95a18daa` | `supabase/functions/_shared/cors.ts` |
| `40ed4c7208573b318b38ff003b344e42b046f0533ceefc390ac3c788f78fb88a` | `supabase/functions/_shared/facebookCredentialMode.ts` |
| `94226018c233d9512999f2e3cd638f5301ff190596847b440506fd9146c6e1ed` | `supabase/functions/_shared/facebookUserCredentialStore.ts` |
| `2600ac74034c91a02d4bc3df9021a8cbba4e4dbc5f6c0a78ed7286e384e4e166` | `supabase/functions/_shared/logging.ts` |
| `dcda9f84653d0c440e39d07ade76445912a2f99051254daefa5c2118a7dd6c53` | `supabase/functions/_shared/validate.ts` |
| `93344e1fbae8ceef08e713f34cecc3a9ed545c81abee0088b6337a90ca5eb8cd` | `supabase/functions/instagram-insights-sync/dailyEnqueue.ts` |
| `92d1bb5ba15b2f7bb271febaa20b7439e73c9c92ed2738578445df06e2f47951` | `supabase/functions/instagram-insights-sync/dailyEnqueueStore.ts` |
| `959e7c150c2005f0a6d74d7db1f94d17e233181e7530679fa822f6071aaa2e95` | `supabase/functions/instagram-insights-sync/directGraphProvider.ts` |
| `02abef3f69875231d07bbd2f6277f1ff61920d7a7b79a4ed8deed18d7dae5b7c` | `supabase/functions/instagram-insights-sync/graphProvider.ts` |
| `58aa6442c38cab1a660248f0d327d4a4bba38569aedcbb9e5ce634bfdfde5101` | `supabase/functions/instagram-insights-sync/handler.ts` |
| `391407b3347e55f5e3e06fd9c3412b944e75f3fa2070ea1432108a3997a0df1f` | `supabase/functions/instagram-insights-sync/index.ts` |
| `e584713817851173c8b75b6ed37e4535fff196b16a95a1d61e8a851c0405acaf` | `supabase/functions/instagram-insights-sync/providerTransport.ts` |
| `085389b4da715e04a036ae366132ef70156d9fcb57b60c68901d1237530baf67` | `supabase/functions/instagram-insights-sync/receipts.ts` |
| `60414e4f8f744ea3e4a17ea6bbbf2020d064658ca778afd2a160660767e3ac05` | `supabase/functions/instagram-insights-sync/store.ts` |
| `49a28e7ce08c617d77b9f7f1579b2dcbac8589ce73acd11cf499126ceb8015b9` | `supabase/functions/instagram-insights-sync/worker.ts` |
| `87f219b80b58eaaad28349808ecb02d8db9f30c0582b5c5c45c7578e885c6327` | `supabase/functions/instagram-insights-sync/workerStore.ts` |

### 2.2 `competitor-snapshot-sync` (15 files)

| SHA256 (working tree) | File |
|---|---|
| `f9a04a1da03137c4ccebd2caf28ec1c88ef7bd7a0c6af1d04aedddcf95a18daa` | `supabase/functions/_shared/cors.ts` |
| `40ed4c7208573b318b38ff003b344e42b046f0533ceefc390ac3c788f78fb88a` | `supabase/functions/_shared/facebookCredentialMode.ts` |
| `94226018c233d9512999f2e3cd638f5301ff190596847b440506fd9146c6e1ed` | `supabase/functions/_shared/facebookUserCredentialStore.ts` |
| `95fc1f8f90b3965dbe647b9e4109aa5c5339b575efbd1227136241bd0c2941ba` | `supabase/functions/_shared/instagramDiscoveryViewer.ts` |
| `2600ac74034c91a02d4bc3df9021a8cbba4e4dbc5f6c0a78ed7286e384e4e166` | `supabase/functions/_shared/logging.ts` |
| `3c356d11464c8a8d47ca08f1e66a39a691859447f8d72102f73c2308f2c876bd` | `supabase/functions/_shared/messengerCredentials.ts` |
| `dcda9f84653d0c440e39d07ade76445912a2f99051254daefa5c2118a7dd6c53` | `supabase/functions/_shared/validate.ts` |
| `b303069da88e6d34c30dd7ed207261fdbd307941b01467aa7ee63abc621a612a` | `supabase/functions/competitor-snapshot-sync/apifyProvider.ts` |
| `3561fd506ab3c933318b6e74fdccc4a6102b954dbf0460fae9fb70a1d8fe1444` | `supabase/functions/competitor-snapshot-sync/graphProvider.ts` |
| `8b932d383d33c7b56ec7c4e6b2171820feb674668870ac1aacf362e9cc1f5488` | `supabase/functions/competitor-snapshot-sync/handler.ts` |
| `d8c52c2082795decd22ed23ad92bc510626f2553c5f1de1032eda39ae6443b1a` | `supabase/functions/competitor-snapshot-sync/index.ts` |
| `b37875241536e20c8072faf1420008c0d36d4cbb7881d600cd7ce618d25a2588` | `supabase/functions/competitor-snapshot-sync/receipts.ts` |
| `4a2508f52275b55447ab046939feb2ff7776ac6e848945e6919cabd3d85ec15b` | `supabase/functions/competitor-snapshot-sync/store.ts` |
| `604c9773e6e7bccb21df1c7943a29c5eeaf544258ed42c00799064ed62df3c20` | `supabase/functions/competitor-snapshot-sync/syncWorker.ts` |
| `da12bec121943c3e8347a1014f0878abfb089aa76c276b1a8a79cd1b30378f95` | `supabase/functions/competitor-snapshot-sync/types.ts` |

**These hashes are a candidate note, not a release manifest.** They describe
the working tree of this branch at the time of writing. A release manifest
freezes the **candidate commit** and re-computes every hash from it; a
changed hash between this table and the candidate is a reason to stop and
re-read this runbook, not to deploy.

`workerTestSupport.ts` is test-only and is **not** part of any closure.
Neither is `supabase/functions/_shared/rolloutIntegrationTestSupport.ts`,
which exists only for the integration suites of §8.

---

## 3. The off state

The collection is off in three independent places. All three must be true
before the runtime is deployed, and all three must still be true when the
runtime boots. A single "off" is not an off state.

### 3.1 The master switch

`collection_instagram_insights_enabled` is the master kill switch. It is
**off by absence**: a missing row means off, and `false` means off. The
runtime reads it **first and alone**, before any job schema, RPC, credential
or provider access, so an off master never touches the new schema.

```sql
SELECT key, value FROM public.app_settings
 WHERE key = 'collection_instagram_insights_enabled';
-- expected: no row, or value = false
```

### 3.2 The rollout policy

`collection_instagram_rollout_policy` is the per-population admission. The
migration seeds the default only when the row is absent, and never
overwrites an operator's value. The off state is:

```json
{ "version": 1,
  "owners": { "mode": "off", "account_ids": [] },
  "competitors": { "mode": "off", "targets": [] } }
```

A **missing** policy row means off as well — it is not an error. A
**malformed** policy is `settings_unavailable`, which is a different refusal:
the runtime stops and never treats it as off.

### 3.3 The four schedules

C1 installs exactly four jobs and leaves every one of them **inactive**.
`active = false` in `cron.job` is the check:

```sql
SELECT jobname, schedule, active FROM cron.job
 WHERE jobname IN (
   'instagram-insights-enqueue-daily',
   'instagram-insights-drain',
   'competitor-snapshot-enqueue-daily',
   'competitor-snapshot-drain')
 ORDER BY jobname;
-- expected: exactly four rows, every active = false
```

Re-applying C1 **pauses** a job an operator activated by hand. That is
deliberate: the definition never leaves one of its own jobs running.

### 3.4 The off-state checks to record

| # | Check | Expected | Where it is proved |
|---|---|---|---|
| 1 | master switch | absent or `false` | `supabase/tests/instagram_collection_rollout_controls.sql` (R1) |
| 2 | policy | the documented off document, or the row absent | the same suite |
| 3 | four cron jobs | exactly four, all `active = false` | `supabase/tests/instagram_collection_cron.sql` (C1) |
| 4 | the runtime boots | `OPTIONS` on both routes answers the CORS preflight | [deploy-edge-function.md](deploy-edge-function.md) §3 |
| 5 | an authenticated drain is refused while off | `503 collection_disabled` | the handler's gate, before any schema access |
| 6 | the credential mode | unchanged (`legacy`) | the suite asserts the mode row is byte-identical |
| 7 | no provider call | zero requests for every identity | [§5](#5-the-zero-call-matrix) |
| 8 | unrelated schedules | untouched | the C1 suite compares every other `cron.job` row before and after |

---

## 4. The schedule catalog

Four jobs, no fifth. The durable continuation is the **drain's own bounded
resume**, not another schedule, and nothing depends on reading a cursor out
of a cron response.

| Job name | UTC cadence | Route | Body | HTTP bound |
|---|---|---|---|---|
| `instagram-insights-enqueue-daily` | `30 0 * * *` | `instagram-insights-sync` | `{"action":"enqueue-daily"}` | `net.http_post` ≤ 60 s |
| `instagram-insights-drain` | `*/2 * * * *` (recommended, not approved) | `instagram-insights-sync` | `{"action":"drain"}` | `net.http_post` ≤ 60 s |
| `competitor-snapshot-enqueue-daily` | `0 1 * * *` | `competitor-snapshot-sync` | `{"mode":"enqueue-daily","dispatch":"durable"}` | `net.http_post` ≤ 60 s |
| `competitor-snapshot-drain` | `*/2 * * * *` (recommended, not approved) | `competitor-snapshot-sync` | `{"mode":"all"}` | `net.http_post` ≤ 60 s |

Every body matches the registered route's **strict** schema exactly. The
competitor's daily body is the **durable** branch; the legacy cursor branch
(`mode:"enqueue-daily"` with a cursor or a limit) stays available for its
existing caller and no schedule uses it.

The two-minute drain interval is a **recommendation awaiting capacity
evidence**, not an approved cadence. Task 11 gate **E2** is where it is
approved.

Each stored command resolves the shared secret at **run time** through
`public.get_cron_secret()`; the stored command is a template, not a
credential, and rotating the secret needs no re-application.

---

## 5. The zero-call matrix

The exclusion is proved by **counts per identity**, never by a total. A
total cannot distinguish "one account called twice" from "two accounts
called once".

### 5.1 The owner population

| Policy stage | Admitted | `A` (allowlisted) | `B` (same owner) | `C` (shared grant) | `D` (foreign) |
|---|---|---|---|---|---|
| owners `off` | — | 0 | 0 | 0 | 0 |
| owners `allowlist = [A]` | `A` | > 0 | **0** | **0** | **0** |
| owners `all` | every owned target | > 0 | > 0 | > 0 | > 0 |

`C` shares the **same protected credential** as `A` and is still excluded:
the exclusion is a policy decision about the target, not about the secret.

### 5.2 The competitor population

| Policy stage | Admitted | the pinned pair | the same owner's other watchlist | the other tenant's watchlist | the unapproved alternate viewer |
|---|---|---|---|---|---|
| competitors `off` | — | 0 | 0 | 0 | 0 |
| competitors `allowlist = [{watchlist, viewer}]` | that pair only | > 0 | **0** | **0** | **0** |
| competitors `all` | every owned watchlist | > 0 | > 0 | > 0 | n/a |

In allowlist mode the request carries the **pinned** viewer's identity and
its credential. A substitute viewer is never used, and the failure of the
pinned viewer is never retried with another one.

### 5.3 What the counts are read from

| Population | Persisted evidence |
|---|---|
| owner | `public.ig_account_insight_daily`, `public.ig_account_profile_observations` |
| competitor | `public.competitor_profile_snapshots` |

A call is also checked for the credential it carried: the request must carry
the **protected** token, never the browser-readable `social_accounts.access_token`
column. The suites seed both and assert the browser-readable value never
appears in a request.

---

## 6. Bounded continuation and expiry

The work is bounded on both axes, and both bounds are observable.

| Bound | Value | Where it lives | What expires |
|---|---|---|---|
| The run budget | 40 s | `WORKER_TOTAL_BUDGET_MS` | the whole drain; the write reserve (5 s) is kept back |
| The provider ceiling | 8 s per attempt | `WORKER_PROVIDER_CEILING_MS` | one attempt, headers **and** body |
| A media attempt | 4 s | `MEDIA_INSIGHT_ATTEMPT_TIMEOUT_MS` | one media request, never retried |
| The claim limit | 25 owner / 50 competitor | `OWNER_CLAIM_LIMIT`, `COMPETITOR_CLAIM_LIMIT` | one claim pass |
| The enqueue page | 25 owners / 50 competitors | `OWNER_DAILY_PAGE_LIMIT`, the R2 constant | one daily page |
| The job lease | 120 s | the claim's lease interval | a claimed job whose worker died |
| The continuation | 1 day | `CONTINUATION_MAX_AGE_DAYS` | a job that outlives its capture day |
| The media sweep | 2 pages per attempt, 500 queued | `MEDIA_PAGES_PER_ATTEMPT`, `MEDIA_QUEUE_LIMIT` | one media sweep |
| The cron request | 60 s | `net.http_post` bound | one scheduled call |

**The continuation is the anti-join, not a cursor.** The R2 sweep selects
eligible due targets *without* a job for the current Kuwait capture day, so
a successfully enqueued target disappears from the next candidate page. There
is no volatile process cursor to lose, and a crash between two pages loses
nothing: the next call reconciles from the persisted sweep row.

**Expiry is truthful.** On the Kuwait day rollover, an unfinished sweep is
recorded **expired** with incomplete evidence. It is never silently marked
completed, and a completed sweep never certifies a target that was excluded
or that became eligible later.

---

## 7. The audit policy

Every refusal is **audited**, and a refusal is never an empty success.

| Refusal | Where the row is written | Reason code |
|---|---|---|
| the claim admitted nothing | the accepted SQL, in the committed transaction | `collection_not_eligible` / `collection_queue_empty` |
| the enqueue refused a target | the accepted SQL, in the committed transaction | `collection_not_eligible` |
| the provider permit refused a call | the accepted SQL, in the committed transaction | the closed permit refusal union |
| the permit could not be read at all | the Edge adapter, in a **separate** bounded call | `permit_read_failed` / `malformed_envelope` / `schema_unavailable` |
| the write after an exclusion | the accepted fence raises; the adapter reports the abandoned job | `storage_error` |
| a policy change | a database trigger on `app_settings` | the canonical fingerprint of the stored document |

Rules that hold for every row:

- A row is only reported as **stored** when it **committed**. A failed audit
  write stops the work and is reported as an audit failure; it is never
  retried as if it had succeeded.
- A refusal that **raised** rolled its audit row back with it. The exception
  path is therefore the adapter's job, and it says whether its own row
  committed.
- A broad scan writes **one bounded aggregate event** per invocation, not
  one row per excluded job.
- No row carries a token, a claim token, a policy list, a header, a
  provider URL, a provider payload or a raw driver message. The reason code
  is from the closed union; the message is dropped.
- The policy fingerprint is **server-computed** from the stored document. A
  caller can never supply a fingerprint or an eligibility boolean.
- The master switch and the policy are read with the account-scoped
  `request.jwt.claim.role` convention, so the grants of the calling role
  are the ones under test.

---

## 8. The evidence this branch produced

### 8.1 The SQL suites

The three new suites are registered in the harness inventory, so CI picks
them up through `scripts/db-harness.sh`:

- `supabase/tests/instagram_collection_rollout_controls.sql` (R1)
- `supabase/tests/instagram_collection_daily_dispatch.sql` (R2)
- `supabase/tests/instagram_collection_cron.sql` (C1)

The two race fixtures are **manual multi-session rehearsals**, not suites;
their headers document the sessions, the waits and the cleanup. Both were
rehearsed on 2026-10-31 against a disposable `supabase/postgres:17.6.1.158`
harness of the merged candidate, before the production application, and met
every PASS line of their headers. Probes against an uncommitted policy,
repin or reconnect returned in under a second, and the same probes were
refused after the commit. The fenced write and the daily page waited on the
account and sweep locks, with the holder named as the blocker, while the
policy writer did not wait. The rollback, resume and rollover probes and
both `assert` paths passed. One ordering note: `attach_new` reports
`IG_COLLECTION_VIEWER_NOT_APPROVED` only on a job with no bound viewer; if
the probe already attached the old viewer during the hold, the refusal after
the repin is `IG_COLLECTION_NOT_ELIGIBLE`.

### 8.2 The integration suites

Two suites drive the **real registered handler** against a **real disposable
Postgres** with a **fake Meta transport** and no public egress:

- `supabase/functions/instagram-insights-sync/rolloutIntegration.test.ts`
- `supabase/functions/competitor-snapshot-sync/rolloutIntegration.test.ts`

They need a disposable Postgres container and a migrated database, and they
**fail** — loudly — when that runtime is missing. They are not a silent
skip and not a zero-test pass. CI runs them in the **Postgres job**, because
that job already owns the disposable container and the migrated database; the
suite needs the same `--allow-run` posture as the neighbouring route suites
(the locked `esbuild` dependency), and the SQL adapter itself only ever
executes `docker`.

```bash
export ROLLOUT_IT_CONTAINER=<container>
export ROLLOUT_IT_DB=<migrated database>
deno test --node-modules-dir=none --allow-read --allow-write --allow-env --allow-run \
  supabase/functions/instagram-insights-sync/rolloutIntegration.test.ts
deno test --node-modules-dir=none --allow-read --allow-write --allow-env --allow-run \
  supabase/functions/competitor-snapshot-sync/rolloutIntegration.test.ts
```

Run them as **two commands**. `deno test` runs test *files* in parallel, and
the two suites share one database and one global policy row; each suite
takes a lease in the database before it starts, so a parallel run serialises
instead of interleaving.

What they prove, and what they do not:

- They prove the **production TypeScript** consumes the SQL decisions and
  never makes its own: the exclusion, the refusal and the write fence are
  the accepted functions' behaviour, observed through the real handler.
- They do **not** prove anything about live Meta. The provider transport is a
  fake, and no request left the machine.
- Each suite contains a **negative control**: it copies the production
  source to a temporary directory, removes the permit call **in the copy**,
  runs the same scenario against the copy and asserts that the suite's own
  detector FAILS. The committed source is never modified. A detector that
  cannot fail proves nothing.

### 8.3 What the integration suites found

Nothing. No production defect was found, so no production source was
changed. The suites observed the behaviour the accepted SQL already
implements.

---

## 9. What this runbook does not authorize

- **No activation.** The master switch stays off, the policy stays off and
  the four schedules stay inactive until Waleed approves it under Task 11
  **B**, **C**, **D** or **E**. Each of those gates needs its own approval
  reference, its own candidate, its own timestamp and its own operator.
- **No further production SQL.** R1, R2 and C1 are applied (§1) with all
  four jobs inactive. Any later migration is reconciled under **B1** and
  applied only after its own review and approval.
- **No deployment.** The runtime closure of §2 is a **candidate**, not a
  deployment. Deployment follows [deploy-edge-function.md](deploy-edge-function.md)
  and is approved under **B2**.
- **No credential mode change.** `credential_facebook_user_mode` stays
  `legacy`. The global mode says where a secret lives; it is never
  collection permission.
- **No OAuth pilot list change.** The OAuth user list and the collection
  policy are different things. A user in the OAuth list collects nothing.
- **No retention change.** Retention is Task 8 / gate **E3** and is not
  touched by any of this.
- **No schedule activation.** The two-minute drains are a recommendation;
  **E2** approves the exact cadence.

### 9.1 The rollback target

The rollback target is a **rollout-aware, protected-compatible** runtime: a
runtime that contains the per-request permit check and reads the policy. A
pre-R1 worker lacks the guard and is **not** a pilot-safe rollback
candidate — rolling back to it would remove the very thing that makes the
pilot safe.

The rollback procedure is:

1. Disable the four schedules (`cron.alter_job(... active := false)`).
2. Disable the master switch, or narrow only the affected population.
3. Record the policy document and the time.
4. Check the pending and in-flight work.
5. Let the bounded requests settle and the 120-second leases expire, then
   verify that **no new permit** is granted before calling the rollback
   quiescent.
6. Deploy the last-good rollout-aware runtime through
   [deploy-edge-function.md](deploy-edge-function.md) and verify the boot.

**Never**, during a rollback: reset jobs to success, purge the queue or the
history, reverse the OAuth protection, remove a credential, flip the global
credential mode, or rely on cron inactivity alone. The additive tables, the
snapshots, the success timestamps, the protected bindings and the operational
credentials all stay.

If the accounting of the already-granted permits is uncertain, keep the
master **off** and escalate. Do not claim zero in-flight calls.

Re-enabling requires a **new** scoped approval and a renewed exclusion
proof. The retained pending work is subject to the eligibility that is in
force at that moment, not to the one that queued it.

---

## 10. The evidence handed to Task 11

| RC | Evidence | Where |
|---|---|---|
| RC-01, RC-02 | the policy schema, the grants, the master-first read | `supabase/tests/instagram_collection_rollout_controls.sql` |
| RC-03 | the owner exclusion, per identity | R1 suite + the owner integration suite |
| RC-04 | the competitor pair, per identity | R1 suite + the competitor integration suite |
| RC-05, RC-06 | the credential selection and its fences | the owner integration suite; the existing OAuth/refresh suites |
| RC-07 | the revocation between enqueue, claim, attach and request | R1 suite + the race fixture + both integration suites |
| RC-08 | the monotonic policy transitions | R1 suite + both integration suites |
| RC-09, RC-10 | the daily dispatch | `supabase/tests/instagram_collection_daily_dispatch.sql` + the daily dispatch race fixture |
| RC-11 | the durable branch and the legacy cursor caller | the competitor suites + `supabase/tests/instagram_collection_daily_dispatch.sql` |
| RC-12 | the four inactive schedules | `supabase/tests/instagram_collection_cron.sql` |
| RC-13 | the audit rows | R1 suite + the integration suites |
| RC-14 | the reports stay readable | the existing report suites; unchanged by this work |
| RC-15 | the rollback with a live lease | both integration suites |
| RC-16 | reachability, the manifest, the unresolved approvals | this runbook + the Task 11 ledger |

**Still pending and NOT supplied by this branch:** the live Meta evidence, the
production applied ledger, the deployed hashes, the D2/D3/E1/E2 approvals,
the direct lifecycle/visibility evidence, the metric/retry reconciliation
(Task 6), and the Task 8 report/retention dependencies. A passing controls
suite does not make a whole product journey, and it does not make live Meta
support, accepted.
