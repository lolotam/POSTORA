import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { Loader2 } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { CompetitorTrackingGateway } from "../application/ports";
import type { CompetitorReportEntry } from "../domain/contracts";
import type { CompetitorTrackingError } from "../domain/errors";
import { formatQuota } from "../domain/formatters";
import { CompetitorDetailSheet } from "./CompetitorDetailSheet";
import { CompetitorList } from "./CompetitorList";
import { RemoveCompetitorDialog } from "./RemoveCompetitorDialog";
import {
  useCompetitorErrorCopy,
  useCompetitorDetail,
  useCompetitorList,
  useCompetitorQuota,
  competitorErrorMessage,
  type CompetitorListState,
  type CompetitorPeriodDays,
} from "./useCompetitorTracking";
import {
  useCompetitorPendingGuard,
  useReactivateCompetitor,
  useRemoveCompetitor,
  useRetryCompetitorCollection,
} from "./useCompetitorMutations";
import { useCompetitorSyncStatus } from "./useCompetitorSyncStatus";

export type CompetitorTrackingWorkspaceProps = {
  gateway: CompetitorTrackingGateway;
  userId: string | null;
};

/** A message the owner has to read but does not have to act on. */
type Notice = {
  tone: "info" | "error";
  text: string;
};

/**
 * The tracked competitors workspace.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The presentation state of the screen: which list the owner is
 *   looking at, which entry is open, which write is in flight and what
 *   the owner is told about it.
 *
 * WHY THE DATA HOOKS LIVE UNDER THE UI
 *
 *   React Query is a UI concern, and the application layer of this
 *   feature holds no React at all (spec §8).
 *
 * WHY THE MUTATIONS ARE NEVER AUTO-REPLAYED
 *
 *   A write whose outcome could not be observed is indeterminate: the
 *   statement may or may not have committed. The screen says so and
 *   offers a read. It never repeats the write on its own.
 */
