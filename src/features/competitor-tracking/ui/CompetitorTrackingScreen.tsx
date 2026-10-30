import { useTranslation } from "react-i18next";

import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/hooks/useAuth";
import type { CompetitorTrackingGateway } from "../application/ports";
import { defaultCompetitorTrackingGateway } from "../infrastructure/supabaseCompetitorTrackingGateway";
import { CompetitorTrackingWorkspace } from "./CompetitorTrackingWorkspace";

export type CompetitorTrackingScreenProps = {
  /**
   * The adapter. It is injected so the screen can be exercised without
   * a backend; the production wiring is the default adapter below.
   */
  gateway?: CompetitorTrackingGateway;
};

/**
 * The tracked competitors screen.
 *
 * WHAT THIS MODULE OWNS
 *
 *   It is one of the TWO composition roots of this feature: the only
 *   place besides the Track control that wires the infrastructure
 *   adapter (spec §8, ARCHITECTURE §4).
 *
 * WHY NOTHING IS FETCHED BEFORE THE IDENTITY IS KNOWN
 *
 *   A screen that renders before it knows who the owner is would either
 *   fetch without an owner or show the PREVIOUS owner's competitors.
 *   While the identity is loading the screen shows a skeleton, and a
 *   signed-out visitor sees nothing at all - the protected routing
 *   handles the sign-in (spec §3).
 */
export function CompetitorTrackingScreen({
  gateway = defaultCompetitorTrackingGateway,
}: CompetitorTrackingScreenProps) {
  const { user, isLoading } = useAuth();
  const { t } = useTranslation("analytics");

  if (isLoading) {
    return (
      <div className="space-y-4" aria-busy="true">
        <span className="sr-only">{t("competitors.loading", "Loading competitors")}</span>
        <Skeleton className="h-24 w-full rounded-xl" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (!user) return null;

  return <CompetitorTrackingWorkspace gateway={gateway} userId={user.id} />;
}

export default CompetitorTrackingScreen;
