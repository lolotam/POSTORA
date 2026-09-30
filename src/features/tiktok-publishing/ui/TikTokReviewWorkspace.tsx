import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { UploadedFile } from "@/hooks/usePostForm";
import { browserTimeZone, parseDatetimeLocal } from "@/features/scheduled/domain/wallClockMove";
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
import { ReviewGatewayError, type ReviewSavePatch } from "../application/ports";
import {
  canTransition,
  consentKey,
  reviewBlockers,
  type ReviewBlocker,
} from "../domain/reviewRules";
import { formatInZone, shortcutInstant, validateScheduledAt, type ShortcutName } from "../domain/scheduleRules";
import type { ReviewDraft, ReviewState } from "../domain/types";
import { PublishControls, type ConfirmDialog } from "./PublishControls";
import { ReviewDetail, type DetailScreen } from "./ReviewDetail";
import { ReviewQueue, type QueueScreen } from "./ReviewQueue";
import { TikTokSettingsPanel } from "./TikTokSettingsPanel";
import { describeBlocker, describeError } from "./reviewCopy";

type Overlay =
  | { kind: "closed" }
  | { kind: "settings" }
  | { kind: "reject" }
  | { kind: "confirm"; mode: "now" | "scheduled"; requestId: string };

type Confirmation = { key: string; caption: string; consent: boolean };

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
  const [mode, setMode] = useState<"now" | "scheduled">("now");
  const [scheduledAt, setScheduledAt] = useState<string | null>(null);
  const [scheduleLocal, setScheduleLocal] = useState("");
  const [scheduleNote, setScheduleNote] = useState<string | null>(null);
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
  const draft = draftQuery.data ?? null;
  const mediaQuery = useTikTokMediaPreview(draft?.mediaFileId ?? null);
  const submissionId = draft?.submission?.id ?? liveSubmission?.id ?? null;
  const publish = usePublishStatus(submissionId);

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
    setMode("now");
    setScheduledAt(null);
    setScheduleLocal("");
    setScheduleNote(null);
    setConfirmation(null);
    setOverlay({ kind: "closed" });
    setMediaNotice(null);
    setActionError(null);
    setConfirmError(null);
    setLiveSubmission(null);
  }, [selectedId]);

  useEffect(() => {
    if (draft && !editing) setCaptionDraft(draft.caption);
  }, [draft, editing]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest("input, textarea, select, [contenteditable='true']")) return;
      if (overlay.kind !== "closed") return;
      // Dialogs owned by child components (e.g. the media picker) are not in
      // `overlay`, so any open dialog, menu or listbox also disables shortcuts.
      if (target.closest("[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']")) return;
      if (document.querySelector("[role='dialog'][data-state='open'], [role='alertdialog'][data-state='open'], [role='menu'][data-state='open']")) return;
      if (event.key === "a" || event.key === "A") {
        event.preventDefault();
        openConfirm("now");
      } else if (event.key === "r" || event.key === "R") {
        event.preventDefault();
        if (draft && canTransition(draft.state, "reject")) setOverlay({ kind: "reject" });
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        const rows = listQuery.data ?? [];
        const index = rows.findIndex((row) => row.id === selectedId);
        const next = rows[index + 1];
        if (next) setSelectedId(next.id);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const creator = creatorQuery.data ?? null;
  const captionDirty = editing && !!draft && captionDraft !== draft.caption;
  const scheduleLabel = mode === "scheduled" && scheduledAt
    ? formatInZone(scheduledAt, timeZone)
    : t("tiktokReview.notScheduled", "—");

  function keyFor(nextMode: "now" | "scheduled", source: ReviewDraft): string {
    return consentKey(
      source.accountId,
      source.revision,
      source.mediaFileId,
      source.settings,
      nextMode,
      nextMode === "scheduled" ? scheduledAt : null,
    );
  }

  function confirmed(nextMode: "now" | "scheduled"): boolean {
    if (!draft || captionDirty || !confirmation) return false;
    return confirmation.key === keyFor(nextMode, draft) && confirmation.caption === draft.caption;
  }

  function blockersFor(nextMode: "now" | "scheduled"): ReviewBlocker[] {
    if (!draft) return [];
    return reviewBlockers({
      caption: draft.caption,
      settings: draft.settings,
      mediaFileId: draft.mediaFileId,
      durationSec: draft.mediaDurationSec,
      creator,
      settingsConfirmed: confirmed(nextMode),
      consentGranted: confirmed(nextMode) && confirmation?.consent === true,
      mode: nextMode,
      scheduledAt: nextMode === "scheduled" ? scheduledAt : null,
    });
  }

  const approveBlockers = blockersFor("now");
  const scheduleBlockers = blockersFor("scheduled");
  const intentBlockers = mode === "scheduled" ? scheduleBlockers : approveBlockers;

  function disabledReason(blockers: ReviewBlocker[], scheduledCheck: boolean): string | null {
    if (!draft) return null;
    if (!canTransition(draft.state, "submit")) {
      return t("tiktokReview.cannotSubmit", "This post cannot be published from its current state.");
    }
    if (creatorQuery.isPending) return t("tiktokReview.creatorLoading", "Loading TikTok account details.");
    if (scheduledCheck && scheduledAt) {
      const verdict = validateScheduledAt(scheduledAt, new Date());
      if (verdict === "past") return t("tiktokReview.timePast", "Choose a future time.");
      if (verdict === "invalid") return t("tiktokReview.timeInvalid", "That time is not valid.");
    }
    const blocker = blockers[0];
    if (!blocker) return null;
    if (blocker.code === "SCHEDULE_TIME_REQUIRED") {
      return t("tiktokReview.pickTime", "PICK A TIME TO ENABLE SCHEDULE");
    }
    return describeBlocker(translate, blocker);
  }

  const approveReason = disabledReason(approveBlockers, false);
  const scheduleReason = disabledReason(scheduleBlockers, true);

  function openConfirm(nextMode: "now" | "scheduled") {
    const reason = nextMode === "scheduled" ? scheduleReason : approveReason;
    if (reason || overlay.kind !== "closed") return;
    setConfirmError(null);
    setOverlay({ kind: "confirm", mode: nextMode, requestId: crypto.randomUUID() });
  }

  async function runSave(patch: ReviewSavePatch) {
    if (!draft || !canTransition(draft.state, "save")) return null;
    setActionError(null);
    try {
      return await commands.saveDraft.mutateAsync({
        draftId: draft.id,
        expectedRevision: draft.revision,
        patch,
      });
    } catch (error) {
      setActionError(describeError(translate, error));
      return null;
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
    if (overlay.kind !== "confirm" || !draft) return;
    const fresh = await creatorQuery.refetch();
    if (fresh.error || !fresh.data) {
      setConfirmError(describeError(translate, fresh.error ?? new ReviewGatewayError("CREATOR_INFO_UNAVAILABLE", "TikTok account details could not be loaded.", 502)));
      return;
    }
    const blockers = reviewBlockers({
      caption: draft.caption,
      settings: draft.settings,
      mediaFileId: draft.mediaFileId,
      durationSec: draft.mediaDurationSec,
      creator: fresh.data,
      settingsConfirmed: confirmed(overlay.mode),
      consentGranted: confirmed(overlay.mode) && confirmation?.consent === true,
      mode: overlay.mode,
      scheduledAt: overlay.mode === "scheduled" ? scheduledAt : null,
    });
    if (!canTransition(draft.state, "submit") || blockers.length > 0) {
      const blocker = blockers[0];
      setConfirmError(blocker ? describeBlocker(translate, blocker) : t("tiktokReview.cannotSubmit", "This post cannot be published from its current state."));
      return;
    }
    if (overlay.mode === "scheduled") {
      if (!scheduledAt) {
        setConfirmError(t("tiktokReview.pickTime", "PICK A TIME TO ENABLE SCHEDULE"));
        return;
      }
      const verdict = validateScheduledAt(scheduledAt, new Date());
      if (verdict !== "ok") {
        setConfirmError(verdict === "past"
          ? t("tiktokReview.timePast", "Choose a future time.")
          : t("tiktokReview.timeInvalid", "That time is not valid."));
        return;
      }
    }
    try {
      const result = await commands.submitDraft.mutateAsync({
        draftId: draft.id,
        expectedRevision: draft.revision,
        requestId: overlay.requestId,
        mode: overlay.mode,
        scheduledAt: overlay.mode === "scheduled" ? scheduledAt : null,
        timeZone,
        consent: true,
      });
      setLiveSubmission({
        id: result.submissionId,
        state: result.state,
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

  function onShortcut(name: ShortcutName) {
    const result = shortcutInstant(name, new Date(), timeZone);
    if (!result.ok) {
      setScheduleNote(result.resolution ?? t("tiktokReview.timeInvalid", "That time is not valid."));
      return;
    }
    setMode("scheduled");
    setScheduledAt(result.iso);
    setScheduleLocal(toDatetimeLocal(result.iso));
    setScheduleNote(result.resolution);
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

  const detail: DetailScreen = commands.revisionConflict
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
            commands.clearRevisionConflict();
            void draftQuery.refetch();
            void listQuery.refetch();
          }}
          narrow={narrow}
          onBack={() => setSelectedId(null)}
          account={account}
          creator={creator}
          preview={mediaQuery.data ?? null}
          previewError={mediaQuery.isError ? describeError(translate, mediaQuery.error) : null}
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
          blockerMessage={intentBlockers[0] ? describeBlocker(translate, intentBlockers[0]) : null}
          scheduleLabel={scheduleLabel}
          timeZone={timeZone}
          scheduleLocal={scheduleLocal}
          scheduleNote={scheduleNote}
          onScheduleLocal={(value) => {
            setScheduleLocal(value);
            if (!value) {
              setScheduledAt(null);
              setMode("scheduled");
              setScheduleNote(null);
              return;
            }
            const parsed = parseDatetimeLocal(value);
            if (parsed.ok === false) {
              setScheduledAt(null);
              setMode("scheduled");
              const missing = parsed.reason === "nonexistent";
              setScheduleNote(missing
                ? t("tiktokReview.dstGap", "That time does not exist because clocks change on that day.")
                : t("tiktokReview.timeInvalid", "That time is not valid."));
              return;
            }
            setMode("scheduled");
            setScheduledAt(parsed.when.toISOString());
            setScheduleNote(null);
          }}
          onNow={() => {
            setMode("now");
            setScheduledAt(null);
            setScheduleLocal("");
            setScheduleNote(null);
          }}
          onShortcut={onShortcut}
          approveReason={approveReason}
          scheduleReason={scheduleReason}
          canReject={!!draft && canTransition(draft.state, "reject")}
          canEdit={!!draft && canTransition(draft.state, "edit")}
          canArchive={!!draft && canTransition(draft.state, "archive")}
          canRestore={!!draft && canTransition(draft.state, "restore")}
          settings={draft ? (
            <TikTokSettingsPanel
              draft={draft}
              creator={creator}
              creatorError={creatorQuery.isError ? describeError(translate, creatorQuery.error) : null}
              onRetryCreator={() => { void creatorQuery.refetch(); }}
              saving={commands.saveDraft.isPending}
              onCancel={() => setOverlay({ kind: "closed" })}
              onSave={(settings, consentChecked) => { void onSaveSettings(settings, consentChecked); }}
            />
          ) : null}
          settingsOpen={overlay.kind === "settings"}
          onSettingsOpenChange={(open) => setOverlay(open ? { kind: "settings" } : { kind: "closed" })}
          onArchive={() => {
            if (!draft || commands.archiveDraft.isPending) return;
            void commands.archiveDraft.mutateAsync({ draftId: draft.id, expectedRevision: draft.revision })
              .catch((error: unknown) => setActionError(describeError(translate, error)));
          }}
          onRestore={() => {
            if (!draft || commands.restoreDraft.isPending) return;
            void commands.restoreDraft.mutateAsync({ draftId: draft.id, expectedRevision: draft.revision })
              .catch((error: unknown) => setActionError(describeError(translate, error)));
          }}
          onReject={(reason) => {
            if (!draft) return;
            void commands.rejectDraft.mutateAsync({ draftId: draft.id, expectedRevision: draft.revision, reason })
              .then(() => setOverlay({ kind: "closed" }))
              .catch((error: unknown) => setActionError(describeError(translate, error)));
          }}
          rejectPending={commands.rejectDraft.isPending}
          confirm={confirm}
          onOpenConfirm={openConfirm}
          onCloseConfirm={() => {
            setOverlay({ kind: "closed" });
            setConfirmError(null);
          }}
          onConfirm={() => { void onConfirm(); }}
          confirmPending={commands.submitDraft.isPending}
          confirmError={confirmError}
          rejectOpen={overlay.kind === "reject"}
          onRejectOpenChange={(open) => setOverlay(open ? { kind: "reject" } : { kind: "closed" })}
          publish={showPublish ? {
            status: publish.status,
            error: publish.error,
            timedOut: publish.timedOut,
            refresh: publish.refresh,
            immediate: submissionSnapshot(draft, liveSubmission),
            scheduledFor: draft?.submission?.scheduledAt ?? liveSubmission?.scheduledFor ?? null,
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

function toDatetimeLocal(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

function readLibraryDuration(file: UploadedFile): number | null {
  // MediaLibraryPicker sets duration from metadata, but UploadedFile does not declare it.
  if (!("duration" in file)) return null;
  const duration = file.duration;
  return typeof duration === "number" && Number.isFinite(duration) ? duration : null;
}

function measureVideoDuration(previewUrl: string): Promise<number | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.preload = "metadata";
    let settled = false;
    const finish = (value: number | null) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      video.onloadedmetadata = null;
      video.onerror = null;
      video.removeAttribute("src");
      video.load();
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), 8000);
    video.onloadedmetadata = () => {
      finish(Number.isFinite(video.duration) ? video.duration : null);
    };
    video.onerror = () => finish(null);
    video.src = previewUrl;
  });
}
