import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import type { CreatorInfo, ReviewDraft, TikTokSettings } from "../domain/types";
import {
  privacyLabel,
  reviewBlockers,
  sanitizeSettingsForCreator,
  type ReviewBlocker,
} from "../domain/reviewRules";
import { describeBlocker } from "./reviewCopy";

interface TikTokSettingsPanelProps {
  draft: ReviewDraft;
  creator: CreatorInfo | null;
  creatorError: string | null;
  onRetryCreator: () => void;
  saving: boolean;
  onCancel: () => void;
  onSave: (settings: TikTokSettings, consentChecked: boolean) => void;
}

export function TikTokSettingsPanel({
  draft,
  creator,
  creatorError,
  onRetryCreator,
  saving,
  onCancel,
  onSave,
}: TikTokSettingsPanelProps) {
  const { t } = useTranslation("post");
  const [settings, setSettings] = useState<TikTokSettings>(draft.settings);
  const [consentChecked, setConsentChecked] = useState(false);

  useEffect(() => {
    setSettings(creator ? sanitizeSettingsForCreator(draft.settings, creator) : draft.settings);
    setConsentChecked(false);
  }, [creator, draft.revision, draft.settings]);

  const update = (patch: Partial<TikTokSettings>) => {
    setSettings((current) => {
      const next = { ...current, ...patch };
      return creator ? sanitizeSettingsForCreator(next, creator) : next;
    });
  };

  const saveBlockers = reviewBlockers({
    caption: draft.caption,
    settings,
    mediaFileId: draft.mediaFileId,
    durationSec: draft.mediaDurationSec,
    creator,
    settingsConfirmed: true,
    consentGranted: consentChecked,
    mode: "now",
    scheduledAt: null,
  });
  const saveReason = firstBlocker(t, saveBlockers);

  return (
    <div className="tiktok-review-settings">
      <p className="tiktok-review-eyebrow">{t("tiktokReview.settingsEyebrow", "TikTok settings")}</p>
      <p>
        {t("tiktokReview.postingAs", "Posting as {{nickname}} (@{{username}})", {
          nickname: creator?.nickname || t("tiktokReview.unknownNickname", "TikTok"),
          username: creator?.username || "…",
        })}
      </p>
      {creatorError ? (
        <div role="alert">
          <p className="tiktok-review-alert">{creatorError}</p>
          <button type="button" className="tiktok-review-button tiktok-review-button-edit" onClick={onRetryCreator}>
            {t("tiktokReview.retry", "Retry")}
          </button>
        </div>
      ) : null}
      <label>
        <span className="tiktok-review-eyebrow">{t("tiktokReview.whoCanView", "Who can view")}</span>
        <select
          className="tiktok-review-select"
          value={settings.privacy ?? ""}
          onChange={(event) => update({ privacy: event.target.value || null })}
        >
          <option value="" disabled>{t("tiktokReview.chooseAudience", "Choose audience…")}</option>
          {(creator?.privacyLevelOptions ?? []).map((level) => (
            <option key={level} value={level} disabled={level === "SELF_ONLY" && settings.brandedContent}>
              {t(`tiktokReview.privacy.${level}`, privacyLabel(level))}
            </option>
          ))}
        </select>
      </label>
      {settings.brandedContent ? (
        <p className="tiktok-review-secondary">
          {t("tiktokReview.brandedPrivateHint", "Branded content visibility cannot be set to private")}
        </p>
      ) : null}
      <p>
        {creator
          ? t("tiktokReview.maxLength", "Maximum video length: {{seconds}} seconds.", { seconds: creator.maxVideoPostDurationSec })
          : t("tiktokReview.maxLengthUnknown", "Maximum video length unavailable.")}
      </p>
      <InteractionToggle
        label={t("tiktokReview.allowComments", "Allow comments")}
        checked={settings.allowComment}
        disabled={creator?.commentDisabled === true}
        reason={t("tiktokReview.commentsDisabled", "Comments are turned off for this TikTok account.")}
        onChange={(allowComment) => update({ allowComment })}
      />
      <InteractionToggle
        label={t("tiktokReview.allowDuet", "Allow Duet")}
        checked={settings.allowDuet}
        disabled={creator?.duetDisabled === true}
        reason={t("tiktokReview.duetDisabled", "Duet is turned off for this TikTok account.")}
        onChange={(allowDuet) => update({ allowDuet })}
      />
      <InteractionToggle
        label={t("tiktokReview.allowStitch", "Allow Stitch")}
        checked={settings.allowStitch}
        disabled={creator?.stitchDisabled === true}
        reason={t("tiktokReview.stitchDisabled", "Stitch is turned off for this TikTok account.")}
        onChange={(allowStitch) => update({ allowStitch })}
      />
      <div className="tiktok-review-check">
        <Switch
          checked={settings.aiGenerated}
          onCheckedChange={(checked) => update({ aiGenerated: checked === true })}
          aria-label={t("tiktokReview.aiGenerated", "AI-generated content")}
        />
        <span>{t("tiktokReview.aiGenerated", "AI-generated content")}</span>
      </div>
      <div className="tiktok-review-check">
        <Switch
          checked={settings.disclose}
          onCheckedChange={(checked) => update({ disclose: checked === true })}
          aria-label={t("tiktokReview.disclose", "Disclose commercial content")}
        />
        <span>{t("tiktokReview.disclose", "Disclose commercial content")}</span>
      </div>
      {settings.disclose ? (
        <div>
          <DisclosureBox
            label={t("tiktokReview.yourBrand", "Your brand")}
            checked={settings.yourBrand}
            preview={t("tiktokReview.promotionalLabel", "Your video will be labeled as 'Promotional content'")}
            onChange={(yourBrand) => update({ yourBrand })}
          />
          <DisclosureBox
            label={t("tiktokReview.brandedContent", "Branded content")}
            checked={settings.brandedContent}
            disabled={settings.privacy === "SELF_ONLY"}
            preview={t("tiktokReview.paidPartnershipLabel", "Your video will be labeled as 'Paid partnership'")}
            onChange={(brandedContent) => update({ brandedContent })}
          />
          {!settings.yourBrand && !settings.brandedContent ? (
            <p className="tiktok-review-alert">{t("tiktokReview.selectAtLeastOne", "Select at least one")}</p>
          ) : null}
        </div>
      ) : null}
      <label className={settings.privacy ? "tiktok-review-check" : "tiktok-review-check is-disabled"}>
        <Checkbox
          checked={consentChecked}
          disabled={!settings.privacy}
          onCheckedChange={(checked) => setConsentChecked(checked === true)}
        />
        <span>{t("tiktokReview.consent", "I consent to send this content to the selected TikTok account")}</span>
      </label>
      {saveReason ? <p className="tiktok-review-reason">{saveReason}</p> : null}
      <div className="tiktok-review-actions">
        <button type="button" className="tiktok-review-button tiktok-review-button-archive" onClick={onCancel}>
          {t("tiktokReview.cancel", "Cancel")}
        </button>
        <button
          type="button"
          className="tiktok-review-button tiktok-review-button-schedule"
          disabled={saving || saveBlockers.length > 0}
          onClick={() => onSave(settings, consentChecked)}
        >
          {t("tiktokReview.save", "Save")}
        </button>
      </div>
    </div>
  );
}

function firstBlocker(
  t: (key: string, fallback: string) => string,
  blockers: ReviewBlocker[],
): string | null {
  const blocker = blockers[0];
  return blocker ? describeBlocker(t, blocker) : null;
}

function InteractionToggle({
  label,
  checked,
  disabled,
  reason,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  reason: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={disabled ? "tiktok-review-check is-disabled" : "tiktok-review-check"}>
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={(value) => onChange(value === true)} />
      <span>
        {label}
        {disabled ? <span className="tiktok-review-secondary"> {reason}</span> : null}
      </span>
    </label>
  );
}

function DisclosureBox({
  label,
  checked,
  preview,
  disabled = false,
  onChange,
}: {
  label: string;
  checked: boolean;
  preview: string;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className={disabled ? "tiktok-review-check is-disabled" : "tiktok-review-check"}>
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={(value) => onChange(value === true)} />
      <span>
        {label}
        {checked ? <span className="tiktok-review-secondary"> {preview}</span> : null}
      </span>
    </label>
  );
}
