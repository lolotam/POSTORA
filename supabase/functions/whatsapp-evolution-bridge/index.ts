import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { handleRestrictedCorsOptions, restrictedErrorResponse, restrictedJsonResponse } from "../_shared/cors.ts";
import { createEvolutionApi } from "../_shared/evolutionApi.ts";
import {
  findOwnedEvolutionAccount,
  mergeDisplayName,
  normalizeConnectionName,
} from "../_shared/evolutionQrAccount.ts";
import { importEvolutionHistory } from "../_shared/whatsappSyncEngine.ts";
import { runInBackground } from "../_shared/background.ts";
import { disconnectWhatsAppAccount, type WhatsAppDisconnectAdmin } from "../_shared/whatsappDisconnect.ts";
import { resolveMaxSocialAccounts, type SocialAccountQuotaClient } from "../_shared/socialAccountQuota.ts";
import { extractQr, extractState } from "./qr.ts";
import { buildQrStatusDeps, getQrStatusResult } from "./qrStatus.ts";
import { reconnectQr, ReconnectError } from "./reconnect.ts";
import { buildReconnectDeps, EVOLUTION_EVENTS } from "./reconnectDeps.ts";
import {
  dismissSetupMove,
  moveSetup,
  MoveSetupError,
  type MoveSetupDeps,
} from "./moveSetup.ts";

class BridgeError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "BridgeError";
  }
}

interface BridgeBody {
  action:
    | "create_and_get_qr"
    | "get_qr_status"
    | "reconnect_qr"
    | "logout_instance"
    | "sync_past_chats"
    | "get_sync_status"
    | "resubscribe_webhook"
    | "move_setup"
    | "dismiss_setup_move";
  social_account_id?: string;
  workspace_id?: string;
  risk_consent?: boolean;
  refresh_qr?: boolean;
  connection_name?: string;
  from?: string;
  to?: string;
  choices?: Record<string, unknown>;
}

interface EvolutionInstanceRow {
  social_account_id: string;
  instance_name: string;
  jwt_key: string;
  last_qr: string | null;
  last_sync_at: string | null;
  sync_started_at: string | null;
  last_sync_outcome: Record<string, unknown> | null;
}

function clientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip");
}

// Evolution runs in its own stack and can only reach the public gateway, while
// SUPABASE_URL is the internal Kong hostname inside the edge runtime.
function evolutionWebhookBaseUrl(internalUrl: string): string {
  const base = Deno.env.get("SUPABASE_PUBLIC_URL") || internalUrl;
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

async function authenticateRequest(req: Request) {
  const authorization = req.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) throw new BridgeError("Invalid session", 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || Deno.env.get("SUPABASE_PUBLISHABLE_KEY");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceRoleKey) throw new BridgeError("Supabase auth is not configured", 503);

  const userClient = createClient(supabaseUrl, anonKey, {
    global: { headers: { Authorization: authorization } },
  });
  const { data, error } = await userClient.auth.getUser();
  if (error || !data.user) throw new BridgeError("Invalid session", 401);

  return {
    user: data.user,
    userClient,
    admin: createClient(supabaseUrl, serviceRoleKey),
    webhookBaseUrl: evolutionWebhookBaseUrl(supabaseUrl),
  };
}

async function requireWorkspaceAdmin(admin: any, userId: string, workspaceId: string): Promise<void> {
  const { data, error } = await admin
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new BridgeError("Workspace not found", 404);
  if (!['owner', 'admin'].includes(data.role)) throw new BridgeError("WhatsApp workspace admin role required", 403);
}

async function resolveWorkspaceId(
  admin: any,
  userClient: any,
  userId: string,
  requestedWorkspaceId?: string,
): Promise<string> {
  if (requestedWorkspaceId) {
    await requireWorkspaceAdmin(admin, userId, requestedWorkspaceId);
    return requestedWorkspaceId;
  }

  const { data, error } = await userClient.rpc("ensure_personal_workspace", { p_user_id: userId });
  if (error || !data) throw error || new BridgeError("Unable to resolve personal workspace", 500);
  return data as string;
}

async function enforceAccountQuota(admin: any, userId: string): Promise<void> {
  const { data: role } = await admin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (role) return;

  const maximum = await resolveMaxSocialAccounts(admin as SocialAccountQuotaClient, userId);
  if (maximum < 0) return;

  const { count, error: countError } = await admin
    .from("social_accounts")
    .select("id", { count: "exact", head: true })
    .eq("user_id", userId)
    .eq("is_active", true);
  if (countError) throw countError;
  if ((count || 0) >= maximum) {
    throw new BridgeError("Social account quota reached. Upgrade your plan to connect another account.", 402);
  }
}

