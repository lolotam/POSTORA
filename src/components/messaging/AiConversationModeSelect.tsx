import { Bot } from "lucide-react";
import { toast } from "sonner";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAiConversationMode } from "@/hooks/useAiConversationMode";
import { type AiAgentMode, type AiAgentPlatform } from "@/hooks/useAiAgentConfig";

const modeLabels: Record<string, string> = {
  default: "AI: Default",
  ai_first: "AI: AI first",
  human_first: "AI: Human first",
  human_then_ai: "AI: Human → AI",
};

// Per-conversation override of the AI agent engagement mode. "Default"
// removes the override so the agent-level default applies again.
export function AiConversationModeSelect({
  platform,
  conversationId,
}: {
  platform: AiAgentPlatform;
  conversationId: string;
}) {
  const { mode, setConversationMode } = useAiConversationMode(platform, conversationId);
  const currentValue = mode?.mode || "default";

  const handleChange = (value: string) => {
    setConversationMode.mutate(value === "default" ? "default" : (value as AiAgentMode), {
      onSuccess: () => toast.success(`Conversation set to ${modeLabels[value]}`),
      onError: (error) => toast.error(error.message || "Could not update AI mode"),
    });
  };

  return (
    <Select value={currentValue} onValueChange={handleChange} disabled={setConversationMode.isPending}>
      <SelectTrigger className="h-8 w-40 text-xs" aria-label="AI engagement mode for this conversation">
        <div className="flex items-center gap-1.5">
          <Bot className="h-3.5 w-3.5 shrink-0" />
          <SelectValue />
        </div>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="default">{modeLabels.default}</SelectItem>
        <SelectItem value="ai_first">{modeLabels.ai_first}</SelectItem>
        <SelectItem value="human_first">{modeLabels.human_first}</SelectItem>
        <SelectItem value="human_then_ai">{modeLabels.human_then_ai}</SelectItem>
      </SelectContent>
    </Select>
  );
}
