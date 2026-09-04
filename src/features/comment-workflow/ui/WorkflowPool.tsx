import { useMemo, useState } from "react";
import { formatDistanceToNow } from "date-fns";
import { Pencil, Plus, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { PlatformIcon } from "@/components/PlatformIcon";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import { explainWorkflowError } from "../domain/eventErrors";
import {
  type CommentWorkflowPlatform,
  describeScope,
  describeTrigger,
} from "../domain/rule";
import { useCommentWorkflowRules, useCommentWorkflowStats } from "./hooks/useCommentWorkflowRules";

const FILTERS: Array<{ id: "all" | CommentWorkflowPlatform; label: string }> = [
  { id: "all", label: "All" },
  { id: "facebook", label: "Facebook" },
  { id: "instagram", label: "Instagram" },
  { id: "threads", label: "Threads" },
  { id: "youtube", label: "YouTube" },
];

interface WorkflowPoolProps {
  onCreate: () => void;
  onEdit: (ruleId: string) => void;
}

export function WorkflowPool({ onCreate, onEdit }: WorkflowPoolProps) {
  const { rules, isLoading, isError, remove, setActive } = useCommentWorkflowRules();
  const { statsByRule, isError: statsFailed } = useCommentWorkflowStats();
  const { data: accounts = [] } = useSocialAccounts();
  const [filter, setFilter] = useState<"all" | CommentWorkflowPlatform>("all");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  const visible = useMemo(
    () => rules.filter((rule) => filter === "all" || rule.platform === filter),
    [rules, filter],
  );

  const totals = useMemo(() => {
    const stats = Object.values(statsByRule);
    return {
      active: rules.filter((rule) => rule.is_active).length,
      claimed: stats.reduce((sum, row) => sum + (row.triggered_count ?? 0), 0),
      dms: stats.reduce((sum, row) => sum + (row.dm_sent_count ?? 0), 0),
    };
  }, [rules, statsByRule]);

  // A failed counter read leaves every number at zero, which reads as "none of your funnels
  // has ever fired" -- the alarming interpretation, and the wrong one. Show a dash and say so.
  const count = (value: number | null | undefined) => (statsFailed ? "—" : String(value ?? 0));

  const ago = (iso: string) => formatDistanceToNow(new Date(iso), { addSuffix: true });

  const accountName = (id: string) =>
    accounts.find((account) => account.id === id)?.platform_username ?? "Disconnected account";

  const pendingDeleteRule = rules.find((rule) => rule.id === pendingDelete);

  if (isError) {
    return (
      <Card>
        <CardContent className="p-8 text-center">
          <p className="font-medium">Your workflows could not be loaded</p>
          <p className="text-sm text-muted-foreground">
            This is a loading failure, not an empty list. Reload the page to try again.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      {statsFailed && (
        <p className="rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground">
          Activity counters could not be loaded, so they are shown as dashes. Your workflows are
          unaffected and are still running.
        </p>
      )}
      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Active workflows</p>
            <p className="text-2xl font-semibold">{totals.active}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Comments claimed</p>
            <p className="text-2xl font-semibold">{count(totals.claimed)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Messages sent</p>
            <p className="text-2xl font-semibold">{count(totals.dms)}</p>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-2">
          {FILTERS.map((option) => (
            <Button
              key={option.id}
              size="sm"
              variant={filter === option.id ? "default" : "outline"}
              onClick={() => setFilter(option.id)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        <Button onClick={onCreate}>
          <Plus className="mr-2 h-4 w-4" />
          Create workflow
        </Button>
      </div>

      {!isLoading && visible.length === 0 && (
        <Card>
          <CardContent className="space-y-3 p-8 text-center">
            <p className="font-medium">No comment workflows yet</p>
            <p className="mx-auto max-w-xl text-sm text-muted-foreground">
              A workflow watches your posts for a keyword. When somebody comments it, the workflow
              replies publicly and, on Facebook and Instagram, sends that person one private
              message with your link.
            </p>
            <Button onClick={onCreate}>Create workflow</Button>
          </CardContent>
        </Card>
      )}

      <div className="space-y-3">
        {visible.map((rule) => {
          const stats = statsByRule[rule.id];
          const lastTriggeredAt = statsFailed ? null : stats?.last_triggered_at;
          const lastError = statsFailed ? null : explainWorkflowError(stats?.last_error_message);
          return (
            <Card key={rule.id}>
              <CardContent className="flex flex-wrap items-center gap-4 p-4">
                <PlatformIcon platform={rule.platform} className="h-6 w-6" />
                <div className="min-w-[12rem] flex-1">
                  <p className="font-medium">{rule.name}</p>
                  <p className="text-sm text-muted-foreground">
                    {accountName(rule.social_account_id)} · {describeScope(rule)}
                  </p>
                </div>
                <Badge variant="secondary">{describeTrigger(rule)}</Badge>
                {/* Labelled per workflow: three bare numbers in a row are unreadable to a
                    screen reader, and ambiguous to anyone hovering the wrong one. */}
                <div className="flex gap-4 text-sm tabular-nums">
                  <span aria-label={`${rule.name}: comments claimed`} title="Comments claimed">
                    {count(stats?.triggered_count)}
                  </span>
                  <span aria-label={`${rule.name}: public replies sent`} title="Public replies sent">
                    {count(stats?.public_sent_count)}
                  </span>
                  <span aria-label={`${rule.name}: private messages sent`} title="Private messages sent">
                    {count(stats?.dm_sent_count)}
                  </span>
                </div>
                {!statsFailed && (stats?.failed_count ?? 0) > 0 && (
                  <Badge variant="destructive">{stats?.failed_count} failed</Badge>
                )}
                {!statsFailed && (stats?.indeterminate_count ?? 0) > 0 && (
                  <Badge variant="outline" title="The platform never confirmed these. They may have been delivered.">
                    {stats?.indeterminate_count} unconfirmed
                  </Badge>
                )}
                <Switch
                  checked={rule.is_active}
                  aria-label={`${rule.name} active`}
                  onCheckedChange={(next) => setActive.mutate({ id: rule.id, is_active: next })}
                />
                <Button size="icon" variant="ghost" aria-label={`Edit ${rule.name}`} onClick={() => onEdit(rule.id)}>
                  <Pencil className="h-4 w-4" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={`Delete ${rule.name}`}
                  onClick={() => setPendingDelete(rule.id)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
                {/* Full-width footer: the reason a send failed is the one thing a "failed" badge
                    cannot say, and the only way to learn it otherwise is the server logs. */}
                {(lastTriggeredAt || lastError) && (
                  <div className="basis-full space-y-1 text-sm">
                    {lastTriggeredAt && (
                      <p className="text-muted-foreground">Last triggered {ago(lastTriggeredAt)}</p>
                    )}
                    {lastError && stats?.last_error_at && (
                      <p className="text-destructive" title={stats.last_error_message ?? undefined}>
                        Last error {ago(stats.last_error_at)}: {lastError}
                      </p>
                    )}
                  </div>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>

      <AlertDialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{pendingDeleteRule?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              The workflow stops immediately, and its history is deleted with it. To stop it
              without losing the numbers, switch it off instead.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pendingDelete) remove.mutate(pendingDelete);
                setPendingDelete(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
