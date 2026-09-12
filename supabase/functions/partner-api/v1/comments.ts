// Entitlement precedes target resolution. withPartnerAuth records every refusal
// in partner_api_usage, including failures caught below.
import { assertEntitled } from "../../_shared/partnerEntitlement.ts";
import { deleteComment, hideComment, replyToComment } from "../../_shared/commentActions.ts";
import { COMMENT_PLATFORMS, CommentOpError, getComment, listComments, requireCommentCapability, resolveComment, youtubeDeps, type CommentContext, type CommentDeps } from "../../_shared/commentOps.ts";
import { claimIdempotency, completeIdempotency, hashRequest, markIndeterminate } from "../../_shared/partnerApiIdempotency.ts";
import type { V1AuthedContext } from "./authenticated.ts";
import { boundAccountIds } from "./binding.ts";
import { v1ErrorResponse } from "./errors.ts";
import { v1JsonResponse } from "./respond.ts";

function failure(error: unknown, requestId: string): Response {
  return v1ErrorResponse(error instanceof CommentOpError ? error.code : "internal_error", requestId);
}
async function context(authed: V1AuthedContext): Promise<CommentContext | Response> {
  const bound = await boundAccountIds(authed);
  if (!bound.ok) return bound.res;
  return { admin: authed.admin, workspaceId: authed.record.workspaceId, accountIds: bound.ids, requestId: authed.requestId };
}
export async function listCommentsRoute(req: Request, authed: V1AuthedContext, _params: Record<string, string>, deps: CommentDeps = {}): Promise<Response> {
  const denied = await assertEntitled(authed.admin, authed.record.workspaceId, "list_comments", authed.requestId);
  if (denied) return denied;
  try {
    const ctx = await context(authed);
    if (ctx instanceof Response) return ctx;
    const query = new URL(req.url).searchParams;
    const platform = query.get("platform") ?? undefined;
    if (platform && !COMMENT_PLATFORMS.includes(platform)) throw new CommentOpError("unsupported_capability");
    const entitledPlatforms: string[] = [];
    let refusal: Response | null = null;
    for (const candidate of platform ? [platform] : COMMENT_PLATFORMS) {
      const denied = await assertEntitled(authed.admin, authed.record.workspaceId, "list_comments", authed.requestId, candidate);
      if (!denied) entitledPlatforms.push(candidate);
      else if (denied.status === 403) refusal = denied;
      else return denied; // A failed flag read must never look like a disabled flag.
    }
    if (!entitledPlatforms.length) return refusal!;
    const result = await listComments({ ...ctx, entitledPlatforms }, req, {
      platform: query.get("platform") ?? undefined,
      postId: query.get("post_id") ?? undefined,
      accountId: query.get("account_id") ?? undefined,
    }, deps);
    return v1JsonResponse({ ...result, request_id: authed.requestId }, authed.requestId);
  } catch (error) { return failure(error, authed.requestId); }
}
export async function getCommentRoute(_req: Request, authed: V1AuthedContext, params: Record<string, string>, deps: CommentDeps = {}): Promise<Response> {
  const denied = await assertEntitled(authed.admin, authed.record.workspaceId, "get_comment", authed.requestId);
  if (denied) return denied;
  try {
    const ctx = await context(authed);
    if (ctx instanceof Response) return ctx;
    const resolved = await resolveComment(ctx, params.id, deps);
    const platformDenied = await assertEntitled(authed.admin, authed.record.workspaceId, "get_comment", authed.requestId, resolved.account.platform);
    if (platformDenied) return platformDenied;
    const result = await getComment(ctx, params.id, deps, resolved);
    return v1JsonResponse({ ...result, request_id: authed.requestId }, authed.requestId);
  } catch (error) { return failure(error, authed.requestId); }
}

