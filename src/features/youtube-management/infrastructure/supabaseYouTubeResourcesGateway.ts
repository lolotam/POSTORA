import { supabase } from "@/integrations/supabase/client";
import { toYouTubeResourceError, YouTubeResourceError } from "../domain/errors";
import type {
  YouTubeAccountCapabilities,
  YouTubeChannelDetails,
  YouTubeResourceSuccess,
  YouTubeVideoDetails,
  YouTubeVideosPage,
} from "../domain/types";
import type { YouTubeResourcesGateway } from "../application/ports";

// One helper does every call: never a user id in the body (identity comes
// from the Authorization header server-side), and a failure always throws a
// YouTubeResourceError with the server's stable code — never an empty result.
async function call<T>(body: Record<string, unknown>): Promise<YouTubeResourceSuccess<T>> {
  const { data, error } = await supabase.functions.invoke<YouTubeResourceSuccess<T>>("youtube-resources", { body });
  if (error) {
    const context = (error as { context?: unknown }).context;
    const payload: unknown = context instanceof Response
      ? await context.clone().json().catch(() => null)
      : null;
    throw toYouTubeResourceError(payload);
  }
  if (!data) throw new YouTubeResourceError("upstream_unavailable");
  return data;
}

export class SupabaseYouTubeResourcesGateway implements YouTubeResourcesGateway {
  getCapabilities(accountId: string): Promise<YouTubeResourceSuccess<YouTubeAccountCapabilities>> {
    return call({ operation: "capabilities", account_id: accountId });
  }

  getChannel(accountId: string): Promise<YouTubeResourceSuccess<YouTubeChannelDetails>> {
    return call({ operation: "channel", account_id: accountId });
  }

  listVideos(params: { accountId: string; pageToken?: string | null }): Promise<YouTubeResourceSuccess<YouTubeVideosPage>> {
    return call({
      operation: "videos",
      account_id: params.accountId,
      ...(params.pageToken ? { page_token: params.pageToken } : {}),
    });
  }

  getVideo(params: { accountId: string; videoId: string }): Promise<YouTubeResourceSuccess<YouTubeVideoDetails>> {
    return call({ operation: "video", account_id: params.accountId, video_id: params.videoId });
  }
}

export const defaultYouTubeResourcesGateway = new SupabaseYouTubeResourcesGateway();
