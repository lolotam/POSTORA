import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { LtrValue } from "./LtrValue";
import type { YouTubeAnalyticsGateway } from "../application/ports";
import { useYouTubeAnalyticsStatus } from "../application/useYouTubeAnalyticsStatus";
import { useYouTubeAnalyticsSummary } from "../application/useYouTubeAnalyticsSummary";
import { useYouTubeAnalyticsDaily } from "../application/useYouTubeAnalyticsDaily";
import { trimTopVideosToFirstPage, useYouTubeTopVideos } from "../application/useYouTubeTopVideos";
import { usePurposeConsent } from "../application/usePurposeConsent";
import { startDateForWindow } from "../domain/format";
import { asYouTubeAnalyticsClientError } from "../domain/errors";
import { mergeTopVideoPages } from "../domain/topVideosView";
import { getAnalyticsPurposeText } from "../domain/purposeText";
import {
  YOUTUBE_ANALYTICS_PERIOD_DAYS,
  YOUTUBE_ANALYTICS_TIME_ZONE,
  type YouTubeAnalyticsPeriodDays,
} from "../domain/types";
import { defaultYouTubeAnalyticsGateway } from "../infrastructure/supabaseYouTubeAnalyticsGateway";
import { AnalyticsNotice } from "./AnalyticsNotice";
import { PurposeAcceptancePanel } from "./PurposeAcceptancePanel";
import { OverviewCards } from "./OverviewCards";
import { DailyTrend } from "./DailyTrend";
import { TopVideosTable } from "./TopVideosTable";
import { VideoAnalyticsSheet } from "./VideoAnalyticsSheet";

export interface YouTubeAnalyticsAccount {
  id: string;
  title: string;
  avatarUrl?: string | null;
  provider?: "native" | "composio";
}

export interface YouTubeAnalyticsScreenProps {
  userId: string;
  accounts: readonly YouTubeAnalyticsAccount[];
  accountsLoading: boolean;
  accountsError?: unknown;
  onRetryAccounts?: () => void;
  initialVideoId?: string | null;
  initialAccountId?: string | null;
  gateway?: YouTubeAnalyticsGateway;
}

