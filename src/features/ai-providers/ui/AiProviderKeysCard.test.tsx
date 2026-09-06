import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSupabaseAiProvidersGateway } from "../infrastructure/supabaseAiProvidersGateway";
import { connectedKey, queryWrapper } from "../tests/fixtures";
import { AiProviderKeysCard } from "./AiProviderKeysCard";

const { invoke, toast } = vi.hoisted(() => ({ invoke: vi.fn(), toast: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke } } }));
vi.mock("@/hooks/use-toast", () => ({ toast }));

describe("Your AI keys", () => {
  beforeEach(() => { invoke.mockReset(); toast.mockClear(); });
  function mount() {
    const context = queryWrapper();
    render(<AiProviderKeysCard gateway={createSupabaseAiProvidersGateway("user-1")} userId="user-1" />, context);
    return context;
  }
  it("saves through the endpoint, clears the password, and keeps secrets out of both caches", async () => {
    let saved = false;
    invoke.mockImplementation(async (_name, { body }) => {
      if (body.action === "save_key") { saved = true; return { data: { ok: true, data: { ...connectedKey, api_key: "test-secret-1234" } }, error: null }; }
      return { data: { ok: true, data: { keys: saved ? [connectedKey] : [] } }, error: null };
    });
    const { client } = mount();
    const row = within(await screen.findByRole("region", { name: "OpenAI" }));
    const input = row.getByLabelText("OpenAI API key");
    expect(row.getByRole("button", { name: "Save" })).toBeDisabled();
    fireEvent.change(input, { target: { value: "test-secret-1234" } });
    fireEvent.click(row.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(input).toHaveValue(""));
    expect(invoke).toHaveBeenCalledWith("user-ai-providers", { body: { action: "save_key", provider_code: "openai", api_key: "test-secret-1234" } });
    expect(await row.findByText("Connected · ends in ••••1234")).toBeInTheDocument();
    expect(screen.queryByText("test-secret-1234")).not.toBeInTheDocument();
    expect(JSON.stringify(client.getQueryCache().getAll().map(query => query.state))).not.toContain("test-secret-1234");
    expect(client.getMutationCache().getAll()).toHaveLength(0);
  });
  it("shows an invalid-key toast without turning an unconnected row into a connection", async () => {
    invoke.mockImplementation(async (_name, { body }) => body.action === "list"
      ? { data: { ok: true, data: { keys: [] } }, error: null }
      : { data: null, error: { context: new Response(JSON.stringify({ ok: false, code: "AI_USER_KEY_INVALID" }), { status: 400 }) } });
    mount();
    const row = within(await screen.findByRole("region", { name: "OpenAI" }));
    fireEvent.change(row.getByLabelText("OpenAI API key"), { target: { value: "bad-key" } });
    fireEvent.click(row.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.objectContaining({ description: "That API key is invalid. Check the key and try again.", variant: "destructive" })));
    expect(row.getByText("Not connected")).toBeInTheDocument();
  });
  it("requires a dialog confirmation before removing a connected key", async () => {
    invoke.mockResolvedValue({ data: { ok: true, data: { keys: [connectedKey] } }, error: null });
    mount();
    const row = within(await screen.findByRole("region", { name: "OpenAI" }));
    fireEvent.click(row.getByRole("button", { name: "Remove" }));
    expect(invoke).not.toHaveBeenCalledWith("user-ai-providers", { body: { action: "delete_key", provider_code: "openai" } });
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(invoke).toHaveBeenCalledWith("user-ai-providers", { body: { action: "delete_key", provider_code: "openai" } }));
  });
});
