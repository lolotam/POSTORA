import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import {
  HIGGSFIELD_PROVIDER_CODE,
  HiggsfieldAuthError,
  buildAuthorizeUrl,
  codeChallengeS256,
  consumeOAuthState,
  exchangeCode,
  generateCodeVerifier,
  generateState,
  getOrRegisterClient,
  getValidAccessToken,
  loadConnection,
  persistTokens,
} from "../_shared/higgsfield-oauth.ts";
import { HiggsfieldMcpClient } from "../_shared/higgsfield-mcp.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const CALLBACK_PATH = "/admin/oauth/higgsfield/callback";
const REDIRECT_URI = "https://postora.cloud/admin/oauth/higgsfield/callback";
const ALLOWED_REDIRECT_HOSTS = new Set(["postora.cloud", "www.postora.cloud"]);
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function validateRedirectUri(raw: unknown): string | null {
  const candidate = typeof raw === "string" && raw ? raw : REDIRECT_URI;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.pathname !== CALLBACK_PATH) return null;
  if (url.search || url.hash) return null;
  if (url.protocol !== "https:" && !isLoopback(url.hostname)) return null;
  if (!ALLOWED_REDIRECT_HOSTS.has(url.hostname) && !isLoopback(url.hostname)) return null;
  return url.toString();
}

function safeReturnTo(raw: unknown, scope: "platform" | "user"): string {
  const fallback = scope === "platform" ? "/admin/settings" : "/settings";
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("://") || raw.includes("\\")) {
    return fallback;
  }
  return raw;
}

function isAdmin(db: any, userId: string) {
  return db
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle()
    .then((r: any) => !r.error && !!r.data);
}
function catalog(payload: any) {
  const items = Array.isArray(payload?.items)
    ? payload.items
    : Array.isArray(payload)
      ? payload
      : [];
  const keys = [
    "parameters",
    "aspect_ratios",
    "durations",
    "duration_range",
    "medias",
    "tags",
    "supports_unlim",
    "output_type",
    "provider_name",
  ];
  return items
    .filter((x: any) => x && typeof x.id === "string")
    .map((x: any) => ({
      id: x.id,
      name: x.name,
      description: x.description,
      metadata: Object.fromEntries(keys.filter((k) => x[k] !== undefined).map((k) => [k, x[k]])),
    }));
}

