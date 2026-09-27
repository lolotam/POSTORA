import { fireEvent, render, screen } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";

const upsertConfig = { mutate: vi.fn(), isPending: false };
let config: Record<string, unknown> | null | undefined = null;
let isLoading = false;
let readError: Error | null = null;
// Every (platform, accountId) pair the manager asked the hook for, so a test
// can prove the selection reaches the query, not just the dropdown.
const hookArgs: Array<[string, string | null]> = [];

vi.mock("@/hooks/useAiAgentConfig", () => ({
  useAiAgentConfig: (platform: string, accountId?: string | null) => {
    hookArgs.push([platform, accountId ?? null]);
    return { config, isLoading, error: readError, upsertConfig };
  },
}));

// The manager owns the account selection through this hook; its data decides
// whether the selector renders and which account the config read targets.
const accounts: Array<Record<string, unknown>> = [];
vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({ data: accounts }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// The settings tab is the subject; its neighbours pull in Supabase and are covered elsewhere.
vi.mock("@/components/messaging/AutomationHandlerCard", () => ({ AutomationHandlerCard: () => null }));
vi.mock("@/components/messaging/AutoReplyManager", () => ({ AutoReplyManager: () => null }));
vi.mock("@/components/messaging/AiKnowledgeManager", () => ({ AiKnowledgeManager: () => null }));
vi.mock("@/components/messaging/AiAgentLogsView", () => ({ AiAgentLogsView: () => null }));
vi.mock("@/components/messaging/AiAgentTestChat", () => ({ AiAgentTestChat: () => null }));
vi.mock("@/components/automation/DatabaseConnectorsManager", () => ({ DatabaseConnectorsManager: () => null }));
vi.mock("@/components/messaging/agent-settings/StoreWebhookSection", () => ({ StoreWebhookSection: () => null }));
vi.mock("@/hooks/useAiAgentTools", () => ({
  useAiAgentTools: () => ({ tools: [] }),
  useAiToolAccountLinks: () => ({ links: [], linksReady: true }),
}));
vi.mock("@/hooks/useStoreWebhookBindings", () => ({
  useStoreWebhookBindings: () => ({
    bindings: [],
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
    createBinding: { isPending: false, mutateAsync: vi.fn() },
    rotateSecret: { isPending: false, mutateAsync: vi.fn() },
  }),
}));
vi.mock("@/lib/messagingApi", () => ({ callMessagingApi: vi.fn(async () => ({ status: "missing" })) }));

import { AiAgentManager } from "@/components/messaging/AiAgentManager";

function savedPayload() {
  return upsertConfig.mutate.mock.calls[0]?.[0] as Record<string, unknown>;
}

function lastAccountScopedWith(): string | null {
  return hookArgs[hookArgs.length - 1]?.[1] ?? null;
}

describe("AiAgentManager", () => {
  beforeEach(() => {
    upsertConfig.mutate.mockReset();
    config = null;
    isLoading = false;
    readError = null;
    accounts.length = 0;
    hookArgs.length = 0;
  });

  // Regression, 2026-08-26: this page sent a hardcoded "gpt-4o-mini" that was not
  // on the admin allow-list, so messaging-api answered 400 and NOTHING saved --
  // reported as "the persona text is gone when I come back". Since 2026-08-27 the
  // model is global and admin-managed, so the page must send no model field at
  // all: messaging-api only validates fields the payload actually carries.
  it("saves the persona and sends no model fields", () => {
    render(<AiAgentManager platform="threads" />);

    fireEvent.change(screen.getByLabelText("Additional instructions (free text)"), {
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

  // Regression, 2026-08-28: a read that returned nothing rendered a blank form
  // whose Save then wrote the blank defaults over a live persona. A blank form
  // is an unloaded form, not a save -- the button must refuse and say why.
  it("does not submit while the config read is still in flight", () => {
    config = undefined;
    isLoading = true;
    render(<AiAgentManager platform="whatsapp" />);

    const save = screen.getByRole("button", { name: /save settings/i });
    expect(save).toBeDisabled();
    expect(screen.getByTestId("save-blocked-reason")).toHaveTextContent(/loading/i);
    fireEvent.click(save);
    expect(upsertConfig.mutate).not.toHaveBeenCalled();
  });

  it("does not submit after a failed read, and reports why", () => {
    config = undefined;
    isLoading = false;
    readError = new Error("gateway dropped the request");
    render(<AiAgentManager platform="whatsapp" />);

    const save = screen.getByRole("button", { name: /save settings/i });
    expect(save).toBeDisabled();
    expect(screen.getByTestId("save-blocked-reason")).toHaveTextContent(/could not be loaded/i);
    fireEvent.click(save);
    expect(upsertConfig.mutate).not.toHaveBeenCalled();
  });

  it("saves once the read settles with no config, because that creates the first one", () => {
    config = null;
    render(<AiAgentManager platform="whatsapp" />);

    expect(screen.getByRole("button", { name: /save settings/i })).toBeEnabled();
  });

  it("defaults to the first active account and switches the config read with the selector", async () => {
    accounts.push(
      { id: "a1", platform: "instagram", platform_username: "Brand A", platform_user_id: "1", is_active: true },
      { id: "a2", platform: "instagram", platform_username: "Brand B", platform_user_id: "2", is_active: true },
      { id: "a3", platform: "instagram", platform_username: "Brand C", platform_user_id: "3", is_active: false },
    );
    config = null;
    render(<AiAgentManager platform="instagram" />);

    // The deactivated account never qualifies; the first active one does.
    expect(lastAccountScopedWith()).toBe("a1");

    fireEvent.keyDown(screen.getByTestId("agent-account"), { key: "Enter" });
    // Only active accounts are options: Brand C is absent by design.
    fireEvent.click(await screen.findByRole("option", { name: "Brand B" }));

    expect(lastAccountScopedWith()).toBe("a2");
  });

  it("renders no selector when the platform has a single active account", () => {
    accounts.push(
      { id: "a1", platform: "whatsapp", platform_username: "One Number", platform_user_id: "1", is_active: true },
    );
    config = null;
    render(<AiAgentManager platform="whatsapp" />);

    expect(screen.queryByTestId("agent-account")).not.toBeInTheDocument();
    expect(lastAccountScopedWith()).toBe("a1");
  });
  // Regression, 2026-08-28: the effect that syncs the form to the loaded config
  // returned early on a falsy config, so a settled null left the PREVIOUS
  // account's persona sitting in the fields -- and since null counts as loaded,
  // Save was enabled and would have written brand A's voice into brand B.
  it("clears the form when the newly selected account has no config", async () => {
    accounts.push(
      { id: "a1", platform: "instagram", platform_username: "Brand A", platform_user_id: "1", is_active: true },
      { id: "a2", platform: "instagram", platform_username: "Brand B", platform_user_id: "2", is_active: true },
    );
    config = {
      is_enabled: true,
      default_mode: "ai_first",
      persona_instructions: "Brand A voice",
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
    const view = render(<AiAgentManager platform="instagram" />);

    expect(screen.getByLabelText("Additional instructions (free text)")).toHaveValue("Brand A voice");

    // Brand B has never been configured: its read settles with null.
    config = null;
    fireEvent.keyDown(screen.getByTestId("agent-account"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Brand B" }));
    view.rerender(<AiAgentManager platform="instagram" />);

    expect(screen.getByLabelText("Additional instructions (free text)")).toHaveValue("");

    fireEvent.click(screen.getByRole("button", { name: /save settings/i }));
    expect(savedPayload().persona_instructions).not.toBe("Brand A voice");
  });
});