async function findOwnedAccount(admin: any, userId: string, socialAccountId: string) {
  // Owner check lives in the shared lookup; this wrapper only maps "not yours (or not
  // a Direct QR account)" to the HTTP error.
  const data = await findOwnedEvolutionAccount(admin, userId, socialAccountId);
  if (!data || data.connection_mode !== "evolution_qr") throw new BridgeError("WhatsApp Direct QR account not found", 404);
  return data;
}

// Setup moves must also work between a Direct QR row and a Meta (Cloud API) row, so
// unlike findOwnedAccount this accepts any WhatsApp connection mode. moveSetup.ts
// turns the null into its own 404, so this stays a raw lookup like the reconnect one.
async function findOwnedWhatsAppAccount(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- service-role client has no generated type here, matching every other lookup in this file
  admin: any,
  userId: string,
  socialAccountId: string,
): Promise<{ id: string } | null> {
  const { data, error } = await admin
    .from("social_accounts")
    .select("id")
    .eq("id", socialAccountId)
    .eq("user_id", userId)
    .eq("platform", "whatsapp")
    .maybeSingle();
  if (error) throw error;
  return data ? { id: data.id } : null;
}

async function findInstance(admin: any, socialAccountId: string): Promise<EvolutionInstanceRow> {
  const { data, error } = await admin
    .from("whatsapp_evolution_instances")
    .select("social_account_id, instance_name, jwt_key, last_qr, last_sync_at, sync_started_at, last_sync_outcome")
    .eq("social_account_id", socialAccountId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new BridgeError("Direct QR instance not found", 404);
  return data as EvolutionInstanceRow;
}

async function removeProvisionedAccount(admin: any, socialAccountId: string): Promise<void> {
  await admin.from("whatsapp_evolution_instances").delete().eq("social_account_id", socialAccountId);
  await admin.from("social_accounts").delete().eq("id", socialAccountId);
}

async function createAndGetQr(context: Awaited<ReturnType<typeof authenticateRequest>>, body: BridgeBody, req: Request) {
  const workspaceId = await resolveWorkspaceId(
    context.admin,
    context.userClient,
    context.user.id,
    body.workspace_id,
  );
  await enforceAccountQuota(context.admin, context.user.id);
  if (body.risk_consent !== true) throw new BridgeError("Risk consent is required before connecting Direct QR mode", 400);
  // Collected before the QR flow starts, not in the scanner that mounts afterwards: the
  // webhook can activate the account while the scanner is still polling, which would
  // make the name arrive after activation has already run. Invalid input is rejected,
  // never silently substituted.
  const connectionName = normalizeConnectionName(body.connection_name);
  if (!connectionName) throw new BridgeError("A connection name of 1 to 60 characters is required", 400);

  const socialAccountId = crypto.randomUUID();
  const instanceName = `postora_${socialAccountId}`;
  const jwtKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const jwtKey = btoa(String.fromCharCode(...jwtKeyBytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const consentAcceptedAt = new Date().toISOString();
  // The name is persisted to BOTH platform_username (what the UI renders) and a merged
  // account_metadata.display_name (the durable marker that keeps a later reconnect's
  // profileName from clobbering the user's choice). platform_user_id stays on the
  // pending_ placeholder until activation resolves it to the linked number.
  const metadata = mergeDisplayName({
    connection_mode: "evolution_qr",
    risk_consent_accepted_at: consentAcceptedAt,
    risk_consent_user_ip: clientIp(req),
  }, connectionName);

  const { error: accountError } = await context.admin.from("social_accounts").insert({
    id: socialAccountId,
    user_id: context.user.id,
    workspace_id: workspaceId,
    platform: "whatsapp",
    platform_user_id: `pending_${socialAccountId}`,
    platform_username: connectionName,
    access_token: "",
    connection_mode: "evolution_qr",
    account_metadata: metadata,
    is_active: false,
  });
  if (accountError) throw accountError;

  const { error: instanceError } = await context.admin.from("whatsapp_evolution_instances").insert({
    social_account_id: socialAccountId,
    instance_name: instanceName,
    jwt_key: jwtKey,
  });
  if (instanceError) {
    await removeProvisionedAccount(context.admin, socialAccountId);
    throw instanceError;
  }

  const api = createEvolutionApi();
  let evolutionCreated = false;
  try {
    await api.createInstance({
      instanceName,
      webhook: {
        url: `${context.webhookBaseUrl}/functions/v1/whatsapp-evolution-webhook`,
        headers: { jwt_key: jwtKey },
        events: EVOLUTION_EVENTS,
      },
    });
    evolutionCreated = true;
    const connection = await api.connect(instanceName);
    const qr = extractQr(connection);
    const state = extractState(connection);
    const { error: qrError } = await context.admin
      .from("whatsapp_evolution_instances")
      .update({ last_qr: qr, last_connection_state: state })
      .eq("social_account_id", socialAccountId);
    if (qrError) throw qrError;
    return { success: true, social_account_id: socialAccountId, qr, state };
  } catch (error) {
    if (evolutionCreated) {
      await api.deleteInstance(instanceName).catch(() => undefined);
    }
    await removeProvisionedAccount(context.admin, socialAccountId);
    throw error;
  }
}

function importHistory(admin: any, account: any, instanceName: string): ReturnType<typeof importEvolutionHistory> {
  return importEvolutionHistory({ admin, api: createEvolutionApi(), account, instanceName });
}

// Auto-import runs until one sweep succeeds and then stops, so the 2s status poll does not
// re-import 300 chats forever. A retry is still possible while last_sync_at is unset, which
// is what makes an early sweep against a half-warmed Baileys session recoverable.
async function autoImportHistory(admin: any, account: any, instance: EvolutionInstanceRow): Promise<void> {
  if (instance.last_sync_at) return;
  await importHistory(admin, account, instance.instance_name);
}

async function syncPastChats(admin: any, userId: string, body: BridgeBody) {
  if (!body.social_account_id) throw new BridgeError("social_account_id is required", 400);
  const account = await findOwnedAccount(admin, userId, body.social_account_id);
  const instance = await findInstance(admin, body.social_account_id);
  await runInBackground("whatsapp history sync", () => importHistory(admin, account, instance.instance_name));
  return { success: true, message: "Importing your WhatsApp conversations" };
}

// The sweep outlives the request that started it, so the setup page polls this until
// finished_at moves past the value it saw before pressing the button.
async function getSyncStatus(admin: any, userId: string, body: BridgeBody) {
  if (!body.social_account_id) throw new BridgeError("social_account_id is required", 400);
  await findOwnedAccount(admin, userId, body.social_account_id);
  const instance = await findInstance(admin, body.social_account_id);
  return {
    success: true,
    social_account_id: body.social_account_id,
    sync_running: instance.sync_started_at !== null,
    last_sync_at: instance.last_sync_at,
    last_sync_outcome: instance.last_sync_outcome,
  };
}

// One-time repair for instances paired before MESSAGES_UPDATE was subscribed: same URL,
// same jwt_key header, the full current event list.
async function resubscribeWebhook(context: Awaited<ReturnType<typeof authenticateRequest>>, body: BridgeBody) {
  if (!body.social_account_id) throw new BridgeError("social_account_id is required", 400);
  await findOwnedAccount(context.admin, context.user.id, body.social_account_id);
  const instance = await findInstance(context.admin, body.social_account_id);
  await createEvolutionApi().setWebhook(instance.instance_name, {
    url: `${context.webhookBaseUrl}/functions/v1/whatsapp-evolution-webhook`,
    headers: { jwt_key: instance.jwt_key },
    events: EVOLUTION_EVENTS,
  });
  return { success: true, social_account_id: body.social_account_id, events: EVOLUTION_EVENTS };
}

// The webhook is the primary activation path; this keeps a dropped delivery from
// leaving an already-linked session permanently inactive in Postora. The decision
// tree itself lives in qrStatus.ts so the mismatch contract stays in one place.
async function getQrStatus(admin: any, userId: string, body: BridgeBody) {
  if (!body.social_account_id) throw new BridgeError("social_account_id is required", 400);
  const account = await findOwnedAccount(admin, userId, body.social_account_id);
  const instance = await findInstance(admin, body.social_account_id);
  const api = createEvolutionApi();
  return await getQrStatusResult({
    ...buildQrStatusDeps(admin, { userId }, api),
    autoImport: (linked, instanceRow) =>
      // instanceRow is the same row passed in as input; qrStatus only narrows its type.
      runInBackground("whatsapp history sync", () => autoImportHistory(admin, linked, instanceRow as EvolutionInstanceRow)),
  }, { account, instance, refreshQr: body.refresh_qr === true });
}

// Deps for the setup-move actions. Ownership uses the any-mode WhatsApp lookup and
// the RPCs run through the service-role client: both owner-bound functions are SECURITY
// DEFINER and service_role-only, and they enforce owner/same-workspace in SQL.
function moveSetupDeps(context: Awaited<ReturnType<typeof authenticateRequest>>): MoveSetupDeps {
  return {
    findOwnedWhatsAppAccount: (userId, id) => findOwnedWhatsAppAccount(context.admin, userId, id),
    rpc: async (name, args) => {
      const { data, error } = await context.admin.rpc(name, args);
      return { data, error };
    },
    // Refusals go to system_logs so /admin/logs can explain a move the owner saw do nothing.
    logRefusal: async (refusal) => {
      const { error } = await context.admin.from("system_logs").insert({
        level: "info",
        category: "system",
        source: "whatsapp-evolution-bridge",
        message: "WhatsApp setup move refused",
        user_id: refusal.userId,
        metadata: { action: refusal.action, from: refusal.from, to: refusal.to, code: refusal.code },
      });
      if (error) throw new Error(error.message ?? "system_logs insert failed");
    },
  };
}

// Delegates to the shared teardown: whatsapp-oauth's "disconnect" action and this
// action must not grow two different notions of what disconnecting an Evolution
// account means. Nothing in the frontend calls this anymore, but a deployed n8n
// workflow or an external caller could still be hitting it, so the action stays.
async function logoutInstance(admin: any, userId: string, body: BridgeBody) {
  if (!body.social_account_id) throw new BridgeError("social_account_id is required", 400);
  const account = await findOwnedAccount(admin, userId, body.social_account_id);
  const teardown = await disconnectWhatsAppAccount(
    {
      accountId: account.id,
      // Legacy rows may predate workspace scoping; the module tolerates null there.
      workspaceId: account.workspace_id,
      connectionMode: "evolution_qr",
    },
    { admin: admin as unknown as WhatsAppDisconnectAdmin, evolution: createEvolutionApi() },
  );
  return { success: true, teardown };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleRestrictedCorsOptions(req);
  try {
    if (req.method !== "POST") return restrictedErrorResponse(req, "Method not allowed", 405);
    const context = await authenticateRequest(req);
    const body = await req.json() as BridgeBody;
    if (body.action === "create_and_get_qr") {
      return restrictedJsonResponse(req, await createAndGetQr(context, body, req));
    }
    if (body.action === "get_qr_status") {
      return restrictedJsonResponse(req, await getQrStatus(context.admin, context.user.id, body));
    }
    if (body.action === "reconnect_qr") {
      if (!body.social_account_id) throw new BridgeError("social_account_id is required", 400);
      try {
        return restrictedJsonResponse(req, await reconnectQr(
          buildReconnectDeps(
            context.admin,
            { userId: context.user.id, webhookBaseUrl: context.webhookBaseUrl },
            createEvolutionApi(),
          ),
          context.user.id,
          body.social_account_id,
        ));
      } catch (error) {
        if (error instanceof ReconnectError) throw new BridgeError(error.message, error.status);
        throw error;
      }
    }
    if (body.action === "sync_past_chats") {
      return restrictedJsonResponse(req, await syncPastChats(context.admin, context.user.id, body));
    }
    if (body.action === "get_sync_status") {
      return restrictedJsonResponse(req, await getSyncStatus(context.admin, context.user.id, body));
    }
    if (body.action === "resubscribe_webhook") {
      return restrictedJsonResponse(req, await resubscribeWebhook(context, body));
    }
    if (body.action === "move_setup") {
      if (!body.from || !body.to) throw new BridgeError("from and to are required", 400);
      try {
        return restrictedJsonResponse(req, await moveSetup(moveSetupDeps(context), context.user.id, {
          from: body.from,
          to: body.to,
          choices: body.choices,
        }));
      } catch (error) {
        if (error instanceof MoveSetupError) throw new BridgeError(error.code, error.status);
        throw error;
      }
    }
    if (body.action === "dismiss_setup_move") {
      if (!body.from || !body.to) throw new BridgeError("from and to are required", 400);
      try {
        return restrictedJsonResponse(req, await dismissSetupMove(moveSetupDeps(context), context.user.id, {
          from: body.from,
          to: body.to,
        }));
      } catch (error) {
        if (error instanceof MoveSetupError) throw new BridgeError(error.code, error.status);
        throw error;
      }
    }
    if (body.action === "logout_instance") {
      return restrictedJsonResponse(req, await logoutInstance(context.admin, context.user.id, body));
    }
    throw new BridgeError("Unknown action", 400);
  } catch (error) {
    if (error instanceof BridgeError) return restrictedErrorResponse(req, error.message, error.status);
    console.error("[whatsapp-evolution-bridge] Request failed:", error instanceof Error ? error.message : "unknown error");
    return restrictedErrorResponse(req, "Direct QR connection failed", 500);
  }
});
