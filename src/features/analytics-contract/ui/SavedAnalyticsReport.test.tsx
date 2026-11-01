import { beforeAll, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { analyticsReportFixture } from "../../../../supabase/functions/_shared/analyticsContractTestSupport.ts";
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
    expect(screen.getByRole("status")).toHaveTextContent(status);
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

  it("a failed account lookup renders retry instead of a missing-account result", async () => {
    render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })}>
      <OwnedAnalyticsScreen platform="threads" gateway={{ accounts: async () => { throw new Error("fixture read failure"); }, report: async () => { throw new Error("Must not request a report"); } }} />
    </QueryClientProvider>);
    expect(await screen.findByRole("alert")).toHaveTextContent("Connected accounts could not be loaded");
    expect(within(screen.getByRole("alert")).getByRole("button", { name: "Retry" })).toBeEnabled();
    expect(screen.queryByText("No connected accounts for this platform.")).toBeNull();
  });
});
