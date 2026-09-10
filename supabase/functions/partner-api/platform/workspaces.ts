// Auth owns identity creation; the provisioning RPC owns all tenant rows.
// Attempts bridge those transactions without storing any plaintext credential.
// deno-lint-ignore no-import-prefix
import { z } from "npm:zod@3.23.8";
import { doorEnvironment, generatePartnerKey } from "../../_shared/partnerApiKeys.ts";
import { FREE_TIER_MAX_SOCIAL_ACCOUNTS } from "../../_shared/socialAccountQuota.ts";
import { v1ErrorResponse, type V1ErrorCode } from "../v1/errors.ts";
import { paginate, readPageRequest } from "../v1/pagination.ts";
import { v1JsonResponse } from "../v1/respond.ts";
import type { PlatformAuthedContext } from "./authenticated.ts";

const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  connection_name: z.string().trim().min(1).max(200),
  external_ref: z.string().trim().min(1).max(200).nullable().optional(),
  risk_consent: z.object({
    accepted: z.literal(true),
    accepted_by: z.string().trim().min(1).max(200),
    accepted_at: z.string().datetime({ offset: true }),
    accepted_ip: z.string().ip(),
  }),
  consent_version: z.string().trim().min(1).max(100),
});

const BOOTSTRAP_SCOPES = [
  "whatsapp:numbers.read", "whatsapp:numbers.manage",
  "conversations:read", "messages:read", "messages:send",
];
const WORKSPACE_COLUMNS = "workspace_id, external_ref, created_at";
interface WorkspaceRow { workspace_id: string; external_ref: string | null; created_at: string }
interface AttemptSettlement {
  state: "failed" | "provisioned";
  error: string | null;
  owner_user_id?: string | null;
  workspace_id?: string;
}

function refuse(requestId: string, code: V1ErrorCode, message?: string): Response {
  console.warn(`[partner-api] platform workspace request refused (request ${requestId}): ${code}`);
  return v1ErrorResponse(code, requestId, { message });
}

async function settleAttempt(
  authed: PlatformAuthedContext,
  attemptId: string,
  settlement: AttemptSettlement,
): Promise<boolean> {
  try {
    const { data: saved, error } = await authed.admin.from("partner_provisioning_attempts")
      .update(settlement).eq("id", attemptId).eq("principal_id", authed.record.principalId)
      .select("id").maybeSingle();
    if (error || !saved) throw new Error("attempt settlement failed");
    return true;
  } catch {
    console.error(`[partner-api] provisioning attempt ${attemptId} requires reconciliation (request ${authed.requestId})`);
    return false;
  }
}

/** Retries return estate metadata, never the bootstrap secret. A pending or
 * failed attempt is reserved until reconciled; blindly retrying Auth can orphan
 * a second identity. The unique constraint also arbitrates concurrent creates. */
async function resumeAttempt(authed: PlatformAuthedContext, externalRef: string): Promise<Response | null> {
  const { admin, record, requestId } = authed;
  const { data: attempt, error } = await admin.from("partner_provisioning_attempts")
    .select("id, state").eq("principal_id", record.principalId)
    .eq("external_ref", externalRef).maybeSingle();
  if (error) return refuse(requestId, "internal_error");
  if (!attempt) return null;
  const { data: workspace, error: estateError } = await admin.from("partner_provisioned_workspaces")
    .select(WORKSPACE_COLUMNS).eq("principal_id", record.principalId)
    .eq("external_ref", externalRef).maybeSingle();
  if (estateError) return refuse(requestId, "internal_error");
  if (!workspace) return refuse(requestId, "idempotency_indeterminate");
  if (!await settleAttempt(authed, attempt.id, {
    state: "provisioned", workspace_id: workspace.workspace_id, error: null,
  })) return refuse(requestId, "internal_error");
  return v1JsonResponse({ ...workspace, request_id: requestId }, requestId);
}

