import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type {
  AIProvider,
  AIModel,
  DefaultModel,
  CategoryDefaults,
  CategoryFallbacks,
  CategoryFallbacks2,
  AIConfigData,
  ModelCategory,
} from './ai-config/types';

export type { AIProvider, AIModel, DefaultModel, CategoryDefaults, CategoryFallbacks, CategoryFallbacks2, AIConfigData, ModelCategory };

function parseDefault(val: unknown): DefaultModel | null {
  if (!val || typeof val !== 'object') return null;
  const obj = val as Record<string, string>;
  if (obj.provider_code && obj.model_id) return { provider_code: obj.provider_code, model_id: obj.model_id };
  return null;
}

const emptyCategoryDefaults: CategoryDefaults = { chat: null, image: null, tts: null, video: null, search: null, stt: null, agent: null, embedding: null };
const emptyCategoryFallbacks: CategoryFallbacks = { chat: null, image: null, tts: null, video: null, search: null, stt: null, agent: null, embedding: null };

const MODEL_CATEGORIES: ModelCategory[] = ['chat', 'image', 'tts', 'video', 'search', 'stt', 'agent', 'embedding'];

export interface ParsedModelSettings {
  defaultModel: DefaultModel | null;
  categoryDefaults: CategoryDefaults;
  categoryFallbacks: CategoryFallbacks;
  categoryFallbacks2: CategoryFallbacks2;
}

/**
 * Route system_settings rows to their tier.
 *
 * Suffix order matters: "_fallback_2" is matched before "_fallback", because the
 * longer key ends with the shorter one and would otherwise be swallowed by it.
 */
export function parseSettingsRows(rows: { key: string; value: unknown }[]): ParsedModelSettings {
  const out: ParsedModelSettings = {
    defaultModel: null,
    categoryDefaults: { ...emptyCategoryDefaults },
    categoryFallbacks: { ...emptyCategoryFallbacks },
    categoryFallbacks2: { ...emptyCategoryFallbacks },
  };

  for (const row of rows) {
    const parsed = parseDefault(row.value);
    if (row.key === 'default_ai_model') {
      out.defaultModel = parsed;
      continue;
    }
    for (const category of MODEL_CATEGORIES) {
      if (row.key === `default_ai_model_${category}_fallback_2`) out.categoryFallbacks2[category] = parsed;
      else if (row.key === `default_ai_model_${category}_fallback`) out.categoryFallbacks[category] = parsed;
      else if (row.key === `default_ai_model_${category}`) out.categoryDefaults[category] = parsed;
      else continue;
      break;
    }
  }
  return out;
}

export function useAIConfiguration() {
  return useQuery({
    queryKey: ['ai-config'],
    queryFn: async (): Promise<AIConfigData> => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        return { providers: [], models: [], defaultModel: null, categoryDefaults: { ...emptyCategoryDefaults }, categoryFallbacks: { ...emptyCategoryFallbacks }, categoryFallbacks2: { ...emptyCategoryFallbacks } };
      }

      const [providersResult, modelsResult, settingsResult] = await Promise.all([
        supabase.from('ai_providers' as any).select('*').order('name'),
        supabase.from('ai_models' as any).select('*, ai_providers(provider_code, name)').order('name'),
        supabase.from('system_settings' as any).select('*').like('key', 'default_ai_model%'),
      ]);

      const providers = (providersResult.data || []) as unknown as AIProvider[];
      const models = (modelsResult.data || []) as unknown as AIModel[];
      const settings = (settingsResult.data || []) as any[];

      const parsed = parseSettingsRows(settings as { key: string; value: unknown }[]);
      return { providers, models, ...parsed };
    },
    retry: false,
  });
}

export function useSetDefaultModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ provider_code, model_id, category }: { provider_code: string; model_id: string; category?: ModelCategory }) => {
      const key = category ? `default_ai_model_${category}` : 'default_ai_model';
      const { error } = await supabase
        .from('system_settings' as any)
        .upsert({ key, value: { provider_code, model_id }, updated_at: new Date().toISOString() } as any, { onConflict: 'key' } as any);
      if (error) throw new Error(error.message);
      return { success: true, provider_code, model_id, category };
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['ai-config'] }); },
  });
}

