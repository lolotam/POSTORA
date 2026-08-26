import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const upsertConfig = { mutate: vi.fn(), isPending: false };
let config: Record<string, unknown> | null = null;

vi.mock("@/hooks/useAiAgentConfig", () => ({
  useAiAgentConfig: () => ({ config, isLoading: false, upsertConfig }),
}));

const allowedModels = [
  { id: "m1", provider: "google", model_id: "gemini-2.5-flash", label: "Google: Gemini 2.5 Flash", is_active: true, sort_order: 10 },
  { id: "m2", provider: "google", model_id: "gemini-2.5-pro", label: "Google: Gemini 2.5 Pro", is_active: true, sort_order: 20 },
];
let modelsResult = { data: allowedModels, isLoading: false };

vi.mock("@/hooks/useAllowedAiAgentModels", async () => {
  const actual = await vi.importActual<typeof import("@/hooks/useAllowedAiAgentModels")>(
    "@/hooks/useAllowedAiAgentModels",
  );
  return { ...actual, useAllowedAiAgentModels: () => modelsResult };
});

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
    modelsResult = { data: allowedModels, isLoading: false };
  });

  // Regression, 2026-08-26: a platform with no config row yet sent the hardcoded default
  // "gpt-4o-mini", which is not on the admin allow-list, so messaging-api answered
  // 400 "model is not an allowed model" and NOTHING saved -- reported as "the persona text
  // is gone when I come back". Every save must carry a model the server will accept.
  it("saves the persona with an allowed model when the platform has no config yet", () => {
    render(<AiAgentManager platform="threads" />);

    fireEvent.change(screen.getByLabelText("Persona and instructions"), {
      target: { value: "Answer in Arabic, keep it short." },
    });
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));

    expect(savedPayload()).toMatchObject({
      persona_instructions: "Answer in Arabic, keep it short.",
      model: "google/gemini-2.5-flash",
    });
  });

  it("replaces a stored model that has left the allow-list and clears its stale fallbacks", () => {
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

    expect(savedPayload()).toMatchObject({
      persona_instructions: "Existing persona",
      model: "google/gemini-2.5-flash",
      fallback_model_1: null,
      fallback_model_2: "google/gemini-2.5-pro",
    });
  });

  it("lets a model be chosen from the admin allow-list", async () => {
    render(<AiAgentManager platform="facebook" />);

    fireEvent.keyDown(screen.getByTestId("agent-model"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Google: Gemini 2.5 Pro" }));
    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));

    expect(savedPayload()).toMatchObject({ model: "google/gemini-2.5-pro" });
  });

  it("blocks saving and says why when no model has been enabled", () => {
    modelsResult = { data: [], isLoading: false };
    render(<AiAgentManager platform="instagram" />);

    expect(screen.getByRole("button", { name: /save settings/i })).toBeDisabled();
    expect(screen.getByText(/No AI models have been enabled yet/i)).toBeInTheDocument();
  });
});
