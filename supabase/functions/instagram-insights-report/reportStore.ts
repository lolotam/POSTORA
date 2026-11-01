/**
 * Database Reader & Store for Instagram Insights Report (Slice O3).
 *
 * Reads authoritative historical data from:
 * - `social_accounts` (verifying ownership and active status)
 * - `ig_media_insight_snapshots` (media metrics and inventory)
 * - `ig_account_insight_daily` (daily interactions and follow breakdowns)
 * - `ig_account_profile_observations` (followers and media count history)
 * - `read_instagram_collection_job_status` (sync status and coverage)
 *
 * Feeds pure `assembleOwnerReport` to construct the canonical OwnerReport v1 DTO.
 */

import {
  type AccountDailyRow,
  type MediaSnapshotRow,
  type OwnerReportCompletenessInput,
  type OwnerReportCoverage,
  type OwnerReportFreshnessInput,
  type OwnerReportReasonCode,
  type OwnerReportRequest,
  type OwnerReportRowStatus,
  type OwnerReportSyncStatus,
  type ProfileObservationRow,
  type OwnerReport,
  OwnerReportContractError,
} from "./contracts.ts";
import { assembleOwnerReport } from "./assemble.ts";
import { readReportHistory, type HistoryClient } from "./readHistory.ts";

export interface ReportStoreClient extends HistoryClient {
  rpc(fn: string, args: Record<string, unknown>): {
    abortSignal(signal: AbortSignal): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  };
}

export function toMediaSnapshotRow(row: Record<string, unknown>): MediaSnapshotRow {
  return {
    id: String(row.id),
    ownerId: row.user_id ? String(row.user_id) : null,
    socialAccountId: row.social_account_id ? String(row.social_account_id) : null,
    mediaId: String(row.ig_media_id ?? row.mediaId),
    postId: row.post_id ? String(row.post_id) : (row.postId ? String(row.postId) : null),
    publishedAt: String(row.published_at ?? row.publishedAt),
    capturedAt: String(row.captured_at ?? row.capturedAt),
    capturedOn: String(row.captured_on ?? row.capturedOn),
    captureTimezone: String(row.capture_timezone ?? row.captureTimezone ?? "Asia/Kuwait"),
    mediaProductType: row.media_product_type ? String(row.media_product_type) : null,
    mediaType: row.media_type ? String(row.media_type) : null,
    permalink: row.permalink ? String(row.permalink) : null,
    thumbnailUrl: row.thumbnail_url ? String(row.thumbnail_url) : null,
    status: (row.status as OwnerReportRowStatus) ?? "ok",
    views: typeof row.views === "number" ? row.views : (row.views != null ? Number(row.views) : null),
    reach: typeof row.reach === "number" ? row.reach : (row.reach != null ? Number(row.reach) : null),
    likes: typeof row.likes === "number" ? row.likes : (row.likes != null ? Number(row.likes) : null),
    comments: typeof row.comments === "number" ? row.comments : (row.comments != null ? Number(row.comments) : null),
    saved: typeof row.saved === "number" ? row.saved : (row.saved != null ? Number(row.saved) : null),
    shares: typeof row.shares === "number" ? row.shares : (row.shares != null ? Number(row.shares) : null),
    totalInteractions:
      typeof row.total_interactions === "number"
        ? row.total_interactions
        : (row.total_interactions != null ? Number(row.total_interactions) : null),
    follows: typeof row.follows === "number" ? row.follows : (row.follows != null ? Number(row.follows) : null),
    profileVisits:
      typeof row.profile_visits === "number"
        ? row.profile_visits
        : (row.profile_visits != null ? Number(row.profile_visits) : null),
    replies: typeof row.replies === "number" ? row.replies : (row.replies != null ? Number(row.replies) : null),
    igReelsAvgWatchTimeMs:
      typeof row.ig_reels_avg_watch_time_ms === "number"
        ? row.ig_reels_avg_watch_time_ms
        : (row.ig_reels_avg_watch_time_ms != null ? Number(row.ig_reels_avg_watch_time_ms) : null),
  };
}

