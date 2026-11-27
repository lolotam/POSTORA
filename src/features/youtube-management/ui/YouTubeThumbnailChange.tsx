import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import type { YouTubeCapabilityReason, YouTubeCapabilityState } from "../domain/types";
import {
  isDirectThumbnailCandidate,
  type YouTubeThumbnailCandidate,
  type YouTubeThumbnailOutcome,
} from "../domain/thumbnail";

export interface YouTubeThumbnailChangeProps {
  /** The server's derived capability; never a client-side flag. */
  capability: YouTubeCapabilityState | null;
  /** The creator's own library images; the picker filters them. */
  candidates: readonly YouTubeThumbnailCandidate[];
  candidatesLoading: boolean;
  candidatesError: unknown;
  onRetryCandidates?: () => void;
  /** Injected write seam; the call is made once per confirmed choice. */
  onSetThumbnail?: (mediaFileId: string) => Promise<YouTubeThumbnailOutcome>;
}

/** Why the control is disabled, in the creator's words. */
function ThumbnailUnavailableReason({ reason }: { reason: YouTubeCapabilityReason | null }): JSX.Element {
  const { t } = useTranslation("accounts");
  let message: string;
  switch (reason) {
    case "reconnect_required":
      message = t(
        "youtubeManagement.thumbnail.reconnectRequired",
        "This channel needs to be reconnected before changing thumbnails is available.",
      );
      break;
    case "missing_scope":
      message = t(
        "youtubeManagement.thumbnail.missingScope",
        "Reconnect this channel and grant YouTube upload permissions to change thumbnails.",
      );
      break;
    case "provider_unsupported":
      message = t(
        "youtubeManagement.thumbnail.providerUnsupported",
        "Changing thumbnails is not available for managed connections.",
      );
      break;
    default:
      message = t(
        "youtubeManagement.thumbnail.unavailable",
        "Changing thumbnails is currently unavailable for this channel.",
      );
      break;
  }
  return <p className="text-xs text-muted-foreground">{message}</p>;
}

/** The one image list the creator may choose from. */
function ThumbnailImageChoices({
  candidates,
  selectedId,
  disabled,
  onSelect,
}: {
  candidates: readonly YouTubeThumbnailCandidate[];
  selectedId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <RadioGroup value={selectedId} onValueChange={onSelect} disabled={disabled}>
      {candidates.map((candidate) => (
        <div key={candidate.id} className="flex items-center gap-2">
          <RadioGroupItem value={candidate.id} aria-label={candidate.file_name} disabled={disabled} />
          <span className="text-sm">{candidate.file_name}</span>
        </div>
      ))}
    </RadioGroup>
  );
}

/** The library, or the one sentence that explains why it cannot be shown. */
function ThumbnailPickerBody({
  candidates,
  loading,
  error,
  onRetry,
  selectedId,
  disabled,
  onSelect,
}: {
  candidates: readonly YouTubeThumbnailCandidate[];
  loading: boolean;
  error: unknown;
  onRetry?: () => void;
  selectedId: string;
  disabled: boolean;
  onSelect: (id: string) => void;
}): JSX.Element {
  const { t } = useTranslation("accounts");
  if (error !== null && error !== undefined) {
    return (
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {t("youtubeManagement.thumbnail.libraryError", "Postora could not read your media library. Nothing was changed.")}
        </p>
        {onRetry ? (
          <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onRetry}>
            {t("youtubeManagement.thumbnail.retryLibrary", "Retry loading images")}
          </Button>
        ) : null}
      </div>
    );
  }
  if (loading) {
    return <p className="text-xs text-muted-foreground">{t("youtubeManagement.thumbnail.loading", "Loading your images…")}</p>;
  }
  if (candidates.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        {t(
          "youtubeManagement.thumbnail.noEligible",
          "Your media library has no JPEG or PNG image to use as a thumbnail.",
        )}
      </p>
    );
  }
  return <ThumbnailImageChoices candidates={candidates} selectedId={selectedId} disabled={disabled} onSelect={onSelect} />;
}

/** The explicit confirmation: the thumbnail is what viewers see on YouTube. */
function ThumbnailConfirmation({
  candidate,
  busy,
  onConfirm,
  onCancel,
}: {
  candidate: YouTubeThumbnailCandidate;
  busy: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const { t } = useTranslation("accounts");
  return (
    <div className="space-y-2 rounded-md border p-3">
      <p className="text-xs font-medium">
        {t("youtubeManagement.thumbnail.chosen", "New thumbnail: {{name}}", { name: candidate.file_name })}
      </p>
      <p className="text-xs text-muted-foreground">
        {t("youtubeManagement.thumbnail.confirmPrompt", "This replaces the thumbnail viewers see on YouTube")}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={onConfirm}>
          {t("youtubeManagement.thumbnail.confirm", "Confirm thumbnail change")}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onCancel}>
          {t("common:cancel", "Cancel")}
        </Button>
      </div>
    </div>
  );
}

