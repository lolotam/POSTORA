import { supabase } from "@/integrations/supabase/client";

/**
 * The pi-ai OAuth provider ids that own a subscription login. The ids are
 * pi-ai's, not ours: `anthropic` and `openai-codex`.
 */
export type OAuthProviderId = "anthropic" | "openai-codex";

/** One provider's subscription-login state, as the admin UI needs it. */
export interface AiOAuthCapability {
  provider_code: "claude" | "openai";
  oauth_provider: OAuthProviderId;
  name: string;
  status: "not_connected" | "connected" | "reauth_required";
  account_label: string | null;
  expires_at: string | null;
  models: string[];
}

export interface AiOAuthCapabilities {
  enabled: boolean;
  providers: AiOAuthCapability[];
}

export interface AiOAuthStartResult {
  authorize_url: string;
}

export interface AiOAuthFinishResult {
  status: "connected";
  account_label: string | null;
}

export interface AiOAuthTestResult {
  ok: boolean;
  latency_ms: number;
  error?: string;
}

const GENERIC_FAILURE = "AI_PROVIDER_AUTH_REQUEST_FAILED";

/**
 * The function answers a refusal with `{ error: "<stable code>" }` and a
 * non-2xx status. supabase-js hands the HTTP failures back as a generic
 * FunctionsHttpError, so the code is read out of the response envelope
 * instead of the error message.
 */
async function serverErrorCode(error: unknown): Promise<string> {
  const context = (error as { context?: unknown } | null)?.context;
  if (context instanceof Response) {
    const envelope = await context.clone().json().catch(() => null);
    const code = (envelope as { error?: unknown } | null)?.error;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return GENERIC_FAILURE;
}

async function invoke<T>(body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("ai-provider-auth", { body });
  if (error) throw new Error(await serverErrorCode(error));
  return data as T;
}

/**
 * The admin AI subscription gateway. Tokens never cross this boundary: the
 * edge function keeps them in Vault and returns only status, labels and model
 * ids (spec §8).
 */
export const aiProviderAuthGateway: {
  capabilities(): Promise<AiOAuthCapabilities>;
  start(provider: OAuthProviderId): Promise<AiOAuthStartResult>;
  finish(provider: OAuthProviderId, pasted: string): Promise<AiOAuthFinishResult>;
  disconnect(provider: OAuthProviderId): Promise<void>;
  test(provider: OAuthProviderId, modelId: string): Promise<AiOAuthTestResult>;
} = {
  capabilities() {
    return invoke<AiOAuthCapabilities>({ action: "capabilities" });
  },
  start(provider) {
    return invoke<AiOAuthStartResult>({ action: "start", oauth_provider: provider });
  },
  finish(provider, pasted) {
    return invoke<AiOAuthFinishResult>({ action: "finish", oauth_provider: provider, pasted });
  },
  async disconnect(provider) {
    await invoke<{ status: "not_connected" }>({ action: "disconnect", oauth_provider: provider });
  },
  test(provider, modelId) {
    return invoke<AiOAuthTestResult>({ action: "test", oauth_provider: provider, model_id: modelId });
  },
};
