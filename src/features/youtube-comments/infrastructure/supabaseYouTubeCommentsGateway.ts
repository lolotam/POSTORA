import { supabase } from "@/integrations/supabase/client";
import type { YouTubeCommentsGateway } from "../application/ports";
import type {
  Stage4CapabilitiesPayload,
  Stage4VideoPagePayload,
  Stage4ThreadPagePayload,
  Stage4ReplyPagePayload,
  Stage4ReceiptPayload,
  Stage4OperationStatusPayload,
  Stage4BanConfirmationPayload,
} from "../domain/types";

const TIMEOUT_MS = 15000;

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("comment-manager", {
    body,
    timeout: TIMEOUT_MS,
  });
  if (error) throw new Error(error.message ?? "comment-manager request failed");
  if (!data || data.ok === false) {
    throw new Error(data?.reason ?? "comment-manager request failed");
  }
  return data.data as T;
}

export class SupabaseYouTubeCommentsGateway implements YouTubeCommentsGateway {
  async capabilities(accountId: string) {
    return call<Stage4CapabilitiesPayload>({ action: "youtube_stage4_capabilities", social_account_id: accountId });
  }
  async videoPage(accountId: string, cursor?: string | null) {
    return call<Stage4VideoPagePayload>({ action: "youtube_video_page", social_account_id: accountId, cursor: cursor ?? undefined });
  }
  async threadPage(params: { accountId: string; videoId: string; list: "published" | "heldForReview"; cursor?: string | null }) {
    return call<Stage4ThreadPagePayload>({ action: "youtube_thread_page", social_account_id: params.accountId, video_id: params.videoId, list: params.list, cursor: params.cursor ?? undefined });
  }
  async replyPage(params: { accountId: string; parentHandle: string; cursor?: string | null }) {
    return call<Stage4ReplyPagePayload>({ action: "youtube_reply_page", social_account_id: params.accountId, parent_handle: params.parentHandle, cursor: params.cursor ?? undefined });
  }
  async createThread(params: { accountId: string; videoId: string; text: string; operationId: string }) {
    return call<Stage4ReceiptPayload>({ action: "youtube_create_thread", social_account_id: params.accountId, video_id: params.videoId, text: params.text, operation_id: params.operationId });
  }
  async reply(params: { accountId: string; targetHandle: string; text: string; operationId: string }) {
    return call<Stage4ReceiptPayload>({ action: "youtube_reply", social_account_id: params.accountId, target_handle: params.targetHandle, text: params.text, operation_id: params.operationId });
  }
  async edit(params: { accountId: string; targetHandle: string; text: string; operationId: string }) {
    return call<Stage4ReceiptPayload>({ action: "youtube_edit_comment", social_account_id: params.accountId, target_handle: params.targetHandle, text: params.text, operation_id: params.operationId });
  }
  async banConfirmation(params: { accountId: string; targetHandle: string; operationId: string }) {
    return call<Stage4BanConfirmationPayload>({ action: "youtube_ban_confirmation", social_account_id: params.accountId, target_handle: params.targetHandle, operation_id: params.operationId });
  }
  async moderate(params: { accountId: string; targetHandle: string; status: "published" | "heldForReview" | "rejected"; operationId: string; banConfirmation?: string }) {
    return call<Stage4ReceiptPayload>({ action: "youtube_moderate_comment", social_account_id: params.accountId, target_handle: params.targetHandle, status: params.status, operation_id: params.operationId, ban_confirmation: params.banConfirmation });
  }
  async operationStatus(params: { accountId: string; operationId: string }) {
    return call<Stage4OperationStatusPayload>({ action: "youtube_operation_status", social_account_id: params.accountId, operation_id: params.operationId });
  }
}

export const defaultYouTubeCommentsGateway = new SupabaseYouTubeCommentsGateway();
