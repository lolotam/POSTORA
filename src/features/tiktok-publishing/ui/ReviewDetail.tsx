import { useState } from "react";
import { useTranslation } from "react-i18next";
import { MediaLibraryPicker } from "@/components/post/MediaLibraryPicker";
import { TikTokVideoPreview } from "@/components/post/TikTokVideoPreview";
import type { UploadedFile } from "@/hooks/usePostForm";
import type { CreatorInfo, MediaPreview, PublishStatus, ReviewDraft, TikTokAccount } from "../domain/types";
import { musicConsentText, privacyLabel } from "../domain/reviewRules";
import { formatInZone } from "../domain/scheduleRules";
import { captionTitle, describeError } from "./reviewCopy";
import { PublishControls, type ConfirmDialog } from "./PublishControls";
import type { ShortcutName } from "../domain/scheduleRules";
import type { ReactNode } from "react";

const CAPTION_LIMIT = 2200;

export type DetailScreen =
  | { kind: "none" }
  | { kind: "loading" }
  | { kind: "error"; message: string; onRetry: () => void }
  | { kind: "conflict" }
  | { kind: "ready"; draft: ReviewDraft };

interface ReviewDetailProps {
  screen: DetailScreen;
  onReloadConflict: () => void;
  narrow: boolean;
  onBack: () => void;
  account: TikTokAccount | null;
  creator: CreatorInfo | null;
  preview: MediaPreview | null;
  previewError: string | null;
  onRetryPreview: () => void;
  editing: boolean;
  captionDraft: string;
  onCaptionDraft: (value: string) => void;
  onStartEdit: () => void;
  onCancelEdit: () => void;
  onSaveCaption: () => void;
  saving: boolean;
  mediaNotice: string | null;
  onPickMedia: (file: UploadedFile) => void;
  onRemoveMedia: () => void;
  blockerMessage: string | null;
  scheduleLabel: string;
  timeZone: string;
  scheduleLocal: string;
  scheduleNote: string | null;
  onScheduleLocal: (value: string) => void;
  onNow: () => void;
  onShortcut: (name: ShortcutName) => void;
  approveReason: string | null;
  scheduleReason: string | null;
  canReject: boolean;
  canEdit: boolean;
  canArchive: boolean;
  canRestore: boolean;
  settings: ReactNode;
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  onArchive: () => void;
  onRestore: () => void;
  onReject: (reason: string) => void;
  rejectPending: boolean;
  confirm: ConfirmDialog | null;
  onOpenConfirm: (mode: "now" | "scheduled") => void;
  onCloseConfirm: () => void;
  onConfirm: () => void;
  confirmPending: boolean;
  confirmError: string | null;
  rejectOpen: boolean;
  onRejectOpenChange: (open: boolean) => void;
  publish: {
    status: PublishStatus | null;
    error: unknown;
    timedOut: boolean;
    refresh: () => void;
    immediate: "queued" | "scheduled" | null;
    scheduledFor: string | null;
  } | null;
}

export function ReviewDetail(props: ReviewDetailProps) {
  const { t } = useTranslation("post");
  const { screen } = props;
  if (screen.kind === "none") {
    return (
      <section className="tiktok-review-detail">
        <p>{t("tiktokReview.selectPrompt", "Select a post to review it.")}</p>
      </section>
    );
  }
  if (screen.kind === "loading") {
    return <section className="tiktok-review-detail" role="status">{t("tiktokReview.loadingPost", "Loading post…")}</section>;
  }
  if (screen.kind === "error") {
    return (
      <section className="tiktok-review-detail" role="alert">
        <p className="tiktok-review-alert">{screen.message}</p>
        <button type="button" className="tiktok-review-button tiktok-review-button-edit" onClick={screen.onRetry}>
          {t("tiktokReview.retry", "Retry")}
        </button>
      </section>
    );
  }
  if (screen.kind === "conflict") {
    return (
      <section className="tiktok-review-detail" role="alert">
        <p className="tiktok-review-alert">
          {t("tiktokReview.revisionConflict", "This post changed elsewhere — reload")}
        </p>
        <button type="button" className="tiktok-review-button tiktok-review-button-edit" onClick={props.onReloadConflict}>
          {t("tiktokReview.reload", "Reload")}
        </button>
      </section>
    );
  }
  return <ReadyDetail {...props} draft={screen.draft} />;
}

