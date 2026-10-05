import { useMemo } from "react";
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

// Jev ships on OpenRouter and Vercel only; other providers never carry the
// "triage" capability, so listing them here would just show an empty picker.
const TRIAGE_PROVIDER_CODES = ["openrouter", "vercel"];

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
  const triage = useAgentTriageEnabled();

  const agentProviders = useMemo(
    () => (aiConfig?.providers || []).filter((p) => AGENT_PROVIDER_CODES.includes(p.provider_code)),
    [aiConfig?.providers],
  );

  const triageProviders = useMemo(
    () => (aiConfig?.providers || []).filter((p) => TRIAGE_PROVIDER_CODES.includes(p.provider_code)),
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
          <DefaultModelSelector
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
            onSetDefault={(pc, mid) => setDefaultModel.mutate({ provider_code: pc, model_id: mid, category: "agent_triage" })}
            onSetFallback={(pc, mid) => setFallbackModel.mutate({ provider_code: pc, model_id: mid, category: "agent_triage" })}
            onSetFallback2={(pc, mid) => setFallback2Model.mutate({ provider_code: pc, model_id: mid, category: "agent_triage" })}
            isSaving={setDefaultModel.isPending || setFallbackModel.isPending || setFallback2Model.isPending}
          />
        </div>
      </CardContent>
    </Card>
  );
}
