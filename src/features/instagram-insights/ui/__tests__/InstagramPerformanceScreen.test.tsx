import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { SupabaseInstagramInsightsGateway } from "../../infrastructure/supabaseInstagramInsightsGateway";
import type { InstagramInsightsGateway } from "../../application/ports";
import { reportFixture } from "../../tests/reportFixture";
import { InstagramPerformanceScreen } from "../InstagramPerformanceScreen";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: vi.fn() } },
}));

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
  afterEach(() => vi.restoreAllMocks());

  it.each([
    ["collection_disabled", "Instagram insights collection is currently disabled. Contact support to check availability."],
    ["collection_not_eligible", "This account is not enabled for Instagram insights collection yet."],
    ["throttled", "Too many sync requests. Please wait before trying again."],
    ["settings_unavailable", "Instagram insights are temporarily unavailable. Please try again later."],
    ["not_found", "Instagram account not found or no longer connected."],
    ["enqueue_indeterminate", "We could not confirm whether syncing started. Wait and check the report before trying again."],
    ["unknown_server_code", "Failed to queue sync job"],
    ["constructor", "Failed to queue sync job"],
  ])("explains the %s sync refusal instead of exposing its machine code", async (code, expectedMessage) => {
    mockUseSocialAccounts.mockReturnValue({
      data: [{ id: "acc-123", platform: "instagram", platform_username: "testcreator", is_active: true }],
      isLoading: false,
    });
    const response = new Response(JSON.stringify({ error: code }), { status: 503 });
    vi.mocked(supabase.functions.invoke)
      .mockResolvedValueOnce({ data: mockReport, error: null })
      .mockResolvedValueOnce({ data: null, error: new FunctionsHttpError(response) });
    const errorToast = vi.spyOn(toast, "error");

    renderScreen(new SupabaseInstagramInsightsGateway());
    expect(await screen.findByText("14.2K")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Sync now/i }));

    await waitFor(() => {
      expect(errorToast).toHaveBeenCalledWith(expectedMessage);
    });
    expect(await response.json()).toEqual({ error: code });
  });

  it("shows a report fallback instead of an unknown server code", async () => {
    mockUseSocialAccounts.mockReturnValue({
      data: [{ id: "acc-123", platform: "instagram", platform_username: "testcreator", is_active: true }],
      isLoading: false,
    });
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: new FunctionsHttpError(new Response(JSON.stringify({ error: "unknown_report_code" }), { status: 503 })),
    });

    renderScreen(new SupabaseInstagramInsightsGateway());

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Failed to load report");
    expect(alert).not.toHaveTextContent("unknown_report_code");
    expect(alert).not.toHaveTextContent("non-2xx");
    vi.mocked(supabase.functions.invoke).mockReset();
  });

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
