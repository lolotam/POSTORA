import { useTranslation } from "react-i18next";
import "@/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import type { AgentCardProps } from "./types";

export function AdvancedCard({ form, update }: AgentCardProps) {
  const { t } = useTranslation("agent");

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("advanced.title", "Advanced")}</CardTitle>
        <CardDescription>{t("advanced.description", "Daily conversation limits and response cooldown settings.")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-5 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="daily-cap">{t("advanced.dailyCap", "Daily message cap")}</Label>
            <Input
              id="daily-cap"
              type="number"
              min={1}
              value={form.daily_message_cap ?? 50}
              onChange={(event) => update("daily_message_cap", Number(event.target.value))}
            />
            <p className="text-xs text-muted-foreground">
              {t("advanced.dailyCapHint", "Maximum automated replies sent per day.")}
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="cooldown">{t("advanced.cooldown", "Reply cooldown (seconds)")}</Label>
            <Input
              id="cooldown"
              type="number"
              min={0}
              value={form.reply_cooldown_seconds ?? 0}
              onChange={(event) => update("reply_cooldown_seconds", Number(event.target.value))}
            />
            <p className="text-xs text-muted-foreground">
              {t("advanced.cooldownHint", "Wait time between consecutive AI replies (0 for instant).")}
            </p>
          </div>
        </div>
        {/* Opt-in: the tool is offered to the model only while this is on, and each
            search adds one to several seconds to the reply. */}
        <div className="flex items-start justify-between gap-4 rounded-md border p-3">
          <div className="space-y-1">
            <Label htmlFor="web-search-enabled" className="font-normal">
              {t("advanced.webSearch", "Use web search")}
            </Label>
            <p className="text-xs text-muted-foreground">
              {t(
                "advanced.webSearchHint",
                "Lets the agent look up current public information (prices, news, events) when your knowledge base cannot answer. Replies that search take a few seconds longer.",
              )}
            </p>
          </div>
          <Switch
            id="web-search-enabled"
            aria-label={t("advanced.webSearch", "Use web search")}
            checked={form.web_search_enabled ?? false}
            onCheckedChange={(checked) => update("web_search_enabled", checked)}
          />
        </div>
      </CardContent>
    </Card>
  );
}
