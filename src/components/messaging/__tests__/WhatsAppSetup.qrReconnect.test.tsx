import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WhatsAppSetup } from "../WhatsAppSetup";

const translate = vi.hoisted(() => (
  key: string,
  fallback?: string | Record<string, unknown>,
  options?: Record<string, unknown>,
) => {
  const template = typeof fallback === "string" ? fallback : key;
  const vars = typeof fallback === "string" ? options : fallback;
  if (!vars || typeof vars !== "object") return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ""));
});

vi.mock("@/i18n", () => ({}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: translate }),
  Trans: ({ children }: { children: React.ReactNode }) => children,
  initReactI18next: { type: "3rdParty", init: () => {} },
}));

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock("@/hooks/use-toast", () => ({ toast: toastSpy }));

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke },
    from: vi.fn(() => ({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      not: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    })),
  },
}));

const mockQrAccounts = vi.hoisted(() => ({
  current: [] as any[],
  isError: false,
  refetch: vi.fn(),
}));
vi.mock("@/hooks/useReconnectableQrAccounts", () => ({
  useReconnectableQrAccounts: () => ({
    data: mockQrAccounts.isError ? undefined : mockQrAccounts.current,
    isLoading: false,
    isError: mockQrAccounts.isError,
    refetch: mockQrAccounts.refetch,
  }),
}));

vi.mock("@/hooks/useReconnectableWhatsApp", () => ({
  useReconnectableWhatsApp: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/hooks/useWhatsAppConnect", () => ({
  useWhatsAppConnect: () => ({ mutate: vi.fn(), isPending: false }),
  useWhatsAppDisconnect: () => ({ mutate: vi.fn(), isPending: false }),
  useWhatsAppReconnect: () => ({ mutate: vi.fn(), isPending: false }),
  useWhatsAppRequestSync: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/hooks/useUserRole", () => ({
  useUserRole: () => ({ isAdmin: false }),
}));

vi.mock("@/hooks/useFeatureFlags", () => ({
  useFeatureFlags: () => ({
    flags: { waCloudApiEnabled: true, waEvolutionQrEnabled: true },
  }),
}));

vi.mock("@/hooks/useWhatsAppTpStatus", () => ({
  useWhatsAppTpStatus: () => ({ status: null, isLoading: false }),
}));

vi.mock("@/hooks/useWhatsAppSetupSummary", () => ({
  useWhatsAppSetupSummary: () => ({ data: null, isLoading: false }),
}));

const scannerMounts = vi.hoisted(() => ({
  counts: {} as Record<string, number>,
  reset() {
    this.counts = {};
  },
}));

vi.mock("../WhatsAppQrScanner", async () => {
  const React = await import("react");
  return {
    WhatsAppQrScanner: ({
      socialAccountId,
      onComplete,
      onConnectAsNew,
    }: {
      socialAccountId: string;
      onComplete?: () => void;
      onConnectAsNew?: () => void;
    }) => {
      React.useEffect(() => {
        scannerMounts.counts[socialAccountId] = (scannerMounts.counts[socialAccountId] ?? 0) + 1;
      }, []);
      return (
        <div data-testid="qr-scanner" data-account-id={socialAccountId}>
          QR Scanner Mock
          {onConnectAsNew && (
            <button data-testid="mock-connect-as-new" onClick={onConnectAsNew}>
              Connect As New Mock
            </button>
          )}
          {onComplete && (
            <button data-testid="mock-complete" onClick={onComplete}>
              Complete Mock
            </button>
          )}
        </div>
      );
    },
  };
});

let currentQueryClient: QueryClient;

