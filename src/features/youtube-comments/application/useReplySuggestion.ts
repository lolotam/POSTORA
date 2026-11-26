import { useCallback, useEffect, useRef, useState } from "react";
import type { YouTubeReplySuggestionGateway, YouTubeReplySuggestionInput } from "./ports";

export interface ReplySuggestionResult {
  suggestion: string | null;
  error: unknown | null;
}

export function useReplySuggestion(gateway?: YouTubeReplySuggestionGateway) {
  const [isSuggesting, setIsSuggesting] = useState(false);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      controllerRef.current?.abort();
    };
  }, []);

  const suggestReply = useCallback(async (input: YouTubeReplySuggestionInput): Promise<ReplySuggestionResult> => {
    if (!gateway) return { suggestion: null, error: new Error("reply_suggestion_unavailable") };
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsSuggesting(true);
    try {
      const suggestion = await gateway.suggestReply({
        ...input,
        videoTitle: input.videoTitle.slice(0, 100),
        commentText: input.commentText.slice(0, 2000),
        signal: input.signal ?? controller.signal,
      });
      return { suggestion, error: null };
    } catch (caught) {
      return { suggestion: null, error: caught };
    } finally {
      if (controllerRef.current === controller) {
        setIsSuggesting(false);
      }
    }
  }, [gateway]);

  return { suggestReply, isSuggesting };
}
