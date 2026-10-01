import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UndeliveredStoreOrdersBanner } from "@/components/dashboard/UndeliveredStoreOrdersBanner";
import { supabase } from "@/integrations/supabase/client";

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

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1", email: "owner@example.com" } }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
  },
}));

interface FlaggedRow {
  id: string;
  platform_username: string | null;
  account_metadata: Record<string, unknown> | null;
}

const queryState = vi.hoisted(() => ({
  rows: [] as FlaggedRow[],
  error: null as Error | null,
}));

function mockAccountsBuilder() {
  const builder: any = {
    select: () => builder,
    eq: () => builder,
    not: () => builder,
    then: (resolve: (val: unknown) => unknown, reject?: (err: unknown) => unknown) => {
      const outcome = queryState.error
        ? { data: null, error: queryState.error }
        : { data: queryState.rows, error: null };
      return Promise.resolve(outcome).then(resolve, reject);
    },
  };
  return builder;
}

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
    queryState.rows = [];
    queryState.error = null;
    vi.mocked(supabase.from).mockImplementation(() => mockAccountsBuilder() as never);
  });

  it("(a) no flagged row renders nothing", async () => {
    queryState.rows = [];
    const { container } = renderBanner();

    await waitFor(() => {
      expect(screen.queryByText(/Store orders are waiting/i)).not.toBeInTheDocument();
    });
    expect(container.firstChild).toBeNull();
  });

  it("(b) one row renders the title text with the account name and a link to /messaging/whatsapp/setup labelled 'Reconnect or move setup'", async () => {
    queryState.rows = [
      {
        id: "acc-1",
        platform_username: "xsellpoint",
        account_metadata: {
          undelivered_store_events: {
            since: "2026-10-01T10:00:00Z",
            last_at: "2026-10-01T12:00:00Z",
          },
        },
      },
    ];

    renderBanner();

    const title = await screen.findByText(
      "Store orders are waiting for a disconnected WhatsApp account (xsellpoint)",
    );
    expect(title).toBeInTheDocument();

    const link = screen.getByRole("link", { name: "Reconnect or move setup" });
    expect(link).toBeInTheDocument();
    expect(link).toHaveAttribute("href", "/messaging/whatsapp/setup");
  });

  it("(c) query error renders nothing and does not throw", async () => {
    queryState.error = new Error("Network / query failure");
    queryState.rows = [];

    let container: HTMLElement | null = null;
    expect(() => {
      const rendered = renderBanner();
      container = rendered.container;
    }).not.toThrow();

    await waitFor(() => {
      expect(screen.queryByText(/Store orders are waiting/i)).not.toBeInTheDocument();
    });
    expect(container?.firstChild).toBeNull();
  });
});
