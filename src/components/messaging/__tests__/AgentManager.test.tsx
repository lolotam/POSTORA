import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";

vi.mock("@/hooks/useWhatsAppAgents", () => ({
  useWhatsAppAgents: () => ({
    agents: [{
      id: "ag1",
      display_name: "Sara",
      status: "online",
      current_conversations: 0,
      last_seen_at: "2026-08-22T00:00:00.000Z",
    }],
    agentsLoading: false,
    myAgent: { id: "ag1", display_name: "Sara", status: "online" },
    registerAgent: { mutate: vi.fn(), isPending: false },
    updateStatus: { mutate: vi.fn(), isPending: false },
  }),
  // Assignment records are global, not platform-scoped — this one belongs to a Facebook
  // conversation and must never surface on the Threads page.
  useConversationAssignments: () => ({
    assignments: [{
      id: "as1",
      conversation_id: "fb1_9001",
      agent_id: "ag1",
      assigned_at: "2026-08-22T00:00:00.000Z",
      notes: null,
    }],
    assignConversation: { mutate: vi.fn(), isPending: false },
    unassignConversation: { mutate: vi.fn(), isPending: false },
  }),
  useAssignmentHistory: () => ({ data: [] }),
}));

const conversationsFor = vi.fn(() => ({ data: [] }));
vi.mock("@/hooks/useMessaging", () => ({
  useMessagingAccounts: () => ({
    accounts: [
      { id: "fb1", platform: "facebook", platform_username: "brand" },
      { id: "th1", platform: "threads", platform_username: "brand" },
    ],
  }),
  useConversations: (...args: unknown[]) => conversationsFor(...(args as [])),
}));

import { AgentManager } from "@/components/messaging/AgentManager";

describe("AgentManager", () => {
  it("offers conversation assignment on a platform that has conversations", () => {
    render(<AgentManager platform="facebook" />);
    expect(screen.getByRole("button", { name: /assign/i })).toBeInTheDocument();
  });

  it("replaces the assign control with an explanation on Threads", () => {
    // Threads exposes no DM API, so there is nothing to assign. Leaving the button in place
    // would open a dialog whose conversation list can only ever be empty.
    render(<AgentManager platform="threads" />);

    expect(screen.queryByRole("button", { name: /assign/i })).not.toBeInTheDocument();
    expect(screen.getByText(/no direct messages/i)).toBeInTheDocument();
  });

  it("hides every assignment surface on Threads, including other platforms' assignments", () => {
    // Assignment rows are not platform-scoped. Showing them here would let a Threads user
    // read and unassign live Facebook and WhatsApp conversations.
    render(<AgentManager platform="threads" />);

    expect(screen.queryByRole("tab", { name: /assignments/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("tab", { name: /history/i })).not.toBeInTheDocument();
    expect(screen.queryByText(/active assignments/i)).not.toBeInTheDocument();
  });

  it("keeps the assignment surfaces on a platform that has conversations", () => {
    render(<AgentManager platform="facebook" />);

    expect(screen.getByRole("tab", { name: /assignments/i })).toBeInTheDocument();
    expect(screen.getByText(/1 active assignments/i)).toBeInTheDocument();
  });

  it("still shows the shared agent roster on Threads", () => {
    // The roster is genuinely shared — the AI agent's handover rules read agent status.
    render(<AgentManager platform="threads" />);
    expect(screen.getByText("Sara")).toBeInTheDocument();
  });
});
