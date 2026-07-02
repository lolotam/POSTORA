import { describe, expect, it, vi } from "vitest";

// authenticatedFunction imports the supabase client, which requires VITE_*
// env vars at module load. readFunctionError never touches the client.
vi.mock("@/integrations/supabase/client", () => ({ supabase: {} }));

const { readFunctionError, PASSWORD_SIGN_IN_MESSAGE } = await import(
  "@/lib/authenticatedFunction"
);

// Regression guard for the 2026-07-02 "Create Password" dialog bug: supabase-js throws
// `FunctionsHttpError(response)` where `error.context` IS the Response object.
// readFunctionError used to read `error.context.response` (always undefined),
// so structured codes like otp_required were dropped and the raw
// "Edge Function returned a non-2xx status code" surfaced to the user instead
// of advancing to the email-code step.

function functionsHttpError(context: unknown): Error & { context: unknown } {
  const error = new Error("Edge Function returned a non-2xx status code");
  return Object.assign(error, { context });
}

function jsonResponse(body: Record<string, unknown>, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("readFunctionError", () => {
  it.each([
    ["otp_required", "Please enter the email verification code to continue."],
    ["mfa_required", "Please enter your authenticator code to continue."],
  ])(
    "extracts %s when error.context is the Response (supabase-js shape) so the dialog can advance",
    async (code, friendlyMessage) => {
      const error = functionsHttpError(
        jsonResponse({ error: "Verification required", code }, 401),
      );

      const result = await readFunctionError(error);

      expect(result.code).toBe(code);
      expect(result.error).toBe(friendlyMessage);
    },
  );

  it("still supports the legacy nested context.response shape", async () => {
    const error = functionsHttpError({
      response: jsonResponse({ error: "Invalid or expired verification code", code: "invalid_otp" }, 400),
    });

    const result = await readFunctionError(error);

    expect(result.code).toBe("invalid_otp");
    expect(result.error).toBe("Invalid or expired code.");
  });

  it("falls back to unauthorized for a 401 without a parseable body", async () => {
    const error = functionsHttpError(new Response("nope", { status: 401 }));

    const result = await readFunctionError(error);

    expect(result.code).toBe("unauthorized");
    expect(result.error).toBe(PASSWORD_SIGN_IN_MESSAGE);
  });

  it("returns the error message when no response is attached", async () => {
    const result = await readFunctionError(new Error("network down"));

    expect(result.code).toBeUndefined();
    expect(result.error).toBe("network down");
  });
});
