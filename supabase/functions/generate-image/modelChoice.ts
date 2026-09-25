export interface RequestedModelRow { model_id: string; ai_providers: { provider_code: string; is_active: boolean } | null }

export function pickRequestedModelRow<T extends RequestedModelRow>(rows: T[], defaultProviderCode: string | undefined): T | null {
  const usable = rows.filter((r) => r.ai_providers?.is_active);
  return usable.find((r) => r.ai_providers!.provider_code === defaultProviderCode) ?? usable[0] ?? null;
}