export function useSetFallbackModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ provider_code, model_id, category }: { provider_code: string; model_id: string; category: ModelCategory }) => {
      const key = `default_ai_model_${category}_fallback`;
      const { error } = await supabase
        .from('system_settings' as any)
        .upsert({ key, value: { provider_code, model_id }, updated_at: new Date().toISOString() } as any, { onConflict: 'key' } as any);
      if (error) throw new Error(error.message);
      return { success: true, provider_code, model_id, category };
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['ai-config'] }); },
  });
}

export function useSetFallback2Model() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ provider_code, model_id, category }: { provider_code: string; model_id: string; category: ModelCategory }) => {
      const key = `default_ai_model_${category}_fallback_2`;
      const { error } = await supabase
        .from('system_settings' as any)
        .upsert({ key, value: { provider_code, model_id }, updated_at: new Date().toISOString() } as any, { onConflict: 'key' } as any);
      if (error) throw new Error(error.message);
      return { success: true, provider_code, model_id, category };
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['ai-config'] }); },
  });
}

export function useSetModelAdminParams() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ model_row_id, admin_params }: { model_row_id: string; admin_params: Record<string, string | number | boolean> }) => {
      const { error } = await supabase
        .from('ai_models' as any)
        .update({ admin_params } as any)
        .eq('id', model_row_id);
      if (error) throw new Error(error.message);
      return { success: true };
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['ai-config'] }); },
  });
}

export function useToggleProvider() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ provider_id, is_active }: { provider_id: string; is_active: boolean }) => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');
      const res = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-config?action=toggle-provider`,
        {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${session.access_token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ provider_id, is_active }),
        }
      );
      if (!res.ok) {
        const e = await res.json();
        throw new Error(e.error || 'Failed');
      }
      return res.json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['ai-config'] }); },
  });
}

export function useToggleModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ model_id, is_active }: { model_id: string; is_active: boolean }) => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) throw new Error('Not authenticated');
      const res = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ai-config?action=toggle-model`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model_id, is_active }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.error || 'Failed'); }
      return res.json();
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['ai-config'] }); },
  });
}

export function useTestConnection() {
  return useMutation({
    mutationFn: async ({ provider_id }: { provider_id: string }) => {
      const { data, error } = await supabase.functions.invoke('ai-config', {
        body: { action: 'test-connection', provider_id },
      });
      if (error) throw new Error(error.message || 'Connection test failed');
      if (data?.error) throw new Error(data.error);
      return data;
    },
  });
}

export interface SetServiceKeyResult {
  success: boolean;
  latency?: number;
  error?: string;
  /** Set when the key was saved but the account is billing-blocked (e.g. Vercel AI Gateway without a card on file). */
  warning?: string;
}

export function useSetServiceKey() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ provider_code, api_key }: { provider_code: string; api_key: string }): Promise<SetServiceKeyResult> => {
      const { data, error } = await supabase.functions.invoke('ai-config', {
        body: { action: 'set-service-key', provider_code, api_key },
      });
      if (error) throw new Error(error.message || 'Failed to save key');
      return data as SetServiceKeyResult;
    },
    onSuccess: () => {
      queryClient.refetchQueries({ queryKey: ['service-keys'] });
    },
  });
}

export function useTestService() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ provider_code }: { provider_code: string }) => {
      const { data, error } = await supabase.functions.invoke('ai-config', {
        body: { action: 'test-service', provider_code },
      });
      if (error) throw new Error(error.message || 'Test failed');
      return data;
    },
    onSuccess: () => {
      queryClient.refetchQueries({ queryKey: ['service-keys'] });
    },
  });
}

export function useCheckServiceKey(providerCodes: string[] = ['firecrawl', 'apify']) {
  return useQuery({
    queryKey: ['service-keys', ...providerCodes],
    queryFn: async () => {
      const results: Record<string, boolean> = {};
      for (const code of providerCodes) {
        const { data, error } = await supabase.functions.invoke('ai-config', {
          body: { action: 'check-service-key', provider_code: code },
        });
        results[code] = !error && data?.has_key === true;
      }
      return results;
    },
  });
}