async function syncHiggsfieldCatalog(db: any) {
  const { data: provider } = await db
    .from("ai_providers")
    .select("id")
    .eq("provider_code", HIGGSFIELD_PROVIDER_CODE)
    .maybeSingle();
  if (!provider) throw new Error("Higgsfield provider row is missing");
  await getValidAccessToken(db);
  const mcp = await HiggsfieldMcpClient.create(db);
  const found = new Map<string, any>();
  for (const capability of ["video", "image"] as const) {
    for (const model of catalog(
      await mcp.callTool("models_explore", { action: "list", type: capability, limit: 100 }),
    )) {
      found.set(model.id, { model, capability });
    }
  }
  if (!found.size) throw new Error("Higgsfield returned an empty model catalog");
  for (const [model_id, x] of found) {
    await db.from("ai_models").upsert(
      {
        provider_id: provider.id,
        model_id,
        name: x.model.name || model_id,
        description: x.model.description ?? null,
        capabilities: [x.capability],
        metadata: x.model.metadata,
        is_active: true,
      },
      { onConflict: "provider_id,model_id" },
    );
  }
  const { data: stale } = await db
    .from("ai_models")
    .select("id, model_id")
    .eq("provider_id", provider.id)
    .eq("is_active", true);
  const ids = (stale ?? []).filter((x: any) => !found.has(x.model_id)).map((x: any) => x.id);
  if (ids.length) await db.from("ai_models").update({ is_active: false }).in("id", ids);
  return { discovered: found.size, activated: found.size, deactivated: ids.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  // Authenticate before the main try, so a missing or expired token answers 401
  // instead of falling into the outer catch and being reported as a 500.
  let caller: { userId: string };
  try {
    caller = await authenticateCaller(req, null);
  } catch {
    return json({ error: "Unauthorized" }, 401);
  }
  try {
    const body = await req.json().catch(() => ({}));
    const db = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const admin = await isAdmin(db, caller.userId);
    const action = body.action || "status";
    const scope = body.scope_kind === "platform" ? "platform" : "user";

    if (action === "authorize_url") {
      if (scope === "platform" && !admin) return json({ error: "Admin access required" }, 403);
      const redirectUri = validateRedirectUri(body.redirect_uri);
      if (!redirectUri) return json({ error: "Invalid redirect_uri" }, 400);
      const client = await getOrRegisterClient(db, redirectUri);
      const verifier = generateCodeVerifier(),
        state = generateState();
      const { error } = await db.from("oauth_states").insert({
        state,
        provider_code: HIGGSFIELD_PROVIDER_CODE,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        scope_kind: scope,
        user_id: scope === "user" ? caller.userId : null,
        return_to: safeReturnTo(body.return_to, scope),
      });
      if (error) return json({ error: "Could not start OAuth flow" }, 500);
      return json({
        success: true,
        url: await buildAuthorizeUrl({
          client,
          redirectUri,
          state,
          codeChallenge: await codeChallengeS256(verifier),
        }),
      });
    }
    if (action === "callback") {
      if (typeof body.code !== "string" || typeof body.state !== "string")
        return json({ error: "Missing code or state" }, 400);
      const state = await consumeOAuthState(db, body.state, undefined, caller.userId, admin);
      if (!state)
        return json({ error: "Unknown, expired, or unauthorized authorization state" }, 400);
      const client = await getOrRegisterClient(db, state.redirect_uri);
      const tokens = await exchangeCode({
        client,
        code: body.code,
        codeVerifier: state.code_verifier,
        redirectUri: state.redirect_uri,
      });
      if (state.scope_kind === "platform")
        await persistTokens(db, tokens, {
          redirectUri: state.redirect_uri,
          createdBy: caller.userId,
          previous: await loadConnection(db),
        });
      else {
        const { error } = await db.from("higgsfield_connections").upsert(
          {
            user_id: state.user_id,
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            expires_at: tokens.expires_at,
            scope: tokens.scope,
            account_id: tokens.account_id,
            account_email: tokens.account_email,
            meta: { redirect_uri: state.redirect_uri },
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id" },
        );
        if (error) throw new Error(`Failed to store connection: ${error.message}`);
      }
      let synced: { discovered: number; activated: number; deactivated: number } | null = null;
      let sync_error: string | null = null;
      if (state.scope_kind === "platform") {
        try {
          synced = await syncHiggsfieldCatalog(db);
        } catch (err) {
          sync_error = err instanceof Error ? err.message : "Model sync failed";
          console.error("[higgsfield-oauth] post-connect sync failed:", sync_error);
        }
      }
      return json({
        success: true,
        connected: true,
        account_id: tokens.account_id,
        expires_at: tokens.expires_at,
        scope: tokens.scope,
        scope_kind: state.scope_kind,
        return_to: state.return_to || safeReturnTo(null, state.scope_kind),
        synced,
        sync_error,
      });
    }
    if (action === "status") {
      const platform = await loadConnection(db);
      // Read the table, not the higgsfield_connection_status view: that view is scoped by
      // `WHERE user_id = auth.uid()`, and `db` holds the service role, under which auth.uid()
      // is NULL. Through the view every user -- including one whose tokens were stored a
      // second earlier -- read back as disconnected. Only non-secret columns are selected.
      const { data: byoRow, error: byoError } = await db
        .from("higgsfield_connections")
        .select("account_email, expires_at")
        .eq("user_id", caller.userId)
        .maybeSingle();
      if (byoError) throw new Error(`Could not read connection: ${byoError.message}`);
      const byo = byoRow ? { ...byoRow, connected: true } : null;
      let platformConnected = !!(platform?.access_token || platform?.refresh_token);
      if (platformConnected) {
        try {
          await getValidAccessToken(db);
        } catch (e) {
          if (e instanceof HiggsfieldAuthError) platformConnected = false;
          else throw e;
        }
      }
      const platformStatus = {
        connected: platformConnected,
        account_id: platformConnected ? (platform?.account_id ?? null) : null,
        expires_at: platformConnected ? (platform?.expires_at ?? null) : null,
        scope: platformConnected ? (platform?.scope ?? null) : null,
      };
      const userStatus = byo ?? { connected: false, account_email: null, expires_at: null };
      const scoped =
        scope === "platform"
          ? {
              connected: platformStatus.connected,
              account_id: platformStatus.account_id,
              expires_at: platformStatus.expires_at,
              scope: platformStatus.scope,
            }
          : {
              connected: !!userStatus.connected,
              account_id: userStatus.account_email ?? null,
              expires_at: userStatus.expires_at ?? null,
              scope: null,
            };
      return json({
        success: true,
        ...scoped,
        platform: platformStatus,
        user: userStatus,
      });
    }
    if (action === "disconnect") {
      if (scope === "platform" && !admin) return json({ error: "Admin access required" }, 403);
      const table = scope === "platform" ? "provider_api_keys" : "higgsfield_connections";
      let q = db.from(table).delete();
      q =
        scope === "platform"
          ? q.eq("provider_code", HIGGSFIELD_PROVIDER_CODE)
          : q.eq("user_id", caller.userId);
      const { error } = await q;
      if (error) throw new Error(`Could not disconnect: ${error.message}`);
      return json({ success: true, connected: false, revoked: false });
    }
    if (action === "sync_models") {
      if (!admin) return json({ error: "Admin access required" }, 403);
      const result = await syncHiggsfieldCatalog(db);
      return json({ success: true, ...result });
    }
    return json({ error: `Unknown action: ${action}` }, 400);
  } catch (e) {
    if (e instanceof HiggsfieldAuthError) return json({ error: e.message, code: e.code }, 409);
    console.error("[higgsfield-oauth]", e);
    return json({ error: e instanceof Error ? e.message : "Unexpected error" }, 500);
  }
});
