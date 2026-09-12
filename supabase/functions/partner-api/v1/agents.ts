// withPartnerAuth records every refusal in partner_api_usage.
import { assertEntitled } from "../../_shared/partnerEntitlement.ts";
import { claimIdempotency, completeIdempotency, hashRequest, markIndeterminate } from "../../_shared/partnerApiIdempotency.ts";
import { agentInput, createHumanAgent, deleteHumanAgent, getHumanAgent, HumanAgentOpError, listHumanAgents, updateHumanAgent, type HumanAgentContext } from "../../_shared/humanAgentOps.ts";
import type { V1AuthedContext } from "./authenticated.ts";
import { decodeId } from "./ids.ts";
import { v1ErrorResponse } from "./errors.ts";
import { readPageRequest } from "./pagination.ts";
import { v1JsonResponse } from "./respond.ts";
import { loadBoundConversation } from "./conversations.ts";
import type { ModeConversation } from "./conversationModes.ts";
import { assignmentInput, getConversationAssignment, listAssignmentHistory, writeConversationAssignment } from "./conversationAssignments.ts";

function context(authed: V1AuthedContext): HumanAgentContext {
  return { admin: authed.admin, workspaceId: authed.record.workspaceId, requestId: authed.requestId };
}
function failure(error: unknown, requestId: string) {
  return error instanceof HumanAgentOpError
    ? v1ErrorResponse(error.code, requestId, { message: error.message, status: error.status })
    : v1ErrorResponse("internal_error", requestId);
}
async function readAgents(req: Request, authed: V1AuthedContext, id?: string) {
  const denied = await assertEntitled(authed.admin, authed.record.workspaceId, id === undefined ? "list_agents" : "get_agent", authed.requestId);
  if (denied) return denied;
  try {
    const ctx = context(authed);
    if (id !== undefined) return v1JsonResponse({ ...await getHumanAgent(ctx, id), request_id: authed.requestId }, authed.requestId);
    const page = readPageRequest(req, authed.requestId);
    if (!page.ok) return page.res;
    return v1JsonResponse({ ...await listHumanAgents(ctx, page.page), request_id: authed.requestId }, authed.requestId);
  } catch (error) { return failure(error, authed.requestId); }
}
type WriteAction = "create_agent" | "update_agent" | "delete_agent" | "assign_conversation" | "unassign_conversation";
async function identityAttemptId(keyId: string, key: string): Promise<string> {
  // A lease takeover changes its attempt token. Keep the Auth email stable
  // across that takeover so a process death cannot mint a second identity.
  // UUIDv8: custom SHA-256 payload, version and variant bits pinned.
  const hash = await hashRequest({ keyId, idempotencyKey: key });
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
async function agentWrite(req: Request, authed: V1AuthedContext, action: WriteAction, id?: string) {
  const { admin, record, requestId } = authed;
  const denied = await assertEntitled(admin, record.workspaceId, action, requestId);
  if (denied) return denied;
  try {
    const assignment = action === "assign_conversation" || action === "unassign_conversation";
    let conversation: ModeConversation | undefined;
    if (assignment) {
      // Prove the current binding even for a replay, as the mode sibling does.
      const loaded = await loadBoundConversation(authed, id ?? "");
      if (!loaded.ok) return loaded.res;
      conversation = loaded.row;
    } else if (id !== undefined && !decodeId("agent", id)) return v1ErrorResponse("resource_not_found", requestId);
    const key = req.headers.get("idempotency-key")?.trim();
    if (!key) return v1ErrorResponse("missing_idempotency_key", requestId);
    let body: unknown;
    try { const raw = await req.text(); body = raw ? JSON.parse(raw) : {}; }
    catch { return v1ErrorResponse("invalid_request", requestId); }
    if (assignment) assignmentInput(body, action === "unassign_conversation");
    else if (action === "delete_agent") {
      if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).length) return v1ErrorResponse("invalid_request", requestId);
    } else agentInput(body, action === "create_agent");
    // Include workspace authority, resource and every submitted field. A replay
    // is resolved before any Auth call (and before a deleted resource lookup).
    const claim = await claimIdempotency(admin, record.id, key, await hashRequest({ action, id, workspaceId: record.workspaceId, body,
      ...(conversation ? { accountId: conversation.social_account_id, owner: conversation.user_id, conversationKey: conversation.conversation_id, platform: conversation.platform } : {}),
    }));
    switch (claim.outcome) {
      case "replay": {
        const response = v1JsonResponse(claim.body, requestId, claim.httpStatus);
        response.headers.set("Idempotency-Replayed", "true"); return response;
      }
      case "conflict": return v1ErrorResponse("idempotency_conflict", requestId);
      case "in_progress": return v1ErrorResponse("idempotency_in_progress", requestId);
      case "indeterminate": return v1ErrorResponse("idempotency_indeterminate", requestId);
      case "claimed": break;
    }
    try {
      let response: Response;
      try {
        const ctx = context(authed);
        const result = assignment ? await writeConversationAssignment(ctx, record.id, conversation!, body, action === "unassign_conversation")
          : action === "create_agent" ? await createHumanAgent(ctx, body, await identityAttemptId(record.id, key))
          : action === "update_agent" ? await updateHumanAgent(ctx, id!, body) : await deleteHumanAgent(ctx, id!);
        response = v1JsonResponse({ ...result, request_id: requestId }, requestId, action === "create_agent" ? 201 : 200);
      } catch (error) {
        if (!(error instanceof HumanAgentOpError)) throw error;
        response = failure(error, requestId);
      }
      await completeIdempotency(admin, record.id, key, claim.attemptToken, response.status, await response.clone().json());
      return response;
    } catch {
      try { await markIndeterminate(admin, record.id, key, claim.attemptToken); }
      catch { console.error(`[partner-api] agent idempotency persistence failed (request ${requestId})`); }
      return v1ErrorResponse("idempotency_indeterminate", requestId);
    }
  } catch (error) { return failure(error, requestId); }
}
export const listAgentsRoute = (req: Request, authed: V1AuthedContext) => readAgents(req, authed);
export const getAgentRoute = (req: Request, authed: V1AuthedContext, params: Record<string, string>) => readAgents(req, authed, params.id);
export const createAgentRoute = (req: Request, authed: V1AuthedContext) => agentWrite(req, authed, "create_agent");
export const updateAgentRoute = (req: Request, authed: V1AuthedContext, params: Record<string, string>) => agentWrite(req, authed, "update_agent", params.id);
export const deleteAgentRoute = (req: Request, authed: V1AuthedContext, params: Record<string, string>) => agentWrite(req, authed, "delete_agent", params.id);

