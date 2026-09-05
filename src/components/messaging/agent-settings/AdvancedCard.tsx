import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { AgentCardProps } from "./types";

export function AdvancedCard({ form, update }: AgentCardProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Advanced</CardTitle>
        <CardDescription>Daily conversation limits and response cooldown settings.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-5 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="daily-cap">Daily message cap</Label>
            <Input
              id="daily-cap"
              type="number"
              min={1}
              value={form.daily_message_cap ?? 50}
              onChange={(event) => update("daily_message_cap", Number(event.target.value))}
            />
            <p className="text-xs text-muted-foreground">
              Maximum automated replies sent per day.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cooldown">Reply cooldown (seconds)</Label>
            <Input
              id="cooldown"
              type="number"
              min={0}
              value={form.reply_cooldown_seconds ?? 0}
              onChange={(event) => update("reply_cooldown_seconds", Number(event.target.value))}
            />
            <p className="text-xs text-muted-foreground">
              Wait time between consecutive AI replies (0 for instant).
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
