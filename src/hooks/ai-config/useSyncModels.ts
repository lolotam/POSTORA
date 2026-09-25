import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export const SYNCABLE_PROVIDER_CODES = ['vercel', 'openrouter', 'deepseek'] as const;

export interface SyncReport {
  added: number; updated: number; deactivated: number;
  kept_in_use: string[]; skipped_by_type: Record<string, number>; synced_at: string;
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
