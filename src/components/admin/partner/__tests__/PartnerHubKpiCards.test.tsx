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

const CONNECTORS = {
  active_connections: 6, workspaces_with_connections: 3,
  calls_30d: 4210, failures_30d: 17, refused_30d: 5, p95_latency_30d: 1900,
};

describe("PartnerHubKpiCards connector row", () => {
  it("renders the 30-day connector call and failure counts", () => {
    render(<PartnerHubKpiCards overview={OVERVIEW} connectorOverview={CONNECTORS} isLoading={false} error={null} />);
    expect(screen.getByText("Connector calls (30 d)")).toBeInTheDocument();
    expect(screen.getByText("4210")).toBeInTheDocument();
    expect(screen.getByText("Connector failures (30 d)")).toBeInTheDocument();
    expect(screen.getByText("17")).toBeInTheDocument();
  });

  it("keeps the connector cards blank rather than showing zero before the read lands", () => {
    render(<PartnerHubKpiCards overview={OVERVIEW} connectorOverview={undefined} isLoading={false} error={null} />);
    expect(screen.getByText("Connector calls (30 d)")).toBeInTheDocument();
    expect(screen.queryByText("4210")).not.toBeInTheDocument();
  });
});

describe("PartnerHubKpiCards connector read failure", () => {
  it("says the connector read failed instead of showing a permanent skeleton", () => {
    render(
      <PartnerHubKpiCards
        overview={OVERVIEW}
        connectorOverview={undefined}
        connectorError={new Error("platform admin only")}
        isLoading={false}
        error={null}
      />,
    );
    expect(screen.getAllByText("Could not load: platform admin only").length).toBe(2);
  });
});
