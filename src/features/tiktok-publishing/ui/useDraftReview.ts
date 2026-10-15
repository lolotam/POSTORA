import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { UploadedFile } from "@/hooks/usePostForm";
import { browserTimeZone } from "@/features/scheduled";
import {
  isRevisionConflict,
  useTikTokCreatorInfo,
  useTikTokDraft,
  useTikTokMediaPreview,
  useTikTokReviewCommands,
} from "../application/useTikTokReview";
import { usePublishStatus } from "../application/usePublishStatus";
import { useSubmissionController } from "../application/useSubmissionController";
import type { ReviewSavePatch } from "../application/ports";
import type { Confirmation } from "../domain/evaluateSubmission";
import { canTransition, consentKey, type ReviewBlocker } from "../domain/reviewRules";
import { formatInZone } from "../domain/scheduleRules";
import type { ReviewDraft } from "../domain/types";
import type { DetailScreen, PreviewScreen } from "./ReviewDetail";
import { describeBlocker, describeError } from "./reviewCopy";
import { readLibraryDuration, measureVideoDuration } from "./mediaDuration";
import { useScheduleSelection } from "./useScheduleSelection";

export type ReviewOverlay =
  | { kind: "closed" }
  | { kind: "settings" }
  | { kind: "reject" }
  | { kind: "confirm"; mode: "now" | "scheduled"; requestId: string };

export interface LiveSubmission {
  id: string;
  state: "queued" | "scheduled";
  scheduledFor: string | null;
}

/**
 * Everything about reviewing one selected draft: loading it, editing caption/media/settings,
 * the approve/schedule confirmation, reject/archive/restore/reopen and the publish outcome.
 * Shared by the admin workspace and the review-shell Approvals page so both run the same flow.
 */
