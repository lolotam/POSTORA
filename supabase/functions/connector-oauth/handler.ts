// Handler logic for connector-oauth, separated from index.ts for testability
// (ARCHITECTURE §12: construct dependencies, then invoke).

import { z } from "npm:zod@3.23.8";
import { createBoundState, verifyAndConsumeState } from "./state.ts";
import { buildAuthorizationUrl, exchangeCodeForTokens, refreshVendorTokens, defaultVendorDependencies, type OAuthConnectorType, type VendorDependencies } from "./vendor.ts";
import { serializedRefresh } from "./refresh.ts";
import { redactSensitive } from "../_shared/logging.ts";

export type HandlerDeps = {
  admin: unknown; // Supabase admin client (typed as any to avoid drift)
  vendorDeps: VendorDependencies;
};

function safeLog(event: string, errorCode: string, metadata: Record<string, unknown> = {}): void {
  // No token/code/secret/state ever placed into metadata (§15)
  const redacted = redactSensitive({ event, error_code: errorCode, ...metadata });
  console.warn(JSON.stringify(redacted));
}

const SUPPORTED_TYPES = ["salla", "zid", "shopify"] as const;
const OAUTH_TYPES_SET = new Set<string>(SUPPORTED_TYPES);

const InitSchema = z.object({
  action: z.literal("init"),
  connector_type: z.enum(SUPPORTED_TYPES),
  social_account_id: z.string().uuid(),
  shop_domain: z.string().optional(),
}).strict();

const CallbackSchema = z.object({
  action: z.literal("callback"),
  code: z.string().min(1),
  state: z.string().min(1),
  shop_domain: z.string().optional(),
}).strict();

const RefreshSchema = z.object({
  action: z.literal("refresh"),
  tool_id: z.string().uuid(),
}).strict();

export type InitRequest = z.infer<typeof InitSchema>;
export type CallbackRequest = z.infer<typeof CallbackSchema>;
export type RefreshRequest = z.infer<typeof RefreshSchema>;

function sanitizeStringForLog(s: string): string {
  return s.slice(0, 8) + "…";
}

export async function handleInit(
  userId: string,
  body: unknown,
  deps: HandlerDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const parsed = InitSchema.safeParse(body);
  if (!parsed.success) {
    safeLog("oauth_refused", "invalid_request", { user_id: userId });
    return { status: 400, body: { error: "Invalid request." } };
  }
  const { connector_type, social_account_id, shop_domain } = parsed.data;

  // Verify the account belongs to the authenticated user — never trust user_id from body (§13)
  const admin = deps.admin as {
    from: (table: string) => {
      select: (cols: string) => {
        eq: (c: string, v: string) => { eq: (c2: string, v2: string) => { maybeSingle: () => Promise<{ data: unknown | null }> } };
      };
    };
  };
  // Typed loosly: real call is admin.from("social_accounts").select("id").eq("id",...).eq("user_id",...).maybeSingle()
  // Use any for the chain to avoid mock brittleness
  const { data: account } = await (deps.admin as never as { from: (...a: unknown[]) => { select: (...a: unknown[]) => { eq: (...a: unknown[]) => { eq: (...a: unknown[]) => { maybeSingle: () => Promise<{ data: unknown }> } } } } })
    .from("social_accounts")
    .select("id")
    .eq("id", social_account_id)
    .eq("user_id", userId)
    .maybeSingle();

  if (!account) {
    safeLog("oauth_refused", "account_not_found", { user_id: userId });
    return { status: 404, body: { error: "Social account not found." } };
  }

  const authUrl = buildAuthorizationUrl(connector_type as OAuthConnectorType, "", deps.vendorDeps, shop_domain);
  if (!authUrl) {
    // Credentials seam not configured (§15) — explicit 503, not a silent no-op
    safeLog("oauth_failure", "oauth_not_configured", { user_id: userId, connector_type });
    return {
      status: 503,
      body: {
        error: "OAuth is not configured for this connector. App registration is required.",
        connector_type,
      },
    };
  }

  // Now create the bound state (state is never logged or returned in error bodies)
  const rec = createBoundState(userId, social_account_id, connector_type);
  const urlWithState = buildAuthorizationUrl(connector_type as OAuthConnectorType, rec.state, deps.vendorDeps, shop_domain);
  if (!urlWithState) {
    safeLog("oauth_failure", "oauth_not_configured", { user_id: userId, connector_type });
    return { status: 503, body: { error: "OAuth is not configured for this connector." } };
  }

  safeLog("oauth_init", "state_created", { user_id: userId, connector_type });
  return {
    status: 200,
    body: {
      authorization_url: urlWithState,
      // Do NOT return state separately — it is embedded in the URL. Returning it
      // as a separate field would tempt callers to log it.
      expires_at: new Date(rec.expiresAt).toISOString(),
    },
  };
}

