import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, Loader2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import type { CompetitorCollectionStatus } from "../application/ports";
import type { CompetitorReportEntry, CompetitorReportMedia } from "../domain/contracts";
import type { CompetitorTrackingError } from "../domain/errors";
import {
  UNAVAILABLE_VALUE,
  formatCount,
  formatGrowth,
  formatObservedAt,
  formatWeekly,
} from "../domain/formatters";
import { displayInstagramHandle } from "../domain/handle";
import { CompetitorMediaTable } from "./CompetitorMediaTable";
import { CompetitorSourceBadge } from "./CompetitorSourceBadge";
import { CompetitorStatus } from "./CompetitorStatus";
import {
  competitorErrorMessage,
  useCompetitorErrorCopy,
  type CompetitorPeriodDays,
} from "./useCompetitorTracking";

export type CompetitorDetailSheetProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: CompetitorReportEntry | null;
  media: CompetitorReportMedia[];
  isLoading: boolean;
  error: CompetitorTrackingError | null;
  periodDays: CompetitorPeriodDays;
  onSelectPeriod: (period: CompetitorPeriodDays) => void;
  onRetryRead: () => void;
  /** The collection state of the entry, when it is being polled. */
  collection: CompetitorCollectionStatus | null;
  /** The entry was removed and is retained. */
  onReactivate?: () => void;
  isReactivatePending?: boolean;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
};

/**
 * The detail of one tracked competitor.
 *
 * The sheet is readable for a REMOVED entry: the history outlives the
 * removal, so the observation, the growth and the posts stay on screen
 * with the removal date and the cleanup date beside them. What a
 * removed entry does NOT have is a collection action - there is nothing
 * left to collect (spec §3).
 */
