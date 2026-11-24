import { supabase } from "@/integrations/supabase/client";
import type { YouTubeCommentsGateway } from "../application/ports";
import { YouTubeCommentsError } from "../domain/errors";
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

/** The `reason` of a handler refusal carried by a FunctionsHttpError, or null. */
export async function reasonFromHttpError(error: unknown): Promise<string | null> {
  const context = (error as { context?: unknown } | null)?.context;
  if (!context || typeof (context as Response).clone !== "function") return null;
  try {
    const body = await (context as Response).clone().json() as { reason?: unknown } | null;
    return typeof body?.reason === "string" && /^[a-z_]{1,64}$/.test(body.reason) ? body.reason : null;
  } catch {
    return null;
  }
}

async function call<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("comment-manager", {
    body,
    timeout: TIMEOUT_MS,
  });
  if (error) {
    // A non-2xx answer arrives as FunctionsHttpError with the Response in
    // `context`; the handler's `{ ok: false, reason }` body is the ONLY place
    // the stable reason (scope_missing, quota, recently_posted, not_found, ...)
    // exists. Reading it keeps a temporary failure from being mistaken for a
    // rebind and keeps each refusal's own copy. A transport error with no
    // body stays `upstream`.
    throw new YouTubeCommentsError((await reasonFromHttpError(error)) ?? "upstream", error.message ?? "comment-manager request failed");
  }
  if (!data) throw new YouTubeCommentsError("upstream");
  // An old backend answers the legacy shape ({error: "Unknown action: ..."}),
  // which must read as "not available here", never as a crash.
  if (typeof data.error === "string") throw new YouTubeCommentsError("not_found", data.error);
  if (data.ok === false) {
    throw new YouTubeCommentsError(typeof data.reason === "string" ? data.reason : "upstream");
  }
  return data.data as T;
}

export class SupabaseYouTubeCommentsGateway implements YouTubeCommentsGateway {
  async capabilities(accountId: string) {
    const payload = await call<Stage4CapabilitiesPayload>({ action: "youtube_stage4_capabilities", social_account_id: accountId });
    // A payload that says the settings could not be read is an ERROR, not a
    // denial: an older server answered a failed settings read as data, and a
    // denial would unmount a screen the owner is using. The reason is
    // `settings_unavailable`, the same one the current server names in its
    // 503, so both shapes read alike.
    if (Object.values(payload?.capabilities ?? {}).some((entry) => entry?.reason === "settings_unavailable")) {
      throw new YouTubeCommentsError("settings_unavailable", "rollout settings unreadable");
    }
    return payload;
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
  async deleteOwnComment(params: { accountId: string; commentId: string }): Promise<void> {
    const { data, error } = await supabase.functions.invoke("comment-manager", {
      body: { action: "delete_comment", comment_id: params.commentId, social_account_id: params.accountId },
      timeout: TIMEOUT_MS,
    });
    if (error) throw new YouTubeCommentsError((await reasonFromHttpError(error)) ?? "upstream", error.message);
    if (!data || data.success !== true) {
      const message = typeof data?.error === "string" ? data.error : data?.error?.message;
      throw new YouTubeCommentsError("upstream", typeof message === "string" ? message : "delete failed");
    }
  }

  async operationStatus(params: { accountId: string; operationId: string; text?: string }) {
    return call<Stage4OperationStatusPayload>({ action: "youtube_operation_status", social_account_id: params.accountId, operation_id: params.operationId, text: params.text });
  }
}

export const defaultYouTubeCommentsGateway = new SupabaseYouTubeCommentsGateway();
