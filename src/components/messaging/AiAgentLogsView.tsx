import { useState } from "react";
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

function statusBadge(log: AiAgentLog) {
  if (log.status === "sent") return <Badge>sent</Badge>;
  if (log.status === "error") return <Badge variant="destructive">error</Badge>;
  return (
    <Badge variant="secondary">
      {log.status}
      {log.error ? ` · ${log.error}` : ""}
    </Badge>
  );
}

function SourceBadge({ source }: { source: AgentActivity["source"] }) {
  return source === "postora" ? (
    <Badge variant="outline" className="gap-1 border-primary/40 text-primary">
      <Bot className="h-3 w-3" />
      Postora agent
    </Badge>
  ) : (
    <Badge variant="outline" className="gap-1 border-amber-500/50 text-amber-700 dark:text-amber-300">
      <Workflow className="h-3 w-3" />
      n8n
    </Badge>
  );
}

function ActivityMeta({ children }: { children: React.ReactNode }) {
  return <span className="ms-auto text-xs text-muted-foreground">{children}</span>;
}

function PostoraEntry({ log }: { log: AiAgentLog }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <SourceBadge source="postora" />
        {statusBadge(log)}
        {(log.tool_calls || []).map((call, index) => (
          <Badge key={`${log.id}-tool-${index}`} variant="outline">
            {call.name}
          </Badge>
        ))}
        <ActivityMeta>
          {formatDistanceToNow(new Date(log.created_at), { addSuffix: true })}
          {log.latency_ms ? ` · ${(log.latency_ms / 1000).toFixed(1)}s` : ""}
          {log.prompt_tokens
            ? ` · ${(log.prompt_tokens || 0) + (log.completion_tokens || 0)} tokens`
            : ""}
        </ActivityMeta>
      </div>
      {log.inbound_text && (
        <p className="text-sm">
          <span className="font-medium text-muted-foreground">Customer: </span>
          <span className="line-clamp-2">{log.inbound_text}</span>
        </p>
      )}
      {log.reply_text && (
        <p className="text-sm">
          <span className="font-medium text-muted-foreground">AI: </span>
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
  const { destination_count: destinations, event, inbound_text, created_at } = dispatch.dispatch;
  const delivered = destinations ?? 0;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <SourceBadge source="n8n" />
        {delivered > 0 ? (
          <Badge variant="secondary">
            {delivered === 1 ? "1 workflow" : `${delivered} workflows`}
          </Badge>
        ) : (
          <Badge variant="destructive">no workflow listening</Badge>
        )}
        {event && <Badge variant="outline">{event}</Badge>}
        <ActivityMeta>{formatDistanceToNow(new Date(created_at), { addSuffix: true })}</ActivityMeta>
      </div>
      {inbound_text && (
        <p className="text-sm">
          <span className="font-medium text-muted-foreground">Customer: </span>
          <span className="line-clamp-2">{inbound_text}</span>
        </p>
      )}
      <p className="text-xs text-muted-foreground">
        {delivered > 0
          ? "Handed to your n8n workflow. Postora does not see what it replied — check the run in n8n."
          : "No n8n workflow was subscribed to this event, so nothing was sent."}
      </p>
    </>
  );
}

const SOURCE_LABELS: Record<ActivitySourceFilter, string> = {
  all: "All handlers",
  postora: "Postora agent",
  n8n: "n8n",
};

export function AiAgentLogsView({ platform }: { platform: AiAgentPlatform }) {
  const [source, setSource] = useState<ActivitySourceFilter>("all");
  const { entries, isLoading, dispatchError } = useAgentActivity(platform);
  const visible = filterActivity(entries, source);

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
            {(Object.keys(SOURCE_LABELS) as ActivitySourceFilter[]).map((key) => (
              <SelectItem key={key} value={key}>
                {SOURCE_LABELS[key]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {entries.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {visible.length} of {entries.length}
          </span>
        )}
      </div>

      {dispatchError && source !== "postora" && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-700 dark:text-amber-300">
          n8n hand-offs could not be loaded, so only the Postora agent&apos;s own activity is
          shown. {dispatchError instanceof Error ? dispatchError.message : "Unknown error"}
        </p>
      )}

      {visible.length === 0 ? (
        <Card>
          <CardContent className="flex min-h-48 flex-col items-center justify-center text-center">
            <Bot className="mb-3 h-9 w-9 text-muted-foreground/50" />
            <p className="font-medium">
              {source === "all" ? "No agent activity yet" : `No activity from ${SOURCE_LABELS[source]}`}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              Replies, skips, escalations, and hand-offs to n8n will appear here.
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
