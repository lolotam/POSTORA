import { useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import type { TranscriptSegment } from "../../supabase/functions/_shared/youtubeTranscriptFormats";

export type { TranscriptSegment };

export interface TranscriptionResult {
  transcript: string;
  language: string;
  duration: number;
  segments: TranscriptSegment[] | null;
}

interface TranscriptionState extends TranscriptionResult {
  isTranscribing: boolean;
  error: string | null;
}

function isValidTranscriptSegment(item: unknown): item is TranscriptSegment {
  if (!item || typeof item !== "object") return false;
  const candidate = item as Record<string, unknown>;
  return (
    typeof candidate.start === "number" &&
    typeof candidate.end === "number" &&
    Number.isFinite(candidate.start) &&
    Number.isFinite(candidate.end) &&
    candidate.start >= 0 &&
    candidate.start < candidate.end &&
    typeof candidate.text === "string" &&
    candidate.text.trim().length > 0
  );
}

function normalizeTranscriptSegments(raw: unknown): TranscriptSegment[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  if (!raw.every(isValidTranscriptSegment)) return null;
  return raw.map((seg) => ({
    start: seg.start,
    end: seg.end,
    text: seg.text,
  }));
}

export function useTranscription() {
  const [state, setState] = useState<TranscriptionState>({
    transcript: "",
    language: "",
    duration: 0,
    segments: null,
    isTranscribing: false,
    error: null,
  });

  const transcribe = useCallback(async (mediaUrl: string): Promise<TranscriptionResult | null> => {
    setState((prev) => ({ ...prev, isTranscribing: true, error: null }));
    try {
      const { data, error } = await supabase.functions.invoke("transcribe-media", {
        body: { mediaUrl },
      });
      if (error) throw new Error(error.message || "Transcription failed");
      if (data?.error) throw new Error(data.error);
      const nextResult: TranscriptionResult = {
        transcript: data?.transcript || "",
        language: data?.language || "unknown",
        duration: data?.duration || 0,
        segments: normalizeTranscriptSegments(data?.segments),
      };
      setState({
        ...nextResult,
        isTranscribing: false,
        error: null,
      });
      return nextResult;
    } catch (err) {
      setState((prev) => ({
        ...prev,
        segments: null,
        isTranscribing: false,
        error: (err as Error).message,
      }));
      return null;
    }
  }, []);

  const reset = useCallback(() => {
    setState({
      transcript: "",
      language: "",
      duration: 0,
      segments: null,
      isTranscribing: false,
      error: null,
    });
  }, []);

  return { ...state, transcribe, reset };
}
