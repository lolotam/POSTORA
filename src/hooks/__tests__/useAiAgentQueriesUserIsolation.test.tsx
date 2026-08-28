import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAiAgentConfig, type AiAgentConfig } from "@/hooks/useAiAgentConfig";
import { useAiAgentTools, type AiAgentTool } from "@/hooks/useAiAgentTools";

// The module under test is the hook; useAuth and the transport are its
// dependencies, mocked here so the cache behaviour under test is real.
const authState = vi.hoisted(() => ({
  user: { id: "user-a" } as { id: string } | null,
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: authState.user,
    session: authState.user ? { user: authState.user } : null,
  }),
}));

vi.mock("@/lib/messagingApi", () => ({
  callMessagingApi: vi.fn(async (action: string) => {
    const userId = authState.user?.id ?? "anonymous";
    if (action === "ai_get_config") {
      return { config: configFor(userId) };
    }
    if (action === "ai_list_tools") {
      return { tools: [toolFor(userId)] };
    }
    return {};
  }),
}));

function configFor(userId: string): AiAgentConfig {
  return {
    id: `config-${userId}`,
    persona_instructions: `Persona of ${userId}`,
    user_id: userId,
  } as AiAgentConfig;
}

function toolFor(userId: string): AiAgentTool {
  return { id: `tool-${userId}` } as AiAgentTool;
}

describe("ai agent query caches are isolated per user", () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    authState.user = { id: "user-a" };
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  it("does not serve user A's cached agent config to user B after an account switch", async () => {
    const first = renderHook(() => useAiAgentConfig("whatsapp"), { wrapper });
    await waitFor(() =>
      expect(first.result.current.config?.persona_instructions).toBe("Persona of user-a"),
    );
    first.unmount();

    authState.user = { id: "user-b" };
    const second = renderHook(() => useAiAgentConfig("whatsapp"), { wrapper });

    // User B starts from scratch — A's cached persona must not even flash.
    expect(second.result.current.config).toBeUndefined();
    await waitFor(() =>
      expect(second.result.current.config?.persona_instructions).toBe("Persona of user-b"),
    );

    // Both entries live in the cache, each under its own user-scoped key.
    expect(client.getQueryData(["ai-agent-config", "user-a", "whatsapp"])).toMatchObject({
      persona_instructions: "Persona of user-a",
    });
    expect(client.getQueryData(["ai-agent-config", "user-b", "whatsapp"])).toMatchObject({
      persona_instructions: "Persona of user-b",
    });
  });

  it("does not serve user A's cached agent tools to user B after an account switch", async () => {
    const first = renderHook(() => useAiAgentTools(), { wrapper });
    await waitFor(() => expect(first.result.current.tools.map((t) => t.id)).toEqual(["tool-user-a"]));
    first.unmount();

    authState.user = { id: "user-b" };
    const second = renderHook(() => useAiAgentTools(), { wrapper });

    expect(second.result.current.tools).toEqual([]);
    await waitFor(() => expect(second.result.current.tools.map((t) => t.id)).toEqual(["tool-user-b"]));

    expect(client.getQueryData(["ai-agent-tools", "user-a"])).toMatchObject([{ id: "tool-user-a" }]);
    expect(client.getQueryData(["ai-agent-tools", "user-b"])).toMatchObject([{ id: "tool-user-b" }]);
  });
});
