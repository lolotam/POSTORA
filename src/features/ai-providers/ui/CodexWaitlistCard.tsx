import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Sparkles } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { AiProvidersGateway } from "../application/ports";
import { notifyAiProviderError } from "./useAiProviderKeys";

export function CodexWaitlistCard({ gateway, userId }: { gateway: AiProvidersGateway; userId: string }) {
  const client = useQueryClient();
  const queryKey = ["ai-provider-waitlist", userId];
  const waitlist = useQuery({ queryKey, queryFn: () => gateway.isOnWaitlist(), enabled: !!userId });
  const join = useMutation({
    mutationFn: () => gateway.joinWaitlist(),
    onSuccess: () => {
      client.setQueryData(queryKey, true);
      return client.invalidateQueries({ queryKey });
    },
    onError: notifyAiProviderError,
  });
  const joined = waitlist.data === true || join.isSuccess;
  return <Card>
    <CardHeader>
      <CardTitle className="flex items-center gap-2"><Sparkles className="h-5 w-5 shrink-0" aria-hidden="true" />Connect ChatGPT / Codex subscription (beta waitlist)</CardTitle>
      <CardDescription>Interested in connecting your own ChatGPT / Codex subscription? Join the waitlist to express interest in a future beta. Subscription connections are not available yet.</CardDescription>
    </CardHeader>
    <CardContent>
      {waitlist.isError && <p role="alert">Could not check your waitlist status. <Button variant="ghost" onClick={() => void waitlist.refetch()}>Retry</Button></p>}
      <Button disabled={waitlist.isPending || waitlist.isError || join.isPending || joined} onClick={() => join.mutate()}>{joined ? "You're on the list" : "Join the waitlist"}</Button>
    </CardContent>
  </Card>;
}
