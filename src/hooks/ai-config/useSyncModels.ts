import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export const SYNCABLE_PROVIDER_CODES = [
  'vercel', 'openrouter', 'deepseek', 'claude', 'gemini', 'openai', 'zai', 'minimax', 'xai',
] as const;

export interface SyncReport {
  added: number; updated: number; deactivated: number;
  kept_in_use: string[]; skipped_by_type: Record<string, number>; synced_at: string;
  dry_run: boolean;
}

/**
 * Runs `syncOne` for every code strictly one after another (never in parallel — the
 * backend does one provider's fetch/mapper/planner sequence per call). A single
 * provider's failure is caught and recorded so the loop keeps going for the rest.
 */
export async function syncAllProviders(
  codes: readonly string[],
  syncOne: (code: string) => Promise<SyncReport>,
): Promise<Array<{ code: string; report?: SyncReport; error?: string }>> {
  const results: Array<{ code: string; report?: SyncReport; error?: string }> = [];
  for (const code of codes) {
    try {
      const report = await syncOne(code);
      results.push({ code, report });
    } catch (e) {
      results.push({ code, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

export function useSyncModels() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ provider_code }: { provider_code: string }): Promise<SyncReport> => {
      const { data, error } = await supabase.functions.invoke('ai-config', { body: { action: 'sync-models', provider_code } });
      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      return data as SyncReport;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai-config'] }),
  });
}
