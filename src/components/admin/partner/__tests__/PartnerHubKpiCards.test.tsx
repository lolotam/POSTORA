import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { PartnerHubKpiCards } from "../PartnerHubKpiCards";

const OVERVIEW = {
  active_keys: 3, revoked_keys: 1, month_billable: 120, month_posts: 4,
  requests_30d: 200, success_30d: 190, deliveries_30d: 50, delivered_30d: 45, exhausted_30d: 5, pending_deliveries: 2,
};

describe("PartnerHubKpiCards", () => {
  it("renders the four KPIs from the overview row", () => {
    render(<PartnerHubKpiCards overview={OVERVIEW} isLoading={false} error={null} />);
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("120")).toBeInTheDocument();
    expect(screen.getByText("95%")).toBeInTheDocument(); // 190/200
    expect(screen.getByText("90%")).toBeInTheDocument(); // 45/(45+5)
  });
  it("shows a dash when there were no requests or no settled deliveries", () => {
    render(<PartnerHubKpiCards overview={{ ...OVERVIEW, requests_30d: 0, success_30d: 0, delivered_30d: 0, exhausted_30d: 0 }} isLoading={false} error={null} />);
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });
  it("shows the error instead of numbers when the read failed", () => {
    render(<PartnerHubKpiCards overview={undefined} isLoading={false} error={new Error("platform admin only")} />);
    expect(screen.getByText(/platform admin only/)).toBeInTheDocument();
  });
});
