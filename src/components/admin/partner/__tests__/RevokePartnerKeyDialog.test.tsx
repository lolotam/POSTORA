import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RevokePartnerKeyDialog } from "../RevokePartnerKeyDialog";

describe("RevokePartnerKeyDialog", () => {
  it("requires a reason before confirming", () => {
    const onConfirm = vi.fn();
    render(<RevokePartnerKeyDialog keyName="Danat backend" open onOpenChange={() => {}} onConfirm={onConfirm} isPending={false} />);
    const confirm = screen.getByRole("button", { name: /revoke key/i });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "leaked in a log" } });
    fireEvent.click(confirm);
    expect(onConfirm).toHaveBeenCalledWith("leaked in a log");
  });
});
