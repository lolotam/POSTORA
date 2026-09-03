import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { GeneratePartnerKeyDialog } from "../GeneratePartnerKeyDialog";

const rpc = vi.fn();
vi.mock("@/integrations/supabase/client", () => ({ supabase: { rpc: (...a: unknown[]) => rpc(...a) } }));

const TARGETS = [
  { workspace_id: "ws1", workspace_name: "Danat", social_account_id: "a1", platform: "whatsapp", platform_username: "danat", is_active: true, needs_reauth: false },
  { workspace_id: "ws1", workspace_name: "Danat", social_account_id: "a2", platform: "whatsapp", platform_username: "danat-old", is_active: false, needs_reauth: true },
];

function wrap(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("GeneratePartnerKeyDialog", () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockImplementation((fn: string) => {
      if (fn === "admin_partner_key_targets") return Promise.resolve({ data: TARGETS, error: null });
      if (fn === "create_partner_key") return Promise.resolve({ data: "new-id", error: null });
      return Promise.resolve({ data: null, error: null });
    });
  });

  it("submits prefix + hash (never the plaintext) and then shows the plaintext once", async () => {
    wrap(<GeneratePartnerKeyDialog open onOpenChange={() => {}} />);
    // Wait for the targets query, not just the title: selecting a workspace
    // before its <option> exists silently leaves the select on "".
    await screen.findByRole("option", { name: "Danat" });
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: "Danat backend" } });
    // Workspace and account are native <select> elements so fireEvent.change works in jsdom.
    // Exact labels: /account/i would also match the "accounts:read" scope checkbox.
    fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "ws1" } });
    fireEvent.change(screen.getByLabelText("Account (WhatsApp)"), { target: { value: "a1" } });
    fireEvent.click(screen.getByLabelText("staging"));
    fireEvent.click(screen.getByLabelText("messages:send"));
    fireEvent.change(screen.getByLabelText(/monthly quota/i), { target: { value: "500" } });
    fireEvent.click(screen.getByRole("button", { name: /generate key/i }));

    await waitFor(() => expect(rpc).toHaveBeenCalledWith("create_partner_key", expect.anything()));
    const args = rpc.mock.calls.find((c) => c[0] === "create_partner_key")![1] as Record<string, unknown>;
    expect(args.p_environment).toBe("staging");
    expect(args.p_key_prefix).toMatch(/^pk_test_/);
    expect(args.p_key_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(args.p_scopes).toEqual(["messages:send"]);
    expect(args.p_monthly_quota).toBe(500);
    const shown = (await screen.findByDisplayValue(/^pk_test_/)) as HTMLInputElement;
    expect(JSON.stringify(args)).not.toContain(shown.value);
  });

  it("lists an unhealthy account but does not let it be chosen", async () => {
    wrap(<GeneratePartnerKeyDialog open onOpenChange={() => {}} />);
    await screen.findByRole("option", { name: "Danat" });
    fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "ws1" } });
    const option = screen.getByRole("option", { name: /danat-old/i }) as HTMLOptionElement;
    expect(option.disabled).toBe(true);
  });

  it("refuses to submit without a scope", async () => {
    wrap(<GeneratePartnerKeyDialog open onOpenChange={() => {}} />);
    await screen.findByRole("option", { name: "Danat" });
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "ws1" } });
    fireEvent.change(screen.getByLabelText("Account (WhatsApp)"), { target: { value: "a1" } });
    expect(screen.getByRole("button", { name: /generate key/i })).toBeDisabled();
  });
  // The dialog stays mounted for the page's lifetime, so a mint that resolves
  // after the admin closed it used to land in state and re-display the key on
  // the next open — the "shown once" control, silently gone.
  it("drops a minted key whose dialog was closed while the request was in flight", async () => {
    let land: () => void = () => {};
    rpc.mockImplementation((fn: string) => {
      if (fn === "admin_partner_key_targets") return Promise.resolve({ data: TARGETS, error: null });
      if (fn === "create_partner_key") {
        return new Promise((resolve) => { land = () => resolve({ data: "new-id", error: null }); });
      }
      return Promise.resolve({ data: null, error: null });
    });

    wrap(<GeneratePartnerKeyDialog open onOpenChange={() => {}} />);
    await screen.findByRole("option", { name: "Danat" });
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: "Danat backend" } });
    fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "ws1" } });
    fireEvent.change(screen.getByLabelText("Account (WhatsApp)"), { target: { value: "a1" } });
    fireEvent.click(screen.getByLabelText("messages:send"));
    fireEvent.click(screen.getByRole("button", { name: /generate key/i }));

    await waitFor(() => expect(rpc).toHaveBeenCalledWith("create_partner_key", expect.anything()));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    land();

    // The RPC has resolved. The created view must never appear for this key.
    await waitFor(() => expect(screen.queryByRole("button", { name: /generate key/i })).toBeInTheDocument());
    expect(screen.queryByDisplayValue(/^pk_(live|test)_/)).not.toBeInTheDocument();
    expect(screen.queryByText(/will not be shown again/i)).not.toBeInTheDocument();
  });

  it("surfaces a failed targets read instead of an empty workspace picker", async () => {
    rpc.mockImplementation((fn: string) => {
      if (fn === "admin_partner_key_targets") {
        return Promise.resolve({ data: null, error: { message: "platform admin only" } });
      }
      return Promise.resolve({ data: null, error: null });
    });
    wrap(<GeneratePartnerKeyDialog open onOpenChange={() => {}} />);
    expect(await screen.findByText(/Could not load workspaces and accounts: platform admin only/)).toBeInTheDocument();
  });
});

