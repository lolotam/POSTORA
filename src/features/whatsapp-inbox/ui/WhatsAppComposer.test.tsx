import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation } from "@/hooks/useMessaging";
import type { WhatsAppInboxApi } from "../application/ports";
import { WhatsAppInboxApiProvider } from "./WhatsAppInboxApiProvider";

const upload = vi.fn();
const getPublicUrl = vi.fn();
const getUser = vi.fn();

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getUser: (...args: unknown[]) => getUser(...args) },
    storage: {
      from: () => ({
        upload: (...args: unknown[]) => upload(...args),
        getPublicUrl: (...args: unknown[]) => getPublicUrl(...args),
      }),
    },
    from: () => ({ insert: vi.fn() }),
  },
}));

vi.mock("@/lib/postoraFileName", () => ({
  buildPostoraFileName: vi.fn(async () => "postora_2026-08-25_user-uuid_1.jpg"),
}));

vi.mock("@/hooks/useMessaging", () => ({
  useSendMessage: () => ({ mutate: vi.fn(), isPending: false }),
}));

vi.mock("@/components/messaging/QuickReplyPicker", () => ({
  QuickReplyPicker: () => <div>Quick replies</div>,
  SlashCommandSuggestions: () => null,
}));

vi.mock("@/components/messaging/InteractiveMessageBuilder", () => ({
  InteractiveMessageBuilder: () => <div>Interactive</div>,
}));

import { WhatsAppComposer } from "./WhatsAppComposer";

const conversation: Conversation = {
  id: "wa_96550000000_96551111111",
  participant_name: "Customer",
  participant_id: "96551111111",
  participant_avatar: null,
  last_message: "Hello",
  last_message_time: "2026-08-25T10:00:00.000Z",
  last_message_from: "96551111111",
  unread_count: 0,
  updated_time: "2026-08-25T10:00:00.000Z",
};

class FakeMediaRecorder {
  static isTypeSupported(type: string): boolean {
    return type.startsWith("audio/webm");
  }

  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state: "inactive" | "recording" = "inactive";
  mimeType: string;

  constructor(_stream: MediaStream, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? "";
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob([new Uint8Array(64)], { type: this.mimeType || "audio/webm" }),
    });
    this.onstop?.();
  }
}

function installVoiceBrowser(): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    writable: true,
    value: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [{ stop: vi.fn(), kind: "audio", readyState: "live" }],
      })),
    },
  });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  vi.stubGlobal("AudioContext", function AudioContext() {
    return {
      state: "running",
      close: vi.fn(async () => {}),
      createMediaStreamSource: () => ({ connect: vi.fn() }),
      createAnalyser: () => ({
        fftSize: 256,
        frequencyBinCount: 8,
        getByteTimeDomainData: (buffer: Uint8Array) => buffer.fill(128),
        connect: vi.fn(),
      }),
    };
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => (
    window.setTimeout(() => callback(0), 16) as unknown as number
  ));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
}