/** A brand-new service owner has no subscription assigned by this route.
 * Honor any signup-trigger quota override before creating its first account. */
async function firstAccountAllowed(authed: PlatformAuthedContext, ownerId: string): Promise<boolean> {
  const { data: quota, error } = await authed.admin.from("user_quotas")
    .select("max_social_accounts").eq("user_id", ownerId).maybeSingle();
  if (error) throw new Error("owner quota read failed");
  const maximum = quota?.max_social_accounts ?? FREE_TIER_MAX_SOCIAL_ACCOUNTS;
  return maximum < 0 || maximum >= 1;
}

/** A lost RPC response is not proof of rollback. Even on a read-back outage
 * the owner stays intact; only a positively absent estate link permits cleanup. */
async function recoverOwner(
  authed: PlatformAuthedContext,
  ownerId: string,
  settlement: AttemptSettlement,
): Promise<V1ErrorCode> {
  const { admin } = authed;
  try {
    const { data: existing, error } = await admin.from("partner_provisioned_workspaces")
      .select("workspace_id").eq("owner_user_id", ownerId).maybeSingle();
    if (error) {
      settlement.error = "outcome_unknown";
      return "internal_error";
    }
    if (existing) {
      settlement.state = "provisioned";
      settlement.workspace_id = existing.workspace_id;
      settlement.error = "response_lost";
      return "idempotency_indeterminate";
    }
    const { error: cleanupError } = await admin.auth.admin.deleteUser(ownerId);
    settlement.error = cleanupError ? "compensation_failed" : "rolled_back";
    if (!cleanupError) settlement.owner_user_id = null;
  } catch {
    settlement.error = "recovery_failed";
  }
  return "internal_error";
}

export async function createWorkspace(
  req: Request,
  authed: PlatformAuthedContext,
  _params: Record<string, string>,
): Promise<Response> {
  const { admin, record, requestId } = authed;
  const parsed = createSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return refuse(requestId, "invalid_request", parsed.error.issues[0].message);
  const input = parsed.data;
  const externalRef = input.external_ref ?? null;
  if (externalRef !== null) {
    const replay = await resumeAttempt(authed, externalRef);
    if (replay) return replay;
  }
  const attemptId = crypto.randomUUID();
  const { error: reservationError } = await admin.from("partner_provisioning_attempts").insert({
    id: attemptId, request_id: requestId, principal_id: record.principalId,
    external_ref: externalRef, state: "pending",
  });
  if (reservationError) {
    if (reservationError.code === "23505" && externalRef !== null) {
      const replay = await resumeAttempt(authed, externalRef);
      if (replay) return replay;
    }
    return refuse(requestId, "internal_error");
  }

  let ownerId: string | null = null;
  let response: Response;
  const settlement: AttemptSettlement = { state: "failed", error: "owner_creation_failed" };
  try {
    // owner_user_id is an Auth FK, so it cannot precede createUser. The email
    // and metadata make the identity findable from the durable attempt instead.
    const { data: owner, error: ownerError } = await admin.auth.admin.createUser({
      email: `svc+${attemptId}@partner.postora.cloud`,
      email_confirm: false,
      user_metadata: { partner_service_account: true, principal_id: record.principalId, provisioning_attempt_id: attemptId },
    });
    if (ownerError || !owner?.user) throw new Error("owner creation failed");
    ownerId = owner.user.id;
    settlement.owner_user_id = ownerId;
    const { data: linked, error: linkError } = await admin.from("partner_provisioning_attempts")
      .update({ owner_user_id: ownerId }).eq("id", attemptId).eq("principal_id", record.principalId)
      .select("id").maybeSingle();
    if (linkError || !linked) throw new Error("owner linkage failed");
    if (!await firstAccountAllowed(authed, ownerId!)) {
      const code = await recoverOwner(authed, ownerId!, settlement);
      response = refuse(requestId, settlement.error === "rolled_back" ? "quota_exceeded" : code,
        settlement.error === "rolled_back" ? "The service owner's social account quota is exhausted" : undefined);
    } else {
      const environment = doorEnvironment();
      const secret = await generatePartnerKey(environment);
      const { data: tenant, error } = await admin.rpc("provision_partner_tenant", {
        p_principal_id: record.principalId, p_owner_user_id: ownerId,
        p_workspace_name: input.name, p_external_ref: externalRef,
        p_connection_name: input.connection_name, p_key_name: `${input.name} bootstrap`,
        p_key_prefix: secret.prefix, p_key_hash: secret.hash, p_scopes: BOOTSTRAP_SCOPES,
        p_environment: environment, p_platform_key_id: record.id, p_request_id: requestId,
        p_risk_consent_accepted_by: input.risk_consent.accepted_by,
        p_risk_consent_accepted_at: input.risk_consent.accepted_at,
        p_risk_consent_accepted_ip: input.risk_consent.accepted_ip,
        p_consent_version: input.consent_version,
      });
      if (error) throw new Error("provisioning outcome unresolved");
      if (!tenant?.workspace_id || !tenant?.account_id || !tenant?.key_id) throw new Error("provisioning response missing");
      settlement.state = "provisioned";
      settlement.workspace_id = tenant.workspace_id;
      settlement.error = null;
      response = v1JsonResponse({
        workspace_id: tenant.workspace_id, account_id: tenant.account_id, key_id: tenant.key_id,
        key: secret.key, external_ref: externalRef, request_id: requestId,
      }, requestId, 201);
      response.headers.set("Cache-Control", "no-store");
    }
  } catch {
    const code = ownerId ? await recoverOwner(authed, ownerId, settlement) : "internal_error";
    response = refuse(requestId, code);
  }
  if (!await settleAttempt(authed, attemptId, settlement)) return refuse(requestId, "internal_error");
  return response;
}