/** What one attempt produced, in words the creator can act on. */
function ThumbnailOutcomeMessage({ outcome }: { outcome: YouTubeThumbnailOutcome }): JSX.Element {
  const { t } = useTranslation("accounts");
  let message: string;
  switch (outcome) {
    case "applied":
      message = t("youtubeManagement.thumbnail.applied", "Thumbnail updated on YouTube.");
      break;
    case "thumbnail_not_allowed":
      message = t(
        "youtubeManagement.thumbnail.thumbnailNotAllowed",
        "This YouTube channel is not eligible to set custom thumbnails.",
      );
      break;
    case "media_not_usable":
      message = t(
        "youtubeManagement.thumbnail.mediaNotUsable",
        "This image cannot be used. Choose a JPEG or PNG image under 2 MB from your library.",
      );
      break;
    case "rate_limited":
    case "quota_exceeded":
      message = t("youtubeManagement.thumbnail.writeLimit", "Thumbnail write limit reached. Try again later.");
      break;
    case "refused":
      message = t(
        "youtubeManagement.thumbnail.refused",
        "Thumbnail could not be updated. Nothing was changed on YouTube.",
      );
      break;
    default:
      message = t("youtubeManagement.thumbnail.outcomeUnknown", "YouTube may have applied it. Refresh to check.");
      break;
  }
  return (
    <p role="status" className="text-xs text-muted-foreground">
      {message}
    </p>
  );
}

/**
 * Replaces the thumbnail of a published video from the creator's own library.
 *
 * The flow is deliberately two steps: a pick, then an explicit confirmation,
 * because the thumbnail is what viewers see on YouTube. The write happens
 * exactly once per confirmed choice, and every outcome is stated in words
 * instead of leaving the creator guessing.
 */
export function YouTubeThumbnailChange({
  capability,
  candidates,
  candidatesLoading,
  candidatesError,
  onRetryCandidates,
  onSetThumbnail,
}: YouTubeThumbnailChangeProps): JSX.Element {
  const { t } = useTranslation("accounts");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [chosen, setChosen] = useState<YouTubeThumbnailCandidate | null>(null);
  const [outcome, setOutcome] = useState<YouTubeThumbnailOutcome | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const available = capability?.state === "available";
  // Only JPEG and PNG can be sent to `thumbnails.set`; everything else the
  // library holds is filtered out here and named in the notice below.
  const eligible = candidates.filter(isDirectThumbnailCandidate);
  const excludedCount = candidates.length - eligible.length;
  const unavailableReason = capability?.state === "unavailable" ? capability.reason : null;

  const openPicker = () => {
    if (submitting) return;
    setPickerOpen(true);
    setChosen(null);
    setOutcome(null);
  };

  const selectImage = (id: string) => {
    if (submitting) return;
    setChosen(eligible.find((candidate) => candidate.id === id) ?? null);
  };

  const confirm = async () => {
    if (!chosen || !onSetThumbnail || submitting) return;
    setSubmitting(true);
    try {
      const result = await onSetThumbnail(chosen.id);
      setOutcome(result);
      if (result === "applied") {
        setPickerOpen(false);
        setChosen(null);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={!available || !onSetThumbnail || submitting} onClick={openPicker}>
          {t("youtubeManagement.thumbnail.change", "Change thumbnail")}
        </Button>
        {!available || !onSetThumbnail ? <ThumbnailUnavailableReason reason={unavailableReason} /> : null}
      </div>

      {pickerOpen ? (
        <div className="space-y-3 rounded-lg border p-3">
          <p className="text-sm font-semibold">{t("youtubeManagement.thumbnail.pickerTitle", "Choose a thumbnail image")}</p>
          <p className="text-xs text-muted-foreground">
            {t("youtubeManagement.thumbnail.pickerHint", "YouTube accepts JPEG and PNG images only.")}
          </p>
          <ThumbnailPickerBody
            candidates={eligible}
            loading={candidatesLoading}
            error={candidatesError}
            onRetry={onRetryCandidates}
            selectedId={chosen?.id ?? ""}
            disabled={submitting}
            onSelect={selectImage}
          />
          {excludedCount > 0 ? (
            <p className="text-xs text-muted-foreground">
              {t(
                "youtubeManagement.thumbnail.excluded",
                "Some images in your library were excluded because YouTube accepts JPEG and PNG only.",
              )}
            </p>
          ) : null}
          {chosen ? (
            <ThumbnailConfirmation
              candidate={chosen}
              busy={submitting}
              onConfirm={() => void confirm()}
              onCancel={() => setChosen(null)}
            />
          ) : null}
        </div>
      ) : null}

      {outcome ? <ThumbnailOutcomeMessage outcome={outcome} /> : null}
    </div>
  );
}