describe("GeneratePartnerKeyDialog connector scopes", () => {
  beforeEach(() => {
    rpc.mockReset();
    rpc.mockImplementation((fn: string) => {
      if (fn === "admin_partner_key_targets") return Promise.resolve({ data: TARGETS, error: null });
      if (fn === "create_partner_key") return Promise.resolve({ data: "new-id", error: null });
      return Promise.resolve({ data: null, error: null });
    });
  });

  it("offers the three connector scopes with their descriptions", async () => {
    wrap(<GeneratePartnerKeyDialog open onOpenChange={() => {}} />);
    await screen.findByRole("option", { name: "Danat" });
    expect(screen.getByLabelText("connectors:read")).toBeInTheDocument();
    expect(screen.getByLabelText("connectors:manage")).toBeInTheDocument();
    expect(screen.getByLabelText("tools:execute")).toBeInTheDocument();
    expect(screen.getByText("List connected tools and their usage")).toBeInTheDocument();
    expect(screen.getByText("Create connect links for Composio-backed tools")).toBeInTheDocument();
    expect(screen.getByText("Execute connected tools headlessly (metered, not billed)")).toBeInTheDocument();
  });

  it("mints a key carrying the connector scopes that were ticked", async () => {
    wrap(<GeneratePartnerKeyDialog open onOpenChange={() => {}} />);
    await screen.findByRole("option", { name: "Danat" });
    fireEvent.change(screen.getByLabelText(/^name/i), { target: { value: "Danat connectors" } });
    fireEvent.change(screen.getByLabelText("Workspace"), { target: { value: "ws1" } });
    fireEvent.change(screen.getByLabelText("Account (WhatsApp)"), { target: { value: "a1" } });
    fireEvent.click(screen.getByLabelText("connectors:read"));
    fireEvent.click(screen.getByLabelText("connectors:manage"));
    fireEvent.click(screen.getByLabelText("tools:execute"));
    fireEvent.click(screen.getByRole("button", { name: /generate key/i }));

    await waitFor(() => expect(rpc).toHaveBeenCalledWith("create_partner_key", expect.anything()));
    const args = rpc.mock.calls.find((c) => c[0] === "create_partner_key")![1] as Record<string, unknown>;
    expect(args.p_scopes).toEqual(["connectors:read", "connectors:manage", "tools:execute"]);
  });
});