export function YouTubeAnalyticsScreen(props: YouTubeAnalyticsScreenProps): JSX.Element {
  const {
    userId, accounts, accountsLoading, accountsError, onRetryAccounts,
    initialVideoId = null, initialAccountId = null,
    gateway = defaultYouTubeAnalyticsGateway,
  } = props;
  const { t, i18n } = useTranslation("analytics");
  const queryClient = useQueryClient();
  const locale = i18n.language.startsWith("ar") ? "ar" : "en";
  const purposeText = getAnalyticsPurposeText(locale);
  const [pickedAccountId, setPickedAccountId] = useState<string | null>(initialAccountId);
  const [periodDays, setPeriodDays] = useState<YouTubeAnalyticsPeriodDays>(30);
  const [pickedVideo, setPickedVideo] = useState<{ accountId: string; videoId: string } | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const initialVideoApplied = useRef(false);
  const videoOpenerRef = useRef<HTMLElement | null>(null);

  const activeAccountId = pickedAccountId && accounts.some((account) => account.id === pickedAccountId)
    ? pickedAccountId
    : accounts[0]?.id ?? null;
  const activeAccount = accounts.find((account) => account.id === activeAccountId) ?? null;

  useEffect(() => {
    if (!initialVideoApplied.current && initialVideoId && activeAccountId) {
      initialVideoApplied.current = true;
      setPickedVideo({ accountId: activeAccountId, videoId: initialVideoId });
    }
  }, [activeAccountId, initialVideoId]);

  const selectedVideoId = pickedVideo?.accountId === activeAccountId ? pickedVideo.videoId : null;
  const access = useYouTubeAnalyticsStatus({ userId, accountId: activeAccountId, gateway });
  const reportParams = {
    gateway,
    userId,
    accountId: activeAccountId,
    connectionRevision: access.connectionRevision,
    windowEnd: access.windowEnd,
    periodDays,
    enabled: access.mayFetch,
    onError: access.reportDataError,
  };
  const summary = useYouTubeAnalyticsSummary(reportParams);
  const daily = useYouTubeAnalyticsDaily(reportParams);
  const topVideos = useYouTubeTopVideos(reportParams);
  const topVideosKey = topVideos.queryKey;
  useEffect(() => {
    trimTopVideosToFirstPage(queryClient, topVideosKey);
  }, [activeAccountId, periodDays, access.windowEnd, queryClient, topVideosKey]);
  const videoSummary = useYouTubeAnalyticsSummary({ ...reportParams, videoId: selectedVideoId, enabled: access.mayFetch && selectedVideoId !== null });
  const videoDaily = useYouTubeAnalyticsDaily({ ...reportParams, videoId: selectedVideoId, enabled: access.mayFetch && selectedVideoId !== null });
  const consent = usePurposeConsent({
    gateway,
    userId,
    accountId: activeAccountId,
    locale,
    onAccepted: () => access.refreshStatus(),
    onWithdrawn: access.markWithdrawn,
  });

  const requestedWindow = useMemo(() => access.windowEnd ? {
    start_date: startDateForWindow(access.windowEnd, periodDays),
    end_date: access.windowEnd,
    days: periodDays,
    time_zone: YOUTUBE_ANALYTICS_TIME_ZONE,
  } : null, [access.windowEnd, periodDays]);

  const refreshReports = async () => {
    setIsRefreshing(true);
    try {
      await queryClient.cancelQueries({ queryKey: topVideosKey });
      trimTopVideosToFirstPage(queryClient, topVideosKey);
      const previousWindow = access.windowEnd;
      const status = await access.refreshStatus({ advanceWindow: true });
      await queryClient.cancelQueries({ queryKey: topVideosKey });
      trimTopVideosToFirstPage(queryClient, topVideosKey);
      if (!status || status.reporting_end_date !== previousWindow || access.latchedError) return;
      await Promise.all([
        summary.refetch(),
        daily.refetch(),
        topVideos.refetch(),
        ...(selectedVideoId ? [videoSummary.refetch(), videoDaily.refetch()] : []),
      ]);
    } finally {
      setIsRefreshing(false);
    }
  };

  const handleAllowConsent = async () => {
    try {
      let revision = acceptRevision;
      if (!revision) {
        const fresh = await access.refreshStatus();
        revision = fresh?.connection_revision ?? access.denial?.connectionRevision ?? null;
      }
      if (!revision) return;
      await consent.accept(revision);
    } catch (error) {
      if ((error as { code?: string })?.code === "connection_changed") {
        await access.refreshStatus();
      }
    }
  };

  const retryLatchedReports = () => {
    void queryClient.cancelQueries({ queryKey: topVideosKey });
    trimTopVideosToFirstPage(queryClient, topVideosKey);
    access.clearLatchForRetry();
    void summary.refetch();
    void daily.refetch();
    void topVideos.refetch();
    if (selectedVideoId) {
      void videoSummary.refetch();
      void videoDaily.refetch();
    }
  };

  const inspectVideo = (videoId: string) => {
    if (!activeAccountId) return;
    videoOpenerRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPickedVideo({ accountId: activeAccountId, videoId });
  };
  const closeVideo = () => {
    setPickedVideo(null);
    setTimeout(() => videoOpenerRef.current?.focus(), 0);
  };
  const loadedTopVideos = useMemo(() => mergeTopVideoPages(topVideos.data?.pages ?? []), [topVideos.data?.pages]);
  const selectedTopVideo = loadedTopVideos.find((row) => row.video_id === selectedVideoId);
  const loadNextTopVideosPage = () => {
    if (isRefreshing) return;
    void topVideos.fetchNextPage();
  };
  const retryNextTopVideosPage = () => {
    if (isRefreshing) return;
    if (topVideos.error && asYouTubeAnalyticsClientError(topVideos.error).code === "window_stale") {
      trimTopVideosToFirstPage(queryClient, topVideosKey);
      void refreshReports();
      return;
    }
    if (topVideos.isFetchNextPageError) {
      void topVideos.fetchNextPage();
      return;
    }
    void topVideos.refetch();
  };

  if (accountsLoading) {
    return <p role="status" className="text-sm text-muted-foreground">{t("youtube.loading", "Loading…")}</p>;
  }
  if (accountsError) {
    return <div className="space-y-3"><AnalyticsNotice error="upstream_unavailable" onRetry={onRetryAccounts} /></div>;
  }
  if (accounts.length === 0) {
    return (
      <div className="space-y-3 rounded-lg border p-4">
        <p className="text-sm">{t("youtube.noAccounts", "No YouTube channel is connected yet.")}</p>
        <Button asChild size="sm" variant="outline"><Link to="/profiles">{t("youtube.openProfiles", "Open Profiles")}</Link></Button>
      </div>
    );
  }

  const consentRequired = access.denial?.code === "consent_required";
  const acceptRevision = access.denial?.connectionRevision ?? access.connectionRevision;

  return (
    <div className="space-y-5" dir={locale === "ar" ? "rtl" : "ltr"}>
      <div>
        <h1 className="text-2xl font-semibold">{t("youtube.title", "YouTube Analytics")}</h1>
        <p className="text-sm text-muted-foreground">{t("youtube.subtitle", "On-demand numbers for your own channel. Postora does not store them.")}</p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-lg border p-3">
        <label className="space-y-1 text-sm">
          <span className="block">{t("youtube.channel", "Channel")}</span>
          <select
            aria-label={t("youtube.channel", "Channel")}
            className="min-w-48 rounded-md border bg-background px-3 py-2"
            value={activeAccountId ?? ""}
            onChange={(event) => {
              setPickedAccountId(event.target.value);
              setPickedVideo(null);
            }}
          >
            {accounts.map((account) => <option key={account.id} value={account.id}>{account.title}</option>)}
          </select>
        </label>
        <label className="space-y-1 text-sm">
          <span className="block">{t("youtube.period", "Period")}</span>
          <select
            aria-label={t("youtube.period", "Period")}
            className="rounded-md border bg-background px-3 py-2"
            value={periodDays}
            onChange={(event) => {
              access.advancePinnedWindow();
              setPeriodDays(Number(event.target.value) as YouTubeAnalyticsPeriodDays);
            }}
          >
            {YOUTUBE_ANALYTICS_PERIOD_DAYS.map((days) => <option key={days} value={days}>{t("youtube.lastDays", "Last {{days}} days", { days })}</option>)}
          </select>
        </label>
        <Button type="button" variant="outline" disabled={access.checkingAccess} onClick={() => void refreshReports()}>{t("youtube.refresh", "Refresh")}</Button>
      </div>

      {requestedWindow ? (
        <p className="text-sm text-muted-foreground">
          {t("youtube.periodLine", "Period:")} <LtrValue>{requestedWindow.start_date} – {requestedWindow.end_date}</LtrValue>, {t("youtube.pacificTime", "Pacific time")}
        </p>
      ) : null}

      {consentRequired && activeAccount ? (
        <PurposeAcceptancePanel
          channelName={activeAccount.title}
          locale={locale}
          busy={consent.accepting}
          error={consent.acceptError}
          onAllow={() => void handleAllowConsent()}
        />
      ) : access.denial ? (
        <AnalyticsNotice error={access.denial} onRetry={() => void access.refreshStatus()} />
      ) : access.latchedError ? (
        <AnalyticsNotice error={access.latchedError} onRetry={retryLatchedReports} />
      ) : !access.mayShow ? (
        <div className="space-y-3">
          <p role="status" className="text-sm text-muted-foreground">{t("youtube.checkingAccess", "Checking access…")}</p>
          {access.statusError ? <AnalyticsNotice error={access.statusError} onRetry={() => void access.refreshStatus()} /> : null}
        </div>
      ) : requestedWindow ? (
        <>
          {summary.isError ? <AnalyticsNotice error={summary.error} onRetry={() => void summary.refetch()} />
            : summary.data ? <OverviewCards data={summary.data.data} />
              : <p role="status" className="text-sm text-muted-foreground">{t("youtube.loading", "Loading…")}</p>}
          {daily.isError ? <AnalyticsNotice error={daily.error} onRetry={() => void daily.refetch()} />
            : daily.data ? <DailyTrend data={daily.data.data} requestedWindow={requestedWindow} />
              : <p role="status" className="text-sm text-muted-foreground">{t("youtube.loading", "Loading…")}</p>}
          {topVideos.isError && !topVideos.data ? <AnalyticsNotice error={topVideos.error} onRetry={() => void topVideos.refetch()} />
            : topVideos.data ? (
              <TopVideosTable
                data={topVideos.data}
                onInspect={inspectVideo}
                hasNextPage={topVideos.hasNextPage}
                isFetchingNextPage={topVideos.isFetchingNextPage || isRefreshing}
                onLoadMore={loadNextTopVideosPage}
                nextPageError={topVideos.error}
                onRetryNextPage={retryNextTopVideosPage}
              />
            ) : <p role="status" className="text-sm text-muted-foreground">{t("youtube.loading", "Loading…")}</p>}
        </>
      ) : null}
      {access.status?.consent.state === "accepted" ? (
        <div className="space-y-2 border-t pt-3 text-xs text-muted-foreground">
          {consent.withdrawError ? <AnalyticsNotice error={consent.withdrawError} /> : null}
          <div className="flex flex-wrap items-center gap-2">
            <span>{purposeText.permissionLine}</span>
            <AlertDialog>
              <AlertDialogTrigger asChild><Button type="button" size="sm" variant="ghost">{purposeText.withdrawTrigger}</Button></AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{purposeText.withdrawTrigger}</AlertDialogTitle>
                  <AlertDialogDescription>{purposeText.withdrawConfirmBody}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{purposeText.withdrawCancelAction}</AlertDialogCancel>
                  <AlertDialogAction disabled={consent.withdrawing} onClick={() => void consent.withdraw().catch(() => {})}>{purposeText.withdrawConfirmAction}</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      ) : null}
      {access.mayShow && selectedVideoId && requestedWindow ? (
        <VideoAnalyticsSheet
          open
          onOpenChange={(open) => {
            if (!open) closeVideo();
          }}
          locale={locale}
          title={selectedTopVideo?.title}
          videoId={selectedVideoId}
          requestedWindow={requestedWindow}
          summary={videoSummary}
          daily={videoDaily}
        />
      ) : null}
    </div>
  );
}
