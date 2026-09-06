import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseAiProvidersGateway } from "../infrastructure/supabaseAiProvidersGateway";
import { queryWrapper } from "../tests/fixtures";
import { CodexWaitlistCard } from "./CodexWaitlistCard";

const { invoke, maybeSingle } = vi.hoisted(() => ({ invoke: vi.fn(), maybeSingle: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: {
  functions: { invoke },
  from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle }) }) }) }),
} }));

describe("Codex waitlist", () => {
  beforeEach(() => { invoke.mockReset(); maybeSingle.mockReset(); });
  function mount() {
    render(<CodexWaitlistCard gateway={createSupabaseAiProvidersGateway("user-1")} userId="user-1" />, queryWrapper());
  }
  it("joins through the endpoint and prevents a second submission", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: null });
    invoke.mockImplementation(async () => {
      maybeSingle.mockResolvedValue({ data: { user_id: "user-1" }, error: null });
      return { data: { ok: true, data: { joined: true } }, error: null };
    });
    mount();
    const button = screen.getByRole("button", { name: "Join the waitlist" });
    await waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByRole("button", { name: "You're on the list" })).toBeDisabled();
    fireEvent.click(button);
    expect(invoke).toHaveBeenCalledExactlyOnceWith("user-ai-providers", { body: { action: "join_waitlist", provider_code: "codex" } });
  });
  it("recognizes an existing row on load", async () => {
    maybeSingle.mockResolvedValue({ data: { user_id: "user-1" }, error: null });
    mount();
    expect(await screen.findByRole("button", { name: "You're on the list" })).toBeDisabled();
    expect(invoke).not.toHaveBeenCalled();
  });
  it("does not misrepresent a failed lookup as not joined", async () => {
    maybeSingle.mockResolvedValue({ data: null, error: { code: "42501" } });
    mount();
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not check your waitlist status");
    expect(screen.getByRole("button", { name: "Join the waitlist" })).toBeDisabled();
  });
});
