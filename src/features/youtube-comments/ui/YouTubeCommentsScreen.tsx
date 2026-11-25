import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import "@/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, RefreshCw, Youtube, AlertTriangle, CheckCircle2, HelpCircle } from "lucide-react";
import { STAGE4_HOLD_FROM_PUBLISHED, type Stage4CommentRow, type Stage4Reason } from "../domain/types";
import type { SubmissionOutcome } from "../application/useYouTubeStage4";
import { useStage4Replies, useYouTubeStage4 } from "../application/useYouTubeStage4";
import { useStage4Recovery } from "../application/useStage4Recovery";
import { mergeReplyRows } from "../application/mergeReplyRows";
import { draftKey, type DraftKind } from "../application/stage4Drafts";
import { defaultYouTubeCommentsGateway } from "../infrastructure/supabaseYouTubeCommentsGateway";
import { YouTubeCommentsGateway } from "../application/ports";
import { isRebindReason, isStaleContextReason } from "../domain/errors";

/** The translation function shape the reason labels need. */
type Translate = TFunction<"automation">;

/**
 * The complete reason copy. Every entry is a static key-with-default literal
 * call so the i18n coverage gate can verify the EN defaults against the
 * Arabic bundle — dynamic keys would be invisible to it.
 */
const REASON_LABELS: Record<Stage4Reason, (t: Translate) => string> = {
  invalid_request: (t) => t("youtubeStage4.reasons.invalid_request", "That request was not understood."),
  unauthorized: (t) => t("youtubeStage4.reasons.unauthorized", "Your session expired. Sign in again."),
  service_role_not_allowed: (t) => t("youtubeStage4.reasons.invalid_request", "That request was not understood."),
  rate_limited: (t) => t("youtubeStage4.reasons.rate_limited", "Too many requests. Wait a minute and try again."),
  not_found: (t) => t("youtubeStage4.reasons.not_found", "This channel is not available for this action."),
  provider_unsupported: (t) => t("youtubeStage4.reasons.provider_unsupported", "The new comments view needs a directly connected YouTube channel."),
  account_not_connected: (t) => t("youtubeStage4.reasons.account_not_connected", "This channel is disconnected."),
  account_needs_reauth: (t) => t("youtubeStage4.reasons.account_needs_reauth", "Reconnect this channel to continue."),
  capability_off: (t) => t("youtubeStage4.reasons.capability_off", "This action is not enabled for this channel yet."),
  prerequisite_missing: (t) => t("youtubeStage4.reasons.capability_off", "This action is not enabled for this channel yet."),
  account_not_admitted: (t) => t("youtubeStage4.reasons.capability_off", "This action is not enabled for this channel yet."),
  tile_disabled: (t) => t("youtubeStage4.reasons.capability_off", "This action is not enabled for this channel yet."),
  rollout_missing: (t) => t("youtubeStage4.reasons.capability_off", "This action is not enabled for this channel yet."),
  rollout_invalid: (t) => t("youtubeStage4.reasons.capability_off", "This action is not enabled for this channel yet."),
  settings_unavailable: (t) => t("youtubeStage4.reasons.settings_unavailable", "Postora could not read its settings. Try again."),
  invalid_handle: (t) => t("youtubeStage4.reasons.stale_context", "This comment's context expired. Refresh the list."),
  expired_handle: (t) => t("youtubeStage4.reasons.stale_context", "This comment's context expired. Refresh the list."),
  cross_context: (t) => t("youtubeStage4.reasons.stale_context", "This comment belongs to another account or channel. Refresh the list."),
  video_not_owned: (t) => t("youtubeStage4.reasons.not_found", "This video is not on your channel."),
  target_not_verified: (t) => t("youtubeStage4.reasons.target_gone", "This comment could not be verified on YouTube. Refresh the list."),
  target_not_owned: (t) => t("youtubeStage4.reasons.not_own_comment", "Only comments your channel wrote can be edited."),
  target_missing_author: (t) => t("youtubeStage4.reasons.no_author", "YouTube did not say who wrote this comment, so they cannot be banned."),
  comment_text_required: (t) => t("youtubeStage4.reasons.invalid_text", "Write something first."),
  comment_text_too_long: (t) => t("youtubeStage4.reasons.invalid_text", "That comment is too long for YouTube."),
  invalid_text: (t) => t("youtubeStage4.reasons.invalid_text", "YouTube refused that comment's text."),
  conflict: (t) => t("youtubeStage4.reasons.conflict", "This submit was already recorded with a different intent."),
  possible_duplicate: (t) => t("youtubeStage4.reasons.possible_duplicate", "The same comment may already be on its way. Refresh the thread."),
  recently_posted: (t) => t("youtubeStage4.reasons.recently_posted", "The same comment was just posted. Wait before posting it again."),
  already_recorded: (t) => t("youtubeStage4.reasons.already_recorded", "This submit was already recorded."),
  binding_changed: (t) => t("youtubeStage4.reasons.binding_changed", "This channel was reconnected, so this action can no longer be checked here. Check the video on YouTube."),
  capability_denied: (t) => t("youtubeStage4.reasons.capability_off", "This action is not enabled for this channel yet."),
  ban_confirmation_required: (t) => t("youtubeStage4.reasons.ban_confirmation", "Banning an author needs its own confirmation step."),
  ban_confirmation_invalid: (t) => t("youtubeStage4.reasons.ban_confirmation", "Banning an author needs its own confirmation step."),
  ban_confirmation_expired: (t) => t("youtubeStage4.reasons.ban_confirmation_expired", "The ban confirmation expired. Start the reject again."),
  ban_confirmation_mismatch: (t) => t("youtubeStage4.reasons.ban_confirmation", "Banning an author needs its own confirmation step."),
  comments_disabled: (t) => t("youtubeStage4.reasons.comments_disabled", "Comments are turned off for this video."),
  scope_missing: (t) => t("youtubeStage4.reasons.scope_missing", "Reconnect this channel to grant comment access."),
  quota: (t) => t("youtubeStage4.reasons.quota", "YouTube's daily limit was reached. Nothing was retried."),
  unauthorized_provider: (t) => t("youtubeStage4.reasons.unauthorized", "Your session expired. Sign in again."),
  forbidden: (t) => t("youtubeStage4.reasons.forbidden", "YouTube refused this action."),
  ineligible_account: (t) => t("youtubeStage4.reasons.ineligible_account", "This account is not allowed to comment on YouTube."),
  not_found_provider: (t) => t("youtubeStage4.reasons.target_gone", "This comment is no longer available on YouTube."),
  upstream: (t) => t("youtubeStage4.reasons.upstream", "YouTube did not answer in a way Postora can use."),
  indeterminate: (t) => t("youtubeStage4.reasons.indeterminate", "This may or may not have been applied."),
  upstream_inconsistent: (t) => t("youtubeStage4.reasons.upstream", "YouTube did not answer in a way Postora can use."),
};