function ReadyDetail({ draft, ...props }: ReviewDetailProps & { draft: ReviewDraft }) {
  const { t } = useTranslation("post");
  const [pickerOpen, setPickerOpen] = useState(false);
  const nickname = props.creator?.nickname || props.account?.username || t("tiktokReview.unknownNickname", "TikTok");
  const username = props.creator?.username || props.account?.username || "";
  const audience = draft.settings.privacy
    ? t(`tiktokReview.privacy.${draft.settings.privacy}`, privacyLabel(draft.settings.privacy))
    : t("tiktokReview.audienceMissing", "No audience");
  const comments = draft.settings.allowComment
    ? t("tiktokReview.commentsOn", "Comments on")
    : t("tiktokReview.commentsOff", "Comments off");
  const summary: string[] = [
    t("tiktokReview.summaryAccount", "Account: @{{username}}", { username }),
    t("tiktokReview.summaryAudience", "Audience: {{audience}}", { audience }),
    t("tiktokReview.summaryComments", "Comments: {{value}}", { value: draft.settings.allowComment ? t("tiktokReview.on", "on") : t("tiktokReview.off", "off") }),
    t("tiktokReview.summaryDuet", "Duet: {{value}}", { value: draft.settings.allowDuet ? t("tiktokReview.on", "on") : t("tiktokReview.off", "off") }),
    t("tiktokReview.summaryStitch", "Stitch: {{value}}", { value: draft.settings.allowStitch ? t("tiktokReview.on", "on") : t("tiktokReview.off", "off") }),
    t("tiktokReview.summaryDisclose", "Disclosure: {{value}}", { value: draft.settings.disclose ? t("tiktokReview.on", "on") : t("tiktokReview.off", "off") }),
    t("tiktokReview.summaryYourBrand", "Your brand: {{value}}", { value: draft.settings.yourBrand ? t("tiktokReview.on", "on") : t("tiktokReview.off", "off") }),
    t("tiktokReview.summaryBranded", "Branded content: {{value}}", { value: draft.settings.brandedContent ? t("tiktokReview.on", "on") : t("tiktokReview.off", "off") }),
    t("tiktokReview.summaryAi", "AI-generated: {{value}}", { value: draft.settings.aiGenerated ? t("tiktokReview.on", "on") : t("tiktokReview.off", "off") }),
    props.confirm?.mode === "scheduled"
      ? t("tiktokReview.summaryWhen", "When: {{when}}", { when: props.scheduleLabel })
      : t("tiktokReview.summaryNow", "When: Now"),
  ];

  return (
    <section className="tiktok-review-detail" aria-label={t("tiktokReview.detailLabel", "Post review")}>
      {props.narrow ? (
        <button type="button" className="tiktok-review-button tiktok-review-button-edit" onClick={props.onBack}>
          {t("tiktokReview.back", "Back to posts")}
        </button>
      ) : null}
      <h2 className="tiktok-review-title">
        {captionTitle(draft.caption, t("tiktokReview.untitled", "Untitled post"))}
      </h2>
      <StatusBadge state={draft.state} />
      {draft.rejectionReason ? <p className="tiktok-review-alert">{draft.rejectionReason}</p> : null}
      {props.preview && props.preview.fileType === "video" ? (
        <TikTokVideoPreview
          caption={draft.caption}
          mediaFile={{ previewUrl: props.preview.previewUrl, fileType: "video" }}
          username={username}
          avatarUrl={props.creator?.avatarUrl ?? props.account?.avatarUrl ?? undefined}
        />
      ) : (
        <p className="tiktok-review-muted">{t("tiktokReview.noPreview", "No video attached.")}</p>
      )}
      {props.previewError ? (
        <div role="alert">
          <p className="tiktok-review-alert">{props.previewError}</p>
          <button type="button" className="tiktok-review-button tiktok-review-button-edit" onClick={props.onRetryPreview}>
            {t("tiktokReview.retry", "Retry")}
          </button>
        </div>
      ) : null}
      <div className="tiktok-review-actions">
        <button type="button" className="tiktok-review-pill" onClick={() => setPickerOpen(true)} disabled={!props.canEdit}>
          {t("tiktokReview.changeVideo", "Change video")}
        </button>
        <button type="button" className="tiktok-review-pill" onClick={props.onRemoveMedia} disabled={!props.canEdit || !draft.mediaFileId}>
          {t("tiktokReview.removeVideo", "Remove video")}
        </button>
      </div>
      {props.mediaNotice ? <p className="tiktok-review-alert" role="alert">{props.mediaNotice}</p> : null}
      <dl className="tiktok-review-summary">
        <div>
          <dt>{t("tiktokReview.summaryScheduled", "Scheduled")}</dt>
          <dd>{props.scheduleLabel}</dd>
        </div>
        <div>
          <dt>{t("tiktokReview.summaryType", "Type")}</dt>
          <dd>{t("tiktokReview.typePost", "Post")}</dd>
        </div>
        <div>
          <dt>{t("tiktokReview.summaryLength", "Length")}</dt>
          <dd>{t("tiktokReview.charCount", "{{count}} chars", { count: draft.caption.length })}</dd>
        </div>
        <div>
          <dt>{t("tiktokReview.summaryTikTok", "TikTok")}</dt>
          <dd>{`${audience} · ${t("tiktokReview.video", "Video")} · ${comments}`}</dd>
        </div>
      </dl>
      {props.editing ? (
        <div>
          <p className="tiktok-review-eyebrow">{t("tiktokReview.editContent", "Edit content")}</p>
          <label>
            <span className="tiktok-review-eyebrow">{t("tiktokReview.postText", "Post text")}</span>
            <textarea
              className="tiktok-review-textarea"
              value={props.captionDraft}
              onChange={(event) => props.onCaptionDraft(event.target.value)}
            />
          </label>
          <p className="tiktok-review-counter">{`${props.captionDraft.length} / ${CAPTION_LIMIT}`}</p>
          <div className="tiktok-review-actions">
            <button type="button" className="tiktok-review-button tiktok-review-button-archive" onClick={props.onCancelEdit}>
              {t("tiktokReview.cancel", "Cancel")}
            </button>
            <button type="button" className="tiktok-review-button tiktok-review-button-schedule" disabled={props.saving} onClick={props.onSaveCaption}>
              {t("tiktokReview.save", "Save")}
            </button>
          </div>
        </div>
      ) : null}
      <p>{t("tiktokReview.destination", "TikTok: {{nickname}}", { nickname })}</p>
      {props.blockerMessage ? <p className="tiktok-review-alert" role="status">{props.blockerMessage}</p> : null}
      <p className="tiktok-review-notice">
        {t(
          draft.settings.disclose && draft.settings.brandedContent
            ? "tiktokReview.musicBranded"
            : "tiktokReview.music",
          musicConsentText(draft.settings),
        )}
      </p>
      <p className="tiktok-review-notice">
        {t("tiktokReview.processingNotice", "After publishing, TikTok may take a few minutes to process your post and show it on your profile.")}
      </p>
      <PublishControls
        timeZone={props.timeZone}
        scheduleLocal={props.scheduleLocal}
        scheduleNote={props.scheduleNote}
        onScheduleLocal={props.onScheduleLocal}
        onNow={props.onNow}
        onShortcut={props.onShortcut}
        destination={t("tiktokReview.publishesTo", "Publishes to @{{username}} · TikTok", { username })}
        approveReason={props.approveReason}
        scheduleReason={props.scheduleReason}
        canReject={props.canReject}
        canEdit={props.canEdit}
        canArchive={props.canArchive}
        canRestore={props.canRestore}
        settings={props.settings}
        settingsOpen={props.settingsOpen}
        onSettingsOpenChange={props.onSettingsOpenChange}
        onEdit={props.onStartEdit}
        onArchive={props.onArchive}
        onRestore={props.onRestore}
        onReject={props.onReject}
        rejectPending={props.rejectPending}
        confirm={props.confirm}
        onOpenConfirm={props.onOpenConfirm}
        onCloseConfirm={props.onCloseConfirm}
        confirmSummary={summary}
        onConfirm={props.onConfirm}
        confirmPending={props.confirmPending}
        confirmError={props.confirmError}
        rejectOpen={props.rejectOpen}
        onRejectOpenChange={props.onRejectOpenChange}
      />
      {props.publish ? <PublishOutcome publish={props.publish} timeZone={props.timeZone} /> : null}
      <MediaLibraryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        maxFiles={1}
        onSelect={(files) => {
          const file = files[0];
          if (!file) return;
          props.onPickMedia(file);
          setPickerOpen(false);
        }}
      />
    </section>
  );
}

