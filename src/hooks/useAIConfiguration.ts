import { useQuery, useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { fetchModelCatalogue } from '@/features/ai-providers/infrastructure/aiModelCatalogueGateway';
import { AI_PROVIDER_HEALTH_QUERY_KEY } from './ai-config/queryKeys';
import { normalizeStoredTextTier, type StoredTextTier } from '../../supabase/functions/_shared/textTierValue';
import { CHAT_LIST_POLICY_QUERY_KEY, CHAT_TIER_KEYS, saveChatTier, saveTextLadder, textTierKeys, type ChatListPolicy, type ChatTierInput } from '@/features/ai-providers/infrastructure/chatListGateway';
import type {
  AIProvider,
  AIModel,
  DefaultModel,
  CategoryDefaults,
  CategoryFallbacks,
  CategoryFallbacks2,
  AIConfigData,
  AiAuthMethod,
  ModelCategory,
  SystemSettingRow,
} from './ai-config/types';

export type { AIProvider, AIModel, DefaultModel, CategoryDefaults, CategoryFallbacks, CategoryFallbacks2, AIConfigData, AiAuthMethod, ModelCategory, SystemSettingRow };

function parseDefault(val: unknown): DefaultModel | null {
  let obj: StoredTextTier | null;
  try { obj = normalizeStoredTextTier(val); } catch { return null; }
  if (!obj) return null;
  if (obj.provider_code && obj.model_id) {
    const parsed: DefaultModel = { provider_code: obj.provider_code, model_id: obj.model_id };
    // `auth_method` only ever carries 'oauth' on disk; api-key tiers keep the
    // old two-key shape so existing rows stay byte-identical.
    if (obj.auth_method === 'oauth') parsed.auth_method = 'oauth';
    return parsed;
  }
  return null;
}

/**
 * The stored tier value. `auth_method` is written only for subscription
 * tiers, so an api-key tier saves exactly the shape it always did.
 */
function settingValue(provider_code: string, model_id: string, auth_method?: AiAuthMethod) {
  if (auth_method !== undefined && auth_method !== 'api_key' && auth_method !== 'oauth') throw new Error('Unknown authentication method');
  return auth_method === 'oauth'
    ? { provider_code, model_id, auth_method }
    : { provider_code, model_id };
}

const emptyCategoryDefaults: CategoryDefaults = { caption: null, hashtags: null, chat: null, image: null, tts: null, video: null, search: null, stt: null, vision: null, agent: null, agent_triage: null, embedding: null };
const emptyCategoryFallbacks: CategoryFallbacks = { caption: null, hashtags: null, chat: null, image: null, tts: null, video: null, search: null, stt: null, vision: null, agent: null, agent_triage: null, embedding: null };

// "agent_triage" must precede "agent": the loop below breaks on the first exact
// match, and exact matching makes the order safe either way, but keeping the
// longer key first mirrors this file's suffix-order rule (see parseSettingsRows).
const MODEL_CATEGORIES: ModelCategory[] = ['caption', 'hashtags', 'chat', 'image', 'tts', 'video', 'search', 'stt', 'vision', 'agent_triage', 'agent', 'embedding'];

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
        return { providers: [], models: [], oauthModels: [], settings: [], defaultModel: null, categoryDefaults: { ...emptyCategoryDefaults }, categoryFallbacks: { ...emptyCategoryFallbacks }, categoryFallbacks2: { ...emptyCategoryFallbacks } };
      }

      const [providersResult, modelsResult, settingsResult] = await Promise.all([
        supabase.from('ai_providers').select('*').order('name'),
        fetchModelCatalogue(),
        // Widened beyond the default_ai_model* tier rows so the admin UI can also
        // read the model_catalog_synced_at_<code> rows the sync-models action writes,
        // and the agent_triage_enabled on/off switch. Deviation from the task-5 brief:
        // the brief's useAgentTriageEnabled comment assumes this hook reads through the
        // ai-config edge function's `list` action, but it queries system_settings
        // directly -- the edge function's filter change alone would not surface this
        // row here, leaving the switch permanently off after a successful write.
        supabase.from('system_settings').select('*').or('key.like.default_ai_model%,key.like.model_catalog_synced_at_%,key.eq.agent_triage_enabled'),
      ]);

      if (providersResult.error) throw new Error('The provider configuration could not be read.');
      if (modelsResult.error) throw new Error('The model catalogue could not be read.');
      if (settingsResult.error) throw new Error('The AI settings could not be read.');

      const providers = (providersResult.data || []) as unknown as AIProvider[];
      const catalogue = (modelsResult.data || []) as unknown as AIModel[];
      // A row with no auth_method is an API-key row: the column did not exist
      // before the catalogue was keyed by credential kind.
      const models = catalogue.filter((m) => m.auth_method !== 'oauth');
      const oauthModels = catalogue.filter((m) => m.auth_method === 'oauth');
      const settings = (settingsResult.data || []) as unknown as SystemSettingRow[];

      const parsed = parseSettingsRows(settings as { key: string; value: unknown }[]);
      return { providers, models, oauthModels, settings, ...parsed };
    },
    retry: false,
  });
}

