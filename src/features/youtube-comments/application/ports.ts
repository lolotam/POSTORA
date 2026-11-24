import type {
  Stage4CapabilitiesPayload,
  Stage4VideoPagePayload,
  Stage4ThreadPagePayload,
  Stage4ReplyPagePayload,
  Stage4ReceiptPayload,
  Stage4OperationStatusPayload,
  Stage4BanConfirmationPayload,
} from "../domain/types";

export interface YouTubeCommentsGateway {
  capabilities(accountId: string): Promise<Stage4CapabilitiesPayload>;
  videoPage(accountId: string, cursor?: string | null): Promise<Stage4VideoPagePayload>;
  threadPage(params: { accountId: string; videoId: string; list: "published" | "heldForReview"; cursor?: string | null }): Promise<Stage4ThreadPagePayload>;
  replyPage(params: { accountId: string; parentHandle: string; cursor?: string | null }): Promise<Stage4ReplyPagePayload>;
  createThread(params: { accountId: string; videoId: string; text: string; operationId: string }): Promise<Stage4ReceiptPayload>;
  reply(params: { accountId: string; targetHandle: string; text: string; operationId: string }): Promise<Stage4ReceiptPayload>;
  edit(params: { accountId: string; targetHandle: string; text: string; operationId: string }): Promise<Stage4ReceiptPayload>;
  banConfirmation(params: { accountId: string; targetHandle: string; operationId: string }): Promise<Stage4BanConfirmationPayload>;
  moderate(params: { accountId: string; targetHandle: string; status: "published" | "heldForReview" | "rejected"; operationId: string; banConfirmation?: string }): Promise<Stage4ReceiptPayload>;
  /** `text` is the live draft of an edit, sent only so the server can compare it with the provider's text. */
  operationStatus(params: { accountId: string; operationId: string; text?: string }): Promise<Stage4OperationStatusPayload>;
  /**
   * Delete the channel's OWN comment through the existing (legacy) delete
   * action, which Stage 4 does not replace. It carries no operation key:
   * deleting twice is harmless, the second answer is simply "not found".
   */
  deleteOwnComment(params: { accountId: string; commentId: string }): Promise<void>;
}
