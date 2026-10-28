# Specification — Bounded Owner Instagram Collection Worker (Slice O2)

Status: Draft / Contract Specification
Parent Plan: `docs/plans/2026-10-26-instagram-insights-and-competitor-tracking.md` (Tasks 4 and 6)
Milestone: Milestone 2 — Step 6 (Owner Analytics Flow)

---

## 1. Context and Objective

Slice O1 provided the authenticated user intake endpoint (`action: "enqueue"` and `action: "status"`).
Slice O2 implements the **bounded service-side owner collection worker**.
The worker consumes claimed collection jobs from the durable job queue, retrieves operational metrics from Meta Graph API (v22.0), persists daily snapshots, and advances job lifecycle states to completion or retry.

All collection remains strictly bounded:
- Maximum 25 owner targets per drain cycle.
- 40-second wall-clock execution budget with a 120-second database lease lease fence.
- Complete idempotency and crash safety across restarts.
- Strict isolation of secrets: tokens and raw provider responses are never leaked into audit logs or unredacted errors.

---

## 2. Database RPC Contracts

The worker interacts with the database exclusively through the pre-accepted durable collection RPCs in `supabase/migrations/20261026150000_instagram_durable_collection_jobs.sql`:

1. **`claim_instagram_collection_jobs(p_target_kind, p_limit)`**:
   - `p_target_kind`: `'owner'`
   - `p_limit`: up to 25
   - Caller: `service_role`
   - Leases pending/retryable jobs for 120 seconds and returns leased rows including `job_id`, `target_id` (social_account_id), `user_id`, `captured_on`, `claim_token`, `context`, and `checkpoint`.

2. **`persist_instagram_collection_snapshot(p_job_id, p_claim_token, p_snapshot)`**:
   - Validates active lease token.
   - Atomically writes daily metrics to `instagram_account_daily_metrics` and `instagram_media_daily_metrics`.
   - Records operation progress and updates checkpoints.

3. **`complete_instagram_collection_job(p_job_id, p_claim_token, p_status, p_reason_code, p_error_message, p_inventory)`**:
   - Status: `'completed'`, `'partial'`, or `'failed'`.
   - Releases the lease and sets final status or calculates backoff interval for retries.

4. **`record_instagram_provider_throttle(p_bucket_name, p_retry_after)`**:
   - Records global/account throttle windows when Graph API returns HTTP 429 or code 4/17/32 rate limits.

---

## 3. Provider Contracts (Meta Graph API v22.0)

### 3.1 Account-Level Daily Metrics
- Target: `/{ig-user-id}/insights`
- Metrics:
  - `impressions`: daily sum
  - `reach`: daily unique
  - `profile_views`: daily sum
  - `accounts_engaged`: daily sum
- Lookback window: Yesterday (Asia/Kuwait) plus 48h repair window for latency adjustment.
- Fallback for accounts with fewer than 100 followers: explicit null with `insufficient_followers` reason code.

### 3.2 Media-Level Metrics
- Target: `/{ig-user-id}/media?fields=id,caption,media_type,media_product_type,timestamp,permalink,thumbnail_url,like_count,comments_count`
- Inventory window: up to 200 items in newest-first order within 90 days.
- Insight metrics:
  - `reach`: unique viewers
  - `impressions`: total impressions
  - `saved`: total bookmarks
  - `engagement`: total interactions
  - `video_views`: for video/reels
- Unsupported metrics per media type are safely omitted without failing the entire collection job.

---

## 4. Execution Budget and Graceful Shutdown

- Total drain tick timeout: 40 seconds.
- Per-account provider timeout: 8 seconds.
- Reserve for database snapshot and completion writes: 5 seconds.
- If the remaining budget drops below 5 seconds, remaining unstarted jobs in the batch are skipped, allowing their leases to safely expire or be reclaimed in the subsequent drain tick.
