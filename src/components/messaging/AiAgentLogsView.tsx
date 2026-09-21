import { useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import { Bot, Loader2, Workflow } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { type AiAgentLog } from "@/hooks/useAiAgentLogs";
import { type AiAgentPlatform } from "@/hooks/useAiAgentConfig";
import {
  type ActivitySourceFilter,
  type AgentActivity,
  filterActivity,
  useAgentActivity,
} from "@/hooks/useAgentActivity";

function statusBadge(log: AiAgentLog, sentLabel: string, errorLabel: string) {
  if (log.status === "sent") return <Badge>{sentLabel}</Badge>;
  if (log.status === "error") return <Badge variant="destructive">{errorLabel}</Badge>;
  return (
    <Badge variant="secondary">
      {log.status}
      {log.error ? ` · ${log.error}` : ""}
    </Badge>
  );
}

function SourceBadge({ source, postoraLabel, n8nLabel }: { source: AgentActivity["source"]; postoraLabel: string; n8nLabel: string }) {
  return source === "postora" ? (
    <Badge variant="outline" className="gap-1 border-primary/40 text-primary">
      <Bot className="h-3 w-3" />
      {postoraLabel}
    </Badge>
  ) : (
    <Badge variant="outline" className="gap-1 border-amber-500/50 text-amber-700 dark:text-amber-300">
      <Workflow className="h-3 w-3" />
      {n8nLabel}
    </Badge>
  );
}

function ActivityMeta({ children }: { children: React.ReactNode }) {
  return <span className="ms-auto text-xs text-muted-foreground">{children}</span>;
}

function PostoraEntry({ log }: { log: AiAgentLog }) {
  const { t } = useTranslation("agent");
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <SourceBadge source="postora" postoraLabel={t("logs.postoraBadge", "Postora agent")} n8nLabel={t("logs.n8nBadge", "n8n")} />
        {statusBadge(log, t("logs.sent", "sent"), t("logs.error", "error"))}
        {(log.tool_calls || []).map((call, index) => (
          <Badge key={`${log.id}-tool-${index}`} variant="outline">
            {call.name}
          </Badge>
        ))}
        <ActivityMeta>
          {formatDistanceToNow(new Date(log.created_at), { addSuffix: true })}
          {log.latency_ms ? t("logs.latency", " · {{seconds}}s", { seconds: (log.latency_ms / 1000).toFixed(1) }) : ""}
          {log.prompt_tokens
            ? t("logs.tokensSuffix", " · {{count}} tokens", { count: (log.prompt_tokens || 0) + (log.completion_tokens || 0) })
            : ""}
        </ActivityMeta>
      </div>
      {log.inbound_text && (
        <p className="text-sm">
          <span className="font-medium text-muted-foreground">{t("logs.customer", "Customer: ")}</span>
          <span className="line-clamp-2">{log.inbound_text}</span>
        </p>
      )}
      {log.reply_text && (
        <p className="text-sm">
          <span className="font-medium text-muted-foreground">{t("logs.replyLabel", "AI: ")}</span>
          <span className="line-clamp-3">{log.reply_text}</span>
        </p>
      )}
      {log.status === "error" && log.error && (
        <p className="text-xs text-destructive">{log.error}</p>
      )}
    </>
  );
}

function N8nEntry({ dispatch }: { dispatch: AgentActivity & { source: "n8n" } }) {
  const { t } = useTranslation("agent");
  const { destination_count: destinations, event, inbound_text, created_at } = dispatch.dispatch;
  const delivered = destinations ?? 0;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <SourceBadge source="n8n" postoraLabel={t("logs.postoraBadge", "Postora agent")} n8nLabel={t("logs.n8nBadge", "n8n")} />
        {delivered > 0 ? (
          <Badge variant="secondary">
            {delivered === 1
              ? t("logs.oneWorkflow", "1 workflow")
              : t("logs.workflows", "{{count}} workflows", { count: delivered })}
          </Badge>
        ) : (
          <Badge variant="destructive">{t("logs.noWorkflow", "no workflow listening")}</Badge>
        )}
        {event && <Badge variant="outline">{event}</Badge>}
        <ActivityMeta>{formatDistanceToNow(new Date(created_at), { addSuffix: true })}</ActivityMeta>
      </div>
      {inbound_text && (
        <p className="text-sm">
          <span className="font-medium text-muted-foreground">{t("logs.customer", "Customer: ")}</span>
          <span className="line-clamp-2">{inbound_text}</span>
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {delivered > 0
          ? t("logs.handedOff", "Handed to your n8n workflow. Postora does not see what it replied — check the run in n8n.")
          : t("logs.noWorkflowHint", "No n8n workflow was subscribed to this event, so nothing was sent.")}
      </p>
    </>
  );
}

export function AiAgentLogsView({ platform }: { platform: AiAgentPlatform }) {
  const { t } = useTranslation("agent");
  const [source, setSource] = useState<ActivitySourceFilter>("all");
  const { entries, isLoading, dispatchError } = useAgentActivity(platform);
  const visible = filterActivity(entries, source);

  const sourceLabel = (key: ActivitySourceFilter) => {
    switch (key) {
      case "all":
        return t("logs.filterAll", "All handlers");
      case "postora":
        return t("logs.filterPostora", "Postora agent");
      case "n8n":
        return t("logs.filterN8n", "n8n");
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Select value={source} onValueChange={(value) => setSource(value as ActivitySourceFilter)}>
          <SelectTrigger className="h-9 w-[190px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(["all", "postora", "n8n"] as const).map((key) => (
              <SelectItem key={key} value={key}>
                {sourceLabel(key)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {entries.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {t("logs.visibleOf", "{{visible}} of {{total}}", { visible: visible.length, total: entries.length })}
          </span>
        )}
      </div>

      {dispatchError && source !== "postora" && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
          {t("logs.dispatchError", "n8n hand-offs could not be loaded, so only the Postora agent's own activity is shown. {{message}}", {
            message: dispatchError instanceof Error ? dispatchError.message : t("logs.unknownError", "Unknown error"),
          })}
        </p>
      )}

      {visible.length === 0 ? (
        <Card>
          <CardContent className="flex min-h-48 flex-col items-center justify-center text-center">
            <Bot className="mb-3 h-9 w-9 text-muted-foreground/50" />
            <p className="font-medium">
              {source === "all"
                ? t("logs.emptyAll", "No agent activity yet")
                : t("logs.emptyFrom", "No activity from {{source}}", { source: sourceLabel(source) })}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("logs.emptyHint", "Replies, skips, escalations, and hand-offs to n8n will appear here.")}
            </p>
          </CardContent>
        </Card>
      ) : (
        visible.map((entry) => (
          <Card key={entry.id}>
            <CardContent className="space-y-2 py-4">
              {entry.source === "postora"
                ? <PostoraEntry log={entry.log} />
                : <N8nEntry dispatch={entry} />}
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
