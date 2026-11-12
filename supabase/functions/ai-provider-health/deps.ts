// The real ports of the provider health run: the database, the providers, the
// catalogue sync and the admin alert channel.
//
// WHY the ports live behind a seam
// The runner holds the rules (what to test, what to sync, what a failure is) and this
// file holds the wiring (which table, which endpoint, which mail provider). The
// runner's tests need no network and no database; this file is the only place that
// knows both.

import { type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getModels } from "npm:@mariozechner/pi-ai@0.73.1";
import { loadProbeTarget, probeProvider } from "../_shared/aiProviderTest.ts";
import { resolveProviderKey } from "../_shared/providerKeys.ts";
import type { RowReader } from "../_shared/providerEndpoint.ts";
import { mapIdOnlyChatCatalog, type MappedCatalog } from "../_shared/modelCatalogSync.ts";
import { runCatalogSync, SYNCABLE_PROVIDERS } from "../_shared/modelCatalogSyncRun.ts";
import { defaultCredentialDeps, getFreshOAuthCredential } from "../_shared/aiOAuth/credentials.ts";
import { OAUTH_PROVIDER_CODE, type OAuthProviderId } from "../_shared/aiOAuth/clients.ts";
import { callPiOAuth, defaultPiCallDeps } from "../_shared/aiOAuth/piCall.ts";
import { alertRowsToDegraded, sendDegradedProviderAlert, type AdminMailer } from "../_shared/aiProviderAlert.ts";
import { verifyCronOrAdmin } from "../_shared/cron-auth.ts";
import type { HealthResult, HealthTarget } from "../_shared/aiProviderHealth.ts";
import { runHealthChunk, type HealthRunPorts } from "./run.ts";
import type { HealthHandlerPorts } from "./handler.ts";

type Admin = SupabaseClient;

/** The OAuth providers Postora can sign in to, as pi-ai knows them. */
const OAUTH_PROVIDERS: readonly OAuthProviderId[] = ["anthropic", "openai-codex"];

function isOAuthProviderId(value: string): value is OAuthProviderId {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

/** The admin mailer: the admins from user_roles/profiles, delivered by Resend. */
function createAdminMailer(admin: Admin): AdminMailer {
  return {
    async adminRecipients(): Promise<string[]> {
      const { data: roles, error: rolesError } = await admin
        .from("user_roles")
        .select("user_id")
        .eq("role", "admin");
      if (rolesError) throw new Error("admin role read failed");
      const ids = (roles ?? []).map((r) => (r as { user_id: string }).user_id).filter(Boolean);
      if (!ids.length) return [];
      const { data: profiles, error: profilesError } = await admin
        .from("profiles")
        .select("id, email")
        .in("id", ids);
      if (profilesError) throw new Error("admin profile read failed");
      return (profiles ?? [])
        .map((p) => (p as { email?: unknown }).email)
        .filter((email): email is string => typeof email === "string" && email.length > 0);
    },
    async send(to: string[], subject: string, html: string): Promise<void> {
      const resendKey = Deno.env.get("RESEND_API_KEY");
      if (!resendKey) {
        // No mail provider configured: the alert cannot be delivered. Throwing keeps
        // the claim open, so the row is re-claimed instead of the alert being lost.
        throw new Error("RESEND_API_KEY is not configured");
      }
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: "Postora <notifications@resend.dev>",
          to,
          subject,
          html,
        }),
      });
      if (!response.ok) {
        // The body can quote the request, so only the status is reported.
        throw new Error(`the mail provider refused the alert (HTTP ${response.status})`);
      }
    },
  };
}

/**
 * The ports the runner uses, wired to the service role.
 *
 * The service role is the only writer of ai_models, ai_provider_health and the alert
 * claim: the browser never writes them.
 */
