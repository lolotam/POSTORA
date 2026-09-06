import { useMemo } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { useUserRole } from "@/hooks/useUserRole";
import { Skeleton } from "@/components/ui/skeleton";
import { createSupabaseAiProvidersGateway } from "../infrastructure/supabaseAiProvidersGateway";
import { AiProviderKeysCard } from "./AiProviderKeysCard";
import { AiRoutingCard } from "./AiRoutingCard";
import { CodexWaitlistCard } from "./CodexWaitlistCard";

export function AiProvidersPanel() {
  const { user } = useAuth();
  const { flags, isLoading } = useFeatureFlags();
  const { isLoading: roleLoading } = useUserRole();
  const gateway = useMemo(() => createSupabaseAiProvidersGateway(user?.id ?? ""), [user?.id]);
  if (isLoading || roleLoading) return <Skeleton className="h-48 w-full" role="status" aria-label="Loading AI provider settings" />;
  if (!flags.byokProviders || !user) return null;
  return <div key={user.id} className="space-y-6">
    <AiProviderKeysCard gateway={gateway} userId={user.id} />
    <AiRoutingCard gateway={gateway} userId={user.id} />
    <CodexWaitlistCard gateway={gateway} userId={user.id} />
  </div>;
}
