import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, Loader2, Radio, WifiOff } from "lucide-react";
import { useWebhookSubscriptions } from "./hooks/useWebhookObservability";
import type { WebhookSubscription } from "../infrastructure/webhookObservabilityApi";

/** Ten consecutive delivery failures is where dispatch stops retrying a destination. */
const AUTO_DISABLE_THRESHOLD = 10;

function registryLabel(registry: string): string {
  return registry === "legacy" ? "WhatsApp webhook" : "n8n trigger";
}

function SubscriptionRow({ subscription }: { subscription: WebhookSubscription }) {
  const autoDisabled =
    !subscription.is_active && subscription.failure_count >= AUTO_DISABLE_THRESHOLD;

  return (
    <div className="rounded-lg border p-3 space-y-2">
      <div className="flex items-start justify-between gap-3">
        <code className="text-xs break-all text-muted-foreground">{subscription.webhook_url}</code>
        <div className="flex shrink-0 gap-1">
          <Badge variant="outline">{registryLabel(subscription.registry)}</Badge>
          {autoDisabled ? (
            <Badge variant="destructive">Auto-disabled</Badge>
          ) : subscription.is_active ? (
            <Badge variant="secondary">Active</Badge>
          ) : (
            <Badge variant="outline">Inactive</Badge>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-1">
        {(subscription.events ?? []).map((event) => (
          <Badge key={event} variant="secondary" className="text-xs font-normal">
            {event}
          </Badge>
        ))}
        {subscription.platform ? (
          <Badge variant="outline" className="text-xs font-normal">
            {subscription.platform} only
          </Badge>
        ) : null}
      </div>

      {autoDisabled ? (
        <p className="text-xs text-destructive">
          Delivery failed {subscription.failure_count} times in a row, so Postora stopped
          sending to this URL. Re-activate the workflow in n8n to register it again.
        </p>
      ) : subscription.failure_count > 0 ? (
        <p className="text-xs text-amber-600 dark:text-amber-500">
          {subscription.failure_count} recent delivery failure
          {subscription.failure_count === 1 ? "" : "s"} — check that the workflow is
          active and the URL is reachable.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Shows what is actually registered to receive this user's events.
 *
 * The empty state is the important one. A user whose n8n workflow is only listening in
 * test mode has zero registrations here, and until this card existed there was no way for
 * them (or for support) to tell that apart from a broken integration -- the only evidence
 * lived in edge-function logs.
 */
export function WebhookSubscriptionsCard() {
  const { data: subscriptions, isLoading, error } = useWebhookSubscriptions();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center gap-2">
          <Radio className="h-5 w-5" />
          Webhook Subscriptions
        </CardTitle>
        <CardDescription>
          Where Postora sends your inbound messages and comments. Registered automatically
          when an n8n workflow is activated.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading subscriptions…
          </div>
        ) : error ? (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Could not load your webhook subscriptions. Try again in a moment.
            </AlertDescription>
          </Alert>
        ) : !subscriptions || subscriptions.length === 0 ? (
          <Alert>
            <WifiOff className="h-4 w-4" />
            <AlertDescription className="space-y-2">
              <p className="font-medium">No triggers registered.</p>
              <p className="text-sm">
                Nothing is currently listening for your messages or comments. If you are
                building a workflow in n8n, note that pressing <strong>Test workflow</strong>{" "}
                only listens while the editor tab is open and does not register a trigger —
                you must <strong>Save and Activate</strong> the workflow.
              </p>
            </AlertDescription>
          </Alert>
        ) : (
          <div className="space-y-2">
            {subscriptions.map((subscription) => (
              <SubscriptionRow
                key={`${subscription.registry}:${subscription.webhook_id}`}
                subscription={subscription}
              />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
