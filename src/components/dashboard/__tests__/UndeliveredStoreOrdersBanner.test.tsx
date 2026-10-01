import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UndeliveredStoreOrdersBanner } from "@/components/dashboard/UndeliveredStoreOrdersBanner";
import { useUndeliveredStoreAccounts } from "@/hooks/useUndeliveredStoreAccounts";

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

vi.mock("@/hooks/useUndeliveredStoreAccounts", () => ({
  useUndeliveredStoreAccounts: vi.fn(),
}));

function renderBanner() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );

  return render(<UndeliveredStoreOrdersBanner />, { wrapper });
}

describe("UndeliveredStoreOrdersBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders nothing when accounts list is empty", () => {
    vi.mocked(useUndeliveredStoreAccounts).mockReturnValue({
      data: [],
      isLoading: false,
    } as any);

    const { container } = renderBanner();
    expect(screen.queryByText(/Store orders are waiting/i)).not.toBeInTheDocument();
    expect(container.firstChild).toBeNull();
  });

  it("renders title with name and link to /messaging/whatsapp/setup for one flagged account", () => {
    vi.mocked(useUndeliveredStoreAccounts).mockReturnValue({
      data: [
        {
          id: "acc-1",
          platform_username: "xsellpoint",
        },
      ],
      isLoading: false,
    } as any);

    renderBanner();

    const title = screen.getByText(
      "Store orders are waiting for a disconnected WhatsApp account (xsellpoint)",
    );
    expect(title).toBeInTheDocument();

    const link = screen.getByRole("link", { name: "Reconnect or move setup" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/messaging/whatsapp/setup");
  });
});
