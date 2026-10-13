import { useId } from "react";
import { Archive, CalendarClock, Check, MoreHorizontal, Pencil, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { settingsNeedAttention } from "../../domain/approvals";
import { musicConsentText, privacyLabel } from "../../domain/reviewRules";
import type { ReviewDraft, TikTokAccount } from "../../domain/types";
import type { DraftReview } from "../useDraftReview";
import { TikTokSettingsForm } from "./TikTokSettingsForm";

const MUSIC_URL = "https://www.tiktok.com/legal/page/global/music-usage-confirmation/en";
const BRANDED_URL = "https://www.tiktok.com/legal/page/global/bc-policy/en";

/** Publish from / Publish at, the TikTok consent notices, the action footer and the confirm dialog. */
export function PublishPanel({
  review,
  draft,
  account,
  onReject,
}: {
  review: DraftReview;
  draft: ReviewDraft;
  account: TikTokAccount | null;
  onReject: () => void;
}) {
  const { schedule } = review;
  const attention = settingsNeedAttention(review.approveBlockers);
  const reason = review.approveReason ?? review.scheduleReason;
  const reasonId = useId();
  const branded = draft.settings.disclose && draft.settings.brandedContent;

  return (
    <>
      <section className="ap-publish">
        <p className="ap-helper">
          This post publishes to the TikTok account below. Confirm its TikTok settings, then approve or schedule it.
        </p>
        <div className="ap-publish-grid">
          <div>
            <span className="ap-field-label">Publish from</span>
            <Select value={draft.accountId} disabled>
              <SelectTrigger className="h-12 rounded-[10px]" aria-label="Publish from">
                <SelectValue placeholder="Choose an account…" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={draft.accountId}>
                  <span className="flex items-center gap-2">
                    <span className="ap-preview-avatar !h-6 !w-6 text-[10px]">
                      {account?.avatarUrl ? <img src={account.avatarUrl} alt="" /> : (account?.username ?? "T").charAt(0).toUpperCase()}
                    </span>
                    <span className="font-semibold">{review.creator?.nickname || account?.username || "TikTok"}</span>
                    <span className="text-[10px] text-[color:var(--rs-ink-mute)]">TikTok</span>
                  </span>
                </SelectItem>
              </SelectContent>
            </Select>
            {review.creator?.postingBlocked ? (
              <p className="ap-alert" role="alert">
                {review.creator.postingBlockedReason || "TikTok is not allowing posts from this account right now."}
              </p>
            ) : null}
          </div>
          <div>
            <label className="ap-field-label" htmlFor={`${reasonId}-at`}>Publish at</label>
            <input
              id={`${reasonId}-at`}
              className="ap-input"
              type="datetime-local"
              value={schedule.scheduleLocal}
              onChange={(event) => schedule.onScheduleLocal(event.target.value)}
            />
            <div className="ap-presets">
              <button type="button" className="rs-btn rs-btn-cream rs-btn-sm" onClick={schedule.onNow}>Now</button>
              <button type="button" className="rs-btn rs-btn-cream rs-btn-sm" onClick={() => schedule.onShortcut("in_1_hour")}>In 1 hour</button>
              <button type="button" className="rs-btn rs-btn-cream rs-btn-sm" onClick={() => schedule.onShortcut("tomorrow_9")}>Tomorrow 9:00</button>
            </div>
            <p className="ap-hint">
              {schedule.mode === "scheduled" ? `Time zone: ${review.timeZone}` : "Choose a time to schedule."}
            </p>
            {schedule.scheduleNote ? <p className="ap-alert" role="status">{schedule.scheduleNote}</p> : null}
          </div>
        </div>
        <p className="ap-notice">
          {branded ? (
            <>By posting, you agree to TikTok's <a href={BRANDED_URL} target="_blank" rel="noreferrer">Branded Content Policy</a> and <a href={MUSIC_URL} target="_blank" rel="noreferrer">Music Usage Confirmation</a>.</>
          ) : (
            <>By posting, you agree to TikTok's <a href={MUSIC_URL} target="_blank" rel="noreferrer">Music Usage Confirmation</a>.</>
          )}
        </p>
        <p className="ap-notice">
          After publishing, TikTok may take a few minutes to process your post and show it on your profile.
        </p>
      </section>

      <div className="ap-footer">
        <div className="ap-footer-group">
          <button
            type="button"
            className="rs-btn rs-btn-tomato-outline"
            title="Reject & tell why"
            aria-label="Reject & tell why"
            disabled={!review.can.reject}
            onClick={onReject}
          >
            <X /> Reject
          </button>
          <button type="button" className="rs-btn rs-btn-cream" aria-label="Edit inline" disabled={!review.can.edit} onClick={review.startEdit}>
            <Pencil /> Edit
          </button>
          <button type="button" className="rs-btn rs-btn-outline" aria-label="Archive" disabled={!review.can.archive} onClick={review.archive}>
            <Archive /> Archive
          </button>
          <Popover
            open={review.overlay.kind === "settings"}
            onOpenChange={(open) => review.setOverlay(open ? { kind: "settings" } : { kind: "closed" })}
          >
            <PopoverTrigger asChild>
              <button type="button" className="rs-btn rs-btn-cream rs-btn-round ap-settings-btn" aria-label="TikTok settings" aria-haspopup="dialog">
                <MoreHorizontal />
                {attention ? <span className="ap-dot" aria-hidden="true" /> : null}
              </button>
            </PopoverTrigger>
            <PopoverContent side="top" align="start" className="w-auto border-0 bg-transparent p-0 shadow-none">
              <TikTokSettingsForm
                draft={draft}
                creator={review.creator}
                creatorError={review.creatorError}
                onRetryCreator={review.retryCreator}
                saving={review.commands.saveDraft.isPending}
                translate={review.translate}
                onCancel={() => review.setOverlay({ kind: "closed" })}
                onSave={(settings, consent) => { void review.saveSettings(settings, consent); }}
              />
            </PopoverContent>
          </Popover>
        </div>
        <div className="ap-footer-group">
          <button
            type="button"
            className="rs-btn rs-btn-mint-outline rs-btn-square"
            disabled={review.approveReason !== null}
            title={review.approveReason ?? undefined}
            aria-describedby={reason ? reasonId : undefined}
            onClick={() => review.openConfirm("now")}
          >
            <Check /> Approve
          </button>
          <button
            type="button"
            className="rs-btn rs-btn-mint rs-btn-square"
            disabled={review.scheduleReason !== null}
            title={review.scheduleReason ?? undefined}
            aria-describedby={reason ? reasonId : undefined}
            onClick={() => review.openConfirm("scheduled")}
          >
            <CalendarClock /> Schedule
          </button>
        </div>
      </div>
      {reason ? <p id={reasonId} className="ap-reason">{reason}</p> : null}
    </>
  );
}

export function ConfirmDialog({ review, draft, username }: { review: DraftReview; draft: ReviewDraft; username: string }) {
  const confirm = review.overlay.kind === "confirm" ? review.overlay : null;
  const onOff = (value: boolean) => (value ? "on" : "off");
  const when = confirm?.mode === "scheduled" ? `When: ${review.scheduleLabel}` : "When: Now";
  const summary = [
    `Account: @${username}`,
    `Audience: ${draft.settings.privacy ? privacyLabel(draft.settings.privacy) : "No audience"}`,
    `Comments: ${onOff(draft.settings.allowComment)} · Duet: ${onOff(draft.settings.allowDuet)} · Stitch: ${onOff(draft.settings.allowStitch)}`,
    `Disclosure: ${onOff(draft.settings.disclose)}${draft.settings.disclose ? ` (Your brand: ${onOff(draft.settings.yourBrand)}, Branded content: ${onOff(draft.settings.brandedContent)})` : ""}`,
    `AI-generated: ${onOff(draft.settings.aiGenerated)}`,
    when,
  ];
  return (
    <Dialog
      open={confirm !== null}
      onOpenChange={(open) => {
        if (open) return;
        review.setOverlay({ kind: "closed" });
        review.setConfirmError(null);
      }}
    >
      <DialogContent className="max-w-md rounded-xl border-[color:var(--rs-rule-strong)] bg-[color:var(--rs-paper-card)]">
        <DialogHeader>
          <DialogTitle>{confirm?.mode === "scheduled" ? "Schedule this video?" : "Publish this video now?"}</DialogTitle>
          <DialogDescription>Nothing is sent to TikTok until you confirm.</DialogDescription>
        </DialogHeader>
        <ul className="space-y-1 text-[13px]">
          {summary.map((line) => <li key={line}>{line}</li>)}
        </ul>
        <p className="ap-notice">{musicConsentText(draft.settings)}</p>
        {review.confirmError ? <p className="ap-alert" role="alert">{review.confirmError}</p> : null}
        <DialogFooter className="gap-2">
          <button
            type="button"
            className="rs-btn rs-btn-ghost"
            onClick={() => {
              review.setOverlay({ kind: "closed" });
              review.setConfirmError(null);
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rs-btn rs-btn-mint rs-btn-square"
            disabled={review.confirmPending || confirm === null}
            onClick={() => { void review.confirm(); }}
          >
            {confirm?.mode === "scheduled" ? "Confirm schedule" : "Confirm & publish"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
