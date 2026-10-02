// Workspace-scoped registration and Direct QR pairing. The browser bridge is
// deliberately not repointed yet; its extraction/parity test is Task 8b.
import type { WhatsAppNumberContext } from "./whatsappNumberOps.ts";
import { normalizeConnectionName, syncEvolutionAccountConnection, NumberMismatchError } from "./evolutionQrAccount.ts";
import { handleNumberMismatch } from "./numberMismatch.ts";
import { createEvolutionApi, EvolutionApiError, type EvolutionApi } from "./evolutionApi.ts";
import { WhatsAppOpError } from "./whatsappPartnerOps.ts";
import { disconnectWhatsAppAccount, type WhatsAppDisconnectDeps } from "./whatsappDisconnect.ts";
import { importEvolutionHistory, type SyncAccount } from "./whatsappSyncEngine.ts";

export const DIRECT_QR_CONSENT_VERSION = "direct-qr-2026-09-10";

interface RegistrationInput {
  connection_name?: unknown;
  connection_mode?: unknown;
  risk_consent?: unknown;
}

type RegistrationResult = { ok: true; accountId: string } | {
  ok: false;
  reason: "invalid_request" | "unsupported_capability" | "quota_exceeded" | "internal_error" | "write_failed";
  message?: string;
};

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export async function registerNumber(
  ctx: WhatsAppNumberContext & { keyId: string },
  input: RegistrationInput,
): Promise<RegistrationResult> {
  if (input.connection_mode === "cloud_api" || input.connection_mode === "coexistence") {
    return { ok: false, reason: "unsupported_capability",
      message: `${input.connection_mode} onboarding is not available through the Partner API yet; Meta credential exchange and business verification are required` };
  }
  if (input.connection_mode !== "evolution_qr") {
    return { ok: false, reason: "invalid_request", message: "connection_mode must be evolution_qr" };
  }
  const name = normalizeConnectionName(input.connection_name);
  if (!name) return { ok: false, reason: "invalid_request", message: "connection_name must be 1 to 60 characters" };
  const consent = object(input.risk_consent);
  if (consent.accepted !== true || typeof consent.accepted_by !== "string" || !consent.accepted_by.trim() ||
    typeof consent.accepted_at !== "string" || !Number.isFinite(Date.parse(consent.accepted_at)) ||
    (consent.accepted_ip != null && typeof consent.accepted_ip !== "string")) {
    return { ok: false, reason: "invalid_request",
      message: "risk_consent requires accepted=true, a non-empty accepted_by and a valid accepted_at timestamp; accepted_ip must be a string or null" };
  }
  try {
    const { data, error } = await ctx.admin.rpc("register_partner_whatsapp_number", {
      p_key_id: ctx.keyId, p_workspace_id: ctx.workspaceId, p_connection_name: name,
      p_risk_consent_accepted_by: consent.accepted_by,
      p_risk_consent_accepted_at: new Date(consent.accepted_at).toISOString(),
      p_risk_consent_accepted_ip: consent.accepted_ip ?? null,
      p_consent_version: DIRECT_QR_CONSENT_VERSION, p_request_id: ctx.requestId,
    });
    if (error) return registrationFailure(error);
    if (typeof data?.account_id !== "string" || !data.account_id) return { ok: false, reason: "write_failed" };
    return { ok: true, accountId: data.account_id };
  } catch {
    // A lost RPC response does not prove the transaction rolled back.
    return { ok: false, reason: "write_failed" };
  }
}

function registrationFailure(error: { code?: string; message?: string }): RegistrationResult {
  if (error.code === "23514" || error.code === "check_violation") {
    if (error.message?.includes("quota exceeded")) return { ok: false, reason: "quota_exceeded" };
    return { ok: false, reason: "invalid_request", message: "Invalid connection name, consent evidence or workspace key" };
  }
  if (error.code === "P0002" || error.code === "no_data_found") {
    // The actual RPC also uses P0002 for a foreign/revoked key.
    return { ok: false, reason: "invalid_request", message: error.message?.includes("calling key")
      ? "The calling key is not an active key of this workspace"
      : "This workspace was not provisioned through the platform tier and has no service owner" };
  }
  // Connection loss and statement-completion-unknown are ambiguous even when
  // they carry a SQLSTATE. Other SQL errors prove a transaction rejection.
  if (error.code?.startsWith("08") || error.code === "40003") return { ok: false, reason: "write_failed" };
  return { ok: false, reason: error.code && /^[0-9A-Z]{5}$/.test(error.code) ? "internal_error" : "write_failed" };
}