export function CompetitorDetailSheet({
  open,
  onOpenChange,
  entry,
  media,
  isLoading,
  error,
  periodDays,
  onSelectPeriod,
  onRetryRead,
  collection,
  onReactivate,
  isReactivatePending = false,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
}: CompetitorDetailSheetProps) {
  const { t, i18n } = useTranslation("analytics");
  const copy = useCompetitorErrorCopy();
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
      capture_gap: t("competitors.captureGap", "A capture gap sits inside this window"),
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

  const handle = entry === null ? "" : displayInstagramHandle(entry.username);
  const growth7 = entry === null ? null : formatGrowth(entry.growth_7d);
  const growth30 = entry === null ? null : formatGrowth(entry.growth_30d);
  const weekly = entry === null ? null : formatWeekly(entry.weekly);
  const status = collection?.status ?? entry?.status ?? null;
  const nextRetryAt = collection?.nextRetryAt ?? entry?.next_retry_at ?? null;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
        <SheetHeader>
          <SheetTitle>
            {entry === null ? (
              t("competitors.loading", "Loading competitors")
            ) : (
              <bdi>{handle}</bdi>
            )}
          </SheetTitle>
          <SheetDescription>
            {entry === null
              ? t("competitors.loading", "Loading competitors")
              : t(
                  "competitors.detailDescription",
                  "The collected public history of this competitor.",
                )}
          </SheetDescription>
        </SheetHeader>

        <div className="mt-4 space-y-4">
          {isLoading && (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-16 w-full rounded-xl" />
              <Skeleton className="h-40 w-full rounded-xl" />
            </div>
          )}

          {(error !== null || (entry === null && !isLoading)) && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle className="text-xs font-semibold">
                {error !== null
                  ? competitorErrorMessage(copy, error)
                  : t("competitors.notFound", "That competitor is no longer available.")}
              </AlertTitle>
              <AlertDescription className="mt-1 text-xs">
                <Button size="sm" variant="outline" onClick={onRetryRead}>
                  {t("competitors.retryRead", "Retry loading")}
                </Button>
              </AlertDescription>
            </Alert>
          )}

          {entry !== null && (
            <>
              {entry.is_active === false && (
                <Alert>
                  <AlertTitle className="text-xs font-semibold">
                    {t("competitors.removedEntry", "This competitor was removed.")}
                  </AlertTitle>
                  <AlertDescription className="mt-1 flex flex-col gap-1 text-xs">
                    {entry.removed_at !== null && (
                      <span>
                        {t("competitors.removedAt", "Removed {{date}}", {
                          date: formatObservedAt(entry.removed_at, locale),
                        })}
                      </span>
                    )}
                    {entry.cleanup_eligible_at !== null && (
                      <span>
                        {t("competitors.cleanupEligibleAt", "Eligible for cleanup on {{date}}", {
                          date: formatObservedAt(entry.cleanup_eligible_at, locale),
                        })}
                      </span>
                    )}
                    {onReactivate && (
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-fit"
                        disabled={isReactivatePending}
                        onClick={onReactivate}
                      >
                        {isReactivatePending ? (
                          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
                        ) : null}
                        {isReactivatePending
                          ? t("competitors.reactivating", "Reactivating")
                          : t("competitors.reactivate", "Reactivate")}
                      </Button>
                    )}
                  </AlertDescription>
                </Alert>
              )}

              <div className="rounded-xl border border-border/70 bg-card p-4">
                <div className="flex flex-wrap items-center gap-2">
                  <CompetitorSourceBadge source={entry.profile?.source ?? "unknown"} />
                  <CompetitorStatus
                    status={status}
                    reasonCode={entry.last_error_code}
                    nextRetryAt={nextRetryAt}
                  />
                </div>
                <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
                  <div>
                    <dt className="text-muted-foreground">
                      {t("competitors.followers", "Followers")}
                    </dt>
                    <dd className="font-medium text-foreground">
                      {entry.profile === null
                        ? UNAVAILABLE_VALUE
                        : formatCount(entry.profile.followers_count, locale)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {t("competitors.postsPerWeek", "Observed posts / week")}
                    </dt>
                    <dd className="font-medium text-foreground">
                      {weekly !== null && weekly.rateAvailable
                        ? weekly.postsPerWeekText
                        : UNAVAILABLE_VALUE}
                    </dd>
                  </div>
                </dl>
                {entry.profile !== null && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    {t("competitors.observedAt", "Observed {{date}}", {
                      date: formatObservedAt(entry.profile.captured_at, locale),
                    })}
                  </p>
                )}
              </div>

              <Tabs
                value={String(periodDays)}
                onValueChange={(value) => onSelectPeriod(Number(value) as CompetitorPeriodDays)}
              >
                <TabsList>
                  <TabsTrigger value="7">
                    {t("competitors.growth7d", "Follower change · 7 days")}
                  </TabsTrigger>
                  <TabsTrigger value="30">
                    {t("competitors.growth30d", "Follower change · 30 days")}
                  </TabsTrigger>
                </TabsList>
              </Tabs>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {[growth7, growth30].map((growth, index) => {
                  if (growth === null) return null;
                  const label =
                    index === 0
                      ? t("competitors.growth7d", "Follower change · 7 days")
                      : t("competitors.growth30d", "Follower change · 30 days");
                  return (
                    <div key={label} className="rounded-xl border border-border/70 bg-card p-4">
                      <p className="text-xs text-muted-foreground">{label}</p>
                      <p className="mt-1 text-sm font-medium text-foreground">{growth.text}</p>
                      {!growth.available && growth.reason !== null && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {growthReasonCopy[growth.reason as keyof typeof growthReasonCopy] ??
                            t("competitors.unavailableMetric", "That metric is unavailable")}
                        </p>
                      )}
                      {growth.available && growth.intervalDays !== null && (
                        <p className="mt-1 text-xs text-muted-foreground">
                          {t(
                            "competitors.growthInterval",
                            "Compared with {{date}} ({{days}} days)",
                            {
                              date: formatObservedAt(growth.baselineAt, locale),
                              days: growth.intervalDays,
                            },
                          )}
                        </p>
                      )}
                    </div>
                  );
                })}
              </div>

              {weekly !== null && (
                <div className="rounded-xl border border-border/70 bg-card p-4">
                  <p className="text-xs text-muted-foreground">
                    {t("competitors.postsPerWeek", "Observed posts / week")}
                  </p>
                  <p className="mt-1 text-sm font-medium text-foreground">
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
                  </p>
                  {weekly.reason !== null && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {weeklyReasonCopy[
                        (weekly.reason as keyof typeof weeklyReasonCopy) ?? "coverage_unknown"
                      ] ??
                        t(
                          "competitors.coverageUnknown",
                          "The coverage of this window is unknown",
                        )}
                    </p>
                  )}
                  {weekly.intervalEnd !== null && (
                    <p className="mt-1 text-xs text-muted-foreground">
                      {t("competitors.observedAt", "Observed {{date}}", {
                        date: formatObservedAt(weekly.intervalEnd, locale),
                      })}
                    </p>
                  )}
                </div>
              )}

              <CompetitorMediaTable media={media} />

              {hasMore && onLoadMore && (
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
            </>
          )}
        </div>

        {/* The live region of the sheet: the collection state changes
            while the sheet is open, and it is announced politely
            instead of interrupting the owner. */}
        <p className={cn("sr-only")} aria-live="polite" role="status">
          {status ?? ""}
        </p>
      </SheetContent>
    </Sheet>
  );
}
