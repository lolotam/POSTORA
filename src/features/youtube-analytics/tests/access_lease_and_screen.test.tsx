import type { ReactNode } from "react";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { YouTubeAnalyticsScreen } from "../ui/YouTubeAnalyticsScreen";
import { useAccessLease } from "../application/useAccessLease";
import type { YouTubeAnalyticsGateway } from "../application/ports";
import type { YouTubeAnalyticsStatusData, YouTubeAnalyticsSuccess } from "../domain/types";
import {
  ACCOUNT_ID, dailyData, makeGateway, NEW_REVISION, OTHER_ACCOUNT_ID, refusal,
  REVISION, statusData, success, summaryData, topVideosData, USER_ID, VIDEO_ID,
} from "./fixtures";

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  LineChart: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Line: (props: { connectNulls?: boolean }) => <div data-testid="trend-line" data-connect-nulls={String(props.connectNulls)} />,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
}));

const accounts = [{ id: ACCOUNT_ID, title: "Fixture channel" }, { id: OTHER_ACCOUNT_ID, title: "Other channel" }];

function client() {
  return new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
}

async function renderScreen(gateway: YouTubeAnalyticsGateway, options: {
  queryClient?: QueryClient;
  locale?: "en" | "ar";
  initialVideoId?: string | null;
  initialAccountId?: string | null;
} = {}) {
  const queryClient = options.queryClient ?? client();
  const i18n = createInstance();
  await i18n.init({ lng: options.locale ?? "en", resources: { en: { analytics: {} }, ar: { analytics: {} } }, defaultNS: "analytics" });
  const view = render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <I18nextProvider i18n={i18n}>
          <YouTubeAnalyticsScreen
            userId={USER_ID}
            accounts={accounts}
            accountsLoading={false}
            gateway={gateway}
            initialVideoId={options.initialVideoId}
            initialAccountId={options.initialAccountId}
          />
        </I18nextProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
  return { queryClient, i18n, ...view };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("cached reports and refusal bounds", () => {
  it("shows cached reports after a 31-minute lapse and same-revision status with zero extra data calls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
    const gateway = makeGateway();
    await renderScreen(gateway);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("Fixture video")).toBeInTheDocument();
    expect(gateway.summary).toHaveBeenCalledTimes(1);
    expect(gateway.daily).toHaveBeenCalledTimes(1);
    expect(gateway.topVideos).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(31 * 60_000); });
    await flush();
    expect(screen.getByText("Fixture video")).toBeInTheDocument();
    expect(gateway.status).toHaveBeenCalled();
    expect(gateway.summary).toHaveBeenCalledTimes(1);
    expect(gateway.daily).toHaveBeenCalledTimes(1);
    expect(gateway.topVideos).toHaveBeenCalledTimes(1);
  });

  it("restores cached reports after a real lease expiry without any new data call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
    const gateway = makeGateway({
      status: vi.fn()
        .mockImplementationOnce(async () => success(statusData(), REVISION, false))
        .mockImplementation(async () => { throw refusal("settings_unavailable"); }),
    });
    await renderScreen(gateway);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("Fixture video")).toBeInTheDocument();

    await act(async () => { await vi.advanceTimersByTimeAsync(91_000); });
    expect(screen.queryByText("Fixture video")).not.toBeInTheDocument();
    expect(screen.getByText("Checking access…")).toBeInTheDocument();
    vi.mocked(gateway.status).mockImplementation(async () => success(statusData(), REVISION, false));
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("Fixture video")).toBeInTheDocument();
    expect(gateway.summary).toHaveBeenCalledTimes(1);
    expect(gateway.daily).toHaveBeenCalledTimes(1);
    expect(gateway.topVideos).toHaveBeenCalledTimes(1);
  });

  it("clears the previous account's cached reports on channel switch", async () => {
    const queryClient = client();
    const gateway = makeGateway({
      topVideos: vi.fn(async (params) => success(topVideosData(params.accountId === OTHER_ACCOUNT_ID ? "Other video" : "Fixture video"))),
    });
    await renderScreen(gateway, { queryClient });
    await screen.findByText("Fixture video");
    fireEvent.change(screen.getByLabelText("Channel"), { target: { value: OTHER_ACCOUNT_ID } });
    expect(screen.queryByText("Fixture video")).not.toBeInTheDocument();
    expect(await screen.findByText("Other video")).toBeInTheDocument();
    await waitFor(() => {
      const oldReports = queryClient.getQueryCache().getAll().filter((query) => query.queryKey[0] === "youtube-analytics" && query.queryKey[2] === ACCOUNT_ID);
      expect(oldReports.every((query) => query.state.data === undefined)).toBe(true);
    });
  });

  it("not_enabled starts no report query and only a manual retry checks access again", async () => {
    const queryClient = client();
    const gateway = makeGateway({ status: vi.fn(async () => { throw refusal("not_enabled"); }) });
    const first = await renderScreen(gateway, { queryClient });
    expect(await screen.findByText(/not switched on for this channel/)).toBeInTheDocument();
    expect(gateway.summary).not.toHaveBeenCalled();
    expect(gateway.daily).not.toHaveBeenCalled();
    expect(gateway.topVideos).not.toHaveBeenCalled();
    fireEvent(window, new Event("online"));
    first.unmount();
    await renderScreen(gateway, { queryClient });
    await flush();
    expect(gateway.summary).not.toHaveBeenCalled();
    expect(gateway.daily).not.toHaveBeenCalled();
    expect(gateway.topVideos).not.toHaveBeenCalled();
    const statusCalls = vi.mocked(gateway.status).mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await flush();
    expect(gateway.status).toHaveBeenCalledTimes(statusCalls + 1);
  });

  it.each(["quota_exceeded", "capacity_reached", "rate_limited"] as const)(
    "%s causes one call per block, none on reconnect/remount, and one on Retry",
    async (code) => {
      const queryClient = client();
      const gateway = makeGateway({
        summary: vi.fn(async () => { throw refusal(code); }),
        daily: vi.fn(async () => { throw refusal(code); }),
        topVideos: vi.fn(async () => { throw refusal(code); }),
      });
      const first = await renderScreen(gateway, { queryClient });
      await screen.findAllByRole("alert");
      await waitFor(() => expect(gateway.topVideos).toHaveBeenCalledTimes(1));
      fireEvent(window, new Event("online"));
      first.unmount();
      await renderScreen(gateway, { queryClient });
      await flush();
      expect(gateway.summary).toHaveBeenCalledTimes(1);
      expect(gateway.daily).toHaveBeenCalledTimes(1);
      expect(gateway.topVideos).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]);
      await waitFor(() => expect(gateway.summary).toHaveBeenCalledTimes(2));
      expect(gateway.daily).toHaveBeenCalledTimes(1);
      expect(gateway.topVideos).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps independent blocks visible when one response has the wrong window", async () => {
    const gateway = makeGateway({
      summary: vi.fn(async () => ({ ...success(summaryData()), requested_window: { ...success(summaryData()).requested_window!, end_date: "2026-11-16" } })),
    });
    await renderScreen(gateway);
    expect(await screen.findByText("Fixture video")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent("could not load this analytics block");
    expect(screen.getByText("Daily trend")).toBeInTheDocument();
  });

  it("shows the refresh message for window_stale and sends nothing on network return", async () => {
    const gateway = makeGateway({ summary: vi.fn(async () => { throw refusal("window_stale"); }) });
    await renderScreen(gateway);
    expect(await screen.findByText(/Refresh to load the latest period/)).toBeInTheDocument();
    fireEvent(window, new Event("online"));
    await flush();
    expect(gateway.summary).toHaveBeenCalledTimes(1);
  });
});

