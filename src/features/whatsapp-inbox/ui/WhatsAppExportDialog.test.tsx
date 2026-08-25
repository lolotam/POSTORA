import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WhatsAppInboxApi } from "../application/ports";
import { WhatsAppExportDialog } from "./WhatsAppExportDialog";
import { WhatsAppInboxApiProvider } from "./WhatsAppInboxApiProvider";

const api = {
  getMessagesPage: vi.fn(async () => ({ messages: [], page_info: { next_before: null, has_more: false } })),
  getMedia: vi.fn(async () => ({ media: [] })),
  downloadBlob: vi.fn(),
} as unknown as WhatsAppInboxApi;

function renderDialog(chats: Array<{ conversationId: string; participantName: string; participantPhone: string }>, estimatedMediaBytes = 0) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <WhatsAppInboxApiProvider api={api}>{children}</WhatsAppInboxApiProvider>
  );
  return render(
    <WhatsAppExportDialog
      open
      onOpenChange={() => {}}
      socialAccountId="acct"
      accountLabel="Support"
      chats={chats}
      estimatedMediaBytes={estimatedMediaBytes}
    />,
    { wrapper },
  );
}

const chat = (id: string, name: string) => ({
  conversationId: id,
  participantName: name,
  participantPhone: "96551111111",
});

describe("WhatsAppExportDialog", () => {
  it("offers Markdown and CSV for a single chat", () => {
    renderDialog([chat("c1", "Ahmed")]);
    expect(screen.getByLabelText(/markdown/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/csv/i)).toBeInTheDocument();
  });

  // A multi-chat export is a zip of markdown; CSV has no sensible multi-file shape, so the
  // dialog says so rather than offering a format it cannot honour.
  it("offers no CSV choice for several chats and explains why", () => {
    renderDialog([chat("c1", "Ahmed"), chat("c2", "Sara")]);
    expect(screen.queryByLabelText(/^csv/i)).not.toBeInTheDocument();
    expect(screen.getByText(/available when exporting a single chat/i)).toBeInTheDocument();
  });

  it("leaves include-media unchecked by default", () => {
    renderDialog([chat("c1", "Ahmed")]);
    expect(screen.getByLabelText(/include media files/i)).not.toBeChecked();
  });

  it("warns before a large media download, but only once media is requested", () => {
    renderDialog([chat("c1", "Ahmed")], 60 * 1024 * 1024);
    expect(screen.queryByText(/may take a while/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByLabelText(/include media files/i));
    expect(screen.getByText(/60 MB/)).toBeInTheDocument();
  });
});
