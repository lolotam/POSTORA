import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WhatsAppQrDisclaimerDialog } from "../WhatsAppQrDisclaimerDialog";

// This dialog is the liability control for an unofficial WhatsApp connection:
// the consent it captures is written to social_accounts.account_metadata as the
// audit trail. If it ever becomes bypassable, numbers get linked without a
// recorded acceptance, so the gating is worth pinning down.
describe("WhatsAppQrDisclaimerDialog", () => {
  const setup = () => {
    const onProceed = vi.fn();
    render(<WhatsAppQrDisclaimerDialog open onOpenChange={vi.fn()} onProceed={onProceed} />);
    return { onProceed, proceed: screen.getByRole("button", { name: /continue to qr scanner/i } ) };
  };

  it("keeps the proceed button disabled until the risk checkbox is ticked", () => {
    const { onProceed, proceed } = setup();

    expect(proceed).toBeDisabled();
    fireEvent.click(proceed);
    expect(onProceed).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox"));

    expect(proceed).toBeEnabled();
    fireEvent.click(proceed);
    expect(onProceed).toHaveBeenCalledTimes(1);
  });

  it("re-arms the gate when the dialog is reopened", () => {
    const onProceed = vi.fn();
    const { rerender } = render(
      <WhatsAppQrDisclaimerDialog open onOpenChange={vi.fn()} onProceed={onProceed} />,
    );
    fireEvent.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: /continue to qr scanner/i })).toBeEnabled();

    rerender(<WhatsAppQrDisclaimerDialog open={false} onOpenChange={vi.fn()} onProceed={onProceed} />);
    rerender(<WhatsAppQrDisclaimerDialog open onOpenChange={vi.fn()} onProceed={onProceed} />);

    // A previous acceptance must not carry over into a fresh connection attempt.
    expect(screen.getByRole("button", { name: /continue to qr scanner/i })).toBeDisabled();
  });
});
