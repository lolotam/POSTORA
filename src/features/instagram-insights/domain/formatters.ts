import type {
  OutlierLabel,
  OwnerReportEngagementRate,
  OwnerReportReasonCode,
  OwnerReportSyncStatus,
} from "./types";

/**
 * Maps outlier labels to human-readable text and styling variants.
 * Pure logic: adheres strictly to ARCHITECTURE §22 (null is unavailable, never 0).
 */

export type OutlierVariant = "default" | "success" | "warning" | "destructive" | "secondary" | "outline";

export function getOutlierVariant(label: OutlierLabel): OutlierVariant {
  switch (label) {
    case "outlier":
    case "above":
      return "success";
    case "normal":
      return "secondary";
    case "below":
      return "warning";
    case "too_early":
    case "small_baseline":
    case "no_data":
    default:
      return "outline";
  }
}

export function formatOutlierBadge(label: OutlierLabel, score: number | null): { text: string; variant: OutlierVariant } {
  const variant = getOutlierVariant(label);
  const formattedScore = score !== null && Number.isFinite(score) ? `${score.toFixed(1)}x` : null;

  switch (label) {
    case "outlier":
      return { text: formattedScore ? `🌟 ${formattedScore} Outlier` : "🌟 Outlier", variant };
    case "above":
      return { text: formattedScore ? `▲ ${formattedScore} Above` : "▲ Above", variant };
    case "normal":
      return { text: formattedScore ? `${formattedScore} Normal` : "Normal", variant };
    case "below":
      return { text: formattedScore ? `▼ ${formattedScore} Below` : "▼ Below", variant };
    case "too_early":
      return { text: "Too early (<48h)", variant };
    case "small_baseline":
      return { text: "Small baseline", variant };
    case "no_data":
    default:
      return { text: "No data", variant };
  }
}

export function formatMetricNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  return new Intl.NumberFormat().format(value);
}

export function formatCompactNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "—";
  }
  if (value >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (value >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  }
  return value.toString();
}

export function formatEngagementRate(rate: OwnerReportEngagementRate | null | undefined): string {
  if (!rate || rate.value === null || rate.value === undefined || !Number.isFinite(rate.value)) {
    return "—";
  }
  return `${rate.value.toFixed(2)}%`;
}

export function formatSyncStatus(status: OwnerReportSyncStatus): { label: string; variant: OutlierVariant } {
  switch (status) {
    case "ok":
      return { label: "Up to date", variant: "success" };
    case "partial":
      return { label: "Partially synced", variant: "warning" };
    case "error":
      return { label: "Sync error", variant: "destructive" };
    case "never":
    default:
      return { label: "Never synced", variant: "outline" };
  }
}

export function formatReasonExplanation(reason: OwnerReportReasonCode | null | undefined): string | null {
  if (!reason || reason === "ok") return null;
  switch (reason) {
    case "never_synced":
      return "Initial collection has not started yet.";
    case "scope_missing":
      return "Required Instagram Insights permissions are missing. Reconnecting your account may resolve this.";
    case "reauth_required":
      return "Account session expired. Please reconnect this Instagram account.";
    case "throttled":
    case "usage_limit_reached":
      return "Instagram API rate limit reached. The system will retry automatically.";
    case "provider_unavailable":
    case "provider_error":
    case "network_error":
      return "Instagram temporary service issue. Next attempt is scheduled.";
    case "baseline_history_incomplete":
    case "inventory_truncated":
      return "Recent media collected; historical baseline is building up.";
    case "write_failed":
    case "unknown":
    default:
      return "A transient sync error occurred.";
  }
}
