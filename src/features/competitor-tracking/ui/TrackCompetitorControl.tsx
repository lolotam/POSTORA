import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import type { CompetitorTrackingGateway } from "../application/ports";
import type { TrackCompetitorResult } from "../application/trackCompetitor";
import { defaultCompetitorTrackingGateway } from "../infrastructure/supabaseCompetitorTrackingGateway";
import { formatQuota } from "../domain/formatters";
import { competitorErrorMessage, useCompetitorErrorCopy, useCompetitorIdentity, useCompetitorQuota } from "./useCompetitorTracking";
import { useTrackCompetitor } from "./useCompetitorMutations";

export type TrackCompetitorControlProps = {
  /** The handle the owner picked. */
  username: string;
  /** An optional label the owner gave the competitor. */
  label?: string | null;
  /**
   * The adapter. It is injected so the control can be exercised
   * without a backend; the production wiring is the default adapter.
   */
  gateway?: CompetitorTrackingGateway;
  /** Called after the owner tracked the handle. */
  onTracked?: (result: TrackCompetitorResult) => void;
};

/**
 * The "Track" control of one handle.
 *
 * WHAT THIS MODULE OWNS
 *
 *   It is the second of the TWO composition roots of this feature: the
 *   only other place that wires the infrastructure adapter (spec §8).
 *
 * WHY AN ALREADY-TRACKED HANDLE IS NOT A SECOND STATE
 *
 *   The handle is normalised the way the database normalises it, so
 *   `@Foo` and `foo` are ONE local tracking state and not two
 *   (spec §8).
 *
 * WHY A FAILED ENQUEUE IS NOT A FAILED TRACKING
 *
 *   The row is saved and the history is intact; only the collection
 *   was not confirmed. The control says exactly that and never offers
 *   to save the row again (spec §3).
 */
export function TrackCompetitorControl({
  username,
  label = null,
  gateway = defaultCompetitorTrackingGateway,
  onTracked,
}: TrackCompetitorControlProps) {
  const { user } = useAuth();
  const { t } = useTranslation("analytics");
  const copy = useCompetitorErrorCopy();

  const userId = user?.id ?? null;
  const { isTracked } = useCompetitorIdentity({ gateway, userId, username });
  // The quota is read so a refusal can name the owner's real limit
  // instead of a placeholder.
  const quota = useCompetitorQuota({ gateway, userId });
  const mutation = useTrackCompetitor({ gateway, userId });

  const [message, setMessage] = useState<{ tone: "info" | "error"; text: string } | null>(null);

  // A new handle is a new decision: the previous outcome belongs to
  // the previous handle and must not be read as this one's.
  useEffect(() => {
    setMessage(null);
  }, [username]);

  const handleClick = () => {
    setMessage(null);
    mutation.mutate(
      { username, label },
      {
        onSuccess: (result) => {
          if (result.outcome === "saved_and_queued") {
            setMessage({
              tone: "info",
              text: t("competitors.trackedQueued", "Tracked; the first snapshot is queued."),
            });
            onTracked?.(result);
            return;
          }
          if (result.outcome === "already_tracked") {
            setMessage({ tone: "info", text: t("competitors.tracked", "Tracked") });
            onTracked?.(result);
            return;
          }
          if (result.outcome === "saved_enqueue_unconfirmed") {
            setMessage({
              tone: "error",
              text: t(
                "competitors.trackedEnqueueFailed",
                "Tracked; collection could not be confirmed.",
              ),
            });
            onTracked?.(result);
            return;
          }
          if (result.outcome === "indeterminate") {
            setMessage({
              tone: "error",
              text: t("competitors.outcomeUnknown", "Could not confirm the change. Reload to check."),
            });
            onTracked?.(result);
            return;
          }
          setMessage({
            tone: "error",
            text: competitorErrorMessage(copy, result.error, formatQuota(quota.quota).limit),
          });
        },
        onError: (error) => {
          setMessage({
            tone: "error",
            text: competitorErrorMessage(
              copy,
              error as never,
              formatQuota(quota.quota).limit,
            ),
          });
        },
      },
    );
  };

  const alreadyTracked = isTracked || mutation.data?.outcome === "already_tracked";

  return (
    <div className="flex flex-col items-start gap-1">
      <Button
        size="sm"
        variant={alreadyTracked ? "secondary" : "default"}
        disabled={alreadyTracked || mutation.isPending || !userId}
        onClick={handleClick}
      >
        {mutation.isPending ? (
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
        ) : null}
        {alreadyTracked
          ? t("competitors.tracked", "Tracked")
          : t("competitors.track", "Track")}
      </Button>

      {message !== null && (
        <p
          role={message.tone === "error" ? "alert" : "status"}
          aria-live={message.tone === "error" ? "assertive" : "polite"}
          className={
            message.tone === "error"
              ? "text-xs font-medium text-destructive"
              : "text-xs text-muted-foreground"
          }
        >
          {message.text}
        </p>
      )}
    </div>
  );
}

export default TrackCompetitorControl;
