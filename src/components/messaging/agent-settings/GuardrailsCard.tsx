import { useTranslation } from "react-i18next";
import "@/i18n";
import { ShieldCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { BehaviorCardProps } from "./types";

/**
 * Two of these rows are NOT switches, and that is the point.
 *
 * `knowledgeOnlyRule` and the escalate-on-unknown rule are unconditional in
 * ai-agent-reply, and were tightened after the 2026-09-01 incident where an
 * agent answered from a persona fallback instead of calling the connector. A
 * toggle here would promise control the prompt does not honour.
 *
 * The contrast with the handoff switches next door is deliberate: those two
 * genuinely gate both the prompt rule and whether escalate_to_human is offered
 * to the model at all, so they are real switches.
 */
const LOCKED_GUARDS = [
  {
    testId: "guard-strict-knowledge",
    title: "Answers only from your knowledge",
    detail: "The assistant never invents prices, stock levels or policies.",
  },
  {
    testId: "guard-admits-unknown",
    title: "Admits what it does not know",
    detail: "It says it will check with the team rather than guessing.",
  },
] as const;

export function GuardrailsCard({ form, update, behavior, updateBehavior }: BehaviorCardProps) {
  const { t } = useTranslation("agent");

  const guardCopy = (testId: (typeof LOCKED_GUARDS)[number]["testId"], title: string, detail: string) => {
    if (testId === "guard-strict-knowledge") {
      return {
        title: t("guardrails.strictTitle", title),
        detail: t("guardrails.strictDetail", detail),
      };
    }
    return {
      title: t("guardrails.admitsTitle", title),
      detail: t("guardrails.admitsDetail", detail),
    };
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("guardrails.title", "Behaviour and guardrails")}</CardTitle>
        <CardDescription>
          {t("guardrails.description", "How the assistant opens a conversation, and the limits it always works within.")}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor="agent-greeting">{t("guardrails.openingMessage", "Opening message")}</Label>
          <Input
            id="agent-greeting"
            value={behavior.greeting ?? ""}
            onChange={(event) => updateBehavior("greeting", event.target.value)}
            placeholder={t("guardrails.openingPlaceholder", "Hi! Welcome to Xsellpoint — how can I help?")}
          />
          <p className="text-xs text-muted-foreground">
            {t("guardrails.openingHint", "Used on the assistant's first reply in a conversation only.")}
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="persona-instructions">{t("guardrails.additionalInstructions", "Additional instructions (free text)")}</Label>
          <Textarea
            id="persona-instructions"
            value={form.persona_instructions || ""}
            onChange={(event) => update("persona_instructions", event.target.value)}
            placeholder={t("guardrails.additionalPlaceholder", "Describe your tone, policies, and how the assistant should help customers.")}
            rows={5}
          />
        </div>

        <div className="space-y-2">
          {LOCKED_GUARDS.map((guard) => {
            const copy = guardCopy(guard.testId, guard.title, guard.detail);
            return (
              <div
                key={guard.testId}
                data-testid={guard.testId}
                className="flex items-start gap-3 rounded-md border bg-muted/30 p-3"
              >
                <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                <div className="flex-1">
                  <p className="text-sm font-medium">{copy.title}</p>
                  <p className="text-xs text-muted-foreground">{copy.detail}</p>
                </div>
                <Badge variant="outline" className="shrink-0">
                  {t("guardrails.alwaysOn", "Always on")}
                </Badge>
              </div>
            );
          })}
          <p className="text-xs text-muted-foreground">
            {t("guardrails.lockedHint", "These two cannot be turned off. They are what stops the assistant inventing an answer.")}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