/** Localized copy for any Stage 4 refusal reason. */
function reasonText(t: Translate, reason: string | null | undefined): string {
  const factory = reason ? REASON_LABELS[reason as Stage4Reason] : undefined;
  return factory ? factory(t) : t("youtubeStage4.reasons.upstream", "YouTube did not answer in a way Postora can use.");
}

export interface YouTubeCommentsScreenProps {
  userId: string;
  accountId: string;
  gateway?: YouTubeCommentsGateway;
}

/**
 * The Stage 4 inbox surface: an owned-video picker, Published and Held lists,
 * fenced create and reply, own-comment edit, moderation with a separately
 * confirmed ban, and durable operation status across reloads. Every string is
 * localized (EN default, AR bundle); provider and commenter text renders as
 * plain text only.
 */
export function YouTubeCommentsScreen(props: YouTubeCommentsScreenProps): JSX.Element {
  const { t } = useTranslation("automation");
  const stage4 = useYouTubeStage4({
    userId: props.userId,
    accountId: props.accountId,
    gateway: props.gateway ?? defaultYouTubeCommentsGateway,
  });
  // A notice belongs to the user, account and video that produced it. It is
  // stored WITH its context and shown only while that context is current, so
  // a late response from the previous video (or account) that lands after a
  // switch is simply never displayed.
  const [notice, setNotice] = useState<{ text: string; context: string } | null>(null);
  const contextKey = `${props.userId}:${props.accountId}:${stage4.effectiveVideoId ?? "-"}`;
  const noticeForThisContext = (text: string | null) => setNotice(text === null ? null : { text, context: contextKey });

  if (stage4.capabilitiesQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-12" aria-busy="true" aria-label={t("youtubeStage4.loading", "Loading YouTube comments")}>
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }
  // A failed settings read is an ERROR, never a denial: it is offered again
  // (retry), and it never reads as "not enabled" (spec 13).
  const settingsError = stage4.capabilitiesQuery.isError;
  const retrySettings = () => void stage4.capabilitiesQuery.refetch();
  if (!stage4.canRead) {
    const reason = stage4.capabilities?.capabilities.read.reason ?? "settings_unavailable";
    return (
      <div className="space-y-4">
        {/* Receipt status is not behind the rollout policy: the outcome of a
            pending send is still shown with every capability off (spec 7.4). */}
        <RecoveredBanners stage4={stage4} />
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <Youtube className="h-10 w-10 mx-auto mb-3 opacity-40" />
            {settingsError ? (
              <>
                <p className="font-medium">{t("youtubeStage4.settings.unavailableTitle", "Postora could not read its settings")}</p>
                <p className="text-sm mt-1">{reasonText(t, "settings_unavailable")}</p>
                <Button size="sm" variant="outline" className="mt-3" onClick={retrySettings} disabled={stage4.capabilitiesQuery.isFetching}>
                  {t("youtubeStage4.settings.retry", "Try again")}
                </Button>
              </>
            ) : (
              <>
                <p className="font-medium">{t("youtubeStage4.notAdmittedTitle", "The new YouTube comments view is not enabled for this channel")}</p>
                <p className="text-sm mt-1">{reasonText(t, reason)}</p>
              </>
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {settingsError && (
        // The screen stays: a failed refresh of the settings never takes away
        // what the owner was already admitted to (and may be typing in).
        <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-amber-600 dark:text-amber-400" data-testid="yt-stage4-settings-error">
          <AlertTriangle className="h-3.5 w-3.5" />
          <span>{t("youtubeStage4.settings.refreshFailed", "Postora could not refresh its settings. Your work here is kept.")}</span>
          <Button size="sm" variant="outline" onClick={retrySettings} disabled={stage4.capabilitiesQuery.isFetching}>
            {t("youtubeStage4.settings.retry", "Try again")}
          </Button>
        </div>
      )}
      {notice && notice.context === contextKey && (
        <p role="status" className="text-xs text-muted-foreground" data-testid="yt-stage4-notice">{notice.text}</p>
      )}
      <RecoveredBanners stage4={stage4} />
      <VideoPicker stage4={stage4} />
      <ListTabs stage4={stage4} />
      {/* Composer drafts, open editors and reply panels live below this key,
          so they are discarded with the user, account or video they belong to. */}
      <ThreadList key={contextKey} stage4={stage4} onNotice={noticeForThisContext} />
    </div>
  );
}

// ---- recovered operations -----------------------------------------------------

function RecoveredBanners({ stage4 }: { stage4: ReturnType<typeof useYouTubeStage4> }): JSX.Element | null {
  if (stage4.recovered.length === 0) return null;
  return (
    <RecoveredBannerList
      testId="yt-stage4-recovered"
      entries={stage4.recovered.map((entry) => ({ operation: entry.operation, status: entry.status, unavailable: entry.unavailable }))}
      onDismiss={stage4.clearRecovered}
      onRecheck={(operationId) => void stage4.recheckRecovered(operationId)}
    />
  );
}

interface BannerEntry {
  operation: { operationId: string };
  status: import("../domain/types").Stage4OperationStatusPayload | null;
  /** The status could not be read right now; the identity is kept and the owner can check again. */
  unavailable: boolean;
}

/** The outcome of operations started before a reload, one banner per operation. */
function RecoveredBannerList(props: {
  testId: string;
  entries: BannerEntry[];
  onDismiss: (operationId: string) => void;
  onRecheck: (operationId: string) => void;
}): JSX.Element {
  const { t } = useTranslation("automation");
  return (
    <div className="space-y-2" data-testid={props.testId}>
      {props.entries.map((entry) => (
        <div
          key={entry.operation.operationId}
          className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
          role={entry.unavailable || entry.status?.state === "indeterminate" ? "alert" : "status"}
        >
          <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
          <div className="flex-1">
            {entry.unavailable ? (
              <>
                <p className="font-medium text-amber-700 dark:text-amber-300">
                  {t("youtubeStage4.recovered.unavailableTitle", "The result of a previous action could not be checked right now")}
                </p>
                <p className="text-amber-700/80 dark:text-amber-300/80 mt-0.5">
                  {t("youtubeStage4.recovered.unavailableBody", "It was not sent again. Check the status again before you try the same thing.")}
                </p>
              </>
            ) : entry.status === null ? (
              <>
                <p className="font-medium text-amber-700 dark:text-amber-300">
                  {t("youtubeStage4.recovered.rebindTitle", "This action was started before the channel was reconnected")}
                </p>
                <p className="text-amber-700/80 dark:text-amber-300/80 mt-0.5">
                  {t("youtubeStage4.recovered.rebindBody", "Its result can no longer be checked here. Check the video on YouTube.")}
                </p>
              </>
            ) : entry.status.state === "claimed" || entry.status.state === "dispatched" ? (
              <>
                <p className="font-medium text-amber-700 dark:text-amber-300">
                  {t("youtubeStage4.recovered.pendingTitle", "A previous action is still being processed")}
                </p>
                <p className="text-amber-700/80 dark:text-amber-300/80 mt-0.5">
                  {t("youtubeStage4.recovered.pendingBody", "It was not sent again. Check the status in a moment.")}
                </p>
              </>
            ) : entry.status.state === "indeterminate" ? (
              <>
                <p className="font-medium text-amber-700 dark:text-amber-300">
                  {t("youtubeStage4.recovered.indeterminateTitle", "A previous action may or may not have been applied")}
                </p>
                <p className="text-amber-700/80 dark:text-amber-300/80 mt-0.5">
                  {t("youtubeStage4.recovered.indeterminateBody", "It was not sent again. Refresh the thread to see what is there now.")}
                </p>
              </>
            ) : entry.status.state === "confirmed" ? (
              <p className="text-amber-700 dark:text-amber-300">
                {t("youtubeStage4.recovered.confirmed", "A previous action was accepted by YouTube.")}
              </p>
            ) : (
              <p className="text-amber-700 dark:text-amber-300">
                {t("youtubeStage4.recovered.refused", "A previous action was not applied.")}{" "}
                {reasonText(t, entry.status.reason)}
              </p>
            )}
          </div>
          {(entry.unavailable || entry.status?.state === "claimed" || entry.status?.state === "dispatched") && (
            <Button size="sm" variant="outline" onClick={() => props.onRecheck(entry.operation.operationId)}>
              {t("youtubeStage4.recovered.checkStatus", "Check status")}
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => props.onDismiss(entry.operation.operationId)}>
            {t("youtubeStage4.recovered.dismiss", "Dismiss")}
          </Button>
        </div>
      ))}
    </div>
  );
}

// ---- the video picker -----------------------------------------------------------

function VideoPicker({ stage4 }: { stage4: ReturnType<typeof useYouTubeStage4> }): JSX.Element {
  const { t } = useTranslation("automation");
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-medium">{t("youtubeStage4.picker.title", "Your uploads")}</p>
        <Button size="sm" variant="outline" onClick={stage4.videos.reload} disabled={stage4.videos.loading}>
          {stage4.videos.loading ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <RefreshCw className="h-4 w-4 me-1" />}
          {t("common:refresh", "Refresh")}
        </Button>
      </div>
      {stage4.videos.error && (
        <p className="text-sm text-destructive">{t("youtubeStage4.picker.error", "Couldn't load your uploads.")}</p>
      )}
      <div className="flex flex-wrap gap-2" role="listbox" aria-label={t("youtubeStage4.picker.title", "Your uploads")}>
        {stage4.videos.items.map((video) => (
          <button
            key={video.id}
            type="button"
            role="option"
            aria-selected={video.id === stage4.effectiveVideoId}
            onClick={() => stage4.setSelectedVideoId(video.id)}
            className={
              "max-w-[260px] truncate rounded-lg border px-3 py-2 text-start text-sm transition-colors " +
              (video.id === stage4.effectiveVideoId
                ? "border-primary bg-primary/10 font-medium"
                : "border-border hover:border-primary/50")
            }
            title={video.title}
          >
            {video.title}
          </button>
        ))}
      </div>
      {stage4.videos.nextCursor && (
        <Button size="sm" variant="ghost" onClick={stage4.videos.loadMore} disabled={stage4.videos.loading}>
          {t("youtubeStage4.picker.loadMore", "Load more uploads")}
        </Button>
      )}
      {stage4.videos.items.length === 0 && !stage4.videos.loading && (
        <p className="text-sm text-muted-foreground">{t("youtubeStage4.picker.empty", "No uploads found for this channel.")}</p>
      )}
    </div>
  );
}

// ---- the Published / Held tabs ---------------------------------------------------

function ListTabs({ stage4 }: { stage4: ReturnType<typeof useYouTubeStage4> }): JSX.Element {
  const { t } = useTranslation("automation");
  return (
    <div role="tablist" aria-label={t("youtubeStage4.lists.aria", "Comment lists")} className="flex gap-2">
      <button
        type="button"
        role="tab"
        aria-selected={stage4.listMode === "published"}
        onClick={() => stage4.setListMode("published")}
        className={"rounded-lg border px-3 py-1.5 text-sm " + (stage4.listMode === "published" ? "border-primary bg-primary/10 font-medium" : "border-border")}
      >
        {t("youtubeStage4.lists.published", "Published")}
      </button>
      {stage4.canHold && (
        <button
          type="button"
          role="tab"
          aria-selected={stage4.listMode === "heldForReview"}
          onClick={() => stage4.setListMode("heldForReview")}
          className={"rounded-lg border px-3 py-1.5 text-sm " + (stage4.listMode === "heldForReview" ? "border-primary bg-primary/10 font-medium" : "border-border")}
        >
          {t("youtubeStage4.lists.held", "Held for review")}
        </button>
      )}
    </div>
  );
}

// ---- the thread list -------------------------------------------------------------

function ThreadList({ stage4, onNotice }: { stage4: ReturnType<typeof useYouTubeStage4>; onNotice: (text: string | null) => void }): JSX.Element {
  const { t } = useTranslation("automation");
  const videoId = stage4.effectiveVideoId;

  if (!videoId) return <></>;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <Button size="sm" variant="outline" onClick={stage4.threads.reload} disabled={stage4.threads.loading}>
          {stage4.threads.loading ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : <RefreshCw className="h-4 w-4 me-1" />}
          {t("youtubeStage4.list.refresh", "Refresh comments")}
        </Button>
      </div>

      {stage4.canWrite && <TopLevelComposer stage4={stage4} videoId={videoId} onNotice={onNotice} />}

      {stage4.threads.error && (
        <div className="flex items-center gap-2 text-sm text-destructive">
          <span>{reasonText(t, stage4.threads.error)}</span>
          {isStaleContextReason(stage4.threads.errorCode) ? (
            <Button size="sm" variant="outline" onClick={stage4.threads.reload}>
              {t("youtubeStage4.list.reloadFromStart", "Reload from the first page")}
            </Button>
          ) : (
            <Button size="sm" variant="outline" onClick={stage4.threads.retry}>
              {t("youtubeStage4.list.retry", "Retry this page")}
            </Button>
          )}
        </div>
      )}

      {stage4.threads.items.length === 0 && !stage4.threads.loading && !stage4.threads.error && (
        <p className="py-8 text-center text-muted-foreground" data-testid="yt-stage4-empty">
          {t("youtubeStage4.list.empty", "No comments yet")}
        </p>
      )}

      <div className="space-y-3">
        {stage4.threads.items
          .filter((item) => item.row.kind === "thread")
          .map((item) => (
            // The generation is part of the key so a rebind remounts the card and its editors (no draft or outcome crosses a binding).
            <CommentCard
              key={`${stage4.threads.bindingGeneration ?? 0}:${item.row.comment_id}`}
              stage4={stage4}
              row={item.row}
              videoId={videoId}
              onNotice={onNotice}
              inlineReplies={stage4.threads.items
                .filter((other) => other.row.kind === "reply" && other.row.canonical_parent_id === item.row.comment_id)
                .map((other) => other.row)}
            />
          ))}
      </div>

      {stage4.threads.nextCursor && (
        <Button size="sm" variant="outline" onClick={stage4.threads.loadMore} disabled={stage4.threads.loading}>
          {t("youtubeStage4.list.loadMore", "Load more comments")}
        </Button>
      )}
    </div>
  );
}

// ---- one comment row ---------------------------------------------------------------

function CommentCard(params: {
  stage4: ReturnType<typeof useYouTubeStage4>;
  row: Stage4CommentRow;
  videoId: string;
  onNotice: (text: string | null) => void;
  reply?: boolean;
  /** The thread page's inline reply preview, merged with the reply pages. */
  inlineReplies?: Stage4CommentRow[];
}): JSX.Element {
  const { stage4, row, videoId, onNotice, reply = false, inlineReplies = [] } = params;
  const { t } = useTranslation("automation");
  // The editors read what they hold from the draft store: this card can leave the
  // screen (a Refresh returns the reply chain to page one) and come back.
  const generation = stage4.threads.bindingGeneration ?? 0;
  const draftKeyOf = (kind: DraftKind) => draftKey(stage4.accountId, generation, row.comment_id, kind);
  // The thread this comment belongs to: a reply names its canonical parent, a top-level comment is its own.
  const threadId = row.canonical_parent_id || row.comment_id;
  const [composer, setComposerState] = useState<"none" | "reply" | "edit">(() =>
    stage4.drafts.get(draftKeyOf("edit"))?.open ? "edit" : stage4.drafts.get(draftKeyOf("reply"))?.open ? "reply" : "none");
  const openComposer = (kind: DraftKind) => {
    const key = draftKeyOf(kind);
    if (!stage4.drafts.get(key)) {
      stage4.drafts.set(key, { text: kind === "edit" ? row.text : "", open: true, parentCommentId: threadId });
    }
    setComposerState(kind);
  };
  const closeComposer = (kind: DraftKind) => {
    stage4.drafts.remove(draftKeyOf(kind));
    setComposerState("none");
  };
  const [rejectOpen, setRejectOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // An outcome that lands after this card is gone has nobody to show it to:
  // it must not clear the operation's identity (see runModerate).
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isCurrent = () => mounted.current;

  // Controls follow the VISIBLE row's own status (spec 8.4 / 10.1).
  const status = row.moderation_status;
  const canModerate = stage4.canWrite && (status === "published" || status === "heldForReview");
  const showPublish = canModerate && status === "heldForReview";
  // Hold is offered on a published row only while the shared switch allows it
  // (a published comment cannot return to held, see STAGE4_HOLD_FROM_PUBLISHED).
  const showHold = canModerate && status === "published" && STAGE4_HOLD_FROM_PUBLISHED;
  const showReject = canModerate;

  return (
    <Card className="p-0">
      <CardContent className="p-4 space-y-2">
        <div className="flex items-start gap-3">
          <Avatar className="h-8 w-8">
            <AvatarImage src={row.author_avatar_url ?? ""} />
            <AvatarFallback>{row.author_name.slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium truncate">{row.author_name}</span>
              {row.is_own && <Badge variant="outline" className="text-[10px]">{t("youtubeStage4.row.you", "You")}</Badge>}
              {status === "heldForReview" && (
                <Badge variant="outline" className="text-[10px] text-amber-600 dark:text-amber-400">
                  {t("youtubeStage4.row.held", "Held for review")}
                </Badge>
              )}
              {status === null && (
                <Badge variant="outline" className="text-[10px] text-muted-foreground">
                  {t("youtubeStage4.row.readOnly", "Read-only")}
                </Badge>
              )}
            </div>
            <p className="text-sm mt-1 whitespace-pre-wrap break-words">{row.text}</p>
            <p className="text-xs text-muted-foreground mt-1">
              {new Date(row.published_at).toLocaleString()} · {t("youtubeStage4.row.likes", "{{count}} likes", { count: row.like_count })}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          {stage4.canWrite && composer === "none" && (
            <Button size="sm" variant="outline" onClick={() => openComposer("reply")}>
              {t("youtubeStage4.actions.reply", "Reply")}
            </Button>
          )}
          {stage4.canWrite && row.is_own && composer === "none" && (
            <Button size="sm" variant="outline" onClick={() => openComposer("edit")}>
              {t("youtubeStage4.actions.edit", "Edit")}
            </Button>
          )}
          {row.is_own && (
            <Button size="sm" variant="outline" onClick={() => setDeleteOpen(true)}>
              {t("youtubeStage4.actions.delete", "Delete")}
            </Button>
          )}
          {showPublish && (
            <Button size="sm" variant="outline" onClick={() => void runModerate(stage4, row, videoId, "published", onNotice, t, undefined, undefined, isCurrent)}>
              {t("youtubeStage4.actions.publish", "Publish")}
            </Button>
          )}
          {showHold && (
            <Button size="sm" variant="outline" onClick={() => void runModerate(stage4, row, videoId, "heldForReview", onNotice, t, undefined, undefined, isCurrent)}>
              {t("youtubeStage4.actions.hold", "Hold")}
            </Button>
          )}
          {showReject && (
            <Button size="sm" variant="destructive" onClick={() => setRejectOpen(true)}>
              {t("youtubeStage4.actions.reject", "Reject")}
            </Button>
          )}
        </div>

        {composer === "reply" && (
          <Composer
            key={`reply-${row.comment_id}`}
            initialText={stage4.drafts.get(draftKeyOf("reply"))?.text}
            onTextChange={(text) => stage4.drafts.set(draftKeyOf("reply"), { text, open: true, parentCommentId: threadId })}
            onConfirmed={() => stage4.drafts.remove(draftKeyOf("reply"))}
            placeholder={t("youtubeStage4.composer.replyPlaceholder", "Write a reply")}
            submitLabel={t("youtubeStage4.composer.replySubmit", "Reply")}
            onSubmit={async (text, isCurrent) => {
              const outcome = await stage4.reply(videoId, row, text, () => mounted.current && isCurrent());
              return outcome;
            }}
            onCancel={() => closeComposer("reply")}
            onNotice={onNotice}
            onCheckStatus={stage4.checkStatus}
            onAcknowledge={stage4.acknowledge}
          />
        )}
        {composer === "edit" && (
          <Composer
            key={`edit-${row.comment_id}`}
            initialText={stage4.drafts.get(draftKeyOf("edit"))?.text ?? row.text}
            onTextChange={(text) => stage4.drafts.set(draftKeyOf("edit"), { text, open: true, parentCommentId: threadId })}
            onConfirmed={() => stage4.drafts.remove(draftKeyOf("edit"))}
            placeholder={t("youtubeStage4.composer.editPlaceholder", "Edit your comment")}
            submitLabel={t("youtubeStage4.composer.editSubmit", "Save")}
            onSubmit={async (text, isCurrent) => {
              const outcome = await stage4.editComment(videoId, row, text, () => mounted.current && isCurrent());
              return outcome;
            }}
            onCancel={() => closeComposer("edit")}
            onNotice={onNotice}
            onCheckStatus={stage4.checkStatus}
            onAcknowledge={stage4.acknowledge}
          />
        )}

        {!reply && (
          <ReplyBlock stage4={stage4} parent={row} videoId={videoId} onNotice={onNotice} inlineReplies={inlineReplies} />
        )}

        <DeleteOwnDialog stage4={stage4} row={row} open={deleteOpen} onOpenChange={setDeleteOpen} onNotice={onNotice} />

        <RejectDialog
          stage4={stage4}
          row={row}
          videoId={videoId}
          open={rejectOpen}
          onOpenChange={setRejectOpen}
          onNotice={onNotice}
          isCurrent={isCurrent}
        />
      </CardContent>
    </Card>
  );
}

async function runModerate(
  stage4: ReturnType<typeof useYouTubeStage4>,
  row: Stage4CommentRow,
  videoId: string,
  status: "published" | "heldForReview" | "rejected",
  onNotice: (text: string | null) => void,
  t: Translate,
  banConfirmation?: string,
  operationId?: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  const outcome = await stage4.moderate(videoId, row, status, banConfirmation, operationId, isCurrent);
  if (outcome.kind === "cancelled") return;
  // Only a surface that is still there to show the outcome acknowledges it.
  if (isCurrent()) {
    if (outcome.kind === "confirmed" || outcome.kind === "refused") stage4.acknowledge(outcome.operationId);
  }
  if (outcome.kind === "confirmed") {
    onNotice(t("youtubeStage4.notice.moderated", "Done. Refresh the list to see the current state."));
    return;
  }
  if (outcome.kind === "indeterminate" || outcome.kind === "error") {
    // A lost response is as unknown as an indeterminate receipt: nothing was
    // resent, and the identity stays so the status can be read after a reload.
    onNotice(t("youtubeStage4.notice.indeterminate", "This may or may not have been applied. It was not sent again."));
    return;
  }
  if (outcome.kind === "pending") {
    onNotice(t("youtubeStage4.notice.pending", "An earlier attempt for this comment is still being checked."));
    return;
  }
  if (outcome.kind === "earlier") {
    if (isCurrent()) stage4.acknowledge(outcome.operationId);
    onNotice(outcome.state === "confirmed"
      ? t("youtubeStage4.outcome.earlierConfirmed", "Your earlier action was accepted by YouTube. What you typed now was not sent — submit again to send it.")
      : t("youtubeStage4.outcome.earlierRefused", "Your earlier action was not applied. What you typed now was not sent — submit again to send it."));
    return;
  }
  onNotice(reasonText(t, outcome.reason));
}

// ---- the reply block with paged replies ---------------------------------------------

function ReplyBlock(params: {
  stage4: ReturnType<typeof useYouTubeStage4>;
  parent: Stage4CommentRow;
  videoId: string;
  onNotice: (text: string | null) => void;
  inlineReplies?: Stage4CommentRow[];
}): JSX.Element | null {
  const { stage4, parent, videoId, onNotice, inlineReplies = [] } = params;
  const { t } = useTranslation("automation");
  const open = stage4.replyTargetsOpen[parent.comment_id] === true;
  const replies = useStage4Replies({
    userId: stage4.userId,
    accountId: stage4.accountId,
    gateway: stage4.gateway,
    parentCommentId: parent.comment_id,
    parentHandle: parent.handle,
    bindingGeneration: stage4.threads.bindingGeneration,
    refreshEpoch: stage4.repliesEpoch,
    enabled: open,
  });
  // Replies merge by comment id across the inline preview and every loaded
  // page (spec 8.3). For one comment id the row from the LATER successful read
  // wins: an older cached reply page must not overwrite the thread page's own
  // fresher copy, and a reply page read after the thread page must not lose to it.
  const allReplies = mergeReplyRows(
    inlineReplies.map((row) => ({ row, readAt: stage4.threads.readAtOf(row.comment_id) })),
    replies.items.map((item) => ({ row: item.row, readAt: item.readAt })),
  ).map((row) => ({ key: row.comment_id, row }));
  // Drafts waiting on a reply this block has not loaded (their row left the screen with a Refresh).
  useSyncExternalStore(stage4.drafts.subscribe, stage4.drafts.version);
  const waitingDrafts = stage4.drafts.forParent(parent.comment_id).filter((draft) =>
    draft.entry.open && draft.commentId !== parent.comment_id && !allReplies.some((item) => item.row.comment_id === draft.commentId));
  // A thread in the Held list with no loaded row (its own, an inline reply or
  // a paged reply) that reads heldForReview says so, per thread (spec 8.4).
  const heldHidden = stage4.listMode === "heldForReview"
    && parent.moderation_status !== "heldForReview"
    && allReplies.every((item) => item.row.moderation_status !== "heldForReview");
  const heldHiddenNotice = heldHidden ? (
    <p className="text-sm text-muted-foreground" data-testid="yt-stage4-held-hidden">
      {t(
        "youtubeStage4.list.heldHidden",
        "A reply in this thread is awaiting review, but YouTube did not make it available here.",
      )}
    </p>
  ) : null;

  if (!open) {
    return (
      <>
        {heldHiddenNotice}
        <Button size="sm" variant="ghost" onClick={() => stage4.openReplies(parent.comment_id)}>
          {t("youtubeStage4.replies.load", "Load replies")}
        </Button>
      </>
    );
  }
  return (
    <div className="space-y-2 ms-6 border-s ps-3" data-testid="yt-stage4-replies">
      {heldHiddenNotice}
      {waitingDrafts.length > 0 && (
        <p className="text-xs text-muted-foreground" data-testid="yt-stage4-draft-waiting">
          {t("youtubeStage4.replies.draftWaiting", "You have an unsent draft on a reply that is not loaded here. Load more replies to see it.")}
        </p>
      )}
      <div className="flex items-center gap-2">
        <p className="text-xs font-medium text-muted-foreground">{t("youtubeStage4.replies.title", "Replies")}</p>
        <Button size="sm" variant="ghost" onClick={() => stage4.closeReplies(parent.comment_id)}>
          {t("youtubeStage4.replies.hide", "Hide")}
        </Button>
      </div>
      {replies.error && (
        <div className="flex items-center gap-2 text-xs text-destructive">
          {isStaleContextReason(replies.errorCode) ? (
            <>
              <span>{t("youtubeStage4.replies.stale", "These replies are out of date.")}</span>
              {/* Repeating a refused cursor cannot help, and the refused handle is the PARENT's: it is
                  issued again with the thread list, so the list is read first and the open reply
                  chains restart from it with the new handles. A parent that sat on a later page of
                  the list leaves the screen with the list's return to page one; the drafts stay. */}
              <Button size="sm" variant="outline" onClick={stage4.threads.reload}>
                {t("youtubeStage4.replies.reloadFromStart", "Reload from the start")}
              </Button>
            </>
          ) : (
            <>
              <span>{t("youtubeStage4.replies.error", "A page of replies failed to load.")}</span>
              <Button size="sm" variant="outline" onClick={replies.retry}>
                {t("youtubeStage4.replies.retry", "Retry this page")}
              </Button>
            </>
          )}
        </div>
      )}
      {allReplies.map((item) => (
        // The generation is part of the key so a rebind remounts the card and its editors (no draft or outcome crosses a binding).
        <CommentCard key={`${stage4.threads.bindingGeneration ?? 0}:${item.row.comment_id}`} stage4={stage4} row={item.row} videoId={videoId} onNotice={onNotice} reply />
      ))}
      {replies.nextCursor && (
        <Button size="sm" variant="outline" onClick={replies.loadMore} disabled={replies.loading}>
          {t("youtubeStage4.replies.more", "More replies")}
        </Button>
      )}
      {allReplies.length === 0 && !replies.loading && !replies.error && (
        <p className="text-xs text-muted-foreground">{t("youtubeStage4.replies.empty", "No replies loaded.")}</p>
      )}
    </div>
  );
}

// ---- the top-level composer -----------------------------------------------------------

function TopLevelComposer(params: {
  stage4: ReturnType<typeof useYouTubeStage4>;
  videoId: string;
  onNotice: (text: string | null) => void;
}): JSX.Element {
  const { stage4, videoId, onNotice } = params;
  const { t } = useTranslation("automation");
  return (
    <Composer
      placeholder={t("youtubeStage4.composer.topPlaceholder", "Post a comment as your channel")}
      submitLabel={t("youtubeStage4.composer.topSubmit", "Comment")}
      onSubmit={async (text, isCurrent) => stage4.createThread(videoId, text, isCurrent)}
      onNotice={onNotice}
      onCheckStatus={stage4.checkStatus}
      onAcknowledge={stage4.acknowledge}
    />
  );
}

// ---- the shared composer ----------------------------------------------------------------

function Composer(params: {
  initialText?: string;
  placeholder: string;
  submitLabel: string;
  onSubmit: (text: string, isCurrent: () => boolean) => Promise<SubmissionOutcome>;
  onCancel?: () => void;
  onNotice?: (text: string | null) => void;
  /** Reads one operation's receipt again; never resends. Offered after a lost response or an unknown outcome. */
  onCheckStatus?: (operationId: string, draftText?: string) => Promise<SubmissionOutcome>;
  /** Called once this composer has shown a definite outcome, so its identity can be forgotten. */
  onAcknowledge?: (operationId: string) => void;
  /** Called with the text on every change, so a draft store can keep it outside this component. */
  onTextChange?: (text: string) => void;
  /** Called only when a confirmed outcome also empties the composer; newer unsent text keeps its stored draft. */
  onConfirmed?: () => void;
}): JSX.Element {
  const { t } = useTranslation("automation");
  const inputId = useId();
  const [text, setText] = useState(params.initialText ?? "");
  const textRef = useRef(text);
  textRef.current = text;
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [localOutcome, setLocalOutcome] = useState<SubmissionOutcome | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  // An answer that arrives after this composer is gone has nobody to show it
  // to: it must neither update state nor acknowledge (clear) the identity.
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // A status check that finishes after newer composer work (a newer submit, or
  // another check) must not overwrite what that work shows. The text a check's
  // confirmation may clear is the text of the operation that was ACTUALLY SENT,
  // so it is remembered together with that operation's id: a submit the
  // pre-submit check blocked (an earlier operation still pending) sent nothing,
  // and what was typed for it must never be mistaken for the sent text.
  const submitSeq = useRef(0);
  const checkSeq = useRef(0);
  const sent = useRef<{ operationId: string; text: string } | null>(null);

  useEffect(() => {
    if (localOutcome) inputRef.current?.focus();
  }, [localOutcome]);

  const show = (outcome: SubmissionOutcome, fromCheck = false) => {
    if (!mounted.current || outcome.kind === "cancelled") return;
    setLocalOutcome(outcome);
    if (outcome.kind === "earlier") {
      // The result of an earlier send, shown. What is typed now was never sent,
      // so it stays exactly as it is.
      params.onAcknowledge?.(outcome.operationId);
      return;
    }
    if (outcome.kind === "confirmed") {
      // A check reads the receipt of the operation that WAS sent: the box is
      // emptied only when this is that operation AND the box still holds the
      // text it sent, so newer typing, or a draft that was never sent, is kept.
      const confirmedSent = sent.current?.operationId === outcome.operationId ? sent.current.text : null;
      const keepsNewer = fromCheck && textRef.current !== confirmedSent;
      params.onAcknowledge?.(outcome.operationId);
      if (!keepsNewer) {
        params.onConfirmed?.();
        setText("");
      }
      params.onNotice?.(t("youtubeStage4.notice.posted", "Posted. Refresh the thread to see it."));
    } else if (outcome.kind === "refused") {
      params.onAcknowledge?.(outcome.operationId);
    } else if (outcome.kind === "error" && outcome.terminal) {
      // The receipt can never be read again and this composer has just said so:
      // the identity would otherwise come back on the next mount. The draft stays.
      params.onAcknowledge?.(outcome.operationId);
    }
  };

  const submit = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setLocalOutcome(null);
    submitSeq.current += 1;
    const submitAtStart = submitSeq.current;
    const isSubmitCurrent = () => mounted.current && submitSeq.current === submitAtStart;
    const submittedText = text;
    const outcome = await params.onSubmit(submittedText, isSubmitCurrent);
    if (!isSubmitCurrent()) return;
    // Only an outcome of THIS submit names the operation it sent. "pending",
    // "earlier" and "cancelled" sent nothing in this invocation.
    if (outcome.kind !== "pending" && outcome.kind !== "earlier" && outcome.kind !== "cancelled") {
      sent.current = { operationId: outcome.operationId, text: submittedText };
    }
    setBusy(false);
    show(outcome);
  };

  const checkStatus = async (operationId: string) => {
    if (!params.onCheckStatus || checking) return;
    setChecking(true);
    const submitAtStart = submitSeq.current;
    checkSeq.current += 1;
    const checkAtStart = checkSeq.current;
    const draft = sent.current?.operationId === operationId ? sent.current.text : undefined;
    const outcome = await params.onCheckStatus(operationId, draft);
    if (mounted.current) setChecking(false);
    if (submitSeq.current !== submitAtStart || checkSeq.current !== checkAtStart) return;
    show(outcome, true);
  };

  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid="yt-stage4-composer">
      <label className="sr-only" htmlFor={inputId}>{params.placeholder}</label>
      <textarea
        id={inputId}
        ref={inputRef}
        className="w-full min-h-[70px] rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring"
        placeholder={params.placeholder}
        value={text}
        onChange={(event) => {
          textRef.current = event.target.value;
          setText(event.target.value);
          params.onTextChange?.(event.target.value);
        }}
        disabled={busy}
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void submit()} disabled={busy || !text.trim()}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : null}
          {params.submitLabel}
        </Button>
        {params.onCancel && (
          <Button size="sm" variant="ghost" onClick={() => {
            submitSeq.current += 1;
            checkSeq.current += 1;
            if (mounted.current) {
              setBusy(false);
              setChecking(false);
            }
            params.onCancel?.();
          }}>
            {t("common:cancel", "Cancel")}
          </Button>
        )}
      </div>
      {localOutcome && (
        <OutcomeLine
          outcome={localOutcome}
          checking={checking}
          onCheckStatus={params.onCheckStatus ? (operationId) => void checkStatus(operationId) : undefined}
        />
      )}
    </div>
  );
}

