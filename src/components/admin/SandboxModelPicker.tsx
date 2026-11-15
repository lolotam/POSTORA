import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { GroupedChatTier } from './GroupedChatModelSelector';
import { fetchSandboxModelPolicy } from '@/features/ai-providers/infrastructure/sandboxModelGateway';
import type { DefaultModel } from '@/hooks/ai-config/types';
import { Button } from '@/components/ui/button';

export function SandboxModelPicker({ value, onChange, busy }: { value: DefaultModel | null; onChange: (value: DefaultModel | null) => void; busy: boolean }) {
  const policy = useQuery({ queryKey: ['ai-sandbox-model-policy'], queryFn: fetchSandboxModelPolicy, retry: false });
  const state = policy.isPending ? 'loading' : policy.isError ? 'error' : policy.data?.enabled ? 'ready' : 'disabled';
  useEffect(() => {
    if ((state === 'error' || state === 'disabled') && value) onChange(null);
  }, [state, value, onChange]);
  if (state === 'disabled' && !value) return null;
  return <div className="space-y-2">
    {state === 'loading' && <p role="status">Loading sandbox model choices...</p>}
    {state === 'error' && <div role="alert">Sandbox model choices could not be read. <Button onClick={() => void policy.refetch()}>Retry</Button></div>}
    {state === 'ready' && policy.data?.enabled && <GroupedChatTier label="Sandbox comparison" groups={policy.data.groups} current={value} isSaving={busy}
      onSelect={(provider_code, model_id, auth_method) => onChange({ provider_code, model_id, ...(auth_method ? { auth_method } : {}) })} />
    }
    {(value || state === 'ready') && <Button variant="outline" disabled={busy || !value} onClick={() => onChange(null)}>Use configured chain</Button>}
    {state === 'ready' && <p className="text-xs text-muted-foreground">Comparison tests exactly one platform model. No fallback; unavailable inference reports refusal.</p>}
  </div>;
}
