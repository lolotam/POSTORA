import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useProviderHealthStatus, useRunProviderHealth } from "./useAiProviderHealth";

const invoke = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } },
}));

const queryClient = new QueryClient();
const wrapper = ({ children }: { children: ReactNode }) => (
  <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
);

describe("useAiProviderHealth", () => {
  beforeEach(() => {
    invoke.mockReset();
    // A fresh cache per test: the stored-results query must not leak between them.
    queryClient.clear();
  });

  it("reads the stored results without running anything", async () => {
    invoke.mockResolvedValue({
      data: { results: [{ provider_code: "claude", auth_method: "api_key", status: "connected" }] },
      error: null,
    });
    const { result } = renderHook(() => useProviderHealthStatus(), { wrapper });
    await waitFor(() => expect(result.current.data?.length).toBe(1));
    expect(invoke.mock.calls[0][1].body.action).toBe("status");
  });

  it("walks the chunks until the server says it is done", async () => {
    invoke
      .mockResolvedValueOnce({ data: { run_id: "r", chunk: 1, done: false, next_chunk: 2, results: [], summary: {} }, error: null })
      .mockResolvedValueOnce({ data: { run_id: "r", chunk: 2, done: true, next_chunk: null, results: [{ provider_code: "xai", auth_method: "api_key", status: "failed" }], summary: {} }, error: null });
    const { result } = renderHook(() => useRunProviderHealth(), { wrapper });
    const rows = await result.current.run();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(rows.length).toBe(1);
    expect(invoke.mock.calls[0][1].body.run_token).toBe(invoke.mock.calls[1][1].body.run_token);
  });

  it("reports a busy server without throwing", async () => {
    invoke.mockResolvedValue({ data: { error: "busy" }, error: null });
    const { result } = renderHook(() => useRunProviderHealth(), { wrapper });
    await result.current.run();
    await waitFor(() => expect(result.current.error).toBe("busy"));
  });

  it("stops running once the run is over", async () => {
    invoke.mockResolvedValue({ data: { run_id: "r", chunk: 1, done: true, next_chunk: null, results: [], summary: {} }, error: null });
    const { result } = renderHook(() => useRunProviderHealth(), { wrapper });
    await result.current.run();
    await waitFor(() => expect(result.current.isRunning).toBe(false));
    expect(result.current.error).toBeNull();
  });
});
