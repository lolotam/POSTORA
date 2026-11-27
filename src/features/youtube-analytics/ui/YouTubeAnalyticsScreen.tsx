import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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
import { useYouTubeAnalyticsBreakdown } from "../application/useYouTubeAnalyticsBreakdown";
import { useYouTubeVideoRetention } from "../application/useYouTubeVideoRetention";
import { trimTopVideosToFirstPage, useYouTubeTopVideos } from "../application/useYouTubeTopVideos";
import { usePurposeConsent } from "../application/usePurposeConsent";
import { startDateForWindow } from "../domain/format";
import { asYouTubeAnalyticsClientError } from "../domain/errors";
import { mergeTopVideoPages } from "../domain/topVideosView";
import { getAnalyticsPurposeText } from "../domain/purposeText";
import type { YouTubeAnalyticsCsvExportInput } from "../domain/exportCsv";
import {
  YOUTUBE_ANALYTICS_PERIOD_DAYS,
  YOUTUBE_ANALYTICS_TIME_ZONE,
  type YouTubeAnalyticsPeriodDays,
  type YouTubeAnalyticsRequestedWindow,
} from "../domain/types";
import { defaultYouTubeAnalyticsGateway } from "../infrastructure/supabaseYouTubeAnalyticsGateway";
import { AnalyticsNotice } from "./AnalyticsNotice";
import { AnalyticsTabs, type YouTubeAnalyticsTab } from "./AnalyticsTabs";
import { BreakdownTable, type YouTubeBreakdownLabels } from "./BreakdownTable";
import { ExportMenu } from "./ExportMenu";
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

/**
 * Country names come from the platform's own region database, so an unknown
 * code is the only case that needs a fallback label.
 */
function createRegionNames(locale: string): Intl.DisplayNames | null {
  try {
    return new Intl.DisplayNames([locale], { type: "region" });
  } catch {
    return null;
  }
}

function resolveCountryName(code: string, regionNames: Intl.DisplayNames | null): string | null {
  if (!regionNames) return null;
  try {
    const name = regionNames.of(code);
    return name && name !== code ? name : null;
  } catch {
    return null;
  }
}

/**
 * The names of the three breakdown dimensions.
 *
 * The screen owns them because the CSV export needs the very same names, so a
 * downloaded file and the table on screen never disagree. An unknown provider
 * enum keeps its raw code next to the fallback label, otherwise the row would
 * be unidentifiable.
 */
function buildBreakdownLabels(t: TFunction, locale: string): YouTubeBreakdownLabels {
  const regionNames = createRegionNames(locale);
  const deviceLabels: Record<string, string> = {
    MOBILE: t("youtube.devices.types.MOBILE", "Mobile"),
    DESKTOP: t("youtube.devices.types.DESKTOP", "Desktop"),
    TV: t("youtube.devices.types.TV", "TV"),
    TABLET: t("youtube.devices.types.TABLET", "Tablet"),
    GAME_CONSOLE: t("youtube.devices.types.GAME_CONSOLE", "Game console"),
    UNKNOWN_PLATFORM: t("youtube.devices.types.UNKNOWN_PLATFORM", "Unknown platform"),
  };
  const trafficSourceLabels: Record<string, string> = {
    YT_SEARCH: t("youtube.traffic.sources.YT_SEARCH", "YouTube search"),
    RELATED_VIDEO: t("youtube.traffic.sources.RELATED_VIDEO", "Suggested videos"),
    SUBSCRIBER: t("youtube.traffic.sources.SUBSCRIBER", "Channel subscribers"),
    EXT_URL: t("youtube.traffic.sources.EXT_URL", "External websites"),
    YT_CHANNEL: t("youtube.traffic.sources.YT_CHANNEL", "Other YouTube channels"),
    PLAYLIST: t("youtube.traffic.sources.PLAYLIST", "Playlists"),
    NOTIFICATION: t("youtube.traffic.sources.NOTIFICATION", "Notifications"),
    SHORTS: t("youtube.traffic.sources.SHORTS", "YouTube Shorts"),
    END_SCREEN: t("youtube.traffic.sources.END_SCREEN", "End screens"),
    ADVERTISING: t("youtube.traffic.sources.ADVERTISING", "Ads"),
    NO_LINK_OTHER: t("youtube.traffic.sources.NO_LINK_OTHER", "Other"),
  };
  return {
    country: (code) => {
      const name = resolveCountryName(code, regionNames);
      return name ?? `${t("youtube.geography.other", "Other")} (${code})`;
    },
    device: (key) => deviceLabels[key] ?? `${t("youtube.devices.types.OTHER", "Other")} (${key})`,
    trafficSource: (key) => trafficSourceLabels[key] ?? `${t("youtube.traffic.sources.OTHER", "Other")} (${key})`,
  };
}

