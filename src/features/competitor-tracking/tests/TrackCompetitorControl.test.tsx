import { describe, expect, it, vi, beforeAll, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import analyticsAr from "@/i18n/locales/ar/analytics.json";
import type { CompetitorTrackingGateway } from "../application/ports";
import type { CompetitorReportEntry, CompetitorReportList, CompetitorReportQuota } from "../domain/contracts";
import { CompetitorTrackingError } from "../domain/errors";
import { TrackCompetitorControl } from "../ui/TrackCompetitorControl";

/**
 * The Track control tests drive the control through an INJECTED fake
 * gateway. They assert what the owner is told and what the control
 * actually asked the server to do - never that it "tried again".
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
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: authState.user, isLoading: false, session: null }),
}));

const WATCHLIST_ID = "3f2b6c1e-9a44-4f0a-8b21-7c5d9e0a1b23";

const QUOTA: CompetitorReportQuota = {
  max_tracked_competitors: 5,
  unlimited: false,
  tracked_active: 4,
  remaining: 1,
};

function makeEntry(username: string): CompetitorReportEntry {
  return {
    watchlist_id: WATCHLIST_ID,
    username,
    label: null,
    is_active: true,
    removed_at: null,
    status: "ok",
    last_error_code: null,
    next_retry_at: null,
    cleanup_eligible_at: null,
    profile: {
      followers_count: 100,
      media_count: 4,
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
      absolute: null,
      percent: null,
      baseline_at: null,
      observed_at: null,
      interval_days: null,
      reason: "first_observation",
    },
    growth_30d: {
      absolute: null,
      percent: null,
      baseline_at: null,
      observed_at: null,
      interval_days: null,
      reason: "first_observation",
    },
    weekly: {
      observed_count: 0,
      posts_per_week: null,
      interval_start: null,
      interval_end: null,
      coverage: "unknown",
      reason: "coverage_unknown",
    },
  };
}

function listEnvelope(entries: CompetitorReportEntry[]): CompetitorReportList {
  return {
    version: 1,
    as_of: "2026-10-30T08:00:00Z",
    capture_timezone: "Asia/Kuwait",
    quota: QUOTA,
    next_cursor: null,
    entries,
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

function createGateway(overrides: Partial<GatewayMock> = {}): GatewayMock {
  return {
    list: vi.fn(async () => listEnvelope([])),
    detail: vi.fn(async () => ({ ...listEnvelope([]), entries: undefined, entry: null, media: [] })),
    quota: vi.fn(async () => QUOTA),
    status: vi.fn(),
    add: vi.fn(async () => ({
      watchlistId: WATCHLIST_ID,
      username: "northwind",
      isActive: true,
      status: "pending",
      reactivated: false,
      alreadyTracked: false,
      quota: QUOTA,
    })),
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

function renderControl(gateway: GatewayMock, username = "northwind") {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <TrackCompetitorControl
          username={username}
          gateway={gateway as unknown as CompetitorTrackingGateway}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  authState.user = { id: "user-a" };
});

describe("TrackCompetitorControl", () => {
  it("offers to track a handle that is not tracked yet", async () => {
    const gateway = createGateway();

    renderControl(gateway);

    const button = await screen.findByRole("button", { name: "Track" });
    expect(button).not.toBeDisabled();
  });

  it("shows a tracked handle as tracked and refuses a second slot", async () => {
    const gateway = createGateway({
      list: vi.fn(async () => listEnvelope([makeEntry("northwind")])),
    });

    renderControl(gateway);

    const button = await screen.findByRole("button", { name: "Tracked" });
    expect(button).toBeDisabled();

    await userEvent.click(button);
    expect(gateway.add).not.toHaveBeenCalled();
  });

  it("treats @Foo and foo as one tracking state", async () => {
    const gateway = createGateway({
      list: vi.fn(async () => listEnvelope([makeEntry("foo")])),
    });

    renderControl(gateway, "@Foo");

    expect(await screen.findByRole("button", { name: "Tracked" })).toBeInTheDocument();
  });

  it("saves the row and queues the collection exactly once", async () => {
    const gateway = createGateway();

    renderControl(gateway);

    await userEvent.click(await screen.findByRole("button", { name: "Track" }));

    await waitFor(() => expect(gateway.add).toHaveBeenCalledTimes(1));
    expect(gateway.add).toHaveBeenCalledWith({ username: "northwind", label: null });
    await waitFor(() => expect(gateway.enqueue).toHaveBeenCalledTimes(1));
    expect(gateway.enqueue).toHaveBeenCalledWith({ watchlistId: WATCHLIST_ID, force: false });
    expect(
      await screen.findByText("Tracked; the first snapshot is queued."),
    ).toBeInTheDocument();
  });

  it("keeps the row when the collection could not be confirmed", async () => {
    const gateway = createGateway({
      enqueue: vi.fn(async () => {
        throw new CompetitorTrackingError("THROTTLED", "throttled", { retryAfterSeconds: 30 });
      }),
    });

    renderControl(gateway);

    await userEvent.click(await screen.findByRole("button", { name: "Track" }));

    expect(
      await screen.findByText("Tracked; collection could not be confirmed."),
    ).toBeInTheDocument();
    expect(gateway.add).toHaveBeenCalledTimes(1);
  });

  it("never replays an enqueue whose outcome could not be observed", async () => {
    const gateway = createGateway({
      enqueue: vi.fn(async () => {
        throw new CompetitorTrackingError("ENQUEUE_INDETERMINATE", "not confirmed");
      }),
    });

    renderControl(gateway);

    await userEvent.click(await screen.findByRole("button", { name: "Track" }));

    // The row IS saved. Only the collection is unconfirmed, and the
    // control says exactly that instead of claiming a failure.
    expect(
      await screen.findByText("Tracked; collection could not be confirmed."),
    ).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(gateway.enqueue).toHaveBeenCalledTimes(1);
    expect(gateway.add).toHaveBeenCalledTimes(1);
  });

  it("never replays a save whose outcome could not be observed", async () => {
    const gateway = createGateway({
      add: vi.fn(async () => {
        throw new CompetitorTrackingError("MUTATION_INDETERMINATE", "not confirmed");
      }),
    });

    renderControl(gateway);

    await userEvent.click(await screen.findByRole("button", { name: "Track" }));

    expect(
      await screen.findByText("Could not confirm the change. Reload to check."),
    ).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(gateway.add).toHaveBeenCalledTimes(1);
    expect(gateway.enqueue).not.toHaveBeenCalled();
  });

  it("explains a quota rejection with the owner's real limit", async () => {
    const gateway = createGateway({
      add: vi.fn(async () => {
        throw new CompetitorTrackingError("QUOTA_EXCEEDED", "the limit is reached");
      }),
    });

    renderControl(gateway);

    await userEvent.click(await screen.findByRole("button", { name: "Track" }));

    expect(
      await screen.findByText("Your limit is 5 active competitors."),
    ).toBeInTheDocument();
    expect(gateway.enqueue).not.toHaveBeenCalled();
  });

  it("refuses a handle that Instagram never issues without asking the server", async () => {
    const gateway = createGateway();

    renderControl(gateway, "not a handle!");

    await userEvent.click(await screen.findByRole("button", { name: "Track" }));

    expect(
      await screen.findByText("That is not a valid Instagram handle."),
    ).toBeInTheDocument();
    expect(gateway.add).not.toHaveBeenCalled();
  });
});
