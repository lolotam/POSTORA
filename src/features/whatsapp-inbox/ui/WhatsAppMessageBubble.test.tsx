import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppInboxApi, WhatsAppMessage } from "../application/ports";
import { WhatsAppMediaScope } from "../application/useWhatsAppMedia";
import type { WhatsAppConnectionMode } from "../domain/whatsappCapabilities";
import { WhatsAppInboxApiProvider } from "./WhatsAppInboxApiProvider";
import { WhatsAppMessageBubble } from "./WhatsAppMessageBubble";

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
  downloadBlob: vi.fn(),
  getMessagesPage: vi.fn(async () => ({ messages: [] })),
  getMedia: vi.fn(async () => ({ media: [] })),
  sendMedia: vi.fn(),
  sendInteractive: vi.fn(),
  getConversationState: vi.fn(async () => ({ flags: [], pinned: [], mutable: [] })),
  setMessageFlag: vi.fn(),
  revokeMessage: vi.fn(),
  sendVoice: vi.fn(),
};

function renderBubble(
  msg: WhatsAppMessage,
  extra: { connectionMode?: WhatsAppConnectionMode; isSent?: boolean } = {},
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <WhatsAppInboxApiProvider api={api}>
        <WhatsAppMediaScope socialAccountId="acct-1">{children}</WhatsAppMediaScope>
      </WhatsAppInboxApiProvider>
    </QueryClientProvider>
  );
  return render(
    <WhatsAppMessageBubble
      message={msg}
      isSent={extra.isSent ?? false}
      connectionMode={extra.connectionMode ?? "evolution_qr"}
    />,
    { wrapper },
  );
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

  // userEvent is unusable here (its clipboard shim breaks), so copy uses fireEvent against
  // the navigator.clipboard mock already installed at src/test/setup.ts:62.
  it("copies the message text", () => {
    vi.mocked(navigator.clipboard.writeText).mockClear();
    renderBubble(message({ id: "a", message: "hello" }));
    fireEvent.contextMenu(screen.getByTestId("wa-bubble"));
    fireEvent.click(screen.getByText("Copy"));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("hello");
  });

  // One consistent contract: delete-for-everyone is ALWAYS present and ALWAYS disabled with a
  // reason where it cannot apply. It is never absent — a missing item reads as a bug.
  it.each([
    ["a cloud account", { connectionMode: "cloud_api" as const, direction: "outbound", provider_message_id: "3EB0" }],
    ["a received message", { connectionMode: "evolution_qr" as const, direction: "inbound", provider_message_id: "3EB0" }],
    ["a synthetic provider id", { connectionMode: "evolution_qr" as const, direction: "outbound", provider_message_id: "sched_1" }],
  ])("disables delete-for-everyone for %s", (_case, override) => {
    renderBubble(message({
      direction: override.direction,
      provider_message_id: override.provider_message_id,
    }), { connectionMode: override.connectionMode, isSent: override.direction === "outbound" });
    fireEvent.contextMenu(screen.getByTestId("wa-bubble"));
    const item = screen.getByText(/for everyone/i);
    expect(item).toBeInTheDocument();
    expect(item).toHaveAttribute("aria-disabled", "true");
  });

  // A long press must not fire while the user is scrolling the thread on touch.
  it.each(["pointermove", "pointerup", "pointercancel"])("cancels the long press on %s", (evt) => {
    vi.useFakeTimers();
    renderBubble(message());
    const bubble = screen.getByTestId("wa-bubble");
    fireEvent.pointerDown(bubble);
    fireEvent[evt === "pointermove" ? "pointerMove" : evt === "pointerup" ? "pointerUp" : "pointerCancel"](bubble, { clientY: 200 });
    act(() => vi.advanceTimersByTime(600));
    expect(screen.queryByText("Copy")).not.toBeInTheDocument();
    vi.useRealTimers();
  });

  it("exposes no actions on a revoked message", () => {
    renderBubble(message({
      revoked_at: "2026-08-25T13:00:00.000Z",
      direction: "outbound",
      provider_message_id: "3EB0",
    }), { isSent: true });
    expect(screen.getByText("This message was deleted")).toBeInTheDocument();
    fireEvent.contextMenu(screen.getByTestId("wa-bubble"));
    expect(screen.queryByText("Copy")).not.toBeInTheDocument();
    expect(screen.queryByText(/for everyone/i)).not.toBeInTheDocument();
  });

  it("shows ticks only on sent bubbles and reflects the status", () => {
    renderBubble(message({ status: "read", direction: "outbound" }), { isSent: true });
    expect(screen.getByTestId("wa-ticks")).toHaveAttribute("data-status", "read");
  });

  it("shows no ticks on received bubbles", () => {
    renderBubble(message({ status: "received" }), { isSent: false });
    expect(screen.queryByTestId("wa-ticks")).not.toBeInTheDocument();
  });

  it("renders the time as hours and minutes only", () => {
    const iso = "2026-08-25T10:07:00.000Z";
    renderBubble(message({ created_time: iso }));
    const expected = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
    expect(screen.getByText(expected)).toBeInTheDocument();
  });
});

afterEach(() => {
  vi.useRealTimers();
});
