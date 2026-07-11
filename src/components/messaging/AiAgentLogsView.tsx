import { Bot, Loader2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useAiAgentLogs, type AiAgentLog } from "@/hooks/useAiAgentLogs";
import { type AiAgentPlatform } from "@/hooks/useAiAgentConfig";

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

export function AiAgentLogsView({ platform }: { platform: AiAgentPlatform }) {
  const { data: logs = [], isLoading } = useAiAgentLogs(platform);

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (logs.length === 0) {
    return (
      <Card>
        <CardContent className="flex min-h-48 flex-col items-center justify-center text-center">
          <Bot className="mb-3 h-9 w-9 text-muted-foreground/50" />
          <p className="font-medium">No AI agent activity yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Replies, skips, and escalations will appear here.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {logs.map((log) => (
        <Card key={log.id}>
          <CardContent className="space-y-2 py-4">
            <div className="flex flex-wrap items-center gap-2">
              {statusBadge(log)}
              {(log.tool_calls || []).map((call, index) => (
                <Badge key={`${log.id}-tool-${index}`} variant="outline">
                  {call.name}
                </Badge>
              ))}
              <span className="ml-auto text-xs text-muted-foreground">
                {formatDistanceToNow(new Date(log.created_at), { addSuffix: true })}
                {log.latency_ms ? ` · ${(log.latency_ms / 1000).toFixed(1)}s` : ""}
                {log.prompt_tokens
                  ? ` · ${(log.prompt_tokens || 0) + (log.completion_tokens || 0)} tokens`
                  : ""}
              </span>
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
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
