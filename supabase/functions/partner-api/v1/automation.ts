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

type WriteAction = "update_agent_config" | "upsert_agent_tool" | "delete_agent_tool" | "set_tool_accounts" | "set_automation_handlers";
async function automationWrite(req: Request, authed: V1AuthedContext, action: WriteAction, id?: string): Promise<Response> {
  const { admin, record, requestId } = authed;
  const denied = await assertEntitled(admin, record.workspaceId, action, requestId, platform(req));
  if (denied) return denied;
  try {
    const ctx = await context(req, authed);
    if (ctx instanceof Response) return ctx;
    const requested = requestedAccount(req);
    // Every account selector is checked before a claim, including replays.
    let accountId: string | null = requested;
    if (action === "update_agent_config" || action === "upsert_agent_tool" || action === "set_automation_handlers") {
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
    if (action === "delete_agent_tool" && Object.keys(body).length) return v1ErrorResponse("invalid_request", requestId);
    let sharingTargets: string[] = [];
    if (action === "set_tool_accounts") {
      const input = parseSetToolAccountsInput({ ...body, tool_id: id });
      if (input.socialAccountIds.some((target) => !ctx.accountIds.includes(target))) return v1ErrorResponse("resource_not_found", requestId);
      sharingTargets = input.socialAccountIds;
    }
    if (id) {
      const affectedPlatforms = await agentToolAffectedPlatforms(ctx, id, accountId, sharingTargets);
      for (const affectedPlatform of affectedPlatforms.filter((value) => value !== ctx.platform)) {
        const affectedDenied = await assertEntitled(admin, record.workspaceId, action, requestId, affectedPlatform);
        if (affectedDenied) return affectedDenied;
      }
    }
    // Include the binding: a replay cannot reuse a result after its authority
    // changes. All outcome-changing body fields (including confirm_clear and
    // credentials) are hashed, never stored in logs or the idempotency row.
    const claim = await claimIdempotency(admin, record.id, key, await hashRequest({ action, id, accountId, platform: ctx.platform, accountIds: [...ctx.accountIds].sort(), body }));
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
