import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const whatsAppState = vi.hoisted(() => ({
  data: undefined as { messages: unknown[]; truncated: boolean } | undefined,
  isLoading: false,
  isFetching: false,
  error: null as Error | null,
  refetch: vi.fn(),
}));

vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: translate }) }));
vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "user-1", email: "owner@example.com" } }) }));
vi.mock("@/hooks/useUserRole", () => ({ useUserRole: () => ({ isAdmin: true }) }));
vi.mock("@/hooks/useSocialAccounts", () => ({ useSocialAccounts: () => ({ data: [] }) }));
vi.mock("@/hooks/useSocialProfiles", () => ({ useSocialProfiles: () => ({ data: [] }) }));
vi.mock("@/hooks/usePosts", () => ({
  usePosts: () => ({
    data: [{
      id: "post-1",
      user_id: "user-1",
      caption: "Launch day",
      platforms: ["instagram"],
      media_file_ids: [],
      status: "scheduled",
      scheduled_at: "2026-12-01T15:00:00.000Z",
      posted_at: null,
      created_at: "2026-09-01T00:00:00.000Z",
      metadata: {},
    }],
    isLoading: false,
    error: null,
    refetch: vi.fn(),
    isFetching: false,
  }),
}));
vi.mock("@/features/scheduled/whatsappScheduledItems", () => ({
  useWhatsAppScheduledItems: () => whatsAppState,
}));
vi.mock("@/hooks/useWhatsAppScheduledMessages", () => ({
  SCHEDULED_CANCEL_BLOCKED: "This message is already being sent and can no longer be cancelled.",
  SCHEDULED_CHANGE_BLOCKED: "This message can no longer be changed (it is being sent, was sent, or was cancelled).",
  SCHEDULED_RESCHEDULE_TOO_SOON: "Choose a time at least one minute from now.",
  useWhatsAppScheduledMessages: () => ({
    cancel: { mutate: vi.fn(), isPending: false },
    reschedule: { mutate: vi.fn(), isPending: false },
  }),
}));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: () => ({
      select: () => ({
        eq: () => ({
          order: () => Promise.resolve({ data: [], error: null }),
        }),
      }),
    }),
    functions: { invoke: vi.fn() },
  },
}));

import ScheduledPosts from "@/pages/ScheduledPosts";

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ScheduledPosts />
    </QueryClientProvider>,
  );
}

describe("ScheduledPosts WhatsApp board", () => {
  beforeEach(() => {
    whatsAppState.error = null;
    whatsAppState.isLoading = false;
    whatsAppState.data = {
      truncated: false,
      messages: [{
        id: "wa-1",
        recipient_phone: "96550001111",
        recipient_name: null,
        message_text: "Bring the file",
        media_url: null,
        media_type: null,
        media_filename: null,
        scheduled_at: "2026-12-01T16:00:00.000Z",
        status: "pending",
        account_name: "Clinic",
        avatar_url: null,
      }],
    };
  });

  it("shows a query error instead of an empty board", () => {
    whatsAppState.error = new Error("statement timeout");
    whatsAppState.data = undefined;
    renderPage();
    expect(screen.getByText("Couldn't load scheduled WhatsApp messages.")).toBeInTheDocument();
    expect(screen.queryByText("No scheduled posts or messages")).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("96550001111");
  });

  it("keeps edit, publish now, and bulk select-all on posts only", () => {
    renderPage();
    expect(screen.getByText("Launch day")).toBeInTheDocument();
    expect(screen.getByText("•••• 1111")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(2);
    const more = screen.getByRole("button", { name: "View more options" });
    fireEvent.pointerDown(more, { button: 0, pointerType: "mouse" });
    expect(screen.getByRole("menuitem", { name: "Quick Edit" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Publish Now" })).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("96550001111");
  });
});
