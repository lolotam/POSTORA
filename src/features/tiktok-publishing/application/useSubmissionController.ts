import { useRef, useState } from "react";
import { evaluateSubmission, type Confirmation } from "../domain/evaluateSubmission";
import type { CreatorInfo, ReviewDraft, SubmissionResult, SubmitReviewCommand } from "../domain/types";
import { ReviewGatewayError } from "./ports";

interface SubmissionContext {
  draft: ReviewDraft | null;
  creator: CreatorInfo | null;
  confirmation: Confirmation | null;
  mode: SubmitReviewCommand["mode"];
  scheduledAt: string | null;
  captionDirty: boolean;
  timeZone: string;
  refreshCreator: () => Promise<{ data?: CreatorInfo; error: unknown }>;
  submit: (command: SubmitReviewCommand) => Promise<SubmissionResult>;
}

export function useSubmissionController(context: SubmissionContext) {
  const latest = useRef(context);
  latest.current = context;
  const inFlight = useRef(false);
  const [confirmPending, setConfirmPending] = useState(false);
  const { draft, creator, confirmation, scheduledAt, captionDirty } = context;
  const now = new Date();
  const approveBlockers = evaluateSubmission(draft, creator, confirmation, "now", scheduledAt, now, captionDirty);
  const scheduleBlockers = evaluateSubmission(draft, creator, confirmation, "scheduled", scheduledAt, now, captionDirty);

  async function confirmSubmission(intent: { mode: SubmitReviewCommand["mode"]; requestId: string }) {
    if (inFlight.current) return null;
    inFlight.current = true;
    setConfirmPending(true);
    const isCurrent = () => latest.current.draft?.id === draft?.id
      && latest.current.draft?.revision === draft?.revision
      && latest.current.confirmation === confirmation
      && latest.current.scheduledAt === scheduledAt
      && latest.current.mode === context.mode;
    try {
      const fresh = await context.refreshCreator();
      if (!isCurrent()) return null;
      if (fresh.error || !fresh.data) {
        throw fresh.error ?? new ReviewGatewayError("CREATOR_INFO_UNAVAILABLE", "TikTok account details could not be loaded.", 502);
      }
      const blockers = evaluateSubmission(draft, fresh.data, confirmation, intent.mode,
        scheduledAt, new Date(), latest.current.captionDirty);
      const blocker = blockers[0];
      if (blocker) throw new ReviewGatewayError(blocker.code, blocker.message, 422);
      if (!draft) return null;
      const submitted = await context.submit({
        draftId: draft.id,
        expectedRevision: draft.revision,
        requestId: intent.requestId,
        mode: intent.mode,
        scheduledAt: intent.mode === "scheduled" ? scheduledAt : null,
        timeZone: context.timeZone,
        consent: true,
      });
      return latest.current.draft?.id === draft.id ? submitted : null;
    } catch (error) {
      if (!isCurrent()) return null;
      throw error;
    } finally {
      inFlight.current = false;
      setConfirmPending(false);
    }
  }

  return { approveBlockers, scheduleBlockers, confirmSubmission, confirmPending };
}
