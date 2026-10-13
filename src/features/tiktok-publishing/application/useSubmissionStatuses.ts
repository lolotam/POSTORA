import { useQueries } from "@tanstack/react-query";
import type { PublishStatus, ReviewDraft } from "../domain/types";
import { useTikTokReviewGateway } from "./ports";

const submissionStatusKey = (submissionId: string) => ["tiktok-review", "status", submissionId] as const;

/**
 * Publish outcome for every sent draft in a list, keyed by draft id. One request per submission,
 * cached for a minute so the sidebar badge, Activity, Calendar and Approvals share the results.
 * The selected post's live polling stays in usePublishStatus.
 */
export function useSubmissionStatuses(drafts: readonly ReviewDraft[]): Map<string, PublishStatus> {
  const gateway = useTikTokReviewGateway();
  const sent = drafts.filter((draft) => draft.submission !== null);
  const results = useQueries({
    queries: sent.map((draft) => {
      const submissionId = draft.submission?.id ?? "";
      return {
        queryKey: submissionStatusKey(submissionId),
        queryFn: () => gateway.status(submissionId),
        staleTime: 60_000,
      };
    }),
  });

  const statuses = new Map<string, PublishStatus>();
  sent.forEach((draft, index) => {
    const data = results[index]?.data;
    if (data) statuses.set(draft.id, data);
  });
  return statuses;
}