export async function listWorkspaces(
  req: Request,
  { admin, record, requestId }: PlatformAuthedContext,
  _params: Record<string, string>,
): Promise<Response> {
  const pageRequest = readPageRequest(req, requestId);
  if (!pageRequest.ok) {
    console.warn(`[partner-api] platform pagination refused (request ${requestId})`);
    return pageRequest.res;
  }
  const { limit, cursor } = pageRequest.page;
  let query = admin.from("partner_provisioned_workspaces").select(WORKSPACE_COLUMNS)
    .eq("principal_id", record.principalId)
    .order("created_at", { ascending: false }).order("workspace_id", { ascending: false })
    .limit(limit + 1);
  if (cursor) {
    query = query.or(`created_at.lt.${cursor.timestamp},and(created_at.eq.${cursor.timestamp},workspace_id.lt.${cursor.id})`);
  }
  const { data: rows, error } = await query;
  if (error) return refuse(requestId, "internal_error");
  const { page, nextCursor } = paginate<WorkspaceRow>(rows ?? [], limit,
    (row) => ({ timestamp: row.created_at, id: row.workspace_id }));
  return v1JsonResponse({ data: page, next_cursor: nextCursor, request_id: requestId }, requestId);
}

export async function getWorkspace(
  _req: Request,
  { admin, record, requestId }: PlatformAuthedContext,
  params: Record<string, string>,
): Promise<Response> {
  if (!z.string().uuid().safeParse(params.id).success) return refuse(requestId, "resource_not_found");
  const { data: workspace, error } = await admin.from("partner_provisioned_workspaces")
    .select(WORKSPACE_COLUMNS).eq("principal_id", record.principalId)
    .eq("workspace_id", params.id).maybeSingle();
  if (error) return refuse(requestId, "internal_error");
  if (!workspace) return refuse(requestId, "resource_not_found");
  return v1JsonResponse({ ...workspace, request_id: requestId }, requestId);
}
