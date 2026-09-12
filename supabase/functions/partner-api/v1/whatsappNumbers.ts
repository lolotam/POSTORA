// WhatsApp number routes: entitlement, binding, use-case, render.
// withPartnerAuth writes a usage row for every response, including refusals.

import { v1ErrorResponse, type V1ErrorCode } from "./errors.ts";
import { v1JsonResponse } from "./respond.ts";
import { boundAccountIds } from "./binding.ts";
import { readPageRequest } from "./pagination.ts";
import { assertEntitled } from "../../_shared/partnerEntitlement.ts";
import { getWhatsAppNumber, listWhatsAppNumbers } from "../../_shared/whatsappNumberOps.ts";
import { resolveWhatsAppAccount, type V1AuthedContext } from "./authenticated.ts";
import { getBusinessProfile, updateBusinessProfile } from "../../_shared/whatsappProfileOps.ts";
import { endSession, historySyncStatus, pairingStatus, registerNumber, resolveNumberContext, startHistorySync, startPairing } from "../../_shared/whatsappPairingOps.ts";
import { WhatsAppOpError } from "../../_shared/whatsappPartnerOps.ts";
import { claimIdempotency, completeIdempotency, hashRequest, markIndeterminate } from "../../_shared/partnerApiIdempotency.ts";

function profileAccount(req: Request, authed: V1AuthedContext, params: Record<string, string>) {
  const queryIds = new URL(req.url).searchParams.getAll("account_id");
  if (queryIds.some((id) => id !== params.id)) {
    return Promise.resolve({ ok: false as const, res: v1ErrorResponse("resource_not_found", authed.requestId) });
  }
  return resolveWhatsAppAccount(authed, params.id);
}

export async function getProfileRoute(req: Request, authed: V1AuthedContext, params: Record<string, string>): Promise<Response> {
  const { admin, record, requestId } = authed;
  const denied = await assertEntitled(admin, record.workspaceId, "get_whatsapp_profile", requestId);
  if (denied) return denied;
  const account = await profileAccount(req, authed, params);
  if (!account.ok) return account.res;
  try {
    const profile = await getBusinessProfile(account.ctx);
    return v1JsonResponse({ ...profile, request_id: requestId }, requestId);
  } catch (error) {
    return error instanceof WhatsAppOpError ? pairingError(error, requestId) : v1ErrorResponse("internal_error", requestId);
  }
}

export async function updateProfileRoute(req: Request, authed: V1AuthedContext, params: Record<string, string>): Promise<Response> {
  const { admin, record, requestId } = authed;
  const denied = await assertEntitled(admin, record.workspaceId, "update_whatsapp_profile", requestId);
  if (denied) return denied;
  return await numberWrite(req, authed, {
    action: "update_whatsapp_profile", accountId: params.id,
    resolve: async () => {
      const account = await profileAccount(req, authed, params);
      return account.ok ? { ok: true as const, value: account.ctx } : account;
    },
  }, async (body, ctx) => {
    const result = await updateBusinessProfile(ctx, body);
    return v1JsonResponse({ ...result, request_id: requestId }, requestId);
  });
}

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
type NumberResolution<T> = { ok: true; value: T } | { ok: false; res: Response };
type NumberWriteTarget<T> = { action: string; accountId?: never } | {
  action: string; accountId: string; resolve: () => Promise<NumberResolution<T>>;
};

async function resolveNumberTarget(authed: V1AuthedContext, accountId: string, action?: string) {
  const { admin, record, requestId } = authed;
  const bound = await boundAccountIds(authed);
  if (!bound.ok) return bound;
  try {
    const value = await resolveNumberContext({ admin, workspaceId: record.workspaceId, accountIds: bound.ids, requestId }, accountId);
    if (action) {
      const denied = await assertEntitled(admin, record.workspaceId, action, requestId, "whatsapp", value.account.connection_mode);
      if (denied) return { ok: false as const, res: denied };
    }
    return { ok: true as const, value };
  } catch (error) {
    return { ok: false as const, res: error instanceof WhatsAppOpError
      ? pairingError(error, requestId) : v1ErrorResponse("internal_error", requestId) };
  }
}

async function numberWrite<T = undefined>(
  req: Request,
  authed: V1AuthedContext,
  target: NumberWriteTarget<T>,
  execute: (body: Record<string, unknown>, resolved: T) => Promise<Response>,
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
  let resolved: T;
  if (target.accountId !== undefined) {
    const result = await target.resolve();
    if (!result.ok) return result.res;
    resolved = result.value;
  }
  const claim = await claimIdempotency(admin, record.id, key, await hashRequest({ action: target.action, accountId: target.accountId, body }));
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
      response = await execute(body, resolved!);
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
  return await numberWrite(req, authed, { action: "create_whatsapp_pairing", accountId: params.id,
    resolve: () => resolveNumberTarget(authed, params.id) }, async (body, ctx) => {
    if (Object.keys(body).length) return v1ErrorResponse("invalid_request", requestId, { message: "Pairing takes an empty body" });
    const result = await startPairing(ctx, params.id);
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
  const { requestId } = authed;
  return await numberWrite(req, authed, { action: "end_whatsapp_session", accountId: params.id,
    resolve: () => resolveNumberTarget(authed, params.id, "end_whatsapp_session") }, async (body, ctx) => {
    if (Object.keys(body).length) return v1ErrorResponse("invalid_request", requestId, { message: "Session end takes an empty body" });
    const result = await endSession(ctx, params.id, deps);
    return v1JsonResponse({ ...result, request_id: requestId }, requestId);
  });
}

export async function historySyncStatusRoute(_req: Request, authed: V1AuthedContext, params: Record<string, string>): Promise<Response> {
  const { requestId } = authed;
  const account = await resolveNumberTarget(authed, params.id, "get_whatsapp_history_sync");
  if (!account.ok) return account.res;
  try {
    const result = await historySyncStatus(account.value, params.id);
    return v1JsonResponse({ ...result, request_id: requestId }, requestId);
  } catch (error) {
    return error instanceof WhatsAppOpError ? pairingError(error, requestId) : v1ErrorResponse("internal_error", requestId);
  }
}

export async function startHistorySyncRoute(
  req: Request, authed: V1AuthedContext, params: Record<string, string>,
): Promise<Response> {
  const { requestId } = authed;
  return await numberWrite(req, authed, { action: "start_whatsapp_history_sync", accountId: params.id,
    resolve: () => resolveNumberTarget(authed, params.id, "start_whatsapp_history_sync") }, async (body, ctx) => {
    if (Object.keys(body).length) return v1ErrorResponse("invalid_request", requestId, { message: "History sync takes an empty body" });
    const result = await startHistorySync(ctx, params.id);
    return v1JsonResponse({ ...result, request_id: requestId }, requestId, 202);
  });
}
