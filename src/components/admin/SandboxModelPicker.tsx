import { useQuery } from '@tanstack/react-query';
import { GroupedChatTier } from './GroupedChatModelSelector';
import { fetchSandboxModelPolicy } from '@/features/ai-providers/infrastructure/sandboxModelGateway';
import type { DefaultModel } from '@/hooks/ai-config/types';
import { Button } from '@/components/ui/button';

export function SandboxModelPicker({ value, onChange, busy }: { value: DefaultModel | null; onChange: (value: DefaultModel | null) => void; busy: boolean }) {
  const policy = useQuery({ queryKey: ['ai-sandbox-model-policy'], queryFn: fetchSandboxModelPolicy, retry: false });
  if (policy.isPending) return <p role="status">Loading sandbox model choices...</p>;
  if (policy.isError) return <div role="alert">Sandbox model choices could not be read. <Button onClick={() => void policy.refetch()}>Retry</Button></div>;
  if (!policy.data?.enabled) return null;
  return <div className="space-y-2">
    <GroupedChatTier label="Sandbox comparison" groups={policy.data.groups} current={value} isSaving={busy}
      onSelect={(provider_code, model_id, auth_method) => onChange({ provider_code, model_id, ...(auth_method ? { auth_method } : {}) })} />
    <Button variant="outline" disabled={busy || !value} onClick={() => onChange(null)}>Use configured chain</Button>
    <p className="text-xs text-muted-foreground">Comparison tests exactly one platform model. No fallback; unavailable inference reports refusal.</p>
  </div>;
}
