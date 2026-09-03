import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PartnerKeyCreatedView } from "../PartnerKeyCreatedView";

const CREATED = {
  name: "Danat", environment: "staging" as const, key: "pk_test_abcdefghijklmnopqrstuvwxyz012345", prefix: "pk_test_abcd",
  scopes: ["messages:send"], workspaceId: "ws", socialAccountId: "acct", createdAt: "2026-09-02T00:00:00.000Z",
};

describe("PartnerKeyCreatedView", () => {
  it("shows the plaintext once with a copy button and the never-again warning", async () => {
    render(<PartnerKeyCreatedView created={CREATED} onDone={() => {}} />);
    expect(screen.getByDisplayValue(CREATED.key)).toBeInTheDocument();
    expect(screen.getByText(/will not be shown again/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /copy/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(CREATED.key);
  });
  it("offers a JSON download built from the shown values", () => {
    const createObjectURL = vi.fn(() => "blob:x");
    const revokeObjectURL = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { writable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { writable: true, value: revokeObjectURL });
    render(<PartnerKeyCreatedView created={CREATED} onDone={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /download/i }));
    expect(createObjectURL).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:x");
  });
});