export function toAccountDailyRow(row: Record<string, unknown>): AccountDailyRow {
  return {
    id: String(row.id),
    ownerId: row.user_id ? String(row.user_id) : null,
    socialAccountId: row.social_account_id ? String(row.social_account_id) : null,
    metricDate: String(row.metric_date ?? row.metricDate),
    providerDate: String(row.provider_date ?? row.providerDate),
    periodStart: row.period_start ? String(row.period_start) : null,
    periodEnd: row.period_end ? String(row.period_end) : null,
    providerTimezone: row.provider_timezone ? String(row.provider_timezone) : "Asia/Kuwait",
    status: (row.status as OwnerReportRowStatus) ?? "ok",
    capturedAt: String(row.captured_at ?? row.capturedAt),
    reach: typeof row.reach === "number" ? row.reach : (row.reach != null ? Number(row.reach) : null),
    views: typeof row.views === "number" ? row.views : (row.views != null ? Number(row.views) : null),
    accountsEngaged:
      typeof row.accounts_engaged === "number"
        ? row.accounts_engaged
        : (row.accounts_engaged != null ? Number(row.accounts_engaged) : null),
    totalInteractions:
      typeof row.total_interactions === "number"
        ? row.total_interactions
        : (row.total_interactions != null ? Number(row.total_interactions) : null),
    likes: typeof row.likes === "number" ? row.likes : (row.likes != null ? Number(row.likes) : null),
    comments: typeof row.comments === "number" ? row.comments : (row.comments != null ? Number(row.comments) : null),
    saves: typeof row.saves === "number" ? row.saves : (row.saves != null ? Number(row.saves) : null),
    shares: typeof row.shares === "number" ? row.shares : (row.shares != null ? Number(row.shares) : null),
    follows: typeof row.follows === "number" ? row.follows : (row.follows != null ? Number(row.follows) : null),
    unfollows: typeof row.unfollows === "number" ? row.unfollows : (row.unfollows != null ? Number(row.unfollows) : null),
  };
}

export function toProfileObservationRow(row: Record<string, unknown>): ProfileObservationRow {
  return {
    id: String(row.id),
    ownerId: row.user_id ? String(row.user_id) : null,
    socialAccountId: row.social_account_id ? String(row.social_account_id) : null,
    observedAt: String(row.observed_at ?? row.observedAt),
    observedOn: String(row.observed_on ?? row.observedOn),
    captureTimezone: String(row.capture_timezone ?? row.captureTimezone ?? "Asia/Kuwait"),
    status: (row.status as OwnerReportRowStatus) ?? "ok",
    followersCount:
      typeof row.followers_count === "number"
        ? row.followers_count
        : (row.followers_count != null ? Number(row.followers_count) : null),
    mediaCount:
      typeof row.media_count === "number"
        ? row.media_count
        : (row.media_count != null ? Number(row.media_count) : null),
  };
}

export function parseFreshness(jobStatus: Record<string, unknown> | null): OwnerReportFreshnessInput {
  if (!jobStatus || jobStatus.status === "none") {
    return {
      status: "never",
      lastAttemptAt: null,
      lastSuccessAt: null,
      lastPartialAt: null,
      partial: false,
      truncated: false,
      retryAt: null,
      reason: "never_synced",
    };
  }

  const rawStatus = String(jobStatus.status ?? "queued");
  let syncStatus: OwnerReportSyncStatus = "never";
  if (rawStatus === "completed") syncStatus = "ok";
  else if (rawStatus === "partial") syncStatus = "partial";
  else if (rawStatus === "failed") syncStatus = "error";
  else if (jobStatus.last_success_at) syncStatus = "ok";
  else if (jobStatus.last_attempt_at) syncStatus = "partial";

  const inventory = (jobStatus.inventory as Record<string, unknown>) ?? {};
  const isPartial = Boolean(inventory.partial ?? rawStatus === "partial");
  const isTruncated = Boolean(inventory.truncated ?? false);
  const reasonCode = (jobStatus.reason_code as OwnerReportReasonCode) ?? null;

  return {
    status: syncStatus,
    lastAttemptAt: jobStatus.last_attempt_at ? String(jobStatus.last_attempt_at) : null,
    lastSuccessAt: jobStatus.last_success_at ? String(jobStatus.last_success_at) : null,
    lastPartialAt: jobStatus.last_partial_at ? String(jobStatus.last_partial_at) : null,
    partial: isPartial,
    truncated: isTruncated,
    retryAt: jobStatus.next_retry_at ? String(jobStatus.next_retry_at) : null,
    reason: reasonCode,
  };
}