export function createHealthRunPorts(admin: Admin): HealthRunPorts {
  const db = admin as unknown as RowReader;
  const mailer = createAdminMailer(admin);

  return {
    async listApiKeyProviders() {
      const { data, error } = await admin
        .from("ai_providers")
        .select("provider_code, name")
        .in("provider_code", [...SYNCABLE_PROVIDERS])
        .eq("is_active", true);
      if (error) throw new Error("AI provider read failed");
      return (data ?? []).map((row) => ({
        provider_code: String((row as { provider_code?: unknown }).provider_code ?? ""),
        name: String((row as { name?: unknown }).name ?? ""),
      }));
    },

    async listOAuthConnections() {
      const { data, error } = await admin
        .from("ai_provider_oauth_connections")
        .select("oauth_provider, provider_code, status");
      if (error) throw new Error("OAuth connection read failed");
      const rows = (data ?? []) as Array<{ oauth_provider?: unknown; provider_code?: unknown; status?: unknown }>;
      const names = new Map<string, string>();
      for (const row of rows) {
        const code = String(row.provider_code ?? "");
        if (!code || names.has(code)) continue;
        const { data: provider } = await admin
          .from("ai_providers")
          .select("name")
          .eq("provider_code", code)
          .maybeSingle();
        names.set(code, String((provider as { name?: unknown } | null)?.name ?? code));
      }
      return rows
        .filter((row) => isOAuthProviderId(String(row.oauth_provider ?? "")))
        .map((row) => ({
          oauth_provider: String(row.oauth_provider),
          provider_code: String(row.provider_code ?? ""),
          name: names.get(String(row.provider_code ?? "")) ?? String(row.provider_code ?? ""),
          status: String(row.status ?? "connected"),
        }));
    },

    async resolveApiKey(providerCode: string): Promise<string | null> {
      return resolveProviderKey(db, providerCode);
    },

    async probeApiKey(target: HealthTarget, key: string): Promise<void> {
      const provider = await loadProbeTarget(db, target.provider_code);
      if (!provider) throw new Error(`Provider ${target.provider_code} is missing`);
      await probeProvider(db, provider, key);
    },

    async probeOAuth(target: HealthTarget): Promise<void> {
      const oauthProvider = target.oauth_provider;
      if (!oauthProvider || !isOAuthProviderId(oauthProvider)) {
        throw new Error(`Provider ${target.provider_code} has no subscription sign-in`);
      }
      const credentials = defaultCredentialDeps(admin as never);
      const { apiKey } = await getFreshOAuthCredential(credentials, oauthProvider);
      const modelId = firstOAuthModel(oauthProvider);
      const response = await callPiOAuth(
        defaultPiCallDeps(),
        oauthProvider,
        modelId,
        { messages: [{ role: "user", content: "Reply with OK" }] },
        apiKey,
        20_000,
      );
      if (!response.ok) {
        // callPiOAuth already redacted the message against the credential.
        const body = await response.text();
        throw new Error(`The subscription sign-in was refused (HTTP ${response.status}): ${body.slice(0, 200)}`);
      }
    },

    async syncApiKeyCatalogue(providerCode: string) {
      const report = await runCatalogSync(admin as never, providerCode, fetch, { authMethod: "api_key" });
      return { added: report.added, updated: report.updated, deactivated: report.deactivated };
    },

    async syncOAuthCatalogue(target: HealthTarget) {
      const oauthProvider = target.oauth_provider;
      if (!oauthProvider || !isOAuthProviderId(oauthProvider)) {
        throw new Error(`Provider ${target.provider_code} has no subscription sign-in`);
      }
      // The OAuth catalogue is pi-ai's registry, not the provider's own /models.
      const catalogue: MappedCatalog = {
        ...mapIdOnlyChatCatalog(piModels(oauthProvider)),
        managedCapabilities: ["chat"],
      };
      const report = await runCatalogSync(admin as never, target.provider_code, fetch, {
        authMethod: "oauth",
        catalogue,
      });
      return { added: report.added, updated: report.updated, deactivated: report.deactivated };
    },

    async recordResult(result, runId) {
      const { error } = await admin.rpc("record_ai_provider_health", {
        p_provider_code: result.provider_code,
        p_auth_method: result.auth_method,
        p_status: result.status,
        p_reason: result.reason,
        p_models_added: result.models_added ?? 0,
        p_models_updated: result.models_updated ?? 0,
        p_models_deactivated: result.models_deactivated ?? 0,
        p_latency_ms: result.latency_ms ?? 0,
        p_run_id: runId,
      });
      if (error) throw new Error("provider health write failed");
    },

    async claimAlerts(claimToken: string) {
      const { data, error } = await admin.rpc("claim_ai_provider_health_notifications", {
        p_claim_token: claimToken,
      });
      if (error) throw new Error("provider health claim failed");
      return alertRowsToDegraded((data ?? []) as Array<Record<string, unknown>>);
    },

    async sendAlert(provider) {
      await sendDegradedProviderAlert(mailer, provider);
    },

    async markAlertsNotified(claimToken: string) {
      const { error } = await admin.rpc("mark_ai_provider_health_notified", { p_claim_token: claimToken });
      if (error) throw new Error("provider health notification close failed");
    },

    now: () => new Date(),
  };
}

