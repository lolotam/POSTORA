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

const mockQrAccounts = vi.hoisted(() => ({ current: [] as any[] }));
vi.mock("@/hooks/useReconnectableQrAccounts", () => ({
  useReconnectableQrAccounts: () => ({
    data: mockQrAccounts.current,
    isLoading: false,
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

vi.mock("../WhatsAppQrScanner", () => ({
  WhatsAppQrScanner: ({ socialAccountId }: { socialAccountId: string }) => (
    <div data-testid="qr-scanner" data-account-id={socialAccountId}>
      QR Scanner Mock
    </div>
  ),
}));

function renderSetup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
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
    mockQrAccounts.current = [sampleQrAccount];
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

  it("shows toast when reconnect fails with 502", async () => {
    invoke.mockResolvedValue({
      data: null,
      error: { message: "Server error", status: 502 },
    });

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
});
