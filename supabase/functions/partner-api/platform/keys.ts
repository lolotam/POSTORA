// deno-lint-ignore no-import-prefix
import { z } from "npm:zod@3.23.8";
import { doorEnvironment, generatePartnerKey } from "../../_shared/partnerApiKeys.ts";
import { GENERIC_SCOPES } from "../../_shared/partnerScopes.ts";
import { v1ErrorResponse, type V1ErrorCode } from "../v1/errors.ts";
import { v1JsonResponse } from "../v1/respond.ts";
import type { PlatformAuthedContext } from "./authenticated.ts";

const issueSchema = z.object({
  name: z.string().trim().min(1).max(200),
  account_id: z.string().uuid(),
  scopes: z.array(z.string().refine(
    (scope) => !scope.startsWith("platform:") && (GENERIC_SCOPES as readonly string[]).includes(scope),
    "scopes must contain only recognised workspace scopes; platform scopes are forbidden",
  )).min(1),
});

function refuse(requestId: string, code: V1ErrorCode, message?: string): Response {
  console.warn(`[partner-api] platform key request refused (request ${requestId}): ${code}`);
  return v1ErrorResponse(code, requestId, { message });
}

export async function issueWorkspaceKey(
  req: Request,
  { admin, record, requestId }: PlatformAuthedContext,
  params: Record<string, string>,
): Promise<Response> {
  if (!z.string().uuid().safeParse(params.id).success) return refuse(requestId, "resource_not_found");
  const parsed = issueSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return refuse(requestId, "invalid_request", parsed.error.issues[0].message);
  const { name, account_id: accountId, scopes } = parsed.data;
  const environment = doorEnvironment();
  const secret = await generatePartnerKey(environment);
  // Ownership, account binding and audit must commit together. service_role
  // cannot UPDATE/DELETE partner_api_keys to compensate for partial writes.
  const { data: keyId, error } = await admin.rpc("issue_partner_key_in_estate", {
    p_principal_id: record.principalId,
    p_workspace_id: params.id,
    p_social_account_id: accountId,
    p_key_name: name,
    p_key_prefix: secret.prefix,
    p_key_hash: secret.hash,
    p_scopes: scopes,
    p_environment: environment,
    p_platform_key_id: record.id,
    p_request_id: requestId,
  });
  if (error) return refuse(requestId, error.code === "P0002" ? "resource_not_found" : "internal_error");
  if (typeof keyId !== "string") return refuse(requestId, "internal_error");
  const response = v1JsonResponse({
    id: keyId, key: secret.key, key_prefix: secret.prefix, scopes,
    workspace_id: params.id, account_id: accountId, request_id: requestId,
  }, requestId, 201);
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export async function revokeWorkspaceKey(
  _req: Request,
  { admin, record, requestId, rateHeaders }: PlatformAuthedContext,
  params: Record<string, string>,
): Promise<Response> {
  if (!z.string().uuid().safeParse(params.id).success) return refuse(requestId, "resource_not_found");
  const { data: revoked, error } = await admin.rpc("revoke_partner_key_in_estate", {
    p_principal_id: record.principalId,
    p_key_id: params.id,
    p_reason: "revoked via platform API",
    p_platform_key_id: record.id,
    p_request_id: requestId,
  });
  if (error) return refuse(requestId, "internal_error");
  if (revoked !== true) return refuse(requestId, "resource_not_found");
  return new Response(null, {
    status: 204,
    headers: { ...rateHeaders, "X-Postora-Request-Id": requestId },
  });
}
