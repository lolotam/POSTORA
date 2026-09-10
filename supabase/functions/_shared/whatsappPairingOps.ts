// Workspace-scoped registration and Direct QR pairing. The browser bridge is
// deliberately not repointed yet; its extraction/parity test is Task 8b.
import type { WhatsAppNumberContext } from "./whatsappNumberOps.ts";
import { normalizeConnectionName, syncEvolutionAccountConnection } from "./evolutionQrAccount.ts";
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
}

interface PairingInstance {
  instance_name: string;
  jwt_key: string;
  last_qr: string | null;
}

type PairingApi = Pick<EvolutionApi, "createInstance" | "connect" | "connectionState" | "fetchInstance">;
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

async function pairingAccount(ctx: WhatsAppNumberContext, accountId: string): Promise<PairingAccount> {
  if (!ctx.accountIds.includes(accountId)) throw new WhatsAppOpError("Number not found", "resource_not_found", 404);
  const { data, error } = await ctx.admin.from("social_accounts")
    .select("id, platform_user_id, is_active, connection_mode")
    .eq("workspace_id", ctx.workspaceId).eq("platform", "whatsapp").eq("id", accountId).maybeSingle();
  if (error) throw new WhatsAppOpError("Unable to read number", "internal_error", 500);
  if (!data) throw new WhatsAppOpError("Number not found", "resource_not_found", 404);
  if (data.connection_mode !== "evolution_qr") {
    throw new WhatsAppOpError("This operation is available only for Direct QR numbers", "unsupported_capability", 422);
  }
  return data;
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
  ctx: WhatsAppNumberContext, accountId: string, deps: PairingDependencies = {},
) {
  await pairingAccount(ctx, accountId);
  let instance = await pairingInstance(ctx, accountId);
  const api = configuredPairingApi(deps);
  if (!instance) {
    const baseUrl = deps.webhookBaseUrl ?? Deno.env.get("SUPABASE_PUBLIC_URL") ?? Deno.env.get("SUPABASE_URL");
    if (!baseUrl) throw new WhatsAppOpError("Pairing is not configured", "internal_error", 500);
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
    await pairingWrite(() => api.createInstance({ instanceName, webhook: {
      url: `${baseUrl.replace(/\/$/, "")}/functions/v1/whatsapp-evolution-webhook`,
      headers: { jwt_key: jwtKey },
      events: ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE", "QRCODE_UPDATED"],
    } }));
  }
  const connection = await pairingWrite(() => api.connect(instance.instance_name));
  const qr = extractQr(connection);
  const state = extractState(connection);
  if (!qr && !state) throw new WhatsAppOpError("Invalid pairing response", "internal_error", 502, undefined, true);
  await savePairing(ctx, accountId, { last_qr: qr, last_connection_state: state });
  // Evolution does not provide a reliable expiry timestamp; never invent one.
  return { account_id: accountId, qr: qr ? { code: qr, expires_at: null } : null, state };
}

async function pairingWrite(call: () => Promise<unknown>): Promise<unknown> {
  try {
    return await call();
  } catch (error) {
    const rejected = error instanceof EvolutionApiError && error.status >= 400 && error.status < 500;
    throw new WhatsAppOpError("Pairing provider request failed", "internal_error", 502, undefined, !rejected);
  }
}

export async function pairingStatus(
  ctx: WhatsAppNumberContext, accountId: string, deps: PairingDependencies = {},
) {
  const account = await pairingAccount(ctx, accountId);
  const instance = await pairingInstance(ctx, accountId);
  if (!instance) throw new WhatsAppOpError("Pairing not found; start pairing first", "resource_not_found", 404);
  const api = configuredPairingApi(deps);
  const state = extractState(await api.connectionState(instance.instance_name));
  if (!state) throw new WhatsAppOpError("Invalid pairing status response", "internal_error", 502);
  await savePairing(ctx, accountId, { last_connection_state: state });
  const ownerNumber = await reconcileAccountConnection(ctx, api, { account, instanceName: instance.instance_name, state });
  return { account_id: accountId, state,
    phone_number: ownerNumber.startsWith("pending_") ? null : ownerNumber };
}

async function reconcileAccountConnection(
  ctx: WhatsAppNumberContext, api: PairingApi,
  input: { account: PairingAccount; instanceName: string; state: string },
): Promise<string> {
  const { account, instanceName, state } = input;
  // Keep all reads/metadata merges/writes in the existing reconciler scoped to
  // this workspace too. No user identity crosses this application boundary.
  const scopedAdmin = {
    from: (table: string) => ({
      select: (columns: string) => ctx.admin.from(table).select(columns).eq("workspace_id", ctx.workspaceId).eq("id", account.id),
      update: (patch: Record<string, unknown>) => ctx.admin.from(table).update(patch).eq("workspace_id", ctx.workspaceId).eq("id", account.id),
    }),
    rpc: (name: string, args: Record<string, unknown>) => ctx.admin.rpc(name, args),
  };
  if (state === "open") {
    if (account.is_active && !account.platform_user_id.startsWith("pending_")) return account.platform_user_id;
    return await syncEvolutionAccountConnection(scopedAdmin, account, state, await api.fetchInstance(instanceName));
  }
  if (state === "close" && account.is_active) await syncEvolutionAccountConnection(scopedAdmin, account, state, null);
  return account.platform_user_id;
}

export async function endSession(
  ctx: WhatsAppNumberContext, accountId: string,
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
  ctx: WhatsAppNumberContext, accountId: string, deps: { api?: EvolutionApi } = {},
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

export async function historySyncStatus(ctx: WhatsAppNumberContext, accountId: string) {
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
