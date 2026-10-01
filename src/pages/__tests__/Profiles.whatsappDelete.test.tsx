import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import Profiles from "@/pages/Profiles";
import { useWhatsAppSetupSummary } from "@/hooks/useWhatsAppSetupSummary";

const mockToast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: mockToast }),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1", email: "test@example.com" } }),
}));

vi.mock("@/hooks/useUserRole", () => ({
  useUserRole: () => ({ isAdmin: false }),
}));

vi.mock("@/hooks/useFeatureFlags", () => ({
  useFeatureFlags: () => ({
    flags: {
      tabWhatsapp: true,
      tabFacebook: false,
      tabInstagram: false,
      tabThreads: false,
      tabTiktok: false,
      tabYoutube: false,
      tabLinkedin: false,
      tabTwitter: false,
      tabPinterest: false,
      tabBluesky: false,
      tabReddit: false,
      tokenLifetime: false,
    },
    isLoading: false,
  }),
}));

vi.mock("@/hooks/useBetaPlatforms", () => ({
  useBetaPlatforms: () => ({ isBeta: () => false }),
}));

vi.mock("@/hooks/useQuotas", () => ({
  useQuotas: () => ({
    quotas: { max_social_accounts: 10 },
    usage: { social_accounts_count: 1 },
    canAddAccount: () => true,
  }),
}));

vi.mock("@/hooks/useRealtimeSocialAccounts", () => ({
  useRealtimeSocialAccounts: vi.fn(),
}));

vi.mock("@/hooks/useProfileOAuth", () => ({
  useProfileOAuth: () => ({
    connectingPlatform: null,
    handleConnectPlatform: vi.fn(),
    handleReconnectPlatform: vi.fn(),
    selectingPage: false,
    pageSelectionData: null,
    clearPageSelection: vi.fn(),
    handleSelectPage: vi.fn(),
    handleSelectStandaloneInstagram: vi.fn(),
    blueskyDialogData: null,
    clearBlueskyDialog: vi.fn(),
    handleBlueskyConnect: vi.fn(),
    handleBlueskyOAuthConnect: vi.fn(),
    instagramFlowRequest: null,
    selectInstagramFlow: vi.fn(),
    clearInstagramFlowRequest: vi.fn(),
  }),
}));

vi.mock("@/features/connectors", () => ({
  useConnectorWorkspace: () => ({ workspaceId: "ws-1" }),
}));

vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

const translate = vi.hoisted(() => (
  key: string,
  fallback?: string | Record<string, unknown>,
  options?: Record<string, unknown>,
) => {
  const template = typeof fallback === "string" ? fallback : key;
  const vars = typeof fallback === "string" ? options : fallback;
  if (!vars) return template;
  return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(vars[name] ?? ""));
});

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: translate }) }));

vi.mock("@/hooks/useWhatsAppSetupSummary", () => ({
  useWhatsAppSetupSummary: vi.fn(),
}));

const mockMutateAsync = vi.fn();
const mockSocialProfiles = [
  { id: "prof-1", name: "Main Profile", user_id: "user-1" },
];
const mockSocialAccounts = [
  {
    id: "wa-acc-1",
    user_id: "user-1",
    platform: "whatsapp",
    platform_username: "xsellpoint",
    platform_user_id: "96597950350",
    is_active: true,
    account_metadata: {},
    social_profile_id: "prof-1",
  },
];

vi.mock("@/hooks/useSocialProfiles", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    useSocialProfiles: () => ({ data: mockSocialProfiles }),
    useAllSocialAccounts: () => ({
      data: mockSocialAccounts,
      isLoading: false,
      refetch: vi.fn(),
    }),
    useEnsureDefaultProfile: () => ({ defaultProfileId: "prof-1", isEnsuring: false }),
    useDisconnectAccountFromProfile: () => ({
      mutateAsync: mockMutateAsync,
      isPending: false,
    }),
  };
});

function renderProfiles() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Profiles />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

async function triggerWhatsAppDeletion(container: HTMLElement) {
  // Find the delete button (trash icon) for the WhatsApp account row in the table
  const deleteBtn = container.querySelector("button svg.lucide-trash-2")?.closest("button");
  expect(deleteBtn).toBeTruthy();
  fireEvent.click(deleteBtn!);

  // If the initial DisconnectAccountDialog appears, click "Disconnect" to proceed to handleDisconnectAccount
  const initialDisconnectBtn = screen.queryByRole("button", { name: /^disconnect$/i });
  if (initialDisconnectBtn) {
    fireEvent.click(initialDisconnectBtn);
  }
}

describe("Profiles - WhatsApp account deletion confirmation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMutateAsync.mockReset();
    vi.mocked(useWhatsAppSetupSummary).mockReturnValue({
      data: {
        agent_config: 1,
        connectors: 1,
        connector_links: 0,
        store_bindings: 1,
        knowledge_sources: 5,
        test_cases: 0,
        waitlist: 0,
        templates: 0,
        partner_keys_primary: 0,
        partner_key_links: 0,
        partner_webhooks: 0,
        n8n_subscriptions: 0,
        scheduled_messages: 0,
        automation_handlers: ["automation_handler"],
      },
      isLoading: false,
    } as any);
  });

  it("removing a WhatsApp account opens a confirmation containing warning and summary lines, and confirming calls delete mutation", async () => {
    mockMutateAsync.mockResolvedValue({});
    const { container } = renderProfiles();

    await triggerWhatsAppDeletion(container);

    // Confirmation dialog opens containing the required warning text:
    expect(
      await screen.findByText(/This permanently deletes the account and its AI agent setup/i),
    ).toBeInTheDocument();

    // Summary lines from useWhatsAppSetupSummary are shown:
    expect(screen.getByText(/AI agent settings/i)).toBeInTheDocument();
    expect(screen.getByText(/1 connector/i)).toBeInTheDocument();
    expect(screen.getByText(/1 store webhook/i)).toBeInTheDocument();
    expect(screen.getByText(/5 knowledge sources/i)).toBeInTheDocument();

    // Confirm button in confirmation dialog calls delete mutation:
    const confirmBtn = screen.getByRole("button", {
      name: /delete|permanently delete|confirm/i,
    });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledWith("wa-acc-1");
    });
  });

  it("shows specific toast when delete mutation fails with code 23503", async () => {
    const error23503 = Object.assign(new Error("Foreign key constraint violation"), {
      code: "23503",
    });
    mockMutateAsync.mockRejectedValue(error23503);

    const { container } = renderProfiles();

    await triggerWhatsAppDeletion(container);

    expect(
      await screen.findByText(/This permanently deletes the account and its AI agent setup/i),
    ).toBeInTheDocument();

    const confirmBtn = screen.getByRole("button", {
      name: /delete|permanently delete|confirm/i,
    });
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(mockToast).toHaveBeenCalledWith(
        expect.objectContaining({
          description:
            "This account can't be deleted while connectors or partner integrations use it. Disconnect it from the WhatsApp page instead.",
        }),
      );
    });
  });
});
