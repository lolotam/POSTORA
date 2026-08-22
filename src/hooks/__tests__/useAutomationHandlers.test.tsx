import { renderHook, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

const callMessagingApi = vi.fn();
vi.mock("@/lib/messagingApi", () => ({
  callMessagingApi: (...args: unknown[]) => callMessagingApi(...args),
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ session: { user: { id: "u1" } } }),
}));

import { useAutomationHandlers } from "@/hooks/useAutomationHandlers";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const HANDLERS = {
  social_account_id: "a1",
  platform: "instagram",
  automation_handler: "internal",
  comment_automation_handler: "off",
};

describe("useAutomationHandlers", () => {
  beforeEach(() => callMessagingApi.mockReset());

  it("loads the handlers for the selected account", async () => {
    callMessagingApi.mockResolvedValueOnce(HANDLERS);

    const { result } = renderHook(() => useAutomationHandlers("a1"), { wrapper });

    await waitFor(() => expect(result.current.handlers?.comment_automation_handler).toBe("off"));
    expect(callMessagingApi).toHaveBeenCalledWith("get_automation_handlers", { social_account_id: "a1" });
  });

  it("sends only the changed handler on save", async () => {
    callMessagingApi.mockResolvedValueOnce(HANDLERS);
    callMessagingApi.mockResolvedValueOnce({ ...HANDLERS, comment_automation_handler: "n8n" });

    const { result } = renderHook(() => useAutomationHandlers("a1"), { wrapper });
    await waitFor(() => expect(result.current.handlers).toBeTruthy());

    await act(async () => {
      await result.current.save.mutateAsync({ comment_automation_handler: "n8n" });
    });

    // Not toHaveBeenLastCalledWith: a successful save invalidates the query, so the
    // refetch is the last call.
    expect(callMessagingApi).toHaveBeenCalledWith("set_automation_handlers", {
      social_account_id: "a1",
      comment_automation_handler: "n8n",
    });
  });

  it("does not query before an account is chosen", () => {
    renderHook(() => useAutomationHandlers(null), { wrapper });
    expect(callMessagingApi).not.toHaveBeenCalled();
  });
});
