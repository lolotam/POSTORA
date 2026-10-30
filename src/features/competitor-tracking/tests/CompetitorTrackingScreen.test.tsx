import { describe, expect, it, vi, beforeEach, beforeAll } from "vitest";
import { act, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import analyticsAr from "@/i18n/locales/ar/analytics.json";
import type {
  CompetitorCollectionStatus,
  CompetitorTrackingGateway,
} from "../application/ports";
import type {
  CompetitorReportDetail,
  CompetitorReportEntry,
  CompetitorReportList,
  CompetitorReportQuota,
} from "../domain/contracts";
import { CompetitorTrackingError } from "../domain/errors";
import { CompetitorTrackingScreen } from "../ui/CompetitorTrackingScreen";
import {
  COMPETITOR_SYNC_MAX_POLLS,
  COMPETITOR_SYNC_POLL_INTERVAL_MS,
  useCompetitorSyncStatus,
} from "../ui/useCompetitorSyncStatus";

/**
 * The screen tests drive the screen through an INJECTED fake gateway.
 *
 * They never touch a backend, and they assert the OWNER'S VIEW: the
 * words on the screen, the calls the screen makes and the states it
 * refuses to invent.
 */

/**
 * The real i18next instance, with the English bundle deliberately
 * EMPTY - exactly like the application, where English is the call-site
 * default and only Arabic ships as a bundle.
 *
 * The difference matters: the call-site default is what the owner
 * reads in English, and it is interpolated with the owner's own
 * numbers.
 */
beforeAll(async () => {
  if (i18next.isInitialized) return;
  await i18next.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    ns: ["analytics"],
    defaultNS: "analytics",
    resources: {
      en: { analytics: {} },
      ar: { analytics: analyticsAr },
    },
    interpolation: { escapeValue: false },
  });
});

const authState = vi.hoisted(() => ({
  user: { id: "user-a" } as { id: string } | null,
  isLoading: false,
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: authState.user,
    isLoading: authState.isLoading,
    session: null,
  }),
}));

const WATCHLIST_ID = "3f2b6c1e-9a44-4f0a-8b21-7c5d9e0a1b23";
const SECOND_WATCHLIST_ID = "9d1f0c22-4c0a-4a1a-9a0a-3b1d2c4e5f60";

const QUOTA: CompetitorReportQuota = {
  max_tracked_competitors: 5,
  unlimited: false,
  tracked_active: 2,
  remaining: 3,
};

type EntryOverrides = Partial<CompetitorReportEntry>;

function makeEntry(overrides: EntryOverrides = {}): CompetitorReportEntry {
  return {
    watchlist_id: WATCHLIST_ID,
    username: "northwind",
    label: null,
    is_active: true,
    removed_at: null,
    status: "ok",
    last_error_code: null,
    next_retry_at: null,
    cleanup_eligible_at: null,
    profile: {
      followers_count: 14200,
      media_count: 156,
      captured_at: "2026-10-29T00:00:00Z",
      captured_on: "2026-10-29",
      source: "official",
    },
    freshness: {
      last_capture_at: "2026-10-29T00:00:00Z",
      last_full_success_at: "2026-10-29T00:00:00Z",
      last_partial_at: null,
      job_status: "completed",
      reason_code: null,
    },
    growth_7d: {
      absolute: 120,
      percent: 0.85,
      baseline_at: "2026-10-22T00:00:00Z",
      observed_at: "2026-10-29T00:00:00Z",
      interval_days: 7,
      reason: null,
    },
    growth_30d: {
      absolute: null,
      percent: null,
      baseline_at: null,
      observed_at: null,
      interval_days: null,
      reason: "missing_baseline",
    },
    weekly: {
      observed_count: 3,
      posts_per_week: null,
      interval_start: "2026-10-23T00:00:00Z",
      interval_end: "2026-10-30T00:00:00Z",
      coverage: "unknown",
      reason: "coverage_unknown",
    },
    ...overrides,
  };
}

function listEnvelope(
  entries: CompetitorReportEntry[],
  nextCursor: string | null = null,
  quota: CompetitorReportQuota = QUOTA,
): CompetitorReportList {
  return {
    version: 1,
    as_of: "2026-10-30T08:00:00Z",
    capture_timezone: "Asia/Kuwait",
    quota,
    next_cursor: nextCursor,
    entries,
  };
}

