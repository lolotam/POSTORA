import {
  type InstagramAccountCapability, parseInstagramAccountCapability, type ServiceRpcCaller,
} from "../_shared/facebookUserCredentialStore.ts";
import type { MetaOAuthReceipt } from "../_shared/metaOAuthAttemptStore.ts";
import { readServiceEnvelope } from "../_shared/metaOAuthProtectedBoundary.ts";

export type DirectPermissionOutcome =
  | { status: "ok"; insights_granted: boolean }
  | { status: "unknown" | "unconfirmed" | "stale" };

/** What the token exchange of THIS callback reported, bound to the identity it returned. */
export interface DirectPermissionEvidence {
  canonicalId: string;
  grantedPermissions: string[] | null;
}

type RecordInput = {
  userId: string;
  receipt: MetaOAuthReceipt;
  evidence: DirectPermissionEvidence;
  rpc: ServiceRpcCaller;
  now?: () => Date;
};

const WRITE_RPC = "write_instagram_account_capability";
const DIRECT_INSIGHTS_SCOPE = "instagram_business_manage_insights";
// ICG01: the capability generation moved on. ICG02: the evidence predates the live generation.
const STALE_CODES = new Set(["ICG01", "ICG02"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** The evidence came from this callback's exchange, for the direct account its commit named. */
function belongsToDirectCommit(receipt: MetaOAuthReceipt, evidence: DirectPermissionEvidence): boolean {
  return receipt.platform === "instagram" && receipt.flow === "instagram_direct"
    && receipt.loginKind === "direct" && !!receipt.socialAccountId
    && receipt.capabilityGeneration !== null && receipt.platformUserId === evidence.canonicalId;
}

function isStaleRefusal(envelope: unknown): boolean {
  return isRecord(envelope) && isRecord(envelope.error) && typeof envelope.error.code === "string"
    && STALE_CODES.has(envelope.error.code);
}

/** The projection the write returned is exactly the evidence that was sent, on the committed generation. */
function provesEvidenceLanded(
  capability: InstagramAccountCapability,
  receipt: MetaOAuthReceipt,
  grantedScopes: string[],
  scopesReadAt: string,
): boolean {
  return capability.socialAccountId === receipt.socialAccountId && capability.loginKind === "direct"
    && capability.credentialGeneration === receipt.capabilityGeneration
    && capability.permissionReadState === "ok" && capability.scopesAuthoritative
    && Date.parse(capability.scopesReadAt ?? "") === Date.parse(scopesReadAt)
    && [...capability.grantedScopes].sort().join(",") === grantedScopes.join(",");
}

/**
 * Records the permissions a direct Instagram Login exchange reported as granted.
 *
 * The write is fenced on the capability generation the commit receipt names,
 * so evidence from this callback can never land on a later reconnect. The
 * evidence time is taken after the commit: the commit itself opens the
 * generation, and the database refuses evidence older than that boundary.
 * No evidence leaves the capability unknown; nothing here ever writes a denial.
 */
export async function recordDirectInstagramPermissions(input: RecordInput): Promise<DirectPermissionOutcome> {
  const { receipt, evidence } = input;
  if (!belongsToDirectCommit(receipt, evidence)) return { status: "unconfirmed" };
  const grantedScopes = evidence.grantedPermissions;
  if (grantedScopes === null) return { status: "unknown" };
  const scopesReadAt = (input.now?.() ?? new Date()).toISOString();
  try {
    const envelope = await input.rpc(WRITE_RPC, {
      p_user_id: input.userId,
      p_social_account_id: receipt.socialAccountId,
      p_payload: {
        login_kind: "direct",
        permission_read_state: "ok",
        granted_scopes: grantedScopes,
        scopes_read_at: scopesReadAt,
        expected_credential_generation: receipt.capabilityGeneration,
      },
    });
    if (isStaleRefusal(envelope)) return { status: "stale" };
    const written = readServiceEnvelope(envelope);
    if (written.status !== "row") return { status: "unconfirmed" };
    const capability = parseInstagramAccountCapability(WRITE_RPC, written.row);
    if (!provesEvidenceLanded(capability, receipt, grantedScopes, scopesReadAt)) return { status: "unconfirmed" };
    return { status: "ok", insights_granted: capability.grantedScopes.includes(DIRECT_INSIGHTS_SCOPE) };
  } catch {
    // The account commit is already durable. An uncertain write is never replayed.
    return { status: "unconfirmed" };
  }
}
