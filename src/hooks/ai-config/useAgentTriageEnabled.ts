import { useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAIConfiguration } from '@/hooks/useAIConfiguration';
import type { SystemSettingRow } from '@/hooks/ai-config/types';

const KEY = 'agent_triage_enabled';

/**
 * Reads the `agent_triage_enabled` row through useAIConfiguration's `settings`
 * list (its system_settings filter includes this key -- see the deviation note
 * on that filter in useAIConfiguration.ts) and writes it the same way the
 * model-slot hooks write system_settings: an upsert keyed on `key`.
 */
export function useAgentTriageEnabled() {
  const { data } = useAIConfiguration();
  const queryClient = useQueryClient();
  const row = data?.settings.find((s: SystemSettingRow) => s.key === KEY);
  const mutation = useMutation({
    mutationFn: async (on: boolean) => {
      const { error } = await supabase
        .from('system_settings' as never)
        .upsert({ key: KEY, value: { enabled: on }, updated_at: new Date().toISOString() } as never, { onConflict: 'key' } as never);
      if (error) throw error;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['ai-config'] }),
  });
  return {
    enabled: row?.value?.enabled === true,
    setEnabled: (on: boolean) => mutation.mutateAsync(on),
    isSaving: mutation.isPending,
  };
}
