// Entitlement -> binding -> shared operation -> response. withPartnerAuth
// records every refusal in partner_api_usage, including caught exceptions.
import { assertEntitled } from "../../_shared/partnerEntitlement.ts";
import { agentConfigFailure, agentToolAffectedPlatforms, deleteAgentTool, getAgentConfig, getAutomationHandlers, getAudience, listAgentTools, resolveAgentAccount, setAgentToolAccounts, setAutomationHandlers, updateAgentConfig, upsertAgentTool, validateAudiencePlatform, type AgentConfigContext } from "../../_shared/agentConfigOps.ts";
import { claimIdempotency, completeIdempotency, hashRequest, markIndeterminate } from "../../_shared/partnerApiIdempotency.ts";
import { parseSetToolAccountsInput } from "../../_shared/toolSharing.ts";
import type { V1AuthedContext } from "./authenticated.ts";
import { boundAccountIds } from "./binding.ts";
import { v1ErrorResponse } from "./errors.ts";
import { v1JsonResponse } from "./respond.ts";
import { readPageRequest } from "./pagination.ts";
import { loadBoundConversation, READABLE_PLATFORM, unreadableConversation } from "./conversations.ts";
import { getConversationMode, listConversationModes, setConversationMode, validateRulePlatform, type ModeConversation } from "./conversationModes.ts";
import { listAutoReplies, writeAutoReply, type AutoReplyOwner } from "./autoReplies.ts";
import { decodeId } from "./ids.ts";

function platform(req: Request): string { return new URL(req.url).searchParams.get("platform") ?? ""; }
function failure(error: unknown, requestId: string): Response {
  const known = agentConfigFailure(error);
  return known ? v1ErrorResponse(known.code, requestId, { message: known.message, status: known.status, details: known.details })
    : v1ErrorResponse("internal_error", requestId);
}
async function context(req: Request, authed: V1AuthedContext): Promise<AgentConfigContext | Response> {
  const query = new URL(req.url).searchParams;
  if (["platform", "account_id"].some((key) => query.getAll(key).length > 1)) return v1ErrorResponse("invalid_request", authed.requestId);
  const bound = await boundAccountIds(authed);
  if (!bound.ok) return bound.res;
  return { admin: authed.admin, workspaceId: authed.record.workspaceId, accountIds: bound.ids, requestId: authed.requestId, platform: platform(req) };
}
function requestedAccount(req: Request) { return new URL(req.url).searchParams.get("account_id"); }

export async function getAgentConfigRoute(req: Request, authed: V1AuthedContext): Promise<Response> {
  const denied = await assertEntitled(authed.admin, authed.record.workspaceId, "get_agent_config", authed.requestId, platform(req));
  if (denied) return denied;
  try {
    const ctx = await context(req, authed);
    if (ctx instanceof Response) return ctx;
    const result = await getAgentConfig(ctx, requestedAccount(req));
    return v1JsonResponse({ ...result, request_id: authed.requestId }, authed.requestId);
  } catch (error) { return failure(error, authed.requestId); }
}
export async function listAgentToolsRoute(req: Request, authed: V1AuthedContext): Promise<Response> {
  const denied = await assertEntitled(authed.admin, authed.record.workspaceId, "list_agent_tools", authed.requestId, platform(req));
  if (denied) return denied;
  try {
    const ctx = await context(req, authed);
    if (ctx instanceof Response) return ctx;
    const page = readPageRequest(req, authed.requestId);
    if (!page.ok) return page.res;
    const result = await listAgentTools(ctx, requestedAccount(req), page.page);
    return v1JsonResponse({ ...result, request_id: authed.requestId }, authed.requestId);
  } catch (error) { return failure(error, authed.requestId); }
}

export async function getAutomationHandlersRoute(req: Request, authed: V1AuthedContext): Promise<Response> {
  const denied = await assertEntitled(authed.admin, authed.record.workspaceId, "get_automation_handlers", authed.requestId, platform(req));
  if (denied) return denied;
  try {
    const ctx = await context(req, authed);
    if (ctx instanceof Response) return ctx;
    const result = await getAutomationHandlers(ctx, requestedAccount(req));
    return v1JsonResponse({ ...result, request_id: authed.requestId }, authed.requestId);
  } catch (error) { return failure(error, authed.requestId); }
}
export async function getAudienceRoute(req: Request, authed: V1AuthedContext): Promise<Response> {
  try { validateAudiencePlatform(platform(req)); }
  catch (error) { return failure(error, authed.requestId); }
  const denied = await assertEntitled(authed.admin, authed.record.workspaceId, "get_audience", authed.requestId, platform(req));
  if (denied) return denied;
  try {
    const ctx = await context(req, authed);
    if (ctx instanceof Response) return ctx;
    const page = readPageRequest(req, authed.requestId);
    if (!page.ok) return page.res;
    const result = await getAudience(ctx, requestedAccount(req), page.page);
    return v1JsonResponse({ ...result, request_id: authed.requestId }, authed.requestId);
  } catch (error) { return failure(error, authed.requestId); }
}