async function readAssignment(req: Request, authed: V1AuthedContext, action: "get_assignment" | "list_assignment_history", id: string) {
  const denied = await assertEntitled(authed.admin, authed.record.workspaceId, action, authed.requestId);
  if (denied) return denied;
  try {
    const loaded = await loadBoundConversation(authed, id);
    if (!loaded.ok) return loaded.res;
    const ctx = context(authed);
    if (action === "get_assignment") return v1JsonResponse({ ...await getConversationAssignment(ctx, loaded.row), request_id: authed.requestId }, authed.requestId);
    const page = readPageRequest(req, authed.requestId);
    if (!page.ok) return page.res;
    return v1JsonResponse({ ...await listAssignmentHistory(ctx, loaded.row, page.page), request_id: authed.requestId }, authed.requestId);
  } catch (error) { return failure(error, authed.requestId); }
}
export const getAssignmentRoute = (req: Request, authed: V1AuthedContext, params: Record<string, string>) => readAssignment(req, authed, "get_assignment", params.id);
export const listAssignmentHistoryRoute = (req: Request, authed: V1AuthedContext, params: Record<string, string>) => readAssignment(req, authed, "list_assignment_history", params.id);
export const assignConversationRoute = (req: Request, authed: V1AuthedContext, params: Record<string, string>) => agentWrite(req, authed, "assign_conversation", params.id);
export const unassignConversationRoute = (req: Request, authed: V1AuthedContext, params: Record<string, string>) => agentWrite(req, authed, "unassign_conversation", params.id);