interface PairingAccount {
  id: string;
  platform_user_id: string;
  is_active: boolean;
  connection_mode: string;
  account_metadata: Record<string, unknown> | null;
}

// A request-local resolved context lets the HTTP door authorize before replay
// and the operation reuse that exact lookup. Standalone callers still resolve.
interface ResolvedNumberContext extends WhatsAppNumberContext { account: PairingAccount }
type PairingContext = WhatsAppNumberContext | ResolvedNumberContext;

interface PairingInstance {
  instance_name: string;
  jwt_key: string;
  last_qr: string | null;
}

// logout is part of the pairing contract since the mismatch flow: a refused phone has its
// remote session killed, and this module owns that call for the partner path.
type PairingApi = Pick<EvolutionApi, "createInstance" | "connect" | "connectionState" | "fetchInstance" | "logout">;
interface PairingDependencies { api?: PairingApi; webhookBaseUrl?: string }

function configuredPairingApi(deps: PairingDependencies): PairingApi {
  if (deps.api) return deps.api;
  try {
    return createEvolutionApi();
  } catch {
    // Construction only checks configuration, before any network or write.
    throw new WhatsAppOpError("Pairing is not configured", "internal_error", 500);
  }
}

export async function resolveNumberContext(ctx: WhatsAppNumberContext, accountId: string): Promise<ResolvedNumberContext> {
  if (!ctx.accountIds.includes(accountId)) throw new WhatsAppOpError("Number not found", "resource_not_found", 404);
  const { data, error } = await ctx.admin.from("social_accounts")
    .select("id, platform_user_id, is_active, connection_mode, account_metadata")
    .eq("workspace_id", ctx.workspaceId).eq("platform", "whatsapp").eq("id", accountId).maybeSingle();
  if (error) throw new WhatsAppOpError("Unable to read number", "internal_error", 500);
  if (!data) throw new WhatsAppOpError("Number not found", "resource_not_found", 404);
  return { ...ctx, account: data };
}

async function pairingAccount(ctx: PairingContext, accountId: string): Promise<PairingAccount> {
  if (!ctx.accountIds.includes(accountId)) throw new WhatsAppOpError("Number not found", "resource_not_found", 404);
  const { account } = "account" in ctx && ctx.account.id === accountId ? ctx : await resolveNumberContext(ctx, accountId);
  if (account.connection_mode !== "evolution_qr") {
    throw new WhatsAppOpError("This operation is available only for Direct QR numbers", "unsupported_capability", 422);
  }
  return account;
}

async function pairingInstance(ctx: WhatsAppNumberContext, accountId: string): Promise<PairingInstance | null> {
  // Called only after the workspace/binding lookup; the instance FK names that account.
  const { data, error } = await ctx.admin.from("whatsapp_evolution_instances")
    .select("instance_name, jwt_key, last_qr").eq("social_account_id", accountId).maybeSingle();
  if (error) throw new WhatsAppOpError("Unable to read pairing", "internal_error", 500);
  return data;
}