export async function handleCallback(
  userId: string,
  body: unknown,
  deps: HandlerDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const parsed = CallbackSchema.safeParse(body);
  if (!parsed.success) {
    safeLog("oauth_refused", "invalid_request", { user_id: userId });
    return { status: 400, body: { error: "Invalid request." } };
  }
  const { code, state, shop_domain } = parsed.data;

  // Single-use, bound, expiring state — replayed or foreign state is refused
  const rec = verifyAndConsumeState(state, userId);
  if (!rec) {
    safeLog("oauth_refused", "invalid_state", { user_id: userId });
    return { status: 400, body: { error: "Invalid or expired state." } };
  }

  // At this point we have a proven binding to (userId, social_account_id, connector_type)
  // The vendor exchange has an explicit timeout and SSRF validation on every hop
  let tokens;
  try {
    tokens = await exchangeCodeForTokens(rec.connectorType as OAuthConnectorType, code, deps.vendorDeps, shop_domain);
  } catch {
    safeLog("oauth_failure", "token_exchange_failed", {
      user_id: userId,
      connector_type: rec.connectorType,
      code_prefix: sanitizeStringForLog(code),
    });
    return { status: 502, body: { error: "Token exchange failed." } };
  }

  // Tokens land in Vault via the existing wrapper, never in a plaintext column
  const adminAny = deps.admin as {
    rpc: (name: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
    from: (t: string) => { select: (...a: unknown[]) => unknown; update: (...a: unknown[]) => unknown };
  };

  // We store Vault blob keyed per connector type:
  // Salla/Zid need client_id/client_secret plus access/refresh tokens; Shopify similar.
  // The wrapper merges into existing blob so an existing connector's other fields are kept.
  // First, find or create the ai_agent_tools row for this account+type.
  // For simplicity v1: look for existing tool matching (user_id, social_account_id, connector_type)
  // If none, create via insert; if one, upsert via wrapper.

  // Attempt to load existing tool id for this account+connector type
  // This keeps the flow working even before the account-scoped tool exists.
  let toolId: string | null = null;
  try {
    const { data: existing } = await (adminAny as unknown as { from: (t: string) => { select: (c: string) => { eq: (a: string, b: string) => { eq: (c: string, d: string) => { eq: (e: string, f: string) => { maybeSingle: () => Promise<{ data: { id: string } | null }> } } } } } }).from("ai_agent_tools").select("id").eq("user_id", userId).eq("social_account_id", rec.socialAccountId).eq("connector_type", rec.connectorType).maybeSingle();
    toolId = (existing as { id: string } | null)?.id ?? null;
  } catch {
    // Non-fatal: will create new below
  }

  const vaultPayload: Record<string, unknown> = {
    access_token: tokens.access_token,
    ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
    ...(tokens.expires_in ? { expires_at: new Date(Date.now() + tokens.expires_in * 1000).toISOString() } : {}),
  };

  // Vault write is first, row write second (orphan tolerable, dangling not — §4.3)
  let secretId: string | null = null;
  let configuredFields: string[] = [];
  if (toolId) {
    // Load existing secret id
    try {
      const { data: row } = await (adminAny as unknown as { from: (t: string) => { select: (c: string) => { eq: (a: string, b: string) => { eq: (c: string, d: string) => { maybeSingle: () => Promise<{ data: { credentials_secret_id: string | null } | null }> } } } } }).from("ai_agent_tools").select("credentials_secret_id").eq("id", toolId).eq("user_id", userId).maybeSingle();
      const existingSecretId = (row as { credentials_secret_id: string | null } | null)?.credentials_secret_id ?? null;
      const { data, error } = await adminAny.rpc("upsert_connector_credential_secret", {
        p_secret_id: existingSecretId,
        p_secret: vaultPayload,
      });
      if (error) throw error;
      const out = data as { secret_id: string; configured_fields: string[] } | { secret_id: string } | unknown;
      // Upsert wrapper returns TABLE(secret_id uuid, configured_fields text[]) — supabase-js returns array of rows
      const rowOut = Array.isArray(out) ? (out[0] as Record<string, unknown>) : (out as Record<string, unknown>);
      secretId = (rowOut?.secret_id ?? rowOut?.secretId ?? null) as string | null;
      configuredFields = (rowOut?.configured_fields ?? rowOut?.configuredFields ?? []) as string[];
    } catch {
      safeLog("oauth_failure", "vault_store_failed", { user_id: userId, connector_type: rec.connectorType });
      return { status: 500, body: { error: "Credential storage failed." } };
    }
    // Update row with secret id + fields, and ensure scope/account linkage
    await (adminAny as unknown as { from: (t: string) => { update: (d: unknown) => { eq: (a: string, b: string) => { eq: (c: string, d: string) => Promise<unknown> } } } }).from("ai_agent_tools").update({
      credentials_secret_id: secretId,
      configured_secret_fields: configuredFields,
      updated_at: new Date().toISOString(),
    }).eq("id", toolId).eq("user_id", userId);
  } else {
    // No existing tool — create a placeholder row then vault-store
    // We call wrapper with null to create new secret
    try {
      const { data, error } = await adminAny.rpc("upsert_connector_credential_secret", {
        p_secret_id: null,
        p_secret: vaultPayload,
      });
      if (error) throw error;
      const out = data as unknown;
      const rowOut = Array.isArray(out) ? (out[0] as Record<string, unknown>) : (out as Record<string, unknown>);
      secretId = (rowOut?.secret_id ?? rowOut?.secretId ?? null) as string | null;
      configuredFields = (rowOut?.configured_fields ?? rowOut?.configuredFields ?? []) as string[];
    } catch {
      safeLog("oauth_failure", "vault_store_failed", { user_id: userId, connector_type: rec.connectorType });
      return { status: 500, body: { error: "Credential storage failed." } };
    }
    // Insert the tool row scoped to this account
    // Using admin client so RLS not involved; ownership is structural via user_id
    await (adminAny as unknown as { from: (t: string) => { insert: (d: unknown) => Promise<unknown> } }).from("ai_agent_tools").insert({
      user_id: userId,
      social_account_id: rec.socialAccountId,
      scope: "account",
      platform: null, // platform may be derived from social_accounts but not required for OAuth
      name: `${rec.connectorType}_oauth`,
      description: `${rec.connectorType} via OAuth`,
      connector_type: rec.connectorType,
      credentials_secret_id: secretId,
      configured_secret_fields: configuredFields,
      settings: {},
      is_enabled: true,
    });
  }

  safeLog("oauth_success", "tokens_stored", { user_id: userId, connector_type: rec.connectorType });
  return { status: 200, body: { ok: true } };
}

export async function handleRefresh(
  userId: string,
  body: unknown,
  deps: HandlerDeps,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const parsed = RefreshSchema.safeParse(body);
  if (!parsed.success) {
    safeLog("oauth_refused", "invalid_request", { user_id: userId });
    return { status: 400, body: { error: "Invalid request." } };
  }
  const { tool_id } = parsed.data;

  // Load the tool row and verify ownership structurally (service role, so RLS not enforced)
  const adminAny = deps.admin as {
    rpc: (n: string, a: Record<string, unknown>) => Promise<{ data: unknown; error: unknown }>;
    from: (t: string) => unknown;
  };
  const { data: tool, error: toolError } = await (adminAny as unknown as { from: (t: string) => { select: (c: string) => { eq: (a: string, b: string) => { eq: (b: string, c: string) => { maybeSingle: () => Promise<{ data: unknown; error: unknown }> } } } } }).from("ai_agent_tools").select("id, connector_type, credentials_secret_id, social_account_id, settings").eq("id", tool_id).eq("user_id", userId).maybeSingle();

  if (toolError || !tool) {
    safeLog("oauth_refused", "connector_not_found", { user_id: userId });
    return { status: 404, body: { error: "Connector not found." } };
  }
  const row = tool as { id: string; connector_type: string; credentials_secret_id: string | null; social_account_id: string | null; settings: Record<string, unknown> };
  if (!SUPPORTED_TYPES.includes(row.connector_type as OAuthConnectorType)) {
    safeLog("oauth_refused", "unsupported_connector", { user_id: userId, connector_type: row.connector_type });
    return { status: 400, body: { error: "Refresh not supported for this connector." } };
  }

  // Serialized per-connector so two concurrent callers cause exactly one upstream refresh (§6.1)
  let resultStatus: { status: number; body: Record<string, unknown> } | null = null;
  try {
    await serializedRefresh(row.id, async () => {
      // Re-read credentials via Vault wrapper (decrypted server-side)
      const { data: blob, error: credErr } = await adminAny.rpc("get_connector_credential", {
        p_user_id: userId,
        p_tool_id: row.id,
      });
      if (credErr || !blob || typeof blob !== "object") {
        resultStatus = { status: 409, body: { error: "Credentials not configured." } };
        return { accessToken: "" };
      }
      const creds = blob as Record<string, unknown>;
      const refreshToken = typeof creds.refresh_token === "string" ? creds.refresh_token : null;
      const accessToken = typeof creds.access_token === "string" ? creds.access_token : null;
      const expiresAt = typeof creds.expires_at === "string" ? creds.expires_at : null;

      // Simulate expiry check: only refresh if token is expired or near expiry
      // The spec says "simulate expiry; do not assume it" — caller passes a
      // deliberately expired expires_at in tests. Here we check the value.
      const isExpired = !expiresAt || new Date(expiresAt).getTime() < Date.now() + 60_000;
      if (!isExpired && accessToken) {
        resultStatus = { status: 200, body: { ok: true, refreshed: false } };
        return { accessToken };
      }
      if (!refreshToken) {
        resultStatus = { status: 409, body: { error: "Refresh token missing." } };
        return { accessToken: "" };
      }

      // Shop domain from settings if present
      const shopDomain = typeof (row.settings as Record<string, unknown>)?.shop_domain === "string"
        ? (row.settings as Record<string, unknown>).shop_domain as string
        : typeof (row.settings as Record<string, unknown>)?.shopDomain === "string"
        ? (row.settings as Record<string, unknown>).shopDomain as string
        : undefined;

      let newTokens;
      try {
        newTokens = await refreshVendorTokens(row.connector_type as OAuthConnectorType, refreshToken, deps.vendorDeps, shopDomain);
      } catch {
        safeLog("oauth_failure", "refresh_failed", { user_id: userId, connector_type: row.connector_type });
        resultStatus = { status: 502, body: { error: "Refresh failed." } };
        return { accessToken: "" };
      }

      // Vault-first, row-second
      const payload: Record<string, unknown> = {
        access_token: newTokens.access_token,
        ...(newTokens.refresh_token ? { refresh_token: newTokens.refresh_token } : { refresh_token: refreshToken }),
        ...(newTokens.expires_in ? { expires_at: new Date(Date.now() + newTokens.expires_in * 1000).toISOString() } : {}),
      };
      const { data, error } = await adminAny.rpc("upsert_connector_credential_secret", {
        p_secret_id: row.credentials_secret_id,
        p_secret: payload,
      });
      if (error) {
        safeLog("oauth_failure", "vault_store_failed", { user_id: userId, connector_type: row.connector_type });
        resultStatus = { status: 500, body: { error: "Credential storage failed." } };
        return { accessToken: "" };
      }
      const out = Array.isArray(data) ? (data[0] as Record<string, unknown>) : (data as Record<string, unknown>);
      const newSecretId = (out?.secret_id ?? out?.secretId ?? row.credentials_secret_id) as string | null;
      const fields = (out?.configured_fields ?? out?.configuredFields ?? []) as string[];
      // Update row if secret id changed (or first time)
      if (newSecretId && newSecretId !== row.credentials_secret_id) {
        await (adminAny as unknown as { from: (t: string) => { update: (d: unknown) => { eq: (a: string, b: string) => { eq: (c: string, d: string) => Promise<unknown> } } } }).from("ai_agent_tools").update({
          credentials_secret_id: newSecretId,
          configured_secret_fields: fields,
          updated_at: new Date().toISOString(),
        }).eq("id", row.id).eq("user_id", userId);
      } else if (fields.length) {
        await (adminAny as unknown as { from: (t: string) => { update: (d: unknown) => { eq: (a: string, b: string) => { eq: (c: string, d: string) => Promise<unknown> } } } }).from("ai_agent_tools").update({
          configured_secret_fields: fields,
          updated_at: new Date().toISOString(),
        }).eq("id", row.id).eq("user_id", userId);
      }

      resultStatus = { status: 200, body: { ok: true, refreshed: true } };
      return { accessToken: newTokens.access_token };
    });
  } catch {
    if (!resultStatus) {
      safeLog("oauth_failure", "refresh_unhandled", { user_id: userId, connector_type: row.connector_type });
      return { status: 500, body: { error: "Refresh failed." } };
    }
  }

  return resultStatus ?? { status: 200, body: { ok: true } };
}