export function parseCompleteness(
  jobStatus: Record<string, unknown> | null,
  mediaItems: MediaSnapshotRow[]
): OwnerReportCompletenessInput {
  const inventory = (jobStatus?.inventory as Record<string, unknown>) ?? {};
  const isTruncated = Boolean(inventory.truncated ?? false);
  const isCovered = Boolean(inventory.window_covered ?? false);

  let coverage: OwnerReportCoverage = "unknown";
  if (isCovered) coverage = "complete";
  else if (inventory.partial || (mediaItems.length > 0 && !isCovered)) coverage = "partial";

  let oldestPublishedAt: string | null = null;
  let newestPublishedAt: string | null = null;

  if (mediaItems.length > 0) {
    const sorted = [...mediaItems].sort(
      (a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime()
    );
    oldestPublishedAt = sorted[0].publishedAt;
    newestPublishedAt = sorted[sorted.length - 1].publishedAt;
  }

  return {
    baselineHistoryComplete: !isTruncated && isCovered,
    inventoryTruncated: isTruncated,
    coverage,
    oldestMediaPublishedAt: oldestPublishedAt,
    newestMediaPublishedAt: newestPublishedAt,
  };
}

export class ReportStore {
  constructor(private readonly client: ReportStoreClient) {}

  async loadAccount(
    socialAccountId: string,
    userId: string,
    signal = AbortSignal.timeout(20_000),
  ): Promise<{ id: string; user_id: string; platform: string } | null> {
    const { data, error } = await this.client
      .from("social_accounts")
      .select("id, user_id, platform")
      .eq("id", socialAccountId)
      .eq("user_id", userId)
      .eq("platform", "instagram")
      .eq("is_active", true)
      .abortSignal(signal)
      .maybeSingle();

    if (error) {
      throw new Error(`Failed to load account: ${error.message}`);
    }
    if (!data) return null;
    return {
      id: String(data.id),
      user_id: String(data.user_id),
      platform: String(data.platform),
    };
  }

  async loadReportData(
    socialAccountId: string,
    userId: string,
    request: OwnerReportRequest,
    now: Date = new Date()
  ): Promise<OwnerReport> {
    // 1. Verify account ownership within the same budget as the history reads.
    const signal = AbortSignal.timeout(20_000);
    const account = await this.loadAccount(socialAccountId, userId, signal);
    if (!account) {
      throw new OwnerReportContractError("ACCOUNT_MISMATCH", "Instagram account not found or not owned by user");
    }

    const periodDays = request.periodDays;
    const windowStartMs = now.getTime() - periodDays * 86_400_000;

    // 2. Query ig_media_insight_snapshots for this account and user
    const historyScope = { userId, socialAccountId };
    const rawMedia = await readReportHistory(this.client, historyScope, {
      table: "ig_media_insight_snapshots",
      columns:
        "id, user_id, social_account_id, post_id, ig_media_id, published_at, captured_at, captured_on, capture_timezone, media_product_type, media_type, permalink, thumbnail_url, status, views, reach, likes, comments, saved, shares, total_interactions, follows, profile_visits, replies, ig_reels_avg_watch_time_ms",
      timestamp: "captured_at", asOf: now.toISOString(),
    }, signal);

    // 3. Query ig_account_insight_daily for this account and user
    const rawDaily = await readReportHistory(this.client, historyScope, {
      table: "ig_account_insight_daily",
      columns:
        "id, user_id, social_account_id, metric_date, provider_date, period_start, period_end, provider_timezone, status, captured_at, reach, views, accounts_engaged, total_interactions, likes, comments, saves, shares, follows, unfollows",
      timestamp: "captured_at", asOf: now.toISOString(),
    }, signal);

    // 4. Query ig_account_profile_observations for this account and user
    const rawProfiles = await readReportHistory(this.client, historyScope, {
      table: "ig_account_profile_observations",
      columns:
        "id, user_id, social_account_id, observed_at, observed_on, capture_timezone, status, followers_count, media_count",
      timestamp: "observed_at", asOf: now.toISOString(),
    }, signal);

    // 5. Query status from read_instagram_collection_job_status
    let jobStatus: Record<string, unknown> | null = null;
    {
      const { data, error } = await this.client.rpc("read_instagram_collection_job_status", {
        p_target_kind: "owner",
        p_target_id: socialAccountId,
      }).abortSignal(signal);
      if (error) throw new Error(`Failed to load collection status: ${error.message}`);
      if (data) {
        jobStatus = data as Record<string, unknown>;
      }
    }

    // Map rows to contracts types
    const mappedMedia: MediaSnapshotRow[] = (rawMedia ?? []).map((r: Record<string, unknown>) =>
      toMediaSnapshotRow(r)
    );
    const displayMedia = mappedMedia.filter(
      (m) => new Date(m.publishedAt).getTime() >= windowStartMs
    );
    const baselineHistory = mappedMedia;

    const mappedDaily: AccountDailyRow[] = (rawDaily ?? []).map((r: Record<string, unknown>) =>
      toAccountDailyRow(r)
    );
    const mappedProfiles: ProfileObservationRow[] = (rawProfiles ?? []).map(
      (r: Record<string, unknown>) => toProfileObservationRow(r)
    );

    const freshness = parseFreshness(jobStatus);
    const completeness = parseCompleteness(jobStatus, mappedMedia);

    return assembleOwnerReport({
      scope: {
        ownerId: userId,
        socialAccountId,
        platform: "instagram",
      },
      now,
      request,
      mediaSnapshots: displayMedia,
      baselineHistory,
      accountDaily: mappedDaily,
      profileObservations: mappedProfiles,
      freshness,
      completeness,
    });
  }
}
