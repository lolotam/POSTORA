import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import { Bot, HelpCircle } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { AiAgentLanguageMode, AiAgentMode } from "@/hooks/useAiAgentConfig";
import {
  RESPONSE_LENGTH_OPTIONS,
  TONE_OPTIONS,
  type AgentResponseLength,
  type AgentTone,
} from "@/lib/agentProfile";
import type { BehaviorCardProps } from "./types";

const ESCALATION_TIMEOUT_TOOLTIP =
  "How long an escalated conversation stays with your team before the override expires and the account default applies again, so the AI can resume answering new messages.";
const ESCALATION_TIMEOUT_HELP =
  "When the assistant hands a conversation to your team, this timeout keeps it from staying muted for ever. After it expires the account default applies again to new messages; a message that arrived while the conversation was muted is not answered retroactively.";
const MAX_ESCALATION_TIMEOUT_MINUTES = 10080;

type TimeoutUnit = "minutes" | "hours";

/** Shown value for the stored minutes: hours as a decimal so 90 minutes reads 1.5, not 2. */
function displayValue(minutes: number, unit: TimeoutUnit): number {
  return unit === "hours" ? Math.round((minutes / 60) * 100) / 100 : minutes;
}

function EscalationTimeoutField({ minutes, onChange }: { minutes: number; onChange: (minutes: number) => void }) {
  const { t } = useTranslation("agent");
  // The stored value is always whole minutes; the unit is display state.
  // Switching the unit never changes the stored value (debate finding 15).
  const [unit, setUnit] = useState<TimeoutUnit>(minutes >= 60 && minutes % 60 === 0 ? "hours" : "minutes");
  // What the user is typing, kept apart from the stored value so an empty or
  // half-typed field ("", "1.") is not stored as 1 minute and rewritten under
  // their cursor; only a finite positive number is committed, and blur puts the
  // stored value back.
  const [draft, setDraft] = useState<string>(String(displayValue(minutes, unit)));
  // The field mounts before the account config has loaded (the form holds the
  // 240 default) and stays mounted when the user switches accounts. A stored
  // value arriving from outside re-derives the unit and the draft; a value we
  // committed ourselves does not, so typing is never rewritten (Codex P2).
  const committed = useRef(minutes);
  useEffect(() => {
    if (minutes === committed.current) return;
    committed.current = minutes;
    const hydratedUnit: TimeoutUnit = minutes >= 60 && minutes % 60 === 0 ? "hours" : "minutes";
    setUnit(hydratedUnit);
    setDraft(String(displayValue(minutes, hydratedUnit)));
  }, [minutes]);
  const max = unit === "hours" ? MAX_ESCALATION_TIMEOUT_MINUTES / 60 : MAX_ESCALATION_TIMEOUT_MINUTES;
  const commit = (typed: number, inUnit: TimeoutUnit) => {
    const asMinutes = inUnit === "hours" ? typed * 60 : typed;
    const clamped = Math.min(MAX_ESCALATION_TIMEOUT_MINUTES, Math.max(1, Math.round(asMinutes)));
    committed.current = clamped;
    onChange(clamped);
  };
  const onDraftChange = (value: string) => {
    setDraft(value);
    const typed = Number(value);
    if (value.trim() !== "" && Number.isFinite(typed) && typed > 0) commit(typed, unit);
  };
  const changeUnit = (next: TimeoutUnit) => {
    setUnit(next);
    setDraft(String(displayValue(minutes, next)));
  };
  return (
    <div className="space-y-1.5 pt-1">
      <div className="flex items-center gap-1.5">
        <Label htmlFor="escalation-timeout">{t("identity.escalationTimeout", "Escalation fallback timeout")}</Label>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button type="button" aria-label={t("identity.escalationTimeoutAria", "What the escalation timeout does")} className="text-muted-foreground">
                <HelpCircle className="h-3.5 w-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="max-w-xs">{t("identity.escalationTooltip", ESCALATION_TIMEOUT_TOOLTIP)}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>
      <div className="flex gap-2">
        <Input
          id="escalation-timeout"
          type="number"
          min={unit === "hours" ? 1 / 60 : 1}
          max={max}
          step="any"
          className="w-28"
          value={draft}
          onChange={(event) => onDraftChange(event.target.value)}
          onBlur={() => setDraft(String(displayValue(minutes, unit)))}
        />
        <Select value={unit} onValueChange={(value) => changeUnit(value as TimeoutUnit)}>
          <SelectTrigger className="w-28" aria-label={t("identity.timeoutUnitAria", "Timeout unit")}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="minutes">{t("identity.minutes", "Minutes")}</SelectItem>
            <SelectItem value="hours">{t("identity.hours", "Hours")}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <p className="text-sm text-muted-foreground">{t("identity.escalationHelp", ESCALATION_TIMEOUT_HELP)}</p>
    </div>
  );
}

