import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const upsertConfig = { mutate: vi.fn(), isPending: false };
let config: Record<string, unknown> | null = null;

vi.mock("@/hooks/useAiAgentConfig", () => ({
  useAiAgentConfig: () => ({ config, isLoading: false, upsertConfig }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The settings tab is the subject; its neighbours pull in Supabase and are covered elsewhere.
vi.mock("@/components/messaging/AutomationHandlerCard", () => ({ AutomationHandlerCard: () => null }));
vi.mock("@/components/messaging/AutoReplyManager", () => ({ AutoReplyManager: () => null }));
vi.mock("@/components/messaging/AiKnowledgeManager", () => ({ AiKnowledgeManager: () => null }));
vi.mock("@/components/messaging/AiAgentLogsView", () => ({ AiAgentLogsView: () => null }));
vi.mock("@/components/messaging/AiAgentTestChat", () => ({ AiAgentTestChat: () => null }));
vi.mock("@/components/automation/DatabaseConnectorsManager", () => ({ DatabaseConnectorsManager: () => null }));

import { AiAgentManager } from "@/components/messaging/AiAgentManager";

function savedPayload() {
  return upsertConfig.mutate.mock.calls[0]?.[0] as Record<string, unknown>;
}

describe("AiAgentManager", () => {
  beforeEach(() => {
    upsertConfig.mutate.mockReset();
    config = null;
  });

  // Regression, 2026-08-26: this page sent a hardcoded "gpt-4o-mini" that was not
  // on the admin allow-list, so messaging-api answered 400 and NOTHING saved --
  // reported as "the persona text is gone when I come back". Since 2026-08-27 the
  // model is global and admin-managed, so the page must send no model field at
  // all: messaging-api only validates fields the payload actually carries.
  it("saves the persona and sends no model fields", () => {
    render(<AiAgentManager platform="threads" />);

    fireEvent.change(screen.getByLabelText("Persona and instructions"), {
      target: { value: "Answer in Arabic, keep it short." },
    });
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));

    const payload = savedPayload();
    expect(payload).toMatchObject({ persona_instructions: "Answer in Arabic, keep it short." });
    expect(payload).not.toHaveProperty("model");
    expect(payload).not.toHaveProperty("fallback_model_1");
    expect(payload).not.toHaveProperty("fallback_model_2");
  });

  it("ignores a model stored on an existing config instead of sending it back", () => {
    config = {
      is_enabled: true,
      default_mode: "human_then_ai",
      persona_instructions: "Existing persona",
      business_profile_text: "",
      language_mode: "auto",
      model: "openrouter/tencent/hy3:free",
      fallback_model_1: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free",
      fallback_model_2: "google/gemini-2.5-pro",
      temperature: 0.4,
      admin_phone_numbers: [],
      daily_message_cap: 50,
      reply_cooldown_seconds: 0,
      max_tool_iterations: 5,
      handoff_on_request: true,
      handoff_on_low_confidence: false,
    };
    render(<AiAgentManager platform="whatsapp" />);

    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));

    const payload = savedPayload();
    expect(payload).toMatchObject({ persona_instructions: "Existing persona" });
    expect(payload).not.toHaveProperty("model");
  });
});