/** The operation a not-yet-settled outcome belongs to, when a status check can read it. */
function checkableOperationId(outcome: SubmissionOutcome): string | null {
  if (outcome.kind === "indeterminate" || outcome.kind === "error") return outcome.operationId;
  if (outcome.kind === "pending") return outcome.operationId ?? null;
  return null;
}

function OutcomeLine({ outcome, checking, onCheckStatus }: {
  outcome: SubmissionOutcome;
  checking: boolean;
  onCheckStatus?: (operationId: string) => void;
}): JSX.Element {
  const { t } = useTranslation("automation");
  if (outcome.kind === "cancelled") return <></>;
  const operationId = checkableOperationId(outcome);
  // A terminal miss was already acknowledged and its identity forgotten; a check would only replace the final message with a retryable one.
  const checkButton = operationId && onCheckStatus && !(outcome.kind === "error" && outcome.terminal) ? (
    <Button size="sm" variant="outline" disabled={checking} onClick={() => onCheckStatus(operationId)}>
      {checking ? <Loader2 className="h-3.5 w-3.5 animate-spin me-1" /> : null}
      {t("youtubeStage4.recovered.checkStatus", "Check status")}
    </Button>
  ) : null;
  if (outcome.kind === "confirmed") {
    return (
      <p role="status" className="flex items-center gap-2 text-xs text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="h-3.5 w-3.5" /> {t("youtubeStage4.outcome.confirmed", "Accepted by YouTube.")}
      </p>
    );
  }
  if (outcome.kind === "indeterminate") {
    return (
      <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
        <HelpCircle className="h-3.5 w-3.5" />
        {t("youtubeStage4.outcome.indeterminate", "This may or may not have been applied. It was not sent again — refresh the thread to see what is there.")}
        {/* What a status check compared against the draft, apart from the receipt state. */}
        {outcome.observation === "requested_text_observed" && (
          <span data-testid="yt-stage4-observation">{t("youtubeStage4.outcome.observedRequested", "YouTube currently shows the text you asked for.")}</span>
        )}
        {outcome.observation === "different_text_observed" && (
          <span data-testid="yt-stage4-observation">{t("youtubeStage4.outcome.observedDifferent", "YouTube currently shows different text.")}</span>
        )}
        {checkButton}
      </p>
    );
  }
  if (outcome.kind === "pending") {
    return (
      <p role="status" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {t("youtubeStage4.outcome.pending", "An earlier attempt for this comment is still being checked. Reload to see its status.")}
        {checkButton}
      </p>
    );
  }
  if (outcome.kind === "earlier") {
    return (
      <p role="status" className="text-xs text-muted-foreground">
        {outcome.state === "confirmed"
          ? t("youtubeStage4.outcome.earlierConfirmed", "Your earlier action was accepted by YouTube. What you typed now was not sent — submit again to send it.")
          : t("youtubeStage4.outcome.earlierRefused", "Your earlier action was not applied. What you typed now was not sent — submit again to send it.")}
      </p>
    );
  }
  const reason = outcome.reason;
  // A failure with no receipt (the answer was lost) may have been applied: say
  // so and offer a status check, which reads and never resends.
  if (outcome.kind === "error" && !isRebindReason(reason)) {
    return (
      <p role="alert" className="flex flex-wrap items-center gap-2 text-xs text-amber-600 dark:text-amber-400">
        <HelpCircle className="h-3.5 w-3.5" />
        {t("youtubeStage4.outcome.lost", "We did not get YouTube's answer, so this may or may not have been applied. It was not sent again.")}
        {checkButton}
      </p>
    );
  }
  return (
    <p role="alert" className="flex items-center gap-2 text-xs text-destructive">
      <AlertTriangle className="h-3.5 w-3.5" />
      {isRebindReason(reason)
        ? t("youtubeStage4.outcome.rebind", "This action was started before the channel was reconnected, so its result can no longer be checked here. Check the video on YouTube.")
        : reasonText(t, reason)}
      {" "}
      {t("youtubeStage4.outcome.draftKept", "Your draft is kept.")}
    </p>
  );
}

