import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// agent_behavior is ONE jsonb column written by four different cards. Every
// test here is ultimately about that: a card that replaces the object instead
// of merging into it makes whichever card the user touched last silently erase
// the other three.

const upsertConfig = { mutate: vi.fn(), isPending: false };
let configValue: null | Record<string, unknown> = null;

vi.mock("@/hooks/useAiAgentConfig", () => ({
  useAiAgentConfig: () => ({
    config: configValue === null ? null : { ...configValue },
    isLoading: false,
    error: null,
    upsertConfig,
  }),
}));
vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({
    data: [{ id: "a1", platform: "facebook", platform_username: "Eltamlawy", is_active: true }],
  }),
}));
vi.mock("@/components/messaging/AutomationHandlerCard", () => ({
  AutomationHandlerCard: () => null,
}));
vi.mock("@/components/messaging/AiKnowledgeManager", () => ({ AiKnowledgeManager: () => null }));
vi.mock("@/components/messaging/AiAgentLogsView", () => ({ AiAgentLogsView: () => null }));
vi.mock("@/components/messaging/AiAgentTestChat", () => ({ AiAgentTestChat: () => null }));
vi.mock("@/components/messaging/AutoReplyManager", () => ({ AutoReplyManager: () => null }));
vi.mock("@/components/automation/DatabaseConnectorsManager", () => ({
  DatabaseConnectorsManager: () => null,
}));

import { AiAgentManager } from "@/components/messaging/AiAgentManager";

const saveSettings = () => fireEvent.click(screen.getByRole("button", { name: /save settings/i }));
const lastPayload = () =>
  (upsertConfig.mutate.mock.calls.at(-1) as [Record<string, unknown>, unknown])[0];

describe("AiAgentManager behavior cards", () => {
  beforeEach(() => {
    upsertConfig.mutate.mockClear();
    configValue = { agent_behavior: {} };
  });

  it("merges tone and response length into an existing behavior", () => {
    configValue = { agent_behavior: { goals: ["capture_leads"] } };
    render(<AiAgentManager platform="facebook" />);

    fireEvent.click(screen.getByRole("radio", { name: /^formal/i }));
    fireEvent.click(screen.getByRole("radio", { name: /^short/i }));
    saveSettings();

    expect(lastPayload().agent_behavior).toEqual({
      goals: ["capture_leads"],
      tone: "formal",
      response_length: "short",
    });
  });

  it("keeps the goals a second card set when a third card writes", () => {
    render(<AiAgentManager platform="facebook" />);

    fireEvent.click(screen.getByRole("checkbox", { name: /answer price, stock/i }));
    fireEvent.change(screen.getByLabelText(/opening message/i), {
      target: { value: "Welcome to Xsellpoint." },
    });
    saveSettings();

    expect(lastPayload().agent_behavior).toEqual({
      goals: ["answer_pricing"],
      greeting: "Welcome to Xsellpoint.",
    });
  });

  it("unticking a goal removes only that goal", () => {
    configValue = { agent_behavior: { goals: ["answer_pricing", "capture_leads"] } };
    render(<AiAgentManager platform="facebook" />);

    fireEvent.click(screen.getByRole("checkbox", { name: /answer price, stock/i }));
    saveSettings();

    expect(lastPayload().agent_behavior).toEqual({ goals: ["capture_leads"] });
  });

  it("adds and removes instruction blocks", () => {
    render(<AiAgentManager platform="facebook" />);

    fireEvent.click(screen.getByRole("button", { name: /add an instruction block/i }));
    fireEvent.change(screen.getByLabelText("Block 1 title"), { target: { value: "Pricing" } });
    fireEvent.change(screen.getByLabelText("Block 1 instructions"), {
      target: { value: "Always check the connector." },
    });
    saveSettings();

    expect(lastPayload().agent_behavior).toEqual({
      instruction_blocks: [{ title: "Pricing", body: "Always check the connector." }],
    });
  });

  it("shows the two hallucination guards as always on, never as switches", () => {
    // knowledgeOnlyRule and the escalate-on-unknown rule are unconditional in
    // ai-agent-reply, and were tightened after the 2026-09-01 incident. A switch
    // here would promise control the prompt does not honour.
    render(<AiAgentManager platform="facebook" />);

    for (const testId of ["guard-strict-knowledge", "guard-admits-unknown"]) {
      const guard = screen.getByTestId(testId);
      expect(guard).toHaveTextContent(/always on/i);
      expect(within(guard).queryByRole("switch")).toBeNull();
    }
  });

  it("writes the two handoff switches, which are real", () => {
    // Unlike the guards above, these two gate both the prompt rule AND whether
    // escalate_to_human is offered to the model at all.
    configValue = { handoff_on_request: true, handoff_on_low_confidence: true };
    render(<AiAgentManager platform="facebook" />);

    fireEvent.click(screen.getByRole("switch", { name: /asks for a person/i }));
    saveSettings();

    expect(lastPayload().handoff_on_request).toBe(false);
    expect(lastPayload().handoff_on_low_confidence).toBe(true);
  });
});
