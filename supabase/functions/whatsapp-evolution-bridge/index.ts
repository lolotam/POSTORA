import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { handleRestrictedCorsOptions, restrictedErrorResponse, restrictedJsonResponse } from "../_shared/cors.ts";
import { createEvolutionApi, type EvolutionApi, type EvolutionEvent } from "../_shared/evolutionApi.ts";
import { syncEvolutionAccountConnection } from "../_shared/evolutionQrAccount.ts";
import { importEvolutionHistory } from "../_shared/whatsappSyncEngine.ts";
import { runInBackground } from "../_shared/background.ts";

const EVOLUTION_EVENTS: EvolutionEvent[] = [
  "MESSAGES_UPSERT",
  "CONNECTION_UPDATE",
  "QRCODE_UPDATED",
];

class BridgeError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "BridgeError";
  }
}

interface BridgeBody {
  action: "create_and_get_qr" | "get_qr_status" | "logout_instance" | "sync_past_chats";
  social_account_id?: string;
  workspace_id?: string;
  risk_consent?: boolean;
  refresh_qr?: boolean;
}

interface EvolutionInstanceRow {
  social_account_id: string;
  instance_name: string;
  jwt_key: string;
  last_qr: string | null;
  last_sync_at: string | null;
}

function clientIp(req: Request): string | null {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || req.headers.get("x-real-ip");
}

function extractQr(payload: any): string | null {
  const qr = payload?.qrcode || payload?.qr || payload;
  return qr?.base64 || qr?.image || qr?.code || null;
}

function extractState(payload: any): string | null {
  return payload?.instance?.state || payload?.state || payload?.connectionStatus || null;
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

  const { data: quota, error: quotaError } = await admin
    .from("user_quotas")
    .select("max_social_accounts")
    .eq("user_id", userId)
    .maybeSingle();
  if (quotaError) throw quotaError;
  const maximum = quota?.max_social_accounts ?? 3;
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
  const { data, error } = await admin
    .from("social_accounts")
    .select("id, user_id, workspace_id, platform, connection_mode, platform_user_id, platform_username, is_active")
    .eq("id", socialAccountId)
    .eq("user_id", userId)
    .eq("platform", "whatsapp")
    .maybeSingle();
  if (error) throw error;
  if (!data || data.connection_mode !== "evolution_qr") throw new BridgeError("WhatsApp Direct QR account not found", 404);
  return data;
}

async function findInstance(admin: any, socialAccountId: string): Promise<EvolutionInstanceRow> {
  const { data, error } = await admin
    .from("whatsapp_evolution_instances")
    .select("social_account_id, instance_name, jwt_key, last_qr, last_sync_at")
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

  const socialAccountId = crypto.randomUUID();
  const instanceName = `postora_${socialAccountId}`;
  const jwtKeyBytes = crypto.getRandomValues(new Uint8Array(32));
  const jwtKey = btoa(String.fromCharCode(...jwtKeyBytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const consentAcceptedAt = new Date().toISOString();
  const metadata = {
    connection_mode: "evolution_qr",
    risk_consent_accepted_at: consentAcceptedAt,
    risk_consent_user_ip: clientIp(req),
  };

  const { error: accountError } = await context.admin.from("social_accounts").insert({
    id: socialAccountId,
    user_id: context.user.id,
    workspace_id: workspaceId,
    platform: "whatsapp",
    platform_user_id: `pending_${socialAccountId}`,
    platform_username: null,
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

function importHistory(admin: any, account: any, instanceName: string): Promise<void> {
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

// The webhook is the primary activation path; this keeps a dropped delivery from
// leaving an already-linked session permanently inactive in Postora.
async function reconcileAccountConnection(reconciliation: {
  admin: any;
  api: EvolutionApi;
  account: { id: string; platform_user_id: string; is_active: boolean };
  instanceName: string;
  state: string;
}): Promise<void> {
  const { admin, api, account, instanceName } = reconciliation;
  const connection = reconciliation.state.toLowerCase();
  if (connection === "open") {
    if (account.is_active && !account.platform_user_id.startsWith("pending_")) return;
    await syncEvolutionAccountConnection(admin, account, connection, await api.fetchInstance(instanceName));
    return;
  }
  if (connection === "close" && account.is_active) {
    await syncEvolutionAccountConnection(admin, account, connection, null);
  }
}

async function getQrStatus(admin: any, userId: string, body: BridgeBody) {
  if (!body.social_account_id) throw new BridgeError("social_account_id is required", 400);
  const account = await findOwnedAccount(admin, userId, body.social_account_id);
  const instance = await findInstance(admin, body.social_account_id);
  const api = createEvolutionApi();
  let qr = instance.last_qr;
  if (body.refresh_qr) {
    qr = extractQr(await api.connect(instance.instance_name));
    await admin.from("whatsapp_evolution_instances").update({ last_qr: qr }).eq("social_account_id", body.social_account_id);
  }
  const statePayload = await api.connectionState(instance.instance_name);
  const state = extractState(statePayload);
  if (state) {
    await admin.from("whatsapp_evolution_instances").update({ last_connection_state: state }).eq("social_account_id", body.social_account_id);
    await reconcileAccountConnection({ admin, api, account, instanceName: instance.instance_name, state });
    if (state.toLowerCase() === "open") {
      await runInBackground("whatsapp history sync", () => autoImportHistory(admin, account, instance));
    }
  }
  return { success: true, social_account_id: body.social_account_id, qr, state };
}

async function logoutInstance(admin: any, userId: string, body: BridgeBody) {
  if (!body.social_account_id) throw new BridgeError("social_account_id is required", 400);
  const account = await findOwnedAccount(admin, userId, body.social_account_id);
  const instance = await findInstance(admin, body.social_account_id);
  await createEvolutionApi().logout(instance.instance_name);
  const { error } = await admin
    .from("social_accounts")
    .update({ is_active: false })
    .eq("id", account.id)
    .eq("user_id", userId);
  if (error) throw error;
  await admin.from("whatsapp_evolution_instances")
    .update({ last_connection_state: "close", last_qr: null })
    .eq("social_account_id", account.id);
  return { success: true };
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
    if (body.action === "sync_past_chats") {
      return restrictedJsonResponse(req, await syncPastChats(context.admin, context.user.id, body));
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
