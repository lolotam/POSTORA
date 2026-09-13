import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AiConversationModeSelect } from "@/components/messaging/AiConversationModeSelect";

const callMessagingApi = vi.fn();
vi.mock("@/lib/messagingApi", () => ({
  callMessagingApi: (...args: unknown[]) => callMessagingApi(...args),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ session: { user: { id: "user-1" } } }),
}));

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

function renderComponent(props = { platform: "whatsapp" as const, conversationId: "c1" }) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <AiConversationModeSelect {...props} />
    </QueryClientProvider>,
  );
}

describe("AiConversationModeSelect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("shows the escalation badge and a Release override button while an escalation override is active", async () => {
    callMessagingApi.mockResolvedValueOnce({
      mode: {
        id: "mode-1",
        user_id: "user-1",
        platform: "whatsapp",
        conversation_id: "c1",
        mode: "human_first",
        expires_at: "2099-01-01T10:00:00Z",
        created_at: "2026-09-13T00:00:00Z",
        updated_at: "2026-09-13T00:00:00Z",
      },
    });

    renderComponent();

    expect(await screen.findByText(/Escalated to human/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Release override" })).toBeInTheDocument();
  });

  it("a manual override without an expiry shows no badge", async () => {
    callMessagingApi.mockResolvedValueOnce({
      mode: {
        id: "mode-1",
        user_id: "user-1",
        platform: "whatsapp",
        conversation_id: "c1",
        mode: "human_first",
        expires_at: null,
        created_at: "2026-09-13T00:00:00Z",
        updated_at: "2026-09-13T00:00:00Z",
      },
    });

    renderComponent();

    expect(await screen.findByText("AI: Human first")).toBeInTheDocument();
    expect(screen.queryByText(/Escalated to human/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Release override" })).not.toBeInTheDocument();
  });

  it("Release override sends the default mode", async () => {
    callMessagingApi.mockImplementation((action: string) => {
      if (action === "ai_get_conversation_mode") {
        return Promise.resolve({
          mode: {
            id: "mode-1",
            user_id: "user-1",
            platform: "whatsapp",
            conversation_id: "c1",
            mode: "human_first",
            expires_at: "2099-01-01T10:00:00Z",
            created_at: "2026-09-13T00:00:00Z",
            updated_at: "2026-09-13T00:00:00Z",
          },
        });
      }
      if (action === "ai_set_conversation_mode") {
        return Promise.resolve({ mode: null });
      }
      return Promise.resolve({});
    });

    renderComponent();

    const releaseButton = await screen.findByRole("button", { name: "Release override" });
    fireEvent.click(releaseButton);

    await waitFor(() => {
      expect(callMessagingApi).toHaveBeenCalledWith("ai_set_conversation_mode", {
        platform: "whatsapp",
        conversation_id: "c1",
        mode: "default",
      });
    });
  });
});