type RuleReadAction = "get_conversation_mode" | "list_conversation_modes" | "list_auto_replies";
function ruleAccount(req: Request): string | null {
  const requested = requestedAccount(req);
  return requested?.startsWith("acc_") ? decodeId("acc", requested) ?? requested : requested;
}
async function ruleRead(req: Request, authed: V1AuthedContext, action: RuleReadAction, id?: string): Promise<Response> {
  const denied = await assertEntitled(authed.admin, authed.record.workspaceId, action, authed.requestId, platform(req));
  if (denied) return denied;
  try {
    validateRulePlatform(platform(req));
    const ctx = await context(req, authed);
    if (ctx instanceof Response) return ctx;
    let result;
    if (action === "get_conversation_mode") {
      const loaded = await loadBoundConversation(authed, id ?? "");
      if (!loaded.ok) return loaded.res;
      if (loaded.row.platform !== ctx.platform || (ruleAccount(req) !== null && ruleAccount(req) !== loaded.row.social_account_id)) return v1ErrorResponse("resource_not_found", authed.requestId);
      result = await getConversationMode(ctx, loaded.row);
    } else {
      const page = readPageRequest(req, authed.requestId);
      if (!page.ok) return page.res;
      if (action === "list_auto_replies") result = await listAutoReplies(ctx, ruleAccount(req), page.page);
      else {
        if (ctx.platform !== READABLE_PLATFORM) return unreadableConversation(authed.requestId);
        const requested = ruleAccount(req);
        const ids = requested === null ? ctx.accountIds : [(await resolveAgentAccount(ctx, requested)).id];
        result = await listConversationModes(ctx, ids, page.page);
      }
    }
    return v1JsonResponse({ ...result, request_id: authed.requestId }, authed.requestId);
  } catch (error) { return failure(error, authed.requestId); }
}
export const getConversationModeRoute = (req: Request, authed: V1AuthedContext, params: Record<string, string>) => ruleRead(req, authed, "get_conversation_mode", params.id);
export const listConversationModesRoute = (req: Request, authed: V1AuthedContext) => ruleRead(req, authed, "list_conversation_modes");
export const listAutoRepliesRoute = (req: Request, authed: V1AuthedContext) => ruleRead(req, authed, "list_auto_replies");

