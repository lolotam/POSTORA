import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AgentCardProps } from "./types";

/**
 * What the assistant is told about itself, and what it is never allowed to do.
 *
 * The locked guard rows arrive with the behavior slice. They are deliberately
 * NOT switches: `knowledgeOnlyRule` and the escalate-on-unknown rule in
 * ai-agent-reply are unconditional, and were tightened after the 2026-09-01
 * incident where an agent answered from a persona fallback instead of the
 * connector. A toggle here would promise control the prompt does not honour.
 */
export function GuardrailsCard({ form, update }: AgentCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Behaviour and guardrails</CardTitle>
        <CardDescription>
          How the assistant presents itself, and the limits it always works within.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <Label htmlFor="persona-instructions">Persona and instructions</Label>
          <Textarea
            id="persona-instructions"
            value={form.persona_instructions || ""}
            onChange={(event) => update("persona_instructions", event.target.value)}
            placeholder="Describe your tone, policies, and how the assistant should help customers."
            rows={5}
          />
        </div>
      </CardContent>
    </Card>
  );
}