export function AgentIdentityCard({ form, update, behavior, updateBehavior }: BehaviorCardProps) {
  const { t } = useTranslation("agent");
  const selectedMode = (form.default_mode || "human_then_ai") as AiAgentMode;

  const modeDescription = (mode: AiAgentMode) => {
    switch (mode) {
      case "ai_first":
        return t("identity.modeAiFirstDesc", "The assistant replies first and hands off when needed.");
      case "human_first":
        return t("identity.modeHumanFirstDesc", "A team member replies first; the assistant stays on standby.");
      case "human_then_ai":
        return t("identity.modeHumanThenAiDesc", "A team member gets the first chance, then AI handles the fallback.");
    }
  };

  const toneCopy = (value: AgentTone, label: string, hint: string) => {
    switch (value) {
      case "friendly_professional":
        return { label: t("identity.toneFriendly", label), hint: t("identity.toneFriendlyHint", hint) };
      case "formal":
        return { label: t("identity.toneFormal", label), hint: t("identity.toneFormalHint", hint) };
      case "enthusiastic":
        return { label: t("identity.toneEnthusiastic", label), hint: t("identity.toneEnthusiasticHint", hint) };
      case "concise":
        return { label: t("identity.toneConcise", label), hint: t("identity.toneConciseHint", hint) };
    }
  };

  const lengthCopy = (value: AgentResponseLength, label: string, hint: string) => {
    switch (value) {
      case "short":
        return { label: t("identity.responseShort", label), hint: t("identity.responseShortHint", hint) };
      case "medium":
        return { label: t("identity.responseMedium", label), hint: t("identity.responseMediumHint", hint) };
      case "detailed":
        return { label: t("identity.responseDetailed", label), hint: t("identity.responseDetailedHint", hint) };
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="h-5 w-5" /> {t("identity.title", "Agent identity and voice")}
        </CardTitle>
        <CardDescription>
          {t("identity.description", "Whether the assistant runs, who answers first, and how it sounds when it does.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="flex items-center justify-between gap-4 rounded-lg border p-4">
          <div>
            <Label htmlFor="ai-agent-enabled" className="text-base">
              {t("identity.enable", "Enable AI agent")}
            </Label>
            <p className="text-sm text-muted-foreground">
              {t("identity.enableHint", "Allow this agent to participate according to the selected mode.")}
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
            <Label>{t("identity.defaultMode", "Default engagement mode")}</Label>
            <Select
              value={selectedMode}
              onValueChange={(value) => update("default_mode", value as AiAgentMode)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ai_first">{t("identity.modeAiFirst", "AI First")}</SelectItem>
                <SelectItem value="human_first">{t("identity.modeHumanFirst", "Human First")}</SelectItem>
                <SelectItem value="human_then_ai">{t("identity.modeHumanThenAi", "Human then AI fallback")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">{modeDescription(selectedMode)}</p>
            {selectedMode !== "human_first" && (
              <EscalationTimeoutField
                minutes={form.escalation_timeout_minutes ?? 240}
                onChange={(minutes) => update("escalation_timeout_minutes", minutes)}
              />
            )}
          </div>
          <div className="space-y-2">
            <Label>{t("identity.language", "Language")}</Label>
            <Select
              value={form.language_mode || "auto"}
              onValueChange={(value) => update("language_mode", value as AiAgentLanguageMode)}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("identity.languageAuto", "Auto-detect (Arabic/English)")}</SelectItem>
                <SelectItem value="ar">{t("identity.languageAr", "Arabic only")}</SelectItem>
                <SelectItem value="en">{t("identity.languageEn", "English only")}</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-sm text-muted-foreground">
              {t("identity.languageHint", "Choose whether replies follow the customer's language automatically.")}
            </p>
          </div>
        </div>

        <div className="grid gap-5 md:grid-cols-2">
          <div className="space-y-2">
            <Label>{t("identity.toneOfVoice", "Tone of voice")}</Label>
            <RadioGroup
              value={behavior.tone ?? ""}
              onValueChange={(value) => updateBehavior("tone", value as AgentTone)}
              className="gap-2"
            >
              {TONE_OPTIONS.map((option) => {
                const copy = toneCopy(option.value, option.label, option.hint);
                return (
                  <label
                    key={option.value}
                    className="flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5"
                  >
                    <RadioGroupItem
                      value={option.value}
                      id={`tone-${option.value}`}
                      aria-label={t("identity.optionAria", "{{label}}. {{hint}}", { label: copy.label, hint: copy.hint })}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="block text-sm font-medium">{copy.label}</span>
                      <span className="block text-xs text-muted-foreground">{copy.hint}</span>
                    </span>
                  </label>
                );
              })}
            </RadioGroup>
          </div>

          <div className="space-y-2">
            <Label>{t("identity.replyLength", "Reply length")}</Label>
            <RadioGroup
              value={behavior.response_length ?? ""}
              onValueChange={(value) =>
                updateBehavior("response_length", value as AgentResponseLength)
              }
              className="gap-2"
            >
              {RESPONSE_LENGTH_OPTIONS.map((option) => {
                const copy = lengthCopy(option.value, option.label, option.hint);
                return (
                  <label
                    key={option.value}
                    className="flex cursor-pointer items-start gap-2.5 rounded-md border p-2.5"
                  >
                    <RadioGroupItem
                      value={option.value}
                      id={`length-${option.value}`}
                      aria-label={t("identity.optionAria", "{{label}}. {{hint}}", { label: copy.label, hint: copy.hint })}
                      className="mt-0.5"
                    />
                    <span>
                      <span className="block text-sm font-medium">{copy.label}</span>
                      <span className="block text-xs text-muted-foreground">{copy.hint}</span>
                    </span>
                  </label>
                );
              })}
            </RadioGroup>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
