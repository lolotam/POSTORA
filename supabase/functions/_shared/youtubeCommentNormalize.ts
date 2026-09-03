import type { PolledCommentInput } from "./polledCommentIngest.ts";
import type {
  YouTubeCommentItem,
  YouTubeThreadItem,
} from "./youtubeComments.ts";

export function videoUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function toInput(
  item: YouTubeCommentItem,
  kind: "comment" | "reply",
): PolledCommentInput {
  return {
    comment: {
      id: item.id,
      kind,
      text: item.text,
      parentCommentId: item.parentId,
      mediaUrl: null,
    },
    post: {
      id: item.videoId || null,
      url: item.videoId ? videoUrl(item.videoId) : null,
      caption: null,
    },
    author: {
      id: item.authorChannelId,
      name: item.authorName,
      username: null,
    },
    timestamp: item.publishedAt,
  };
}

/** Top-level first so a reply never reaches the door before the comment it answers. */
export function threadToInputs(
  thread: YouTubeThreadItem,
): PolledCommentInput[] {
  return [
    toInput(thread, "comment"),
    ...thread.replies.map((reply) => toInput(reply, "reply")),
  ];
}
