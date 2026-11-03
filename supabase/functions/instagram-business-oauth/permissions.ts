import {
  createFacebookUserCredentialStore, parseInstagramAccountCapability, type ServiceRpcCaller,
} from "../_shared/facebookUserCredentialStore.ts";
import type { MetaOAuthReceipt } from "../_shared/metaOAuthAttemptStore.ts";
import { createOperationBudget, protectedFetchJson, readServiceEnvelope } from "../_shared/metaOAuthProtectedBoundary.ts";

export type PageLinkedPermissionOutcome =
  | { status: "ok"; insights_granted: boolean }
  | { status: "failed" | "unconfirmed" | "stale" };

type RefreshInput = {
  userId: string;
  receipt: MetaOAuthReceipt;
  rpc: ServiceRpcCaller;
  fetcher?: typeof fetch;
  now?: () => Date;
};

type PermissionEvidence =
  | { permission_read_state: "ok"; granted_scopes: string[]; scopes_read_at: string }
  | { permission_read_state: "failed"; read_failed_at: string; read_error_code: string };

const WRITE_RPC = "write_instagram_account_capability";
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Only complete, current protected-authority observations may establish a grant. */
export async function refreshPageLinkedInstagramPermissions(input: RefreshInput): Promise<PageLinkedPermissionOutcome> {
  const { receipt } = input;
  if (receipt.platform !== "instagram" || receipt.loginKind !== "page_linked" || !receipt.socialAccountId
    || receipt.capabilityGeneration === null || receipt.credentialId === null || receipt.credentialRevision === null
    || receipt.connectionVersion === null) return { status: "unconfirmed" };
  try {
    const credential = await createFacebookUserCredentialStore(input.rpc).readAccountCredential({
      userId: input.userId, socialAccountId: receipt.socialAccountId,
    });
    if (!credential.found || credential.platform !== "instagram" || credential.credentialKind !== "facebook_user"
      || !credential.token || credential.credentialId !== receipt.credentialId || credential.revision !== receipt.credentialRevision
      || credential.capabilityGeneration !== receipt.capabilityGeneration || credential.connectionVersion !== receipt.connectionVersion) {
      return { status: "stale" };
    }
    const startedAt = (input.now?.() ?? new Date()).toISOString();
    let payload: PermissionEvidence;
    try {
      const scopes = await readPageLinkedPermissions(credential.token, input.fetcher);
      payload = { permission_read_state: "ok", granted_scopes: scopes, scopes_read_at: startedAt };
    } catch {
      // A failed read is evidence of failure, never an authoritative empty scope set.
      payload = { permission_read_state: "failed", read_failed_at: startedAt, read_error_code: "permission_read_failed" };
    }
    const envelope = await input.rpc(WRITE_RPC, {
      p_user_id: input.userId, p_social_account_id: receipt.socialAccountId,
      p_payload: { ...payload, login_kind: "page_linked", expected_credential_generation: receipt.capabilityGeneration },
    });
    if (isRecord(envelope) && isRecord(envelope.error) && typeof envelope.error.code === "string"
      && ["ICG01", "ICG02"].includes(envelope.error.code)) {
      return { status: "stale" };
    }
    const written = readServiceEnvelope(envelope);
    if (written.status !== "row") return { status: "unconfirmed" };
    const capability = parseInstagramAccountCapability(WRITE_RPC, written.row);
    if (capability.socialAccountId !== receipt.socialAccountId || capability.credentialGeneration !== receipt.capabilityGeneration
      || capability.loginKind !== "page_linked") return { status: "unconfirmed" };
    if (payload.permission_read_state === "failed") return capability.permissionReadState !== "unknown"
      && Date.parse(capability.lastReadFailedAt ?? "") === Date.parse(startedAt) ? { status: "failed" } : { status: "unconfirmed" };
    if (capability.permissionReadState !== "ok" || !capability.scopesAuthoritative
      || Date.parse(capability.scopesReadAt ?? "") !== Date.parse(startedAt)
      || [...capability.grantedScopes].sort().join(",") !== [...payload.granted_scopes].sort().join(",")) {
      return { status: "unconfirmed" };
    }
    return { status: "ok", insights_granted: capability.grantedScopes.includes("instagram_manage_insights") };
  } catch {
    // The account commit is already durable. Never replay it after an uncertain read/write.
    return { status: "unconfirmed" };
  }
}

async function readPageLinkedPermissions(token: string, fetcher?: typeof fetch): Promise<string[]> {
  const budget = createOperationBudget(8_000);
  const statuses = new Map<string, string>();
  const cursors = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < 4; page++) {
    const url = new URL("https://graph.facebook.com/v22.0/me/permissions");
    url.searchParams.set("access_token", token);
    url.searchParams.set("limit", "100");
    if (after !== null) url.searchParams.set("after", after);
    const response = await protectedFetchJson(url.toString(), { method: "GET", redirect: "error" }, {
      timeoutMs: budget.take(8_000), fetcher, maxBodyBytes: 65_536,
    });
    const body = response.body;
    if (!response.ok || !isRecord(body) || body.error || body.error_message
      || !Array.isArray(body.data) || body.data.length > 100) throw new Error("Permission response unavailable");
    for (const row of body.data) {
      if (!isRecord(row) || typeof row.permission !== "string" || !/^[a-z][a-z0-9_]{0,127}$/.test(row.permission)
        || typeof row.status !== "string" || !["granted", "declined", "expired"].includes(row.status) || statuses.has(row.permission)) {
        throw new Error("Permission response unavailable");
      }
      statuses.set(row.permission, row.status);
    }
    if (body.paging === undefined || body.paging === null) return grantedScopes(statuses);
    if (!isRecord(body.paging)) throw new Error("Permission response unavailable");
    if (body.paging.next === undefined || body.paging.next === null) return grantedScopes(statuses);
    if (typeof body.paging.next !== "string" || !body.paging.next || !isRecord(body.paging.cursors)
      || typeof body.paging.cursors.after !== "string" || !/^[A-Za-z0-9_=-]{1,2048}$/.test(body.paging.cursors.after)
      || cursors.has(body.paging.cursors.after)) throw new Error("Permission continuation unavailable");
    after = body.paging.cursors.after;
    cursors.add(after);
  }
  throw new Error("Permission page budget exhausted");
}

function grantedScopes(statuses: ReadonlyMap<string, string>): string[] {
  return [...statuses].filter(([, status]) => status === "granted").map(([permission]) => permission).sort();
}
