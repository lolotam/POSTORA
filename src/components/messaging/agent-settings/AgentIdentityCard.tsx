import { Bot } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { AiAgentLanguageMode, AiAgentMode } from "@/hooks/useAiAgentConfig";
import type { AgentCardProps } from "./types";

const MODE_DESCRIPTIONS: Record<AiAgentMode, string> = {
  ai_first: "The assistant replies first and hands off when needed.",
  human_first: "A team member replies first; the assistant stays on standby.",
  human_then_ai: "A team member gets the first chance, then AI handles the fallback.",
};

export function AgentIdentityCard({ form, update }: AgentCardProps) {
  const selectedMode = (form.default_mode || "human_then_ai") as AiAgentMode;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="h-5 w-5" /> Agent identity
        </CardTitle>
        <CardDescription>
          Whether the assistant runs, who answers first, and which language it replies in.
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
      </CardContent>
    </Card>
  );
}
