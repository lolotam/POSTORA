import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useAiAgentTools, useAiToolAccountLinks } from "@/hooks/useAiAgentTools";

// The link-table read and the set_tool_accounts write are the two halves of
// connector sharing that do not go through ai_list_tools. The read runs in
// the browser under the user's own JWT against a table whose RLS is
// `auth.uid() = user_id`; the write goes through messaging-api, because the
// replacing RPC is service-role only. These tests pin the request the server
// contract defines (spec §12.2) and the cache refresh that keeps a second
// toggle from computing its full list out of stale links.

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1" }, session: { user: { id: "u1" } } }),
}));

const callMessagingApi = vi.fn();
vi.mock("@/lib/messagingApi", () => ({
  callMessagingApi: (...args: unknown[]) => callMessagingApi(...args),
}));

let linkRows: Array<{ tool_id: string; social_account_id: string }> = [];
let linkReadError: unknown = null;
const from = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: (table: string) => from(table),
  },
}));

describe("useAiToolAccountLinks", () => {
  let client: QueryClient;

  beforeEach(() => {
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    callMessagingApi.mockReset();
    callMessagingApi.mockResolvedValue({});
    linkRows = [];
    linkReadError = null;
    from.mockReset();
    from.mockImplementation((table: string) => {
      if (table !== "ai_agent_tool_accounts") {
        throw new Error(`unexpected table: ${table}`);
      }
      return {
        select: () =>
          linkReadError
            ? Promise.resolve({ data: null, error: linkReadError })
            : Promise.resolve({ data: linkRows, error: null }),
      };
    });
  });

  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );

  it("reads this user's tool-account link rows", async () => {
    linkRows = [{ tool_id: "t1", social_account_id: "fb-1" }];
    const { result } = renderHook(() => useAiToolAccountLinks(), { wrapper });

    await waitFor(() => expect(result.current.linksReady).toBe(true));
    expect(result.current.links).toEqual([{ tool_id: "t1", social_account_id: "fb-1" }]);
    expect(result.current.linksError).toBeNull();
  });

  it("reports a failed link read instead of pretending there are no links", async () => {
    // An error swallowed into [] would render every strip unticked, and a
    // click would write that fiction back as if the user had chosen it.
    linkReadError = new Error("rls refused");
    const { result } = renderHook(() => useAiToolAccountLinks(), { wrapper });

    await waitFor(() => expect(result.current.linksError).toBeTruthy());
    expect(result.current.linksReady).toBe(false);
  });

  it("sends the complete account list under the server's key names", async () => {
    const { result } = renderHook(() => useAiToolAccountLinks(), { wrapper });
    await waitFor(() => expect(result.current.linksReady).toBe(true));

    await result.current.setToolAccounts.mutateAsync({
      toolId: "t1",
      socialAccountIds: ["fb-1", "ig-1"],
    });

    expect(callMessagingApi).toHaveBeenCalledWith("set_tool_accounts", {
      tool_id: "t1",
      social_account_ids: ["fb-1", "ig-1"],
    });
  });

  it("refreshes links and tools after a write, so the next toggle sees fresh state", async () => {
    linkRows = [{ tool_id: "t1", social_account_id: "fb-1" }];
    const tools = renderHook(() => useAiAgentTools(), { wrapper });
    const links = renderHook(() => useAiToolAccountLinks(), { wrapper });
    await waitFor(() => expect(tools.result.current.tools).toEqual([]));
    await waitFor(() => expect(links.result.current.linksReady).toBe(true));
    expect(from).toHaveBeenCalledTimes(1);

    linkRows = [
      { tool_id: "t1", social_account_id: "fb-1" },
      { tool_id: "t1", social_account_id: "ig-1" },
    ];
    await links.result.current.setToolAccounts.mutateAsync({
      toolId: "t1",
      socialAccountIds: ["fb-1", "ig-1"],
    });

    await waitFor(() =>
      expect(links.result.current.links.map((l) => l.social_account_id)).toEqual(["fb-1", "ig-1"]),
    );
    expect(callMessagingApi).toHaveBeenCalledWith("ai_list_tools", {});
  });
});