type WriteAction = "reply_comment" | "hide_comment" | "delete_comment";
async function commentWrite(req: Request, authed: V1AuthedContext, target: { id: string; action: WriteAction }, deps: CommentDeps): Promise<Response> {
  const { admin, record, requestId } = authed;
  const denied = await assertEntitled(admin, record.workspaceId, target.action, requestId);
  if (denied) return denied;
  try {
    const ctx = await context(authed);
    if (ctx instanceof Response) return ctx;
    // Replays still honor current binding, workspace, and platform capability.
    const resolved = await resolveComment(ctx, target.id, deps);
    const platformDenied = await assertEntitled(admin, record.workspaceId, target.action, requestId, resolved.account.platform);
    if (platformDenied) return platformDenied;
    requireCommentCapability(resolved.account, target.action);
    const key = req.headers.get("idempotency-key")?.trim();
    if (!key) return v1ErrorResponse("missing_idempotency_key", requestId);
    let body: Record<string, unknown>;
    try {
      const text = await req.text();
      const parsed = text ? JSON.parse(text) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      body = parsed;
    } catch { return v1ErrorResponse("invalid_request", requestId); }
    const allowed = target.action === "reply_comment" ? ["message"] : target.action === "hide_comment" ? ["hidden"] : [];
    if (Object.keys(body).some((field) => !allowed.includes(field)) ||
      (target.action === "reply_comment" && (typeof body.message !== "string" || !body.message.trim())) ||
      (target.action === "hide_comment" && body.hidden !== undefined && typeof body.hidden !== "boolean")) {
      return v1ErrorResponse("invalid_request", requestId);
    }
    const claim = await claimIdempotency(admin, record.id, key, await hashRequest({ ...target, accountId: resolved.account.id, body }));
    switch (claim.outcome) {
      case "replay": {
        const response = v1JsonResponse(claim.body, requestId, claim.httpStatus);
        response.headers.set("Idempotency-Replayed", "true");
        return response;
      }
      case "conflict": return v1ErrorResponse("idempotency_conflict", requestId);
      case "in_progress": return v1ErrorResponse("idempotency_in_progress", requestId);
      case "indeterminate": return v1ErrorResponse("idempotency_indeterminate", requestId);
      case "claimed": break;
    }
    try {
      const { account, target: comment } = resolved;
      const yt = account.platform === "youtube" ? youtubeDeps(ctx, deps) : undefined;
      const fetcher = deps.fetcher ?? fetch;
      const result = target.action === "reply_comment"
        ? await replyToComment(account, comment.comment, body.message as string, fetcher, yt)
        : target.action === "hide_comment"
        ? await hideComment(account, comment.comment, body.hidden !== false, fetcher, yt)
        : await deleteComment(account, comment.comment, fetcher, yt);
      // CommentActionResult doesn't retain enough status/body evidence to prove
      // every provider rejection safe to retry. Conservatively fence failures,
      // including 5xx, malformed JSON, timeout and failed settlement.
      if (!result.success || (target.action === "reply_comment" && (!result.platform_comment_id || result.platform_comment_id === "undefined"))) throw new Error("Unknown provider outcome");
      const response = v1JsonResponse({ success: true, platform_comment_id: result.platform_comment_id, request_id: requestId }, requestId);
      await completeIdempotency(admin, record.id, key, claim.attemptToken, response.status, await response.clone().json());
      return response;
    } catch {
      try { await markIndeterminate(admin, record.id, key, claim.attemptToken); }
      catch { console.error(`[partner-api] comment idempotency persistence failed (request ${requestId})`); }
      return v1ErrorResponse("idempotency_indeterminate", requestId);
    }
  } catch (error) { return failure(error, requestId); }
}
export function replyCommentRoute(req: Request, authed: V1AuthedContext, params: Record<string, string>, deps: CommentDeps = {}) {
  return commentWrite(req, authed, { id: params.id, action: "reply_comment" }, deps);
}
export function hideCommentRoute(req: Request, authed: V1AuthedContext, params: Record<string, string>, deps: CommentDeps = {}) {
  return commentWrite(req, authed, { id: params.id, action: "hide_comment" }, deps);
}
export function deleteCommentRoute(req: Request, authed: V1AuthedContext, params: Record<string, string>, deps: CommentDeps = {}) {
  return commentWrite(req, authed, { id: params.id, action: "delete_comment" }, deps);
}
