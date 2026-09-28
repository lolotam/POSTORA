import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import {
  fetchWhatsAppScheduleBoard,
  type WhatsAppScheduleScope,
} from "./infrastructure/fetchWhatsAppScheduleBoard";

export type { WhatsAppScheduleBoard, WhatsAppScheduleScope } from "./infrastructure/fetchWhatsAppScheduleBoard";

export function useWhatsAppScheduledItems(scope: WhatsAppScheduleScope) {
  const { user } = useAuth();
  const rangeStart = scope.kind === "range" ? scope.rangeStart : "";
  const rangeEnd = scope.kind === "range" ? scope.rangeEnd : "";

  return useQuery({
    queryKey: ["whatsapp-scheduled", user?.id, "board", scope.kind, rangeStart, rangeEnd],
    queryFn: () => {
      if (!user) throw new Error("Sign in to load scheduled WhatsApp messages.");
      return fetchWhatsAppScheduleBoard(user.id, scope);
    },
    enabled: Boolean(user) && (scope.kind === "active" || (rangeStart !== "" && rangeEnd !== "")),
    retry: false,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}
