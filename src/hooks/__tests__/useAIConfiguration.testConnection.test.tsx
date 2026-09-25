import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useTestConnection } from "../useAIConfiguration";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke } } }));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useTestConnection", () => {
  beforeEach(() => invoke.mockReset());

  // The card toasts result.error; throwing here replaced the mapped billing message
  // with a generic "Connection test failed".
  it("returns a failed test result with its error instead of throwing", async () => {
    const failed = { success: false, error: "Vercel AI Gateway requires a card on file" };
    invoke.mockResolvedValue({ data: failed, error: null });
    const { result } = renderHook(() => useTestConnection(), { wrapper });
    await expect(result.current.mutateAsync({ provider_id: "p1" })).resolves.toEqual(failed);
  });

  it("still throws when the function call itself fails", async () => {
    invoke.mockResolvedValue({ data: null, error: { message: "Failed to send a request" } });
    const { result } = renderHook(() => useTestConnection(), { wrapper });
    await expect(result.current.mutateAsync({ provider_id: "p1" })).rejects.toThrow("Failed to send a request");
  });
});