function extractQr(payload: unknown): string | null {
  const root = object(payload);
  const qr = object(root.qrcode || root.qr || root);
  const code = qr.base64 || qr.image || qr.code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

function extractState(payload: unknown): string | null {
  const root = object(payload);
  const state = object(root.instance).state || root.state || root.connectionStatus;
  return typeof state === "string" && state.length > 0 ? state.toLowerCase() : null;
}

async function savePairing(ctx: WhatsAppNumberContext, accountId: string, patch: Record<string, unknown>) {
  const { error } = await ctx.admin.from("whatsapp_evolution_instances")
    .update(patch).eq("social_account_id", accountId);
  if (error) throw new WhatsAppOpError("Unable to save pairing", "internal_error", 500, undefined, true);
}

export async function startPairing(
  ctx: PairingContext, accountId: string, deps: PairingDependencies = {},
) {
  const account = await pairingAccount(ctx, accountId);
  let instance = await pairingInstance(ctx, accountId);
  const api = configuredPairingApi(deps);
  if (!instance) {
    const webhookUrl = pairingWebhookUrl(deps);
    const instanceName = `postora_${accountId}`;
    const jwtKeyBytes = crypto.getRandomValues(new Uint8Array(32));
    const jwtKey = btoa(String.fromCharCode(...jwtKeyBytes))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const { error } = await ctx.admin.from("whatsapp_evolution_instances").insert({
      social_account_id: accountId, instance_name: instanceName, jwt_key: jwtKey,
    });
    // Never upsert: a racing attempt must not replace the webhook credential.
    if (error) throw new WhatsAppOpError("Unable to create pairing", "internal_error", 500, undefined, error.code !== "23505");
    instance = { instance_name: instanceName, jwt_key: jwtKey, last_qr: null };
    try {
      await createProviderInstance(api, instance, webhookUrl);
    } catch (error) {
      if (definiteRejection(error)) {
        // Remove only this reservation, never a different racing instance.
        const { error: cleanupError } = await ctx.admin.from("whatsapp_evolution_instances").delete()
          .eq("social_account_id", accountId).eq("instance_name", instanceName);
        if (cleanupError) throw new WhatsAppOpError("Pairing cleanup outcome unknown", "internal_error", 500, undefined, true);
      }
      throw pairingFailure(error);
    }
  }
  const current = instance;
  const connection = await pairingWrite(async () => {
    try {
      return await api.connect(current.instance_name);
    } catch (error) {
      if (!(error instanceof EvolutionApiError) || error.status !== 404) throw error;
      // A retained local reservation may outlive the provider instance. Reuse
      // its credential and recreate once; a second failure is never looped.
      await createProviderInstance(api, current, pairingWebhookUrl(deps));
      return await api.connect(current.instance_name);
    }
  });
  const qr = extractQr(connection);
  const state = extractState(connection);
  if (!qr && !state) throw new WhatsAppOpError("Invalid pairing response", "internal_error", 502, undefined, true);
  await savePairing(ctx, accountId, { last_qr: qr, last_connection_state: state });
  // A fresh pairing supersedes an earlier refusal: the durable mismatch flag is dropped
  // so the next status poll reads the live provider state again. A failed start throws
  // before this point, so the flag survives a refused pairing. The clear runs through
  // the RPC with the workspace as the tenant scope -- no owner identity crosses this
  // partner-API boundary, and only the number_mismatch key changes, atomically.
  if (account.account_metadata?.number_mismatch === true) {
    const { error } = await ctx.admin.rpc("clear_whatsapp_number_mismatch", {
      p_account_id: accountId,
      p_user_id: null,
      p_workspace_id: ctx.workspaceId,
    });
    if (error) throw error;
  }
  // Evolution does not provide a reliable expiry timestamp; never invent one.
  return { account_id: accountId, qr: qr ? { code: qr, expires_at: null } : null, state };
}

async function pairingWrite(call: () => Promise<unknown>): Promise<unknown> {
  try {
    return await call();
  } catch (error) {
    throw pairingFailure(error);
  }
}

function definiteRejection(error: unknown): boolean {
  return error instanceof EvolutionApiError && error.status >= 400 && error.status < 500;
}
function pairingFailure(error: unknown): WhatsAppOpError {
  if (error instanceof WhatsAppOpError) return error;
  // invalid_request is the contract's generic application rejection code.
  return definiteRejection(error)
    ? new WhatsAppOpError("Pairing provider rejected the request", "invalid_request", 422)
    : new WhatsAppOpError("Pairing provider request failed", "internal_error", 502, undefined, true);
}
function pairingWebhookUrl(deps: PairingDependencies): string {
  const baseUrl = deps.webhookBaseUrl ?? Deno.env.get("SUPABASE_PUBLIC_URL") ?? Deno.env.get("SUPABASE_URL");
  if (!baseUrl) throw new WhatsAppOpError("Pairing is not configured", "internal_error", 500);
  return `${baseUrl.replace(/\/$/, "")}/functions/v1/whatsapp-evolution-webhook`;
}
function createProviderInstance(api: PairingApi, instance: PairingInstance, url: string) {
  return api.createInstance({ instanceName: instance.instance_name, webhook: {
    url, headers: { jwt_key: instance.jwt_key },
    events: ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE", "QRCODE_UPDATED"],
  } });
}

export async function pairingStatus(
  ctx: WhatsAppNumberContext, accountId: string, deps: PairingDependencies = {},
) {
  const account = await pairingAccount(ctx, accountId);
  const instance = await pairingInstance(ctx, accountId);
  if (!instance) throw new WhatsAppOpError("Pairing not found; start pairing first", "resource_not_found", 404);
  // A durable mismatch from an earlier refusal is answered from the stored flag alone:
  // the remote session was already killed, so a provider poll would only see a closed
  // instance and could never clear the flag the owner must see. The stored state is
  // left untouched too -- it already says number_mismatch.
  if (account.account_metadata?.number_mismatch === true) {
    return { account_id: accountId, state: "number_mismatch", phone_number: null };
  }
  const api = configuredPairingApi(deps);
  const state = extractState(await api.connectionState(instance.instance_name));
  if (!state) throw new WhatsAppOpError("Invalid pairing status response", "internal_error", 502);
  // The reconciler runs before the observed state is persisted, mirroring the bridge's
  // ordering contract: a refused phone must not have "open" stored over the
  // number_mismatch state the mismatch handler writes, and a failed reconcile must not
  // leave behind a state this request could not actually verify.
  const result = await reconcileAccountConnection(ctx, api, { account, instanceName: instance.instance_name, state });
  if (!result.mismatch) {
    await savePairing(ctx, accountId, { last_connection_state: state });
  }
  return {
    account_id: accountId,
    // A refused phone never reports "open": the pairing is blocked until the right
    // phone scans, and the status says so instead of a state the UI would celebrate.
    state: result.mismatch ? "number_mismatch" : state,
    phone_number: result.mismatch || result.ownerNumber.startsWith("pending_") ? null : result.ownerNumber,
  };
}

interface ReconcileResult {
  ownerNumber: string;
  mismatch: boolean;
}

async function reconcileAccountConnection(
  ctx: WhatsAppNumberContext, api: PairingApi,
  input: { account: PairingAccount; instanceName: string; state: string },
): Promise<ReconcileResult> {
  const { account, instanceName, state } = input;
  // Keep all reads/metadata merges/writes in the existing reconciler scoped to
  // this workspace too. No user identity crosses this application boundary.
  const scopedAdmin = {
    from: (table: string) => {
      // Fan-out scopes subscriptions/deliveries itself. Their ids are not
      // social-account ids, so applying the account filter would suppress events.
      if (table === "partner_webhooks" || table === "partner_webhook_deliveries") return ctx.admin.from(table);
      return {
        select: (columns: string) => ctx.admin.from(table).select(columns).eq("workspace_id", ctx.workspaceId).eq("id", account.id),
        update: (patch: Record<string, unknown>) => ctx.admin.from(table).update(patch).eq("workspace_id", ctx.workspaceId).eq("id", account.id),
      };
    },
    rpc: (name: string, args: Record<string, unknown>) => ctx.admin.rpc(name, args),
  };
  if (state === "open") {
    if (account.is_active && !account.platform_user_id.startsWith("pending_")) {
      return { ownerNumber: account.platform_user_id, mismatch: false };
    }
    try {
      // The partner path has no owner identity; its workspace is the tenant scope the
      // mismatch flag requires, and no user id crosses this boundary.
      const ownerNumber = await syncEvolutionAccountConnection(scopedAdmin, account, state, await api.fetchInstance(instanceName), {
        workspaceId: ctx.workspaceId,
      });
      return { ownerNumber, mismatch: false };
    } catch (error) {
      if (!(error instanceof NumberMismatchError)) throw error;
      // The stored number and the linked phone disagree: the flag RPC inside the sync
      // already recorded the refusal on the account row; the shared handler kills the
      // remote session and records why in the instance row.
      await handleNumberMismatch(ctx.admin, api, { accountId: account.id, instanceName });
      return { ownerNumber: account.platform_user_id, mismatch: true };
    }
  }
  if (state === "close" && account.is_active) await syncEvolutionAccountConnection(scopedAdmin, account, state, null);
  return { ownerNumber: account.platform_user_id, mismatch: false };
}

export async function endSession(
  ctx: PairingContext, accountId: string,
  deps: { evolution?: WhatsAppDisconnectDeps["evolution"]; disconnect?: typeof disconnectWhatsAppAccount } = {},
) {
  await pairingAccount(ctx, accountId);
  let evolution = deps.evolution;
  if (!evolution) {
    try { evolution = createEvolutionApi(); } catch {
      // Missing provider configuration must still allow mandatory local teardown.
      evolution = undefined;
    }
  }
  const result = await (deps.disconnect ?? disconnectWhatsAppAccount)({
    accountId, workspaceId: ctx.workspaceId, connectionMode: "evolution_qr",
  }, { admin: ctx.admin, evolution });
  if (!result.deactivated) throw new WhatsAppOpError("Number was not deactivated", "internal_error", 500);
  return {
    local_deactivated: result.deactivated, remote_logout: result.evolution,
    // The shared teardown includes raw provider/DB exception text. Preserve each
    // warning's meaning without exposing hosts, credentials or query details.
    warnings: result.warnings.map((warning) => warning.startsWith("Evolution logout failed:")
      ? "Remote logout failed; the session may still be live"
      : warning.startsWith("Evolution instance delete failed:")
      ? "Remote instance removal failed; the session may still be live"
      : warning.startsWith("Evolution instance row not updated:")
      ? "Local session status could not be updated"
      : "Remote logout could not be confirmed; the session may still be live"),
  };
}

export async function startHistorySync(
  ctx: PairingContext, accountId: string, deps: { api?: EvolutionApi } = {},
) {
  await pairingAccount(ctx, accountId);
  // Resolve the owner internally, after the workspace/binding gate. No owner id
  // is accepted from the route or reused as the authorization boundary.
  const { data: account, error } = await ctx.admin.from("social_accounts")
    .select("id, user_id, workspace_id, platform_user_id")
    .eq("workspace_id", ctx.workspaceId).eq("platform", "whatsapp").eq("id", accountId).maybeSingle();
  if (error) throw new WhatsAppOpError("Unable to read number", "internal_error", 500);
  if (!account) throw new WhatsAppOpError("Number not found", "resource_not_found", 404);
  const instance = await pairingInstance(ctx, accountId);
  if (!instance) throw new WhatsAppOpError("History sync instance not found", "resource_not_found", 404);
  let api: EvolutionApi;
  try { api = deps.api ?? createEvolutionApi(); } catch {
    throw new WhatsAppOpError("History sync is not configured", "internal_error", 500);
  }
  const outcome = await importEvolutionHistory({ admin: ctx.admin, api,
    account: account as SyncAccount, instanceName: instance.instance_name });
  switch (outcome) {
    case "claimed": return { state: "running" as const };
    case "skipped_lease_held":
      throw new WhatsAppOpError("History sync is already running; poll history-sync for progress", "sync_already_running", 409);
    case "skipped_unresolved_number":
      throw new WhatsAppOpError("Finish pairing the number before syncing history", "unsupported_capability", 422);
    case "skipped_no_workspace":
      throw new WhatsAppOpError("History sync account has no workspace", "internal_error", 500);
  }
}

interface HistorySyncInstance {
  sync_started_at: string | null;
  last_sync_at: string | null;
  last_sync_outcome: unknown;
}

function recordedHistoryState(instance: HistorySyncInstance): "idle" | "running" | "completed" | "partial" | "failed" {
  if (instance.sync_started_at) return "running";
  if (instance.last_sync_outcome === null) return instance.last_sync_at ? "completed" : "idle";
  const outcome = object(instance.last_sync_outcome);
  if (typeof outcome.error === "string" && outcome.error) return "failed";
  const counts = ["chatsDiscovered", "chatsImported", "chatsSkipped", "chatsAwaitingLid",
    "chatsLidResolved", "messagesWritten", "chatFailures"];
  if (!counts.every((key) => typeof outcome[key] === "number" && Number.isInteger(outcome[key]) && Number(outcome[key]) >= 0) ||
    typeof outcome.truncated !== "boolean") {
    throw new WhatsAppOpError("Stored history sync outcome is not recognized", "internal_error", 500);
  }
  return outcome.truncated || Number(outcome.chatFailures) > 0 || Number(outcome.chatsAwaitingLid) > 0 ||
      outcome.chatsImported === 0 || outcome.messagesWritten === 0 ? "partial" : "completed";
}

export async function historySyncStatus(ctx: PairingContext, accountId: string) {
  await pairingAccount(ctx, accountId);
  const { data, error } = await ctx.admin.from("whatsapp_evolution_instances")
    .select("sync_started_at, last_sync_at, last_sync_outcome").eq("social_account_id", accountId).maybeSingle();
  if (error) throw new WhatsAppOpError("Unable to read history sync", "internal_error", 500);
  if (!data) throw new WhatsAppOpError("History sync instance not found", "resource_not_found", 404);
  const instance = data as HistorySyncInstance;
  const outcome = object(instance.last_sync_outcome);
  return { account_id: accountId, state: recordedHistoryState(instance), started_at: instance.sync_started_at,
    finished_at: typeof outcome.finished_at === "string" ? outcome.finished_at : instance.last_sync_at };
}