export function useDraftReview(input: {
  selectedId: string | null;
  accountId: string | null;
  /** Called after a failed submission is reopened, so the list can switch back to Pending. */
  onReopened?: () => void;
}) {
  const { selectedId, accountId, onReopened } = input;
  const { t } = useTranslation("post");
  const translate = (key: string, fallback: string) => t(key, fallback);
  const timeZone = useMemo(() => browserTimeZone(), []);
  const [editing, setEditing] = useState(false);
  const [captionDraft, setCaptionDraft] = useState("");
  const schedule = useScheduleSelection(selectedId, timeZone);
  const { mode, scheduledAt } = schedule;
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [overlay, setOverlay] = useState<ReviewOverlay>({ kind: "closed" });
  const [mediaNotice, setMediaNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [liveSubmission, setLiveSubmission] = useState<LiveSubmission | null>(null);

  const draftQuery = useTikTokDraft(selectedId);
  const creatorQuery = useTikTokCreatorInfo(accountId);
  const commands = useTikTokReviewCommands();
  const { clearRevisionConflict } = commands;
  const draft = draftQuery.data ?? null;
  const selectionRef = useRef({ draftId: selectedId, accountId });
  if (selectionRef.current.draftId !== selectedId || selectionRef.current.accountId !== accountId) {
    selectionRef.current = { draftId: selectedId, accountId };
  }
  const mediaQuery = useTikTokMediaPreview(draft?.mediaFileId ?? null);
  const submissionId = draft?.submission?.id ?? liveSubmission?.id ?? null;
  const submissionScheduledAt = draft?.submission?.scheduledAt ?? liveSubmission?.scheduledFor ?? null;
  const publish = usePublishStatus(submissionId, submissionScheduledAt);

  useEffect(() => {
    setEditing(false);
    setCaptionDraft("");
    setConfirmation(null);
    setOverlay({ kind: "closed" });
    setMediaNotice(null);
    setActionError(null);
    setConfirmError(null);
    setLiveSubmission(null);
    clearRevisionConflict();
  }, [selectedId, accountId, clearRevisionConflict]);

  useEffect(() => {
    if (draft && !editing) setCaptionDraft(draft.caption);
  }, [draft, editing]);

  const creator = creatorQuery.isError || creatorQuery.isPending ? null : creatorQuery.data ?? null;
  const creatorError = creatorQuery.isError ? describeError(translate, creatorQuery.error) : null;
  const captionDirty = editing && !!draft && captionDraft !== draft.caption;
  const scheduleLabel = mode === "scheduled" && scheduledAt
    ? formatInZone(scheduledAt, timeZone)
    : t("tiktokReview.notScheduled", "—");

  const submission = useSubmissionController({
    draft: draftQuery.isSuccess ? draft : null,
    creator,
    confirmation,
    mode,
    scheduledAt,
    captionDirty,
    timeZone,
    refreshCreator: () => creatorQuery.refetch(),
    submit: commands.submitDraft.mutateAsync,
  });

  function disabledReason(blockers: ReviewBlocker[]): string | null {
    const blocker = blockers[0];
    return blocker ? describeBlocker(translate, blocker) : null;
  }

  const approveReason = disabledReason(submission.approveBlockers);
  const scheduleReason = disabledReason(submission.scheduleBlockers);

  const detail: DetailScreen = selectedId !== null && commands.conflictedDraftId === selectedId
    ? { kind: "conflict" }
    : !selectedId
      ? { kind: "none" }
      : draftQuery.isPending
        ? { kind: "loading" }
        : draftQuery.isError
          ? { kind: "error", message: describeError(translate, draftQuery.error), onRetry: () => { void draftQuery.refetch(); } }
          : draft
            ? { kind: "ready", draft }
            : { kind: "loading" };

  const preview: PreviewScreen = mediaQuery.isError
    ? { kind: "error", message: describeError(translate, mediaQuery.error) }
    : mediaQuery.isPending
      ? { kind: "loading" }
      : { kind: "ready", media: mediaQuery.data };

  function openConfirm(nextMode: "now" | "scheduled") {
    const reason = nextMode === "scheduled" ? scheduleReason : approveReason;
    if (detail.kind !== "ready" || reason || overlay.kind !== "closed") return;
    setConfirmError(null);
    setOverlay({ kind: "confirm", mode: nextMode, requestId: crypto.randomUUID() });
  }

  async function runSave(patch: ReviewSavePatch) {
    if (!draft || !canTransition(draft.state, "save")) return null;
    const selection = selectionRef.current;
    setActionError(null);
    try {
      const saved = await commands.saveDraft.mutateAsync({
        draftId: draft.id,
        expectedRevision: draft.revision,
        patch,
      });
      return selectionRef.current === selection ? saved : null;
    } catch (error) {
      if (selectionRef.current !== selection) return null;
      setActionError(describeError(translate, error));
      return null;
    }
  }

  // The database answers whether this attempt may be reopened; never inferred from the publish state.
  const canReopen = draft?.state === "submitted" && publish.status?.reopenable === true;

  async function reopen() {
    if (!draft || !canReopen || commands.reopenDraft.isPending) return;
    const selection = selectionRef.current;
    setActionError(null);
    try {
      await commands.reopenDraft.mutateAsync({ draftId: draft.id, expectedRevision: draft.revision });
      if (selectionRef.current !== selection) return;
      setLiveSubmission(null);
      onReopened?.();
    } catch (error) {
      if (selectionRef.current !== selection) return;
      setActionError(describeError(translate, error));
    }
  }

  async function pickMedia(file: UploadedFile) {
    if (!draft) return;
    if (file.fileType !== "video") {
      setMediaNotice(t("tiktokReview.videoOnly", "Choose a video. Other files stay in your library."));
      return;
    }
    if (!file.storagePath) {
      setMediaNotice(t("tiktokReview.missingMediaId", "That library item has no saved id."));
      return;
    }
    setMediaNotice(null);
    const measured = readLibraryDuration(file) ?? await measureVideoDuration(file.previewUrl);
    await attachVideo(file.storagePath, measured);
  }

  /** Puts an already-stored video (a media_files id) on the draft. */
  async function attachVideo(mediaFileId: string, durationSec: number | null) {
    if (!draft) return;
    await runSave({
      caption: draft.caption,
      mediaFileId,
      mediaDurationSec: durationSec,
      settings: draft.settings,
    });
  }

  async function removeMedia() {
    if (!draft) return;
    setMediaNotice(null);
    await runSave({
      caption: draft.caption,
      mediaFileId: null,
      mediaDurationSec: null,
      settings: draft.settings,
    });
  }

  async function saveCaption(caption: string = captionDraft) {
    if (!draft) return;
    const saved = await runSave({
      caption,
      mediaFileId: draft.mediaFileId,
      mediaDurationSec: draft.mediaDurationSec,
      settings: draft.settings,
    });
    if (saved) setEditing(false);
  }

  async function saveSettings(settings: ReviewDraft["settings"], consentChecked: boolean) {
    if (!draft) return;
    const saved = await runSave({
      caption: draft.caption,
      mediaFileId: draft.mediaFileId,
      mediaDurationSec: draft.mediaDurationSec,
      settings,
    });
    if (!saved) return;
    const key = consentKey(
      saved.id,
      saved.accountId,
      saved.revision,
      saved.mediaFileId,
      saved.settings,
      mode,
      mode === "scheduled" ? scheduledAt : null,
    );
    setConfirmation({ key, caption: saved.caption, consent: consentChecked });
    setOverlay({ kind: "closed" });
  }

  async function confirm() {
    if (overlay.kind !== "confirm") return;
    try {
      const submitted = await submission.confirmSubmission(overlay);
      if (!submitted) return;
      setLiveSubmission({
        id: submitted.submissionId,
        state: submitted.state,
        scheduledFor: overlay.mode === "scheduled" ? scheduledAt : null,
      });
      setOverlay({ kind: "closed" });
      setConfirmError(null);
    } catch (error) {
      if (isRevisionConflict(error)) {
        setOverlay({ kind: "closed" });
        return;
      }
      setConfirmError(describeError(translate, error));
    }
  }

  function report(error: unknown) {
    setActionError(describeError(translate, error));
  }

  function archive() {
    if (!draft || commands.archiveDraft.isPending) return;
    void commands.archiveDraft.mutateAsync({ draftId: draft.id, expectedRevision: draft.revision }).catch(report);
  }

  function restore() {
    if (!draft || commands.restoreDraft.isPending) return;
    void commands.restoreDraft.mutateAsync({ draftId: draft.id, expectedRevision: draft.revision }).catch(report);
  }

  function reject(reason: string) {
    if (!draft) return;
    void commands.rejectDraft.mutateAsync({ draftId: draft.id, expectedRevision: draft.revision, reason })
      .then(() => setOverlay({ kind: "closed" }))
      .catch(report);
  }

  function startEdit() {
    if (draft) setCaptionDraft(draft.caption);
    setEditing(true);
  }

  function cancelEdit() {
    if (draft) setCaptionDraft(draft.caption);
    setEditing(false);
  }

  function reloadConflict() {
    clearRevisionConflict();
    void draftQuery.refetch();
  }

  return {
    t,
    translate,
    timeZone,
    draft,
    detail,
    preview,
    retryPreview: () => { void mediaQuery.refetch(); },
    creator,
    creatorError,
    retryCreator: () => { void creatorQuery.refetch(); },
    commands,
    schedule,
    scheduleLabel,
    editing,
    captionDraft,
    setCaptionDraft,
    startEdit,
    cancelEdit,
    saveCaption,
    saveSettings,
    pickMedia,
    attachVideo,
    removeMedia,
    mediaNotice,
    setMediaNotice,
    actionError,
    setActionError,
    report,
    overlay,
    setOverlay,
    confirmError,
    setConfirmError,
    confirmPending: submission.confirmPending,
    confirmation,
    approveReason,
    scheduleReason,
    approveBlockers: submission.approveBlockers,
    scheduleBlockers: submission.scheduleBlockers,
    openConfirm,
    confirm,
    archive,
    restore,
    reject,
    reopen,
    canReopen,
    reloadConflict,
    publish,
    liveSubmission,
    submissionScheduledAt,
    showPublish: liveSubmission !== null || (submissionId !== null && draft?.state === "submitted"),
    can: {
      reject: !!draft && canTransition(draft.state, "reject"),
      edit: !!draft && canTransition(draft.state, "edit"),
      archive: !!draft && canTransition(draft.state, "archive"),
      restore: !!draft && canTransition(draft.state, "restore"),
    },
  };
}

export type DraftReview = ReturnType<typeof useDraftReview>;