function saveChatTierAndReconcile(queryClient: QueryClient, input: Omit<ChatTierInput, 'expected'> | { category: 'caption' | 'hashtags'; slot?: 'primary' | 'fallback' | 'fallback_2'; provider_code?: string; model_id?: string; auth_method?: AiAuthMethod }) {
  const current = queryClient.getQueryData<AIConfigData>(['ai-config']);
  if (!current) throw new Error('AI configuration must be loaded before saving. Reload and retry.');
  const keys = textTierKeys(input.category);
  const expected = Object.fromEntries(current.settings.filter(row => keys.includes(row.key)).map(row => [row.key, row.value]));
  const expected_chat = Object.fromEntries(current.settings.filter(row => CHAT_TIER_KEYS.some(key => key === row.key)).map(row => [row.key, row.value]));
  const reconcile = async (snapshot: Record<string, Record<string, unknown> | string | null>) => {
    // Publish every observed tier before a failed mutation can show its error.
    // Invalidation alone can leave stale saved tiers and CAS expectations visible.
    await queryClient.cancelQueries({ queryKey: ['ai-config'] });
    queryClient.setQueryData<AIConfigData>(['ai-config'], current => {
      if (!current) return current;
      const settings = current.settings.filter(row => !Object.keys(snapshot).includes(row.key));
      for (const [key, value] of Object.entries(snapshot)) {
        if (value !== undefined) settings.push({ key, value });
      }
      return { ...current, settings, ...parseSettingsRows(settings) };
    });
    // Another category's successful write may have started the cancelled read.
    // Restart it even though this mutation will reject after reconciliation.
    void queryClient.invalidateQueries({ queryKey: ['ai-config'] });
  };
  return input.category === 'chat' ? saveChatTier({ ...input, expected }, reconcile)
    : saveTextLadder({ ...input, expected, expected_chat }, reconcile);
}

export function useResetTextCategory() {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn: (category: 'caption' | 'hashtags') => saveChatTierAndReconcile(queryClient, { category }),
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['ai-config'] }); },
  });
}

export function useSetDefaultModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ provider_code, model_id, category, auth_method }: { provider_code: string; model_id: string; category?: ModelCategory; auth_method?: AiAuthMethod }) => {
      if (category === 'caption' || category === 'hashtags') return saveChatTierAndReconcile(queryClient, { category, slot: 'primary', provider_code, model_id, auth_method });
      if (category === 'chat' && queryClient.getQueryData<ChatListPolicy>(CHAT_LIST_POLICY_QUERY_KEY)?.enabled) {
        return saveChatTierAndReconcile(queryClient, { category, slot: 'primary', provider_code, model_id, auth_method });
      }
      const key = category ? `default_ai_model_${category}` : 'default_ai_model';
      const { error } = await supabase
        .from('system_settings')
        .upsert({ key, value: settingValue(provider_code, model_id, auth_method), updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (error) throw new Error(error.message);
      return { success: true, provider_code, model_id, category, auth_method };
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['ai-config'] }); },
  });
}

