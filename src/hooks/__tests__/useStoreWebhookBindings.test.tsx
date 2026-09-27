import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactNode } from "react";

const callMessagingApi = vi.fn();
vi.mock("@/lib/messagingApi", () => ({
  callMessagingApi: (...args: unknown[]) => callMessagingApi(...args),
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ session: { access_token: "token" }, user: { id: "user-1" } }),
}));

import { useStoreWebhookBindings } from "@/hooks/useStoreWebhookBindings";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useStoreWebhookBindings", () => {
  beforeEach(() => callMessagingApi.mockReset());

  it("keeps bindings undefined while the list is loading", async () => {
    let finish: (value: { bindings: [] }) => void = () => {};
    callMessagingApi.mockReturnValue(new Promise((resolve) => {
      finish = resolve;
    }));
    const { result } = renderHook(() => useStoreWebhookBindings(), { wrapper });
    expect(result.current.isLoading).toBe(true);
    expect(result.current.bindings).toBeUndefined();
    expect(result.current.isError).toBe(false);
    finish({ bindings: [] });
    await waitFor(() => expect(result.current.bindings).toEqual([]));
  });

  it("returns an empty list only after a successful read", async () => {
    callMessagingApi.mockResolvedValueOnce({ bindings: [] });
    const { result } = renderHook(() => useStoreWebhookBindings(), { wrapper });
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.bindings).toEqual([]);
    expect(result.current.isError).toBe(false);
  });

  it("does not turn a failed read into an empty list", async () => {
    callMessagingApi.mockRejectedValueOnce(new Error("down"));
    const { result } = renderHook(() => useStoreWebhookBindings(), { wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.bindings).toBeUndefined();
    expect(result.current.isLoading).toBe(false);
  });
});
