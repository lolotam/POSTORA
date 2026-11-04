import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { reportFixture } from "../../tests/reportFixture";
import { MetricsOverviewCards } from "../MetricsOverviewCards";

async function renderCards(report: ReturnType<typeof reportFixture>) {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { analytics: {} } }, defaultNS: "analytics" });
  render(<I18nextProvider i18n={i18n}><MetricsOverviewCards report={report} /></I18nextProvider>);
}

function reachCard() {
  return screen.getByText("Total Reach").closest("div.p-4") as HTMLElement;
}

describe("account metric cards", () => {
  it("explains partial values and never labels daily reach sums as unique period reach", async () => {
    await renderCards(reportFixture());
    expect(within(reachCard()).getByText("Not available")).toBeInTheDocument();
    expect(within(reachCard()).getByText("The unique reach of this period has not been collected yet.")).toBeInTheDocument();
    expect(screen.getAllByText("Partial: 2 of 30 days")).toHaveLength(2);
    expect(screen.getByText("8.4K")).toBeInTheDocument();
    expect(screen.queryByText("3K")).not.toBeInTheDocument();
    expect(screen.queryByText(/impressions/i)).not.toBeInTheDocument();
  });
});

describe("the period reach card", () => {
  it("shows the stored exact reach of the period", async () => {
    await renderCards(reportFixture({
      accountPeriodTotals: [{
        id: "total-1", metric: "reach", periodDays: 30, sinceDate: "2026-09-29", untilDate: "2026-10-28",
        status: "ok", value: 2300, capturedAt: "2026-10-29T00:00:00.000Z",
      }],
    }));
    expect(within(reachCard()).getByText("2.3K")).toBeInTheDocument();
    expect(within(reachCard()).getByText("Unique accounts reached in the period")).toBeInTheDocument();
  });

  it.each([
    [90, "Meta reports exact unique reach for periods of up to 30 days."],
    ["all", "Meta reports exact unique reach for periods of up to 30 days."],
  ] as const)("says why a %s-day period has no exact reach", async (periodDays, reason) => {
    await renderCards(reportFixture({ request: { periodDays, limit: 20, cursor: null } }));
    expect(within(reachCard()).getByText("Not available")).toBeInTheDocument();
    expect(within(reachCard()).getByText(reason)).toBeInTheDocument();
  });

  it("says when Meta did not report the period's reach", async () => {
    await renderCards(reportFixture({
      accountPeriodTotals: [{
        id: "total-1", metric: "reach", periodDays: 30, sinceDate: "2026-09-29", untilDate: "2026-10-28",
        status: "unavailable", value: null, capturedAt: "2026-10-29T00:00:00.000Z",
      }],
    }));
    expect(within(reachCard()).getByText("Meta did not report the unique reach of this period.")).toBeInTheDocument();
  });
});
