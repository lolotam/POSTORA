/**
 * One contract shared with the edge function: re-exported, never redefined.
 * (ARCHITECTURE.md §22, the same pattern as youtube-management / instagram-insights.)
 */
export type {
  Stage4Reason,
  Stage4Capability,
  Stage4CapabilitiesPayload,
  Stage4VideoRow,
  Stage4VideoPagePayload,
  Stage4CommentRow,
  Stage4ThreadPagePayload,
  Stage4ReplyPagePayload,
  Stage4ReceiptPayload,
  Stage4OperationStatusPayload,
  Stage4BanConfirmationPayload,
} from "../../../../supabase/functions/comment-manager/stage4/contracts";

export class YouTubeCommentsError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
    this.name = "YouTubeCommentsError";
  }
}
