import {
  createFacebookUserCredentialStore, parseInstagramAccountCapability, type ServiceRpcCaller,
} from "./facebookUserCredentialStore.ts";
import type { MetaOAuthReceipt } from "./metaOAuthAttemptStore.ts";
import { createOperationBudget, protectedFetchJson, readServiceEnvelope } from "./metaOAuthProtectedBoundary.ts";
import { metaNextCursor } from "./metaPagination.ts";

export type PageLinkedPermissionOutcome =
  | { status: "ok"; insights_granted: boolean }
  | { status: "failed" | "unconfirmed" | "stale" };

export class MetaPermissionReadFailure extends Error {
  constructor(readonly reason: "token_invalid" | "permission_missing" | "unsupported" | "provider_error" | "rate_limited") { super(reason); }
}

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

/** The commit-time authority a permission read must still match before it may write. */
type BoundAuthority = {
  socialAccountId: string;
  credentialId: string;
  credentialRevision: number;
  capabilityGeneration: number;
  /** Null when the receipt does not carry this account's own connection version. */
  connectionVersion: number | null;
};

/** Only complete, current protected-authority observations may establish a grant. */
export async function refreshPageLinkedInstagramPermissions(input: RefreshInput): Promise<PageLinkedPermissionOutcome> {
  const { receipt } = input;
  if (receipt.platform !== "instagram" || receipt.loginKind !== "page_linked" || !receipt.socialAccountId
    || receipt.capabilityGeneration === null || receipt.credentialId === null || receipt.credentialRevision === null
    || receipt.connectionVersion === null) return { status: "unconfirmed" };
  return await refreshBoundPermissions(input, {
    socialAccountId: receipt.socialAccountId, credentialId: receipt.credentialId, credentialRevision: receipt.credentialRevision,
    capabilityGeneration: receipt.capabilityGeneration, connectionVersion: receipt.connectionVersion,
  });
}

/**
 * The Instagram companion a Facebook Page commit created or adopted.
 *
 * The commit advances the companion's capability generation and clears its
 * permissions, and the receipt carries that generation. The receipt's
 * connection version belongs to the Page, so only the shared credential and
 * the companion's generation fence this read.
 */
export async function refreshCompanionInstagramPermissions(input: RefreshInput): Promise<PageLinkedPermissionOutcome> {
  const { receipt } = input;
  if (receipt.flow !== "facebook_page" || receipt.platform !== "facebook" || !receipt.companionSocialAccountId
    || receipt.capabilityGeneration === null || receipt.credentialId === null || receipt.credentialRevision === null) {
    return { status: "unconfirmed" };
  }
  return await refreshBoundPermissions(input, {
    socialAccountId: receipt.companionSocialAccountId, credentialId: receipt.credentialId,
    credentialRevision: receipt.credentialRevision, capabilityGeneration: receipt.capabilityGeneration, connectionVersion: null,
  });
}

