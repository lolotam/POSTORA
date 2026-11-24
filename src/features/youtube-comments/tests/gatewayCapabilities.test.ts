import { beforeEach, describe, expect, it, vi } from "vitest";

const invoke = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: (...args: unknown[]) => invoke(...args) } } }));

import { SupabaseYouTubeCommentsGateway } from "../infrastructure/supabaseYouTubeCommentsGateway";
import { YouTubeCommentsError } from "../domain/errors";

const ACCOUNT = "33333333-3333-4333-8333-333333333333";

function payload(reason: string | null, allowed: boolean) {
  const entry = { allowed, reason };
  return { account_id: ACCOUNT, capabilities: { read: entry, held: entry, write: entry, ban: entry } };
}

describe("SupabaseYouTubeCommentsGateway.capabilities", () => {
  beforeEach(() => invoke.mockReset());

  it("returns a normal answer, including a plain denial, as data", async () => {
    invoke.mockResolvedValueOnce({ data: { ok: true, data: payload("capability_off", false) }, error: null });
    const result = await new SupabaseYouTubeCommentsGateway().capabilities(ACCOUNT);
    expect(result.capabilities.read.reason).toBe("capability_off");
  });

  it("turns an answer that says the settings were unreadable into an upstream error, never a denial", async () => {
    // An older server answered a failed settings read as data. As a denial it would unmount an admitted screen.
    invoke.mockResolvedValueOnce({ data: { ok: true, data: payload("settings_unavailable", false) }, error: null });
    await expect(new SupabaseYouTubeCommentsGateway().capabilities(ACCOUNT)).rejects.toMatchObject({
      constructor: YouTubeCommentsError,
      code: "upstream",
    });
  });

  it("sends the draft with a status check only when there is one", async () => {
    invoke.mockResolvedValue({ data: { ok: true, data: { state: "confirmed" } }, error: null });
    const gateway = new SupabaseYouTubeCommentsGateway();
    await gateway.operationStatus({ accountId: ACCOUNT, operationId: "op-1", text: "edited" });
    await gateway.operationStatus({ accountId: ACCOUNT, operationId: "op-2" });
    expect((invoke.mock.calls[0][1] as { body: { text?: string } }).body.text).toBe("edited");
    expect((invoke.mock.calls[1][1] as { body: { text?: string } }).body.text).toBeUndefined();
  });
});
