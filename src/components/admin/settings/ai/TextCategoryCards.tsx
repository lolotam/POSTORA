import { useState } from 'react';
import { Hash, MessageSquare } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { GroupedChatModelSelector } from '@/components/admin/GroupedChatModelSelector';
import { useChatListPolicy } from '@/hooks/ai-config/useChatListPolicy';
import { useAIConfiguration, useSetDefaultModel, useSetFallbackModel, useSetFallback2Model, useResetTextCategory } from '@/hooks/useAIConfiguration';
import type { AiAuthMethod } from '@/hooks/ai-config/types';
import type { ChatListPolicy } from '@/features/ai-providers/infrastructure/chatListGateway';

function TextCategoryCard({ category, policy }: { category: 'caption' | 'hashtags'; policy: Extract<ChatListPolicy, { enabled?: true }> }) {
  const configuration = useAIConfiguration();
  const primary = useSetDefaultModel();
  const fallback = useSetFallbackModel();
  const fallback2 = useSetFallback2Model();
  const reset = useResetTextCategory();
  const [customizing, setCustomizing] = useState(false);
  const title = category === 'caption' ? 'Caption Models' : 'Hashtag Models';
  const config = configuration.data;
  const inherited = !config?.settings.some(row => [`default_ai_model_${category}`, `default_ai_model_${category}_fallback`, `default_ai_model_${category}_fallback_2`].includes(row.key));
  const error = primary.error ?? fallback.error ?? fallback2.error ?? reset.error;
  const busy = primary.isPending || fallback.isPending || fallback2.isPending || reset.isPending;
  if (configuration.isPending) return <p role="status">Loading {title}...</p>;
  if (configuration.isError || !config) return <Card><CardContent><p role="alert">AI configuration could not be read. Saved selections have not changed.</p><Button onClick={() => void configuration.refetch()}>Retry</Button></CardContent></Card>;
  const save = (mutation: typeof primary, provider_code: string, model_id: string, auth_method?: AiAuthMethod) => mutation.mutate({ category, provider_code, model_id, auth_method });
  if (inherited && !customizing) {
    return <GroupedChatModelSelector title={title} description="Inherits Chat" icon={category === 'caption' ? MessageSquare : Hash} policy={policy}
      currentDefault={config.categoryDefaults.chat ?? { provider_code: 'google', model_id: 'google/gemini-3.1-flash-lite' }}
      currentFallback={config.categoryFallbacks.chat} currentFallback2={config.categoryFallbacks2.chat ?? { provider_code: 'google', model_id: 'gemini-3-flash-preview' }}
      onSetDefault={(...args) => save(primary, ...args)} onSetFallback={(...args) => save(fallback, ...args)} onSetFallback2={(...args) => save(fallback2, ...args)}
      readOnly saveError={error?.message}>
      <Button onClick={() => setCustomizing(true)}>Customize this category</Button>
    </GroupedChatModelSelector>;
  }
  return <div className="space-y-2">
    <GroupedChatModelSelector title={title} description="Independent ladder. Capped requests require a compatible tier; Claude Auth supports caps, OpenAI Codex Auth does not."
      icon={category === 'caption' ? MessageSquare : Hash} policy={policy}
      currentDefault={config.categoryDefaults[category]} currentFallback={config.categoryFallbacks[category]} currentFallback2={config.categoryFallbacks2[category]}
      onSetDefault={(...args) => save(primary, ...args)} onSetFallback={(...args) => save(fallback, ...args)} onSetFallback2={(...args) => save(fallback2, ...args)}
      isSaving={busy} saveError={error?.message} />
    {inherited ? <Button disabled={busy} onClick={() => setCustomizing(false)}>Cancel customization</Button>
      : <Button disabled={busy} onClick={() => reset.mutate(category, { onSuccess: () => setCustomizing(false) })}>Inherit Chat</Button>}
  </div>;
}

/** Mounted with Chat, hidden until both server-authoritative rollout flags allow it. */
export function TextCategoryCards() {
  const policy = useChatListPolicy(true);
  if (!policy.data?.enabled || !policy.data.categoryLaddersEnabled) return null;
  if (policy.isError) return <p role="alert">Text model readiness could not be read. <Button onClick={() => void policy.refetch()}>Retry</Button></p>;
  return <><TextCategoryCard category="caption" policy={policy.data} /><TextCategoryCard category="hashtags" policy={policy.data} /></>;
}
