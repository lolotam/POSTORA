/** Storage boundary shared by the browser and Edge Functions.
 * Decode legacy JSON strings without discarding provider extension fields.
 * Callers retain the original value separately for whole-chain CAS.
 * SQL's normalize_ai_text_tier implements this contract at the write boundary.
 */
export interface StoredTextTier extends Record<string, unknown> {
  provider_code: string;
  model_id: string;
  auth_method?: 'api_key' | 'oauth';
}

/** Codex's pinned subscription transport cannot serialize a mandatory cap. */
export function supportsOutputCap(tier: { provider: string; authMethod?: string; credentialSource?: string }): boolean {
  return tier.credentialSource === "user" || tier.authMethod !== "oauth" || tier.provider !== "openai";
}

export function normalizeStoredTextTier(stored: unknown): StoredTextTier | null {
  const decoded: unknown = typeof stored === 'string' ? JSON.parse(stored) : stored;
  if (decoded == null) return null;
  if (typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('invalid_text_chain');
  const tier = decoded as Record<string, unknown>;
  if (typeof tier.provider_code !== 'string' || !tier.provider_code.trim() ||
      typeof tier.model_id !== 'string' || !tier.model_id.trim() ||
      ('auth_method' in tier && tier.auth_method !== 'api_key' && tier.auth_method !== 'oauth')) {
    throw new Error('invalid_text_chain');
  }
  return { ...tier, provider_code: tier.provider_code.trim(), model_id: tier.model_id.trim() } as StoredTextTier;
}
