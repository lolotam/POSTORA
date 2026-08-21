import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

// Regression guard for the 2026-08-21 reset-password incident: the reset
// screen reported "Edge Function returned a non-2xx status code". supabase-js throws `FunctionsHttpError(response)`, so
// `error.context` IS the Response. This screen used to read
// `error.context.response` (always undefined), which dropped the function's
// real message and made the `mfa_required` handoff unreachable — a 2FA account
// could never reach the authenticator field and the reset flow dead-ended.

const invoke = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke } },
}));

const { PasswordResetOptions } = await import("../PasswordResetOptions");

function functionsHttpError(body: Record<string, unknown>, status: number) {
  const error = new Error("Edge Function returned a non-2xx status code");
  return Object.assign(error, {
    context: new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  });
}

async function reachVerifyStep() {
  render(<PasswordResetOptions onBack={vi.fn()} />);
  fireEvent.change(screen.getByLabelText("Email"), {
    target: { value: "user@example.com" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Send reset code" }));
  await screen.findByLabelText("Reset code");

  fireEvent.change(screen.getByLabelText("Reset code"), { target: { value: "123456" } });
  fireEvent.change(screen.getByLabelText("New password"), {
    target: { value: "correct-horse-battery" },
  });
}

describe("PasswordResetOptions error handling", () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockResolvedValue({ data: { success: true }, error: null });
  });

  it("shows the authenticator field when the function answers 401 mfa_required", async () => {
    await reachVerifyStep();
    invoke.mockResolvedValueOnce({
      data: null,
      error: functionsHttpError({ error: "MFA code required", code: "mfa_required" }, 401),
    });

    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));

    expect(await screen.findByLabelText("Authenticator code")).toBeInTheDocument();
  });

  it("surfaces the function's own message instead of the generic non-2xx text", async () => {
    await reachVerifyStep();
    invoke.mockResolvedValueOnce({
      data: null,
      error: functionsHttpError({ error: "Invalid or expired reset code" }, 400),
    });

    fireEvent.click(screen.getByRole("button", { name: "Reset password" }));

    expect(await screen.findByText("Invalid or expired reset code")).toBeInTheDocument();
    expect(
      screen.queryByText("Edge Function returned a non-2xx status code"),
    ).not.toBeInTheDocument();
  });
});
