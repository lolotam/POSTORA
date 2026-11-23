import { describe, expect, it } from "vitest";
import { reasonFromHttpError } from "../infrastructure/supabaseYouTubeCommentsGateway";

function httpError(body: BodyInit | null, status = 429) {
  return { name: "FunctionsHttpError", message: "Edge Function returned a non-2xx status code", context: new Response(body, { status }) };
}

describe("reasonFromHttpError", () => {
  it("reads the handler's stable reason from the non-2xx response body", async () => {
    expect(await reasonFromHttpError(httpError(JSON.stringify({ ok: false, reason: "quota" })))).toBe("quota");
    expect(await reasonFromHttpError(httpError(JSON.stringify({ ok: false, reason: "scope_missing" }), 403))).toBe("scope_missing");
    expect(await reasonFromHttpError(httpError(JSON.stringify({ ok: false, reason: "recently_posted" }), 409))).toBe("recently_posted");
  });

  it("returns null when there is no usable reason, so the caller treats it as temporary", async () => {
    expect(await reasonFromHttpError(httpError("not json at all", 502))).toBeNull();
    expect(await reasonFromHttpError(httpError(JSON.stringify({ error: "Unauthorized" }), 401))).toBeNull();
    expect(await reasonFromHttpError(httpError(JSON.stringify({ reason: "Not A Reason!" })))).toBeNull();
    expect(await reasonFromHttpError(new Error("network down"))).toBeNull();
    expect(await reasonFromHttpError(null)).toBeNull();
  });
});
