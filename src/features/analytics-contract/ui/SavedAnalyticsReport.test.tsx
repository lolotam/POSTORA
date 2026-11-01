import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { analyticsReportFixture } from "../../../../supabase/functions/_shared/analyticsContractTestSupport.ts";
import { analyticsDefinitions } from "../../../../supabase/functions/_shared/analyticsRegistry.ts";
import { AnalyticsMetricValue, SavedAnalyticsReport } from "./SavedAnalyticsReport";
import { OwnedAnalyticsScreen } from "./OwnedAnalyticsScreen";
import { AnalyticsReadError, type SavedAnalyticsGateway } from "../application/ports";
import type { AnalyticsSyncState, MetricValue } from "../domain/types";

vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "owner-fixture" } }) }));

describe("saved analytics presentation", () => {
  beforeAll(async () => { await i18n.changeLanguage("en"); });
  it.each<{ metric: MetricValue; expected: string }>([
    { metric: { status: "available", value: 0 }, expected: "0" },
    { metric: { status: "partial", value: 0, coverage: { availableDays: 2, expectedDays: 7 } }, expected: "Partial: 2/7 days" },
    { metric: { status: "unavailable", reason: "permission_missing" }, expected: "Not available" },
  ])("preserves $metric.status instead of manufacturing a zero", ({ metric, expected }) => {
    const { container } = render(<AnalyticsMetricValue metric={metric} />);
    expect(container).toHaveTextContent(expected);
    if (metric.status === "unavailable") expect(container).not.toHaveTextContent("0");
  });

  it.each<AnalyticsSyncState["status"]>(["never_synced", "syncing", "fresh", "stale", "partial", "failed"])("keeps saved values visible when collection is %s", (status) => {
    const report = analyticsReportFixture("facebook");
    report.source = "persisted";
    report.sync.status = status;
    report.sync.reason = status === "failed" ? "reauth_required" : null;
    report.metrics.find((metric) => metric.definition.key === "views")!.current = { status: "available", value: 923 };
    render(<SavedAnalyticsReport report={report} />);
    expect(screen.getByRole("status")).toHaveTextContent({ never_synced: "Never synced", syncing: "Syncing", fresh: "Up to date", stale: "Needs updating", partial: "Partial data", failed: "Sync failed; saved data remains available" }[status]);
    expect(screen.getByText("923")).toBeVisible();
  });

  it("selects exact accounts/periods, carries continuation and requires refresh after a revision conflict", async () => {
    const seen: string[] = [];
    const gateway: SavedAnalyticsGateway = {
      accounts: async () => [{ id: "first", name: "Curemed", active: true }, { id: "second", name: "Archived", active: false }],
      report: async (request) => {
        seen.push(`${request.accountId}:${request.periodDays}:${request.cursor}`);
        if (request.cursor) throw new AnalyticsReadError("history_revision_changed");
        const report = analyticsReportFixture("facebook");
        report.posts.nextCursor = "signed-fixture";
        return report;
      },
    };
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <OwnedAnalyticsScreen platform="facebook" gateway={gateway} />
    </QueryClientProvider>);
    await screen.findByRole("button", { name: "Load more posts" });
    fireEvent.click(screen.getByRole("button", { name: "Load more posts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Saved history changed");
    expect(seen).toContain("first:7:signed-fixture");
    fireEvent.change(screen.getByLabelText("Account"), { target: { value: "second" } });
    await waitFor(() => expect(seen).toContain("second:7:null"));
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "14" } });
    await waitFor(() => expect(seen).toContain("second:14:null"));
    expect(screen.getByRole("option", { name: "Archived · Disconnected" })).toBeInTheDocument();
  });

  it.each([true, false])("defaults to an active account when one exists: %s", async (hasActiveAccount) => {
    const seen: string[] = [];
    const accounts = [{ id: "archived", name: "Archived", active: false }, { id: "second", name: "Second", active: hasActiveAccount }];
    const gateway: SavedAnalyticsGateway = {
      accounts: async () => accounts,
      report: async (request) => {
        seen.push(request.accountId);
        return { ...analyticsReportFixture("facebook"), accountId: request.accountId };
      },
    };
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <OwnedAnalyticsScreen platform="facebook" gateway={gateway} />
    </QueryClientProvider>);
    const expected = hasActiveAccount ? "second" : "archived";
    await waitFor(() => expect(seen).toEqual([expected]));
    expect(screen.getByLabelText("Account")).toHaveValue(expected);
    if (hasActiveAccount) {
      fireEvent.change(screen.getByLabelText("Account"), { target: { value: "archived" } });
      await waitFor(() => expect(seen).toEqual(["second", "archived"]));
      expect(screen.getByLabelText("Account")).toHaveValue("archived");
    }
  });

  it("a failed account lookup renders retry instead of a missing-account result", async () => {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <OwnedAnalyticsScreen platform="threads" gateway={{ accounts: async () => { throw new Error("fixture read failure"); }, report: async () => { throw new Error("Must not request a report"); } }} />
    </QueryClientProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("Connected accounts could not be loaded");
    expect(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.queryByText("No connected accounts for this platform.")).toBeNull();
  });

  it.each(["complete", "collection_gap", "first_page_metric_gap", "last_page_metric_gap"] as const)("continuation clears only unread pagination: %s", async (scenario) => {
    const pages = [analyticsReportFixture("facebook"), analyticsReportFixture("facebook")];
    pages.forEach((page, pageIndex) => {
      page.source = "persisted";
      page.sync.status = "fresh";
      page.posts.items = Array.from({ length: pageIndex === 0 ? 25 : 1 }, (_, index) => ({
        id: `post-${pageIndex * 25 + index}`, publishedAt: page.period.since, text: `Saved post ${pageIndex * 25 + index}`, permalink: null,
        metrics: analyticsDefinitions("facebook", "post").map((definition) => ({ ...page.metrics[0], definition, current: { status: "available" as const, value: 0 } })),
      }));
      page.truncated = page.posts.truncated = pageIndex === 0 || scenario === "collection_gap";
      page.posts.status = page.truncated ? "partial" : "available";
      page.posts.reason = scenario === "collection_gap" ? "not_collected" : null;
      page.posts.nextCursor = pageIndex === 0 ? "page-two" : null;
    });
    if (scenario.endsWith("metric_gap")) {
      const affected = pages[scenario === "first_page_metric_gap" ? 0 : 1];
      affected.posts.items[0].metrics.find((metric) => metric.definition.capability === "available")!.current = { status: "unavailable", reason: "provider_error" };
      affected.posts.status = "partial";
      affected.sync.status = "partial";
    }
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <OwnedAnalyticsScreen platform="facebook" gateway={{ accounts: async () => [{ id: "first", name: "Curemed", active: true }],
        report: async (request) => pages[request.cursor ? 1 : 0] }} />
    </QueryClientProvider>);
    fireEvent.click(await screen.findByRole("button", { name: "Load more posts" }));
    expect(await screen.findByText("Saved post 25")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Load more posts" })).toBeNull();
    expect(screen.queryByText("Collection is incomplete. Some posts are missing.") !== null).toBe(scenario === "collection_gap");
    expect(screen.queryByText(/Post coverage is incomplete/) !== null).toBe(scenario !== "complete");
    if (scenario.endsWith("metric_gap")) expect(screen.getByText("Partial data")).toBeVisible();
  });
});
