// WhatsApp number routes: entitlement, binding, use-case, render.
// withPartnerAuth writes a usage row for every response, including refusals.

import { v1ErrorResponse, type V1ErrorCode } from "./errors.ts";
import { v1JsonResponse } from "./respond.ts";
import { boundAccountIds } from "./binding.ts";
import { readPageRequest } from "./pagination.ts";
import { assertEntitled } from "../../_shared/partnerEntitlement.ts";
import { getWhatsAppNumber, listWhatsAppNumbers } from "../../_shared/whatsappNumberOps.ts";
import type { V1AuthedContext } from "./authenticated.ts";
import { endSession, historySyncStatus, pairingStatus, registerNumber, startPairing } from "../../_shared/whatsappPairingOps.ts";
import { WhatsAppOpError } from "../../_shared/whatsappPartnerOps.ts";
import { claimIdempotency, completeIdempotency, hashRequest, markIndeterminate } from "../../_shared/partnerApiIdempotency.ts";

export async function listNumbers(
  req: Request,
  authed: V1AuthedContext,
  _params: Record<string, string>,
): Promise<Response> {
  const { admin, record, requestId } = authed;
  const denied = await assertEntitled(admin, record.workspaceId, "list_whatsapp_numbers", requestId);
  if (denied) return denied;
  const bound = await boundAccountIds(authed);
  if (!bound.ok) return bound.res;
  const page = readPageRequest(req, requestId);
  if (!page.ok) return page.res;

  const result = await listWhatsAppNumbers({
    admin, workspaceId: record.workspaceId, accountIds: bound.ids, requestId,
  }, page.page);
  if (!result.ok) return v1ErrorResponse("internal_error", requestId);
  return v1JsonResponse({
    data: result.numbers, next_cursor: result.nextCursor, request_id: requestId,
  }, requestId);
}

export async function getNumber(
  _req: Request,
  authed: V1AuthedContext,
  params: Record<string, string>,
): Promise<Response> {
  const { admin, record, requestId } = authed;
  const denied = await assertEntitled(admin, record.workspaceId, "get_whatsapp_number", requestId);
  if (denied) return denied;
  const bound = await boundAccountIds(authed);
  if (!bound.ok) return bound.res;

  const result = await getWhatsAppNumber({
    admin, workspaceId: record.workspaceId, accountIds: bound.ids, requestId,
  }, params.id);
  if (!result.ok) {
    return v1ErrorResponse(result.reason === "not_found" ? "resource_not_found" : "internal_error", requestId);
  }
  return v1JsonResponse({ ...result.number, request_id: requestId }, requestId);
}

// Number writes use the same claim/settle cycle. The action and account are part
// of the hash because keys share one idempotency namespace across routes.
async function numberWrite(
  req: Request,
  authed: V1AuthedContext,
  target: { action: string; accountId?: string },
  execute: (body: Record<string, unknown>) => Promise<Response>,
): Promise<Response> {
  const { admin, record, requestId } = authed;
  const key = req.headers.get("idempotency-key")?.trim();
  if (!key) return v1ErrorResponse("missing_idempotency_key", requestId);
  let body: Record<string, unknown>;
  try {
    const raw = await req.text();
    const emptyNumberBody = raw.length === 0 && target.accountId !== undefined;
    const parsed: unknown = emptyNumberBody ? {} : JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
    body = parsed as Record<string, unknown>;
  } catch {
    return v1ErrorResponse("invalid_request", requestId, { message: "body must be a JSON object" });
  }
  const claim = await claimIdempotency(admin, record.id, key, await hashRequest({ ...target, body }));
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
      response = await execute(body);
    } catch (error) {
      if (!(error instanceof WhatsAppOpError) || error.indeterminate) throw error;
      response = pairingError(error, requestId);
    }
    // Keep the six-argument API: the attempt token fences a stale claimant.
    await completeIdempotency(admin, record.id, key, claim.attemptToken, response.status, await response.clone().json());
    return response;
  } catch {
    // Includes a failed settlement after a successful write. Never advertise a
    // safe retry when the database/provider may already have committed.
    try {
      await markIndeterminate(admin, record.id, key, claim.attemptToken);
    } catch {
      console.error(`[partner-api] number write indeterminate persistence failed (request ${requestId})`);
    }
    return v1ErrorResponse("idempotency_indeterminate", requestId);
  }
}

