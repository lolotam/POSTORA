import { useEffect, useState } from "react";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { CreatorInfo, ReviewDraft, TikTokSettings } from "../../domain/types";
import { privacyLabel, reviewBlockers, sanitizeSettingsForCreator } from "../../domain/reviewRules";
import { describeBlocker } from "../reviewCopy";

interface TikTokSettingsFormProps {
  draft: ReviewDraft;
  creator: CreatorInfo | null;
  creatorError: string | null;
  onRetryCreator: () => void;
  saving: boolean;
  translate: (key: string, fallback: string) => string;
  onCancel: () => void;
  onSave: (settings: TikTokSettings, consentChecked: boolean) => void;
}

/**
 * The "⋯" TikTok settings popover. Same rules as the admin TikTokSettingsPanel: audience comes from
 * the creator's offered privacy levels with no default, interactions start off and follow the
 * account's limits, branded content cannot be private, and saving records consent for this exact
 * account, revision, settings and time.
 */
export function TikTokSettingsForm({
  draft,
  creator,
  creatorError,
  onRetryCreator,
  saving,
  translate,
  onCancel,
  onSave,
}: TikTokSettingsFormProps) {
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

  const saveBlocker = reviewBlockers({
    caption: draft.caption,
    settings,
    mediaFileId: draft.mediaFileId,
    durationSec: draft.mediaDurationSec,
    creator,
    settingsConfirmed: true,
    consentGranted: consentChecked,
    mode: "now",
    scheduledAt: null,
  })[0];
  const brandedPrivate = settings.disclose && settings.brandedContent;

  return (
    <div className="ap-pop">
      <div className="rs-label">TikTok settings</div>
      <p className="ap-pop-help">
        Prepare your post now. Account settings and publishing consent can be confirmed before scheduling.
      </p>
      {creator ? (
        <p className="mb-2 text-[12px] text-[color:var(--rs-ink-soft)]">
          Posting as <strong>{creator.nickname}</strong> (@{creator.username}) · up to {creator.maxVideoPostDurationSec}s
        </p>
      ) : null}
      {creatorError ? (
        <div role="alert" className="mb-2">
          <p className="ap-alert">{creatorError}</p>
          <button type="button" className="rs-btn rs-btn-cream rs-btn-sm mt-1" onClick={onRetryCreator}>Retry</button>
        </div>
      ) : null}

      <div className="rs-label mt-2">Who can view</div>
      <Select
        value={settings.privacy ?? undefined}
        onValueChange={(privacy) => update({ privacy })}
        disabled={!creator}
      >
        <SelectTrigger className="mt-1.5 h-10 rounded-[10px]" aria-label="Who can view">
          <SelectValue placeholder="Choose audience…" />
        </SelectTrigger>
        <SelectContent>
          {(creator?.privacyLevelOptions ?? []).map((level) => (
            <SelectItem key={level} value={level} disabled={level === "SELF_ONLY" && brandedPrivate}>
              {privacyLabel(level)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {brandedPrivate ? <p className="ap-pop-help">Branded content visibility cannot be set to private</p> : null}

      <div className="rs-label mt-3">Post type</div>
      <div className="ap-pop-row" role="radiogroup" aria-label="Post type">
        <label className="flex items-center gap-2"><input type="radio" checked readOnly disabled /> Video</label>
        <label className="flex items-center gap-2 opacity-55"><input type="radio" disabled /> Photo</label>
      </div>
      <p className="ap-pop-help">Set by what the post carries — attach a video or images to change it.</p>

      <div className="ap-pop-divider" />
      <InteractionRow
        label="Allow comments"
        checked={settings.allowComment}
        disabled={creator?.commentDisabled === true}
        reason="Comments are turned off for this TikTok account."
        onChange={(allowComment) => update({ allowComment })}
      />
      <InteractionRow
        label="Allow Duet"
        checked={settings.allowDuet}
        disabled={creator?.duetDisabled === true}
        reason="Duet is turned off for this TikTok account."
        onChange={(allowDuet) => update({ allowDuet })}
      />
      <InteractionRow
        label="Allow Stitch"
        checked={settings.allowStitch}
        disabled={creator?.stitchDisabled === true}
        reason="Stitch is turned off for this TikTok account."
        onChange={(allowStitch) => update({ allowStitch })}
      />

      <label className="ap-pop-row">
        <span>AI-generated content</span>
        <Switch
          className="ap-switch"
          checked={settings.aiGenerated}
          onCheckedChange={(checked) => update({ aiGenerated: checked === true })}
          aria-label="AI-generated content"
        />
      </label>

      <div className="ap-pop-divider" />
      <p className="ap-pop-help">Disclose whether this content promotes yourself, a brand, product or service.</p>
      <label className="ap-pop-row">
        <span>Disclose commercial content</span>
        <Switch
          className="ap-switch"
          checked={settings.disclose}
          onCheckedChange={(checked) => update({ disclose: checked === true })}
          aria-label="Disclose commercial content"
        />
      </label>
      {settings.disclose ? (
        <div className="pl-1">
          <InteractionRow
            label="Your brand"
            checked={settings.yourBrand}
            disabled={false}
            reason=""
            hint={settings.yourBrand ? "Your video will be labeled as 'Promotional content'" : undefined}
            onChange={(yourBrand) => update({ yourBrand })}
          />
          <InteractionRow
            label="Branded content"
            checked={settings.brandedContent}
            disabled={settings.privacy === "SELF_ONLY"}
            reason="Branded content visibility cannot be set to private"
            hint={settings.brandedContent ? "Your video will be labeled as 'Paid partnership'" : undefined}
            onChange={(brandedContent) => update({ brandedContent })}
          />
          {!settings.yourBrand && !settings.brandedContent ? <p className="ap-alert">Select at least one</p> : null}
        </div>
      ) : null}

      <div className="ap-pop-divider" />
      <label className="ap-pop-row justify-start" data-disabled={!settings.privacy}>
        <Checkbox
          checked={consentChecked}
          disabled={!settings.privacy}
          onCheckedChange={(checked) => setConsentChecked(checked === true)}
        />
        <span className="text-[12px]">I consent to send this content to the selected TikTok account</span>
      </label>
      {saveBlocker ? <p className="ap-pop-help">{describeBlocker(translate, saveBlocker)}</p> : null}

      <div className="mt-3 flex justify-end gap-2">
        <button type="button" className="rs-btn rs-btn-ghost rs-btn-sm" onClick={onCancel}>Cancel</button>
        <button
          type="button"
          className="rs-btn rs-btn-mint rs-btn-sm"
          disabled={saving || saveBlocker !== undefined}
          onClick={() => onSave(settings, consentChecked)}
        >
          Save settings
        </button>
      </div>
    </div>
  );
}

function InteractionRow({
  label,
  checked,
  disabled,
  reason,
  hint,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  reason: string;
  hint?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="ap-pop-row" data-disabled={disabled}>
      <span className="min-w-0">
        {label}
        {disabled && reason ? <span className="block text-[11px] text-[color:var(--rs-ink-mute)]">{reason}</span> : null}
        {hint ? <span className="block text-[11px] text-[color:var(--rs-ink-mute)]">{hint}</span> : null}
      </span>
      <Checkbox checked={checked} disabled={disabled} onCheckedChange={(value) => onChange(value === true)} aria-label={label} />
    </label>
  );
}
