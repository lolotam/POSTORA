import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import UnifiedInboxesPage from "../UnifiedInboxesPage";

vi.mock("@/hooks/useFeatureFlags", () => ({
  useFeatureFlags: () => ({
    flags: {
      msgWhatsapp: true,
      msgFacebook: true,
      msgInstagram: true,
      msgThreads: true,
      commentManager: true,
    },
    isLoading: false,
  }),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "test-user-id", email: "test@example.com" },
    session: {},
  }),
}));

vi.mock("@/hooks/useUserRole", () => ({
  useUserRole: () => ({
    role: "admin",
    isAdmin: true,
    isSubscriber: true,
    isLoading: false,
  }),
}));

vi.mock("@/hooks/useMessaging", () => ({
  useMessagingAccounts: () => ({ accounts: [], isLoading: false }),
  useConversations: () => ({ data: [], isLoading: false, error: null }),
}));

vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({ data: [], isLoading: false }),
}));

vi.mock("@/hooks/useWhatsAppLabels", () => ({
  useWhatsAppLabels: () => ({ assignments: [] }),
}));

vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div data-testid="dashboard-layout">{children}</div>,
}));

describe("UnifiedInboxesPage", () => {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  it("renders the unified inboxes page header and 3D channel cards", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/messaging"]}>
          <UnifiedInboxesPage />
        </MemoryRouter>
      </QueryClientProvider>
    );

    expect(screen.getByText("Unified Inboxes")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /WhatsApp/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Facebook/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Instagram/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /Threads/i })).toBeInTheDocument();
  });

  it("switches active channel when clicking provider card", () => {
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={["/messaging"]}>
          <UnifiedInboxesPage />
        </MemoryRouter>
      </QueryClientProvider>
    );

    const facebookTab = screen.getByRole("tab", { name: /Facebook/i });
    fireEvent.click(facebookTab);
    expect(facebookTab).toHaveAttribute("aria-selected", "true");
  });
});
