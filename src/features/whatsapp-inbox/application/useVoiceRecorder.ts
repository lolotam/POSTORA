import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_DURATION_SECONDS, pickRecordingMimeType } from "../domain/voiceNotePolicy";

export type RecorderState =
  | "idle"
  | "requesting"
  | "recording"
  | "preview"
  | "uploading"
  | "denied"
  | "unsupported";

export interface VoiceRecorder {
  state: RecorderState;
  elapsedMs: number;
  level: number;
  blob: Blob | null;
  mimeType: string | null;
  start(): Promise<void>;
  stop(): void;
  cancel(): void;
  reset(): void;
}

type MediaRecorderCtor = {
  new (stream: MediaStream, options?: { mimeType?: string }): MediaRecorder;
  isTypeSupported(type: string): boolean;
};

function mediaRecorderCtor(): MediaRecorderCtor | null {
  const ctor = (globalThis as unknown as { MediaRecorder?: MediaRecorderCtor }).MediaRecorder;
  return typeof ctor === "function" ? ctor : null;
}

function rmsLevel(data: Uint8Array): number {
  if (data.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const sample = (data[i] - 128) / 128;
    sum += sample * sample;
  }
  return Math.sqrt(sum / data.length);
}

export function useVoiceRecorder(): VoiceRecorder {
  const [state, setState] = useState<RecorderState>("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [level, setLevel] = useState(0);
  const [blob, setBlob] = useState<Blob | null>(null);
  const [mimeType, setMimeType] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const intervalRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const generationRef = useRef(0);
  const startedAtRef = useRef(0);
  const mountedRef = useRef(true);
  const outcomeRef = useRef<"preview" | "idle">("preview");
  const stateRef = useRef(state);
  stateRef.current = state;

  const releaseHardware = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (intervalRef.current != null) {
      window.clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    const context = audioContextRef.current;
    audioContextRef.current = null;
    if (context && context.state !== "closed") {
      void context.close();
    }
  }, []);

  const finishRecording = useCallback((nextBlob: Blob | null, nextState: RecorderState) => {
    releaseHardware();
    recorderRef.current = null;
    chunksRef.current = [];
    if (!mountedRef.current) return;
    setBlob(nextBlob);
    setLevel(0);
    setState(nextState);
  }, [releaseHardware]);

  const stop = useCallback(() => {
    const recorder = recorderRef.current;
    if (!recorder || recorder.state !== "recording") return;
    outcomeRef.current = "preview";
    try {
      recorder.stop();
    } catch {
      finishRecording(null, "idle");
    }
  }, [finishRecording]);

  const cancel = useCallback(() => {
    generationRef.current += 1;
    outcomeRef.current = "idle";
    const recorder = recorderRef.current;
    recorderRef.current = null;
    if (recorder) {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state === "recording") {
        try {
          recorder.stop();
        } catch {
          // Recorder already stopped; tracks still need an explicit stop().
        }
      }
    }
    releaseHardware();
    if (!mountedRef.current) return;
    setBlob(null);
    setElapsedMs(0);
    setLevel(0);
    setMimeType(null);
    setState("idle");
  }, [releaseHardware]);

  const reset = useCallback(() => {
    generationRef.current += 1;
    outcomeRef.current = "idle";
    const recorder = recorderRef.current;
    if (recorder && recorder.state === "recording") {
      cancel();
      return;
    }
    recorderRef.current = null;
    releaseHardware();
    if (!mountedRef.current) return;
    setBlob(null);
    setElapsedMs(0);
    setLevel(0);
    setMimeType(null);
    setState("idle");
  }, [cancel, releaseHardware]);

  const start = useCallback(async () => {
    if (stateRef.current === "recording" || stateRef.current === "requesting") return;

    const Recorder = mediaRecorderCtor();
    if (!Recorder) {
      setState("unsupported");
      return;
    }
    const selectedMime = pickRecordingMimeType((type) => Recorder.isTypeSupported(type));
    if (!selectedMime) {
      setState("unsupported");
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      setState("unsupported");
      return;
    }

    const generation = generationRef.current + 1;
    generationRef.current = generation;
    setState("requesting");
    setBlob(null);
    setElapsedMs(0);
    setLevel(0);
    setMimeType(selectedMime);

    let stream: MediaStream | null = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (generationRef.current !== generation || !mountedRef.current) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }

      streamRef.current = stream;
      chunksRef.current = [];
      const recorder = new Recorder(stream, { mimeType: selectedMime });
      recorderRef.current = recorder;
      outcomeRef.current = "preview";

      recorder.ondataavailable = (event: BlobEvent) => {
        if (event.data && event.data.size > 0) chunksRef.current.push(event.data);
      };
      recorder.onstop = () => {
        if (generationRef.current !== generation) {
          releaseHardware();
          return;
        }
        const recorded = new Blob(chunksRef.current, { type: selectedMime });
        if (outcomeRef.current === "preview") {
          finishRecording(recorded, "preview");
          return;
        }
        finishRecording(null, "idle");
      };

      try {
        const AudioContextCtor = window.AudioContext
          ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioContextCtor) {
          const context = new AudioContextCtor();
          audioContextRef.current = context;
          const source = context.createMediaStreamSource(stream);
          const analyser = context.createAnalyser();
          analyser.fftSize = 256;
          source.connect(analyser);
          const samples = new Uint8Array(analyser.frequencyBinCount);
          const tick = () => {
            analyser.getByteTimeDomainData(samples);
            if (mountedRef.current) setLevel(rmsLevel(samples));
            rafRef.current = requestAnimationFrame(tick);
          };
          rafRef.current = requestAnimationFrame(tick);
        }
      } catch {
        // Metering is best-effort; a missing AudioContext must not block recording.
      }

      recorder.start();
      startedAtRef.current = Date.now();
      intervalRef.current = window.setInterval(() => {
        const elapsed = Date.now() - startedAtRef.current;
        if (mountedRef.current) setElapsedMs(elapsed);
        if (elapsed >= MAX_DURATION_SECONDS * 1000) stop();
      }, 100);

      if (!mountedRef.current || generationRef.current !== generation) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        if (recorder.state === "recording") {
          try {
            recorder.stop();
          } catch {
            // already stopped
          }
        }
        recorderRef.current = null;
        releaseHardware();
        return;
      }
      setState("recording");
    } catch (error) {
      stream?.getTracks().forEach((track) => track.stop());
      releaseHardware();
      if (!mountedRef.current || generationRef.current !== generation) return;
      const name = error instanceof Error ? error.name : "";
      setState(name === "NotAllowedError" ? "denied" : "unsupported");
    }
  }, [finishRecording, releaseHardware, stop]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      const recorder = recorderRef.current;
      recorderRef.current = null;
      if (recorder) {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        if (recorder.state === "recording") {
          try {
            recorder.stop();
          } catch {
            // already stopped
          }
        }
      }
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      if (intervalRef.current != null) window.clearInterval(intervalRef.current);
      intervalRef.current = null;
      const context = audioContextRef.current;
      audioContextRef.current = null;
      if (context && context.state !== "closed") void context.close();
    };
  }, []);

  return { state, elapsedMs, level, blob, mimeType, start, stop, cancel, reset };
}