describe("access lease epochs, issue time and backoff", () => {
  it("discards a pre-hide status answer and coalesces resume events", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
    const first = deferred<YouTubeAnalyticsSuccess<YouTubeAnalyticsStatusData>>();
    const gateway = makeGateway({ status: vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementation(async () => success(statusData(), REVISION, false)) });
    const queryClient = client();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useAccessLease({ userId: USER_ID, accountId: ACCOUNT_ID, gateway }), { wrapper });
    await flush();
    expect(gateway.status).toHaveBeenCalledTimes(1);

    act(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    act(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
      window.dispatchEvent(new Event("online"));
    });
    await flush();
    expect(gateway.status).toHaveBeenCalledTimes(2);
    expect(result.current.mayShow).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    first.resolve(success(statusData(), REVISION, false));
    await flush();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(result.current.mayShow).toBe(true);
    expect(gateway.summary).not.toHaveBeenCalled();
  });

  it("uses status issue time for the 90-second lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
    const first = deferred<YouTubeAnalyticsSuccess<YouTubeAnalyticsStatusData>>();
    const gateway = makeGateway({ status: vi.fn(() => first.promise) });
    const queryClient = client();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useAccessLease({ userId: USER_ID, accountId: ACCOUNT_ID, gateway }), { wrapper });
    await act(async () => { await vi.advanceTimersByTimeAsync(80_000); });
    first.resolve(success(statusData(), REVISION, false));
    await flush();
    expect(result.current.mayShow).toBe(true);
    expect(result.current.mayFetch).toBe(true);

    await act(async () => { await vi.advanceTimersByTimeAsync(11_000); });
    expect(result.current.mayShow).toBe(false);
    expect(result.current.mayFetch).toBe(true);
    expect(result.current.checkingAccess).toBe(true);
  });

  it("backs off 5s, 15s and 45s and honors a larger retry_after_seconds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T12:00:00Z"));
    const calls: number[] = [];
    const gateway = makeGateway({ status: vi.fn(async () => {
      calls.push(Date.now());
      throw refusal("settings_unavailable", { retryAfterSeconds: calls.length === 4 ? 120 : null });
    }) });
    const queryClient = client();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    renderHook(() => useAccessLease({ userId: USER_ID, accountId: ACCOUNT_ID, gateway }), { wrapper });
    await flush();
    for (const elapsed of [5_000, 15_000, 45_000, 120_000]) {
      await act(async () => { await vi.advanceTimersByTimeAsync(elapsed); });
      await flush();
    }
    expect(calls.slice(1).map((call, index) => call - calls[index])).toEqual([5_000, 15_000, 45_000, 120_000]);
  });
});