export function CompetitorTrackingWorkspace({
  gateway,
  userId,
}: CompetitorTrackingWorkspaceProps) {
  const { t } = useTranslation("analytics");
  const copy = useCompetitorErrorCopy();

  const [state, setState] = useState<CompetitorListState>("active");
  const [selectedWatchlistId, setSelectedWatchlistId] = useState<string | null>(null);
  const [periodDays, setPeriodDays] = useState<CompetitorPeriodDays>(7);
  const [removeTarget, setRemoveTarget] = useState<CompetitorReportEntry | null>(null);
  const [pollingWatchlistId, setPollingWatchlistId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const headingRef = useRef<HTMLHeadingElement>(null);

  const list = useCompetitorList({ gateway, userId, state });
  const quota = useCompetitorQuota({ gateway, userId });
  const detail = useCompetitorDetail({
    gateway,
    userId,
    watchlistId: selectedWatchlistId,
    periodDays,
    enabled: selectedWatchlistId !== null,
  });

  const removeMutation = useRemoveCompetitor({ gateway, userId });
  const reactivateMutation = useReactivateCompetitor({ gateway, userId });
  const retryMutation = useRetryCompetitorCollection({ gateway, userId });

  const reactivateGuard = useCompetitorPendingGuard(reactivateMutation);
  const retryGuard = useCompetitorPendingGuard(retryMutation);

  const sync = useCompetitorSyncStatus({
    gateway,
    userId,
    watchlistId: pollingWatchlistId,
    enabled: pollingWatchlistId !== null,
  });

  const quotaState = useMemo(() => formatQuota(quota.quota), [quota.quota]);

  // An owner change abandons the poll of the previous owner: the poll
  // belongs to the session that started it (spec §4).
  useEffect(() => {
    setPollingWatchlistId(null);
    setSelectedWatchlistId(null);
    setRemoveTarget(null);
    setNotice(null);
  }, [userId]);

  const collectionStatus = useCallback(
    (watchlistId: string) =>
      pollingWatchlistId === watchlistId ? sync.collection : null,
    [pollingWatchlistId, sync.collection],
  );

  const focusListHeading = useCallback(() => {
    // The removed row is gone, so the focus cannot return to it. The
    // heading of the list is the next best place for it to land.
    window.requestAnimationFrame(() => headingRef.current?.focus());
  }, []);

  const handleRetryCollection = useCallback(
    (entry: CompetitorReportEntry) => {
      setNotice(null);
      retryMutation.mutate(entry.watchlist_id, {
        onSuccess: (result) => {
          if (result.outcome === "accepted") {
            // An accepted enqueue means QUEUED. It is not a collected
            // snapshot, and the screen says so.
            setPollingWatchlistId(entry.watchlist_id);
            setNotice({
              tone: "info",
              text: t("competitors.trackedQueued", "Tracked; the first snapshot is queued."),
            });
            return;
          }
          setNotice({
            tone: "error",
            text: copy.throttled(result.retryAfterSeconds),
          });
        },
        onError: (error) => {
          setNotice({
            tone: "error",
            text: competitorErrorMessage(copy, error as CompetitorTrackingError, quotaState.limit),
          });
        },
      });
    },
    [copy, quotaState.limit, retryMutation, t],
  );

  const handleConfirmRemove = useCallback(() => {
    if (removeTarget === null) return;
    setNotice(null);
    removeMutation.mutate(removeTarget.watchlist_id, {
      onSuccess: (result) => {
        if (result.outcome === "removed") {
          setRemoveTarget(null);
          focusListHeading();
          return;
        }
        if (result.outcome === "indeterminate") {
          // The row may or may not be removed. The screen does not
          // claim a removal it could not observe.
          setNotice({
            tone: "error",
            text: t("competitors.outcomeUnknown", "Could not confirm the change. Reload to check."),
          });
        }
      },
      onError: (error) => {
        setNotice({
          tone: "error",
          text: competitorErrorMessage(copy, error as CompetitorTrackingError, quotaState.limit),
        });
      },
    });
  }, [copy, focusListHeading, quotaState.limit, removeMutation, removeTarget, t]);

  const handleReactivate = useCallback(
    (entry: CompetitorReportEntry) => {
      setNotice(null);
      reactivateMutation.mutate(entry.watchlist_id, {
        onSuccess: (result) => {
          if (result.outcome === "reactivated_and_queued") {
            setPollingWatchlistId(entry.watchlist_id);
            setNotice({
              tone: "info",
              text: t("competitors.trackedQueued", "Tracked; the first snapshot is queued."),
            });
            return;
          }
          if (result.outcome === "reactivated_enqueue_unconfirmed") {
            setNotice({
              tone: "error",
              text: t(
                "competitors.trackedEnqueueFailed",
                "Tracked; collection could not be confirmed.",
              ),
            });
            return;
          }
          if (result.outcome === "indeterminate") {
            setNotice({
              tone: "error",
              text: t("competitors.outcomeUnknown", "Could not confirm the change. Reload to check."),
            });
          }
        },
        onError: (error) => {
          setNotice({
            tone: "error",
            text: competitorErrorMessage(copy, error as CompetitorTrackingError, quotaState.limit),
          });
        },
      });
    },
    [copy, quotaState.limit, reactivateMutation, t],
  );

  const removeError = removeMutation.error
    ? competitorErrorMessage(copy, removeMutation.error as CompetitorTrackingError, quotaState.limit)
    : null;
  const removeIndeterminate =
    removeMutation.data !== undefined && removeMutation.data.outcome === "indeterminate";

  const syncNotice = useMemo(() => {
    if (sync.state === "exhausted") {
      return t("competitors.stillQueued", "Still queued; check status");
    }
    if (sync.state === "deferred" && sync.retryAt !== null) {
      return t("competitors.nextRetryAt", "Next attempt {{date}}", { date: sync.retryAt });
    }
    if (sync.state === "failed" && sync.error !== null) {
      return competitorErrorMessage(copy, sync.error);
    }
    return null;
  }, [copy, sync.error, sync.retryAt, sync.state, t]);

  return (
    <section className="space-y-4">
      <div className="flex flex-col gap-3 rounded-xl border border-border/70 bg-card p-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="text-sm font-semibold text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {t("competitors.tab", "Tracked competitors")}
          </h2>
          <p className="text-xs text-muted-foreground">
            {quotaState.available
              ? quotaState.unlimited
                ? t("competitors.unlimited", "Unlimited tracking")
                : t("competitors.quota", "{{used}} of {{limit}} tracked", {
                    used: quotaState.used ?? 0,
                    limit: quotaState.limit ?? 0,
                  })
              : t("competitors.quotaUnavailable", "Limit unavailable")}
          </p>
          {quotaState.available && !quotaState.unlimited && quotaState.remaining === 0 && (
            <Button asChild size="sm" variant="outline">
              <Link to="/pricing">{t("competitors.upgrade", "View plans")}</Link>
            </Button>
          )}
          {!quotaState.available && quota.error !== null && (
            <Button size="sm" variant="outline" onClick={quota.reload}>
              {t("competitors.retryRead", "Retry loading")}
            </Button>
          )}
        </div>

        <Tabs
          value={state}
          onValueChange={(value) => {
            setState(value as CompetitorListState);
            setSelectedWatchlistId(null);
            setNotice(null);
          }}
        >
          <TabsList>
            <TabsTrigger value="active">{t("competitors.active", "Active")}</TabsTrigger>
            <TabsTrigger value="removed">{t("competitors.removed", "Removed")}</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {notice !== null && (
        <Alert variant={notice.tone === "error" ? "destructive" : "default"}>
          <AlertTitle className="text-xs font-semibold">{notice.text}</AlertTitle>
        </Alert>
      )}

      <CompetitorList
        entries={list.entries}
        state={state}
        isLoading={list.isLoading}
        error={list.error}
        onRetryRead={list.reload}
        onOpenDetail={(watchlistId) => setSelectedWatchlistId(watchlistId)}
        onRetryCollection={handleRetryCollection}
        isRetryPending={retryGuard.isPending}
        onRemove={(entry) => {
          setNotice(null);
          setRemoveTarget(entry);
        }}
        onReactivate={handleReactivate}
        isReactivatePending={reactivateGuard.isPending}
        collectionStatus={collectionStatus}
        hasMore={list.hasMore}
        isLoadingMore={list.isLoadingMore}
        loadMoreError={list.loadMoreError}
        onLoadMore={list.loadMore}
      />

      <CompetitorDetailSheet
        open={selectedWatchlistId !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedWatchlistId(null);
        }}
        entry={detail.entry}
        media={detail.media}
        isLoading={detail.isLoading}
        error={detail.error}
        periodDays={periodDays}
        onSelectPeriod={setPeriodDays}
        onRetryRead={detail.reload}
        collection={collectionStatus(selectedWatchlistId ?? "")}
        onReactivate={
          detail.entry !== null && detail.entry.is_active === false
            ? () => handleReactivate(detail.entry as CompetitorReportEntry)
            : undefined
        }
        isReactivatePending={reactivateGuard.isPending(detail.entry?.watchlist_id ?? "")}
        hasMore={detail.hasMore}
        isLoadingMore={detail.isLoadingMore}
        onLoadMore={detail.loadMore}
      />

      <RemoveCompetitorDialog
        open={removeTarget !== null}
        onOpenChange={(open) => {
          if (!open && !removeMutation.isPending) setRemoveTarget(null);
        }}
        username={removeTarget?.username ?? ""}
        onConfirm={handleConfirmRemove}
        isPending={removeMutation.isPending}
        errorMessage={removeError}
        indeterminate={removeIndeterminate}
      />

      {/* The live region of the screen. It announces what changed and
          nothing else: a failed read is an alert, not a status. */}
      <p className="sr-only" role="status" aria-live="polite">
        {syncNotice ?? ""}
      </p>
      {sync.state === "polling" && (
        <p className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          {t("competitors.status.queued", "Queued")}
        </p>
      )}
    </section>
  );
}
