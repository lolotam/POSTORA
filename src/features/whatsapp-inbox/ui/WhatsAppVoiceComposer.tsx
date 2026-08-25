import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Mic, Send, Square, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useVoiceRecorder } from "../application/useVoiceRecorder";
import { MAX_BYTES } from "../domain/voiceNotePolicy";
import { VoiceNotePlayer } from "./VoiceNotePlayer";

const LEVEL_BARS = 32;
const SLIDE_CANCEL_PX = -60;
const HOLD_TO_STOP_MS = 400;

interface WhatsAppVoiceComposerProps {
  offered: boolean;
  onSend(blob: Blob, mimeType: string, durationSeconds: number): Promise<void>;
  onBusyChange?(busy: boolean): void;
}

function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${(total % 60).toString().padStart(2, "0")}`;
}

function LevelMeter({ level }: { level: number }): JSX.Element {
  const clamped = Math.min(1, Math.max(0, level));
  return (
    <div
      className="flex h-6 flex-1 items-end gap-px"
      role="meter"
      aria-label="Input level"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(clamped * 100)}
      data-testid="wa-voice-level"
    >
      {Array.from({ length: LEVEL_BARS }, (_, index) => {
        const active = clamped > 0 && (index + 1) / LEVEL_BARS <= clamped;
        return (
          <span
            key={index}
            className={cn(
              "min-w-[2px] flex-1 rounded-sm",
              active ? "bg-emerald-500" : "bg-muted",
            )}
            style={{ height: `${12 + Math.round((index / LEVEL_BARS) * 12)}px` }}
          />
        );
      })}
    </div>
  );
}

export function WhatsAppVoiceComposer({
  offered,
  onSend,
  onBusyChange,
}: WhatsAppVoiceComposerProps): JSX.Element | null {
  const recorder = useVoiceRecorder();
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const previewUrlRef = useRef<string | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const gestureRef = useRef<{ startX: number; startedAt: number; wasRecording: boolean } | null>(null);
  const cancelRef = useRef(recorder.cancel);
  const stopRef = useRef(recorder.stop);
  cancelRef.current = recorder.cancel;
  stopRef.current = recorder.stop;

  const busy = recorder.state === "requesting"
    || recorder.state === "recording"
    || recorder.state === "preview"
    || recorder.state === "denied"
    || sending;

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  useEffect(() => {
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    if (recorder.blob && recorder.state === "preview") {
      const url = URL.createObjectURL(recorder.blob);
      previewUrlRef.current = url;
      setPreviewUrl(url);
      return;
    }
    setPreviewUrl(null);
  }, [recorder.blob, recorder.state]);

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
  }, []);

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      if (event.clientX - gesture.startX <= SLIDE_CANCEL_PX) {
        gestureRef.current = null;
        cancelRef.current();
      }
    };
    const onUp = () => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      gestureRef.current = null;
      if (gesture.wasRecording) {
        stopRef.current();
        return;
      }
      if (Date.now() - gesture.startedAt >= HOLD_TO_STOP_MS) {
        stopRef.current();
      }
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, []);

  if (!offered && !busy) return null;

  const tooLarge = Boolean(recorder.blob && recorder.blob.size > MAX_BYTES);
  const durationSeconds = Math.max(0.001, recorder.elapsedMs / 1000);

  const handleMicPointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const wasRecording = recorder.state === "recording";
    gestureRef.current = {
      startX: event.clientX,
      startedAt: Date.now(),
      wasRecording,
    };
    if (!wasRecording) void recorder.start();
  };

  const handleDiscard = () => {
    setSendError(null);
    recorder.reset();
  };

  const handleSend = async () => {
    if (!recorder.blob || !recorder.mimeType || tooLarge || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await onSend(recorder.blob, recorder.mimeType, durationSeconds);
      recorder.reset();
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Failed to send voice note");
    } finally {
      setSending(false);
    }
  };

  if (recorder.state === "denied") {
    return (
      <div className="flex flex-1 items-start gap-2 rounded-md bg-muted/60 px-3 py-2" data-testid="wa-voice-denied">
        <p className="flex-1 text-sm" role="alert">
          Microphone access was blocked. Allow the microphone in your browser settings to send voice notes.
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={handleDiscard}>
          OK
        </Button>
      </div>
    );
  }

  if (recorder.state === "unsupported") {
    return (
      <div className="flex flex-1 items-start gap-2 rounded-md bg-muted/60 px-3 py-2">
        <p className="flex-1 text-sm" role="alert">
          This browser cannot record a voice note.
        </p>
        <Button type="button" variant="ghost" size="sm" onClick={handleDiscard}>
          OK
        </Button>
      </div>
    );
  }

  if (recorder.state === "recording" || recorder.state === "requesting") {
    return (
      <div className="flex flex-1 items-center gap-2" data-testid="wa-voice-recording">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label="Cancel recording"
          className="h-9 w-9 shrink-0"
          onClick={() => recorder.cancel()}
        >
          <X className="h-4 w-4" />
        </Button>
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500" aria-hidden="true" />
        <span className="w-10 tabular-nums text-sm" data-testid="wa-voice-timer">
          {formatClock(recorder.elapsedMs)}
        </span>
        <span className="sr-only">Slide left to cancel</span>
        <LevelMeter level={recorder.level} />
        <Button
          type="button"
          size="icon"
          aria-label="Stop recording"
          className="h-9 w-9 shrink-0"
          onClick={() => recorder.stop()}
          disabled={recorder.state !== "recording"}
        >
          <Square className="h-4 w-4" />
        </Button>
      </div>
    );
  }

  if (recorder.state === "preview" && recorder.blob) {
    return (
      <div className="flex flex-1 flex-col gap-1" data-testid="wa-voice-preview">
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Discard voice note"
            className="h-9 w-9 shrink-0"
            onClick={handleDiscard}
            disabled={sending}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
          {previewUrl ? (
            <VoiceNotePlayer src={previewUrl} durationSeconds={durationSeconds} className="flex-1" />
          ) : null}
          <Button
            type="button"
            size="icon"
            aria-label="Send voice note"
            className="h-9 w-9 shrink-0"
            onClick={() => void handleSend()}
            disabled={tooLarge || sending}
            data-testid="wa-voice-send"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
        {tooLarge ? (
          <p className="text-xs text-destructive" role="alert">
            Voice note is too large to send (16 MB max).
          </p>
        ) : null}
        {sendError ? (
          <p className="text-xs text-destructive" role="alert">{sendError}</p>
        ) : null}
      </div>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label="Record voice note"
      className="h-9 w-9 shrink-0"
      onPointerDown={handleMicPointerDown}
      data-testid="wa-voice-mic"
    >
      <Mic className="h-4 w-4" />
    </Button>
  );
}