function detailEnvelope(
  entry: CompetitorReportEntry | null,
  media: CompetitorReportDetail["media"] = [],
): CompetitorReportDetail {
  return {
    version: 1,
    as_of: "2026-10-30T08:00:00Z",
    capture_timezone: "Asia/Kuwait",
    quota: QUOTA,
    next_cursor: null,
    entry,
    media,
  };
}

function makeStatus(overrides: Partial<CompetitorCollectionStatus> = {}): CompetitorCollectionStatus {
  return {
    targetKind: "competitor",
    targetId: WATCHLIST_ID,
    capturedOn: "2026-10-30",
    status: "queued",
    jobGeneration: 1,
    attempts: 1,
    dueAt: null,
    nextRetryAt: null,
    lastAttemptAt: null,
    lastSuccessAt: null,
    reasonCode: null,
    pendingOperations: 0,
    ...overrides,
  };
}

type GatewayMock = {
  list: ReturnType<typeof vi.fn>;
  detail: ReturnType<typeof vi.fn>;
  quota: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
  setActive: ReturnType<typeof vi.fn>;
  enqueue: ReturnType<typeof vi.fn>;
};

function createGateway(overrides: Partial<Record<keyof GatewayMock, unknown>> = {}): GatewayMock {
  return {
    list: vi.fn(async () => listEnvelope([])),
    detail: vi.fn(async () => detailEnvelope(null)),
    quota: vi.fn(async () => QUOTA),
    status: vi.fn(async () => makeStatus()),
    add: vi.fn(),
    setActive: vi.fn(),
    enqueue: vi.fn(async () => ({
      outcome: "accepted" as const,
      reason: "queued",
      jobId: null,
      jobGeneration: null,
      status: "queued",
      capturedOn: "2026-10-30",
    })),
    ...overrides,
  } as GatewayMock;
}

function renderScreen(gateway: GatewayMock) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <CompetitorTrackingScreen gateway={gateway as unknown as CompetitorTrackingGateway} />
      </MemoryRouter>
    </QueryClientProvider>
  );

  const result = render(tree());

  return {
    ...result,
    queryClient,
    /** Switches the authenticated owner and re-renders the screen. */
    rerenderAs: (userId: string) => {
      authState.user = { id: userId };
      result.rerender(tree());
    },
  };
}

beforeEach(() => {
  authState.user = { id: "user-a" };
  authState.isLoading = false;
});

