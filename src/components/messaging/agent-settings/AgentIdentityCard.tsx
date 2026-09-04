import { Bot } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { AiAgentLanguageMode, AiAgentMode } from "@/hooks/useAiAgentConfig";
import {
  RESPONSE_LENGTH_OPTIONS,
  TONE_OPTIONS,
  type AgentResponseLength,
  type AgentTone,
} from "@/lib/agentProfile";
import type { BehaviorCardProps } from "./types";

const MODE_DESCRIPTIONS: Record<AiAgentMode, string> = {
  ai_first: "The assistant replies first and hands off when needed.",
  human_first: "A team member replies first; the assistant stays on standby.",
  human_then_ai: "A team member gets the first chance, then AI handles the fallback.",
};

export function AgentIdentityCard({ form, update, behavior, updateBehavior }: BehaviorCardProps) {
  const selectedMode = (form.default_mode || "human_then_ai") as AiAgentMode;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="h-5 w-5" /> Agent identity and voice
        </CardTitle>
        <CardDescription>
          Whether the assistant runs, who answers first, and how it sounds when it does.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
          <div>
            <Label htmlFor="ai-agent-enabled" className="text-base">
              Enable AI agent
            </Label>
            <p className="text-sm text-muted-foreground">
              Allow this agent to participate according to the selected mode.
            </p>
          </div>
          <Switch
            id="ai-agent-enabled"
            checked={Boolean(form.is_enabled)}
            onCheckedChange={(checked) => update("is_enabled", checked)}
          />
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Default engagement mode</Label>
            <Select
              value={selectedMode}
              onValueChange={(value) => update("default_mode", value as AiAgentMode)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ai_first">AI First</SelectItem>
                <SelectItem value="human_first">Human First</SelectItem>
                <SelectItem value="human_then_ai">Human then AI fallback</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">{MODE_DESCRIPTIONS[selectedMode]}</p>
          </div>
          <div className="space-y-2">
            <Label>Language</Label>
            <Select
              value={form.language_mode || "auto"}
              onValueChange={(value) => update("language_mode", value as AiAgentLanguageMode)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">Auto-detect (Arabic/English)</SelectItem>
                <SelectItem value="ar">Arabic only</SelectItem>
                <SelectItem value="en">English only</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              Choose whether replies follow the customer&apos;s language automatically.
            </p>
          </div>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Tone of voice</Label>
            <RadioGroup
              value={behavior.tone ?? ""}
              onValueChange={(value) => updateBehavior("tone", value as AgentTone)}
              className="gap-2"
            >
              {TONE_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5"
                >
                  <RadioGroupItem
                    value={option.value}
                    id={`tone-${option.value}`}
                    aria-label={`${option.label}. ${option.hint}`}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-sm font-medium">{option.label}</span>
                    <span className="block text-xs text-muted-foreground">{option.hint}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </div>

          <div className="space-y-2">
            <Label>Reply length</Label>
            <RadioGroup
              value={behavior.response_length ?? ""}
              onValueChange={(value) =>
                updateBehavior("response_length", value as AgentResponseLength)
              }
              className="gap-2"
            >
              {RESPONSE_LENGTH_OPTIONS.map((option) => (
                <label
                  key={option.value}
                  className="flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5"
                >
                  <RadioGroupItem
                    value={option.value}
                    id={`length-${option.value}`}
                    aria-label={`${option.label}. ${option.hint}`}
                    className="mt-0.5"
                  />
                  <span>
                    <span className="block text-sm font-medium">{option.label}</span>
                    <span className="block text-xs text-muted-foreground">{option.hint}</span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
