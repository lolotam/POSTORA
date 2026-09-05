import { videoUrl } from "../_shared/youtubeCommentNormalize.ts";
import type { YouTubeErrorClass } from "../_shared/youtubeApiErrors.ts";
import type {
  YouTubeCommentItem,
  YouTubeThreadItem,
} from "../_shared/youtubeComments.ts";

export interface YouTubeReplyView {
  id: string;
  text: string;
  author: { id: string | null; name: string; avatar_url: string | null };
  published_at: string;
  like_count: number;
  moderation_status: string | null;
  is_own: boolean;
}

export interface YouTubeThreadView extends YouTubeReplyView {
  total_reply_count: number;
  replies: YouTubeReplyView[];
}

export interface VideoGroup {
  id: string;
  title: string;
  url: string;
  threads: YouTubeThreadView[];
}

function view(
  item: YouTubeCommentItem,
  ownChannelId: string | null,
): YouTubeReplyView {
  return {
    id: item.id,
    text: item.text,
    author: {
      id: item.authorChannelId,
      name: item.authorName,
      avatar_url: item.authorAvatar,
    },
    published_at: item.publishedAt,
    like_count: item.likeCount,
    moderation_status: item.moderationStatus,
    is_own: !!ownChannelId && item.authorChannelId === ownChannelId,
  };
}

export function groupThreadsByVideo(
  items: YouTubeThreadItem[],
  titles: Map<string, { title: string }>,
  ownChannelId: string | null,
): VideoGroup[] {
  const groups = new Map<string, VideoGroup>();
  for (const item of items) {
    const group = groups.get(item.videoId) ?? {
      id: item.videoId,
      title: titles.get(item.videoId)?.title ?? "",
      url: videoUrl(item.videoId),
      threads: [],
    };
    group.threads.push({
      ...view(item, ownChannelId),
      total_reply_count: item.totalReplyCount,
      replies: item.replies.map((reply) => view(reply, ownChannelId)),
    });
    groups.set(item.videoId, group);
  }
  return [...groups.values()];
}

export function errorTypeFor(
  kind: YouTubeErrorClass,
): "MISSING_SCOPE" | "TOKEN_EXPIRED" | "QUOTA" | "YOUTUBE_ERROR" {
  if (kind === "scope_missing") return "MISSING_SCOPE";
  if (kind === "unauthorized") return "TOKEN_EXPIRED";
  if (kind === "quota") return "QUOTA";
  return "YOUTUBE_ERROR";
}
