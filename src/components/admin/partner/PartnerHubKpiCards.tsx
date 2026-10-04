import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, AlertTriangle, KeyRound, MessageSquare, Plug, Webhook } from "lucide-react";
import type { ConnectorOverview, PartnerHubOverview } from "@/features/partner-hub";

interface PartnerHubKpiCardsProps {
  overview: PartnerHubOverview | undefined;
  /** Connector metering (spec §9.2). Read separately from the partner-key
   *  overview, so it is passed in separately and may lag it. */
  connectorOverview?: ConnectorOverview;
  /** A refused connector read must not sit as a permanent skeleton — that is
   *  a failure wearing "still loading". */
  connectorError?: Error | null;
  isLoading: boolean;
  error: Error | null;
}

function percent(numerator: number, denominator: number): string {
  return denominator > 0 ? `${Math.round((numerator / denominator) * 100)}%` : "—";
}

export function PartnerHubKpiCards({ overview, connectorOverview, connectorError, isLoading, error }: PartnerHubKpiCardsProps) {
  if (error) {
    return <p className="text-sm text-destructive">Could not load partner metrics: {error.message}</p>;
  }
  const settled = (overview?.delivered_30d ?? 0) + (overview?.exhausted_30d ?? 0);
  const cards = [
    { title: "Active partners", icon: KeyRound, value: overview ? String(overview.active_keys) : null, hint: `${overview?.revoked_keys ?? 0} revoked` },
    { title: "Monthly consumption", icon: MessageSquare, value: overview ? String(overview.month_billable) : null, hint: `billable sends this month · ${overview?.month_posts ?? 0} posts created` },
    { title: "API health (30d)", icon: Activity, value: overview ? percent(overview.success_30d, overview.requests_30d) : null, hint: `${overview?.requests_30d ?? 0} authenticated requests` },
    { title: "Webhooks health (30d)", icon: Webhook, value: overview ? percent(overview.delivered_30d, settled) : null, hint: `${overview?.deliveries_30d ?? 0} deliveries · ${overview?.pending_deliveries ?? 0} pending` },
    // An unread connector overview shows a skeleton, never 0: "no calls" and
    // "not read yet" are different facts and only one is safe to state.
    { title: "Connector calls (30 d)", icon: Plug, value: connectorOverview ? String(connectorOverview.calls_30d) : null, hint: connectorError ? `Could not load: ${connectorError.message}` : `${connectorOverview?.active_connections ?? 0} active connections across ${connectorOverview?.workspaces_with_connections ?? 0} workspaces`, failed: Boolean(connectorError) },
    { title: "Connector failures (30 d)", icon: AlertTriangle, value: connectorOverview ? String(connectorOverview.failures_30d) : null, hint: connectorError ? `Could not load: ${connectorError.message}` : `${connectorOverview?.refused_30d ?? 0} refused · p95 ${connectorOverview?.p95_latency_30d ?? "—"} ms`, failed: Boolean(connectorError) },
  ];
  return (
    <div className="grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.title}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
            <card.icon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {"failed" in card && card.failed ? (
              <div className="text-2xl font-bold text-destructive">—</div>
            ) : isLoading || card.value === null ? (
              <Skeleton className="h-8 w-16" />
            ) : (
              <div className="text-2xl font-bold">{card.value}</div>
            )}
            <p className={"failed" in card && card.failed ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>{card.hint}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
