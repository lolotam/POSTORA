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
  /**
   * Which credential the row belongs to. The same model_id exists once per
   * credential kind, so a row with no value is an API-key row.
   */
  auth_method?: 'api_key' | 'oauth';
  /** Administrator-set generation knobs for this model. Empty object when unset. */
  admin_params?: Record<string, string | number | boolean>;
  /** Provider-reported capabilities from the last sync. Read by mergeModelSpec. */
  metadata?: Record<string, unknown> | null;
  ai_providers?: {
    provider_code: string;
    name: string;
  };
}

/**
 * How a tier reaches its provider. `api_key` is the default and is never
 * written to `system_settings`; `oauth` marks a tier served by the admin's
 * own Claude Pro/Max or ChatGPT subscription.
 */
export type AiAuthMethod = 'api_key' | 'oauth';

export interface DefaultModel {
  provider_code: string;
  model_id: string;
  /** Present only when the tier is served by a subscription. */
  auth_method?: AiAuthMethod;
}

export type ModelCategory = 'chat' | 'image' | 'tts' | 'video' | 'search' | 'stt' | 'vision' | 'agent' | 'agent_triage' | 'embedding';

export interface CategoryDefaults {
  chat: DefaultModel | null;
  image: DefaultModel | null;
  tts: DefaultModel | null;
  video: DefaultModel | null;
  search: DefaultModel | null;
  stt: DefaultModel | null;
  vision: DefaultModel | null;
  agent: DefaultModel | null;
  agent_triage: DefaultModel | null;
  embedding: DefaultModel | null;
}

export interface CategoryFallbacks {
  chat: DefaultModel | null;
  image: DefaultModel | null;
  tts: DefaultModel | null;
  video: DefaultModel | null;
  search: DefaultModel | null;
  stt: DefaultModel | null;
  vision: DefaultModel | null;
  agent: DefaultModel | null;
  agent_triage: DefaultModel | null;
  embedding: DefaultModel | null;
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
  vision: DefaultModel | null;
  agent: DefaultModel | null;
  agent_triage: DefaultModel | null;
  embedding: DefaultModel | null;
}

/**
 * A raw `system_settings` row as returned by the `ai-config` list query.
 *
 * `value` covers both shapes seen under this LIKE filter: `{ provider_code,
 * model_id }` for the `default_ai_model*` tier rows, and `{ at: ISO }` for the
 * `model_catalog_synced_at_<code>` sync-timestamp rows. `at` is typed
 * explicitly (rather than left to the index signature, which would resolve to
 * `unknown`) so callers can read `.value?.at` as `string | undefined` without
 * a cast.
 */
export interface SystemSettingRow {
  key: string;
  value: { at?: string } & Record<string, unknown>;
}

export interface AIConfigData {
  providers: AIProvider[];
  /** The API-key catalogue. Every API-key consumer reads this list and only this list. */
  models: AIModel[];
  /**
   * The OAuth catalogue. The same model_id exists once per credential kind, so
   * the subscription login section reads this list and not the API-key one.
   */
  oauthModels: AIModel[];
  /** Raw system_settings rows matched by the list query, before tier-parsing. */
  settings: SystemSettingRow[];
  defaultModel: DefaultModel | null;
  categoryDefaults: CategoryDefaults;
  categoryFallbacks: CategoryFallbacks;
  categoryFallbacks2: CategoryFallbacks2;
}

/** The provider health types, re-exported so the admin UI has one import place. */
export type {
  ProviderHealthChunk,
  ProviderHealthRow,
  ProviderHealthStatus,
} from "@/features/ai-providers/infrastructure/aiProviderHealthGateway";
