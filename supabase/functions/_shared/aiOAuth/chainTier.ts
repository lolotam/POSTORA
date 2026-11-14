import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getModels } from "npm:@mariozechner/pi-ai@0.73.1";
import { serviceClient } from "../providerEndpoint.ts";
import { oauthProviderForCode } from "./clients.ts";
import { AiOAuthError } from "./errors.ts";
import { defaultCredentialDeps, getFreshOAuthCredential, type CredentialDeps } from "./credentials.ts";
import { isAiProviderOAuthEnabled } from "./flag.ts";
import { callPiOAuth, defaultPiCallDeps, preflightPiRequest, raceSignal, type PiCallDeps } from "./piCall.ts";
import { needsToolTransport, type OAuthContinuation } from "./toolTranscript.ts";
import { readAiTextFlags } from "./textFlags.ts";

/** Test seam for the chain: everything below is defaulted to the real deps. */
export interface OAuthChainDeps {
  credentials?: CredentialDeps;
  pi?: PiCallDeps;
  enabled?: () => Promise<boolean>;
  providerActive?: (providerCode: string) => Promise<boolean>;
  toolsEnabled?: () => Promise<boolean>;
  continuation?: OAuthContinuation;
  requireTools?: boolean;
}

/** Either the OpenAI-shaped Response, or the stable error code to record. */
export type OAuthTierOutcome = { response: Response } | { error: string };

/**
 * True when a saved subscription tier names a model the subscription can
 * serve. Subscription-only models have no ai_models row, so the API-key
 * catalogue cannot validate them; pi-ai's model registry can.
 */
export function isOAuthTierModel(providerCode: string, modelId: string): boolean {
  const oauthProvider = oauthProviderForCode(providerCode);
  if (!oauthProvider) return false;
  // Infrastructure seam (ARCHITECTURE §31): pi-ai types the key as a narrow union.
  return getModels(oauthProvider as never).some((model) => model.id === modelId);
}

/** The same switch that gates API-key tiers (loadOpenAiCompatibleBase). */
async function isProviderActive(admin: SupabaseClient | undefined, providerCode: string, signal?: AbortSignal): Promise<boolean> {
  const db = (admin ?? await serviceClient()) as unknown as SupabaseClient;
  const query = db.from("ai_providers").select("is_active").eq("provider_code", providerCode);
  const { data, error } = await (signal ? query.abortSignal(signal) : query).maybeSingle();
  if (error) throw new Error("AI provider read failed");
  return (data as { is_active?: unknown } | null)?.is_active === true;
}

const UNSUPPORTED_CODES: Record<string, string> = {
  tools_unsupported: "oauth_tools_unsupported",
  max_tokens_unsupported: "oauth_max_tokens_unsupported",
  tool_history_unsupported: "oauth_tool_history_unsupported",
  schema_unsupported: "oauth_schema_unsupported",
  response_invalid: "oauth_response_invalid",
};

async function unsupportedCode(response: Response): Promise<string> {
  const body = await response.json().catch(() => null) as { error?: { code?: unknown } } | null;
  const code = typeof body?.error?.code === "string" ? body.error.code : "";
  return UNSUPPORTED_CODES[code] ?? "oauth_request_unsupported";
}

type CredentialOutcome = { apiKey: string } | { error: string };

/**
 * Bounds the gate checks and credential resolution by the tier deadline.
 * pi-ai's refresh takes no abort signal (Codex sets no timeout at all), so the
 * refresh itself keeps running after the deadline; it keeps its lease
 * (credentials.ts LEASE_SECONDS) and its save stays fenced by the lease token.
 * Its eventual rejection is swallowed here.
 */
function withinDeadline(work: Promise<CredentialOutcome>, timeoutMs: number): Promise<CredentialOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AiOAuthError("refresh_timeout", "credential resolution outlasted the tier deadline")), timeoutMs);
  });
  work.catch(() => {});
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

