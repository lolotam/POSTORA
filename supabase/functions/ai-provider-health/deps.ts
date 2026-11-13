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
import { alertRowsToDegraded, sendDegradedProviderAlert } from "../_shared/aiProviderAlert.ts";
import { verifyCronOrAdmin } from "../_shared/cron-auth.ts";
import {
  HEALTH_TARGET_TIMEOUT_MS,
  boundedFetch,
  withSignal,
  type DegradedProvider,
  type HealthResult,
  type HealthTarget,
} from "../_shared/aiProviderHealth.ts";
import { runHealthChunk, type HealthRunPorts } from "./run.ts";
import type { HealthHandlerPorts } from "./handler.ts";

import { createAdminMailer } from "./mailer.ts";

type Admin = SupabaseClient;

/** Postora sign-ins; OpenRouter reuses pi-ai's ordinary provider with its Vault key. */
const OAUTH_PROVIDERS: readonly OAuthProviderId[] = ["anthropic", "openai-codex", "openrouter"];

function isOAuthProviderId(value: string): value is OAuthProviderId {
  return (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

/**
 * The providers' display names, in one query. A run touches a handful of
 * providers, and one query per provider is one round trip per provider.
 */
async function providerNames(admin: Admin, codes: string[], options: { signal?: AbortSignal; activeOnly?: boolean } = {}): Promise<Map<string, string>> {
  const unique = [...new Set(codes.filter(Boolean))];
  const names = new Map<string, string>();
  if (!unique.length) return names;
  const { data, error } = await admin
    .from("ai_providers")
    .select("provider_code, name, is_active")
    .in("provider_code", unique).abortSignal(options.signal ?? AbortSignal.timeout(5_000));
  if (error) throw new Error("AI provider read failed");
  for (const row of (data ?? []) as Array<Record<string, unknown>>) {
    const code = String(row.provider_code ?? "");
    if (!code || options.activeOnly && row.is_active !== true) continue;
    names.set(code, String(row.name ?? code));
  }
  return names;
}

/** Cancels the credential/configuration reads through PostgREST, not only the wait. */
function signalReader(admin: Admin, signal: AbortSignal): RowReader {
  return { from: (table) => ({ select: (columns) => ({ eq: (column, value) => ({
    maybeSingle: () => admin.from(table).select(columns).eq(column, value).abortSignal(signal).maybeSingle(),
  }) }) }) };
}

/**
 * The ports the runner uses, wired to the service role.
 *
 * The service role is the only writer of ai_models, ai_provider_health and the alert
 * claim: the browser never writes them.
 */
export function createHealthRunPorts(admin: Admin, leaseHolder?: string): HealthRunPorts {
  const mailer = createAdminMailer(admin);

  return {
    async listApiKeyProviders(signal) {
      const { data, error } = await admin
        .from("ai_providers")
        .select("provider_code, name")
        .in("provider_code", [...SYNCABLE_PROVIDERS])
        .eq("is_active", true).abortSignal(signal);
      if (error) throw new Error("AI provider read failed");
      return (data ?? []).map((row) => ({
        provider_code: String((row as { provider_code?: unknown }).provider_code ?? ""),
        name: String((row as { name?: unknown }).name ?? ""),
      }));
    },

    async listOAuthConnections(signal) {
      const { data, error } = await admin
        .from("ai_provider_oauth_connections")
        .select("oauth_provider, provider_code, status").abortSignal(signal);
      if (error) throw new Error("OAuth connection read failed");
      const rows = (data ?? []) as Array<{ oauth_provider?: unknown; provider_code?: unknown; status?: unknown }>;
      const names = await providerNames(
        admin,
        rows.map((row) => String(row.provider_code ?? "")), { signal, activeOnly: true },
      );
      return rows
        .filter((row) => isOAuthProviderId(String(row.oauth_provider ?? "")) && names.has(String(row.provider_code ?? "")))
        .map((row) => ({
          oauth_provider: String(row.oauth_provider),
          provider_code: String(row.provider_code ?? ""),
          name: names.get(String(row.provider_code ?? "")) ?? String(row.provider_code ?? ""),
          status: String(row.status ?? "connected"),
        }));
    },

    async resolveApiKey(providerCode: string, signal: AbortSignal): Promise<string | null> {
      return resolveProviderKey(signalReader(admin, signal), providerCode);
    },

    async listRecordedTargets(runId: string, signal: AbortSignal) {
      const { data, error } = await admin
        .from("ai_provider_health_completions")
        .select("provider_code, auth_method")
        .eq("run_id", runId).abortSignal(signal);
      // A failed read throws: it must not look like "no target was recorded",
      // because that would probe and sync every provider a second time.
      if (error) throw new Error("provider health read failed");
      return (data ?? []).map((row) => ({
        provider_code: String((row as { provider_code?: unknown }).provider_code ?? ""),
        auth_method: String((row as { auth_method?: unknown }).auth_method ?? ""),
      }));
    },

    async probeApiKey(target: HealthTarget, key: string, signal: AbortSignal): Promise<void> {
      const provider = await loadProbeTarget(signalReader(admin, signal), target.provider_code);
      if (!provider) throw new Error(`Provider ${target.provider_code} is missing`);
      // The probe's own fetch is bounded by the target's signal, so a target that
      // runs out of time stops working instead of being abandoned.
      await probeProvider(admin, provider, key, HEALTH_TARGET_TIMEOUT_MS, boundedFetch(signal), signal);
    },

    async probeOAuth(target: HealthTarget, signal: AbortSignal): Promise<void> {
      const oauthProvider = target.oauth_provider;
      if (!oauthProvider || !isOAuthProviderId(oauthProvider)) {
        throw new Error(`Provider ${target.provider_code} has no subscription sign-in`);
      }
      const credentials = defaultCredentialDeps(admin as never);
      // The token refresh lives inside pi-ai and cannot be cancelled, so the wait
      // for it ends with the target's budget.
      const { apiKey } = await withSignal(
        getFreshOAuthCredential(credentials, oauthProvider),
        signal,
      );
      const modelId = firstOAuthModel(oauthProvider);
      const response = await withSignal(
        callPiOAuth(
          defaultPiCallDeps(),
          oauthProvider,
          modelId,
          { messages: [{ role: "user", content: "Reply with OK" }] },
          apiKey,
          20_000,
          signal,
        ),
        signal,
      );
      if (!response.ok) {
        // The upstream body can quote the request, so it is never stored: the
        // reason is a fixed sentence with the status code and nothing else.
        throw new Error(`The subscription sign-in was refused (HTTP ${response.status}).`);
      }
    },

    async syncApiKeyCatalogue(providerCode: string, signal: AbortSignal) {
      const report = await runCatalogSync(admin as never, providerCode, boundedFetch(signal), {
        authMethod: "api_key", signal, leaseHolder,
      });
      return { added: report.added, updated: report.updated, deactivated: report.deactivated };
    },

    async syncOAuthCatalogue(target: HealthTarget, signal: AbortSignal) {
      const oauthProvider = target.oauth_provider;
      if (!oauthProvider || !isOAuthProviderId(oauthProvider)) {
        throw new Error(`Provider ${target.provider_code} has no subscription sign-in`);
      }
      // The OAuth catalogue is pi-ai's registry, not the provider's own /models.
      const catalogue: MappedCatalog = {
        ...mapIdOnlyChatCatalog(piModels(oauthProvider)),
        managedCapabilities: ["chat"],
      };
      const report = await runCatalogSync(admin as never, target.provider_code, boundedFetch(signal), {
        authMethod: "oauth", signal, leaseHolder,
        catalogue,
      });
      return { added: report.added, updated: report.updated, deactivated: report.deactivated };
    },

    async recordResult(result, runId, signal) {
      const { error } = await admin.rpc("record_ai_provider_health", {
        p_provider_code: result.provider_code,
        p_auth_method: result.auth_method,
        p_status: result.status,
        p_reason: result.reason,
        // A null count means "there was no count", not "zero models changed". A
        // failed sync that wrote a zero would read as a successful no-op.
        p_models_added: result.models_added,
        p_models_updated: result.models_updated,
        p_models_deactivated: result.models_deactivated,
        p_latency_ms: result.latency_ms ?? 0,
        p_run_id: runId,
      }).abortSignal(signal);
      if (error) throw new Error("provider health write failed");
    },

    async claimAlerts(claimToken: string, signal: AbortSignal) {
      const { data, error } = await admin.rpc("claim_ai_provider_health_notifications", {
        p_claim_token: claimToken,
      }).abortSignal(signal);
      if (error) throw new Error("provider health claim failed");
      const degraded = alertRowsToDegraded((data ?? []) as Array<Record<string, unknown>>);
      // The alert names the provider, not its code: the names are resolved in one
      // query for the whole claim.
      const names = await providerNames(admin, degraded.map((p) => p.provider_code), { signal });
      return degraded.map((provider) => ({
        ...provider,
        display_name: names.get(provider.provider_code) ?? provider.provider_code,
      }));
    },

    async sendAlert(provider, signal) {
      await sendDegradedProviderAlert(mailer, provider, signal);
    },

    async markAlertNotified(claimToken: string, provider: DegradedProvider, signal: AbortSignal) {
      const { error } = await admin.rpc("mark_ai_provider_health_notified", {
        p_claim_token: claimToken,
        p_provider_code: provider.provider_code,
        p_auth_method: provider.auth_method,
        p_alert_id: provider.alert_id,
      }).abortSignal(signal);
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
export async function createHealthHandlerPorts(adminOverride?: Admin): Promise<HealthHandlerPorts> {
  const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
  const admin = adminOverride ?? createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
  ) as unknown as SupabaseClient;
  const runPorts = createHealthRunPorts(admin);

  return {
    async runChunk(chunk: number, runId: string, holder: string, deadlineMs: number) {
      return runHealthChunk(createHealthRunPorts(admin, holder), { runId, chunk, deadlineMs });
    },

    async readResults(): Promise<HealthResult[]> {
      const signal = AbortSignal.timeout(8_000);
      const providers = await runPorts.listApiKeyProviders(signal);
      const connections = await runPorts.listOAuthConnections(signal);
      const targets = new Set(connections.map((c) => `${c.provider_code}:oauth`));
      for (const provider of providers) {
        if (await runPorts.resolveApiKey(provider.provider_code, signal)) targets.add(`${provider.provider_code}:api_key`);
      }
      const { data, error } = await admin
        .from("ai_provider_health")
        .select("provider_code, auth_method, status, reason, models_added, models_updated, models_deactivated, latency_ms, checked_at")
        .order("provider_code").abortSignal(signal);
      if (error) throw new Error("provider health read failed");
      const rows = ((data ?? []) as Array<Record<string, unknown>>).filter((row) => targets.has(`${row.provider_code}:${row.auth_method}`));
      // One query for the names of every row, not one query per row.
      const names = await providerNames(
        admin,
        rows.map((row) => String(row.provider_code ?? "")), { signal },
      );
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
      }).abortSignal(AbortSignal.timeout(5_000));
      if (error) throw new Error("lease rpc failed");
      return data === true;
    },

    async releaseLease(job: string, holder: string): Promise<boolean> {
      const { data, error } = await admin.rpc("release_cron_run_lease", {
        p_job: job,
        p_holder: holder,
      }).abortSignal(AbortSignal.timeout(3_000));
      if (error) throw new Error("lease release rpc failed");
      return data === true;
    },

    async admitRun(scope, runId, adminId) {
      const { data, error } = await admin.rpc('admit_ai_provider_health_run', {
        p_scope: scope, p_run_id: runId, p_admin_id: adminId,
      }).abortSignal(AbortSignal.timeout(5_000));
      if (error) throw new Error('Health run admission failed');
      if (!['ready', 'complete', 'busy', 'cooldown'].includes(String(data))) throw new Error('Invalid run admission');
      return data as 'ready' | 'complete' | 'busy' | 'cooldown';
    },
    async completeRun(runId) {
      const { error } = await admin.rpc('complete_ai_provider_health_run', { p_run_id: runId })
        .abortSignal(AbortSignal.timeout(3_000));
      if (error) throw new Error('Health run completion failed');
    },
    async isAuthorized(req: Request) {
      return verifyCronOrAdmin(req, true);
    },
  };
}
