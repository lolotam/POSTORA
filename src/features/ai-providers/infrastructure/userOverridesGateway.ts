import { supabase } from '@/integrations/supabase/client';
import type { Tables } from '@/integrations/supabase/types';

type OverrideRow = Tables<'user_ai_model_overrides'>;
export type UserAiOverride = OverrideRow & { user_email?: string; user_name?: string; snapshot: OverrideRow };
export interface UserProfile { id: string; email: string; full_name: string | null }
export interface OverrideSelection { provider_code: string; model_id: string; auth_method?: 'api_key' | 'oauth'; expires_at: string | null; reason: string | null }

export async function fetchUserOverrides(): Promise<UserAiOverride[]> {
  const signal = AbortSignal.timeout(30_000);
  const { data, error } = await supabase.from('user_ai_model_overrides').select('*').order('created_at', { ascending: false }).abortSignal(signal);
  if (error) throw new Error('Could not read user AI overrides. Retry.');
  const ids = [...new Set((data ?? []).map(row => row.user_id))];
  if (!ids.length) return [];
  const { data: profiles, error: profileError } = await supabase.from('profiles').select('id,email,full_name').in('id', ids).abortSignal(signal);
  if (profileError) throw new Error('Could not read override users. Retry.');
  const profileMap = new Map(profiles?.map(profile => [profile.id, profile]));
  return (data ?? []).map(row => ({ ...row, snapshot: row, user_email: profileMap.get(row.user_id)?.email,
    user_name: profileMap.get(row.user_id)?.full_name ?? undefined }));
}

export async function searchOverrideUsers(search: string): Promise<UserProfile[]> {
  let query = supabase.from('profiles').select('id,email,full_name').order('email').limit(20);
  if (search) query = query.or(`email.ilike.%${search}%,full_name.ilike.%${search}%`);
  const { data, error } = await query.abortSignal(AbortSignal.timeout(30_000));
  if (error) throw new Error('Could not read users. Retry.');
  return data ?? [];
}

export async function writeUserOverride(user_id: string, value: OverrideSelection | null, expected: OverrideRow | null): Promise<void> {
  const { data, error } = await supabase.functions.invoke('ai-config', { body: { action: 'set-user-override', user_id, value, expected }, timeout: 30_000 });
  if (error || data?.success !== true) throw new Error('Override could not be saved. Settings refreshed; review the current choice and retry.');
}

/** Keep the flag-off picker/API behavior; the database guard clears old Auth markers. */
export async function writeLegacyUserOverride(user_id: string, value: OverrideSelection): Promise<void> {
  const { error } = await supabase.from('user_ai_model_overrides').upsert({ user_id, provider: value.provider_code,
    model: value.model_id, expires_at: value.expires_at, reason: value.reason }, { onConflict: 'user_id' }).abortSignal(AbortSignal.timeout(30_000));
  if (error) throw new Error('Could not save override. Retry.');
}
export async function deleteLegacyUserOverride(id: string): Promise<void> {
  const { error } = await supabase.from('user_ai_model_overrides').delete().eq('id', id).abortSignal(AbortSignal.timeout(30_000));
  if (error) throw new Error('Could not remove override. Retry.');
}
