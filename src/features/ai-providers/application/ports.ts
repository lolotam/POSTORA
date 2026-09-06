export const PROVIDERS = {
  openai: "OpenAI",
  claude: "Anthropic",
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
} as const;

export type ProviderCode = keyof typeof PROVIDERS;
export type Capability = "*" | "chat" | "agent";
export type RoutingMode = "postora_only" | "user_first" | "user_only";

export interface KeyStatus {
  id?: string;
  user_id?: string;
  provider_code: ProviderCode;
  key_hint: string | null;
  status: "active" | "invalid";
  last_verified_at: string | null;
  updated_at?: string;
}

export interface RoutingPreference {
  capability: Capability;
  mode: RoutingMode;
  preferred_provider_code: ProviderCode | null;
  preferred_model_id: string | null;
  allow_platform_fallback: boolean;
  updated_at?: string;
}

export interface ProviderModel {
  id: string;
  model_id: string;
  name: string;
  provider_code: ProviderCode;
}

export interface AiProvidersGateway {
  listKeys(): Promise<KeyStatus[]>;
  saveKey(provider: ProviderCode, key: string): Promise<KeyStatus>;
  testKey(provider: ProviderCode): Promise<KeyStatus>;
  deleteKey(provider: ProviderCode): Promise<void>;
  joinWaitlist(): Promise<void>;
  isOnWaitlist(): Promise<boolean>;
  getPreferences(): Promise<RoutingPreference[]>;
  upsertPreference(preference: RoutingPreference): Promise<void>;
  deletePreference(capability: Capability): Promise<void>;
  listModels(): Promise<ProviderModel[]>;
}
