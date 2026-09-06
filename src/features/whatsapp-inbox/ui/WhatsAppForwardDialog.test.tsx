import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WhatsAppInboxApi } from "../application/ports";
import { WhatsAppInboxApiProvider } from "./WhatsAppInboxApiProvider";
import { WhatsAppForwardDialog } from "./WhatsAppForwardDialog";

const forwardMessage = vi.fn(async () => ({ success: true, message_id: "x" }));
const api = { forwardMessage } as unknown as WhatsAppInboxApi;

describe("WhatsAppForwardDialog", () => {
  it("filters targets by name or digits and forwards on pick", async () => {
    const onOpenChange = vi.fn();
    render(
      <WhatsAppInboxApiProvider api={api}>
        <WhatsAppForwardDialog
          open
          onOpenChange={onOpenChange}
          socialAccountId="acct-1"
          messageRowId="row-1"
          targets={[{ phone: "96555", label: "Ali" }, { phone: "96599", label: "Sara" }]}
        />
      </WhatsAppInboxApiProvider>,
    );
    fireEvent.change(screen.getByPlaceholderText("Search chats or contacts"), { target: { value: "sar" } });
    expect(screen.queryByText("Ali")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Sara"));
    await waitFor(() => expect(forwardMessage).toHaveBeenCalledWith({
      social_account_id: "acct-1",
      message_row_id: "row-1",
      to_phone: "96599",
    }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("keeps the dialog open when the server refuses", async () => {
    forwardMessage.mockResolvedValueOnce({ success: false, error_type: "media_unavailable", error: "gone" } as never);
    const onOpenChange = vi.fn();
    render(
      <WhatsAppInboxApiProvider api={api}>
        <WhatsAppForwardDialog
          open
          onOpenChange={onOpenChange}
          socialAccountId="acct-1"
          messageRowId="row-1"
          targets={[{ phone: "96555", label: "Ali" }]}
        />
      </WhatsAppInboxApiProvider>,
    );
    fireEvent.click(screen.getByText("Ali"));
    await waitFor(() => expect(forwardMessage).toHaveBeenCalled());
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
