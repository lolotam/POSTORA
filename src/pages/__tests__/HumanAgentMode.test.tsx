import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The Human Agent queues show the AI's handoff summary for a conversation,
// whether it is still waiting (unassigned) or already claimed by me. The
// summaries come from one ai_conversation_modes query, not one per row.

const page = vi.hoisted(() => ({
  assignments: [] as Array<{
    id: string;
    conversation_id: string;
    agent_id: string | null;
    assigned_by: string | null;
    notes: string | null;
    assigned_at: string;
    unassigned_at: string | null;
  }>,
  summaryRows: [] as Array<{
    conversation_id: string;
    handoff_summary: string | null;
    expires_at: string | null;
  }>,
}));

vi.mock("@/hooks/useFeatureFlags", () => ({
  useFeatureFlags: () => ({ flags: { humanAgent: true }, isLoading: false, broadcastRefresh: vi.fn() }),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ session: { user: { id: "user-1" } } }),
}));

vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }));

vi.mock("@/components/messaging/AccountSelector", () => ({
  AccountSelector: () => null,
}));

vi.mock("@/hooks/useWhatsAppAgents", () => ({
  useWhatsAppAgents: () => ({
    myAgent: {
      id: "agent-1",
      workspace_id: "ws-1",
      user_id: "user-1",
      display_name: "Me",
      avatar_url: null,
      status: "online",
      max_conversations: 10,
      current_conversations: 0,
      last_seen_at: "2026-09-25T00:00:00Z",
      created_at: "2026-09-25T00:00:00Z",
    },
    registerAgent: { mutate: vi.fn() },
    updateStatus: { mutateAsync: vi.fn() },
    updateMaxConversations: { mutate: vi.fn() },
  }),
  useConversationAssignments: () => ({
    assignments: page.assignments,
    assignConversation: { mutate: vi.fn() },
    unassignConversation: { mutate: vi.fn() },
  }),
  useAssignmentHistory: () => ({ data: [] }),
}));

vi.mock("@/hooks/useMessaging", () => ({
  useMessagingAccounts: () => ({
    accounts: [
      { id: "wa-account-1", platform: "whatsapp", platform_user_id: "1", platform_username: null, avatar_url: null },
    ],
  }),
  useConversations: (accountId: string | null, messagingPlatform: string) => ({
    data:
      accountId && messagingPlatform === "WHATSAPP"
        ? [
            {
              id: "wa-conv-1",
              assignment_key: "wa_1_customer-1",
              participant_name: "Sara",
              participant_id: "customer-1",
              participant_avatar: null,
              last_message: "وين طلبي؟",
              last_message_time: "2026-09-25T09:00:00Z",
              last_message_from: "customer",
              unread_count: 0,
              updated_time: "2026-09-25T09:00:00Z",
            },
          ]
        : [],
  }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          not: vi.fn(() => ({
            gt: vi.fn((_column: string, cutoff: string) => Promise.resolve({
              data: page.summaryRows.filter((row) => row.handoff_summary !== null && row.expires_at !== null && row.expires_at > cutoff),
              error: null,
            })),
          })),
        })),
      })),
    })),
  },
}));

import HumanAgentMode from "@/pages/HumanAgentMode";

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <HumanAgentMode />
    </QueryClientProvider>,
  );
}

describe("HumanAgentMode handoff summaries", () => {
  beforeEach(() => {
    page.assignments = [];
    page.summaryRows = [
      {
        conversation_id: "wa_1_customer-1",
        handoff_summary: "Asking where order 42 is; I told her it shipped yesterday.",
        expires_at: "2099-01-01T00:00:00.000Z",
      },
    ];
  });

  it("a waiting conversation whose mode row has a summary shows it", async () => {
    renderPage();

    expect(await screen.findByText(/Asking where order 42 is/)).toBeInTheDocument();
    expect(screen.getByText(/AI summary/)).toBeInTheDocument();
  });

  it("an assigned conversation in my queue also shows the summary", async () => {
    page.assignments = [
      {
        id: "assignment-1",
        conversation_id: "wa_1_customer-1",
        agent_id: "agent-1",
        assigned_by: "user-1",
        notes: null,
        assigned_at: "2026-09-25T09:05:00Z",
        unassigned_at: null,
      },
    ];

    renderPage();

    expect(await screen.findByText(/Asking where order 42 is/)).toBeInTheDocument();
  });

  it("shows no summary line when the mode row has none", async () => {
    page.summaryRows = [];

    renderPage();

    expect(await screen.findByText("Sara")).toBeInTheDocument();
    expect(screen.queryByText(/AI summary/)).not.toBeInTheDocument();
  });
});
