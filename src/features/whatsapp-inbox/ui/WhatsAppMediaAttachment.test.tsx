import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WhatsAppAttachment, WhatsAppInboxApi, WhatsAppResolvedMedia } from "../application/ports";
import { WhatsAppMediaScope } from "../application/useWhatsAppMedia";
import { WhatsAppInboxApiProvider } from "./WhatsAppInboxApiProvider";
import { WhatsAppMediaAttachment } from "./WhatsAppMediaAttachment";

type ObserverRecord = {
  callback: IntersectionObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
};

let observers: ObserverRecord[] = [];

function stubIntersectionObserver() {
  observers = [];
  // setup.ts defines IntersectionObserver as writable but not configurable, so
  // vi.stubGlobal cannot replace it.
  window.IntersectionObserver = class {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
    constructor(callback: IntersectionObserverCallback) {
      observers.push({ callback, observe: this.observe, disconnect: this.disconnect });
    }
  } as unknown as typeof IntersectionObserver;
}

function triggerIntersect(isIntersecting = true) {
  for (const observer of observers) {
    observer.callback(
      [{ isIntersecting, intersectionRatio: isIntersecting ? 1 : 0, target: document.createElement("div") } as unknown as IntersectionObserverEntry],
      observer as unknown as IntersectionObserver,
    );
  }
}

function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function attachment(overrides: Partial<WhatsAppAttachment> = {}): WhatsAppAttachment {
  return {
    kind: "image",
    message_row_id: "row-1",
    mime_type: "image/jpeg",
    name: "photo.jpg",
    needs_fetch: true,
    file_url: "user/whatsapp/inbound/row-1.jpg",
    ...overrides,
  };
}

function media(overrides: Partial<WhatsAppResolvedMedia> = {}): WhatsAppResolvedMedia {
  return {
    message_row_id: "row-1",
    kind: "image",
    url: "https://signed.example/photo.jpg",
    expires_in: 3600,
    mime_type: "image/jpeg",
    file_name: "photo.jpg",
    ...overrides,
  };
}

function renderAttachment(
  item: WhatsAppAttachment,
  api: WhatsAppInboxApi,
) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createQueryClient()}>
      <WhatsAppInboxApiProvider api={api}>
        <WhatsAppMediaScope socialAccountId="acct-1">{children}</WhatsAppMediaScope>
      </WhatsAppInboxApiProvider>
    </QueryClientProvider>
  );
  return render(<WhatsAppMediaAttachment attachment={item} createdTime="2026-08-25T10:00:00.000Z" />, { wrapper });
}

