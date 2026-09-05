import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { GOAL_OPTIONS, type AgentGoal } from "@/lib/agentProfile";
import type { BehaviorCardProps } from "./types";

export function BusinessGoalsCard({ behavior, updateBehavior }: BehaviorCardProps) {
  const goals = behavior.goals ?? [];

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
        <CardTitle className="text-base">What this agent is for</CardTitle>
        <CardDescription>
          The objectives the assistant works towards in every conversation.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-3">
          {GOAL_OPTIONS.map((option) => (
            <label key={option.value} className="flex cursor-pointer items-center gap-3 text-sm">
              <Checkbox
                checked={goals.includes(option.value)}
                onCheckedChange={(value) => toggle(option.value, value === true)}
                aria-label={option.label}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
