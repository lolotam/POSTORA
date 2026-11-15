import { z } from 'npm:zod@3.23.8';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { chatActionDeps, loadChatPolicySnapshot } from './chatListActions.ts';
import { buildChatListPolicy, ChatTierError } from './chatListPolicy.ts';
import { platformChatTiers, resolveTextModelConfig } from '../_shared/ai-fallback.ts';
import { composeAiTiers, resolveUserAiRoute, type AiRoutingAdmin } from '../_shared/ai-user-routing.ts';
import { supportsOutputCap, TEXT_LAST_RESORT, TextLadderError } from '../_shared/textLadders.ts';

const selection = z.object({ provider_code: z.string().trim().min(1).max(120), model_id: z.string().trim().min(1).max(300),
  auth_method: z.enum(['api_key', 'oauth']).optional(), expires_at: z.string().datetime({ offset: true }).nullable(), reason: z.string().max(2000).nullable(),
}).strict();
const requestSchema = z.object({ user_id: z.string().uuid(), expected: z.record(z.unknown()).nullable(), value: selection.nullable() }).strict();

/** The existing configuration boundary owns identity, readiness and CAS writes. */
export async function runUserOverrideAction(body: unknown, admin: SupabaseClient, actor: string, signal: AbortSignal): Promise<Response> {
  const deps = chatActionDeps(admin, actor, signal);
  try {
    if (!await deps.isAdmin()) throw new ChatTierError('not_admin', 403);
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) throw new ChatTierError('invalid_user_override', 400);
    const input = parsed.data;
    const flags = await deps.flags();
    const snapshot = await loadChatPolicySnapshot(admin, flags, signal);
    const groups = buildChatListPolicy(snapshot).groups;
    if (input.value) {
      // Retain the auth-aware API writer during a picker-only rollback.
      if (input.value.auth_method === 'oauth' && !flags.feature_ai_text_auth_lists) throw new ChatTierError('text_lists_disabled');
      const group = groups.find(g => g.provider_code === input.value?.provider_code && g.auth_method === (input.value?.auth_method ?? 'api_key'));
      const model = group?.models.find(m => m.model_id === input.value?.model_id);
      if (!group || group.reason || !model || model.reason) throw new ChatTierError(group?.reason ?? model?.reason ?? 'model_unavailable');
    }
    const route = await resolveUserAiRoute(admin as unknown as AiRoutingAdmin, input.user_id, 'chat', signal);
    const active = input.value && (!input.value.expires_at || Date.parse(input.value.expires_at) > Date.now()) ? input.value : null;
    for (const category of ['caption', 'hashtags'] as const) {
      // Use the runtime resolver without the stored override, then compose the
      // proposed override and the user's own-key route before the three-tier cap.
      const config = await resolveTextModelConfig(admin, null, category, signal);
      const platform = platformChatTiers(config);
      if (active) platform.unshift({ provider: active.provider_code, model: active.model_id, credentialSource: 'platform',
        authMethod: active.auth_method === 'oauth' ? 'oauth' : undefined });
      const effective = composeAiTiers(route, platform);
      const usable = effective.some(tier => {
        if (!supportsOutputCap(tier)) return false;
        if (tier.credentialSource === 'user') return true;
        if (tier.provider === TEXT_LAST_RESORT.provider && tier.model === TEXT_LAST_RESORT.model && tier.authMethod !== 'oauth') {
          return Boolean(snapshot.textFloorAvailable && snapshot.providers.some(p => ['google', 'gemini'].includes(p.provider_code) && p.is_active));
        }
        const group = groups.find(g => g.provider_code === tier.provider && g.auth_method === (tier.authMethod ?? 'api_key'));
        const model = group?.models.find(m => m.model_id === tier.model);
        return Boolean(group && !group.reason && model && !model.reason);
      });
      if (!usable) throw new ChatTierError('ai_output_cap_unsupported');
    }
    signal.throwIfAborted();
    const { data, error } = await admin.rpc('write_ai_model_override', { p_user_id: input.user_id, p_value: input.value, p_expected: input.expected, p_actor: actor }).abortSignal(signal);
    if (error) throw new Error('Override write failed');
    if (data !== true) throw new ChatTierError('configuration_changed_retry');
    return Response.json({ success: true });
  } catch (cause) {
    const reason = cause instanceof ChatTierError || cause instanceof TextLadderError ? cause.code : 'configuration_read_or_write_failed';
    try { await deps.logRefusal(reason); } catch { console.warn({ event: 'ai_override_refusal_log_failed', reason }); }
    return Response.json({ error: reason }, { status: cause instanceof ChatTierError ? cause.status : cause instanceof TextLadderError ? 409 : 503 });
  }
}
