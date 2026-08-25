import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { WhatsAppInboxApi } from "../application/ports";
import { WhatsAppMediaScope } from "../application/useWhatsAppMedia";
import { WhatsAppInboxApiProvider } from "./WhatsAppInboxApiProvider";
import { WhatsAppMessageBubble, type WhatsAppMessage } from "./WhatsAppMessageBubble";

function message(overrides: Partial<WhatsAppMessage> = {}): WhatsAppMessage {
  return {
    id: "msg-1",
    message: "hello",
    from: { name: "Customer", id: "96551111111" },
    to: [{ name: "", id: "96550000000" }],
    created_time: "2026-08-25T10:00:00.000Z",
    attachments: [],
    ...overrides,
  };
}

const api: WhatsAppInboxApi = {
  getMessagesPage: vi.fn(async () => ({ messages: [] })),
  getMedia: vi.fn(async () => ({ media: [] })),
  sendMedia: vi.fn(),
  sendInteractive: vi.fn(),
};

function renderBubble(msg: WhatsAppMessage) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <WhatsAppInboxApiProvider api={api}>
        <WhatsAppMediaScope socialAccountId="acct-1">{children}</WhatsAppMediaScope>
      </WhatsAppInboxApiProvider>
    </QueryClientProvider>
  );
  return render(<WhatsAppMessageBubble message={msg} isSent={false} />, { wrapper });
}

describe("WhatsAppMessageBubble", () => {
  it("renders a collapsible AI description when media_understanding is present", () => {
    renderBubble(message({ media_understanding: "A brown dog on a sofa" }));
    expect(screen.queryByText("A brown dog on a sofa")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("AI description"));
    expect(screen.getByText("A brown dog on a sofa")).toBeInTheDocument();
  });

  it("omits the AI description control when understanding is absent", () => {
    renderBubble(message());
    expect(screen.queryByText("AI description")).not.toBeInTheDocument();
  });

  it("renders a media attachment for each typed attachment", () => {
    renderBubble(message({
      attachments: [{
        kind: "image",
        message_row_id: "row-1",
        mime_type: "image/jpeg",
        name: "photo.jpg",
        needs_fetch: true,
        file_url: "not-browser-safe",
      }],
    } as WhatsAppMessage));
    expect(screen.getByTestId("wa-media-pending")).toBeInTheDocument();
  });
});
