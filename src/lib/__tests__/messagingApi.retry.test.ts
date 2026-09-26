import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: {
      getSession: vi.fn(async () => ({ data: { session: { access_token: "token" } } })),
      refreshSession: vi.fn(),
    },
  },
}));

import { callEdgeApi, EdgeApiError } from "@/lib/messagingApi";

describe("callEdgeApi retry option", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not retry a gateway status when retry is false", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "down" }), { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(callEdgeApi("ai-agent-reply", "test", { inbound_text: "hi" }, { retry: false }))
      .rejects.toBeInstanceOf(EdgeApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still retries a gateway status by default", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "down" }), { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await callEdgeApi("ai-agent-reply", "test", { inbound_text: "hi" });
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
