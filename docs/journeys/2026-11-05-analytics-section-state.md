# Analytics section: live state after the 2026-11-05 root fixes

Recorded 2026-11-05 17:30–18:45 UTC from the logged-in production web app (`https://postora.cloud`, owner session) and read-only queries on the production database. No post was retried, no job was edited, no setting was changed while recording.

## 1. What landed today

| Change | PR | Merge | Prod |
|---|---|---|---|
| Owned-analytics completion judged by the account's cells; worker releases a refused completion | [#385](https://github.com/lolotam/POSTORA/pull/385) | `675ff3cf` | migration `20261105160000` applied 16:36 UTC; `meta-owned-analytics-sync` files match `main` since 17:39 UTC |
| Carousel children waited for; Instagram carousels deferred and resumed like reels | [#386](https://github.com/lolotam/POSTORA/pull/386) | `f0f491ad` | `process-post` files match `main` since 17:34 UTC |

The Facebook drain that had wedged on job `093295db` (due 2026-11-05) reached `success` on the 16:40 UTC drain under the new rule; receipts since then are `complete` (nothing further due today). The worker's refusal path and the carousel deferral path have not yet run live: the first overlapping job pair is enqueued after 00:30 UTC on 2026-11-06, and no carousel has been published since the merge.

## 2. Pages, as rendered

| Page | Account | What it shows | Reading |
|---|---|---|---|
| `/analytics/instagram` (Performance) | flexitolkw | 958 followers, reach 50, views 9, interactions 2, "Partial: 27 of 30 days"; one FEED post of Nov 5 (`18137554891631463`, "Too early (<48h)"); alert "Instagram temporary service issue. Next attempt is scheduled." | Data present; the alert is the symptom of §3.1 |
| `/analytics/instagram?tab=competitors` | — | one tracked competitor, `@curemedkw`; report: 18,667 followers, snapshot history and post counts | Working |
| `/analytics/facebook` (Connected account performance) | Xsellpoint page, 7 closed days | "Partial data", last collection 2026-11-05 08:05 UTC; views 0 and engagements 0 "Partial: 3/7 days", followers 8; reach, unique viewers, profile views "Not available" | Collection started 2026-11-03, so three of seven days exist; the "Not available" metrics have no stored cell for this page yet (`fb_analytics_metric_values` holds `views`, `unique_viewers`, `engagements`, `followers` for 3 days, all `available`) |
| `/analytics/threads?tab=insights` | xsellpoint_kw, 7 closed days | "Partial data"; profile views 4 "Partial: 3/7 days"; views, reach, engagements, likes, replies "Not available" | By design: the Threads collector stores `profile_views` as the only daily account metric (completion rule requires only that key per day); views/likes/replies/reposts/quotes are per-post metrics |
| `/analytics/threads` (default) | — | opens the Discovery tab ("Start by searching for a brand") | Default tab is discovery, not the owned insights |

## 3. Findings

### 3.1 Instagram owner collection loops for accounts without a recorded capability (defect)

- `instagram-insights-drain` (cron 50, every 2 minutes) claims 29 owner jobs each tick and abandons every one with `reasonCode: "context_missing"` (edge function log, `owner_job_abandoned`, `durationMs: 0`). The jobs stay `leased`, their `attempts` climb (573 for the oldest, captured_on 2026-11-04), they have no operations and no checkpoints, and `last_reason_code` stays null.
- Cause: `ig_collection_try_claim_job` binds the job's context (`context_login_kind`, `context_credential_generation`) from `instagram_account_capabilities`; those 29 accounts have **no capability row**. The only row (`xsellpoint_kw`, `page_linked`, `generation_reason = oauth_lifecycle_commit`) was written today by the owner's reconnect, and that account's two jobs are the only `completed` ones.
- Population: 22 active, non-reauth Instagram accounts; 1 with a capability row, 21 without. The rollout policy `collection_instagram_rollout_policy` is `owners: { mode: "all" }`, so every owned target is enqueued daily regardless.
- Effect: 720 wasted claim cycles per day, misleading page copy ("temporary service issue"), and no Instagram owner analytics for 21 accounts until each is reconnected through the new OAuth lifecycle.
- Not changed in this record. Options are listed in §4.

### 3.2 Competitor drain logs an empty queue as a warning (noise)

`competitor-snapshot-sync` writes a `warn` row "Instagram collection rollout refusal" with `reason_code: collection_queue_empty` on every 2-minute tick when nothing is due: 1,082 rows since 2026-11-04 10:38 UTC. Nothing is refused; the level and message are wrong for an empty queue.

### 3.3 Provider and policy state (read-only)

| Setting / schedule | Value |
|---|---|
| `apify_enabled` | `false` (paid Apify off) |
| `collection_facebook_analytics_enabled` / `_threads_` | `true`, explicit `account_ids` allowlists |
| `collection_instagram_insights_enabled` | `true`; rollout policy `owners: all`, `competitors: all` |
| `competitor_retention_enabled`, `retention_facebook_analytics_enabled`, `retention_threads_analytics_enabled` | `false`; cron 47 / 55 / 58 inactive |
| Active crons | 49 instagram-insights-enqueue-daily, 50 instagram-insights-drain, 51/52 competitor enqueue/drain, 53/54 facebook enqueue/drain, 56/57 threads enqueue/drain, 18 send-weekly-analytics |
| Jobs (due ≥ 2026-11-02) | Facebook: 1 success, 1 failed (`completion_rule_overlap`, the manually released 2026-11-04 job); Threads: 24 success; Instagram: 2 completed, 29 leased (§3.1), 1 retry (`provider_error`) |
| Stored rows, last 7 days | ig_account_insight_daily 7, ig_media_insight_snapshots 41, fb_page_insight_daily 3, threads_account_insight_daily 36, competitor_profile_snapshots 2, competitor_media_snapshots 60 |

## 4. Open items

Owner actions: the #384 reconnect journeys; the 13-Threads notification; deleting Instagram trial post `18137554891631463`; publishing a 3-image carousel on Threads and the Instagram pilot to exercise the new carousel path; checking the drain receipts after 00:30 UTC on 2026-11-06.

Decision needed for §3.1 (any combination): narrow the Instagram owner rollout policy to the accounts that have a capability row until others reconnect; make the enqueue skip accounts without a capability row and settle a context-less job terminally instead of re-leasing it; a bulk reconnect of the 21 accounts. The 29 leased jobs need releasing once a decision is taken.