/** pi-ai's model list for one OAuth provider. */
function piModels(oauthProvider: OAuthProviderId): unknown[] {
  try {
    return getModels(oauthProvider as never) as unknown[];
  } catch {
    return [];
  }
}

/** The model the OAuth probe calls. pi-ai's list is the authority on what a subscription can run. */
function firstOAuthModel(oauthProvider: OAuthProviderId): string {
  const models = piModels(oauthProvider) as Array<{ id?: unknown }>;
  const id = models.map((m) => String(m.id ?? "")).find((value) => value.length > 0);
  if (!id) throw new Error(`No model is available for the ${OAUTH_PROVIDER_CODE[oauthProvider]} sign-in`);
  return id;
}

/**
 * The ports the request handler uses: the runner, the stored results, the shared
 * lease and the authorization.
 */
export async function createHealthHandlerPorts(): Promise<HealthHandlerPorts> {
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  const admin = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  ) as unknown as SupabaseClient;
  const runPorts = createHealthRunPorts(admin);

  return {
    async runChunk(chunk: number, runId: string, scope: "daily" | "manual") {
      return runHealthChunk(runPorts, { runId, chunk });
    },

    async readResults(): Promise<HealthResult[]> {
      const { data, error } = await admin
        .from("ai_provider_health")
        .select("provider_code, auth_method, status, reason, models_added, models_updated, models_deactivated, latency_ms, checked_at")
        .order("provider_code");
      if (error) throw new Error("provider health read failed");
      const rows = (data ?? []) as Array<Record<string, unknown>>;
      const names = new Map<string, string>();
      for (const row of rows) {
        const code = String(row.provider_code ?? "");
        if (!code || names.has(code)) continue;
        const { data: provider } = await admin
          .from("ai_providers")
          .select("name")
          .eq("provider_code", code)
          .maybeSingle();
        names.set(code, String((provider as { name?: unknown } | null)?.name ?? code));
      }
      return rows.map((row) => {
        const code = String(row.provider_code ?? "");
        return {
          provider_code: code,
          auth_method: row.auth_method === "oauth" ? "oauth" : "api_key",
          display_name: names.get(code) ?? code,
          status: row.status === "failed" ? "failed" : row.status === "needs_relogin" ? "needs_relogin" : "connected",
          reason: typeof row.reason === "string" ? row.reason : null,
          models_added: typeof row.models_added === "number" ? row.models_added : null,
          models_updated: typeof row.models_updated === "number" ? row.models_updated : null,
          models_deactivated: typeof row.models_deactivated === "number" ? row.models_deactivated : null,
          latency_ms: typeof row.latency_ms === "number" ? row.latency_ms : null,
          checked_at: String(row.checked_at ?? ""),
        };
      });
    },

    async acquireLease(job: string, holder: string, ttlSeconds: number): Promise<boolean> {
      const { data, error } = await admin.rpc("acquire_cron_run_lease", {
        p_job: job,
        p_holder: holder,
        p_ttl: `${ttlSeconds} seconds`,
      });
      if (error) throw new Error("lease rpc failed");
      return data === true;
    },

    async releaseLease(job: string, holder: string): Promise<boolean> {
      const { data, error } = await admin.rpc("release_cron_run_lease", {
        p_job: job,
        p_holder: holder,
      });
      if (error) throw new Error("lease release rpc failed");
      return data === true;
    },

    async isAuthorized(req: Request) {
      return verifyCronOrAdmin(req);
    },
  };
}