describe("WhatsAppComposer outbound upload", () => {
  let sendMedia: ReturnType<typeof vi.fn>;
  let sendVoice: ReturnType<typeof vi.fn>;
  let api: WhatsAppInboxApi;
  let queryClient: QueryClient;

  beforeEach(() => {
    sendMedia = vi.fn(async () => ({}));
    sendVoice = vi.fn(async () => ({ success: true, message_id: "3EB0" }));
    api = {
      getMessagesPage: vi.fn(),
      getMedia: vi.fn(),
      sendMedia: sendMedia as unknown as WhatsAppInboxApi["sendMedia"],
      sendInteractive: vi.fn(),
      getConversationState: vi.fn(),
      setMessageFlag: vi.fn(),
      revokeMessage: vi.fn(),
      sendVoice: sendVoice as unknown as WhatsAppInboxApi["sendVoice"],
      forwardMessage: vi.fn(),
      deleteConversation: vi.fn(),
      downloadBlob: vi.fn(),
    };
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    vi.spyOn(queryClient, "invalidateQueries");
    getUser.mockResolvedValue({ data: { user: { id: "user-uuid" } } });
    upload.mockResolvedValue({ data: { path: "user-uuid/whatsapp/outbound/postora_2026-08-25_user-uuid_1.jpg" }, error: null });
    getPublicUrl.mockReturnValue({ data: { publicUrl: "https://should-not-be-used.example/x" } });
    URL.createObjectURL = vi.fn(() => "blob:preview");
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderComposer(connectionMode: "evolution_qr" | "cloud_api" | "coexistence" | null = null) {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <WhatsAppInboxApiProvider api={api}>{children}</WhatsAppInboxApiProvider>
      </QueryClientProvider>
    );
    return render(
      <WhatsAppComposer
        conversation={conversation}
        socialAccountId="account-1"
        connectionMode={connectionMode}
      />,
      { wrapper },
    );
  }

  it("uploads under the caller's uid and sends media_path instead of a public URL", async () => {
    const { container } = renderComposer();
    const file = new File(["hello"], "photo.jpg", { type: "image/jpeg" });
    const input = container.querySelector("input[type=file]") as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    await waitFor(() => expect(sendMedia).toHaveBeenCalled());
    expect(upload).toHaveBeenCalledWith(
      "user-uuid/whatsapp/outbound/postora_2026-08-25_user-uuid_1.jpg",
      file,
    );
    expect(sendMedia).toHaveBeenCalledWith({
      social_account_id: "account-1",
      recipient_phone: conversation.participant_id,
      media_path: "user-uuid/whatsapp/outbound/postora_2026-08-25_user-uuid_1.jpg",
      media_type: "image",
      caption: undefined,
    });
    expect(getPublicUrl).not.toHaveBeenCalled();
    expect(queryClient.invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["messaging-messages", conversation.id],
    });
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");
  });

  it("hides the mic for a cloud account", () => {
    installVoiceBrowser();
    renderComposer("cloud_api");
    expect(screen.queryByRole("button", { name: /record voice note/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /send message/i }).getAttribute("title")).toMatch(/Direct QR/i);
  });

  it("replaces Send with the mic on a Direct QR account when the text box is empty", () => {
    installVoiceBrowser();
    renderComposer("evolution_qr");
    expect(screen.getByRole("button", { name: /record voice note/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send message/i })).not.toBeInTheDocument();
  });

  it("labels Attach ▸ Audio as a file attachment, not a voice note", async () => {
    renderComposer("cloud_api");
    const trigger = screen.getByRole("button", { name: /attach a file/i });
    fireEvent.pointerDown(trigger, { button: 0, buttons: 1, pointerType: "mouse" });
    fireEvent.click(trigger);
    await waitFor(() => {
      expect(screen.getByRole("menuitem", { name: /audio file/i })).toBeInTheDocument();
    });
    expect(screen.queryByRole("menuitem", { name: /^voice note/i })).not.toBeInTheDocument();
  });

  it("hides the interactive builder on a Direct QR account and shows the disabled label", () => {
    renderComposer("evolution_qr");
    expect(screen.queryByText("Interactive")).not.toBeInTheDocument();
    expect(screen.getByRole("button", {
      name: /interactive messages are only available on cloud api accounts/i,
    })).toBeDisabled();
  });

  it("shows the interactive builder on a Cloud API account", () => {
    renderComposer("cloud_api");
    expect(screen.getByText("Interactive")).toBeInTheDocument();
  });

  it("uploads a recorded note under the caller uid and sends media_path", async () => {
    installVoiceBrowser();
    upload.mockResolvedValue({ data: { path: "user-uuid/whatsapp/outbound/voice.webm" }, error: null });
    renderComposer("evolution_qr");
    fireEvent.pointerDown(screen.getByRole("button", { name: /record voice note/i }), {
      button: 0,
      clientX: 200,
    });
    await waitFor(() => expect(screen.getByTestId("wa-voice-recording")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /stop recording/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /send voice note/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: /send voice note/i }));

    await waitFor(() => expect(sendVoice).toHaveBeenCalled());
    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(/^user-uuid\/whatsapp\/outbound\//),
      expect.any(Blob),
      expect.objectContaining({ contentType: "audio/webm;codecs=opus" }),
    );
    expect(sendVoice).toHaveBeenCalledWith(expect.objectContaining({
      social_account_id: "account-1",
      recipient_phone: conversation.participant_id,
      media_path: expect.stringMatching(/^user-uuid\/whatsapp\/outbound\//),
      mime_type: "audio/webm;codecs=opus",
    }));
    expect(getPublicUrl).not.toHaveBeenCalled();
  });
});
