import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callOAuthTier, type OAuthChainDeps } from "../_shared/aiOAuth/chainTier.ts";
import { raceSignal } from "../_shared/aiOAuth/piCall.ts";
import { completionFailure } from "./logic.ts";

export class AgentOAuthRefusal extends Error {
  constructor(readonly code: string) { super(code); }
}
/** Auth dispatch has no dependency on endpoint or API-key resolution. */
export async function agentOAuthCompletion(admin: SupabaseClient | undefined, tier: { provider: string; model: string },
  payload: Record<string, unknown>, timeoutMs: number, deps?: OAuthChainDeps, outerSignal?: AbortSignal): Promise<unknown> {
  const signal = outerSignal ? AbortSignal.any([outerSignal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  try {
    const result = await raceSignal(callOAuthTier(admin, tier, payload, timeoutMs, { ...deps, requireTools: true }, signal), signal);
    if ("error" in result) throw new AgentOAuthRefusal(result.error);
    if (!result.response.ok) throw new AgentOAuthRefusal(`oauth_http_${result.response.status}`);
    const body: unknown = await raceSignal(result.response.json(), signal);
    if (completionFailure(body)) throw new AgentOAuthRefusal("oauth_response_invalid");
    return body;
  } catch (cause) {
    if (cause instanceof AgentOAuthRefusal) throw cause;
    throw new AgentOAuthRefusal(signal.aborted ? "oauth_request_timeout" : "oauth_configuration_read_failed");
  }
}
