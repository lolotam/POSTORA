import { describe, expect, it } from "vitest";
import { invokeErrorMessage } from "../functionInvokeError";

/** What supabase-js throws for a non-2xx reply: a generic message, the Response on `context`. */
function httpError(body: unknown, status = 422): Error & { context: Response } {
  const error = new Error("Edge Function returned a non-2xx status code") as Error & { context: Response };
  error.context = new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  return error;
}

describe("invokeErrorMessage", () => {
  it("returns the reason the function gave, not supabase-js's generic message", async () => {
    const error = httpError({ success: false, error: "Move the box back to the centre.", error_code: "UNSUPPORTED_CROP_REGION" });
    expect(await invokeErrorMessage(error, "Crop failed")).toBe("Move the box back to the centre.");
  });

  it("leaves the response readable for other handlers", async () => {
    const error = httpError({ error: "x" });
    await invokeErrorMessage(error, "fallback");
    expect(await error.context.json()).toEqual({ error: "x" });
  });

  it("falls back when the body is not JSON or has no error text", async () => {
    expect(await invokeErrorMessage(httpError("<html>502</html>", 502), "Crop failed")).toBe("Crop failed");
    expect(await invokeErrorMessage(httpError({ error: "   " }), "Crop failed")).toBe("Crop failed");
    expect(await invokeErrorMessage(httpError({ error: 42 }), "Crop failed")).toBe("Crop failed");
  });

  it("keeps a meaningful error message when there is no response (network failure)", async () => {
    expect(await invokeErrorMessage(new TypeError("Failed to fetch"), "Crop failed")).toBe("Failed to fetch");
  });

  it("never shows the generic non-2xx text", async () => {
    expect(await invokeErrorMessage(new Error("Edge Function returned a non-2xx status code"), "Compression failed")).toBe("Compression failed");
  });

  it("handles values that are not errors", async () => {
    expect(await invokeErrorMessage(null, "Compression failed")).toBe("Compression failed");
    expect(await invokeErrorMessage("boom", "Compression failed")).toBe("Compression failed");
  });
});
