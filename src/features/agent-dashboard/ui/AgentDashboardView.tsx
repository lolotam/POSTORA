import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import { BarChart3, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import {
  type AccountOutcomeCounts,
  type AgentDashboard,
  estimateCost,
  fastPathShare,
  share,
} from "../domain/agentDashboard";
import { type DashboardWindow, useAgentDashboard, useModelPrices } from "./hooks/useAgentDashboard";

const WINDOWS: readonly DashboardWindow[] = [7, 30];
const TOP_LIST_SIZE = 5;

function percent(value: number | null): string {
  return value === null ? "—" : `${Math.round(value * 100)}%`;
}

function seconds(ms: number | null): string {
  return ms === null ? "—" : `${(ms / 1000).toFixed(1)}s`;
}

function usd(value: number): string {
  return value > 0 && value < 0.01 ? "<$0.01" : `$${value.toFixed(2)}`;
}

function StatCard({ testId, label, value, hint }: { testId: string; label: string; value: string; hint?: string }) {
  return (
    <Card data-testid={testId}>
      <CardContent className="space-y-1 py-4">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  );
}

function useIntentLabel() {
  const { t } = useTranslation("agent");
  return (intent: string): string => {
    switch (intent) {
      case "pricing":
        return t("dashboard.intent.pricing", "Pricing");
      case "order_status":
        return t("dashboard.intent.orderStatus", "Order status");
      case "complaint":
        return t("dashboard.intent.complaint", "Complaint");
      case "lead":
        return t("dashboard.intent.lead", "Lead");
      case "booking":
        return t("dashboard.intent.booking", "Booking");
      case "greeting":
        return t("dashboard.intent.greeting", "Greeting");
      case "other":
        return t("dashboard.intent.other", "Other");
      default:
        return intent;
    }
  };
}

function useSkipReasonLabel() {
  const { t } = useTranslation("agent");
  return (reason: string): string => {
    switch (reason) {
      case "human_agent_active":
        return t("dashboard.skip.humanAgentActive", "A human is handling the chat");
      case "mode_human_first":
        return t("dashboard.skip.modeHumanFirst", "Conversation set to human first");
      case "outside_service_window":
        return t("dashboard.skip.outsideServiceWindow", "Outside the 24-hour messaging window");
      case "cooldown_active":
        return t("dashboard.skip.cooldownActive", "Reply cooldown");
      case "daily_cap_reached":
        return t("dashboard.skip.dailyCapReached", "Daily reply cap reached");
      case "agent_disabled":
        return t("dashboard.skip.agentDisabled", "Agent turned off");
      case "agent_not_configured":
        return t("dashboard.skip.agentNotConfigured", "Agent not set up");
      case "no_reply_generated":
        return t("dashboard.skip.noReplyGenerated", "The model produced no reply");
      case "AI_CONNECTION_REQUIRED":
        return t("dashboard.skip.aiConnectionRequired", "No AI connection");
      case "AI_USER_KEY_INVALID":
        return t("dashboard.skip.aiUserKeyInvalid", "Your AI key was rejected");
      default:
        return reason;
    }
  };
}

function RankedList({ title, rows, empty }: { title: string; rows: Array<{ key: string; label: string; count: number }>; empty: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{empty}</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {rows.map((row) => (
              <li key={row.key} className="flex justify-between gap-2">
                <span>{row.label}</span>
                <span className="tabular-nums text-muted-foreground">{row.count}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AccountTable({ rows }: { rows: AccountOutcomeCounts[] }) {
  const { t } = useTranslation("agent");
  const { data: socialAccounts = [] } = useSocialAccounts();
  const nameOf = (row: AccountOutcomeCounts) => {
    if (!row.socialAccountId) return t("dashboard.accounts.untracked", "Before account tracking");
    const account = socialAccounts.find((candidate) => candidate.id === row.socialAccountId);
    return account?.platform_username || row.socialAccountId.slice(0, 8);
  };

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm">{t("dashboard.accounts.title", "By account")}</CardTitle>
      </CardHeader>
      <CardContent className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("dashboard.accounts.account", "Account")}</TableHead>
              <TableHead className="text-end">{t("dashboard.answered", "Answered by AI (no handoff)")}</TableHead>
              <TableHead className="text-end">{t("dashboard.escalated", "Handed off to a human")}</TableHead>
              <TableHead className="text-end">{t("dashboard.skipped", "Skipped")}</TableHead>
              <TableHead className="text-end">{t("dashboard.errors", "Errors")}</TableHead>
              <TableHead className="text-end">{t("dashboard.accounts.median", "Median latency")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={`${row.platform ?? ""}:${row.socialAccountId ?? "untracked"}`}>
                <TableCell>{nameOf(row)}</TableCell>
                <TableCell className="text-end tabular-nums">{row.answered}</TableCell>
                <TableCell className="text-end tabular-nums">{row.escalated}</TableCell>
                <TableCell className="text-end tabular-nums">{row.skipped}</TableCell>
                <TableCell className="text-end tabular-nums">{row.errors}</TableCell>
                <TableCell className="text-end tabular-nums">{seconds(row.latencyP50Ms)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function DashboardBody({ data }: { data: AgentDashboard }) {
  const { t } = useTranslation("agent");
  const { data: prices = [] } = useModelPrices();
  const intentLabel = useIntentLabel();
  const skipReasonLabel = useSkipReasonLabel();
  const { totals } = data;
  const ofItems = (count: number) =>
    t("dashboard.ofItems", "{{share}} of {{total}} messages", { share: percent(share(count, totals.items)), total: totals.items });
  const cost = estimateCost(data.models, prices);

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard testId="stat-answered" label={t("dashboard.answered", "Answered by AI (no handoff)")} value={String(totals.answered)} hint={ofItems(totals.answered)} />
        <StatCard testId="stat-escalated" label={t("dashboard.escalated", "Handed off to a human")} value={String(totals.escalated)} hint={ofItems(totals.escalated)} />
        <StatCard testId="stat-skipped" label={t("dashboard.skipped", "Skipped")} value={String(totals.skipped)} hint={ofItems(totals.skipped)} />
        <StatCard testId="stat-errors" label={t("dashboard.errors", "Errors")} value={String(totals.errors)} hint={ofItems(totals.errors)} />
        <StatCard
          testId="stat-latency"
          label={t("dashboard.latency", "Reply latency (median / p90)")}
          value={`${seconds(totals.latencyP50Ms)} / ${seconds(totals.latencyP90Ms)}`}
          hint={t("dashboard.latencyHint", "Over replies that were sent")}
        />
        <StatCard
          testId="stat-tokens"
          label={t("dashboard.tokens", "Tokens (prompt / completion)")}
          value={`${totals.promptTokens.toLocaleString()} / ${totals.completionTokens.toLocaleString()}`}
          hint={t("dashboard.tokensHint", "Every billed attempt, retries included")}
        />
        <StatCard
          testId="stat-cost"
          label={t("dashboard.cost", "Estimated cost")}
          value={cost.usd === null ? "—" : usd(cost.usd)}
          hint={cost.usd === null
            ? t("dashboard.costUnpriced", "No catalogue price for the models used")
            : t("dashboard.costHint", "From the model catalogue; covers {{share}} of tokens, excludes triage", { share: percent(cost.pricedShare) })}
        />
        <StatCard
          testId="stat-fast-path"
          label={t("dashboard.fastPath", "Triage fast path")}
          value={percent(fastPathShare(totals))}
          hint={t("dashboard.fastPathHint", "{{count}} of {{triaged}} triaged messages skipped knowledge lookup", { count: totals.fastPath, triaged: totals.triaged })}
        />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <RankedList
          title={t("dashboard.intents", "Top intents")}
          empty={t("dashboard.intentsEmpty", "No confident intents yet")}
          rows={data.intents.slice(0, TOP_LIST_SIZE).map((row) => ({ key: row.intent, label: intentLabel(row.intent), count: row.count }))}
        />
        <RankedList
          title={t("dashboard.skipReasons", "Why messages were skipped")}
          empty={t("dashboard.skipReasonsEmpty", "Nothing was skipped")}
          rows={data.skipReasons.slice(0, TOP_LIST_SIZE).map((row) => ({ key: row.reason, label: skipReasonLabel(row.reason), count: row.count }))}
        />
      </div>

      {data.accounts.length > 0 && <AccountTable rows={data.accounts} />}

      <p className="text-xs text-muted-foreground">
        {t(
          "dashboard.footnote",
          "Each inbound message counts once, even when it was retried. \"Answered by AI\" means a reply was sent without a handoff; it does not mean the customer's question was settled. Test-chat runs are excluded. Intents (at least 80% confidence), the fast path and per-account figures are recorded from the dashboard's release onwards.",
        )}
      </p>
    </div>
  );
}

/**
 * The AI Agent dashboard for one platform: outcomes, latency, tokens and triage over
 * the last 7 or 30 days. Lives beside the agent's Logs tab, which shows the raw rows.
 */
export function AgentDashboardView({ platform }: { platform: string }) {
  const { t } = useTranslation("agent");
  const [days, setDays] = useState<DashboardWindow>(7);
  const { data, isLoading, error } = useAgentDashboard(days, platform);

  const windowLabel = (value: DashboardWindow) =>
    value === 7 ? t("dashboard.last7", "Last 7 days") : t("dashboard.last30", "Last 30 days");

  let body: ReactNode;
  if (error) {
    body = (
      <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
        {t("dashboard.loadError", "The dashboard could not be loaded. {{message}}", {
          message: error instanceof Error ? error.message : "",
        })}
      </p>
    );
  } else if (isLoading || !data) {
    body = (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  } else if (data.totals.items === 0 && data.totals.promptTokens + data.totals.completionTokens === 0) {
    body = (
      <Card>
        <CardContent className="flex min-h-48 flex-col items-center justify-center text-center">
          <BarChart3 className="mb-3 h-9 w-9 text-muted-foreground/50" />
          <p className="font-medium">{t("dashboard.empty", "No agent activity in the last {{days}} days", { days })}</p>
        </CardContent>
      </Card>
    );
  } else {
    body = <DashboardBody data={data} />;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {WINDOWS.map((value) => (
          <Button
            key={value}
            size="sm"
            variant={value === days ? "default" : "outline"}
            aria-pressed={value === days}
            onClick={() => setDays(value)}
          >
            {windowLabel(value)}
          </Button>
        ))}
      </div>
      {body}
    </div>
  );
}
