import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import type { InstagramInsightsGateway } from "../../application/ports";
import { reportFixture } from "../../tests/reportFixture";
import { InstagramPerformanceScreen } from "../InstagramPerformanceScreen";

// Mock useAuth
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "test-user-id" },
    session: { access_token: "test-token" },
  }),
}));

// Mock useSocialAccounts
const mockUseSocialAccounts = vi.fn();
vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => mockUseSocialAccounts(),
}));

const mockReport = reportFixture();

function createMockGateway(overrides?: Partial<InstagramInsightsGateway>): InstagramInsightsGateway {
  return {
    getReport: vi.fn().mockResolvedValue(mockReport),
    triggerSync: vi.fn().mockResolvedValue({ jobId: "job-1", status: "queued" }),
    ...overrides,
  };
}

function renderScreen(gateway: InstagramInsightsGateway) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <InstagramPerformanceScreen gateway={gateway} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("InstagramPerformanceScreen", () => {
  it("renders connect prompt when user has no active Instagram accounts", async () => {
    mockUseSocialAccounts.mockReturnValue({
      data: [],
      isLoading: false,
    });

    const gateway = createMockGateway();
    renderScreen(gateway);

    expect(
      screen.getByText(/Connect Your Instagram Account|No active Instagram accounts found/i),
    ).toBeInTheDocument();
  });

  it("loads report and renders overview metrics, trend chart, and media table", async () => {
    mockUseSocialAccounts.mockReturnValue({
      data: [
        {
          id: "acc-123",
          platform: "instagram",
          platform_username: "testcreator",
          is_active: true,
        },
      ],
      isLoading: false,
    });

    const gateway = createMockGateway();
    renderScreen(gateway);

    await waitFor(() => {
      expect(gateway.getReport).toHaveBeenCalledWith(
        expect.objectContaining({
          socialAccountId: "acc-123",
          periodDays: 30,
        }),
      );
    });

    // Followers metric (14.2K)
    expect(await screen.findByText("14.2K")).toBeInTheDocument();

    // Outlier badge on reel
    expect(screen.getByText(/▲ 2.5x Above/i)).toBeInTheDocument();

    // Engagement rate (10.00%)
    expect(screen.getByText("10.00%")).toBeInTheDocument();

    // Reel media ID
    expect(screen.getByText("media-999")).toBeInTheDocument();
  });

  it("calls triggerSync when Sync now button is clicked", async () => {
    mockUseSocialAccounts.mockReturnValue({
      data: [
        {
          id: "acc-123",
          platform: "instagram",
          platform_username: "testcreator",
          is_active: true,
        },
      ],
      isLoading: false,
    });

    const gateway = createMockGateway();
    renderScreen(gateway);

    // Wait for report query to finish so buttons are enabled
    expect(await screen.findByText("14.2K")).toBeInTheDocument();

    const syncButton = await screen.findByRole("button", { name: /Sync now/i });
    expect(syncButton).not.toBeDisabled();
    fireEvent.click(syncButton);

    await waitFor(() => {
      expect(gateway.triggerSync).toHaveBeenCalledWith({
        socialAccountId: "acc-123",
      });
    });
  });
});
