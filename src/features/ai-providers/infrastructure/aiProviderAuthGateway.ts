import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";

/**
 * The pi-ai OAuth provider ids that own a subscription login. The ids are
 * pi-ai's, not ours: `anthropic` and `openai-codex`.
 */
export type OAuthProviderId = "anthropic" | "openai-codex";

// The edge function's responses are validated at this boundary, so a contract
// drift fails here with one stable code instead of deep inside a component.
const capabilitySchema = z.object({
  provider_code: z.enum(["claude", "openai"]),
  oauth_provider: z.enum(["anthropic", "openai-codex"]),
  /** Null when the ai_providers row has no name. */
  name: z.string().nullable(),
  /** The admin's ai_providers.is_active switch for this provider. */
  active: z.boolean(),
  status: z.enum(["not_connected", "connected", "reauth_required"]),
  account_label: z.string().nullable(),
  expires_at: z.string().nullable(),
  models: z.array(z.string()),
});
const capabilitiesSchema = z.object({ enabled: z.boolean(), providers: z.array(capabilitySchema) });
const startSchema = z.object({ authorize_url: z.string().url() });
const finishSchema = z.object({ status: z.literal("connected"), account_label: z.string().nullable() });
const disconnectSchema = z.object({ status: z.literal("not_connected") });
const testSchema = z.object({ ok: z.boolean(), latency_ms: z.number(), error: z.string().optional() });

/** One provider's subscription-login state, as the admin UI needs it. */
export type AiOAuthCapability = z.infer<typeof capabilitySchema>;
export type AiOAuthCapabilities = z.infer<typeof capabilitiesSchema>;
export type AiOAuthStartResult = z.infer<typeof startSchema>;
export type AiOAuthFinishResult = z.infer<typeof finishSchema>;
export type AiOAuthTestResult = z.infer<typeof testSchema>;

const GENERIC_FAILURE = "AI_PROVIDER_AUTH_REQUEST_FAILED";
export const INVALID_RESPONSE = "AI_PROVIDER_AUTH_INVALID_RESPONSE";

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

async function invoke<T>(body: Record<string, unknown>, schema: z.ZodType<T>): Promise<T> {
  const { data, error } = await supabase.functions.invoke("ai-provider-auth", { body });
  if (error) throw new Error(await serverErrorCode(error));
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new Error(INVALID_RESPONSE);
  return parsed.data;
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
    return invoke({ action: "capabilities" }, capabilitiesSchema);
  },
  start(provider) {
    return invoke({ action: "start", oauth_provider: provider }, startSchema);
  },
  finish(provider, pasted) {
    return invoke({ action: "finish", oauth_provider: provider, pasted }, finishSchema);
  },
  async disconnect(provider) {
    await invoke({ action: "disconnect", oauth_provider: provider }, disconnectSchema);
  },
  test(provider, modelId) {
    return invoke({ action: "test", oauth_provider: provider, model_id: modelId }, testSchema);
  },
};
