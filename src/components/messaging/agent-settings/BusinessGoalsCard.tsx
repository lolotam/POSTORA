import { useTranslation } from "react-i18next";
import "@/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { GOAL_OPTIONS, type AgentGoal } from "@/lib/agentProfile";
import type { BehaviorCardProps } from "./types";

export function BusinessGoalsCard({ behavior, updateBehavior }: BehaviorCardProps) {
  const { t } = useTranslation("agent");
  const goals = behavior.goals ?? [];

  const goalLabel = (goal: AgentGoal, fallback: string) => {
    switch (goal) {
      case "recommend_products":
        return t("goals.recommendProducts", fallback);
      case "answer_pricing":
        return t("goals.answerPricing", fallback);
      case "handle_complaints":
        return t("goals.handleComplaints", fallback);
      case "capture_leads":
        return t("goals.captureLeads", fallback);
    }
  };

  const toggle = (goal: AgentGoal, checked: boolean) =>
    updateBehavior(
      "goals",
      // Filtered from the canonical option order rather than appended, so the
      // saved array -- and therefore the order of objectives the model reads --
      // does not depend on the order the user happened to tick the boxes in.
      GOAL_OPTIONS.map((option) => option.value).filter((value) =>
        value === goal ? checked : goals.includes(value),
      ),
    );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("goals.title", "What this agent is for")}</CardTitle>
        <CardDescription>
          {t("goals.description", "The objectives the assistant works towards in every conversation.")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {GOAL_OPTIONS.map((option) => {
            const label = goalLabel(option.value, option.label);
            return (
              <label key={option.value} className="flex cursor-pointer items-center gap-3 text-sm">
                <Checkbox
                  checked={goals.includes(option.value)}
                  onCheckedChange={(value) => toggle(option.value, value === true)}
                  aria-label={label}
                />
                <span>{label}</span>
              </label>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
