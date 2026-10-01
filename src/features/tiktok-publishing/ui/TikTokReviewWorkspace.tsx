import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { UploadedFile } from "@/hooks/usePostForm";
import { browserTimeZone } from "@/features/scheduled";
import {
  isRevisionConflict,
  useTikTokAccounts,
  useTikTokCreatorInfo,
  useTikTokDraft,
  useTikTokDrafts,
  useTikTokMediaPreview,
  useTikTokReviewCommands,
} from "../application/useTikTokReview";
import { usePublishStatus } from "../application/usePublishStatus";
import type { ReviewSavePatch } from "../application/ports";
import {
  canTransition,
  consentKey,
  type ReviewBlocker,
} from "../domain/reviewRules";
import { formatInZone } from "../domain/scheduleRules";
import type { ReviewDraft, ReviewState } from "../domain/types";
import type { ConfirmDialog } from "./PublishControls";
import { ReviewDetail, type DetailScreen } from "./ReviewDetail";
import { ReviewQueue, type QueueScreen } from "./ReviewQueue";
import { TikTokSettingsPanel } from "./TikTokSettingsPanel";
import { describeBlocker, describeError } from "./reviewCopy";

import type { Confirmation } from "../domain/evaluateSubmission";
import { useSubmissionController } from "../application/useSubmissionController";
import { useScheduleSelection } from "./useScheduleSelection";
import { useReviewShortcuts } from "./useReviewShortcuts";
import { readLibraryDuration, measureVideoDuration } from "./mediaDuration";

type Overlay =
  | { kind: "closed" }
  | { kind: "settings" }
  | { kind: "reject" }
  | { kind: "confirm"; mode: "now" | "scheduled"; requestId: string };

interface TikTokReviewWorkspaceProps {
  headerLink: ReactNode;
}