async function resolveTierCredential(
  admin: SupabaseClient | undefined,
  providerCode: string,
  oauthProvider: NonNullable<ReturnType<typeof oauthProviderForCode>>,
  injected: OAuthChainDeps | undefined,
  signal?: AbortSignal,
): Promise<CredentialOutcome> {
  signal?.throwIfAborted();
  const enabled = injected?.enabled ?? (() => isAiProviderOAuthEnabled(admin as unknown as SupabaseClient, signal));
  if (!(await enabled())) return { error: "oauth_disabled" };
  signal?.throwIfAborted();
  const providerActive = injected?.providerActive ?? ((code: string) => isProviderActive(admin, code, signal));
  if (!(await providerActive(providerCode))) return { error: "oauth_provider_disabled" };
  signal?.throwIfAborted();
  const credentials = injected?.credentials ?? defaultCredentialDeps(admin as unknown as SupabaseClient);
  try {
    return await getFreshOAuthCredential(credentials, oauthProvider, signal);
  } catch (cause) {
    // Only the settings and catalogue reads above may throw out of the tier.
    return { error: cause instanceof AiOAuthError ? cause.code : "refresh_failed" };
  }
}

/**
 * One platform tier through the admin's subscription credential. Kept out of
 * ai-fallback.ts (ARCHITECTURE §40): the chain grows by a few lines, the
 * OAuth machinery stays here. Every credential or
 * provider failure becomes a code the chain records on the attempt and skips
 * past; only a settings or catalogue read failure throws. timeoutMs bounds the whole
 * tier, credential refresh included.
 */
export async function callOAuthTier(
  admin: SupabaseClient | undefined,
  tier: { provider: string; model: string },
  requestBody: Record<string, unknown>,
  timeoutMs: number,
  injected?: OAuthChainDeps,
  signal?: AbortSignal,
): Promise<OAuthTierOutcome> {
  const oauthProvider = oauthProviderForCode(tier.provider);
  if (!oauthProvider) return { error: "oauth_unsupported_provider" };
  const startedAt = Date.now();
  const deadline = AbortSignal.timeout(Math.max(1, timeoutMs));
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  // Cap/schema/history checks require no credentials or refresh. Codex tools
  // remain refused even if its future-phase flag has been configured.
  const preflight = preflightPiRequest(oauthProvider, requestBody, true);
  if (preflight) return { error: UNSUPPORTED_CODES[preflight] ?? "oauth_request_unsupported" };
  const pi = injected?.pi ?? defaultPiCallDeps();
  if (!pi.getModel(oauthProvider, tier.model)) return { error: "oauth_model_unsupported" };
  let toolsEnabled = false;
  if (needsToolTransport(requestBody) || injected?.requireTools) {
    if (oauthProvider !== "anthropic") return { error: "oauth_tools_unsupported" };
    try {
      toolsEnabled = await raceSignal(injected?.toolsEnabled ? injected.toolsEnabled() : (async () => {
        const flags = await readAiTextFlags((admin ?? await serviceClient()) as unknown as SupabaseClient, signal);
        return flags.feature_ai_provider_oauth && flags.feature_ai_text_auth_lists && flags.feature_ai_oauth_tools_claude;
      })(), signal);
    } catch { return { error: "oauth_configuration_read_failed" }; }
    if (!toolsEnabled) return { error: "oauth_tools_unsupported" };
  }

  let resolved: CredentialOutcome;
  try {
    resolved = await raceSignal(withinDeadline(resolveTierCredential(admin, tier.provider, oauthProvider, injected, signal), timeoutMs), signal);
  } catch (cause) {
    if (signal.aborted) return { error: "refresh_timeout" };
    if (cause instanceof AiOAuthError) return { error: cause.code };
    throw cause; // settings or catalogue read failure
  }
  if ("error" in resolved) return resolved;

  try {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) return { error: "refresh_timeout" };
    signal?.throwIfAborted();
    const response = await callPiOAuth(pi, oauthProvider, tier.model, requestBody, resolved.apiKey, remainingMs, signal, { toolsEnabled, continuation: injected?.continuation });
    if (response.status === 422) return { error: await unsupportedCode(response) };
    return { response };
  } catch (cause) {
    return { error: cause instanceof AiOAuthError ? cause.code : "refresh_failed" };
  }
}
