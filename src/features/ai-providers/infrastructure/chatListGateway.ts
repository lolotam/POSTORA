import { z } from 'zod';
import { FunctionsFetchError, FunctionsHttpError } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { normalizeStoredTextTier } from '../../../../supabase/functions/_shared/textTierValue';

const groupSchema = z.object({
  provider_code: z.string(), auth_method: z.enum(['api_key', 'oauth']), name: z.string(),
  reason: z.enum(['flag_off', 'inactive', 'not_connected', 'reauth_required', 'disconnected', 'api_key_absent', 'no_compatible_models']).nullable(),
  synced_at: z.string().nullable(),
  models: z.array(z.object({ model_id: z.string(), name: z.string(), provisional: z.boolean(), reason: z.enum(['inactive', 'unsupported_model']).nullable() })),
});
const policySchema = z.discriminatedUnion('enabled', [
  z.object({ enabled: z.literal(false) }),
  z.object({ enabled: z.literal(true), groups: z.array(groupSchema), categoryLaddersEnabled: z.boolean().optional() }),
]);
export type ChatListPolicy = z.infer<typeof policySchema>;
export type ChatListGroup = z.infer<typeof groupSchema>;
export type ChatTierInput = { category: 'chat'; slot: 'primary' | 'fallback' | 'fallback_2'; provider_code: string; model_id: string; auth_method?: 'api_key' | 'oauth'; expected: Record<string, unknown> };
export const CHAT_LIST_POLICY_QUERY_KEY = ['ai-chat-list-policy'] as const;
export const CHAT_TIER_KEYS = ['default_ai_model_chat', 'default_ai_model_chat_fallback', 'default_ai_model_chat_fallback_2'] as const;
const RETRY_MESSAGE = 'AI configuration could not be saved or read. Retry; check AI Providers if it remains unavailable.';
const savedTierSchema = z.object({ provider_code: z.string(), model_id: z.string(), auth_method: z.enum(['api_key', 'oauth']).optional() });
type SavedChatTier = z.infer<typeof savedTierSchema>;
type ChatTierSnapshot = Partial<Record<typeof CHAT_TIER_KEYS[number], SavedChatTier | null>>;
export type TextTierSnapshot = Record<string, Record<string, unknown> | string | null>;
const rawTextTierSchema = z.union([savedTierSchema.passthrough(), z.string(), z.null()]).superRefine((stored, context) => {
  try { normalizeStoredTextTier(stored); }
  catch { context.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid saved text tier' }); }
});

class ChatActionError extends Error {
  constructor(readonly outcome: 'refused' | 'conflict' | 'unconfirmed', reason?: string) { super(reason === 'ai_output_cap_unsupported'
    ? 'Capped text requests need a compatible tier. Choose Claude Auth or an API tier before saving or inheriting Chat.' : RETRY_MESSAGE); }
}

async function invokeChatAction(body: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await supabase.functions.invoke('ai-config', { body, timeout: 30_000 });
  const reason = data?.error ?? (error instanceof FunctionsHttpError ? (await error.context.clone().json().catch(() => null))?.error : undefined);
  const stale = reason === 'configuration_changed_retry';
  if (error || data?.error) throw new ChatActionError(stale ? 'conflict' : error instanceof FunctionsFetchError ||
    (error instanceof FunctionsHttpError && error.context.status >= 500) ? 'unconfirmed' : 'refused', reason);
  return data;
}

export async function fetchChatListPolicy(): Promise<ChatListPolicy> {
  const parsed = policySchema.safeParse(await invokeChatAction({ action: 'chat-list-policy' }));
  if (!parsed.success) throw new Error('AI list readiness could not be read. Retry.');
  return parsed.data;
}

export async function saveChatTier(input: ChatTierInput, onReconciled?: (snapshot: ChatTierSnapshot) => void | Promise<void>): Promise<void> {
  let response: unknown;
  try {
    response = await invokeChatAction({ action: 'set-chat-tier', ...input });
  } catch (cause) {
    if (!(cause instanceof ChatActionError) || cause.outcome === 'refused') throw cause;
    if (cause.outcome === 'conflict') {
      // CAS compares the whole chain. Refresh siblings in one read too, including
      // absent rows, or the next manual retry would carry the stale expectation.
      const { data, error } = await supabase.from('system_settings').select('key,value').in('key', CHAT_TIER_KEYS)
        .abortSignal(AbortSignal.timeout(30_000));
      const chain = z.array(z.object({ key: z.enum(CHAT_TIER_KEYS), value: savedTierSchema.passthrough().nullable() })).safeParse(data);
      if (error || !chain.success) throw new Error('AI configuration save outcome could not be confirmed. Retry or reload to refresh.');
      await onReconciled?.(Object.fromEntries(CHAT_TIER_KEYS.map(key => [key, chain.data.find(row => row.key === key)?.value])));
      throw cause;
    }
    // An aborted response cannot tell us whether the atomic write committed.
    // Read the exact tier under admin RLS; never retry the write automatically.
    // This is an observation, not proof that a timed-out transaction finished.
    // A manual retry carries the same cached expectation; CAS refuses it if a
    // delayed write committed, and the conflict returns here to refresh the UI.
    const key = `default_ai_model_chat${input.slot === 'primary' ? '' : `_${input.slot}`}`;
    const { data, error } = await supabase.from('system_settings').select('value').eq('key', key)
      .abortSignal(AbortSignal.timeout(30_000)).maybeSingle();
    const saved = savedTierSchema.nullable().safeParse(data === null ? null : data?.value);
    if (error || !saved.success) throw new Error('AI configuration save outcome could not be confirmed. Retry or reload to refresh.');
    await onReconciled?.({ [key]: data === null ? undefined : saved.data });
    if (saved.data?.provider_code === input.provider_code && saved.data.model_id === input.model_id &&
      (saved.data.auth_method ?? 'api_key') === (input.auth_method ?? 'api_key')) return;
    throw cause;
  }
  if (!z.object({ success: z.literal(true) }).safeParse(response).success) throw new Error('AI configuration was not saved. Retry.');
}

export const textTierKeys = (category: string) => [`default_ai_model_${category}`, `default_ai_model_${category}_fallback`, `default_ai_model_${category}_fallback_2`];
export type TextLadderInput = { category: 'caption' | 'hashtags'; expected: Record<string, unknown>; expected_chat: Record<string, unknown>;
  slot?: 'primary' | 'fallback' | 'fallback_2'; provider_code?: string; model_id?: string; auth_method?: 'api_key' | 'oauth' };

export async function saveTextLadder(input: TextLadderInput, onReconciled: (snapshot: TextTierSnapshot) => void | Promise<void>): Promise<void> {
  let response: unknown;
  try {
    response = await invokeChatAction({ action: input.slot ? 'set-text-tier' : 'inherit-text-category', ...input });
  } catch (cause) {
    if (!(cause instanceof ChatActionError) || cause.outcome === 'refused') throw cause;
    // Both the independent category and inherited Chat snapshot may have changed.
    // Keep exact raw sibling values for the next whole-chain CAS expectation.
    const keys = [...textTierKeys(input.category), ...CHAT_TIER_KEYS];
    const { data, error } = await supabase.from('system_settings').select('key,value').in('key', keys).abortSignal(AbortSignal.timeout(30_000));
    const observed = z.array(z.object({ key: z.string(), value: rawTextTierSchema })).safeParse(data);
    if (error || !observed.success || observed.data.some(row => !keys.includes(row.key))) throw new Error('AI configuration save outcome could not be confirmed. Retry or reload to refresh.');
    await onReconciled(Object.fromEntries(keys.map(key => [key, observed.data.find(row => row.key === key)?.value])));
    // An observation is never proof that an earlier timed-out reset completed.
    throw cause;
  }
  if (!z.object({ success: z.literal(true) }).safeParse(response).success) throw new Error('AI configuration was not saved. Retry.');
}
