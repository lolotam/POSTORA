import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Bot } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { DefaultModelSelector } from "@/components/admin/DefaultModelSelector";
import {
  useAIConfiguration,
  useSetDefaultModel,
  useSetFallbackModel,
  useSetFallback2Model,
} from "@/hooks/useAIConfiguration";
import { useAgentTriageEnabled } from "@/hooks/ai-config/useAgentTriageEnabled";
import { useChatListPolicy } from "@/hooks/ai-config/useChatListPolicy";
import type { AiAuthMethod } from "@/hooks/useAIConfiguration";

// Any provider can hold a triage slot: decision models (Jev) on OpenRouter/Vercel, and
// fast chat models tagged triage_chat on any OpenAI-compatible provider. The selector
// already narrows this to providers that have such a model. Claude is excluded -- the
// triage runtime ignores it (no JSON mode on its API).
const TRIAGE_EXCLUDED_PROVIDERS = ["claude"];

// The reply engine can only call providers it holds an endpoint and API key for.
// Must stay in sync with PROVIDER_ENDPOINTS and KNOWN_MODEL_PROVIDERS in
// supabase/functions/ai-agent-reply/index.ts and logic.ts. Offering anything else is not a
// cosmetic slip: parseModelRef rewrites an unknown provider prefix to "openai",
// so a Claude or Z AI model would be posted to OpenAI's endpoint under a name it
// does not have.
const AGENT_PROVIDER_CODES = ["openai", "openrouter", "gemini", "claude", "vercel", "deepseek", "moonshot"];

