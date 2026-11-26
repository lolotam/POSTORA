import { supabase } from "@/integrations/supabase/client";
import type { YouTubeReplySuggestionGateway, YouTubeReplySuggestionInput } from "../application/ports";

export class SupabaseReplySuggestionGateway implements YouTubeReplySuggestionGateway {
  async suggestReply(input: YouTubeReplySuggestionInput): Promise<string> {
    const { data, error } = await supabase.functions.invoke("generate-caption", {
      body: {
        requestType: "youtube_comment_reply",
        platform: "youtube",
        language: input.language ?? "auto",
        context: JSON.stringify({
          video_title: input.videoTitle.slice(0, 100),
          comment_text: input.commentText.slice(0, 2000),
        }),
      },
      signal: input.signal,
      timeout: 15000,
    });
    if (error) throw error;
    if (data?.error) throw new Error(data.error);
    const suggestion = Array.isArray(data?.suggestions) ? data.suggestions[0] : null;
    if (typeof suggestion !== "string" || !suggestion.trim()) throw new Error("reply_invalid");
    return suggestion;
  }
}

export const defaultYouTubeReplySuggestionGateway = new SupabaseReplySuggestionGateway();
