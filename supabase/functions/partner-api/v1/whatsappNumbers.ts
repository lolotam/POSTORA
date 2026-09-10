// Read-only WhatsApp number routes: entitlement, binding, use-case, render.
// withPartnerAuth writes a usage row for every response, including refusals.

import { v1ErrorResponse } from "./errors.ts";
import { v1JsonResponse } from "./respond.ts";
import { boundAccountIds } from "./binding.ts";
import { readPageRequest } from "./pagination.ts";
import { assertEntitled } from "../../_shared/partnerEntitlement.ts";
import { getWhatsAppNumber, listWhatsAppNumbers } from "../../_shared/whatsappNumberOps.ts";
import type { V1AuthedContext } from "./authenticated.ts";

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