describe("provider latch and revision", () => {
  it("keeps missing_scope latched through same-revision status and clears only on explicit successful Retry", async () => {
    const gateway = makeGateway();
    const queryClient = client();
    const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
    const { result } = renderHook(() => useAccessLease({ userId: USER_ID, accountId: ACCOUNT_ID, gateway }), { wrapper });
    await flush();
    expect(result.current.mayShow).toBe(true);

    act(() => result.current.reportDataError(refusal("missing_scope", { detail: "grant_not_effective" })));
    expect(result.current.latchedError?.code).toBe("missing_scope");
    expect(result.current.latchedError?.detail).toBe("grant_not_effective");
    expect(result.current.mayFetch).toBe(false);
    expect(result.current.mayShow).toBe(false);

    await act(async () => { await result.current.refreshStatus(); });
    expect(result.current.status?.connection_revision).toBe(REVISION);
    expect(result.current.mayShow).toBe(false);
    expect(result.current.mayFetch).toBe(false);
    expect(result.current.latchedError?.code).toBe("missing_scope");
    expect(gateway.summary).not.toHaveBeenCalled();
    expect(gateway.daily).not.toHaveBeenCalled();
    expect(gateway.topVideos).not.toHaveBeenCalled();

    act(() => result.current.clearLatchForRetry());
    await act(async () => { await gateway.summary({ accountId: ACCOUNT_ID, periodDays: 30, windowEnd: "2026-11-17" }); });
    expect(result.current.latchedError).toBeNull();
    expect(gateway.summary).toHaveBeenCalledTimes(1);
  });

  it("clears the latch and purges old-revision cache when status returns a new revision", async () => {
    const queryClient = client();
    const gateway = makeGateway({
      status: vi.fn()
        .mockImplementationOnce(async () => success(statusData(), REVISION, false))
        .mockImplementation(async () => success(statusData(NEW_REVISION), NEW_REVISION, false)),
      summary: vi.fn()
        .mockRejectedValueOnce(refusal("reconnect_required"))
        .mockImplementation(async () => success(summaryData(), NEW_REVISION)),
      daily: vi.fn(async () => success(dailyData(), NEW_REVISION)),
      topVideos: vi.fn(async () => success(topVideosData(), NEW_REVISION)),
    });
    await renderScreen(gateway, { queryClient });
    await screen.findByText(/Reconnect this channel/);
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await screen.findByText("Fixture video");
    expect(gateway.summary).toHaveBeenCalledTimes(2);
    expect(queryClient.getQueryCache().getAll().some((query) => query.queryKey[3] === REVISION)).toBe(false);
  });
});

describe("video scope", () => {
  it("keeps channel reports when only the selected video is not found", async () => {
    const gateway = makeGateway({
      summary: vi.fn(async (params) => {
        if (params.videoId) throw refusal("video_not_found");
        return success(summaryData());
      }),
      daily: vi.fn(async (params) => {
        if (params.videoId) throw refusal("video_not_found");
        return success(dailyData());
      }),
    });
    await renderScreen(gateway, { initialVideoId: VIDEO_ID });
    expect(await screen.findAllByText(/not available on this channel/)).not.toHaveLength(0);
    expect(screen.getByText("Fixture video")).toBeInTheDocument();
    expect(screen.getByLabelText("Overview", { selector: "section" })).toBeInTheDocument();
    expect(screen.getByText("Daily trend")).toBeInTheDocument();
  });
});

