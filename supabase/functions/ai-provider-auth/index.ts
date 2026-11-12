import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getModels } from "npm:@mariozechner/pi-ai@0.73.1";
import { getOAuthProviders as listOAuthProviderIds } from "npm:@mariozechner/pi-ai@0.73.1/oauth";
import { authenticateCaller } from "../_shared/auth-helper.ts";
import {
  handleRestrictedCorsOptions,
  restrictedCorsHeaders,
  restrictedErrorResponse,
  restrictedJsonResponse,
} from "../_shared/cors.ts";
import { callPiOAuth, defaultPiCallDeps } from "../_shared/aiOAuth/piCall.ts";
import { defaultCredentialDeps, getFreshOAuthCredential } from "../_shared/aiOAuth/credentials.ts";
import { finishLogin, startLogin } from "../_shared/aiOAuth/loginFlow.ts";
import { isAiProviderOAuthEnabled } from "../_shared/aiOAuth/flag.ts";
import { AiOAuthError } from "../_shared/aiOAuth/errors.ts";
import { type OAuthProviderId } from "../_shared/aiOAuth/clients.ts";
import { handle, type HandlerDeps, type OAuthStatusRow } from "./handler.ts";

// This function authenticates in-handler via authenticateCaller and keeps the
// gateway's JWT verification, exactly like higgsfield-oauth
// (supabase/config.toml [functions.higgsfield-oauth] verify_jwt = true).
// The matching [functions.ai-provider-auth] verify_jwt = true entry is in
// config.toml, so the two stay in lockstep.

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return handleRestrictedCorsOptions(req);
  if (req.method !== "POST") return restrictedErrorResponse(req, "Method not allowed", 405);

  let caller: { userId: string };
  try {
    caller = await authenticateCaller(req);
  } catch {
    return restrictedErrorResponse(req, "Unauthorized", 401);
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  // Service role only: the connection table and RPCs are revoked from every
  // other role, so the browser can never read a credential (spec §8).
  const admin = createClient(supabaseUrl, serviceKey);

  const loginDeps = { admin: admin as never, fetch: globalThis.fetch, now: () => Date.now() };

  const deps: HandlerDeps = {
    isAdmin: async (userId) => {
      const { data, error } = await admin.from("user_roles")
        .select("role").eq("user_id", userId).eq("role", "admin").maybeSingle();
      return !error && !!data;
    },
    oauthEnabled: async () => isAiProviderOAuthEnabled(admin as never),
    listOAuthProviders: () => listOAuthProviderIds().map((provider) => provider.id),
    listModels: (oauthProvider) => {
      try {
        // Infrastructure seam (ARCHITECTURE §31): pi-ai types the provider key
        // as a narrow KnownProvider union; the registry seam keeps it a string.
        return getModels(oauthProvider as never).map((m) => m.id);
      } catch {
        return [];
      }
    },
    providerInfo: async (providerCode) => {
      const { data, error } = await admin.from("ai_providers")
        .select("name, is_active").eq("provider_code", providerCode).maybeSingle();
      if (error) throw new Error("AI provider read failed");
      return {
        name: (data?.name as string | undefined) ?? null,
        active: data?.is_active === true,
      };
    },
    statuses: async () => {
      // A failed read must not look like "nothing connected": the admin would
      // see every subscription as disconnected. Throwing surfaces a 500.
      const { data, error } = await admin.rpc("get_ai_oauth_statuses");
      if (error) throw new Error("OAuth status read failed");
      return (data ?? []) as OAuthStatusRow[];
    },
    start: (provider: OAuthProviderId, userId) => startLogin(loginDeps, provider, userId),
    finish: (provider: OAuthProviderId, pasted: string, userId) =>
      finishLogin(loginDeps, provider, pasted, userId),
    disconnect: async (provider) => {
      // Reporting not_connected after a failed delete would leave a live
      // credential the admin believes is gone.
      const { error } = await admin.rpc("delete_ai_oauth_connection", { p_oauth_provider: provider });
      if (error) throw new Error("OAuth disconnect failed");
    },
    test: async (provider, modelId) => {
      const startedAt = Date.now();
      try {
        const credentials = defaultCredentialDeps(admin as never);
        const { apiKey } = await getFreshOAuthCredential(credentials, provider);
        const response = await callPiOAuth(
          defaultPiCallDeps(),
          provider,
          modelId,
          { messages: [{ role: "user", content: "Reply with OK" }] },
          apiKey,
          20_000,
        );
        const latency_ms = Date.now() - startedAt;
        if (!response.ok) {
          // callPiOAuth already redacted the provider text against the api key.
          // Surface the message only, never the raw envelope.
          const raw = await response.text().catch(() => "");
          let message = raw.slice(0, 300);
          try {
            const parsed = JSON.parse(raw) as { error?: { message?: string } };
            if (typeof parsed.error?.message === "string") message = parsed.error.message.slice(0, 300);
          } catch {
            // Not JSON: the truncated text is already redacted.
          }
          return { ok: false, latency_ms, error: message };
        }
        return { ok: true, latency_ms };
      } catch (cause) {
        // The credential error codes are stable and safe to surface; anything
        // else stays generic and carries no token.
        const code = cause instanceof AiOAuthError ? cause.code : "test_failed";
        return {
          ok: false,
          latency_ms: Date.now() - startedAt,
          error: code,
        };
      }
    },
    logRefusal: async ({ action, reason, userId }) => {
      const { error } = await admin.from("system_logs").insert({
        level: "warn",
        category: "ai",
        source: "ai-provider-auth",
        message: "refused",
        user_id: userId,
        metadata: { action, reason },
      });
      if (error) console.warn({ event: "ai_provider_auth_log_failed", action, reason });
    },
  };

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return restrictedJsonResponse(req, { error: "invalid_json" }, 400);
  }

  try {
    const response = await handle(body, { userId: caller.userId }, deps);
    return new Response(response.body, {
      status: response.status,
      headers: { ...restrictedCorsHeaders(req), "content-type": "application/json" },
    });
  } catch (cause) {
    console.warn({
      event: "ai_provider_auth_failed",
      reason: cause instanceof Error ? cause.message : "unknown",
    });
    return restrictedErrorResponse(req, "Internal error", 500);
  }
});