async function refreshBoundPermissions(input: RefreshInput, authority: BoundAuthority): Promise<PageLinkedPermissionOutcome> {
  try {
    const credential = await createFacebookUserCredentialStore(input.rpc).readAccountCredential({
      userId: input.userId, socialAccountId: authority.socialAccountId,
    });
    if (!credential.found || credential.platform !== "instagram" || credential.credentialKind !== "facebook_user"
      || !credential.token || credential.credentialId !== authority.credentialId || credential.revision !== authority.credentialRevision
      || credential.capabilityGeneration !== authority.capabilityGeneration
      || (authority.connectionVersion !== null && credential.connectionVersion !== authority.connectionVersion)) {
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
      p_user_id: input.userId, p_social_account_id: authority.socialAccountId,
      p_payload: { ...payload, login_kind: "page_linked", expected_credential_generation: authority.capabilityGeneration },
    });
    if (isRecord(envelope) && isRecord(envelope.error) && typeof envelope.error.code === "string"
      && ["ICG01", "ICG02"].includes(envelope.error.code)) {
      return { status: "stale" };
    }
    const written = readServiceEnvelope(envelope);
    if (written.status !== "row") return { status: "unconfirmed" };
    const capability = parseInstagramAccountCapability(WRITE_RPC, written.row);
    if (capability.socialAccountId !== authority.socialAccountId || capability.credentialGeneration !== authority.capabilityGeneration
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

/** The audit row a permission read leaves; it never carries a credential, provider body or URL. */
export type PermissionAuditRow = {
  level: "info" | "warn";
  category: "auth";
  source: string;
  message: string;
  user_id: string;
  metadata: { social_account_id: string | null } & PageLinkedPermissionOutcome;
};

/**
 * Records the outcome of one permission read. An outcome that cannot be
 * audited is reported as unconfirmed, never as a usable grant.
 */
export async function auditPermissionOutcome(input: {
  insert: (row: PermissionAuditRow) => Promise<{ error: unknown }>;
  source: string;
  userId: string;
  socialAccountId: string | null;
  outcome: PageLinkedPermissionOutcome;
}): Promise<PageLinkedPermissionOutcome> {
  try {
    const audit = await input.insert({
      level: input.outcome.status === "ok" ? "info" : "warn", category: "auth", source: input.source,
      message: "Protected Instagram permission read finished", user_id: input.userId,
      metadata: { social_account_id: input.socialAccountId, ...input.outcome },
    });
    if (audit.error) throw new Error("Permission audit unavailable");
    return input.outcome;
  } catch {
    console.error(`[${input.source}] permission audit unavailable`, { event: "permission_audit_unavailable" });
    return { status: "unconfirmed" };
  }
}

export async function readPageLinkedPermissions(token: string, fetcher?: typeof fetch, options: {
  deadline?: number; beforeRequest?: () => Promise<void>;
  origin?: "https://graph.facebook.com" | "https://graph.instagram.com"; version?: "v22.0" | "v25.0";
} = {}): Promise<string[]> {
  const budget = createOperationBudget(8_000);
  const origin = options.origin ?? "https://graph.facebook.com";
  const path = `/${options.version ?? "v22.0"}/me/permissions`;
  const statuses = new Map<string, string>();
  const cursors = new Set<string>();
  let after: string | null = null;
  for (let page = 0; page < 4; page++) {
    await options.beforeRequest?.();
    const url = new URL(origin + path);
    url.searchParams.set("access_token", token);
    url.searchParams.set("limit", "100");
    if (after !== null) url.searchParams.set("after", after);
    const response = await protectedFetchJson(url.toString(), { method: "GET", redirect: "error" }, {
      timeoutMs: Math.min(budget.take(8_000), (options.deadline ?? Infinity) - Date.now()), fetcher, maxBodyBytes: 65_536,
    });
    const body = response.body;
    if (isRecord(body) && isRecord(body.error)) {
      const code = body.error.code;
      throw new MetaPermissionReadFailure(response.status === 429 || [4, 17, 32, 613].includes(Number(code)) ? "rate_limited" : code === 190 ? "token_invalid" : [10, 200].includes(Number(code))
        ? "permission_missing" : code === 100 ? "unsupported" : "provider_error");
    }
    if (!response.ok || !isRecord(body) || body.error || body.error_message
      || !Array.isArray(body.data) || body.data.length > 100) throw new Error("Permission response unavailable");
    for (const row of body.data) {
      if (!isRecord(row) || typeof row.permission !== "string" || !/^[a-z][a-z0-9_]{0,127}$/.test(row.permission)
        || typeof row.status !== "string" || !["granted", "declined", "expired"].includes(row.status) || statuses.has(row.permission)) {
        throw new Error("Permission response unavailable");
      }
      statuses.set(row.permission, row.status);
    }
    after = metaNextCursor(body, origin, path, cursors);
    if (after === null) return grantedScopes(statuses);
  }
  throw new Error("Permission page budget exhausted");
}

function grantedScopes(statuses: ReadonlyMap<string, string>): string[] {
  return [...statuses].filter(([, status]) => status === "granted").map(([permission]) => permission).sort();
}
