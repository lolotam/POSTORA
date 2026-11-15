import { z } from "npm:zod@3.23.8";
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { readAiTextFlags } from '../_shared/aiOAuth/textFlags.ts';
import { loadChatPolicySnapshot } from '../ai-config/chatListActions.ts';
import { buildAgentListPolicy } from '../ai-config/agentListPolicy.ts';

/** Served by the same runtime that accepts the structured request contract. */
export async function loadSandboxModelPolicy(admin: SupabaseClient, signal: AbortSignal) {
  const flags = await readAiTextFlags(admin, signal);
  if (!flags.feature_ai_text_auth_lists) return { enabled: false as const };
  const source = await loadChatPolicySnapshot(admin, flags, signal);
  const { data: allowed, error } = await admin.from('ai_agent_allowed_models').select('provider,model_id').eq('is_active', true).abortSignal(signal);
  if (error) throw new Error('Sandbox allowed models read failed');
  const groups = buildAgentListPolicy(source).groups;
  for (const group of groups) {
    if (group.auth_method !== 'api_key') continue;
    group.models = group.models.filter(m => allowed?.some(row => row.provider === group.provider_code && row.model_id === m.model_id));
    if (!group.reason && !group.models.some(m => !m.reason)) group.reason = 'no_compatible_agent_models';
  }
  return { enabled: true as const, contract: 1 as const, groups };
}

export const INVALID_MODEL_OVERRIDE = "invalid_model_override" as const;

const ModelOverrideSchema = z.string().trim().min(1).max(200);
const AuthAwareOverrideSchema = z.object({ provider_code: z.string().trim().min(1).max(120),
  model_id: z.string().trim().min(1).max(300), auth_method: z.enum(['api_key', 'oauth']),
}).strict();
export type AuthAwareSandboxModel = z.infer<typeof AuthAwareOverrideSchema>;

export interface AllowedAgentModel {
  provider: string;
  model_id: string;
}

export type SandboxModelOverrideResult =
  | { ok: true; model: { provider: string; model: string; authMethod?: 'oauth' } | null }
  | { ok: false; error: typeof INVALID_MODEL_OVERRIDE };

/**
 * Only a platform admin's sandbox run may select a single allowed model. Live callers never
 * reach the allow-list read: their body cannot alter the configured chain or its credentials.
 * The override runs on platform credentials and skips the user's own-key requirement, so any
 * other signed-in user choosing it would spend the platform's quota (review, 2026-11-12).
 */
export async function resolveSandboxModelOverride(input: {
  dryRun: boolean;
  requestedOverride: unknown;
  isPlatformAdmin: () => Promise<boolean>;
  readAllowedModels: () => Promise<readonly AllowedAgentModel[]>;
  readAuthAwareModels?: () => Promise<readonly AuthAwareSandboxModel[]>;
}): Promise<SandboxModelOverrideResult> {
  if (!input.dryRun || input.requestedOverride === undefined) return { ok: true, model: null };
  if (!(await input.isPlatformAdmin())) return { ok: false, error: INVALID_MODEL_OVERRIDE };

  if (typeof input.requestedOverride === 'object') {
    const parsed = AuthAwareOverrideSchema.safeParse(input.requestedOverride);
    if (!parsed.success || !input.readAuthAwareModels) return { ok: false, error: INVALID_MODEL_OVERRIDE };
    const choice = parsed.data;
    const allowed = await input.readAuthAwareModels();
    if (!allowed.some(row => row.provider_code === choice.provider_code && row.model_id === choice.model_id && row.auth_method === choice.auth_method)) return { ok: false, error: INVALID_MODEL_OVERRIDE };
    return { ok: true, model: { provider: choice.provider_code, model: choice.model_id,
      ...(choice.auth_method === 'oauth' ? { authMethod: 'oauth' } : {}) } };
  }

  const parsedOverride = ModelOverrideSchema.safeParse(input.requestedOverride);
  if (!parsedOverride.success) return { ok: false, error: INVALID_MODEL_OVERRIDE };

  const overrideText = parsedOverride.data;
  const allowedModels = await input.readAllowedModels();
  const matchedModel = matchAllowedModel(overrideText, allowedModels);
  if (!matchedModel) return { ok: false, error: INVALID_MODEL_OVERRIDE };

  // A bare legacy model id stays tied to the provider that allow-listed it.
  return { ok: true, model: { provider: matchedModel.provider, model: matchedModel.model_id } };
}

/**
 * The allow-list is read from the database, so the order of its rows is not a contract:
 * two rows that match the override must never be resolved by the order they happened to
 * arrive in. An admin dry run would otherwise test -- and pay for -- whichever provider
 * the database returned first.
 *
 * A canonical `provider/model_id` is the row's own identity, so it wins over a bare
 * `model_id`: `openai/gpt-4o` names the OpenAI row, even when an OpenRouter row carries
 * `openai/gpt-4o` as its own id.
 *
 * A bare `model_id` is accepted only when every row that matches it names the SAME model.
 * Two bare matches that name different models are ambiguous, and the override is refused
 * instead of a provider being picked by the row order: the canonical form then says which
 * provider is meant.
 */
function matchAllowedModel(
  overrideText: string,
  rows: readonly AllowedAgentModel[],
): AllowedAgentModel | null {
  const canonical = rows.filter((row) => overrideText === `${row.provider}/${row.model_id}`);
  const bare = rows.filter((row) => overrideText === row.model_id);
  const candidates = canonical.length > 0 ? canonical : bare;
  const [first, ...rest] = candidates;
  if (first === undefined) return null;
  const unanimous = rest.every(
    (row) => row.provider === first.provider && row.model_id === first.model_id,
  );
  return unanimous ? first : null;
}

export function invalidModelOverrideRefusalLog(input: {
  userId: string;
  platform: string;
  requestedOverride: unknown;
}) {
  return {
    source: "ai-agent-reply",
    category: "ai",
    level: "info",
    message: "AI agent sandbox refused: invalid model_override",
    user_id: input.userId,
    metadata: {
      platform: input.platform,
      error: INVALID_MODEL_OVERRIDE,
      ...(typeof input.requestedOverride === "string" ? { override_length: input.requestedOverride.length } : {}),
    },
  };
}