function pairingError(error: WhatsAppOpError, requestId: string): Response {
  return v1ErrorResponse(error.code as V1ErrorCode, requestId, {
    message: error.message, status: error.status,
  });
}

export async function registerNumberRoute(req: Request, authed: V1AuthedContext, _params: Record<string, string>): Promise<Response> {
  const { admin, record, requestId } = authed;
  const denied = await assertEntitled(admin, record.workspaceId, "register_whatsapp_number", requestId);
  if (denied) return denied;
  return await numberWrite(req, authed, { action: "register_whatsapp_number" }, async (body) => {
    const result = await registerNumber({ admin, workspaceId: record.workspaceId,
      keyId: record.id, accountIds: [], requestId }, body);
    if (!result.ok) {
      if (result.reason === "write_failed") throw new WhatsAppOpError("Registration outcome unknown", "internal_error", 500, undefined, true);
      return v1ErrorResponse(result.reason, requestId, { message: result.message });
    }
    return v1JsonResponse({ account_id: result.accountId, connection_mode: "evolution_qr", status: "pending", request_id: requestId }, requestId, 201);
  });
}

export async function startPairingRoute(req: Request, authed: V1AuthedContext, params: Record<string, string>): Promise<Response> {
  const { admin, record, requestId } = authed;
  const denied = await assertEntitled(admin, record.workspaceId, "create_whatsapp_pairing", requestId);
  if (denied) return denied;
  return await numberWrite(req, authed, { action: "create_whatsapp_pairing", accountId: params.id }, async (body) => {
    if (Object.keys(body).length) return v1ErrorResponse("invalid_request", requestId, { message: "Pairing takes an empty body" });
    const bound = await boundAccountIds(authed);
    if (!bound.ok) return bound.res;
    const result = await startPairing({ admin, workspaceId: record.workspaceId, accountIds: bound.ids, requestId }, params.id);
    return v1JsonResponse({ ...result, request_id: requestId }, requestId);
  });
}

export async function pairingStatusRoute(_req: Request, authed: V1AuthedContext, params: Record<string, string>): Promise<Response> {
  const { admin, record, requestId } = authed;
  const denied = await assertEntitled(admin, record.workspaceId, "get_whatsapp_pairing", requestId);
  if (denied) return denied;
  const bound = await boundAccountIds(authed);
  if (!bound.ok) return bound.res;
  try {
    const result = await pairingStatus({ admin, workspaceId: record.workspaceId, accountIds: bound.ids, requestId }, params.id);
    return v1JsonResponse({ ...result, request_id: requestId }, requestId);
  } catch (error) {
    return error instanceof WhatsAppOpError ? pairingError(error, requestId) : v1ErrorResponse("internal_error", requestId);
  }
}

export async function endSessionRoute(
  req: Request, authed: V1AuthedContext, params: Record<string, string>,
  deps: Parameters<typeof endSession>[2] = {},
): Promise<Response> {
  const { admin, record, requestId } = authed;
  const denied = await assertEntitled(admin, record.workspaceId, "end_whatsapp_session", requestId);
  if (denied) return denied;
  return await numberWrite(req, authed, { action: "end_whatsapp_session", accountId: params.id }, async (body) => {
    if (Object.keys(body).length) return v1ErrorResponse("invalid_request", requestId, { message: "Session end takes an empty body" });
    const bound = await boundAccountIds(authed);
    if (!bound.ok) return bound.res;
    const result = await endSession({ admin, workspaceId: record.workspaceId, accountIds: bound.ids, requestId }, params.id, deps);
    return v1JsonResponse({ ...result, request_id: requestId }, requestId);
  });
}

export async function historySyncStatusRoute(_req: Request, authed: V1AuthedContext, params: Record<string, string>): Promise<Response> {
  const { admin, record, requestId } = authed;
  const denied = await assertEntitled(admin, record.workspaceId, "get_whatsapp_history_sync", requestId);
  if (denied) return denied;
  const bound = await boundAccountIds(authed);
  if (!bound.ok) return bound.res;
  try {
    const result = await historySyncStatus({ admin, workspaceId: record.workspaceId, accountIds: bound.ids, requestId }, params.id);
    return v1JsonResponse({ ...result, request_id: requestId }, requestId);
  } catch (error) {
    return error instanceof WhatsAppOpError ? pairingError(error, requestId) : v1ErrorResponse("internal_error", requestId);
  }
}
