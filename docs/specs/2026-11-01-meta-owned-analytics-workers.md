# Owned Meta analytics workers (C3)

Status: implementation contract derived from the C2 candidate and deployed provider adapters. Preparation is authorized by the analytics completion task; migration merge/application, runtime deployment, admission, retention and activation retain the separate decisions in the [completion design §12](2026-11-01-meta-analytics-completion-design.md#12-approvals-owner-decisions). This document does not mark C3 or the overall analytics goal complete.

## Scope and responsible layers

Implement C3 of the [completion plan](../plans/2026-11-01-meta-analytics-completion.md), using the platform-owned queues selected by the [history/job ADR](2026-11-01-meta-analytics-history-job-model.md). Preserve Instagram owner/competitor queues and legacy live endpoints. Capability definitions remain in `_shared/analyticsRegistry.ts`; C3 cannot declare an unverified cell available or turn unavailable values into zero.

Use `supabase/functions/meta-owned-analytics-sync/` for the HTTP boundary, admission, drain, dispatch, retention orchestration and typed RPC adapter. Existing Facebook and Threads provider modules continue to own provider-specific HTTP requests. Extend `_shared/metaAnalyticsTransport.ts` only for a real pre-request authorization callback used by C3. Share the existing calendar and metric decoders rather than maintaining another registry or fake seven-day calendar for one daily capture.

## Proven source gaps

| Gap | Current source | Required correction |
|---|---|---|
| Admission cannot bootstrap through the worker credential reader | `prepare_*_analytics_account` returns authority only; enqueue/claim require a matching verified permission observation; `read_*_analytics_collection_credential` requires a claimed job | A narrowly granted admission credential RPC captures current allowed account authority before provider verification. It never invents grants or repairs credentials. |
| Transport catches arbitrary errors as provider failures | `MetaAnalyticsTransport.request` has a broad catch around provider work | Run the pre-request permit outside that catch. A store timeout or unknown outcome propagates and ends the invocation; recompute the remaining provider deadline afterwards. |
| Daily enumeration may exceed one invocation | Policy allows 100 target IDs, while the shared budget is 50 targets and 40 seconds | Durable policy/due-day-bound sweep progress; never restart at the first IDs on each invocation. Enqueue remains idempotent. |
| Inventory has no response reservation | C2 checkpoint accepts a cumulative cursor/ID set under the job fence, but has no page request ID | Reserve the expected page request under the existing checkpoint before HTTP and commit its validated response once, with replay/content-conflict checks. Do not represent inventory as a numeric metric. |
| Reclaim needs durable operation truth | C2 reserve refuses already successful/unavailable operation keys | A fenced worker-state read returns completed operations and checkpoint state. Skip accepted operations and reserve a new capture only for outstanding work. |
| Listing metadata does not survive a restart | Checkpoint stores post IDs, not full text/timestamps | Fetch an owned post's metadata through the provider adapter before its lifetime capture when not already accepted. Extra bounded HTTP is preferable to a second unbounded provider-payload store. |

The equal-due partial-claim starvation found during this trace is corrected in the C2 candidate, with the failed-before-fix SQL regression and race repeat recorded in its [journey](../journeys/2026-11-01-meta-owned-history-schema.md).

## Internal HTTP contract

Register `meta-owned-analytics-sync`. Use `verifyCronAuth` for cron/service authority, restricted CORS helpers and a strict discriminated request schema. Normal user/admin session JWTs are not an alternative authority for this route. Every refusal or terminal path records one sanitized operational event. Never copy the wildcard CORS headers from the auth helper's failure response.

Accepted bodies:

```json
{"action":"admit","platform":"facebook","accountId":"<uuid>"}
{"action":"admit","platform":"threads","accountId":"<uuid>"}
{"action":"enqueue-daily","platform":"facebook"}
{"action":"drain","platform":"threads"}
{"action":"retention","platform":"all","dryRun":true}
```

For enqueue, drain and retention, `platform` is exactly `facebook`, `threads` or `all`. For admission it is exactly one platform and `accountId` is required. Retention requires an explicit boolean `dryRun`; other actions reject it. Reject unknown keys, body owner IDs, caller limits, due dates, floors, tokens and permission lists. `OPTIONS` performs no work. Only `POST` executes an action. Bound body reads to 8 KiB and the remaining invocation deadline.

Return only action/platform, a truthful status (`complete`, `partial`, `disabled`, `refused` or `unavailable`), sanitized reason and bounded work counts. Never return authority objects, token material, provider bodies, cursors, account text or private measurements. Authentication is 401, invalid input 400, definitive admission/fence refusal 409, and unknown dependency outcome 503. `complete` describes that action's committed receipt, not pilot acceptance.

## Admission and permission renewal

Add service-only `read_fb_analytics_admission_credential(uuid,jsonb)` and `read_threads_analytics_admission_credential(uuid,jsonb)`. The second argument is nullable expected authority, supplied explicitly through HTTP RPC calls. The reader derives the owner from the exact account/platform, invokes the existing preparation under its account/advisory locks and verifies the collection switch and target allow-list. Non-null expected authority must equal the current complete authority. Return the operational token, canonical provider identity, derived owner and captured authority only to the internal caller. Facebook additionally returns the protected bound User token for grant inspection; the Page token remains the metrics and Page-identity credential.

Do not create another credential counter, token vault, refresh attempt or synthetic binding. An absent/expired/broken Facebook binding is a refusal; an unprepared Threads account gets its existing C2 epoch through preparation. Preparation's monotonic credential guard is retained. No admission RPC changes a collection switch, allow-list or schedule.

Admission reads app configuration before accessing account secrets. Missing app debugger credentials refuse without preparing the account. Then:

1. Capture the allowed account and credential authority through the admission reader.
2. Before each HTTP request, repeat that reader with the captured expected authority. Any changed authority, policy, account health or owner refuses before provider HTTP.
3. Verify the grant using the fixed-origin app-authenticated debugger: Graph `v25.0` with Facebook app bearer, Threads `v1.0` with `TH|APP_ID|APP_SECRET`. Check `is_valid`, canonical user identity and valid unique scope strings. Facebook requires a matching `app_id`. An omitted Threads `app_id` is unreported evidence, not a mismatch; a reported value must match. Never infer requested permissions as granted.
4. Verify the operational account identity separately. Facebook's `/me` must be the expected Page; a User ID cannot stand in for it. Threads' `/me` must be its expected user.
5. Commit only validated scopes through the existing `observe_*_analytics_permissions` RPC with the captured authority and actual observation time. The SQL fence repeats after HTTP. A scope change may advance authority; use the returned authority rather than recapturing an unrelated grant.

Required scopes remain the C2 contracts: Facebook `read_insights` and `pages_read_engagement`; Threads `threads_basic` and `threads_manage_insights`. A valid observation missing either scope is persisted as observed, then admission refuses `permission_missing`; it must not enqueue work. Invalid/expired identity or malformed debugger results never produce a verified observation. Provider failures are sanitized and do not overwrite a previous observation as a fabricated empty grant.

Transport failures, provider 5xx responses and undecodable permission replies stop admission without committing a dispatch refusal. Abort/budget failures also stop the invocation. The durable target remains resumable; transient unavailability is not proof that the account lacks permission.

The observation stores only actually granted scopes relevant to this analytics feature. It does not claim to inventory every permission on the provider grant. Accept a bounded provider scope list, validate its names/uniqueness, then intersect it with the feature's required scopes before persistence. Adding unrelated valid permissions must never exceed the observation's 32-scope storage ceiling or invalidate analytics authority; a missing relevant permission remains missing and is never filled from the requested scope list.

Daily dispatch renews observations before enqueue so legitimate credential rotation does not leave jobs permanently unclaimable. The same admission use case is called directly by the explicit admission action and by the policy-controlled dispatcher; there is no separate unfenced token-read path. Collection attempts never renew or revoke provider credentials.

## Budgets, permits and unknown outcomes

One invocation has 40 seconds from before request-body/auth work, 5 seconds per dependency and a final 5-second write/audit reserve. Provider requests also retain the transport's 4-second cap, 1 MiB response limit, fixed origins and no redirect/retry policy. Race dependencies against an abort even when a replacement implementation ignores its signal. Before issuing provider HTTP, reserve enough time for its permit, its request and a result write; recompute remaining time after the permit.

One invocation shares at most 50 visited targets across selected platforms, including refused targets. Retention additionally shares at most 500 physical child deletions; pass only the remaining budget to each existing cleanup RPC, and deduct its actual deletion receipt. A single-platform invocation uses these same bounds. Pin one UTC 365-day cutoff for the whole retention invocation. Do not reset any counter when switching platform.

Unknown store/read/write outcomes end the invocation immediately. A timeout is not a rollback and must not be followed by retry, completion, cursor advancement or a success response. Leave a claimed job to its lease; on its next visit, read durable state before spending another provider call. Definitive MAH refusals are not PostgREST-retryable serialization errors. A known refusal may end one target and permit another only within the shared deadline and budget.

## Dispatch, inventory and collection

Extend the existing model additively in a new migration. A private dispatcher checkpoint is keyed by platform, provider due date and database-authored policy digest, with a monotonic account-ID position and explicit completion. A changed policy begins a different sweep; enqueue's existing business key prevents duplicate generation resets. SQL revalidates current target admission before enqueue/advancement. Expired sweeps do not masquerade as a successful new due date.

A fenced worker-state read returns only the claimed generation's checkpoint, operations and accepted captures. No response combines several REST snapshots. Inventory reserves a request UUID against the expected previous cursor/page count; the response writer validates that reservation, current claim/authority, bounded owned IDs and replay digest. Full-list exhaustion alone sets complete. A missing cursor with a provider next page, a repeated cursor, malformed/foreign IDs, duplicate response content conflicts or the 500-ID cap cannot become an empty/complete inventory. Durable page advancement and ID publication commit together.

### Concrete daily dispatch protocol

`meta_analytics_enqueue_sweeps` is private global enumeration bookkeeping, not another tenant job queue. Its key is `(platform,due_on,policy_digest)`. It stores a positive round, last account UUID, completion flag and at most 100 sanitized per-account outcomes. The existing platform queues continue to own all collection jobs, authority and measurement history. No raw credential or provider payload enters the sweep.

`next_meta_analytics_dispatch_target(platform,start)` selects today's provider-calendar day in SQL, reads the master switch first and returns a disabled receipt without touching policy/sweeps when false. A missing/malformed enabled configuration is unavailable, never disabled or empty. One canonical locked policy decoder supplies both dispatch and the existing collection-allowed boolean; the latter preserves its fail-closed refusal behavior while comparing valid UUIDs in canonical form. Target order is distinct UUID order from that policy, including equivalent uppercase spellings. The digest binds the original validated policy document; a changed digest creates a different sweep.

The invocation passes `start:true` only once per selected platform, then `false` while resuming. An unfinished round retains its position. A completed round may reopen only on a later start; it cannot loop back within one invocation. Reopening renews stale grants or rotated authority even when today's job already exists. A current matching grant observed since today's due instant can enqueue directly without another provider verification; missing/stale grant evidence returns `needs_admission` without advancing the cursor. Normal admission then verifies the real grant before another commit attempt.

For `platform:all`, inspect both resumable states before choosing order. Prefer the lower next-round number, then the least recently served sweep; an unstarted round has no served timestamp. A completed sweep's next-round number is its current round plus one. These hints determine order only: each actual start/commit repeats current SQL policy and cursor validation. A platform with 50 targets must not reopen ahead of an unstarted or older round on the other platform every invocation and exhaust the shared budget forever. A single-platform call needs no cross-platform ranking.

`commit_meta_analytics_dispatch_target(ticket,outcome,reason)` derives ownership from the exact account/platform and enforces current day, digest, round and expected previous position. The ticket never accepts a caller owner. A successful commit atomically invokes the existing non-force enqueue and stores its enumeration outcome/cursor. A definitive account/admission refusal can advance with an allow-listed reason; an unknown dependency outcome never advances speculatively. A concurrently consumed or expired ticket refuses as stale; the next invocation reads durable progress. Existing jobs keep their generation/state and are not reported as newly created measurements. Each repeated target visit counts against the invocation-wide 50-target cap, even when no job is queued.

An enumeration round with recorded refusals is not a successful collection due date. The HTTP receipt reports that round as partial and exposes only bounded visited/queued/refused counts. Seven-day pilot acceptance still requires the platform job's actual successful on-time measurement receipt. Refused targets can be reconsidered in a later completed-round start without changing the policy or resetting an existing job.

Plan the latest completed provider-calendar day and its preceding correction day before collection. Use actual `America/Los_Angeles` day boundaries, including DST; never the job capture day or a fixed 86,400-second subtraction. Resume outstanding operations, not the newest few posts. Bound per-visit provider work and rotate failed items behind unvisited work. Preserve the original due date/deadline through retries; a late repair cannot satisfy an earlier missed deadline.

Facebook daily collection uses verified `page_media_view`, `page_total_media_view_unique`, `page_post_engagements` and daily `page_follows`. Do not fabricate a Facebook point-in-time followers sample. Post captures use `post_media_view` and `post_total_media_view_unique`. Threads collects verified daily profile views, point-in-time `followers_count` and its six verified lifetime post metrics. Calendar-less period totals stay unavailable unless the registry verifies that exact period; do not label a provider lifetime count as a selected-window total. Per-cell failure causes and true zeros pass through the canonical decoder, C2 writer and report read unchanged.

Reserve each metric capture before HTTP; the request's operation key includes kind, subject and window identity. Metadata and accepted cells from one response commit together. The first accepted capture supersedes older responses according to the existing sequence rules. Replays do not manufacture timestamps, increment report revisions or skip the current claim fence. Completion calls the existing SQL truth checks; truncated inventory, expected missing cells, failed/pending operations, unverified capability and permission/credential failures cannot become successful due dates.

After every planned bounded capture is accepted, an irrecoverable inventory bound terminates the job as `failed` with `inventory_truncated`, preserving its saved prefix and permitting later due dates. Unfinished captures remain `partial` with a 60-second retry delay. Other eligible jobs can proceed in the same drain. Rate limits pause only their platform for the invocation; the other platform remains eligible within the shared budget.

## Throttling and retention

Reuse the existing provider usage parser and persisted bucket mechanism only after extracting neutral code with both existing Instagram and new C3 callers wired. Namespaced bucket keys include platform/app/current authority, never raw secrets. Bucket-only `record_instagram_provider_throttle_http` calls may carry null job fields; never pass Facebook/Threads job IDs into an Instagram job RPC. Preserve the longest observed backoff across concurrent responses and due-date rollover. An unknown throttle-write outcome ends the invocation. A later visit reads the shared bucket before HTTP; a provider refusal parks the platform-owned job through its own completion RPC.

Retention selects targets exclusively through the independent approved retention scope. Disabled/disconnected collection targets remain eligible for approved retention under the existing structural ownership/live-lease fence. Dry runs do not delete or advance revisions. Cleanup receipts retain the pinned floor, exact target count and actual physical deletion count. Instagram/competitor retention remains unchanged.

## Inactive schedule contract

After real handlers exist and their bodies are proved, install exactly these six names, all inactive:

| Platform prefix | Suffix | UTC cron | Body action |
|---|---|---|---|
| `facebook-analytics`, `threads-analytics` | `-enqueue-daily` | `5 * * * *` | `enqueue-daily` |
| `facebook-analytics`, `threads-analytics` | `-drain` | `*/5 * * * *` | `drain` |
| `facebook-analytics`, `threads-analytics` | `-retention` | `35 * * * *` | `retention`, `dryRun:false` |

Each body names its one platform. Hourly dispatch resolves the provider-calendar due date server-side and is idempotent across retries/DST. Durable progress is resumed by those invocations, not an extra continuation cron. Commands use the existing fixed Postora API origin, runtime `get_cron_secret()` and 60-second outer HTTP bound. Missing pg_cron/pg_net/secret reader fails installation atomically. Reapplication reconciles only these six names and leaves them inactive, including previously activated instances; other jobs/settings are untouched. Application is separately approved; inactivity is not activation approval.

## Required proof and remaining release gates

- Real PostgreSQL admission ACL/ownership/policy tests, current-authority refusal before and after provider HTTP, missing binding, Page/User token distinction, Threads epoch changes, unchanged secrets/settings/schedules and credential-writer compatibility.
- Actual registered HTTP composition with fake provider network and real disposable SQL: normal and missing scope, malformed/expired debugger token, wrong Page/user/app, policy/credential change between calls, true zero and distinct persisted failure reasons. Do not mock the SQL under test.
- Durable sweep over more than 50 targets; duplicate invokes and policy edits; page reservation replay/conflict/stale claim; restart midway through daily/post work without lost/duplicated measurements; fairness and generation/lease expiry.
- Provider version/window alignment and DST; deadlines before body/permit/provider/read/write/audit; ports ignoring abort; unknown committed write stops all later work; shared 50-target/500-child limits across both platforms.
- Persistent throttle backoff across due dates; isolated bucket-only calls; exact inactive cron bodies, secret rotation, missing prerequisites, reapplication and untouched unrelated cron/settings.

Record executed results separately from intended behavior. C2/C3 schema must be approved/applied and verified before dependent production runtime adoption. Full Instagram G-X is unchanged; no owner-only exception, pilot collection, retention deletion, activation, seven-day stability or wider rollout is accepted by this document.
