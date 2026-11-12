import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
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
}

/** Either the OpenAI-shaped Response, or the stable error code to record. */
export type OAuthTierOutcome = { response: Response } | { error: string };

/**
 * One platform tier through the admin's subscription credential. Kept out of
 * ai-fallback.ts (ARCHITECTURE §40): the chain grows by a few lines, the
 * OAuth machinery stays here. Never throws — every failure becomes a code the
 * chain records on the attempt and skips past.
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

  const enabled = injected?.enabled ??
    (() => isAiProviderOAuthEnabled(admin as unknown as SupabaseClient));
  if (!(await enabled())) return { error: "oauth_disabled" };

  const credentials = injected?.credentials ??
    defaultCredentialDeps(admin as unknown as SupabaseClient);
  try {
    const { apiKey } = await getFreshOAuthCredential(credentials, oauthProvider);
    const pi = injected?.pi ?? defaultPiCallDeps();
    const response = await callPiOAuth(pi, oauthProvider, tier.model, requestBody, apiKey, timeoutMs);
    if (response.status === 422) return { error: "oauth_tools_unsupported" };
    return { response };
  } catch (cause) {
    return { error: cause instanceof AiOAuthError ? cause.code : "refresh_failed" };
  }
}
