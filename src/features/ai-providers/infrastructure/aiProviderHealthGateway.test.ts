import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  fetchProviderHealth,
  INVALID_RESPONSE,
  runProviderHealthChunk,
} from "./aiProviderHealthGateway";

const invoke = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: (...a: unknown[]) => invoke(...a) } },
}));

describe("aiProviderHealthGateway", () => {
  beforeEach(() => invoke.mockReset());

  it("reads the stored results without running anything", async () => {
    invoke.mockResolvedValue({
      data: { results: [{ provider_code: "claude", auth_method: "api_key", status: "connected" }] },
      error: null,
    });
    const rows = await fetchProviderHealth();
    expect(rows.length).toBe(1);
    expect(rows[0].provider_code).toBe("claude");
    expect(rows[0].reason).toBeNull();
    expect(invoke.mock.calls[0][0]).toBe("ai-provider-health");
    expect(invoke.mock.calls[0][1].body.action).toBe("status");
  });

  it("runs one chunk with the run token", async () => {
    invoke.mockResolvedValue({
      data: { run_id: "r", chunk: 1, done: true, next_chunk: null, results: [], summary: {} },
      error: null,
    });
    const chunk = await runProviderHealthChunk(2, "token-a");
    expect(chunk.done).toBe(true);
    expect(chunk.summary.total).toBe(0);
    expect(invoke.mock.calls[0][1].body).toEqual({
      action: "run",
      scope: "manual",
      chunk: 2,
      run_token: "token-a",
    });
  });

  it("surfaces the server's refusal instead of a contract error", async () => {
    invoke.mockResolvedValue({ data: { error: "busy" }, error: null });
    await expect(runProviderHealthChunk(1, "token-a")).rejects.toThrow("busy");
  });

  it("rejects a response that is not the agreed shape", async () => {
    invoke.mockResolvedValue({ data: { results: "not an array" }, error: null });
    await expect(fetchProviderHealth()).rejects.toThrow(INVALID_RESPONSE);
  });

  it("rethrows the transport failure", async () => {
    invoke.mockResolvedValue({ data: null, error: new Error("offline") });
    await expect(fetchProviderHealth()).rejects.toThrow("offline");
  });
});