export function TikTokReviewWorkspace({ headerLink }: TikTokReviewWorkspaceProps) {
  const { t } = useTranslation("post");
  const translate = (key: string, fallback: string) => t(key, fallback);
  const timeZone = useMemo(() => browserTimeZone(), []);
  const accountsQuery = useTikTokAccounts();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [filter, setFilter] = useState<ReviewState>("pending_review");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 767px)").matches);
  const [editing, setEditing] = useState(false);
  const [captionDraft, setCaptionDraft] = useState("");
  const schedule = useScheduleSelection(selectedId, timeZone);
  const { mode, scheduledAt, scheduleLocal, scheduleNote, onNow, onShortcut, onScheduleLocal } = schedule;
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [overlay, setOverlay] = useState<Overlay>({ kind: "closed" });
  const [mediaNotice, setMediaNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const [liveSubmission, setLiveSubmission] = useState<{ id: string; state: "queued" | "scheduled"; scheduledFor: string | null } | null>(null);

  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const pendingQuery = useTikTokDrafts(accountId, "pending_review");
  const listQuery = useTikTokDrafts(accountId, filter);
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
    if (!accountId && accounts.length > 0) setAccountId(accounts[0]?.id ?? null);
  }, [accountId, accounts]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const onChange = () => setNarrow(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

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

  const canReopen = draft?.state === "submitted" && publish.status?.reopenable === true;

  async function onReopen() {
    if (!draft || !canReopen || commands.reopenDraft.isPending) return;
    const selection = selectionRef.current;
    setActionError(null);
    try {
      await commands.reopenDraft.mutateAsync({ draftId: draft.id, expectedRevision: draft.revision });
      if (selectionRef.current !== selection) return;
      setLiveSubmission(null);
      setFilter("pending_review");
    } catch (error) {
      if (selectionRef.current !== selection) return;
      setActionError(describeError(translate, error));
    }
  }

  async function onPickMedia(file: UploadedFile) {
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
    await runSave({
      caption: draft.caption,
      mediaFileId: file.storagePath,
      mediaDurationSec: measured,
      settings: draft.settings,
    });
  }

  async function onRemoveMedia() {
    if (!draft) return;
    setMediaNotice(null);
    await runSave({
      caption: draft.caption,
      mediaFileId: null,
      mediaDurationSec: null,
      settings: draft.settings,
    });
  }

  async function onSaveCaption() {
    if (!draft) return;
    const saved = await runSave({
      caption: captionDraft,
      mediaFileId: draft.mediaFileId,
      mediaDurationSec: draft.mediaDurationSec,
      settings: draft.settings,
    });
    if (saved) setEditing(false);
  }

  async function onSaveSettings(settings: ReviewDraft["settings"], consentChecked: boolean) {
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

  async function onConfirm() {
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

  const queue = buildQueue({
    accountId,
    accountsLoading: accountsQuery.isPending,
    accountsError: accountsQuery.isError,
    accountsMessage: accountsQuery.error ? describeError(translate, accountsQuery.error) : "",
    noAccounts: accountsQuery.isSuccess && accounts.length === 0,
    listPending: !!accountId && listQuery.isPending,
    listError: listQuery.isError,
    listMessage: listQuery.error ? describeError(translate, listQuery.error) : "",
    drafts: listQuery.isSuccess ? listQuery.data : null,
    emptyConnected: t("tiktokReview.empty", "No posts in this view."),
    emptyAccount: t("tiktokReview.emptyAccount", "Connect a TikTok account to start a review."),
  });

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

  useReviewShortcuts({
    ready: detail.kind === "ready",
    overlayOpen: overlay.kind !== "closed",
    canReject: detail.kind === "ready" && canTransition(detail.draft.state, "reject"),
    onApprove: () => openConfirm("now"),
    onReject: () => setOverlay({ kind: "reject" }),
    onNext: () => {
      const rows = listQuery.data ?? [];
      const index = rows.findIndex((row) => row.id === selectedId);
      const next = rows[index + 1];
      if (next) setSelectedId(next.id);
    },
  });

  const confirm: ConfirmDialog | null = overlay.kind === "confirm"
    ? { mode: overlay.mode, requestId: overlay.requestId }
    : null;
  const account = accounts.find((item) => item.id === accountId) ?? null;
  const showPublish = liveSubmission !== null || (submissionId !== null && draft?.state === "submitted");

  return (
    <div className="tiktok-review">
      {actionError ? <p className="tiktok-review-alert" role="alert">{actionError}</p> : null}
      <div className="tiktok-review-layout" data-pane={narrow && selectedId ? "detail" : "queue"}>
        <ReviewQueue
          headerLink={headerLink}
          accounts={accountsQuery.isSuccess ? accounts : []}
          accountId={accountId}
          onAccountId={(next) => {
            setAccountId(next);
            setSelectedId(null);
          }}
          accountsLoading={accountsQuery.isPending}
          filter={filter}
          onFilter={(next) => {
            setFilter(next);
            setSelectedId(null);
          }}
          pendingCount={pendingQuery.isSuccess ? pendingQuery.data.length : accountId ? null : 0}
          pendingLoading={!!accountId && pendingQuery.isPending}
          queue={queue}
          selectedId={selectedId}
          onSelect={setSelectedId}
          creating={commands.createDraft.isPending}
          onRetry={() => {
            if (accountsQuery.isError) void accountsQuery.refetch();
            if (listQuery.isError) void listQuery.refetch();
            if (pendingQuery.isError) void pendingQuery.refetch();
          }}
          onCreate={() => {
            if (!accountId) return;
            void commands.createDraft.mutateAsync(accountId).then((created) => {
              setFilter("pending_review");
              setSelectedId(created.id);
            }).catch((error: unknown) => setActionError(describeError(translate, error)));
          }}
        />
        <ReviewDetail
          screen={detail}
          onReloadConflict={() => {
            clearRevisionConflict();
            void draftQuery.refetch();
            void listQuery.refetch();
          }}
          narrow={narrow}
          onBack={() => setSelectedId(null)}
          account={account}
          creator={creator}
          preview={mediaQuery.isError
            ? { kind: "error", message: describeError(translate, mediaQuery.error) }
            : mediaQuery.isPending
              ? { kind: "loading" }
              : { kind: "ready", media: mediaQuery.data }}
          onRetryPreview={() => { void mediaQuery.refetch(); }}
          editing={editing}
          captionDraft={captionDraft}
          onCaptionDraft={setCaptionDraft}
          onStartEdit={() => {
            if (draft) setCaptionDraft(draft.caption);
            setEditing(true);
          }}
          onCancelEdit={() => {
            if (draft) setCaptionDraft(draft.caption);
            setEditing(false);
          }}
          onSaveCaption={() => { void onSaveCaption(); }}
          saving={commands.saveDraft.isPending}
          mediaNotice={mediaNotice}
          onPickMedia={(file) => { void onPickMedia(file); }}
          onRemoveMedia={() => { void onRemoveMedia(); }}
          scheduleLabel={scheduleLabel}
          controls={{
            timeZone,
            scheduleLocal,
            scheduleNote,
            onScheduleLocal,
            onNow,
            onShortcut,
            approveReason,
            scheduleReason,
            canReject: !!draft && canTransition(draft.state, "reject"),
            canEdit: !!draft && canTransition(draft.state, "edit"),
            canArchive: !!draft && canTransition(draft.state, "archive"),
            canRestore: !!draft && canTransition(draft.state, "restore"),
            settings: draft ? (
              <TikTokSettingsPanel
                draft={draft}
                creator={creator}
                creatorError={creatorQuery.isError ? describeError(translate, creatorQuery.error) : null}
                onRetryCreator={() => { void creatorQuery.refetch(); }}
                saving={commands.saveDraft.isPending}
                onCancel={() => setOverlay({ kind: "closed" })}
                onSave={(settings, consentChecked) => { void onSaveSettings(settings, consentChecked); }}
              />
            ) : null,
            settingsOpen: overlay.kind === "settings",
            onSettingsOpenChange: (open) => setOverlay(open ? { kind: "settings" } : { kind: "closed" }),
            onArchive: () => {
              if (!draft || commands.archiveDraft.isPending) return;
              void commands.archiveDraft.mutateAsync({ draftId: draft.id, expectedRevision: draft.revision })
                .catch((error: unknown) => setActionError(describeError(translate, error)));
            },
            onRestore: () => {
              if (!draft || commands.restoreDraft.isPending) return;
              void commands.restoreDraft.mutateAsync({ draftId: draft.id, expectedRevision: draft.revision })
                .catch((error: unknown) => setActionError(describeError(translate, error)));
            },
            onReject: (reason) => {
              if (!draft) return;
              void commands.rejectDraft.mutateAsync({ draftId: draft.id, expectedRevision: draft.revision, reason })
                .then(() => setOverlay({ kind: "closed" }))
                .catch((error: unknown) => setActionError(describeError(translate, error)));
            },
            rejectPending: commands.rejectDraft.isPending,
            confirm,
            onOpenConfirm: openConfirm,
            onCloseConfirm: () => {
              setOverlay({ kind: "closed" });
              setConfirmError(null);
            },
            onConfirm: () => { void onConfirm(); },
            confirmPending: submission.confirmPending,
            confirmError,
            rejectOpen: overlay.kind === "reject",
            onRejectOpenChange: (open) => setOverlay(open ? { kind: "reject" } : { kind: "closed" }),
          }}
          publish={showPublish ? {
            status: publish.status,
            error: publish.error,
            timedOut: publish.timedOut,
            refresh: publish.refresh,
            immediate: submissionSnapshot(draft, liveSubmission),
            scheduledFor: submissionScheduledAt,
            reopen: canReopen ? () => { void onReopen(); } : null,
            reopening: commands.reopenDraft.isPending,
          } : null}
        />
      </div>
    </div>
  );
}

function buildQueue(input: {
  accountId: string | null;
  accountsLoading: boolean;
  accountsError: boolean;
  accountsMessage: string;
  noAccounts: boolean;
  listPending: boolean;
  listError: boolean;
  listMessage: string;
  drafts: ReviewDraft[] | null;
  emptyConnected: string;
  emptyAccount: string;
}): QueueScreen {
  if (input.accountsLoading) return { kind: "loading" };
  if (input.accountsError) return { kind: "error", message: input.accountsMessage };
  if (input.noAccounts || !input.accountId) return { kind: "empty", message: input.emptyAccount };
  if (input.listError) return { kind: "error", message: input.listMessage };
  if (input.listPending || !input.drafts) return { kind: "loading" };
  if (input.drafts.length === 0) return { kind: "empty", message: input.emptyConnected };
  return { kind: "ready", drafts: input.drafts };
}

function submissionSnapshot(
  draft: ReviewDraft | null,
  live: { state: "queued" | "scheduled" } | null,
): "queued" | "scheduled" | null {
  if (live) return live.state;
  if (draft?.submission?.mode === "scheduled") return "scheduled";
  if (draft?.submission) return "queued";
  return null;
}