describe("WhatsAppMediaAttachment", () => {
  let getMedia: ReturnType<typeof vi.fn>;
  let api: WhatsAppInboxApi;

  beforeEach(() => {
    stubIntersectionObserver();
    getMedia = vi.fn();
    api = {
      getMessagesPage: vi.fn(),
      getMedia: getMedia as unknown as WhatsAppInboxApi["getMedia"],
      sendMedia: vi.fn(),
      sendInteractive: vi.fn(),
      getConversationState: vi.fn(),
      setMessageFlag: vi.fn(),
      revokeMessage: vi.fn(),
      sendVoice: vi.fn(),
      forwardMessage: vi.fn(),
      deleteConversation: vi.fn(),
      downloadBlob: vi.fn(),
    };
  });

  it("does not fetch a bubble that is far outside the pane", async () => {
    // jsdom gives every element a zero rect, which the geometric fallback would read as
    // on-screen. Place this one well below the pane so the assertion is about the behaviour
    // rather than about jsdom's missing layout.
    const far = vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({
      top: 5000, bottom: 5100, left: 0, right: 100, width: 100, height: 100, x: 0, y: 5000,
      toJSON: () => ({}),
    } as DOMRect);

    renderAttachment(attachment(), api);
    await Promise.resolve();
    expect(getMedia).not.toHaveBeenCalled();
    expect(screen.getByTestId("wa-media-pending")).toBeInTheDocument();
    far.mockRestore();
  });

  it("never puts file_url on an img", () => {
    renderAttachment(attachment({ file_url: "https://lookaside.example/secret" }), api);
    expect(document.querySelector("img")).toBeNull();
  });

  it("renders an img for kind image after a signed url arrives", async () => {
    getMedia.mockResolvedValue({ media: [media()] });
    renderAttachment(attachment(), api);
    act(() => triggerIntersect());
    const img = await screen.findByRole("img", { name: "photo.jpg" });
    expect(img).toHaveAttribute("src", "https://signed.example/photo.jpg");
    // Verified in a real browser on 2026-08-26: loading="lazy" inside the programmatically
    // scrolled message pane means Chrome never marks these images visible, so they stay
    // unloaded forever and the bubble renders blank on a perfectly good URL. The laziness
    // that matters is already in useWhatsAppMedia, which only asks the server to materialise
    // bytes once the bubble enters the viewport.
    expect(img).not.toHaveAttribute("loading", "lazy");
    expect(img.className).toContain("max-h-72");
    // Without a starting box an <img> with only max-* constraints lays out at 0x0.
    expect(img.className).toContain("min-h-24");
  });

  it("renders video with native controls and metadata preload", async () => {
    getMedia.mockResolvedValue({
      media: [media({ kind: "video", url: "https://signed.example/clip.mp4", file_name: "clip.mp4" })],
    });
    renderAttachment(attachment({ kind: "video", name: "clip.mp4", mime_type: "video/mp4" }), api);
    act(() => triggerIntersect());
    const video = await waitFor(() => {
      const el = document.querySelector("video");
      expect(el).toBeTruthy();
      return el as HTMLVideoElement;
    });
    expect(video).toHaveAttribute("controls");
    expect(video).toHaveAttribute("preload", "metadata");
    expect(video).not.toHaveAttribute("poster");
  });

  it("renders the voice player for audio", async () => {
    getMedia.mockResolvedValue({
      media: [media({ kind: "audio", url: "https://signed.example/note.ogg" })],
    });
    renderAttachment(attachment({ kind: "audio", name: "note.ogg", mime_type: "audio/ogg" }), api);
    act(() => triggerIntersect());
    expect(await screen.findByRole("button", { name: "Play" })).toBeInTheDocument();
  });

  it("renders filename and size for a document, and a generic label when both are absent", async () => {
    getMedia.mockResolvedValue({
      media: [media({ kind: "document", url: "https://signed.example/doc.pdf", file_name: "invoice.pdf", size_bytes: 2048 })],
    });
    renderAttachment(attachment({ kind: "document", name: null, mime_type: "application/pdf" }), api);
    act(() => triggerIntersect());
    expect(await screen.findByText("invoice.pdf")).toBeInTheDocument();
    expect(screen.getByText("2.0 KB")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /download/i })).toHaveAttribute("href", "https://signed.example/doc.pdf");
  });

  it("degrades a document to a generic label when name and size are missing", async () => {
    getMedia.mockResolvedValue({
      media: [media({ kind: "document", url: "https://signed.example/file.bin", file_name: undefined, size_bytes: undefined })],
    });
    renderAttachment(attachment({ kind: "document", name: null, mime_type: "application/octet-stream" }), api);
    act(() => triggerIntersect());
    expect(await screen.findByText("Document")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /download/i })).toBeInTheDocument();
  });

  // Regression, 2026-08-25: 527 historical rows have no stored bytes. A download
  // link would 404; a broken <img> is worse. Unavailable is a first-class state.
  it("renders an unavailable placeholder, not a download link, when url is null", async () => {
    getMedia.mockResolvedValue({
      media: [media({ url: null, error: "MEDIA_UNAVAILABLE" })],
    });
    renderAttachment(attachment({ file_url: null }), api);
    act(() => triggerIntersect());
    expect(await screen.findByTestId("wa-media-unavailable")).toHaveTextContent("Media unavailable");
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("offers a download on image, video and audio", async () => {
    getMedia.mockResolvedValue({ media: [media()] });
    renderAttachment(attachment(), api);
    act(() => triggerIntersect());
    expect(await screen.findByLabelText("Download image")).toBeInTheDocument();
  });

  it("opens a PDF in the lightbox from the document card", async () => {
    getMedia.mockResolvedValue({
      media: [media({ kind: "document", url: "https://signed.example/doc.pdf", file_name: "Receipt.pdf", mime_type: "application/pdf" })],
    });
    renderAttachment(attachment({ kind: "document", name: null, mime_type: "application/pdf" }), api);
    act(() => triggerIntersect());
    fireEvent.click(await screen.findByRole("button", { name: "Receipt.pdf" }));
    expect(await screen.findByTitle("Receipt.pdf")).toHaveAttribute("src", "https://signed.example/doc.pdf");
  });

  it("keeps a non-PDF document as a plain card", async () => {
    getMedia.mockResolvedValue({
      media: [media({ kind: "document", url: "https://signed.example/a.docx", file_name: "a.docx", mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" })],
    });
    renderAttachment(attachment({ kind: "document", name: "a.docx", mime_type: null }), api);
    act(() => triggerIntersect());
    expect(await screen.findByText("a.docx")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "a.docx" })).not.toBeInTheDocument();
  });

  it("opens a lightbox on image click and closes it with Escape", async () => {
    getMedia.mockResolvedValue({ media: [media()] });
    renderAttachment(attachment(), api);
    act(() => triggerIntersect());
    fireEvent.click(await screen.findByRole("img", { name: "photo.jpg" }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });
});

// Regression, 2026-08-26: media resolution hung on the pending skeleton forever whenever the
// IntersectionObserver never fired -- which is exactly what Chrome does while a tab is hidden.
// Confirmed in a real browser: with document.visibilityState "hidden", an observer on a fully
// on-screen 126x108 element never fires, with or without a root, so every voice note and image
// stayed a grey box that reads as an attachment that cannot be played.
//
// The observers stubbed here never invoke their callback -- the same condition as a hidden tab.
// Do NOT call triggerIntersect: the point is that media resolves without it.
describe("WhatsAppMediaAttachment when the observer never fires", () => {
  beforeEach(() => {
    stubIntersectionObserver();
  });

  it("still resolves an on-screen bubble", async () => {
    const getMedia = vi.fn().mockResolvedValue({
      media: [media({ kind: "audio", url: "https://signed.example/voice.ogg", mime_type: "audio/ogg" })],
    });
    const api = {
      getMessagesPage: vi.fn(),
      getMedia,
      sendMedia: vi.fn(),
      sendInteractive: vi.fn(),
      getConversationState: vi.fn(),
      setMessageFlag: vi.fn(),
      revokeMessage: vi.fn(),
      sendVoice: vi.fn(),
      forwardMessage: vi.fn(),
      deleteConversation: vi.fn(),
      downloadBlob: vi.fn(),
    } as unknown as WhatsAppInboxApi;

    renderAttachment(attachment({ kind: "audio" }), api);

    await waitFor(() => expect(getMedia).toHaveBeenCalled());
    await waitFor(() => expect(screen.queryByTestId("wa-media-pending")).not.toBeInTheDocument());
  });
});