function earlierIsoTimestamp(left?: string, right?: string): string | undefined {
  if (left && right) return left <= right ? left : right;
  return left ?? right;
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
  const [activeTab, setActiveTab] = useState<YouTubeAnalyticsTab>("overview");
  const [visitedByContext, setVisitedByContext] = useState<{
    contextKey: string;
    tabs: ReadonlySet<YouTubeAnalyticsTab>;
  }>(() => ({
    contextKey: "",
    tabs: new Set<YouTubeAnalyticsTab>(["overview"]),
  }));
  const [retentionExpandedByVideo, setRetentionExpandedByVideo] = useState<{
    videoKey: string;
    expanded: boolean;
  }>({ videoKey: "", expanded: false });
  const initialVideoApplied = useRef(false);
  const videoOpenerRef = useRef<HTMLElement | null>(null);
  const reportRootRef = useRef<HTMLDivElement | null>(null);

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

  useEffect(() => {
    let previouslyClosed: HTMLDetailsElement[] = [];
    const onBeforePrint = () => {
      previouslyClosed = Array.from(
        document.querySelectorAll<HTMLDetailsElement>(".youtube-analytics-report details, [role='dialog'] details"),
      ).filter((el) => !el.open);
      for (const el of previouslyClosed) el.open = true;
    };
    const onAfterPrint = () => {
      for (const el of previouslyClosed) el.open = false;
      previouslyClosed = [];
    };
    window.addEventListener("beforeprint", onBeforePrint);
    window.addEventListener("afterprint", onAfterPrint);
    return () => {
      window.removeEventListener("beforeprint", onBeforePrint);
      window.removeEventListener("afterprint", onAfterPrint);
    };
  }, []);

  const selectedVideoId = pickedVideo?.accountId === activeAccountId ? pickedVideo.videoId : null;
  const access = useYouTubeAnalyticsStatus({ userId, accountId: activeAccountId, gateway });
  const contextKey = `${activeAccountId ?? ""}:${periodDays}:${access.windowEnd ?? ""}`;
  const videoContextKey = `${contextKey}:${selectedVideoId ?? ""}`;
  const visitedInContext = visitedByContext.contextKey === contextKey
    ? visitedByContext.tabs
    : new Set<YouTubeAnalyticsTab>([activeTab]);
  const retentionExpanded = selectedVideoId !== null
    && retentionExpandedByVideo.videoKey === videoContextKey
    && retentionExpandedByVideo.expanded;
  const setRetentionExpanded = (expanded: boolean) => {
    setRetentionExpandedByVideo({ videoKey: videoContextKey, expanded });
  };
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

  // A breakdown is requested the first time its tab is opened in the current
  // (account, period, window) context, evaluated synchronously during render so
  // changing period/channel never triggers a fetch for an inactive tab.
  const audienceVisited = activeTab === "audience" || visitedInContext.has("audience");
  const trafficVisited = activeTab === "traffic" || visitedInContext.has("traffic");
  const geography = useYouTubeAnalyticsBreakdown({
    ...reportParams,
    operation: "geography",
    enabled: access.mayFetch && audienceVisited,
  });
  const devices = useYouTubeAnalyticsBreakdown({
    ...reportParams,
    operation: "devices",
    enabled: access.mayFetch && audienceVisited,
  });
  const trafficSources = useYouTubeAnalyticsBreakdown({
    ...reportParams,
    operation: "traffic_sources",
    enabled: access.mayFetch && trafficVisited,
  });

  useEffect(() => {
    trimTopVideosToFirstPage(queryClient, topVideosKey);
  }, [activeAccountId, periodDays, access.windowEnd, queryClient, topVideosKey]);

  const videoSummary = useYouTubeAnalyticsSummary({ ...reportParams, videoId: selectedVideoId, enabled: access.mayFetch && selectedVideoId !== null });
  const videoDaily = useYouTubeAnalyticsDaily({ ...reportParams, videoId: selectedVideoId, enabled: access.mayFetch && selectedVideoId !== null });
  const retention = useYouTubeVideoRetention({
    ...reportParams,
    videoId: selectedVideoId,
    enabled: access.mayFetch && retentionExpanded,
  });
  const consent = usePurposeConsent({
    gateway,
    userId,
    accountId: activeAccountId,
    locale,
    onAccepted: () => access.refreshStatus(),
    onWithdrawn: access.markWithdrawn,
  });

  const requestedWindow = useMemo<YouTubeAnalyticsRequestedWindow | null>(() => access.windowEnd ? {
    start_date: startDateForWindow(access.windowEnd, periodDays),
    end_date: access.windowEnd,
    days: periodDays,
    time_zone: YOUTUBE_ANALYTICS_TIME_ZONE,
  } : null, [access.windowEnd, periodDays]);

  const breakdownLabels = useMemo<YouTubeBreakdownLabels>(
    () => buildBreakdownLabels(t, locale),
    [locale, t],
  );

  const changeTab = (tab: YouTubeAnalyticsTab) => {
    setActiveTab(tab);
    setVisitedByContext((previous) => {
      const base = previous.contextKey === contextKey ? previous.tabs : new Set<YouTubeAnalyticsTab>([activeTab]);
      if (base.has(tab) && previous.contextKey === contextKey) return previous;
      const next = new Set(base);
      next.add(tab);
      return { contextKey, tabs: next };
    });
  };

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
        ...(selectedVideoId && retentionExpanded ? [retention.refetch()] : []),
        ...(audienceVisited ? [geography.refetch(), devices.refetch()] : []),
        ...(trafficVisited ? [trafficSources.refetch()] : []),
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
      if (retentionExpanded) {
        void retention.refetch();
      }
    }
    if (audienceVisited) {
      void geography.refetch();
      void devices.refetch();
    }
    if (trafficVisited) {
      void trafficSources.refetch();
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

  const exportInput = useMemo<YouTubeAnalyticsCsvExportInput | null>(() => {
    if (!requestedWindow || !activeAccount) return null;
    const overviewFetchedAt = earlierIsoTimestamp(
      summary.data?.freshness.fetched_at,
      daily.data?.freshness.fetched_at,
    ) ?? topVideos.data?.pages[0]?.freshness.fetched_at;
    const audienceFetchedAt = earlierIsoTimestamp(
      geography.data?.freshness.fetched_at,
      devices.data?.freshness.fetched_at,
    );
    const trafficFetchedAt = trafficSources.data?.freshness.fetched_at;
    const tabFetchedAt = activeTab === "overview"
      ? overviewFetchedAt
      : activeTab === "audience"
        ? audienceFetchedAt
        : trafficFetchedAt;
    return {
      tab: activeTab,
      channelTitle: activeAccount.title,
      window: requestedWindow,
      fetchedAt: tabFetchedAt ?? overviewFetchedAt ?? new Date().toISOString(),
      summary: summary.data?.data ?? null,
      daily: daily.data?.data ?? null,
      topVideos: loadedTopVideos,
      geography: geography.data?.data ?? null,
      devices: devices.data?.data ?? null,
      trafficSources: trafficSources.data?.data ?? null,
      resolveCountryLabel: breakdownLabels.country,
      resolveDeviceLabel: breakdownLabels.device,
      resolveTrafficSourceLabel: breakdownLabels.trafficSource,
    };
  }, [
    activeAccount, activeTab, breakdownLabels, daily.data, geography.data,
    loadedTopVideos, requestedWindow, summary.data, topVideos.data, trafficSources.data, devices.data,
  ]);

  const activeTabHasData = activeTab === "overview"
    ? Boolean(summary.data || daily.data || topVideos.data)
    : activeTab === "audience"
      ? Boolean(geography.data || devices.data)
      : Boolean(trafficSources.data);

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
    <div ref={reportRootRef} className="youtube-analytics-report space-y-5" dir={locale === "ar" ? "rtl" : "ltr"}>
      <div>
        <h1 className="text-2xl font-semibold">{t("youtube.title", "YouTube Analytics")}</h1>
        <p className="text-sm text-muted-foreground">{t("youtube.subtitle", "On-demand numbers for your own channel. Postora does not store them.")}</p>
      </div>

      <div className="no-print flex flex-wrap items-end gap-3 rounded-lg border p-3">
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
        {access.mayShow && requestedWindow && exportInput ? (
          <ExportMenu input={exportInput} disabled={!activeTabHasData} />
        ) : null}
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
        <div className="space-y-4">
          <AnalyticsTabs active={activeTab} onChange={changeTab} />
          <div
            role="tabpanel"
            tabIndex={0}
            id={`youtube-analytics-panel-${activeTab}`}
            aria-labelledby={`youtube-analytics-tab-${activeTab}`}
            className="space-y-4"
          >
            {activeTab === "overview" ? (
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
            {activeTab === "audience" ? (
              <>
                {geography.isError ? <AnalyticsNotice error={geography.error} onRetry={() => void geography.refetch()} />
                  : geography.data ? <BreakdownTable data={geography.data.data} operation="geography" labels={breakdownLabels} />
                    : <p role="status" className="text-sm text-muted-foreground">{t("youtube.loading", "Loading…")}</p>}
                {devices.isError ? <AnalyticsNotice error={devices.error} onRetry={() => void devices.refetch()} />
                  : devices.data ? <BreakdownTable data={devices.data.data} operation="devices" labels={breakdownLabels} />
                    : <p role="status" className="text-sm text-muted-foreground">{t("youtube.loading", "Loading…")}</p>}
              </>
            ) : null}
            {activeTab === "traffic" ? (
              trafficSources.isError ? <AnalyticsNotice error={trafficSources.error} onRetry={() => void trafficSources.refetch()} />
                : trafficSources.data ? <BreakdownTable data={trafficSources.data.data} operation="traffic_sources" labels={breakdownLabels} />
                  : <p role="status" className="text-sm text-muted-foreground">{t("youtube.loading", "Loading…")}</p>
            ) : null}
          </div>
        </div>
      ) : null}
      {access.status?.consent.state === "accepted" ? (
        <div className="no-print space-y-2 border-t pt-3 text-xs text-muted-foreground">
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
          retention={retention}
          retentionExpanded={retentionExpanded}
          onExpandRetention={setRetentionExpanded}
        />
      ) : null}
    </div>
  );
}
