import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { AgentDashboardView } from "../AgentDashboardView";
import { useAgentDashboard, useModelPrices } from "../hooks/useAgentDashboard";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import type { AgentDashboard, OutcomeCounts } from "../../domain/agentDashboard";

vi.mock("../hooks/useAgentDashboard", () => ({
  useAgentDashboard: vi.fn(),
  useModelPrices: vi.fn(),
}));
vi.mock("@/hooks/useSocialAccounts", () => ({ useSocialAccounts: vi.fn() }));

const dashboardHook = vi.mocked(useAgentDashboard);
const pricesHook = vi.mocked(useModelPrices);
const accountsHook = vi.mocked(useSocialAccounts);

const counts: OutcomeCounts = {
  items: 8,
  answered: 3,
  escalated: 2,
  skipped: 3,
  errors: 0,
  other: 0,
  latencyP50Ms: 2500,
  latencyP90Ms: 3700,
  fastPath: 2,
  triaged: 4,
  promptTokens: 1_000_000,
  completionTokens: 0,
};

const dashboard: AgentDashboard = {
  days: 7,
  since: "2026-09-19T10:00:00Z",
  totals: counts,
  accounts: [
    { ...counts, platform: "whatsapp", socialAccountId: "acct-1" },
    { ...counts, items: 1, platform: "whatsapp", socialAccountId: null },
  ],
  skipReasons: [{ reason: "human_agent_active", count: 2 }],
  intents: [{ intent: "pricing", count: 2 }, { intent: "order_status", count: 1 }],
  models: [{ model: "openai/gpt-4o", promptTokens: 1_000_000, completionTokens: 0 }],
};

function mockDashboard(data: AgentDashboard | undefined, extra: Record<string, unknown> = {}) {
  dashboardHook.mockReturnValue({ data, isLoading: false, error: null, ...extra } as unknown as ReturnType<typeof useAgentDashboard>);
}

function mockPrices(data: Array<{ model_id: string; cost_per_1m_input_tokens: number; cost_per_1m_output_tokens: number }>) {
  pricesHook.mockReturnValue({ data } as unknown as ReturnType<typeof useModelPrices>);
}

describe("AgentDashboardView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDashboard(dashboard);
    mockPrices([]);
    accountsHook.mockReturnValue({
      data: [{ id: "acct-1", platform: "whatsapp", platform_username: "Main shop" }],
    } as unknown as ReturnType<typeof useSocialAccounts>);
  });

  it("labels AI-sent replies honestly instead of calling them resolved", () => {
    render(<AgentDashboardView platform="whatsapp" />);
    expect(screen.getAllByText("Answered by AI (no handoff)").length).toBeGreaterThan(0);
    expect(screen.queryByText(/resolved/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("stat-answered")).toHaveTextContent("3");
    expect(screen.getByTestId("stat-answered")).toHaveTextContent("38%");
    expect(screen.getByTestId("stat-escalated")).toHaveTextContent("2");
  });

  it("asks for the 7-day window first and switches to 30 days", () => {
    render(<AgentDashboardView platform="whatsapp" />);
    expect(dashboardHook).toHaveBeenLastCalledWith(7, "whatsapp");
    fireEvent.click(screen.getByRole("button", { name: "Last 30 days" }));
    expect(dashboardHook).toHaveBeenLastCalledWith(30, "whatsapp");
  });

  it("shows median and p90 reply latency in seconds", () => {
    render(<AgentDashboardView platform="whatsapp" />);
    const latency = screen.getByTestId("stat-latency");
    expect(latency).toHaveTextContent("2.5s");
    expect(latency).toHaveTextContent("3.7s");
  });

  it("shows no cost when the catalogue has no price, rather than inventing one", () => {
    render(<AgentDashboardView platform="whatsapp" />);
    const cost = screen.getByTestId("stat-cost");
    expect(cost).not.toHaveTextContent("$");
    expect(cost).toHaveTextContent("No catalogue price");
  });

  it("estimates cost from the catalogue when a price exists", () => {
    mockPrices([{ model_id: "gpt-4o", cost_per_1m_input_tokens: 2.5, cost_per_1m_output_tokens: 10 }]);
    render(<AgentDashboardView platform="whatsapp" />);
    expect(screen.getByTestId("stat-cost")).toHaveTextContent("$2.50");
    expect(screen.getByTestId("stat-cost")).toHaveTextContent("100%");
  });

  it("shows the fast-path share over triaged turns, and a dash when triage never ran", () => {
    const { unmount } = render(<AgentDashboardView platform="whatsapp" />);
    expect(screen.getByTestId("stat-fast-path")).toHaveTextContent("50%");
    unmount();
    mockDashboard({ ...dashboard, totals: { ...counts, fastPath: 0, triaged: 0 } });
    render(<AgentDashboardView platform="whatsapp" />);
    expect(screen.getByTestId("stat-fast-path")).toHaveTextContent("—");
  });

  it("names accounts, and groups rows logged before account tracking", () => {
    render(<AgentDashboardView platform="whatsapp" />);
    const table = screen.getByRole("table");
    expect(within(table).getByText("Main shop")).toBeInTheDocument();
    expect(within(table).getByText("Before account tracking")).toBeInTheDocument();
  });

  it("lists top intents and skip reasons", () => {
    render(<AgentDashboardView platform="whatsapp" />);
    expect(screen.getByText("Pricing")).toBeInTheDocument();
    expect(screen.getByText("Order status")).toBeInTheDocument();
    expect(screen.getByText("A human is handling the chat")).toBeInTheDocument();
  });

  it("shows an empty state for a window with no activity", () => {
    mockDashboard({
      ...dashboard,
      totals: { ...counts, items: 0, answered: 0, escalated: 0, skipped: 0, fastPath: 0, triaged: 0, promptTokens: 0, completionTokens: 0, latencyP50Ms: null, latencyP90Ms: null },
      accounts: [],
      skipReasons: [],
      intents: [],
      models: [],
    });
    render(<AgentDashboardView platform="whatsapp" />);
    expect(screen.getByText("No agent activity in the last 7 days")).toBeInTheDocument();
  });

  it("surfaces a load failure instead of showing zeros", () => {
    mockDashboard(undefined, { error: new Error("permission denied") });
    render(<AgentDashboardView platform="whatsapp" />);
    expect(screen.getByText(/permission denied/)).toBeInTheDocument();
    expect(screen.queryByTestId("stat-answered")).not.toBeInTheDocument();
  });
});