export function useSetFallbackModel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ provider_code, model_id, category, auth_method }: { provider_code: string; model_id: string; category: ModelCategory; auth_method?: AiAuthMethod }) => {
      if (category === 'caption' || category === 'hashtags') return saveChatTierAndReconcile(queryClient, { category, slot: 'fallback', provider_code, model_id, auth_method });
      if (category === 'chat' && queryClient.getQueryData<ChatListPolicy>(CHAT_LIST_POLICY_QUERY_KEY)?.enabled) {
        return saveChatTierAndReconcile(queryClient, { category, slot: 'fallback', provider_code, model_id, auth_method });
      }
      const key = `default_ai_model_${category}_fallback`;
      const { error } = await supabase
        .from('system_settings')
        .upsert({ key, value: settingValue(provider_code, model_id, auth_method), updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (error) throw new Error(error.message);
      return { success: true, provider_code, model_id, category, auth_method };
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['ai-config'] }); },
  });
}

export function useSetFallback2Model() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ provider_code, model_id, category, auth_method }: { provider_code: string; model_id: string; category: ModelCategory; auth_method?: AiAuthMethod }) => {
      if (category === 'caption' || category === 'hashtags') return saveChatTierAndReconcile(queryClient, { category, slot: 'fallback_2', provider_code, model_id, auth_method });
      if (category === 'chat' && queryClient.getQueryData<ChatListPolicy>(CHAT_LIST_POLICY_QUERY_KEY)?.enabled) {
        return saveChatTierAndReconcile(queryClient, { category, slot: 'fallback_2', provider_code, model_id, auth_method });
      }
      const key = `default_ai_model_${category}_fallback_2`;
      const { error } = await supabase
        .from('system_settings')
        .upsert({ key, value: settingValue(provider_code, model_id, auth_method), updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (error) throw new Error(error.message);
      return { success: true, provider_code, model_id, category, auth_method };
    },
    onSuccess: () => { queryClient.invalidateQueries({ queryKey: ['ai-config'] }); },
  });
}

export function useSetModelAdminParams() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ model_row_id, admin_params }: { model_row_id: string; admin_params: Record<string, string | number | boolean> }) => {
      const { error } = await supabase
        .from('ai_models')
        .update({ admin_params })
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CHAT_LIST_POLICY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ['ai-config'] });
      queryClient.invalidateQueries({ queryKey: AI_PROVIDER_HEALTH_QUERY_KEY });
    },
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
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CHAT_LIST_POLICY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: ['ai-config'] });
    },
  });
}

export interface TestConnectionResult {
  success: boolean;
  latency?: number;
  error?: string | null;
}

export function useTestConnection() {
  return useMutation({
    // A failed test comes back as { success: false, error } so the card can show the
    // provider's mapped message; only a failed call to the function throws.
    mutationFn: async ({ provider_id }: { provider_id: string }): Promise<TestConnectionResult> => {
      const { data, error } = await supabase.functions.invoke('ai-config', {
        body: { action: 'test-connection', provider_id },
      });
      if (error) throw new Error(error.message || 'Connection test failed');
      return data as TestConnectionResult;
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
      queryClient.invalidateQueries({ queryKey: CHAT_LIST_POLICY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: AI_PROVIDER_HEALTH_QUERY_KEY });
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
      // A code missing from the result means the read failed: unknown, not "no key".
      const results: Record<string, boolean> = {};
      for (const code of providerCodes) {
        const { data, error } = await supabase.functions.invoke('ai-config', {
          body: { action: 'check-service-key', provider_code: code },
        });
        if (!error && typeof data?.has_key === 'boolean') results[code] = data.has_key;
      }
      return results;
    },
  });
}
