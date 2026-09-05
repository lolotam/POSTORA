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

export interface PolledYouTubeComment {
  input: PolledCommentInput;
  // The Google item for this comment alone: the commentThread for the top level, the
  // reply item for a reply. It is what the inbox row stores.
  raw: unknown;
}

/** Top-level first so a reply never reaches the door before the comment it answers. */
export function threadToInputs(
  thread: YouTubeThreadItem,
): PolledYouTubeComment[] {
  return [
    { input: toInput(thread, "comment"), raw: thread.raw },
    ...thread.replies.map((reply) => ({
      input: toInput(reply, "reply"),
      raw: reply.raw,
    })),
  ];
}
