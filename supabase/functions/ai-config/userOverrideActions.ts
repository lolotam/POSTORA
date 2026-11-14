import { z } from 'npm:zod@3.23.8';
import type { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { chatActionDeps, loadChatPolicySnapshot } from './chatListActions.ts';
import { buildChatListPolicy, ChatTierError } from './chatListPolicy.ts';

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
    if (input.value) {
      const flags = await deps.flags();
      // Retain the auth-aware API writer during a picker-only rollback.
      if (input.value.auth_method === 'oauth' && !flags.feature_ai_text_auth_lists) throw new ChatTierError('text_lists_disabled');
      const snapshot = await loadChatPolicySnapshot(admin, flags, signal);
      const group = buildChatListPolicy(snapshot).groups.find(g => g.provider_code === input.value?.provider_code && g.auth_method === (input.value?.auth_method ?? 'api_key'));
      const model = group?.models.find(m => m.model_id === input.value?.model_id);
      if (!group || group.reason || !model || model.reason) throw new ChatTierError(group?.reason ?? model?.reason ?? 'model_unavailable');
    }
    signal.throwIfAborted();
    const { data, error } = await admin.rpc('write_ai_model_override', { p_user_id: input.user_id, p_value: input.value, p_expected: input.expected, p_actor: actor }).abortSignal(signal);
    if (error) throw new Error('Override write failed');
    if (data !== true) throw new ChatTierError('configuration_changed_retry');
    return Response.json({ success: true });
  } catch (cause) {
    const reason = cause instanceof ChatTierError ? cause.code : 'configuration_read_or_write_failed';
    try { await deps.logRefusal(reason); } catch { console.warn({ event: 'ai_override_refusal_log_failed', reason }); }
    return Response.json({ error: reason }, { status: cause instanceof ChatTierError ? cause.status : 503 });
  }
}
