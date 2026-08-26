import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_BYTES } from "../domain/voiceNotePolicy";
import { WhatsAppVoiceComposer } from "./WhatsAppVoiceComposer";

class FakeMediaRecorder {
  static isTypeSupported(type: string): boolean {
    return type.startsWith("audio/webm");
  }

  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  private readonly chunk: Blob;

  constructor(_stream: MediaStream, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? "";
    this.chunk = new Blob([new Uint8Array(64)], { type: this.mimeType || "audio/webm" });
  }

  start(): void {
    this.state = "recording";
  }

  stop(): void {
    this.state = "inactive";
    this.ondataavailable?.({ data: this.chunk });
    this.onstop?.();
  }
}

class HugeMediaRecorder extends FakeMediaRecorder {
  stop(): void {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob([new Uint8Array(MAX_BYTES + 1)], { type: this.mimeType || "audio/webm" }),
    });
    this.onstop?.();
  }
}

class FakeAudioContext {
  state: AudioContextState = "running";
  close = vi.fn(async () => {
    this.state = "closed";
  });
  createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
  createAnalyser = vi.fn(() => ({
    fftSize: 256,
    frequencyBinCount: 8,
    getByteTimeDomainData: (buffer: Uint8Array) => buffer.fill(128),
    connect: vi.fn(),
  }));
}

function installBrowserMocks(Recorder: typeof FakeMediaRecorder = FakeMediaRecorder): ReturnType<typeof vi.fn> {
  const trackStop = vi.fn();
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    writable: true,
    value: {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [{ stop: trackStop, kind: "audio", readyState: "live" }],
      })),
    },
  });
  vi.stubGlobal("MediaRecorder", Recorder);
  vi.stubGlobal("AudioContext", function AudioContext() {
    return new FakeAudioContext();
  });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => (
    window.setTimeout(() => callback(0), 16) as unknown as number
  ));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => window.clearTimeout(id));
  URL.createObjectURL = vi.fn(() => "blob:voice-preview");
  URL.revokeObjectURL = vi.fn();
  return trackStop;
}

async function recordThenStop(): Promise<void> {
  fireEvent.pointerDown(screen.getByRole("button", { name: /record voice note/i }), {
    button: 0,
    clientX: 200,
  });
  await waitFor(() => expect(screen.getByTestId("wa-voice-recording")).toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: /stop recording/i }));
  await waitFor(() => expect(screen.getByTestId("wa-voice-preview")).toBeInTheDocument());
}

describe("WhatsAppVoiceComposer", () => {
  beforeEach(() => {
    installBrowserMocks();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("hides the mic when it is not offered", () => {
    const { container } = render(
      <WhatsAppVoiceComposer offered={false} onSend={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("records, previews, and sends", async () => {
    const onSend = vi.fn(async (_blob: Blob, _mimeType: string, _durationSeconds: number) => {});
    render(<WhatsAppVoiceComposer offered onSend={onSend} />);
    await recordThenStop();
    expect(screen.getByRole("button", { name: /discard voice note/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /send voice note/i }));
    await waitFor(() => expect(onSend).toHaveBeenCalled());
    const [blob, mime, duration] = onSend.mock.calls[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(mime).toBe("audio/webm;codecs=opus");
    expect(duration).toBeGreaterThan(0);
  });

  // Regression, 2026-08-25: a blob over the declared cap used to reach the
  // action and look like a successful send while Evolution rejected it.
  it("refuses to send a blob over MAX_BYTES", async () => {
    installBrowserMocks(HugeMediaRecorder);
    const onSend = vi.fn(async (_blob: Blob, _mimeType: string, _durationSeconds: number) => {});
    render(<WhatsAppVoiceComposer offered onSend={onSend} />);
    await recordThenStop();
    expect(screen.getByRole("alert")).toHaveTextContent(/16 MB/i);
    fireEvent.click(screen.getByRole("button", { name: /send voice note/i }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("cancels when the pointer slides left past 60px", async () => {
    const trackStop = installBrowserMocks();
    render(<WhatsAppVoiceComposer offered onSend={vi.fn()} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: /record voice note/i }), {
      button: 0,
      clientX: 200,
    });
    await waitFor(() => expect(screen.getByTestId("wa-voice-recording")).toBeInTheDocument());
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { clientX: 120, bubbles: true }));
    });
    await waitFor(() => expect(screen.queryByTestId("wa-voice-recording")).not.toBeInTheDocument());
    expect(trackStop).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /record voice note/i })).toBeInTheDocument();
  });

  it("explains a microphone permission denial", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      writable: true,
      value: {
        getUserMedia: vi.fn(async () => {
          const error = new Error("Permission denied");
          error.name = "NotAllowedError";
          throw error;
        }),
      },
    });
    render(<WhatsAppVoiceComposer offered onSend={vi.fn()} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: /record voice note/i }), {
      button: 0,
      clientX: 200,
    });
    await waitFor(() => expect(screen.getByTestId("wa-voice-denied")).toBeInTheDocument());
    expect(screen.getByRole("alert")).toHaveTextContent(/microphone access was blocked/i);
  });

  it("revokes the preview object URL on discard", async () => {
    render(<WhatsAppVoiceComposer offered onSend={vi.fn()} />);
    await recordThenStop();
    fireEvent.click(screen.getByRole("button", { name: /discard voice note/i }));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:voice-preview");
  });
});
