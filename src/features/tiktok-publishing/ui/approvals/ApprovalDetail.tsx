import { useId, useState } from "react";
import {
  Archive,
  ArchiveRestore,
  Download,
  ExternalLink,
  Pencil,
  Plus,
  RefreshCw,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { MediaLibraryPicker } from "@/components/post/MediaLibraryPicker";
import { draftStatus, hashtagsToAppend, tiktokSummary } from "../../domain/approvals";
import { CAPTION_MAX } from "../../domain/reviewRules";
import { formatInZone } from "../../domain/scheduleRules";
import type { ReviewDraft, TikTokAccount } from "../../domain/types";
import { captionTitle, describeError } from "../reviewCopy";
import type { DraftReview } from "../useDraftReview";
import { TikTokGlyph } from "../shell/TikTokGlyph";
import { ConfirmDialog, PublishPanel } from "./ApprovalPublishPanel";

interface ApprovalDetailProps {
  review: DraftReview;
  account: TikTokAccount | null;
  onBack: () => void;
}

export function ApprovalDetail({ review, account, onBack }: ApprovalDetailProps) {
  const { detail } = review;
  if (detail.kind === "none") {
    return <section className="rs-card ap-detail"><p className="ap-empty">Select a post to review it.</p></section>;
  }
  if (detail.kind === "loading") {
    return (
      <section className="rs-card ap-detail p-6" role="status" aria-label="Loading post">
        <div className="rs-skeleton h-5 w-2/3" />
        <div className="rs-skeleton mt-3 h-3 w-1/3" />
        <div className="rs-skeleton mt-6 h-64 w-full" />
      </section>
    );
  }
  if (detail.kind === "error" || detail.kind === "conflict") {
    const message = detail.kind === "error" ? detail.message : "This post changed elsewhere — reload";
    return (
      <section className="rs-card ap-detail p-6" role="alert">
        <p className="ap-alert mb-3">{message}</p>
        <button
          type="button"
          className="rs-btn rs-btn-cream rs-btn-sm"
          onClick={detail.kind === "error" ? detail.onRetry : review.reloadConflict}
        >
          {detail.kind === "error" ? "Retry" : "Reload"}
        </button>
      </section>
    );
  }
  return <ReadyDetail key={detail.draft.id} review={review} draft={detail.draft} account={account} onBack={onBack} />;
}

function ReadyDetail({ review, draft, account, onBack }: ApprovalDetailProps & { draft: ReviewDraft }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const publishState = review.publish.status?.state ?? review.liveSubmission?.state ?? null;
  const status = draftStatus(draft.state, draft.state === "submitted" ? publishState : null);
  const title = captionTitle(draft.caption, "Untitled post");
  const username = review.creator?.username || account?.username || "";
  const displayName = review.creator?.nickname || account?.username || "TikTok";
  const avatarUrl = review.creator?.avatarUrl ?? account?.avatarUrl ?? null;
  const pending = draft.state === "pending_review";
  const scheduledFor = review.submissionScheduledAt;

  return (
    <article className="rs-card ap-detail" aria-label={`Approval detail: ${title}`}>
      <header className="ap-detail-head">
        <button type="button" className="rs-btn rs-btn-ghost rs-btn-sm min-[1101px]:hidden" onClick={onBack}>
          ← Back
        </button>
        <span className="rs-tile !h-7 !w-7"><TikTokGlyph className="h-3.5 w-3.5" /></span>
        <div className="min-w-0 flex-1">
          <h2 className="ap-detail-title truncate">{title}</h2>
          <div className="ap-meta">
            Post · TikTok{scheduledFor ? ` · Scheduled ${formatInZone(scheduledFor, review.timeZone)}` : ""}
          </div>
        </div>
        <span className="ap-tag" data-tone={status.tone}>{status.tag}</span>
      </header>

      {review.actionError ? <div className="ap-banner" data-tone="tomato" role="alert">{review.actionError}</div> : null}
      {draft.state === "rejected" && draft.rejectionReason ? (
        <div className="ap-banner" data-tone="tomato">
          <span><strong>Rejected:</strong> {draft.rejectionReason}</span>
          <span className="text-[12px]">Edit the post to send it back to review.</span>
        </div>
      ) : null}

      {review.showPublish ? <PublishOutcome review={review} /> : null}

      {review.editing ? (
        <EditContent review={review} draft={draft} onChangeVideo={() => setPickerOpen(true)} />
      ) : (
        <section className="ap-section">
          <div className="ap-section-head">
            <span className="ap-section-title">Post preview</span>
            {review.can.edit ? (
              <button type="button" className="rs-btn rs-btn-ghost rs-btn-sm" onClick={review.startEdit}>
                <Pencil /> Edit caption
              </button>
            ) : null}
          </div>
          <div className="ap-preview">
            <div className="ap-preview-head">
              <span className="ap-preview-avatar">
                {avatarUrl ? <img src={avatarUrl} alt="" /> : displayName.charAt(0).toUpperCase()}
              </span>
              <div className="min-w-0">
                <div className="truncate text-[14px] font-semibold">{displayName}</div>
                <div className="ap-meta !mt-0">
                  {scheduledFor ? formatInZone(scheduledFor, review.timeZone) : username ? `@${username}` : "TikTok"}
                </div>
              </div>
            </div>
            {draft.caption ? <p className="ap-caption">{draft.caption}</p> : <p className="ap-caption text-[color:var(--rs-ink-mute)]">No caption yet.</p>}
            <MediaBlock review={review} draft={draft} onChange={() => setPickerOpen(true)} />
          </div>
          {review.mediaNotice ? <p className="ap-alert text-center" role="alert">{review.mediaNotice}</p> : null}
        </section>
      )}

      <section className="ap-section">
        <dl className="ap-facts">
          {scheduledFor ? <Fact label="Scheduled" value={formatInZone(scheduledFor, review.timeZone)} /> : null}
          <Fact label="Type" value="Post" />
          <Fact label="Length" value={`${draft.caption.length} chars`} />
          <Fact label="TikTok" value={tiktokSummary(draft.settings)} />
          <Fact label="Account" value={username ? `@${username}` : "—"} />
        </dl>
        {draft.state === "archived" ? (
          <button type="button" className="rs-btn rs-btn-cream rs-btn-sm rs-btn-square mt-4" onClick={review.restore}>
            <ArchiveRestore /> Restore to pending
          </button>
        ) : null}
      </section>

      {pending && rejecting ? (
        <RejectPanel
          pending={review.commands.rejectDraft.isPending}
          onCancel={() => setRejecting(false)}
          onConfirm={(reason) => review.reject(reason)}
        />
      ) : null}

      {pending && !rejecting ? (
        <PublishPanel review={review} draft={draft} account={account} onReject={() => setRejecting(true)} />
      ) : null}

      {draft.state === "rejected" ? (
        <div className="ap-footer">
          <div className="ap-footer-group">
            <button type="button" className="rs-btn rs-btn-cream" onClick={review.startEdit} disabled={!review.can.edit}>
              <Pencil /> Edit
            </button>
            <button type="button" className="rs-btn rs-btn-outline" onClick={review.archive} disabled={!review.can.archive}>
              <Archive /> Archive
            </button>
          </div>
        </div>
      ) : null}

      <ConfirmDialog review={review} draft={draft} username={username} />
      <MediaLibraryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        maxFiles={1}
        onSelect={(files) => {
          const file = files[0];
          if (!file) return;
          void review.pickMedia(file);
          setPickerOpen(false);
        }}
      />
    </article>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function MediaBlock({ review, draft, onChange }: { review: DraftReview; draft: ReviewDraft; onChange: () => void }) {
  const editable = review.can.edit;
  if (!draft.mediaFileId) {
    return (
      <button type="button" className="ap-media-empty w-full" onClick={onChange} disabled={!editable}>
        <Plus className="h-5 w-5" />
        Add video
      </button>
    );
  }
  const preview = review.preview;
  return (
    <>
      {preview.kind === "loading" ? (
        <div className="rs-skeleton h-64 w-full" role="status" aria-label="Loading video preview" />
      ) : preview.kind === "ready" && preview.media.fileType === "video" ? (
        <div className="ap-media">
          <video src={preview.media.previewUrl} controls playsInline aria-label="Post video" />
          <a className="ap-media-download" href={preview.media.previewUrl} download aria-label="Download Post video" target="_blank" rel="noreferrer">
            <Download className="h-4 w-4" />
          </a>
        </div>
      ) : (
        <div role="alert" className="ap-media-empty">
          <span>{preview.kind === "error" ? preview.message : "That video could not be loaded."}</span>
          <button type="button" className="rs-btn rs-btn-cream rs-btn-sm" onClick={review.retryPreview}>Retry</button>
        </div>
      )}
      {editable ? (
        <div className="ap-media-actions">
          <button type="button" className="rs-btn rs-btn-ghost rs-btn-sm" onClick={() => { void review.removeMedia(); }}>
            <Trash2 /> Remove video
          </button>
          <button type="button" className="rs-btn rs-btn-outline rs-btn-sm" onClick={onChange}>Change</button>
        </div>
      ) : null}
    </>
  );
}

function EditContent({ review, draft, onChangeVideo }: { review: DraftReview; draft: ReviewDraft; onChangeVideo: () => void }) {
  const [hashtags, setHashtags] = useState("");
  const textId = useId();
  const tagsId = useId();
  const toAppend = hashtagsToAppend(hashtags, review.captionDraft);
  const over = review.captionDraft.length > CAPTION_MAX;

  return (
    <section className="ap-section">
      <div className="rs-label mb-3">Edit content</div>
      <div className="flex items-center justify-between">
        <label className="rs-label !text-[color:var(--rs-ink)]" htmlFor={textId}>Post text</label>
        <span className="rs-label" data-over={over} style={over ? { color: "var(--rs-tomato)" } : undefined}>
          {review.captionDraft.length} / {CAPTION_MAX} chars
        </span>
      </div>
      <textarea
        id={textId}
        className="ap-textarea mt-2 !min-h-[160px]"
        value={review.captionDraft}
        onChange={(event) => review.setCaptionDraft(event.target.value)}
      />

      <label className="rs-label mt-4 block !text-[color:var(--rs-ink)]" htmlFor={tagsId}>Hashtags</label>
      <div className="mt-2 flex gap-2">
        <input
          id={tagsId}
          className="ap-input !h-10"
          placeholder="brand, launch, story"
          value={hashtags}
          onChange={(event) => setHashtags(event.target.value)}
        />
        <button
          type="button"
          className="rs-btn rs-btn-cream"
          disabled={!toAppend}
          onClick={() => {
            const base = review.captionDraft.trimEnd();
            review.setCaptionDraft(base ? `${base} ${toAppend}` : toAppend);
            setHashtags("");
          }}
        >
          Add
        </button>
      </div>

      <div className="rs-label mt-4 !text-[color:var(--rs-ink)]">Video</div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <button type="button" className="rs-btn rs-btn-outline rs-btn-sm" onClick={onChangeVideo}>
          {draft.mediaFileId ? "Change video" : "Choose video"}
        </button>
        {draft.mediaFileId ? (
          <button type="button" className="rs-btn rs-btn-ghost rs-btn-sm" onClick={() => { void review.removeMedia(); }}>
            <X /> Remove video
          </button>
        ) : null}
      </div>
      <p className="ap-hint">
        Up to 200 MB. MP4, MOV or WebM. TikTok: 23–60 fps, 360–4096 px on each side, up to 10 minutes.
      </p>

      <div className="mt-5 flex justify-end gap-2">
        <button type="button" className="rs-btn rs-btn-ghost" onClick={review.cancelEdit}>Cancel</button>
        <button
          type="button"
          className="rs-btn rs-btn-mint rs-btn-square"
          disabled={review.commands.saveDraft.isPending || over}
          onClick={() => { void review.saveCaption(); }}
        >
          Save changes
        </button>
      </div>
    </section>
  );
}

function RejectPanel({ pending, onCancel, onConfirm }: { pending: boolean; onCancel: () => void; onConfirm: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  const id = useId();
  return (
    <section className="ap-publish">
      <label className="rs-label block" htmlFor={id}>Reason (required)</label>
      <textarea
        id={id}
        className="ap-textarea mt-2"
        placeholder="e.g., wrong tone, already said something similar, not now…"
        value={reason}
        autoFocus
        onChange={(event) => setReason(event.target.value)}
      />
      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="rs-btn rs-btn-ghost" onClick={onCancel}>Cancel</button>
        <button
          type="button"
          className="rs-btn rs-btn-tomato rs-btn-square"
          disabled={pending || reason.trim().length === 0}
          onClick={() => onConfirm(reason.trim())}
        >
          Confirm reject
        </button>
      </div>
    </section>
  );
}

function PublishOutcome({ review }: { review: DraftReview }) {
  const { publish } = review;
  const state = publish.status?.state ?? review.liveSubmission?.state ?? (review.draft?.submission?.mode === "scheduled" ? "scheduled" : "queued");
  let body = "Checking publish status…";
  if (state === "scheduled") {
    body = review.submissionScheduledAt
      ? `Approved. Scheduled for ${formatInZone(review.submissionScheduledAt, review.timeZone)}.`
      : "Approved and scheduled.";
  } else if (state === "queued") body = "Approved. Sending to TikTok…";
  else if (state === "processing") body = "TikTok is processing your video. This can take a few minutes.";
  else if (state === "published") body = "Published on TikTok.";
  else if (state === "failed") body = publish.status?.reason || "Publishing failed.";
  else if (state === "needs_attention") body = publish.status?.reason || "This post needs attention. Check TikTok before trying again.";
  const failed = state === "failed" || state === "needs_attention";

  return (
    <div className="ap-banner" data-tone={failed ? "tomato" : undefined} role="status">
      <span>
        {body}
        {publish.timedOut ? " Status updates paused after 10 minutes." : ""}
        {failed && !review.canReopen
          ? " TikTok hasn't confirmed this attempt failed, so the video may still go live. Check TikTok. To post it again, start a new draft."
          : ""}
        {publish.error ? ` ${describeError(review.translate, publish.error)}` : ""}
      </span>
      <span className="flex flex-wrap gap-2">
        {publish.status?.state === "published" && publish.status.postUrl ? (
          <a className="rs-btn rs-btn-ink rs-btn-sm" href={publish.status.postUrl} target="_blank" rel="noreferrer">
            <ExternalLink /> View on TikTok
          </a>
        ) : null}
        <button type="button" className="rs-btn rs-btn-cream rs-btn-sm" onClick={publish.refresh}>
          <RefreshCw /> Refresh
        </button>
        {review.canReopen ? (
          <button
            type="button"
            className="rs-btn rs-btn-outline rs-btn-sm"
            disabled={review.commands.reopenDraft.isPending}
            onClick={() => { void review.reopen(); }}
          >
            <RotateCcw /> Back to pending
          </button>
        ) : null}
      </span>
    </div>
  );
}
