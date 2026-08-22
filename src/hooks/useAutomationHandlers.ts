import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { callMessagingApi } from "@/lib/messagingApi";

export type MessageAutomationHandler = "internal" | "n8n" | "off";
export type CommentAutomationHandler = "off" | "internal" | "n8n";

export interface AutomationHandlers {
  social_account_id: string;
  platform: string;
  automation_handler: MessageAutomationHandler;
  comment_automation_handler: CommentAutomationHandler;
}

export type AutomationHandlersPatch = Partial<
  Pick<AutomationHandlers, "automation_handler" | "comment_automation_handler">
>;

// Which agent answers this account: the Postora AI agent ("internal"), an n8n workflow
// ("n8n"), or nobody ("off"). Messages and comments are chosen separately because a common
// setup is the AI agent on DMs and an n8n workflow on public comments.
export function useAutomationHandlers(socialAccountId: string | null) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = ["automation-handlers", socialAccountId];

  const query = useQuery({
    queryKey,
    queryFn: async () =>
      (await callMessagingApi("get_automation_handlers", {
        social_account_id: socialAccountId,
      })) as AutomationHandlers,
    enabled: !!session && !!socialAccountId,
  });

  const save = useMutation({
    mutationFn: async (patch: AutomationHandlersPatch) =>
      (await callMessagingApi("set_automation_handlers", {
        social_account_id: socialAccountId,
        ...patch,
      })) as AutomationHandlers,
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  return { handlers: query.data, isLoading: query.isLoading, error: query.error, save };
}