describe("purpose acceptance and withdrawal", () => {
  it("renders all eight elements with zero data calls, Not now records nothing, and Allow loads reports", async () => {
    const gateway = makeGateway({
      status: vi.fn()
        .mockRejectedValueOnce(refusal("consent_required", { consent: { state: "none", version: 0 }, purposeVersion: 1 }))
        .mockImplementation(async () => success(statusData(), REVISION, false)),
    });
    await renderScreen(gateway);
    const panel = await screen.findByRole("heading", { name: "Allow YouTube Analytics for Fixture channel?" });
    const section = panel.closest("section")!;
    for (const key of ["channelHeading", "whatWeRead", "whyWeRead", "whoSeesIt", "onDemandNoStorage", "separateFromGoogle", "howToStop", "versionAndLinks"]) {
      expect(section.querySelector(`[data-purpose-element="${key}"]`)).toBeInTheDocument();
    }
    expect(gateway.summary).not.toHaveBeenCalled();
    expect(gateway.daily).not.toHaveBeenCalled();
    expect(gateway.topVideos).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(panel);

    fireEvent.click(screen.getByRole("button", { name: "Not now" }));
    expect(screen.getByText("Analytics is off for this channel until you allow it.")).toBeInTheDocument();
    expect(gateway.acceptConsent).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Allow analytics for this channel" }));
    await screen.findByText("Fixture video");
    expect(gateway.acceptConsent).toHaveBeenCalledWith({ accountId: ACCOUNT_ID, purposeVersion: 1, locale: "en", connectionRevision: REVISION });
    expect(gateway.summary).toHaveBeenCalledTimes(1);
  });

  it("renders the eight Arabic elements and records the displayed locale", async () => {
    const gateway = makeGateway({
      status: vi.fn()
        .mockRejectedValueOnce(refusal("consent_required", { consent: { state: "outdated", version: 0 }, purposeVersion: 1 }))
        .mockImplementation(async () => success(statusData(), REVISION, false)),
    });
    await renderScreen(gateway, { locale: "ar" });
    const panel = await screen.findByRole("heading", { name: "السماح بتحليلات YouTube لقناة Fixture channel؟" });
    const section = panel.closest("section")!;
    expect(section).toHaveAttribute("dir", "rtl");
    expect(section.querySelectorAll("[data-purpose-element]")).toHaveLength(8);
    fireEvent.click(screen.getByRole("button", { name: "السماح بالتحليلات لهذه القناة" }));
    await screen.findByText("Fixture video");
    expect(gateway.acceptConsent).toHaveBeenCalledWith(expect.objectContaining({ locale: "ar", purposeVersion: 1 }));
  });

  it("withdraws after confirmation, purges cache, and shows the panel again", async () => {
    const queryClient = client();
    const gateway = makeGateway();
    await renderScreen(gateway, { queryClient });
    await screen.findByText("Fixture video");
    fireEvent.click(screen.getByRole("button", { name: "Stop using analytics for this channel" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText(/channel stays connected/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Stop analytics" }));

    await screen.findByRole("heading", { name: "Allow YouTube Analytics for Fixture channel?" });
    expect(gateway.withdrawConsent).toHaveBeenCalledWith({ accountId: ACCOUNT_ID, locale: "en" });
    await waitFor(() => {
      const reports = queryClient.getQueryCache().getAll().filter((query) => query.queryKey[0] === "youtube-analytics");
      expect(reports.every((query) => query.state.data === undefined)).toBe(true);
    });
    expect(screen.queryByText("Fixture video")).not.toBeInTheDocument();
    expect(gateway.summary).toHaveBeenCalledTimes(1);
  });

  it("renders the daily table alternative with gaps and did-not-return copy", async () => {
    const gateway = makeGateway();
    await renderScreen(gateway);
    await screen.findByText("Fixture video");
    expect(screen.getByTestId("trend-line")).toHaveAttribute("data-connect-nulls", "false");
    expect(screen.getByText("YouTube did not return daily numbers for 6 day(s) of this period.")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Daily values"));
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    expect(screen.getByText("Last day with daily numbers:")).toBeInTheDocument();
  });

  it("keeps the pinned reporting window across a simulated Pacific midnight poll without triggering extra data calls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-20T07:59:30Z"));
    let pollCount = 0;
    const gateway = makeGateway({
      status: vi.fn(async () => {
        pollCount += 1;
        const base = statusData(REVISION);
        const reportingEnd = pollCount === 1 ? "2026-11-17" : "2026-11-18";
        return success({
          ...base,
          reporting_end_date: reportingEnd,
          accepted_window_ends: [reportingEnd, "2026-11-17"] as [string, string],
        }, REVISION, false);
      }),
    });
    await renderScreen(gateway);
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByText("Fixture video")).toBeInTheDocument();
    expect(gateway.summary).toHaveBeenCalledTimes(1);
    expect(gateway.daily).toHaveBeenCalledTimes(1);
    expect(gateway.topVideos).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    await flush();
    expect(pollCount).toBeGreaterThanOrEqual(2);
    expect(gateway.summary).toHaveBeenCalledTimes(1);
    expect(gateway.daily).toHaveBeenCalledTimes(1);
    expect(gateway.topVideos).toHaveBeenCalledTimes(1);
  });
});
