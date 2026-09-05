import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Regression guard (Codex review round 3, PR #69). A save for account A that resolves
// after the user has switched to account B used to write A's captured form into the
// shared baseline. B's untouched fields then compared unequal, so B read as dirty and the
// next transition prompted for edits nobody had made.

const cfg = (persona: string) => ({
  is_enabled: true,
  default_mode: "ai_first",
  persona_instructions: persona,
  business_profile_text: "",
  language_mode: "auto",
  temperature: 0.4,
  admin_phone_numbers: [],
  daily_message_cap: 50,
  reply_cooldown_seconds: 0,
  max_tool_iterations: 5,
  handoff_on_request: true,
  handoff_on_low_confidence: false,
});
const configs: Record<string, unknown> = { a1: cfg("Brand A persona"), a2: cfg("Brand B persona") };

/** Held so the test can resolve the mutation after the account has already changed. */
let pendingOnSuccess: (() => void) | null = null;

const upsertConfig = {
  mutate: vi.fn((_form: unknown, opts?: { onSuccess?: () => void }) => {
    pendingOnSuccess = opts?.onSuccess ?? null;
  }),
  isPending: false,
};

vi.mock("@/hooks/useAiAgentConfig", () => ({
  useAiAgentConfig: (_platform: string, accountId?: string | null) => ({
    config: accountId ? configs[accountId] ?? null : null,
    isLoading: false,
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

describe("AiAgentManager save resolving after an account switch", () => {
  it("does not re-baseline the new account with the saved account's form", async () => {
    render(<AiAgentManager platform="instagram" />);

    fireEvent.change(await screen.findByLabelText(/additional instructions/i), {
      target: { value: "A's edited persona" },
    });
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));
    expect(upsertConfig.mutate).toHaveBeenCalledTimes(1);

    // Move to B while A's mutation is still in flight. The form is dirty, so this is the
    // guarded path; discarding is what a user does when the save is already away.
    fireEvent.keyDown(screen.getByTestId("agent-account"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Brand B" }));
    fireEvent.click(await screen.findByRole("button", { name: /discard changes/i }));
    expect((await screen.findByLabelText(/additional instructions/i) as HTMLTextAreaElement).value)
      .toBe("Brand B persona");

    // A's save now lands.
    pendingOnSuccess?.();

    // B was never edited, so nothing should be treated as unsaved: switching back to A
    // must go straight through with no discard prompt.
    fireEvent.keyDown(screen.getByTestId("agent-account"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Brand A" }));

    expect(screen.queryByText(/you have unsaved changes/i)).not.toBeInTheDocument();
  });
});
