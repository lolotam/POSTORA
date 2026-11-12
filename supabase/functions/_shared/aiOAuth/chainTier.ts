import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { getModels } from "npm:@mariozechner/pi-ai@0.73.1";
import { serviceClient } from "../providerEndpoint.ts";
import { oauthProviderForCode } from "./clients.ts";
import { AiOAuthError } from "./errors.ts";
import { defaultCredentialDeps, getFreshOAuthCredential, type CredentialDeps } from "./credentials.ts";
import { isAiProviderOAuthEnabled } from "./flag.ts";
import { callPiOAuth, defaultPiCallDeps, type PiCallDeps } from "./piCall.ts";

/** Test seam for the chain: everything below is defaulted to the real deps. */
export interface OAuthChainDeps {
  credentials?: CredentialDeps;
  pi?: PiCallDeps;
  enabled?: () => Promise<boolean>;
  providerActive?: (providerCode: string) => Promise<boolean>;
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
async function isProviderActive(admin: SupabaseClient | undefined, providerCode: string): Promise<boolean> {
  const db = (admin ?? await serviceClient()) as unknown as SupabaseClient;
  const { data, error } = await db.from("ai_providers")
    .select("is_active").eq("provider_code", providerCode).maybeSingle();
  if (error) throw new Error("AI provider read failed");
  return (data as { is_active?: unknown } | null)?.is_active === true;
}

const UNSUPPORTED_CODES: Record<string, string> = {
  tools_unsupported: "oauth_tools_unsupported",
  max_tokens_unsupported: "oauth_max_tokens_unsupported",
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
): Promise<CredentialOutcome> {
  const enabled = injected?.enabled ?? (() => isAiProviderOAuthEnabled(admin as unknown as SupabaseClient));
  if (!(await enabled())) return { error: "oauth_disabled" };
  const providerActive = injected?.providerActive ?? ((code: string) => isProviderActive(admin, code));
  if (!(await providerActive(providerCode))) return { error: "oauth_provider_disabled" };
  const credentials = injected?.credentials ?? defaultCredentialDeps(admin as unknown as SupabaseClient);
  try {
    return await getFreshOAuthCredential(credentials, oauthProvider);
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
): Promise<OAuthTierOutcome> {
  const oauthProvider = oauthProviderForCode(tier.provider);
  if (!oauthProvider) return { error: "oauth_unsupported_provider" };
  const startedAt = Date.now();

  let resolved: CredentialOutcome;
  try {
    resolved = await withinDeadline(resolveTierCredential(admin, tier.provider, oauthProvider, injected), timeoutMs);
  } catch (cause) {
    if (cause instanceof AiOAuthError) return { error: cause.code };
    throw cause; // settings or catalogue read failure
  }
  if ("error" in resolved) return resolved;

  try {
    const remainingMs = timeoutMs - (Date.now() - startedAt);
    if (remainingMs <= 0) return { error: "refresh_timeout" };
    const pi = injected?.pi ?? defaultPiCallDeps();
    const response = await callPiOAuth(pi, oauthProvider, tier.model, requestBody, resolved.apiKey, remainingMs);
    if (response.status === 422) return { error: await unsupportedCode(response) };
    return { response };
  } catch (cause) {
    return { error: cause instanceof AiOAuthError ? cause.code : "refresh_failed" };
  }
}
