import { useMemo } from "react";
import { Bot } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DefaultModelSelector } from "@/components/admin/DefaultModelSelector";
import {
  useAIConfiguration,
  useSetDefaultModel,
  useSetFallbackModel,
  useSetFallback2Model,
} from "@/hooks/useAIConfiguration";

// The reply engine can only call providers it holds an endpoint and API key for.
// Must stay in sync with PROVIDER_ENDPOINTS and KNOWN_MODEL_PROVIDERS in
// supabase/functions/ai-agent-reply/index.ts and logic.ts. Offering anything else is not a
// cosmetic slip: parseModelRef rewrites an unknown provider prefix to "openai",
// so a Claude or Z AI model would be posted to OpenAI's endpoint under a name it
// does not have.
const AGENT_PROVIDER_CODES = ["openai", "openrouter", "gemini", "claude", "vercel", "deepseek"];

export function AdminAiAgentSection() {
  const { data: aiConfig } = useAIConfiguration();
  const setDefaultModel = useSetDefaultModel();
  const setFallbackModel = useSetFallbackModel();
  const setFallback2Model = useSetFallback2Model();

  const agentProviders = useMemo(
    () => (aiConfig?.providers || []).filter((p) => AGENT_PROVIDER_CODES.includes(p.provider_code)),
    [aiConfig?.providers],
  );

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
        <DefaultModelSelector
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
          onSetDefault={(pc, mid) => setDefaultModel.mutate({ provider_code: pc, model_id: mid, category: "agent" })}
          onSetFallback={(pc, mid) => setFallbackModel.mutate({ provider_code: pc, model_id: mid, category: "agent" })}
          onSetFallback2={(pc, mid) => setFallback2Model.mutate({ provider_code: pc, model_id: mid, category: "agent" })}
          isSaving={setDefaultModel.isPending || setFallbackModel.isPending || setFallback2Model.isPending}
        />
      </CardContent>
    </Card>
  );
}
