import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ReactNode } from "react";
import type { ShortcutName } from "../domain/scheduleRules";

export type ConfirmDialog = { mode: "now" | "scheduled"; requestId: string };

export interface PublishControlsViewModel {
  timeZone: string;
  scheduleLocal: string;
  scheduleNote: string | null;
  onScheduleLocal: (value: string) => void;
  onNow: () => void;
  onShortcut: (name: ShortcutName) => void;
  destination: string;
  approveReason: string | null;
  scheduleReason: string | null;
  canReject: boolean;
  canEdit: boolean;
  canArchive: boolean;
  canRestore: boolean;
  settings: ReactNode;
  settingsOpen: boolean;
  onSettingsOpenChange: (open: boolean) => void;
  onEdit: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onReject: (reason: string) => void;
  rejectPending: boolean;
  confirm: ConfirmDialog | null;
  onOpenConfirm: (mode: "now" | "scheduled") => void;
  onCloseConfirm: () => void;
  confirmSummary: string[];
  onConfirm: () => void;
  confirmPending: boolean;
  confirmError: string | null;
  rejectOpen: boolean;
  onRejectOpenChange: (open: boolean) => void;
}

export function PublishControls({ model }: { model: PublishControlsViewModel }) {
  const {
    timeZone,
    scheduleLocal,
    scheduleNote,
    onScheduleLocal,
    onNow,
    onShortcut,
    destination,
    approveReason,
    scheduleReason,
    canReject,
    canEdit,
    canArchive,
    canRestore,
    settings,
    settingsOpen,
    onSettingsOpenChange,
    onEdit,
    onArchive,
    onRestore,
    onReject,
    rejectPending,
    confirm,
    onOpenConfirm,
    onCloseConfirm,
    confirmSummary,
    onConfirm,
    confirmPending,
    confirmError,
    rejectOpen,
    onRejectOpenChange,
  } = model;
  const { t } = useTranslation("post");
  const [rejectReason, setRejectReason] = useState("");
  const approveReasonId = useId();
  const scheduleReasonId = useId();

  useEffect(() => {
    if (rejectOpen) setRejectReason("");
  }, [rejectOpen]);

  return (
    <div>
      <p className="tiktok-review-eyebrow">{t("tiktokReview.publishAt", "Publish at")}</p>
      <div className="tiktok-review-filters">
        <input
          className="tiktok-review-input"
          type="datetime-local"
          value={scheduleLocal}
          aria-label={t("tiktokReview.publishAt", "Publish at")}
          onChange={(event) => onScheduleLocal(event.target.value)}
        />
        <button type="button" className="tiktok-review-pill" onClick={onNow}>{t("tiktokReview.now", "Now")}</button>
        <button type="button" className="tiktok-review-pill" onClick={() => onShortcut("in_1_hour")}>
          {t("tiktokReview.inOneHour", "In 1 hour")}
        </button>
        <button type="button" className="tiktok-review-pill" onClick={() => onShortcut("tomorrow_9")}>
          {t("tiktokReview.tomorrowNine", "Tomorrow 9:00")}
        </button>
      </div>
      <p className="tiktok-review-secondary">
        {t("tiktokReview.timeZone", "Time zone: {{zone}}", { zone: timeZone })}
      </p>
      <p className="tiktok-review-eyebrow">{destination}</p>
      {scheduleNote ? <p className="tiktok-review-alert" role="status">{scheduleNote}</p> : null}
      <div className="tiktok-review-actions">
        <button
          type="button"
          className="tiktok-review-button tiktok-review-button-reject"
          disabled={!canReject}
          onClick={() => onRejectOpenChange(true)}
        >
          {t("tiktokReview.reject", "Reject")}
        </button>
        <button type="button" className="tiktok-review-button tiktok-review-button-edit" disabled={!canEdit} onClick={onEdit}>
          {t("tiktokReview.edit", "Edit")}
        </button>
        {canRestore ? (
          <button type="button" className="tiktok-review-button tiktok-review-button-archive" onClick={onRestore}>
            {t("tiktokReview.restore", "Restore")}
          </button>
        ) : (
          <button type="button" className="tiktok-review-button tiktok-review-button-archive" disabled={!canArchive} onClick={onArchive}>
            {t("tiktokReview.archive", "Archive")}
          </button>
        )}
        <Popover open={settingsOpen} onOpenChange={onSettingsOpenChange}>
          <PopoverTrigger asChild>
            <button type="button" className="tiktok-review-button tiktok-review-button-edit" aria-label={t("tiktokReview.settingsButton", "TikTok settings")}>
              {t("tiktokReview.settingsButton", "TikTok settings")}
            </button>
          </PopoverTrigger>
          <PopoverContent className="tiktok-review tiktok-review-portal" align="start">
            {settings}
          </PopoverContent>
        </Popover>
        <div className="tiktok-review-actions-end">
          <span className="tiktok-review-secondary">
            <kbd className="tiktok-review-kbd">A</kbd> {t("tiktokReview.hintApprove", "approve & publish")}
            {" "}
            <kbd className="tiktok-review-kbd">R</kbd> {t("tiktokReview.hintReject", "reject")}
            {" "}
            <kbd className="tiktok-review-kbd">→</kbd> {t("tiktokReview.hintNext", "next")}
          </span>
          <button
            type="button"
            className="tiktok-review-button tiktok-review-button-approve"
            disabled={approveReason !== null}
            aria-describedby={approveReason ? approveReasonId : undefined}
            onClick={() => onOpenConfirm("now")}
          >
            {t("tiktokReview.approve", "Approve & publish")}
          </button>
          <button
            type="button"
            className="tiktok-review-button tiktok-review-button-schedule"
            disabled={scheduleReason !== null}
            aria-describedby={scheduleReason ? scheduleReasonId : undefined}
            onClick={() => onOpenConfirm("scheduled")}
          >
            {t("tiktokReview.schedule", "Schedule")}
          </button>
        </div>
      </div>
      {approveReason ? <p id={approveReasonId} className="tiktok-review-reason">{approveReason}</p> : null}
      {scheduleReason ? <p id={scheduleReasonId} className="tiktok-review-reason">{scheduleReason}</p> : null}

      <Dialog open={rejectOpen} onOpenChange={onRejectOpenChange}>
        <DialogContent className="tiktok-review tiktok-review-dialog">
          <DialogHeader>
            <DialogTitle>{t("tiktokReview.rejectTitle", "Reject this post")}</DialogTitle>
            <DialogDescription>
              {t("tiktokReview.rejectHelp", "A reason is required. Cancel leaves the post unchanged.")}
            </DialogDescription>
          </DialogHeader>
          <label>
            <span className="tiktok-review-eyebrow">{t("tiktokReview.rejectReason", "Reason")}</span>
            <textarea
              className="tiktok-review-textarea"
              value={rejectReason}
              onChange={(event) => setRejectReason(event.target.value)}
            />
          </label>
          <DialogFooter>
            <button type="button" className="tiktok-review-button tiktok-review-button-archive" onClick={() => onRejectOpenChange(false)}>
              {t("tiktokReview.cancel", "Cancel")}
            </button>
            <button
              type="button"
              className="tiktok-review-button tiktok-review-button-reject"
              disabled={rejectPending || rejectReason.trim().length === 0}
              onClick={() => onReject(rejectReason.trim())}
            >
              {t("tiktokReview.reject", "Reject")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={confirm !== null} onOpenChange={(open) => { if (!open) onCloseConfirm(); }}>
        <DialogContent className="tiktok-review tiktok-review-dialog">
          <DialogHeader>
            <DialogTitle>
              {confirm?.mode === "scheduled"
                ? t("tiktokReview.confirmScheduleTitle", "Schedule this video?")
                : t("tiktokReview.confirmPublishTitle", "Publish this video now?")}
            </DialogTitle>
            <DialogDescription>
              {t("tiktokReview.confirmHelp", "Nothing is sent to TikTok until you confirm.")}
            </DialogDescription>
          </DialogHeader>
          <ul>
            {confirmSummary.map((line) => <li key={line}>{line}</li>)}
          </ul>
          {confirmError ? <p className="tiktok-review-alert" role="alert">{confirmError}</p> : null}
          <DialogFooter>
            <button type="button" className="tiktok-review-button tiktok-review-button-archive" onClick={onCloseConfirm}>
              {t("tiktokReview.cancel", "Cancel")}
            </button>
            <button
              type="button"
              className="tiktok-review-button tiktok-review-button-schedule"
              disabled={confirmPending || confirm === null}
              onClick={onConfirm}
            >
              {t("tiktokReview.confirm", "Confirm")}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