type WriteAction = "update_agent_config" | "upsert_agent_tool" | "delete_agent_tool" | "set_tool_accounts" | "set_automation_handlers" | "set_conversation_mode" | "create_auto_reply" | "update_auto_reply" | "delete_auto_reply";
async function automationWrite(req: Request, authed: V1AuthedContext, action: WriteAction, id?: string): Promise<Response> {
  const { admin, record, requestId } = authed;
  const denied = await assertEntitled(admin, record.workspaceId, action, requestId, platform(req));
  if (denied) return denied;
  try {
    const autoReply = action === "create_auto_reply" || action === "update_auto_reply" || action === "delete_auto_reply";
    const conversationMode = action === "set_conversation_mode";
    if (autoReply || conversationMode) validateRulePlatform(platform(req));
    const ctx = await context(req, authed);
    if (ctx instanceof Response) return ctx;
    const requested = autoReply || conversationMode ? ruleAccount(req) : requestedAccount(req);
    // Every account selector is checked before a claim, including replays.
    let accountId: string | null = requested;
    let owner: AutoReplyOwner | undefined;
    let conversation: ModeConversation | undefined;
    if (conversationMode) {
      const loaded = await loadBoundConversation(authed, id ?? "");
      if (!loaded.ok) return loaded.res;
      conversation = loaded.row as ModeConversation;
      if (conversation.platform !== ctx.platform || (requested !== null && requested !== conversation.social_account_id)) return v1ErrorResponse("resource_not_found", requestId);
      accountId = conversation.social_account_id;
    } else if (autoReply) {
      owner = await resolveAgentAccount(ctx, requested);
      accountId = owner.id;
    } else if (action === "update_agent_config" || action === "upsert_agent_tool" || action === "set_automation_handlers") {
      accountId = (await resolveAgentAccount(ctx, requested)).id;
    } else if (requested !== null && !ctx.accountIds.includes(requested)) {
      return v1ErrorResponse("resource_not_found", requestId);
    }
    const key = req.headers.get("idempotency-key")?.trim();
    if (!key) return v1ErrorResponse("missing_idempotency_key", requestId);
    let body: Record<string, unknown>;
    try {
      const raw = await req.text();
      const parsed = raw ? JSON.parse(raw) : {};
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      body = parsed;
    } catch { return v1ErrorResponse("invalid_request", requestId); }
    if ((action === "delete_agent_tool" || action === "delete_auto_reply") && Object.keys(body).length) return v1ErrorResponse("invalid_request", requestId);
    let sharingTargets: string[] = [];
    if (action === "set_tool_accounts") {
      const input = parseSetToolAccountsInput({ ...body, tool_id: id });
      if (input.socialAccountIds.some((target) => !ctx.accountIds.includes(target))) return v1ErrorResponse("resource_not_found", requestId);
      sharingTargets = input.socialAccountIds;
    }
    if (id && !autoReply && !conversationMode) {
      const affectedPlatforms = await agentToolAffectedPlatforms(ctx, id, accountId, sharingTargets);
      for (const affectedPlatform of affectedPlatforms.filter((value) => value !== ctx.platform)) {
        const affectedDenied = await assertEntitled(admin, record.workspaceId, action, requestId, affectedPlatform);
        if (affectedDenied) return affectedDenied;
      }
    }
    // Include the binding: a replay cannot reuse a result after its authority
    // changes. All outcome-changing body fields (including confirm_clear and
    // credentials) are hashed, never stored in logs or the idempotency row.
    const claim = await claimIdempotency(admin, record.id, key, await hashRequest({ action, id, accountId, platform: ctx.platform, accountIds: [...ctx.accountIds].sort(), body,
      // Hash private persistence identity, never publish it. An owner/key
      // reassignment must not replay an outcome from the previous identity.
      ...((autoReply || conversationMode) ? { owner: owner?.user_id ?? conversation?.user_id, conversationKey: conversation?.conversation_id } : {}),
    }));
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
      let response: Response;
      try {
        const result = action === "update_agent_config" ? await updateAgentConfig(ctx, accountId, body)
          : action === "set_conversation_mode" ? await setConversationMode(ctx, conversation!, body)
          : action === "create_auto_reply" || action === "update_auto_reply" || action === "delete_auto_reply" ? await writeAutoReply(ctx, owner!, action, id, body)
          : action === "set_automation_handlers" ? await setAutomationHandlers(ctx, accountId, body)
          : action === "upsert_agent_tool" ? await upsertAgentTool(ctx, id!, accountId, body)
          : action === "delete_agent_tool" ? await deleteAgentTool(ctx, id!, accountId)
          : await setAgentToolAccounts(ctx, id!, accountId, body);
        response = v1JsonResponse({ ...result, request_id: requestId }, requestId);
      } catch (error) {
        if (!agentConfigFailure(error)) throw error;
        response = failure(error, requestId);
      }
      await completeIdempotency(admin, record.id, key, claim.attemptToken, response.status, await response.clone().json());
      return response;
    } catch {
      try { await markIndeterminate(admin, record.id, key, claim.attemptToken); }
      catch { console.error(`[partner-api] automation idempotency persistence failed (request ${requestId})`); }
      return v1ErrorResponse("idempotency_indeterminate", requestId);
    }
  } catch (error) { return failure(error, requestId); }
}
export function updateAgentConfigRoute(req: Request, authed: V1AuthedContext) {
  return automationWrite(req, authed, "update_agent_config");
}
export function setAutomationHandlersRoute(req: Request, authed: V1AuthedContext) {
  return automationWrite(req, authed, "set_automation_handlers");
}
export function upsertAgentToolRoute(req: Request, authed: V1AuthedContext, params: Record<string, string>) {
  return automationWrite(req, authed, "upsert_agent_tool", params.id);
}
export function deleteAgentToolRoute(req: Request, authed: V1AuthedContext, params: Record<string, string>) {
  return automationWrite(req, authed, "delete_agent_tool", params.id);
}
export function setToolAccountsRoute(req: Request, authed: V1AuthedContext, params: Record<string, string>) {
  return automationWrite(req, authed, "set_tool_accounts", params.id);
}
export const setConversationModeRoute = (req: Request, authed: V1AuthedContext, params: Record<string, string>) => automationWrite(req, authed, "set_conversation_mode", params.id);
export const createAutoReplyRoute = (req: Request, authed: V1AuthedContext) => automationWrite(req, authed, "create_auto_reply");
export const updateAutoReplyRoute = (req: Request, authed: V1AuthedContext, params: Record<string, string>) => automationWrite(req, authed, "update_auto_reply", params.id);
export const deleteAutoReplyRoute = (req: Request, authed: V1AuthedContext, params: Record<string, string>) => automationWrite(req, authed, "delete_auto_reply", params.id);