export function AdminAiAgentSection() {
  const { data: aiConfig, isLoading, isError, refetch } = useAIConfiguration();
  const policy = useChatListPolicy(true);
  const [saveError, setSaveError] = useState<string>();
  const [agentSaveError, setAgentSaveError] = useState<string>();
  const setDefaultModel = useSetDefaultModel();
  const setFallbackModel = useSetFallbackModel();
  const setFallback2Model = useSetFallback2Model();
  const triage = useAgentTriageEnabled();
  const saveAgent = (mutation: { mutateAsync: (variables: {
    provider_code: string; model_id: string; category: "agent"; auth_method?: AiAuthMethod;
  }) => Promise<unknown> }) => async (provider_code: string, model_id: string, auth_method?: AiAuthMethod) => {
    setAgentSaveError(undefined);
    try { await mutation.mutateAsync({ provider_code, model_id, auth_method, category: "agent" }); }
    catch (error) { setAgentSaveError(error instanceof Error ? error.message : "Could not save Agent model. Retry."); }
  };
  const saveTriage = (mutation: { mutateAsync: (variables: {
    provider_code: string; model_id: string; category: "agent_triage"; auth_method?: AiAuthMethod;
  }) => Promise<unknown> }) => async (provider_code: string, model_id: string, auth_method?: AiAuthMethod) => {
    setSaveError(undefined);
    try { await mutation.mutateAsync({ provider_code, model_id, auth_method, category: "agent_triage" }); }
    catch (error) { setSaveError(error instanceof Error ? error.message : "Could not save triage model. Retry."); }
  };

  const agentProviders = useMemo(
    () => (aiConfig?.providers || []).filter((p) => AGENT_PROVIDER_CODES.includes(p.provider_code)),
    [aiConfig?.providers],
  );

  const triageProviders = useMemo(
    () => (aiConfig?.providers || []).filter((p) => !TRIAGE_EXCLUDED_PROVIDERS.includes(p.provider_code)),
    [aiConfig?.providers],
  );

  const handleTriageToggle = (next: boolean) => {
    triage
      .setEnabled(next)
      .then(() => toast.success(next ? "Reply triage turned on" : "Reply triage turned off"))
      .catch((error) => toast.error(error instanceof Error ? error.message : "Could not update reply triage"));
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2"><Bot className="h-5 w-5" /> AI Agent Models</CardTitle>
        <CardDescription>
          The models every messaging AI agent uses, on every platform. Each fallback is tried in
          turn when the one before it fails.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <section aria-label="Messaging Agent model configuration">
        {(isLoading || policy.isLoading) && <p>Loading messaging Agent model configuration...</p>}
        {(isError || policy.isError) && <p className="text-destructive">Messaging Agent configuration could not be read. Saved selections are retained. Use Retry below.</p>}
        {aiConfig && !policy.data && <dl aria-label="Saved messaging Agent selections">
          {([['Primary', aiConfig.categoryDefaults.agent], ['Fallback', aiConfig.categoryFallbacks.agent], ['Fallback 2', aiConfig.categoryFallbacks2.agent]] as const).map(([label, saved]) => <div key={label}>
            <dt>{label}</dt><dd>{saved ? `${saved.auth_method === 'oauth' ? 'Auth' : 'API'} · ${saved.provider_code} · ${saved.model_id}` : 'Not configured'}</dd>
          </div>)}
        </dl>}
        {policy.data?.enabled && !policy.data.agentGroups && <p>Messaging Agent readiness is unavailable. <button type="button" onClick={() => { void policy.refetch(); }}>Retry Agent readiness</button></p>}
        {aiConfig && policy.data && (!policy.data.enabled || policy.data.agentGroups) && <DefaultModelSelector
          textListPolicy={policy.data}
          saveError={agentSaveError}
          category="agent"
          capability="chat"
          title="Messaging agent"
          description="Used by WhatsApp, Facebook, Instagram and Threads agents alike"
          icon={Bot}
          providers={agentProviders}
          models={aiConfig?.models || []}
          currentDefault={aiConfig?.categoryDefaults.agent ?? null}
          currentFallback={aiConfig?.categoryFallbacks.agent ?? null}
          currentFallback2={aiConfig?.categoryFallbacks2.agent ?? null}
          onSetDefault={saveAgent(setDefaultModel)}
          onSetFallback={saveAgent(setFallbackModel)}
          onSetFallback2={saveAgent(setFallback2Model)}
          isSaving={isError || policy.isError || setDefaultModel.isPending || setFallbackModel.isPending || setFallback2Model.isPending}
        />}

        </section>
        <Separator className="my-4" />

        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="agent-triage-switch" className="text-sm font-medium">
              Reply triage (Jev)
            </Label>
            <p className="text-xs text-muted-foreground max-w-md">
              A fast decision model reads each message first so the agent does less: it stops
              waiting for the knowledge search when it isn't needed, offers only the connector the
              message needs, and skips tools for small talk. It never writes replies. If it is
              unsure or unavailable, replies run as before.
            </p>
          </div>
          <Switch
            id="agent-triage-switch"
            aria-label="Reply triage (Jev)"
            checked={triage.enabled}
            disabled={triage.isSaving}
            onCheckedChange={handleTriageToggle}
          />
        </div>

        <div className="mt-4">
          {(isLoading || policy.isLoading) && <p role="status">Loading triage model configuration...</p>}
          {(isError || policy.isError || (policy.data?.enabled && !policy.data.triageGroups)) && <p role="alert">
            Triage model configuration could not be read. Saved selections are retained.
            <button type="button" className="ml-2 underline" onClick={() => { void refetch(); void policy.refetch(); }}>Retry</button>
          </p>}
          {aiConfig && (!policy.data || (policy.data.enabled && !policy.data.triageGroups)) && <dl className="space-y-2 text-xs" aria-label="Saved triage selections">
            {([['Primary', aiConfig.categoryDefaults.agent_triage], ['Fallback', aiConfig.categoryFallbacks.agent_triage], ['Fallback 2', aiConfig.categoryFallbacks2.agent_triage]] as const).map(([label, saved]) => <div key={label}>
              <dt>{label}</dt><dd>{saved ? `${saved.auth_method === 'oauth' ? 'Auth' : 'API'} · ${saved.provider_code} · ${saved.model_id}` : 'Not configured'}</dd>
            </div>)}
          </dl>}
          {aiConfig && policy.data && (!policy.data.enabled || policy.data.triageGroups) && <>
          <DefaultModelSelector
            textListPolicy={policy.data}
            saveError={saveError}
            category="agent_triage"
            capability="triage"
            title="Triage model"
            description="TypeSafe Jev (decision API, ~0.4s) or a fast chat model such as DeepSeek, Gemini Flash Lite or Ministral (~1s, strict JSON). Mix them across the three slots."
            icon={Bot}
            providers={triageProviders}
            models={aiConfig?.models || []}
            currentDefault={aiConfig?.categoryDefaults.agent_triage ?? null}
            currentFallback={aiConfig?.categoryFallbacks.agent_triage ?? null}
            currentFallback2={aiConfig?.categoryFallbacks2.agent_triage ?? null}
            onSetDefault={saveTriage(setDefaultModel)}
            onSetFallback={saveTriage(setFallbackModel)}
            onSetFallback2={saveTriage(setFallback2Model)}
            isSaving={isError || policy.isError || (policy.data.enabled && !policy.data.triageGroups) || setDefaultModel.isPending || setFallbackModel.isPending || setFallback2Model.isPending}
          />
          </>}
        </div>
      </CardContent>
    </Card>
  );
}
