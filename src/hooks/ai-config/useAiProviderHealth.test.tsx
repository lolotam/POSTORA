import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import {
  MAX_CHUNK_ATTEMPTS,
  useProviderHealthStatus,
  useRunProviderHealth,
} from "./useAiProviderHealth";

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

  it('refreshes both catalogue and health after a completed sync', async () => {
    queryClient.setQueryData(['ai-config'], { models: ['old'] });
    queryClient.setQueryData(['ai-provider-health'], []);
    invoke.mockResolvedValue({ data: { done: true, results: [], skipped: [], summary: {} }, error: null });
    const { result } = renderHook(() => useRunProviderHealth(), { wrapper });
    await result.current.run();
    expect(queryClient.getQueryState(['ai-config'])?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(['ai-provider-health'])?.isInvalidated).toBe(true);
  });

  it('exposes an initial stored-health read failure', async () => {
    invoke.mockResolvedValue({ data: null, error: new Error('unavailable') });
    const { result } = renderHook(() => useProviderHealthStatus(), { wrapper });
    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.data).toBeUndefined();
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
    const run = await result.current.run();
    expect(invoke).toHaveBeenCalledTimes(2);
    expect(run.rows.length).toBe(1);
    expect(run.complete).toBe(true);
    expect(invoke.mock.calls[0][1].body.run_token).toBe(invoke.mock.calls[1][1].body.run_token);
  });

  it("reports a completed run when a retry checks the previously skipped target", async () => {
    invoke
      .mockResolvedValueOnce({
        data: {
          run_id: "r",
          chunk: 1,
          done: false,
          next_chunk: 2,
          results: [{ provider_code: "xai", auth_method: "api_key", status: "failed" }],
          skipped: [{ provider_code: "claude", auth_method: "api_key", reason: "ran out of time" }],
          summary: {},
        },
        error: null,
      })
      .mockResolvedValueOnce({
        data: {
          run_id: "r",
          chunk: 1,
          done: true,
          next_chunk: null,
          results: [{ provider_code: "claude", auth_method: "api_key", status: "connected" }],
          skipped: [],
          summary: {},
        },
        error: null,
      });
    const { result } = renderHook(() => useRunProviderHealth(), { wrapper });
    const run = await result.current.run();
    expect(run.rows.map((row) => row.provider_code)).toEqual(["xai", "claude"]);
    expect(run.skipped).toEqual([]);
    expect(run.complete).toBe(true);
  });

  it("asks for the same chunk again when the server could not finish it", async () => {
    invoke.mockResolvedValue({
      data: {
        run_id: "r",
        chunk: 1,
        done: false,
        next_chunk: 2,
        results: [],
        skipped: [{ provider_code: "claude", auth_method: "api_key", reason: "ran out of time" }],
        summary: {},
      },
      error: null,
    });
    const { result } = renderHook(() => useRunProviderHealth(), { wrapper });
    const run = await result.current.run();
    // The same chunk is asked for again, because the server re-plans and puts the
    // targets it has not recorded yet first. The number of tries is bounded.
    expect(invoke.mock.calls.length).toBe(MAX_CHUNK_ATTEMPTS);
    expect(invoke.mock.calls.every((call) => call[1].body.chunk === 1)).toBe(true);
    expect(run.complete).toBe(false);
    expect(run.skipped.map((target) => target.provider_code)).toEqual(["claude"]);
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
