import { z } from 'zod';
import { FunctionsFetchError, FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';

const groupSchema = z.object({
  provider_code: z.string(), auth_method: z.enum(['api_key', 'oauth']), name: z.string(),
  reason: z.enum(['flag_off', 'inactive', 'not_connected', 'reauth_required', 'disconnected', 'api_key_absent', 'no_compatible_models']).nullable(),
  synced_at: z.string().nullable(),
  models: z.array(z.object({ model_id: z.string(), name: z.string(), provisional: z.boolean(), reason: z.enum(['inactive', 'unsupported_model']).nullable() })),
});
const policySchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }),
  z.object({ enabled: z.literal(true), groups: z.array(groupSchema) }),
]);
export type ChatListPolicy = z.infer<typeof policySchema>;
export type ChatListGroup = z.infer<typeof groupSchema>;
export type ChatTierInput = { category: 'chat'; slot: 'primary' | 'fallback' | 'fallback_2'; provider_code: string; model_id: string; auth_method?: 'api_key' | 'oauth' };
export const CHAT_LIST_POLICY_QUERY_KEY = ['ai-chat-list-policy'] as const;
const RETRY_MESSAGE = 'AI configuration could not be saved or read. Retry; check AI Providers if it remains unavailable.';
const savedTierSchema = z.object({ provider_code: z.string(), model_id: z.string(), auth_method: z.enum(['api_key', 'oauth']).optional() });
type SavedChatTier = z.infer<typeof savedTierSchema>;

class ChatActionError extends Error {
  constructor(readonly ambiguous: boolean) { super(RETRY_MESSAGE); }
}

async function invokeChatAction(body: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await supabase.functions.invoke('ai-config', { body, timeout: 30_000 });
  if (error || data?.error) throw new ChatActionError(error instanceof FunctionsFetchError ||
    (error instanceof FunctionsHttpError && error.context.status >= 500));
  return data;
}

export async function fetchChatListPolicy(): Promise<ChatListPolicy> {
  const parsed = policySchema.safeParse(await invokeChatAction({ action: 'chat-list-policy' }));
  if (!parsed.success) throw new Error('AI list readiness could not be read. Retry.');
  return parsed.data;
}

export async function saveChatTier(input: ChatTierInput, onReconciled?: (saved: SavedChatTier | null) => void | Promise<void>): Promise<void> {
  let response: unknown;
  try {
    response = await invokeChatAction({ action: 'set-chat-tier', ...input });
  } catch (cause) {
    if (!(cause instanceof ChatActionError) || !cause.ambiguous) throw cause;
    // An aborted response cannot tell us whether the atomic write committed.
    // Read the exact tier under admin RLS; never retry the write automatically.
    const key = `default_ai_model_chat${input.slot === 'primary' ? '' : `_${input.slot}`}`;
    const { data, error } = await supabase.from('system_settings').select('value').eq('key', key)
      .abortSignal(AbortSignal.timeout(30_000)).maybeSingle();
    const saved = savedTierSchema.nullable().safeParse(data === null ? null : data?.value);
    if (error || !saved.success) throw new Error('AI configuration save outcome could not be confirmed. Reload before retrying.');
    await onReconciled?.(saved.data);
    if (saved.data?.provider_code === input.provider_code && saved.data.model_id === input.model_id &&
      (saved.data.auth_method ?? 'api_key') === (input.auth_method ?? 'api_key')) return;
    throw cause;
  }
  if (!z.object({ success: z.literal(true) }).safeParse(response).success) throw new Error('AI configuration was not saved. Retry.');
}
