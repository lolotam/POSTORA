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
  ai_providers?: {
    provider_code: string;
    name: string;
  };
}

export interface DefaultModel {
  provider_code: string;
  model_id: string;
}

export type ModelCategory = 'chat' | 'image' | 'tts' | 'video' | 'search' | 'stt';

export interface CategoryDefaults {
  chat: DefaultModel | null;
  image: DefaultModel | null;
  tts: DefaultModel | null;
  video: DefaultModel | null;
  search: DefaultModel | null;
  stt: DefaultModel | null;
}

export interface CategoryFallbacks {
  chat: DefaultModel | null;
  image: DefaultModel | null;
  tts: DefaultModel | null;
  video: DefaultModel | null;
  search: DefaultModel | null;
  stt: DefaultModel | null;
}

export interface AIConfigData {
  providers: AIProvider[];
  models: AIModel[];
  defaultModel: DefaultModel | null;
  categoryDefaults: CategoryDefaults;
  categoryFallbacks: CategoryFallbacks;
}