function renderSetup() {
  currentQueryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={currentQueryClient}>
      <MemoryRouter>
        <WhatsAppSetup connectedAccounts={[]} />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("WhatsAppSetup QR reconnect", () => {
  const sampleQrAccount = {
    id: "qr-acc-1",
    platform_user_id: "96597950350",
    platform_username: "Direct QR Support",
    connection_mode: "evolution_qr",
    updated_at: "2026-10-01T12:00:00Z",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    scannerMounts.reset();
    mockQrAccounts.current = [sampleQrAccount];
    mockQrAccounts.isError = false;
    mockQrAccounts.refetch = vi.fn();
  });

  it("shows Reconnect button and QR disconnected copy", () => {
    renderSetup();

    expect(
      screen.getByText("Disconnected. Scan a new QR code with the same phone to restore it."),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("invokes whatsapp-evolution-bridge with reconnect_qr and mounts scanner for that id", async () => {
    invoke.mockResolvedValue({
      data: { success: true, social_account_id: "qr-acc-1", qr: "qr-code", state: "connecting" },
      error: null,
    });

    renderSetup();

    const reconnectBtn = screen.getByRole("button", { name: "Reconnect" });
    fireEvent.click(reconnectBtn);

    await waitFor(() => {
      expect(invoke).toHaveBeenCalledWith("whatsapp-evolution-bridge", {
        body: {
          action: "reconnect_qr",
          social_account_id: "qr-acc-1",
        },
      });
    });

    await waitFor(() => {
      expect(screen.getByTestId("qr-scanner")).toBeInTheDocument();
      expect(screen.getByTestId("qr-scanner")).toHaveAttribute("data-account-id", "qr-acc-1");
    });
  });

  it("scanner mock renders button that calls onConnectAsNew: clicking it unmounts scanner and opens connection-name dialog", async () => {
    invoke.mockResolvedValue({
      data: { success: true, social_account_id: "qr-acc-1", qr: "qr-code", state: "connecting" },
      error: null,
    });

    renderSetup();

    const reconnectBtn = screen.getByRole("button", { name: "Reconnect" });
    fireEvent.click(reconnectBtn);

    await waitFor(() => {
      expect(screen.getByTestId("qr-scanner")).toBeInTheDocument();
    });

    const connectAsNewBtn = screen.getByTestId("mock-connect-as-new");
    fireEvent.click(connectAsNewBtn);

    await waitFor(() => {
      expect(screen.queryByTestId("qr-scanner")).not.toBeInTheDocument();
    });

    expect(screen.getByText("Name this connection")).toBeInTheDocument();
  });

  it.each([
    ["error object", { data: null, error: { message: "Server error", status: 502 } }],
    ["error inside data payload", { data: { error: "reconnect_failed" }, error: null }],
  ])("shows toast when reconnect fails with %s", async (_, response) => {
    invoke.mockResolvedValue(response);

    renderSetup();

    const reconnectBtn = screen.getByRole("button", { name: "Reconnect" });
    fireEvent.click(reconnectBtn);

    await waitFor(() => {
      expect(toastSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Couldn't start the reconnect. Try again in a minute.",
          variant: "destructive",
        }),
      );
    });

    expect(screen.queryByTestId("qr-scanner")).not.toBeInTheDocument();
  });

  it("NEW: after scanner calls onComplete, the query key ['whatsapp-reconnectable-qr'] is invalidated", async () => {
    invoke.mockResolvedValue({
      data: { success: true, social_account_id: "qr-acc-1", qr: "qr-code", state: "connecting" },
      error: null,
    });

    renderSetup();

    const invalidateQueriesSpy = vi.spyOn(currentQueryClient, "invalidateQueries");

    const reconnectBtn = screen.getByRole("button", { name: "Reconnect" });
    fireEvent.click(reconnectBtn);

    await waitFor(() => {
      expect(screen.getByTestId("qr-scanner")).toBeInTheDocument();
    });

    const completeBtn = screen.getByTestId("mock-complete");
    fireEvent.click(completeBtn);

    expect(invalidateQueriesSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["whatsapp-reconnectable-qr"] }),
    );
  });

  it("when the reconnectable-QR query fails, shows error copy and Retry button that calls refetch", () => {
    const refetchSpy = vi.fn();
    mockQrAccounts.isError = true;
    mockQrAccounts.refetch = refetchSpy;

    renderSetup();

    expect(
      screen.getByText("Couldn't load your disconnected connections."),
    ).toBeInTheDocument();

    const retryBtn = screen.getByRole("button", { name: /retry/i });
    expect(retryBtn).toBeInTheDocument();

    fireEvent.click(retryBtn);
    expect(refetchSpy).toHaveBeenCalledTimes(1);
  });

  it("when Reconnect is clicked on a second disconnected account while the scanner for the first is mounted, the scanner is REMOUNTED for the second", async () => {
    const sampleQrAccount1 = {
      id: "qr-acc-1",
      platform_user_id: "96597950350",
      platform_username: "Direct QR Support 1",
      connection_mode: "evolution_qr",
      updated_at: "2026-10-01T12:00:00Z",
    };
    const sampleQrAccount2 = {
      id: "qr-acc-2",
      platform_user_id: "96597950351",
      platform_username: "Direct QR Support 2",
      connection_mode: "evolution_qr",
      updated_at: "2026-10-01T12:00:00Z",
    };
    mockQrAccounts.current = [sampleQrAccount1, sampleQrAccount2];

    invoke.mockImplementation(async (_fn: string, options?: any) => {
      const accountId = options?.body?.social_account_id;
      return {
        data: {
          success: true,
          social_account_id: accountId,
          qr: `qr-code-${accountId}`,
          state: "connecting",
        },
        error: null,
      };
    });

    renderSetup();

    const reconnectBtns = screen.getAllByRole("button", { name: "Reconnect" });
    expect(reconnectBtns).toHaveLength(2);

    // Click Reconnect on the first account
    fireEvent.click(reconnectBtns[0]);

    await waitFor(() => {
      expect(screen.getByTestId("qr-scanner")).toBeInTheDocument();
      expect(screen.getByTestId("qr-scanner")).toHaveAttribute("data-account-id", "qr-acc-1");
    });
    expect(scannerMounts.counts["qr-acc-1"]).toBe(1);

    // Click Reconnect on the second account while the scanner for the first is mounted
    fireEvent.click(reconnectBtns[1]);

    await waitFor(() => {
      expect(screen.getByTestId("qr-scanner")).toHaveAttribute("data-account-id", "qr-acc-2");
    });

    // Scanner must be remounted for the second id (fresh mount counter == 1)
    expect(scannerMounts.counts["qr-acc-2"]).toBe(1);
  });
});

