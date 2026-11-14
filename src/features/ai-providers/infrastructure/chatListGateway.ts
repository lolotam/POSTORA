import { z } from 'zod';
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

async function invokeChatAction(body: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await supabase.functions.invoke('ai-config', { body, timeout: 30_000 });
  if (error || data?.error) throw new Error('AI configuration could not be saved or read. Retry; check AI Providers if it remains unavailable.');
  return data;
}

export async function fetchChatListPolicy(): Promise<ChatListPolicy> {
  const parsed = policySchema.safeParse(await invokeChatAction({ action: 'chat-list-policy' }));
  if (!parsed.success) throw new Error('AI list readiness could not be read. Retry.');
  return parsed.data;
}

export async function saveChatTier(input: ChatTierInput): Promise<void> {
  const response = await invokeChatAction({ action: 'set-chat-tier', ...input });
  if (!z.object({ success: z.literal(true) }).safeParse(response).success) throw new Error('AI configuration was not saved. Retry.');
}
