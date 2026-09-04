import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const upsertConfig = { mutate: vi.fn(), isPending: false };
const hookArgs: Array<[string, string | null]> = [];

const configsByAccount: Record<string, Record<string, unknown>> = {
  a1: {
    is_enabled: true,
    default_mode: "ai_first",
    persona_instructions: "Brand A persona",
    business_profile_text: "",
    language_mode: "auto",
    temperature: 0.4,
    admin_phone_numbers: [],
    daily_message_cap: 50,
    reply_cooldown_seconds: 0,
    max_tool_iterations: 5,
    handoff_on_request: true,
    handoff_on_low_confidence: false,
  },
  a2: {
    is_enabled: true,
    default_mode: "human_then_ai",
    persona_instructions: "Brand B persona",
    business_profile_text: "",
    language_mode: "en",
    temperature: 0.2,
    admin_phone_numbers: [],
    daily_message_cap: 25,
    reply_cooldown_seconds: 2,
    max_tool_iterations: 3,
    handoff_on_request: true,
    handoff_on_low_confidence: true,
  },
};

vi.mock("@/hooks/useAiAgentConfig", () => ({
  useAiAgentConfig: (platform: string, accountId?: string | null) => {
    const scopedAccountId = accountId ?? null;
    hookArgs.push([platform, scopedAccountId]);
    return {
      config: scopedAccountId ? configsByAccount[scopedAccountId] ?? null : null,
      isLoading: false,
      error: null,
      upsertConfig,
    };
  },
}));

const accounts = [
  { id: "a1", platform: "instagram", platform_username: "Brand A", platform_user_id: "1", is_active: true },
  { id: "a2", platform: "instagram", platform_username: "Brand B", platform_user_id: "2", is_active: true },
];

vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({ data: accounts }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/messaging/AutomationHandlerCard", () => ({ AutomationHandlerCard: () => null }));
vi.mock("@/components/messaging/AutoReplyManager", () => ({ AutoReplyManager: () => null }));
vi.mock("@/components/messaging/AiKnowledgeManager", () => ({ AiKnowledgeManager: () => null }));
vi.mock("@/components/messaging/AiAgentLogsView", () => ({ AiAgentLogsView: () => null }));
vi.mock("@/components/messaging/AiAgentTestChat", () => ({ AiAgentTestChat: () => null }));
vi.mock("@/components/automation/DatabaseConnectorsManager", () => ({ DatabaseConnectorsManager: () => null }));

import { AiAgentManager } from "../AiAgentManager";

function lastAccountScopedWith(): string | null {
  return hookArgs[hookArgs.length - 1]?.[1] ?? null;
}

describe("AiAgentManager unsaved-changes guard", () => {
  beforeEach(() => {
    hookArgs.length = 0;
    upsertConfig.mutate.mockReset();
  });

  it("switching account with unsaved edits opens the dialog", async () => {
    render(<AiAgentManager platform="instagram" />);

    fireEvent.change(await screen.findByLabelText(/additional instructions/i), {
      target: { value: "a brand new persona" },
    });
    fireEvent.keyDown(screen.getByTestId("agent-account"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Brand B" }));

    expect(await screen.findByText(/you have unsaved changes/i)).toBeInTheDocument();
  });

  it("Keep editing keeps the text and does NOT switch account", async () => {
    render(<AiAgentManager platform="instagram" />);
    const field = await screen.findByLabelText(/additional instructions/i);
    fireEvent.change(field, { target: { value: "a brand new persona" } });
    fireEvent.keyDown(screen.getByTestId("agent-account"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Brand B" }));
    fireEvent.click(await screen.findByRole("button", { name: /keep editing/i }));

    expect((field as HTMLTextAreaElement).value).toBe("a brand new persona");
    expect(lastAccountScopedWith()).toBe("a1");
  });

  it("Discard changes switches account and loads its values", async () => {
    render(<AiAgentManager platform="instagram" />);
    fireEvent.change(await screen.findByLabelText(/additional instructions/i), {
      target: { value: "a brand new persona" },
    });
    fireEvent.keyDown(screen.getByTestId("agent-account"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Brand B" }));
    fireEvent.click(await screen.findByRole("button", { name: /discard changes/i }));

    expect(lastAccountScopedWith()).toBe("a2");
    // Assert the positive, not merely "not the old text": a blank or default-filled
    // field would also satisfy not.toBe(...), and a discard that loses the target
    // account's persona is exactly the failure this guard exists to prevent.
    expect((await screen.findByLabelText(/additional instructions/i) as HTMLTextAreaElement).value)
      .toBe("Brand B persona");
  });

  it("switching account with no edits does not prompt", async () => {
    render(<AiAgentManager platform="instagram" />);
    fireEvent.keyDown(screen.getByTestId("agent-account"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Brand B" }));

    expect(screen.queryByText(/you have unsaved changes/i)).not.toBeInTheDocument();
    expect(lastAccountScopedWith()).toBe("a2");
  });
});
