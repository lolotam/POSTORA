import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import {
  fetchInboundActivity,
  fetchUnmatchedObservations,
  fetchWebhookSubscriptions,
} from "../../infrastructure/webhookObservabilityApi";

/**
 * Every webhook subscription registered for the signed-in user, across both registries.
 *
 * An empty result is the answer, not a failure: it means no automation is listening at
 * all, which is what "my n8n trigger never fires" usually turns out to be.
 */
export function useWebhookSubscriptions() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["webhook_subscriptions", user?.id],
    queryFn: fetchWebhookSubscriptions,
    enabled: !!user,
  });
}

/** Last inbound event per connected account. Absent account === never received one. */
export function useInboundActivity() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["inbound_activity", user?.id],
    queryFn: fetchInboundActivity,
    enabled: !!user,
  });
}

/** Admin-only view of events that arrived for accounts Postora could not resolve. */
export function useUnmatchedObservations(limit = 100) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["unmatched_observations", user?.id, limit],
    queryFn: () => fetchUnmatchedObservations(limit),
    enabled: !!user,
  });
}
