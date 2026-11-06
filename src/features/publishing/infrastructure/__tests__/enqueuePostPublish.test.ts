import { beforeEach, describe, expect, it, vi } from "vitest";
import { FunctionsHttpError } from "@supabase/supabase-js";
import { enqueuePostPublish } from "../enqueuePostPublish";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke } } }));

beforeEach(() => vi.resetAllMocks());

describe("enqueuePostPublish", () => {
  it.each([false, true])("accepts only the server's processing acknowledgement (already=%s)", async (already) => {
    invoke.mockResolvedValue({ data: { accepted: true, post_id: "post-1", status: "processing", already }, error: null, response: new Response(null, { status: 202 }) });
    expect(await enqueuePostPublish({ postId: "post-1", mode: "retry", accountIds: ["account-1"] }))
      .toEqual({ accepted: true, alreadyRunning: already });
    expect(invoke).toHaveBeenCalledWith("enqueue-post-publish", { body: { post_id: "post-1", mode: "retry", account_ids: ["account-1"] } });
  });

  it.each([
    [404, "not_found"], [409, "not_publishable"], [409, "not_retryable"], [409, "no_targets"],
  ])("preserves HTTP %s refusal %s", async (status, reason) => {
    invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(Response.json({ error: reason }, { status: Number(status) })) });
    expect(await enqueuePostPublish({ postId: "post-1", mode: "publish_now" }))
      .toEqual({ accepted: false, reason });
  });

  it.each([null, { accepted: true }, { accepted: true, post_id: "other", status: "processing" }])("does not report acceptance for a malformed acknowledgement %j", async (data) => {
    invoke.mockResolvedValue({ data, error: null });
    expect(await enqueuePostPublish({ postId: "post-1", mode: "publish_now" })).toEqual({ accepted: false, reason: "error" });
  });

  it.each(["returned", "thrown"])("maps a %s network failure without claiming success", async (kind) => {
    const error = new Error("network unavailable");
    if (kind === "returned") invoke.mockResolvedValue({ data: null, error });
    else invoke.mockRejectedValue(error);
    expect(await enqueuePostPublish({ postId: "post-1", mode: "publish_now" })).toEqual({ accepted: false, reason: "error" });
  });
});
