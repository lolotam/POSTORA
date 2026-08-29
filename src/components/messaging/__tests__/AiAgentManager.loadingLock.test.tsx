import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Regression guard (Codex review, PR #69). After discarding edits to switch to an
// account whose config is not cached, the form keeps showing the PREVIOUS account's
// values until the query settles. It used to stay editable through that window, and
// because the baseline is null there, useDirtyForm read anything typed as clean -- so
// neither the transition guard nor beforeunload protected it, and the arriving config
// overwrote it silently. The fields must be locked while the config is in flight.

const upsertConfig = { mutate: vi.fn(), isPending: false };

const loadedConfig = {
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
};

vi.mock("@/hooks/useAiAgentConfig", () => ({
  // Account a2's read never settles, which is exactly the loading window under test.
  useAiAgentConfig: (_platform: string, accountId?: string | null) => ({
    config: accountId === "a1" ? loadedConfig : undefined,
    isLoading: accountId !== "a1",
    error: null,
    upsertConfig,
  }),
}));

vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({
    data: [
      { id: "a1", platform: "instagram", platform_username: "Brand A", platform_user_id: "1", is_active: true },
      { id: "a2", platform: "instagram", platform_username: "Brand B", platform_user_id: "2", is_active: true },
    ],
  }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/messaging/AutomationHandlerCard", () => ({ AutomationHandlerCard: () => null }));
vi.mock("@/components/messaging/AutoReplyManager", () => ({ AutoReplyManager: () => null }));
vi.mock("@/components/messaging/AiKnowledgeManager", () => ({ AiKnowledgeManager: () => null }));
vi.mock("@/components/messaging/AiAgentLogsView", () => ({ AiAgentLogsView: () => null }));
vi.mock("@/components/messaging/AiAgentTestChat", () => ({ AiAgentTestChat: () => null }));
vi.mock("@/components/automation/DatabaseConnectorsManager", () => ({ DatabaseConnectorsManager: () => null }));

import { AiAgentManager } from "../AiAgentManager";

describe("AiAgentManager form lock while a config is loading", () => {
  it("locks the fields after discarding into an account whose config has not arrived", async () => {
    render(<AiAgentManager platform="instagram" />);

    const persona = await screen.findByLabelText(/persona and instructions/i);
    expect(persona).toBeEnabled();

    fireEvent.change(persona, { target: { value: "typed but unsaved" } });
    fireEvent.keyDown(screen.getByTestId("agent-account"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Brand B" }));
    fireEvent.click(await screen.findByRole("button", { name: /discard changes/i }));

    // a2's config never settles, so the form still shows a1's text -- and must be locked,
    // because anything typed here would read as clean and then be overwritten.
    expect(await screen.findByLabelText(/persona and instructions/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: /save settings/i })).toBeDisabled();
  });

  it("leaves the fields editable once the config has loaded", async () => {
    render(<AiAgentManager platform="instagram" />);

    expect(await screen.findByLabelText(/persona and instructions/i)).toBeEnabled();
    expect(screen.getByRole("button", { name: /save settings/i })).toBeEnabled();
  });
});
