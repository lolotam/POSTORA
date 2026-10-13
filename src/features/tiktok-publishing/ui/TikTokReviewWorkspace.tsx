import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { useTikTokAccounts, useTikTokDrafts } from "../application/useTikTokReview";
import type { ReviewDraft, ReviewState } from "../domain/types";
import type { ConfirmDialog } from "./PublishControls";
import { ReviewDetail } from "./ReviewDetail";
import { ReviewQueue, type QueueScreen } from "./ReviewQueue";
import { TikTokSettingsPanel } from "./TikTokSettingsPanel";
import { describeError } from "./reviewCopy";
import { useDraftReview, type LiveSubmission } from "./useDraftReview";
import { useReviewShortcuts } from "./useReviewShortcuts";

interface TikTokReviewWorkspaceProps {
  headerLink: ReactNode;
}

export function TikTokReviewWorkspace({ headerLink }: TikTokReviewWorkspaceProps) {
  const { t } = useTranslation("post");
  const translate = (key: string, fallback: string) => t(key, fallback);
  const accountsQuery = useTikTokAccounts();
  const [accountId, setAccountId] = useState<string | null>(null);
  const [filter, setFilter] = useState<ReviewState>("pending_review");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 767px)").matches);

  const accounts = useMemo(() => accountsQuery.data ?? [], [accountsQuery.data]);
  const pendingQuery = useTikTokDrafts(accountId, "pending_review");
  const listQuery = useTikTokDrafts(accountId, filter);
  const review = useDraftReview({
    selectedId,
    accountId,
    onReopened: () => setFilter("pending_review"),
  });
  const { draft, detail, commands, schedule, overlay, setOverlay } = review;

  useEffect(() => {
    if (!accountId && accounts.length > 0) setAccountId(accounts[0]?.id ?? null);
  }, [accountId, accounts]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const onChange = () => setNarrow(media.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

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

  useReviewShortcuts({
    ready: detail.kind === "ready",
    overlayOpen: overlay.kind !== "closed",
    canReject: review.can.reject,
    onApprove: () => review.openConfirm("now"),
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

  return (
    <div className="tiktok-review">
      {review.actionError ? <p className="tiktok-review-alert" role="alert">{review.actionError}</p> : null}
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
            }).catch(review.report);
          }}
        />
        <ReviewDetail
          screen={detail}
          onReloadConflict={() => {
            review.reloadConflict();
            void listQuery.refetch();
          }}
          narrow={narrow}
          onBack={() => setSelectedId(null)}
          account={account}
          creator={review.creator}
          preview={review.preview}
          onRetryPreview={review.retryPreview}
          editing={review.editing}
          captionDraft={review.captionDraft}
          onCaptionDraft={review.setCaptionDraft}
          onStartEdit={review.startEdit}
          onCancelEdit={review.cancelEdit}
          onSaveCaption={() => { void review.saveCaption(); }}
          saving={commands.saveDraft.isPending}
          mediaNotice={review.mediaNotice}
          onPickMedia={(file) => { void review.pickMedia(file); }}
          onRemoveMedia={() => { void review.removeMedia(); }}
          scheduleLabel={review.scheduleLabel}
          controls={{
            timeZone: review.timeZone,
            scheduleLocal: schedule.scheduleLocal,
            scheduleNote: schedule.scheduleNote,
            onScheduleLocal: schedule.onScheduleLocal,
            onNow: schedule.onNow,
            onShortcut: schedule.onShortcut,
            approveReason: review.approveReason,
            scheduleReason: review.scheduleReason,
            canReject: review.can.reject,
            canEdit: review.can.edit,
            canArchive: review.can.archive,
            canRestore: review.can.restore,
            settings: draft ? (
              <TikTokSettingsPanel
                draft={draft}
                creator={review.creator}
                creatorError={review.creatorError}
                onRetryCreator={review.retryCreator}
                saving={commands.saveDraft.isPending}
                onCancel={() => setOverlay({ kind: "closed" })}
                onSave={(settings, consentChecked) => { void review.saveSettings(settings, consentChecked); }}
              />
            ) : null,
            settingsOpen: overlay.kind === "settings",
            onSettingsOpenChange: (open) => setOverlay(open ? { kind: "settings" } : { kind: "closed" }),
            onArchive: review.archive,
            onRestore: review.restore,
            onReject: review.reject,
            rejectPending: commands.rejectDraft.isPending,
            confirm,
            onOpenConfirm: review.openConfirm,
            onCloseConfirm: () => {
              setOverlay({ kind: "closed" });
              review.setConfirmError(null);
            },
            onConfirm: () => { void review.confirm(); },
            confirmPending: review.confirmPending,
            confirmError: review.confirmError,
            rejectOpen: overlay.kind === "reject",
            onRejectOpenChange: (open) => setOverlay(open ? { kind: "reject" } : { kind: "closed" }),
          }}
          publish={review.showPublish ? {
            status: review.publish.status,
            error: review.publish.error,
            timedOut: review.publish.timedOut,
            refresh: review.publish.refresh,
            immediate: submissionSnapshot(draft, review.liveSubmission),
            scheduledFor: review.submissionScheduledAt,
            reopen: review.canReopen ? () => { void review.reopen(); } : null,
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
  live: Pick<LiveSubmission, "state"> | null,
): "queued" | "scheduled" | null {
  if (live) return live.state;
  if (draft?.submission?.mode === "scheduled") return "scheduled";
  if (draft?.submission) return "queued";
  return null;
}
