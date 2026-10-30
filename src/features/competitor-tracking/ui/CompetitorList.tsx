import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { AlertCircle, Loader2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import type { CompetitorCollectionStatus } from "../application/ports";
import type { CompetitorReportEntry } from "../domain/contracts";
import type { CompetitorTrackingError } from "../domain/errors";
import {
  UNAVAILABLE_VALUE,
  formatCount,
  formatGrowth,
  formatObservedAt,
  formatWeekly,
} from "../domain/formatters";
import { displayInstagramHandle } from "../domain/handle";
import { CompetitorSourceBadge } from "./CompetitorSourceBadge";
import { CompetitorStatus } from "./CompetitorStatus";
import type { CompetitorListState } from "./useCompetitorTracking";

export type CompetitorListProps = {
  entries: CompetitorReportEntry[];
  state: CompetitorListState;
  isLoading: boolean;
  error: CompetitorTrackingError | null;
  onRetryRead: () => void;
  onOpenDetail: (watchlistId: string) => void;
  onRetryCollection: (entry: CompetitorReportEntry) => void;
  isRetryPending: (watchlistId: string) => boolean;
  onRemove: (entry: CompetitorReportEntry, trigger: HTMLElement) => void;
  onReactivate: (entry: CompetitorReportEntry) => void;
  isReactivatePending: (watchlistId: string) => boolean;
  collectionStatus: (watchlistId: string) => CompetitorCollectionStatus | null;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMoreError: CompetitorTrackingError | null;
  onLoadMore: () => void;
};

const SKELETON_ROWS = 3;

/**
 * The tracked competitors.
 *
 * The layout is the repository's reference lock: a compact toolbar, a
 * solid bordered card and one row per competitor. At a narrow width
 * the same rows stack into labelled cards instead of a table that
 * would need a horizontal scrollbar.
 */
export function CompetitorList({
  entries,
  state,
  isLoading,
  error,
  onRetryRead,
  onOpenDetail,
  onRetryCollection,
  isRetryPending,
  onRemove,
  onReactivate,
  isReactivatePending,
  collectionStatus,
  hasMore,
  isLoadingMore,
  loadMoreError,
  onLoadMore,
}: CompetitorListProps) {
  const { t, i18n } = useTranslation("analytics");
  const locale = i18n.resolvedLanguage ?? i18n.language;

  const growthReasonCopy = useMemo(
    () => ({
      first_observation: t("competitors.firstBaseline", "Not enough history"),
      missing_baseline: t("competitors.missingBaseline", "No comparable baseline"),
      zero_baseline: t("competitors.zeroBaseline", "No percentage: baseline was zero"),
      stale_baseline: t("competitors.staleBaseline", "Baseline is too old"),
      unavailable_metric: t("competitors.unavailableMetric", "That metric is unavailable"),
      source_changed: t(
        "competitors.sourceChanged",
        "The source changed between the two observations",
      ),
      baseline_policy_unset: t(
        "competitors.baselinePolicyUnset",
        "No baseline policy is configured",
      ),
    }),
    [t],
  );

  const weeklyReasonCopy = useMemo(
    () => ({
      capture_gap: t(
        "competitors.captureGap",
        "A capture gap sits inside this window",
      ),
      ordering_unknown: t(
        "competitors.orderingUnknown",
        "The order of the captured posts is not verified",
      ),
      coverage_unknown: t(
        "competitors.coverageUnknown",
        "The coverage of this window is unknown",
      ),
    }),
    [t],
  );

  if (isLoading) {
    return (
      <div className="space-y-2" aria-busy="true">
        <span className="sr-only">{t("competitors.loading", "Loading competitors")}</span>
        {Array.from({ length: SKELETON_ROWS }).map((_, index) => (
          <Skeleton key={index} className="h-20 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  // A first-load failure is a FAILURE, not an empty list: there is no
  // "track your first competitor" invitation when we simply do not know
  // whether the owner has any.
  if (error !== null && entries.length === 0) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle className="text-xs font-semibold">
          {t("competitors.loadFailed", "Could not load competitors.")}
        </AlertTitle>
        <AlertDescription className="mt-1 text-xs">
          <Button size="sm" variant="outline" onClick={onRetryRead}>
            {t("competitors.retryRead", "Retry loading")}
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  if (entries.length === 0) {
    if (state === "removed") {
      return (
        <div className="rounded-xl border border-dashed border-border bg-card/40 p-8 text-center">
          <p className="text-sm text-muted-foreground">
            {t("competitors.emptyRemoved", "No removed competitors")}
          </p>
        </div>
      );
    }

    return (
      <div className="rounded-xl border border-dashed border-border bg-card/40 p-8 text-center">
        <p className="text-sm font-medium text-foreground">
          {t("competitors.emptyActive", "Track your first Instagram competitor")}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t(
            "competitors.emptyActiveHint",
            "Once a competitor is tracked you can compare its public posts and follower growth here.",
          )}
        </p>
        <Button asChild size="sm" variant="outline" className="mt-4">
          <Link to="/analytics/instagram?tab=analyze">
            {t("competitors.search", "Go to search")}
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {error !== null && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle className="text-xs font-semibold">
            {t("competitors.staleData", "Showing the last data that loaded.")}
          </AlertTitle>
          <AlertDescription className="mt-1 flex flex-wrap items-center gap-2 text-xs">
            <span>{t("competitors.loadFailed", "Could not load competitors.")}</span>
            <Button size="sm" variant="outline" onClick={onRetryRead}>
              {t("competitors.retryRead", "Retry loading")}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      <div className="rounded-xl border border-border/70 bg-card">
        <Table className="max-lg:block [&_td]:lg:px-2 [&_th]:lg:px-2">
          <TableHeader className="max-lg:sr-only">
            <TableRow>
              <TableHead>{t("competitors.handle", "Handle")}</TableHead>
              <TableHead>{t("competitors.followers", "Followers")}</TableHead>
              <TableHead>{t("competitors.growth7d", "Follower change · 7 days")}</TableHead>
              <TableHead>{t("competitors.growth30d", "Follower change · 30 days")}</TableHead>
              <TableHead>{t("competitors.postsPerWeek", "Observed posts / week")}</TableHead>
              <TableHead>{t("competitors.sourceLabel", "Source")}</TableHead>
              <TableHead>{t("competitors.status.pending", "Waiting for collection")}</TableHead>
              <TableHead>{t("competitors.actions", "Actions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="max-lg:block">
            {entries.map((entry) => {
              const growth7 = formatGrowth(entry.growth_7d);
              const growth30 = formatGrowth(entry.growth_30d);
              const weekly = formatWeekly(entry.weekly);
              const collection = collectionStatus(entry.watchlist_id);
              const status = collection?.status ?? entry.status;
              const nextRetryAt = collection?.nextRetryAt ?? entry.next_retry_at;
              const retryDeferred = nextRetryAt !== null && nextRetryAt !== undefined
                ? Date.parse(nextRetryAt) > Date.now()
                : false;
              const retryBusy = isRetryPending(entry.watchlist_id);
              const reactivateBusy = isReactivatePending(entry.watchlist_id);

              return (
                <TableRow
                  key={entry.watchlist_id}
                  className="max-lg:block max-lg:mb-2 max-lg:rounded-lg max-lg:border max-lg:border-border max-lg:bg-background"
                >
                  <TableCell className="max-lg:block max-lg:border-0 max-lg:p-3 max-lg:px-3 max-lg:whitespace-normal">
                    <span className="mb-1 block text-xs font-medium text-muted-foreground lg:hidden">
                      {t("competitors.handle", "Handle")}
                    </span>
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium text-foreground">
                        <bdi>{displayInstagramHandle(entry.username)}</bdi>
                      </span>
                      {entry.label !== null && entry.label !== "" && (
                        <span className="text-xs text-muted-foreground">{entry.label}</span>
                      )}
                      {!entry.is_active && entry.cleanup_eligible_at !== null && (
                        <span className="text-xs text-muted-foreground">
                          {t("competitors.cleanupEligibleAt", "Eligible for cleanup on {{date}}", {
                            date: formatObservedAt(entry.cleanup_eligible_at, locale),
                          })}
                        </span>
                      )}
                    </div>
                  </TableCell>

                  <TableCell className="max-lg:block max-lg:border-0 max-lg:p-3 max-lg:px-3 max-lg:whitespace-normal">
                    <span className="mb-1 block text-xs font-medium text-muted-foreground lg:hidden">
                      {t("competitors.followers", "Followers")}
                    </span>
                    <div className="flex flex-col gap-0.5">
                      <span>
                        {entry.profile === null
                          ? UNAVAILABLE_VALUE
                          : formatCount(entry.profile.followers_count, locale)}
                      </span>
                      {entry.profile === null ? (
                        <span className="text-xs text-muted-foreground">
                          {t("competitors.firstSnapshot", "Waiting for first snapshot")}
                        </span>
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          {t("competitors.observedAt", "Observed {{date}}", {
                            date: formatObservedAt(entry.profile.captured_at, locale),
                          })}
                        </span>
                      )}
                    </div>
                  </TableCell>

                  <TableCell className="max-lg:block max-lg:border-0 max-lg:p-3 max-lg:px-3 max-lg:whitespace-normal">
                    <span className="mb-1 block text-xs font-medium text-muted-foreground lg:hidden">
                      {t("competitors.growth7d", "Follower change · 7 days")}
                    </span>
                    <div className="flex flex-col gap-0.5">
                      <span>{growth7.text}</span>
                      {!growth7.available && growth7.reason !== null && (
                        <span className="text-xs text-muted-foreground">
                          {growthReasonCopy[growth7.reason as keyof typeof growthReasonCopy] ??
                            t("competitors.unavailableMetric", "That metric is unavailable")}
                        </span>
                      )}
                      {growth7.available && growth7.intervalDays !== null && (
                        <span className="text-xs text-muted-foreground">
                          {t(
                            "competitors.growthInterval",
                            "Compared with {{date}} ({{days}} days)",
                            {
                              date: formatObservedAt(growth7.baselineAt, locale),
                              days: growth7.intervalDays,
                            },
                          )}
                        </span>
                      )}
                    </div>
                  </TableCell>

                  <TableCell className="max-lg:block max-lg:border-0 max-lg:p-3 max-lg:px-3 max-lg:whitespace-normal">
                    <span className="mb-1 block text-xs font-medium text-muted-foreground lg:hidden">
                      {t("competitors.growth30d", "Follower change · 30 days")}
                    </span>
                    <div className="flex flex-col gap-0.5">
                      <span>{growth30.text}</span>
                      {!growth30.available && growth30.reason !== null && (
                        <span className="text-xs text-muted-foreground">
                          {growthReasonCopy[growth30.reason as keyof typeof growthReasonCopy] ??
                            t("competitors.unavailableMetric", "That metric is unavailable")}
                        </span>
                      )}
                      {growth30.available && growth30.intervalDays !== null && (
                        <span className="text-xs text-muted-foreground">
                          {t(
                            "competitors.growthInterval",
                            "Compared with {{date}} ({{days}} days)",
                            {
                              date: formatObservedAt(growth30.baselineAt, locale),
                              days: growth30.intervalDays,
                            },
                          )}
                        </span>
                      )}
                    </div>
                  </TableCell>

                  <TableCell className="max-lg:block max-lg:border-0 max-lg:p-3 max-lg:px-3 max-lg:whitespace-normal">
                    <span className="mb-1 block text-xs font-medium text-muted-foreground lg:hidden">
                      {t("competitors.postsPerWeek", "Observed posts / week")}
                    </span>
                    <div className="flex flex-col gap-0.5">
                      <span>
                        {weekly.rateAvailable ? weekly.postsPerWeekText : UNAVAILABLE_VALUE}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {weekly.coverage === "complete"
                          ? t(
                              "competitors.weeklyComplete",
                              "{{count}} observed posts / 7 days",
                              { count: weekly.observedCount },
                            )
                          : t(
                              "competitors.weeklyPartial",
                              "{{count}} posts observed · incomplete coverage",
                              { count: weekly.observedCount },
                            )}
                      </span>
                      {weekly.reason !== null && (
                        <span className="text-xs text-muted-foreground">
                          {weeklyReasonCopy[
                            (weekly.reason as keyof typeof weeklyReasonCopy) ?? "coverage_unknown"
                          ] ?? t("competitors.coverageUnknown", "The coverage of this window is unknown")}
                        </span>
                      )}
                    </div>
                  </TableCell>

                  <TableCell className="max-lg:block max-lg:border-0 max-lg:p-3 max-lg:px-3 max-lg:whitespace-normal">
                    <span className="mb-1 block text-xs font-medium text-muted-foreground lg:hidden">
                      {t("competitors.sourceLabel", "Source")}
                    </span>
                    <CompetitorSourceBadge source={entry.profile?.source ?? "unknown"} />
                  </TableCell>

                  <TableCell className="max-lg:block max-lg:border-0 max-lg:p-3 max-lg:px-3 max-lg:whitespace-normal">
                    <span className="mb-1 block text-xs font-medium text-muted-foreground lg:hidden">
                      {t("competitors.status.pending", "Waiting for collection")}
                    </span>
                    <CompetitorStatus
                      status={status}
                      reasonCode={entry.last_error_code}
                      nextRetryAt={nextRetryAt}
                    />
                    {entry.freshness.last_partial_at !== null && (
                      <span className="text-xs text-muted-foreground">
                        {t(
                          "competitors.partialData",
                          "Only part of the collection is available.",
                        )}
                      </span>
                    )}
                  </TableCell>

                  <TableCell className="max-lg:block max-lg:border-0 max-lg:p-3 max-lg:px-3 max-lg:whitespace-normal lg:whitespace-nowrap">
                    <span className="mb-1 block text-xs font-medium text-muted-foreground lg:hidden">
                      {t("competitors.actions", "Actions")}
                    </span>
                    <div className="flex flex-wrap items-center gap-2 lg:flex-nowrap">
                      <Button
                        size="sm"
                        variant="outline"
                        aria-label={t("competitors.viewReport", "View report for @{{username}}", {
                          username: entry.username,
                        })}
                        onClick={() => onOpenDetail(entry.watchlist_id)}
                      >
                        {t("competitors.view", "View")}
                      </Button>

                      {entry.is_active ? (
                        <>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={retryBusy || retryDeferred}
                            onClick={() => onRetryCollection(entry)}
                          >
                            {retryBusy ? (
                              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                            ) : null}
                            {t("competitors.retryCollection", "Retry collection")}
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-destructive hover:text-destructive"
                            aria-label={`${t("competitors.remove", "Remove")} ${displayInstagramHandle(entry.username)}`}
                            onClick={(event) => onRemove(entry, event.currentTarget)}
                          >
                            {t("competitors.remove", "Remove")}
                          </Button>
                        </>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={reactivateBusy}
                          aria-label={`${t("competitors.reactivate", "Reactivate")} ${displayInstagramHandle(entry.username)}`}
                          onClick={() => onReactivate(entry)}
                        >
                          {reactivateBusy ? (
                            <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                          ) : null}
                          {t("competitors.reactivate", "Reactivate")}
                        </Button>
                      )}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>

      {loadMoreError !== null && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle className="text-xs font-semibold">
            {t("competitors.loadMoreFailed", "Could not load more competitors.")}
          </AlertTitle>
        </Alert>
      )}

      {hasMore && (
        <div className="flex justify-center">
          <Button size="sm" variant="outline" disabled={isLoadingMore} onClick={onLoadMore}>
            {isLoadingMore ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : null}
            {isLoadingMore
              ? t("competitors.loadingMore", "Loading more")
              : t("competitors.loadMore", "Load more")}
          </Button>
        </div>
      )}
    </div>
  );
}
