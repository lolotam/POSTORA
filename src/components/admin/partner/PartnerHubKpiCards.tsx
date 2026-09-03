import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Activity, KeyRound, MessageSquare, Webhook } from "lucide-react";
import type { PartnerHubOverview } from "@/features/partner-hub";

interface PartnerHubKpiCardsProps {
  overview: PartnerHubOverview | undefined;
  isLoading: boolean;
  error: Error | null;
}

function percent(numerator: number, denominator: number): string {
  return denominator > 0 ? `${Math.round((numerator / denominator) * 100)}%` : "—";
}

export function PartnerHubKpiCards({ overview, isLoading, error }: PartnerHubKpiCardsProps) {
  if (error) {
    return <p className="text-sm text-destructive">Could not load partner metrics: {error.message}</p>;
  }
  const settled = (overview?.delivered_30d ?? 0) + (overview?.exhausted_30d ?? 0);
  const cards = [
    { title: "Active partners", icon: KeyRound, value: overview ? String(overview.active_keys) : null, hint: `${overview?.revoked_keys ?? 0} revoked` },
    { title: "Monthly consumption", icon: MessageSquare, value: overview ? String(overview.month_billable) : null, hint: `billable sends this month · ${overview?.month_posts ?? 0} posts created` },
    { title: "API health (30d)", icon: Activity, value: overview ? percent(overview.success_30d, overview.requests_30d) : null, hint: `${overview?.requests_30d ?? 0} authenticated requests` },
    { title: "Webhooks health (30d)", icon: Webhook, value: overview ? percent(overview.delivered_30d, settled) : null, hint: `${overview?.deliveries_30d ?? 0} deliveries · ${overview?.pending_deliveries ?? 0} pending` },
  ];
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => (
        <Card key={card.title}>
          <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
            <CardTitle className="text-sm font-medium">{card.title}</CardTitle>
            <card.icon className="h-4 w-4 text-muted-foreground" />
          </CardHeader>
          <CardContent>
            {isLoading || card.value === null ? <Skeleton className="h-8 w-16" /> : <div className="text-2xl font-bold">{card.value}</div>}
            <p className="text-xs text-muted-foreground">{card.hint}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