describe("CompetitorTrackingScreen", () => {
  describe("the states of the tracked list", () => {
    it("shows a loading state and claims no list before the first read", async () => {
      const gateway = createGateway({
        list: vi.fn(() => new Promise(() => undefined)),
      });

      const { container } = renderScreen(gateway);

      expect(container.querySelector("[aria-busy='true']")).not.toBeNull();
      expect(screen.getByText("Loading competitors")).toBeInTheDocument();
      expect(screen.queryByText("Track your first Instagram competitor")).toBeNull();
    });

    it("shows the empty active list with a way to search", async () => {
      const gateway = createGateway({ list: vi.fn(async () => listEnvelope([])) });

      renderScreen(gateway);

      expect(
        await screen.findByText("Track your first Instagram competitor"),
      ).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Go to search" })).toBeInTheDocument();
    });

    it("shows an empty removed list without a loading or a failure", async () => {
      const gateway = createGateway({ list: vi.fn(async () => listEnvelope([])) });

      renderScreen(gateway);

      await screen.findByText("Track your first Instagram competitor");
      await userEvent.click(screen.getByRole("tab", { name: "Removed" }));

      expect(await screen.findByText("No removed competitors")).toBeInTheDocument();
      expect(screen.queryByText("Could not load competitors.")).toBeNull();
    });

    it("shows an inline failure with a retry instead of an empty list", async () => {
      const gateway = createGateway({
        list: vi.fn(async () => {
          throw new CompetitorTrackingError("REPORT_UNAVAILABLE", "the report is unavailable");
        }),
      });

      renderScreen(gateway);

      expect(await screen.findByText("Could not load competitors.")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry loading" })).toBeInTheDocument();
      // A failed read is not an empty list: there is no invitation to
      // track a first competitor when we do not know whether one exists.
      expect(screen.queryByText("Track your first Instagram competitor")).toBeNull();
    });

    it("keeps the data it has and marks it stale when a refetch fails", async () => {
      const gateway = createGateway({
        list: vi
          .fn()
          .mockResolvedValueOnce(listEnvelope([makeEntry()]))
          .mockRejectedValue(new CompetitorTrackingError("REPORT_UNAVAILABLE", "unavailable")),
      });

      const { queryClient } = renderScreen(gateway);

      expect(await screen.findByText("@northwind")).toBeInTheDocument();

      await act(async () => {
        await queryClient.invalidateQueries({ queryKey: ["competitor-tracking", "user-a"] });
      });

      expect(await screen.findByText("Showing the last data that loaded.")).toBeInTheDocument();
      expect(screen.getByText("@northwind")).toBeInTheDocument();
    });

    it("says the limit is unavailable instead of inventing a free allowance", async () => {
      const gateway = createGateway({
        quota: vi.fn(async () => {
          throw new CompetitorTrackingError("REPORT_UNAVAILABLE", "unavailable");
        }),
      });

      renderScreen(gateway);

      expect(await screen.findByText("Limit unavailable")).toBeInTheDocument();
      expect(screen.queryByText(/of 5 tracked/)).toBeNull();
    });

    it("says the tracking is unlimited for an unlimited owner", async () => {
      const gateway = createGateway({
        quota: vi.fn(async () => ({
          max_tracked_competitors: null,
          unlimited: true,
          tracked_active: 12,
          remaining: null,
        })),
      });

      renderScreen(gateway);

      expect(await screen.findByText("Unlimited tracking")).toBeInTheDocument();
      expect(screen.queryByRole("link", { name: "View plans" })).toBeNull();
    });

    it("shows the resolved limit and the upgrade action at the cap", async () => {
      const gateway = createGateway({
        quota: vi.fn(async () => ({
          max_tracked_competitors: 5,
          unlimited: false,
          tracked_active: 5,
          remaining: 0,
        })),
      });

      renderScreen(gateway);

      expect(await screen.findByText("5 of 5 tracked")).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "View plans" })).toBeInTheDocument();
    });
  });

  describe("the states of one row", () => {
    it("waits for the first snapshot and shows no metric for an entry without an observation", async () => {
      const gateway = createGateway({
        list: vi.fn(async () =>
          listEnvelope([
            makeEntry({
              status: "pending",
              profile: null,
              growth_7d: {
                absolute: null,
                percent: null,
                baseline_at: null,
                observed_at: null,
                interval_days: null,
                reason: "first_observation",
              },
            }),
          ]),
        ),
      });

      renderScreen(gateway);

      expect(await screen.findByText("Waiting for first snapshot")).toBeInTheDocument();
      expect(screen.getAllByText("—").length).toBeGreaterThan(0);
    });

    it("names the missing history of a first observation", async () => {
      const gateway = createGateway({
        list: vi.fn(async () =>
          listEnvelope([
            makeEntry({
              growth_7d: {
                absolute: null,
                percent: null,
                baseline_at: null,
                observed_at: null,
                interval_days: null,
                reason: "first_observation",
              },
            }),
          ]),
        ),
      });

      renderScreen(gateway);

      expect(await screen.findByText("Not enough history")).toBeInTheDocument();
    });

    it("names the zero baseline instead of inventing a percentage", async () => {
      const gateway = createGateway({
        list: vi.fn(async () =>
          listEnvelope([
            makeEntry({
              growth_7d: {
                absolute: null,
                percent: null,
                baseline_at: null,
                observed_at: null,
                interval_days: null,
                reason: "zero_baseline",
              },
            }),
          ]),
        ),
      });

      renderScreen(gateway);

      expect(await screen.findByText("No percentage: baseline was zero")).toBeInTheDocument();
      expect(screen.queryByText(/Infinity/)).toBeNull();
      expect(screen.queryByText(/NaN/)).toBeNull();
    });

    it("shows an incomplete week as an observed count without a weekly rate", async () => {
      const gateway = createGateway({
        list: vi.fn(async () =>
          listEnvelope([
            makeEntry({
              weekly: {
                observed_count: 3,
                posts_per_week: null,
                interval_start: "2026-10-23T00:00:00Z",
                interval_end: "2026-10-30T00:00:00Z",
                coverage: "partial",
                reason: "capture_gap",
              },
            }),
          ]),
        ),
      });

      renderScreen(gateway);

      expect(
        await screen.findByText("3 posts observed · incomplete coverage"),
      ).toBeInTheDocument();
      expect(screen.getByText("A capture gap sits inside this window")).toBeInTheDocument();
    });

    it("shows the source of the observation", async () => {
      const gateway = createGateway({
        list: vi.fn(async () =>
          listEnvelope([
            makeEntry({
              profile: {
                followers_count: 10,
                media_count: 2,
                captured_at: "2026-10-29T00:00:00Z",
                captured_on: "2026-10-29",
                source: "apify",
              },
            }),
          ]),
        ),
      });

      renderScreen(gateway);

      expect(await screen.findByText("Third-party")).toBeInTheDocument();
    });

    it("explains a missing scope and offers the reconnect action", async () => {
      const gateway = createGateway({
        list: vi.fn(async () =>
          listEnvelope([makeEntry({ last_error_code: "scope_missing" })]),
        ),
      });

      renderScreen(gateway);

      expect(
        await screen.findByText(
          "The connected account is missing the permission this collection needs.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Reconnect" })).toHaveAttribute("href", "/profiles");
    });

    it("explains a throttled collector without inventing a retry time", async () => {
      const gateway = createGateway({
        list: vi.fn(async () => listEnvelope([makeEntry({ last_error_code: "rate_limited" })])),
      });

      renderScreen(gateway);

      expect(
        await screen.findByText("The collector is busy. Try again when it says it is due."),
      ).toBeInTheDocument();
    });

    it("explains that the collection is switched off and keeps the stored report", async () => {
      const gateway = createGateway({
        list: vi.fn(async () =>
          listEnvelope([makeEntry({ last_error_code: "collection_disabled" })]),
        ),
      });

      renderScreen(gateway);

      expect(
        await screen.findByText(
          "Collection is not available right now. Your stored reports are still here.",
        ),
      ).toBeInTheDocument();
      expect(screen.getByText("@northwind")).toBeInTheDocument();
    });
  });

  describe("the removed list", () => {
    it("shows the cleanup date and no collection action for a removed entry", async () => {
      const gateway = createGateway({
        list: vi.fn(async (request: { state: string }) =>
          request.state === "removed"
            ? listEnvelope([
                makeEntry({
                  is_active: false,
                  removed_at: "2026-10-20T00:00:00Z",
                  cleanup_eligible_at: "2027-01-18T00:00:00Z",
                }),
              ])
            : listEnvelope([]),
        ),
      });

      renderScreen(gateway);

      await userEvent.click(screen.getByRole("tab", { name: "Removed" }));

      expect(await screen.findByText("@northwind")).toBeInTheDocument();
      expect(screen.getByText(/Eligible for cleanup on/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /Retry collection/ })).toBeNull();
      expect(screen.getByRole("button", { name: /Reactivate/ })).toBeInTheDocument();
    });
    it("returns the focus to the list heading after a confirmed removal", async () => {
      const gateway = createGateway({
        list: vi.fn(async () => listEnvelope([makeEntry()])),
        setActive: vi.fn(async () => ({
          watchlistId: WATCHLIST_ID,
          username: "northwind",
          label: null,
          isActive: false,
          removedAt: "2026-10-30T00:00:00Z",
          status: "ok",
          quota: QUOTA,
        })),
      });

      renderScreen(gateway);

      await screen.findByText("@northwind");
      await userEvent.click(screen.getByRole("button", { name: "Remove @northwind" }));

      const dialog = await screen.findByRole("alertdialog");
      await userEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

      // The row that owned the focus is gone, so the focus lands on the
      // heading of the list instead of on nothing.
      await waitFor(() =>
        expect(document.activeElement).toBe(
          screen.getByRole("heading", { name: "Tracked competitors" }),
        ),
      );
    });
  });

  describe("the owner isolation", () => {
    it("never flashes the previous owner's competitors", async () => {
      const gateway = createGateway({
        list: vi.fn(async () => listEnvelope([makeEntry()])),
      });

      const { rerenderAs } = renderScreen(gateway);

      expect(await screen.findByText("@northwind")).toBeInTheDocument();

      let resolveSecond: ((value: CompetitorReportList) => void) | null = null;
      gateway.list.mockImplementation(
        () =>
          new Promise<CompetitorReportList>((resolve) => {
            resolveSecond = resolve;
          }),
      );
      rerenderAs("user-b");

      await waitFor(() => expect(gateway.list).toHaveBeenCalledTimes(2));
      expect(screen.queryByText("@northwind")).toBeNull();

      act(() => {
        resolveSecond?.(
          listEnvelope([makeEntry({ watchlist_id: SECOND_WATCHLIST_ID, username: "southwind" })]),
        );
      });

      expect(await screen.findByText("@southwind")).toBeInTheDocument();
      expect(screen.queryByText("@northwind")).toBeNull();
    });

    it("drops every cached read of the previous owner when the owner changes", async () => {
      const gateway = createGateway({
        list: vi.fn(async () => listEnvelope([makeEntry()])),
      });

      const { queryClient, rerenderAs } = renderScreen(gateway);

      expect(await screen.findByText("@northwind")).toBeInTheDocument();
      expect(
        queryClient.getQueryCache().findAll({ queryKey: ["competitor-tracking", "user-a"] }).length,
      ).toBeGreaterThan(0);

      rerenderAs("user-b");

      await waitFor(() =>
        expect(
          queryClient.getQueryCache().findAll({ queryKey: ["competitor-tracking", "user-a"] }),
        ).toHaveLength(0),
      );
    });

    it("resets the cursor when the list changes", async () => {
      const gateway = createGateway({
        list: vi.fn(async (request: { state: string; cursor: string | null }) =>
          request.state === "active"
            ? listEnvelope([makeEntry()], "cursor-page-2")
            : listEnvelope([makeEntry({ username: "removedone", is_active: false })]),
        ),
      });

      renderScreen(gateway);

      await screen.findByText("@northwind");
      await userEvent.click(screen.getByRole("button", { name: "Load more" }));

      await waitFor(() =>
        expect(gateway.list).toHaveBeenCalledWith(
          expect.objectContaining({ state: "active", cursor: "cursor-page-2" }),
          expect.anything(),
        ),
      );

      await userEvent.click(screen.getByRole("tab", { name: "Removed" }));

      await waitFor(() =>
        expect(gateway.list).toHaveBeenCalledWith(
          expect.objectContaining({ state: "removed", cursor: null }),
          expect.anything(),
        ),
      );
    });
  });

  describe("the collection controls", () => {
    it("blocks a duplicate retry for the same target only", async () => {
      const gateway = createGateway({
        list: vi.fn(async () =>
          listEnvelope([
            makeEntry(),
            makeEntry({ watchlist_id: SECOND_WATCHLIST_ID, username: "southwind" }),
          ]),
        ),
        enqueue: vi.fn(() => new Promise(() => undefined)),
      });

      renderScreen(gateway);

      await screen.findByText("@northwind");
      const buttons = screen.getAllByRole("button", { name: /Retry collection/ });
      await userEvent.click(buttons[0]);

      await waitFor(() => expect(buttons[0]).toBeDisabled());
      expect(buttons[1]).not.toBeDisabled();
    });

    it("shows the queued state after an accepted enqueue and starts the status read", async () => {
      const gateway = createGateway({
        list: vi.fn(async () => listEnvelope([makeEntry()])),
        enqueue: vi.fn(async () => ({
          outcome: "accepted" as const,
          reason: "queued",
          jobId: null,
          jobGeneration: null,
          status: "queued",
          capturedOn: "2026-10-30",
        })),
      });

      renderScreen(gateway);

      await screen.findByText("@northwind");
      await userEvent.click(screen.getByRole("button", { name: /Retry collection/ }));

      expect(
        await screen.findByText("Tracked; the first snapshot is queued."),
      ).toBeInTheDocument();
      await waitFor(() => expect(gateway.status).toHaveBeenCalled());
    });

    it("honours the retry time of a deferred enqueue and does not poll", async () => {
      const gateway = createGateway({
        list: vi.fn(async () => listEnvelope([makeEntry()])),
        enqueue: vi.fn(async () => ({
          outcome: "deferred" as const,
          reason: "throttled",
          retryAfterSeconds: 42,
          capturedOn: "2026-10-30",
        })),
      });

      renderScreen(gateway);

      await screen.findByText("@northwind");
      await userEvent.click(screen.getByRole("button", { name: /Retry collection/ }));

      expect(await screen.findByText("Retry in 42 seconds.")).toBeInTheDocument();
      expect(gateway.status).not.toHaveBeenCalled();
    });

    it("never replays an enqueue whose outcome could not be observed", async () => {
      const gateway = createGateway({
        list: vi.fn(async () => listEnvelope([makeEntry()])),
        enqueue: vi.fn(async () => {
          throw new CompetitorTrackingError("ENQUEUE_INDETERMINATE", "not confirmed");
        }),
      });

      renderScreen(gateway);

      await screen.findByText("@northwind");
      await userEvent.click(screen.getByRole("button", { name: /Retry collection/ }));

      expect(
        await screen.findByText("Could not confirm the change. Reload to check."),
      ).toBeInTheDocument();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(gateway.enqueue).toHaveBeenCalledTimes(1);
    });
  });

  describe("the detail sheet", () => {
    it("reports a missing entry as not found instead of an empty report", async () => {
      const gateway = createGateway({
        list: vi.fn(async () => listEnvelope([makeEntry()])),
        detail: vi.fn(async () => detailEnvelope(null)),
      });

      renderScreen(gateway);

      await screen.findByText("@northwind");
      await userEvent.click(screen.getByRole("button", { name: "View report for @northwind" }));

      const sheet = await screen.findByRole("dialog");
      expect(
        within(sheet).getByText("That competitor is no longer available."),
      ).toBeInTheDocument();
    });
  });
});