function StatusBadge({ state }: { state: ReviewDraft["state"] }) {
  const { t } = useTranslation("post");
  if (state === "pending_review") {
    return <p className="tiktok-review-badge">{t("tiktokReview.awaiting", "Awaiting review")}</p>;
  }
  if (state === "rejected") return <p className="tiktok-review-chip tiktok-review-chip-rejected">{t("tiktokReview.state.rejected", "Rejected")}</p>;
  if (state === "archived") return <p className="tiktok-review-chip">{t("tiktokReview.state.archived", "Archived")}</p>;
  return <p className="tiktok-review-chip">{t("tiktokReview.state.submitted", "Submitted")}</p>;
}

function PublishOutcome({
  publish,
  timeZone,
}: {
  publish: NonNullable<ReviewDetailProps["publish"]>;
  timeZone: string;
}) {
  const { t } = useTranslation("post");
  const state = publish.status?.state ?? publish.immediate;
  let body = t("tiktokReview.statusWaiting", "Checking publish status…");
  if (state === "scheduled") {
    const when = publish.scheduledFor ? formatInZone(publish.scheduledFor, timeZone) : "";
    body = when
      ? t("tiktokReview.statusScheduledAt", "Scheduled for {{when}}.", { when })
      : t("tiktokReview.statusScheduled", "Scheduled.");
  } else if (state === "queued") {
    body = t("tiktokReview.statusQueued", "Queued.");
  } else if (state === "processing") {
    body = t("tiktokReview.statusProcessing", "TikTok is processing your video. This can take a few minutes.");
  } else if (state === "published") {
    body = t("tiktokReview.statusPublished", "Published.");
  } else if (state === "failed") {
    body = publish.status?.reason || t("tiktokReview.statusFailed", "Publishing failed.");
  } else if (state === "needs_attention") {
    body = publish.status?.reason || t("tiktokReview.statusAttention", "This post needs attention.");
  }
  return (
    <div className="tiktok-review-status" role="status">
      <p className="tiktok-review-eyebrow">{t("tiktokReview.outcome", "Outcome")}</p>
      <p>{body}</p>
      {state === "needs_attention" ? (
        <p className="tiktok-review-notice">
          {t("tiktokReview.attentionGuidance", "TikTok did not accept this post as-is. Refresh after you have reviewed the reason. A new send needs a new confirmation.")}
        </p>
      ) : null}
      {publish.status?.state === "published" && publish.status.postUrl ? (
        <p><a href={publish.status.postUrl}>{t("tiktokReview.viewPost", "View post")}</a></p>
      ) : null}
      {publish.error ? <p className="tiktok-review-alert" role="alert">{describeError(t, publish.error)}</p> : null}
      {publish.timedOut ? (
        <p role="status">{t("tiktokReview.statusTimedOut", "Status updates paused after 10 minutes. Refresh to check again.")}</p>
      ) : null}
      <button type="button" className="tiktok-review-button tiktok-review-button-edit" onClick={publish.refresh}>
        {t("tiktokReview.refresh", "Refresh")}
      </button>
    </div>
  );
}
