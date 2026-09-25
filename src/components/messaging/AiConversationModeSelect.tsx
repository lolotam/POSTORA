import { Bot, UserRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAiConversationMode } from "@/hooks/useAiConversationMode";
import { type AiAgentMode, type AiAgentPlatform } from "@/hooks/useAiAgentConfig";

// Per-conversation override of the AI agent engagement mode. "Default"
// removes the override so the agent-level default applies again.
export function AiConversationModeSelect({
  platform,
  conversationId,
}: {
  platform: AiAgentPlatform;
  conversationId: string;
}) {
  const { t } = useTranslation("agent");
  const { mode, setConversationMode } = useAiConversationMode(platform, conversationId);
  const currentValue = mode?.mode || "default";

  const modeLabel = (value: string) => {
    switch (value) {
      case "default":
        return t("mode.default", "AI: Default");
      case "ai_first":
        return t("mode.aiFirst", "AI: AI first");
      case "human_first":
        return t("mode.humanFirst", "AI: Human first");
      case "human_then_ai":
        return t("mode.humanThenAi", "AI: Human → AI");
      default:
        return value;
    }
  };

  const handleChange = (value: string) => {
    setConversationMode.mutate(value === "default" ? "default" : (value as AiAgentMode), {
      onSuccess: () => toast.success(t("mode.setTo", "Conversation set to {{mode}}", { mode: modeLabel(value) })),
      onError: (error) => toast.error(error.message || t("mode.updateFailed", "Could not update AI mode")),
    });
  };

  const untilTime = mode?.expires_at
    ? new Date(mode.expires_at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : "";

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <Select value={currentValue} onValueChange={handleChange} disabled={setConversationMode.isPending}>
          <SelectTrigger className="h-8 w-40 text-xs" aria-label={t("mode.aria", "AI engagement mode for this conversation")}>
            <div className="flex items-center gap-1.5">
              <Bot className="h-3.5 w-3.5 shrink-0" />
              <SelectValue />
            </div>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="default">{modeLabel("default")}</SelectItem>
            <SelectItem value="ai_first">{modeLabel("ai_first")}</SelectItem>
            <SelectItem value="human_first">{modeLabel("human_first")}</SelectItem>
            <SelectItem value="human_then_ai">{modeLabel("human_then_ai")}</SelectItem>
          </SelectContent>
        </Select>
        {mode?.expires_at && (
          <>
            <Badge
              variant="secondary"
              className="gap-1 text-xs"
              title={t("mode.humanWindow", "Human window until {{time}}", { time: new Date(mode.expires_at).toLocaleString() })}
            >
              <UserRound className="h-3 w-3" />
              {mode.mode === "human_first"
                ? t("mode.escalatedUntil", "Escalated to human · until {{time}}", { time: untilTime })
                : t("mode.notedUntil", "Escalation noted · AI answering · until {{time}}", { time: untilTime })}
            </Badge>
            <Button
              type="button" size="sm" variant="outline" className="h-8 text-xs"
              disabled={setConversationMode.isPending}
              onClick={() => setConversationMode.mutate("default", {
                onSuccess: () => toast.success(t("mode.cleared", "Override cleared. The account default applies again.")),
                onError: (error) => toast.error(error.message || t("mode.clearFailed", "Could not clear the override")),
              })}
            >
              {t("mode.release", "Release override")}
            </Button>
          </>
        )}
      </div>
      {/* Plain text only: the summary is model output and must never render as HTML. */}
      {mode?.handoff_summary ? (
        <div className="max-w-[280px] text-xs text-muted-foreground">
          <span className="font-medium">{t("mode.aiSummary", "AI summary")}</span>
          <p className="truncate" title={mode.handoff_summary}>{mode.handoff_summary}</p>
        </div>
      ) : null}
    </div>
  );
}