// ---- deleting the channel's own comment ---------------------------------------------

function DeleteOwnDialog(params: {
  stage4: ReturnType<typeof useYouTubeStage4>;
  row: Stage4CommentRow;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNotice: (text: string | null) => void;
}): JSX.Element {
  const { stage4, row, open, onOpenChange, onNotice } = params;
  const { t } = useTranslation("automation");
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    setBusy(true);
    try {
      const outcome = await stage4.deleteOwn(row);
      onNotice(outcome.kind === "deleted"
        ? t("youtubeStage4.notice.deleted", "Deleted. The list was refreshed.")
        : reasonText(t, outcome.reason));
      onOpenChange(false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("youtubeStage4.delete.title", "Delete your comment?")}</DialogTitle>
          <DialogDescription>
            {t("youtubeStage4.delete.body", "This removes your channel's comment from the video. It cannot be undone here.")}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t("common:cancel", "Cancel")}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={() => void confirm()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : null}
            {t("youtubeStage4.delete.confirm", "Delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ---- the reject dialog with the two-step ban ---------------------------------------------

function RejectDialog(params: {
  stage4: ReturnType<typeof useYouTubeStage4>;
  row: Stage4CommentRow;
  videoId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onNotice: (text: string | null) => void;
  isCurrent: () => boolean;
}): JSX.Element | null {
  const { stage4, row, videoId, open, onOpenChange, onNotice, isCurrent } = params;
  const { t } = useTranslation("automation");
  const [alsoBan, setAlsoBan] = useState(false);
  const [step, setStep] = useState<"reject" | "ban">("reject");
  // The confirmation carries the operation id it was issued for: the ban step
  // submits with exactly that pair and with nothing else.
  const [banInfo, setBanInfo] = useState<{ confirmation: string; authorName: string; authorChannelId: string; operationId: string } | null>(null);
  const [banError, setBanError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // One operation id per dialog instance; the server confirmation is bound
  // to it, so cancel-and-retry mints a fresh one through a new submit.
  const operationIdRef = useRef<string>("");
  if (!operationIdRef.current) operationIdRef.current = mintOperationIdDialog();
  // Advances every time the dialog opens or closes, so a confirmation request
  // started in an earlier opening can tell that it is stale when it answers.
  const generationRef = useRef(0);

  useLayoutEffect(() => {
    generationRef.current += 1;
    if (open) {
      setAlsoBan(false);
      setStep("reject");
      setBanInfo(null);
      setBanError(null);
      setBusy(false);
      operationIdRef.current = mintOperationIdDialog();
    }
  }, [open]);

  const changeOpen = (next: boolean) => {
    if (!next) generationRef.current += 1;
    setAlsoBan(false);
    setBanInfo(null);
    setStep("reject");
    onOpenChange(next);
  };

  /** A plain Reject: no ban is requested and none is implied. */
  const confirmPlainReject = async () => {
    const generation = generationRef.current;
    setBusy(true);
    try {
      await runModerate(
        stage4, row, videoId, "rejected", onNotice, t, undefined, undefined,
        () => isCurrent() && generation === generationRef.current,
      );
      // Only the opening that started this request closes: a dialog that was
      // cancelled and reopened meanwhile belongs to the owner's newer work.
      if (generation === generationRef.current) changeOpen(false);
    } finally {
      if (generation === generationRef.current) setBusy(false);
    }
  };

  /**
   * Reject AND ban. It has its own handler and requires the issued
   * confirmation with its operation id: with none, it does nothing. It never
   * falls back to a plain Reject (spec 10.2).
   */
  const confirmRejectAndBan = async () => {
    if (!banInfo) return;
    const generation = generationRef.current;
    setBusy(true);
    try {
      // The server bound the confirmation to this operation key, so the submit
      // must use that same key (a fresh one would be refused).
      await runModerate(
        stage4, row, videoId, "rejected", onNotice, t, banInfo.confirmation, banInfo.operationId,
        () => isCurrent() && generation === generationRef.current,
      );
      if (generation === generationRef.current) changeOpen(false);
    } finally {
      if (generation === generationRef.current) setBusy(false);
    }
  };

  const requestConfirmation = async () => {
    const generation = generationRef.current;
    const operationId = operationIdRef.current;
    setBusy(true);
    setBanError(null);
    try {
      const payload = await stage4.requestBanConfirmation(row, operationId);
      if (generation !== generationRef.current) return;
      setBanInfo({
        confirmation: payload.confirmation,
        authorName: payload.author_name,
        authorChannelId: payload.author_channel_id,
        operationId,
      });
      setStep("ban");
    } catch (error) {
      if (generation !== generationRef.current) return;
      const reason = typeof (error as { code?: string }).code === "string" ? (error as { code: string }).code : "upstream";
      setBanError(reasonText(t, reason));
    } finally {
      if (generation === generationRef.current) setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent>
        {step === "reject" ? (
          <>
            <DialogHeader>
              <DialogTitle>{t("youtubeStage4.reject.title", "Reject this comment?")}</DialogTitle>
              <DialogDescription>
                {t(
                  "youtubeStage4.reject.body",
                  "Rejecting hides this comment and its replies from the video, and a rejected comment cannot be published again through Postora. There is no undo here.",
                )}
              </DialogDescription>
            </DialogHeader>
            {stage4.canBan && (
              <div className="flex items-start gap-2 pt-2">
                <Checkbox
                  id="yt-stage4-ban"
                  checked={alsoBan}
                  disabled={busy}
                  onCheckedChange={(checked) => setAlsoBan(checked === true)}
                />
                <label htmlFor="yt-stage4-ban" className="text-sm leading-relaxed">
                  {t("youtubeStage4.reject.alsoBan", "Also ban this author")}
                </label>
              </div>
            )}
            <DialogFooter>
              <Button variant="ghost" onClick={() => changeOpen(false)}>
                {t("common:cancel", "Cancel")}
              </Button>
              <Button
                variant="destructive"
                disabled={busy}
                onClick={() => (alsoBan ? void requestConfirmation() : void confirmPlainReject())}
              >
                {busy ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : null}
                {alsoBan
                  ? t("youtubeStage4.reject.continueBan", "Continue")
                  : t("youtubeStage4.reject.confirm", "Reject")}
              </Button>
            </DialogFooter>
            {banError && <p role="alert" className="text-xs text-destructive">{banError}</p>}
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>{t("youtubeStage4.ban.title", "Also ban this author?")}</DialogTitle>
              <DialogDescription>
                {t(
                  "youtubeStage4.ban.body",
                  "Postora will ask YouTube to automatically reject additional comments written by {{name}} ({{channel}}). Postora cannot show whether an author is banned, and cannot reverse it; it is managed in YouTube. If the reject is accepted but you lose this screen, both effects stay unknown together.",
                  { name: banInfo?.authorName ?? "", channel: banInfo?.authorChannelId ?? "" },
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="ghost" onClick={() => {
                generationRef.current += 1;
                setAlsoBan(false);
                setBanInfo(null);
                setStep("reject");
              }}>
                {t("common:back", "Back")}
              </Button>
              <Button variant="destructive" disabled={busy || !banInfo} onClick={() => void confirmRejectAndBan()}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin me-1" /> : null}
                {t("youtubeStage4.ban.confirm", "Reject and ban")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** Mint a fresh operation id for a dialog confirmation. */
function mintOperationIdDialog(): string {
  const c = globalThis.crypto;
  return c && typeof c.randomUUID === "function"
    ? c.randomUUID()
    : `op-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

// ---- the standalone recovery surface ---------------------------------------------
//
// Mounted by the LEGACY inbox when capabilities are off or the channel is
// Composio: receipt status stays reachable with every capability off (spec
// 7.4), so an owner still learns the outcome of a pending send. It performs
// no list read, no provider read and offers no resend.

export interface Stage4RecoveredOperationsProps {
  userId: string;
  accountId: string;
  gateway?: YouTubeCommentsGateway;
}

export function Stage4RecoveredOperations(props: Stage4RecoveredOperationsProps): JSX.Element | null {
  const { recovered, clear, recheck } = useStage4Recovery({
    userId: props.userId,
    accountId: props.accountId,
    enabled: !!props.userId && !!props.accountId,
    gateway: props.gateway ?? defaultYouTubeCommentsGateway,
  });
  if (recovered.length === 0) return null;
  return (
    <RecoveredBannerList
      testId="yt-stage4-recovered-standalone"
      entries={recovered}
      onDismiss={clear}
      onRecheck={(operationId) => void recheck(operationId)}
    />
  );
}
