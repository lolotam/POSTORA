import { useEffect, useState, type ReactNode } from 'react';
import type { DefaultModel, AiAuthMethod } from '@/hooks/ai-config/types';
import type { ChatListGroup, ChatListPolicy } from '@/features/ai-providers/infrastructure/chatListGateway';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { LucideIcon } from 'lucide-react';

const REASONS = {
  flag_off: 'Subscription calls disabled.', inactive: 'Provider inactive.',
  not_connected: 'Connect a subscription in AI Providers.', reauth_required: 'Reauthentication required.',
  disconnected: 'Subscription disconnected.', api_key_absent: 'API key required.',
  no_compatible_models: 'No compatible Chat models. Sync the catalogue in AI Providers.',
  unsupported_model: 'Model not supported by subscription transport.',
};
const identity = (provider_code: string, auth_method?: AiAuthMethod) => JSON.stringify([provider_code, auth_method ?? 'api_key']);
const groupName = (auth_method: AiAuthMethod) => auth_method === 'oauth' ? 'Auth' : 'API';
type TierSave = (providerCode: string, modelId: string, authMethod?: AiAuthMethod) => void;

function GroupedChatTier({ label, groups, current, onSelect, isSaving }: {
  label: string; groups: ChatListGroup[]; current: DefaultModel | null; onSelect: TierSave; isSaving?: boolean;
}) {
  const savedIdentity = current ? identity(current.provider_code, current.auth_method) : '';
  const [draftGroup, setDraftGroup] = useState(savedIdentity);
  const [choosingModel, setChoosingModel] = useState(false);
  useEffect(() => { setDraftGroup(savedIdentity); setChoosingModel(false); }, [savedIdentity, current?.model_id]);
  const selected = groups.find(g => identity(g.provider_code, g.auth_method) === draftGroup);
  const savedGroup = groups.find(g => identity(g.provider_code, g.auth_method) === savedIdentity);
  const savedModel = savedGroup?.models.find(m => m.model_id === current?.model_id);
  const savedReason = savedGroup?.reason ?? savedModel?.reason;
  const modelValue = !choosingModel && savedIdentity === draftGroup ? current?.model_id ?? '' : '';
  const chooseModel = (modelId: string) => {
    const eligible = selected?.models.find(m => m.model_id === modelId);
    if (isSaving || !selected || selected.reason || !eligible || eligible.reason) return;
    setChoosingModel(false);
    onSelect(selected.provider_code, modelId, selected.auth_method === 'oauth' ? 'oauth' : undefined);
  };

  return <fieldset className="space-y-2 rounded-md border p-3">
    <legend className="px-1 text-sm font-medium">{label}</legend>
    <div className="grid gap-2 sm:grid-cols-2">
      <label className="space-y-1 text-xs">Provider / authentication
        <select aria-label={`${label} provider`} className="h-9 w-full rounded-md border bg-background px-2"
          value={draftGroup} disabled={isSaving} onChange={event => { setDraftGroup(event.target.value); setChoosingModel(true); }}>
          <option value="">Choose provider...</option>
          {(['api_key', 'oauth'] as const).map(method => <optgroup key={method} label={groupName(method)}>
            {groups.filter(g => g.auth_method === method).map(g => <option key={identity(g.provider_code, method)} value={identity(g.provider_code, method)} disabled={Boolean(g.reason)}>
              {groupName(method)} · {g.name} ({g.provider_code}){g.reason ? ` — ${REASONS[g.reason]}` : ''}
            </option>)}
          </optgroup>)}
        </select>
      </label>
      <label className="space-y-1 text-xs">{selected ? groupName(selected.auth_method) : 'Group'} model
        <select aria-label={`${label} model`} className="h-9 w-full rounded-md border bg-background px-2"
          value={modelValue} disabled={isSaving || !selected || Boolean(selected.reason)} onChange={event => chooseModel(event.target.value)}>
          <option value="">Choose model...</option>
          {modelValue && !selected?.models.some(m => m.model_id === modelValue) && <option value={modelValue} disabled>{modelValue} — unavailable</option>}
          {selected?.models.map(m => <option key={JSON.stringify([selected.provider_code, selected.auth_method, m.model_id])} value={m.model_id} disabled={Boolean(m.reason)}>
            {groupName(selected.auth_method)} · {m.name}{m.provisional ? ' — Provisional registry entry' : ''}{m.reason ? ` — ${REASONS[m.reason]}` : ''}
          </option>)}
        </select>
      </label>
    </div>
    {current && <p className="text-xs font-medium">{groupName(current.auth_method ?? 'api_key')} · {current.provider_code} · {current.model_id}</p>}
    {current && <p className="text-xs text-muted-foreground">{savedReason ? REASONS[savedReason] : !savedModel ? 'Saved model unavailable.' : savedModel.provisional ? 'Provisional registry entry; catalogue sync pending.' : ''}</p>}
    {selected?.synced_at && <p className="text-xs text-muted-foreground">Catalogue synced: {selected.synced_at}</p>}
    <ul className="space-y-1 text-xs text-muted-foreground" aria-label={`${label} availability`}>
      {groups.filter(g => g.reason).map(g => <li key={identity(g.provider_code, g.auth_method)}>{groupName(g.auth_method)} · {g.name}: <span>{REASONS[g.reason]}</span></li>)}
    </ul>
    <a className="text-xs underline" href="/admin/settings?tab=ai&sub=Providers">Manage connections and catalogue sync in AI Providers</a>
  </fieldset>;
}

export function GroupedChatModelSelector({ title, description, icon: Icon, policy, currentDefault, currentFallback, currentFallback2,
  onSetDefault, onSetFallback, onSetFallback2, isSaving, saveError, readOnly, children }: {
  title: string; description: string; icon: LucideIcon; policy: Extract<ChatListPolicy, { enabled?: true }>;
  currentDefault: DefaultModel | null; currentFallback: DefaultModel | null; currentFallback2: DefaultModel | null;
  onSetDefault: TierSave; onSetFallback: TierSave; onSetFallback2: TierSave; isSaving?: boolean; saveError?: string; readOnly?: boolean; children?: ReactNode;
}) {
  return <Card><CardHeader><CardTitle className="flex items-center gap-2 text-base"><Icon className="h-5 w-5" />{title}</CardTitle><CardDescription>{description}</CardDescription></CardHeader>
    <CardContent className="space-y-3">
      {saveError && <p role="alert" className="text-sm text-destructive">{saveError} Choose the model again to retry.</p>}
      {isSaving && <p role="status">Saving...</p>}
      <GroupedChatTier label="Primary" groups={policy.groups} current={currentDefault} onSelect={onSetDefault} isSaving={isSaving || readOnly} />
      <GroupedChatTier label="Fallback" groups={policy.groups} current={currentFallback} onSelect={onSetFallback} isSaving={isSaving || readOnly || !currentDefault} />
      <GroupedChatTier label="Fallback 2" groups={policy.groups} current={currentFallback2} onSelect={onSetFallback2} isSaving={isSaving || readOnly || !currentDefault || !currentFallback} />
      {children}
      <p className="text-xs text-muted-foreground">Last Resort (Hardcoded): google/gemini-3-flash-preview. Capped requests require a compatible tier. Claude Auth supports caps; OpenAI Codex Auth skips to a configured compatible tier.</p>
    </CardContent>
  </Card>;
}