describe("the collection status polling", () => {
  function renderStatusHook(
    gateway: GatewayMock,
    options: { userId: string; intervalMs?: number; maxPolls?: number },
  ) {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    return renderHook(
      (props: { userId: string }) =>
        useCompetitorSyncStatus({
          gateway: gateway as unknown as CompetitorTrackingGateway,
          userId: props.userId,
          watchlistId: WATCHLIST_ID,
          enabled: true,
          intervalMs: options.intervalMs ?? 5,
          maxPolls: options.maxPolls,
        }),
      {
        initialProps: { userId: options.userId },
        wrapper: ({ children }) => (
          <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
        ),
      },
    );
  }

  it("polls at most twelve times and then stops", async () => {
    const gateway = createGateway({ status: vi.fn(async () => makeStatus({ status: "queued" })) });

    renderStatusHook(gateway, { userId: "user-a", intervalMs: 1 });

    expect(COMPETITOR_SYNC_MAX_POLLS).toBe(12);
    await waitFor(() => expect(gateway.status).toHaveBeenCalledTimes(12), {
      timeout: 5000,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(gateway.status).toHaveBeenCalledTimes(12);
    expect(COMPETITOR_SYNC_POLL_INTERVAL_MS).toBe(5000);
  });

  it("stops on a terminal state", async () => {
    const gateway = createGateway({
      status: vi.fn(async () => makeStatus({ status: "completed" })),
    });

    renderStatusHook(gateway, { userId: "user-a", intervalMs: 1 });

    await waitFor(() => expect(gateway.status).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(gateway.status).toHaveBeenCalledTimes(1);
  });

  it("stops when the collector defers the work", async () => {
    const gateway = createGateway({
      status: vi.fn(async () => makeStatus({ status: "retry", nextRetryAt: "2026-10-30T09:00:00Z" })),
    });

    renderStatusHook(gateway, { userId: "user-a", intervalMs: 1 });

    await waitFor(() => expect(gateway.status).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(gateway.status).toHaveBeenCalledTimes(1);
  });

  it("stops when the screen unmounts", async () => {
    const gateway = createGateway({ status: vi.fn(async () => makeStatus({ status: "queued" })) });

    const { unmount } = renderStatusHook(gateway, { userId: "user-a", intervalMs: 1 });

    await waitFor(() => expect(gateway.status).toHaveBeenCalledTimes(1));
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(gateway.status).toHaveBeenCalledTimes(1);
  });

  it("stops when the authenticated owner changes", async () => {
    const gateway = createGateway({ status: vi.fn(async () => makeStatus({ status: "queued" })) });

    const { rerender } = renderStatusHook(gateway, { userId: "user-a", intervalMs: 1 });

    await waitFor(() => expect(gateway.status).toHaveBeenCalledTimes(1));
    rerender({ userId: "user-b" });
    await new Promise((resolve) => setTimeout(resolve, 150));

    expect(gateway.status.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
