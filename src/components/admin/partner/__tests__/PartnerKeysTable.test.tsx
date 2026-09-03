import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PartnerKeysTable } from "../PartnerKeysTable";
import type { PartnerKeyRow } from "@/features/partner-hub";

const base: PartnerKeyRow = {
  id: "k1", name: "Danat backend", environment: "production", key_prefix: "pk_live_a1b2",
  workspace_id: "ws", workspace_name: "Danat", social_account_id: "acct", account_platform: "whatsapp", account_username: "danat",
  scopes: ["messages:send", "templates:read"], rate_limit_per_min: 60, monthly_quota: 100,
  usage_charged: 85, usage_reserved: 0, usage_confirmed: 85, usage_indeterminate: 0, period_start: "2026-09-01T00:00:00Z",
  status: "active", created_at: "2026-09-01T10:00:00Z", last_used_at: "2026-09-02T09:14:00Z", expires_at: null,
  revoked_at: null, revoked_reason: null, superseded_by_key_id: null,
};
const revoked: PartnerKeyRow = { ...base, id: "k2", name: "Old key", key_prefix: "pk_live_zzzz", status: "revoked", revoked_at: "2026-08-30T00:00:00Z", environment: "staging" };

describe("PartnerKeysTable", () => {
  it("renders name, environment, prefix, workspace and account", () => {
    render(<PartnerKeysTable keys={[base]} isLoading={false} error={null} activeScope={null} onToggleScope={() => {}} onViewActivity={() => {}} onRevoke={() => {}} />);
    expect(screen.getByText("Danat backend")).toBeInTheDocument();
    expect(screen.getByText("production")).toBeInTheDocument();
    expect(screen.getByText("pk_live_a1b2…")).toBeInTheDocument();
    // Exact, not /Danat/: that also matches the key name "Danat backend".
    expect(screen.getByText("Danat")).toBeInTheDocument();
    expect(screen.getByText(/whatsapp · danat/)).toBeInTheDocument();
  });
  it("disables Revoke for a non-active key and enables it for an active one", () => {
    render(<PartnerKeysTable keys={[base, revoked]} isLoading={false} error={null} activeScope={null} onToggleScope={() => {}} onViewActivity={() => {}} onRevoke={() => {}} />);
    const buttons = screen.getAllByRole("button", { name: /revoke key/i });
    expect(buttons[0]).toBeEnabled();
    expect(buttons[1]).toBeDisabled();
  });
  it("calls back with the key for View Live Activity and Revoke", () => {
    const onView = vi.fn(); const onRevoke = vi.fn();
    render(<PartnerKeysTable keys={[base]} isLoading={false} error={null} activeScope={null} onToggleScope={() => {}} onViewActivity={onView} onRevoke={onRevoke} />);
    fireEvent.click(screen.getByRole("button", { name: /view live activity/i }));
    fireEvent.click(screen.getByRole("button", { name: /revoke key/i }));
    expect(onView).toHaveBeenCalledWith(base);
    expect(onRevoke).toHaveBeenCalledWith(base);
  });
  it("filters rows by the active scope", () => {
    render(<PartnerKeysTable keys={[base, { ...revoked, scopes: ["posts:write"] }]} isLoading={false} error={null} activeScope="posts:write" onToggleScope={() => {}} onViewActivity={() => {}} onRevoke={() => {}} />);
    expect(screen.queryByText("Danat backend")).not.toBeInTheDocument();
    expect(screen.getByText("Old key")).toBeInTheDocument();
  });
  it("shows the error instead of an empty table", () => {
    render(<PartnerKeysTable keys={undefined} isLoading={false} error={new Error("platform admin only")} activeScope={null} onToggleScope={() => {}} onViewActivity={() => {}} onRevoke={() => {}} />);
    expect(screen.getByText(/platform admin only/)).toBeInTheDocument();
  });
});
