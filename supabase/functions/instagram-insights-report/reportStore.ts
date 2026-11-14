import { parseOwnerAnalyticsReadiness, ownerAnalyticsData } from "../_shared/ownerAnalyticsReadiness.ts";
/**
 * Database Reader & Store for Instagram Insights Report (Slice O3).
 *
 * Reads authoritative historical data from:
 * - `social_accounts` (verifying ownership and active status)
 * - `ig_media_insight_snapshots` (media metrics and inventory)
 * - `ig_account_insight_daily` (daily interactions and follow breakdowns)
 * - `ig_account_profile_observations` (followers and media count history)
 * - owner-scoped collection jobs/checkpoints (sync status and coverage)
 *
 * Feeds pure `assembleOwnerReport` to construct the canonical OwnerReport v1 DTO.
 */

import {
  type AccountDailyRow,
  type AccountPeriodTotalRow,
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
import { readReportQuery, ReportHistoryUnavailableError, type HistoryClient } from "./readHistory.ts";

export type ReportStoreClient = HistoryClient & {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }> & { abortSignal(signal: AbortSignal): PromiseLike<{ data: unknown; error: { code?: string; message: string } | null }> };
};

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

export function toAccountPeriodTotalRow(row: Record<string, unknown>): AccountPeriodTotalRow {
  return {
    id: String(row.id),
    ownerId: row.user_id ? String(row.user_id) : null,
    socialAccountId: row.social_account_id ? String(row.social_account_id) : null,
    metric: String(row.metric),
    periodDays: Number(row.period_days),
    sinceDate: String(row.since_date),
    untilDate: String(row.until_date),
    status: String(row.status),
    // A total without a value stays without one; it is never read as zero.
    value: row.value == null ? null : Number(row.value),
    capturedAt: String(row.captured_at),
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

/**
 * The collection worker records its own reason vocabulary on the job; the
 * report speaks a smaller one. Every worker reason is translated here so a
 * partial or failed visit never makes the report itself invalid. A reason the
 * report does not know yet reads as "unknown", never as a refusal.
 */
const WORKER_REASON_TO_REPORT_REASON: Readonly<Record<string, OwnerReportReasonCode>> = {
  scope_missing: "scope_missing",
  capability_missing: "unknown",
  token_invalid: "reauth_required",
  credential_unavailable: "unknown",
  context_missing: "unknown",
  direct_login_unsupported: "unknown",
  rate_limited: "throttled",
  provider_error: "provider_error",
  collection_unavailable: "provider_unavailable",
  inventory_unavailable: "provider_unavailable",
  inventory_incomplete: "inventory_truncated",
  daily_observation_pending: "baseline_history_incomplete",
  media_insights_pending: "baseline_history_incomplete",
  period_reach_pending: "baseline_history_incomplete",
};

const REPORT_REASONS: ReadonlySet<string> = new Set<OwnerReportReasonCode>([
  "ok", "never_synced", "scope_missing", "reauth_required", "throttled", "usage_limit_reached",
  "provider_unavailable", "provider_error", "network_error", "write_failed", "inventory_truncated",
  "baseline_history_incomplete", "unknown",
]);

function toReportReason(stored: unknown): OwnerReportReasonCode | null {
  if (stored === null || stored === undefined) return null;
  const code = String(stored);
  if (REPORT_REASONS.has(code)) return code as OwnerReportReasonCode;
  return WORKER_REASON_TO_REPORT_REASON[code] ?? "unknown";
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


  const inventory = (jobStatus.inventory as Record<string, unknown>) ?? {};
  const isPartial = Boolean(inventory.partial ?? rawStatus === "partial");
  const isTruncated = Boolean(inventory.truncated ?? false);
  const reasonCode = toReportReason(jobStatus.reason_code);

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
    const { data, error } = await readReportQuery(this.client
      .from("social_accounts")
      .select("id, user_id, platform")
      .eq("id", socialAccountId)
      .eq("user_id", userId)
      .eq("platform", "instagram")
      .eq("is_active", true)
      .abortSignal(signal)
      .maybeSingle(), signal);

    if (error) {
      throw new ReportHistoryUnavailableError(`Failed to load account: ${error.message}`);
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
    now: Date = new Date(),
    signal = AbortSignal.timeout(20_000),
  ): Promise<OwnerReport> {
    const { data, error } = await readReportQuery(this.client.rpc("read_instagram_owner_report_snapshot", {
      p_user_id: userId, p_account_id: socialAccountId, p_as_of: now.toISOString(),
    }).abortSignal(signal), signal);
    if (error?.code === "MAH02") throw new OwnerReportContractError("ACCOUNT_MISMATCH", "Instagram account not found or not owned by user");
    if (error) throw new ReportHistoryUnavailableError("Owner report snapshot could not be read");
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new ReportHistoryUnavailableError("Invalid owner report snapshot");
    const snapshot = data as Record<string, unknown>;
    if (snapshot.account_id !== socialAccountId || snapshot.owner_id !== userId) throw new ReportHistoryUnavailableError("Invalid owner report snapshot scope");
    const rows = (key: string): Record<string, unknown>[] => {
      const value = snapshot[key];
      if (!Array.isArray(value) || value.length > 20_000 || value.some((row) => !row || typeof row !== "object" || Array.isArray(row)
        || row.user_id !== userId || row.social_account_id !== socialAccountId)) throw new ReportHistoryUnavailableError("Invalid owner report history");
      if (new Set(value.map((row) => row.id)).size !== value.length) throw new ReportHistoryUnavailableError("Duplicate owner report history");
      return value;
    };
    const rawMedia = rows("media"), rawDaily = rows("daily"), rawProfiles = rows("profiles");
    const rawPeriodTotals = rows("period_totals");
    if (snapshot.collection !== null && (!snapshot.collection || typeof snapshot.collection !== "object" || Array.isArray(snapshot.collection))) {
      throw new ReportHistoryUnavailableError("Invalid owner report collection state");
    }
    const jobStatus = snapshot.collection as Record<string, unknown> | null;
    // "All time" displays every stored media; a day count bounds the rest.
    const windowStartMs = request.periodDays === "all"
      ? Number.NEGATIVE_INFINITY
      : now.getTime() - request.periodDays * 86_400_000;

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
    const mappedPeriodTotals = rawPeriodTotals.map(toAccountPeriodTotalRow);
    const mappedProfiles: ProfileObservationRow[] = (rawProfiles ?? []).map(
      (r: Record<string, unknown>) => toProfileObservationRow(r)
    );

    const freshness = parseFreshness(jobStatus);
    const completeness = parseCompleteness(jobStatus, mappedMedia);

    const report = assembleOwnerReport({
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
      accountPeriodTotals: mappedPeriodTotals,
      profileObservations: mappedProfiles,
      freshness,
      completeness,
    });
    // Count numerical observations in the requested report, not jobs or null placeholders.
    const measured = (row: Record<string, unknown>, fields: string[]) => fields.some((key) => typeof row[key] === "number");
    const measuredDaily = report.account.daily.filter((row) => row.status !== "pending" && measured(row,
      ["reach", "views", "accountsEngaged", "totalInteractions", "likes", "comments", "saves", "shares", "follows", "unfollows"]));
    const observed = [
      ...measuredDaily.map((row) => row.capturedAt),
      ...report.account.profiles.filter((row) => Date.parse(row.observedAt) >= Date.parse(report.period.windowStart)
        && Date.parse(row.observedAt) <= Date.parse(report.period.windowEnd) && row.status !== "pending" && (row.followersCount !== null || row.mediaCount !== null)).map((row) => row.observedAt),
      ...displayMedia.filter((row) => row.status !== "pending" && measured(row, ["reach", "views", "likes", "comments", "saved", "shares", "totalInteractions", "follows", "profileVisits", "replies", "igReelsAvgWatchTimeMs"])).map((row) => row.capturedAt),
      ...mappedPeriodTotals.filter((row) => row.status === "ok" && row.value !== null && row.sinceDate === report.period.metricDateStart && row.untilDate === report.period.metricDateEnd).map((row) => row.capturedAt),
    ];
    const lastCapture = observed.sort((a, b) => Date.parse(b) - Date.parse(a))[0] ?? null;
    const expectedDays = (Date.parse(report.period.metricDateEnd) - Date.parse(report.period.metricDateStart)) / 86_400_000 + 1;
    const dataState = ownerAnalyticsData({ count: observed.length,
      complete: completeness.coverage === "complete" && new Set(measuredDaily.map((row) => row.metricDate)).size === expectedDays, lastCapture, now: now.toISOString(), staleAfterMs: 2 * 86_400_000 });
    report.data = dataState;
    if (observed.length === 0) {
      report.freshness = { ...report.freshness, status: "never", partial: false, lastSuccessAt: null, lastPartialAt: null, reason: "never_synced" };
    } else {
      report.freshness = { ...report.freshness, status: dataState.state === "partial" ? "partial" : "ok", partial: dataState.state === "partial", lastSuccessAt: lastCapture };
    }
    if (snapshot.readiness !== undefined) {
      let readiness;
      try { readiness = parseOwnerAnalyticsReadiness(snapshot.readiness); }
      catch { throw new ReportHistoryUnavailableError("Invalid owner readiness snapshot"); }
      Object.assign(report, readiness);
      if (readiness.collection.reason_code === "awaiting_first_capture" && observed.length > 0) {
        report.collection = { ...readiness.collection, state: "ready", reason_code: "ready", next_action: "none" };
      }
      // Historical attempt causes never override current connection/permission evidence.
      report.freshness.reason = null;
    }
    return report;
  }
}
