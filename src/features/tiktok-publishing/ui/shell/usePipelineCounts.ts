import { usePipelineDrafts } from "../../application/usePipelineDrafts";
import { useSubmissionStatuses } from "../../application/useSubmissionStatuses";

const PENDING = ["pending_review"] as const;
const SENT = ["submitted"] as const;

/** Sidebar and tab badges. Counts stay 0 while loading or on error so a badge never flickers in. */
export function usePipelineCounts(): { pending: number; failed: number } {
  const pending = usePipelineDrafts(PENDING);
  const sent = usePipelineDrafts(SENT);
  const statuses = useSubmissionStatuses(sent.drafts);
  let failed = 0;
  statuses.forEach((status) => {
    if (status.state === "failed" || status.state === "needs_attention") failed += 1;
  });
  return {
    pending: pending.isError ? 0 : pending.drafts.length,
    failed,
  };
}
