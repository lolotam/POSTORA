export interface AIProvider {
  id: string;
  provider_code: string;
  name: string;
  api_endpoint: string;
  api_key_env_var: string;
  api_type: string;
  auth_type?: string;
  supports_streaming: boolean;
  is_active: boolean;
}

export interface AIModel {
  id: string;
  provider_id: string;
  model_id: string;
  name: string;
  description: string | null;
  capabilities: string[];
  context_limit: number | null;
  is_active: boolean;
  cost_per_1m_input_tokens: string | number | null;
  cost_per_1m_output_tokens: string | number | null;
  /** Administrator-set generation knobs for this model. Empty object when unset. */
  admin_params?: Record<string, string | number | boolean>;
  /** Provider-reported capabilities from the last sync. Read by mergeModelSpec. */
  metadata?: Record<string, unknown> | null;
  ai_providers?: {
    provider_code: string;
    name: string;
  };
}

export interface DefaultModel {
  provider_code: string;
  model_id: string;
}

export type ModelCategory = 'chat' | 'image' | 'tts' | 'video' | 'search' | 'stt' | 'agent';

export interface CategoryDefaults {
  chat: DefaultModel | null;
  image: DefaultModel | null;
  tts: DefaultModel | null;
  video: DefaultModel | null;
  search: DefaultModel | null;
  stt: DefaultModel | null;
  agent: DefaultModel | null;
}

export interface CategoryFallbacks {
  chat: DefaultModel | null;
  image: DefaultModel | null;
  tts: DefaultModel | null;
  video: DefaultModel | null;
  search: DefaultModel | null;
  stt: DefaultModel | null;
  agent: DefaultModel | null;
}

/**
 * Second fallback tier, tried after CategoryFallbacks.
 *
 * `image` is read by generate-image; `agent` is read by ai-agent-reply as the
 * last entry of the messaging agent's global model chain. The other five are
 * written by the admin UI and read by nothing, pending a resolver that wants them.
 */
export interface CategoryFallbacks2 {
  chat: DefaultModel | null;
  image: DefaultModel | null;
  tts: DefaultModel | null;
  video: DefaultModel | null;
  search: DefaultModel | null;
  stt: DefaultModel | null;
  agent: DefaultModel | null;
}

export interface AIConfigData {
  providers: AIProvider[];
  models: AIModel[];
  defaultModel: DefaultModel | null;
  categoryDefaults: CategoryDefaults;
  categoryFallbacks: CategoryFallbacks;
  categoryFallbacks2: CategoryFallbacks2;
}
