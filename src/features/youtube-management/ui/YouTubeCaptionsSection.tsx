import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  CAPTION_CONTENT_MAX_BYTES,
  CAPTION_DAILY_UPLOAD_ALLOWANCE,
  CAPTION_LANGUAGE_PATTERN,
  CAPTION_TRACK_NAME_MAX_LENGTH,
} from "../domain/types";
import type {
  YouTubeCaptionFormat,
  YouTubeCaptionTrack,
  YouTubeCaptionUploadOutcome,
  YouTubeCaptionUploadResult,
  YouTubeCapabilityReason,
  YouTubeCapabilityState,
} from "../domain/types";
import {
  inferCaptionFormatFromFileName,
  measureCaptionUtf8Bytes,
} from "../domain/captions";

export interface YouTubeCaptionsSectionProps {
  /** The server's derived caption capability; never a client-side flag. */
  capability: YouTubeCapabilityState | null;
  /** The video whose tracks are listed and extended. */
  videoId: string;
  /** Lists the tracks. Costs provider units, so it is never called on open. */
  onListCaptions?: (videoId: string) => Promise<YouTubeCaptionTrack[]>;
  /** Uploads one track; the write happens once per confirmed attempt. */
  onUploadCaption?: (params: {
    videoId: string;
    language: string;
    name: string;
    format: YouTubeCaptionFormat;
    content: string;
  }) => Promise<YouTubeCaptionUploadResult>;
}

/** The languages most creators need, plus a free-form BCP-47 code. */
const COMMON_LANGUAGES = ["en", "ar", "es", "fr", "de"] as const;
const CUSTOM_LANGUAGE = "other";

/** The chosen caption file, measured the way the server measures it. */
interface CaptionFile {
  name: string;
  format: YouTubeCaptionFormat;
  content: string;
  bytes: number;
}

/** Why the control is disabled, in the creator's words. */
function CaptionsUnavailableReason({ reason }: { reason: YouTubeCapabilityReason | null }): JSX.Element {
  const { t } = useTranslation("accounts");
  let message: string;
  switch (reason) {
    case "reconnect_required":
      message = t(
        "youtubeManagement.captions.reconnectRequired",
        "This channel needs to be reconnected before captions management is available.",
      );
      break;
    case "missing_scope":
      message = t(
        "youtubeManagement.captions.missingScope",
        "Reconnect this channel and grant YouTube caption permissions (force-ssl) to manage captions.",
      );
      break;
    case "provider_unsupported":
      message = t(
        "youtubeManagement.captions.providerUnsupported",
        "Captions management is not available for managed connections.",
      );
      break;
    default:
      message = t(
        "youtubeManagement.captions.unavailable",
        "Captions management is currently unavailable for this channel.",
      );
      break;
  }
  return <p className="text-xs text-muted-foreground">{message}</p>;
}

/** The track table, or the one sentence that says there is nothing to show. */
function CaptionTracksTable({ tracks }: { tracks: readonly YouTubeCaptionTrack[] }): JSX.Element {
  const { t } = useTranslation("accounts");
  return (
    <table className="w-full text-left text-xs">
      <thead>
        <tr className="text-muted-foreground">
          <th scope="col" className="py-1 pe-2">{t("youtubeManagement.captions.colLanguage", "Language")}</th>
          <th scope="col" className="py-1 pe-2">{t("youtubeManagement.captions.colName", "Name")}</th>
          <th scope="col" className="py-1 pe-2">{t("youtubeManagement.captions.colKind", "Kind")}</th>
          <th scope="col" className="py-1 pe-2">{t("youtubeManagement.captions.colStatus", "Status")}</th>
          <th scope="col" className="py-1">{t("youtubeManagement.captions.colDraft", "Draft")}</th>
        </tr>
      </thead>
      <tbody>
        {tracks.map((track) => (
          <tr key={track.id} className="border-t">
            <td className="py-1 pe-2">{track.language}</td>
            <td className="py-1 pe-2">{track.name}</td>
            <td className="py-1 pe-2">{track.track_kind ?? "—"}</td>
            <td className="py-1 pe-2">{track.status ?? "—"}</td>
            <td className="py-1">
              {track.is_draft === null
                ? "—"
                : track.is_draft
                  ? t("youtubeManagement.captions.yes", "Yes")
                  : t("youtubeManagement.captions.no", "No")}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** What one attempt produced, in words the creator can act on. */
function CaptionOutcomeMessage({ outcome }: { outcome: YouTubeCaptionUploadOutcome }): JSX.Element {
  const { t } = useTranslation("accounts");
  let message: string;
  switch (outcome) {
    case "uploaded":
      message = t("youtubeManagement.captions.uploaded", "Caption track uploaded to YouTube.");
      break;
    case "caption_conflict":
      message = t(
        "youtubeManagement.captions.captionConflict",
        "A caption track with this language and name already exists on YouTube.",
      );
      break;
    case "caption_invalid":
      message = t(
        "youtubeManagement.captions.captionInvalid",
        "This caption file is invalid. Check the SRT or VTT timestamps and ensure it is under 512 KB.",
      );
      break;
    case "rate_limited":
    case "quota_exceeded":
      message = t(
        "youtubeManagement.captions.writeLimit",
        "Caption upload limit reached ({{count}} uploads per 24 hours). Try again tomorrow.",
        { count: CAPTION_DAILY_UPLOAD_ALLOWANCE },
      );
      break;
    case "refused":
      message = t(
        "youtubeManagement.captions.refused",
        "Caption track could not be uploaded. Nothing was changed on YouTube.",
      );
      break;
    default:
      message = t(
        "youtubeManagement.captions.outcomeUnknown",
        "YouTube may have added this caption track. Refresh the track list before trying again.",
      );
      break;
  }
  return (
    <p role="status" className="text-xs text-muted-foreground">
      {message}
    </p>
  );
}

/**
 * The caption tracks of one video, and the form that adds a new one.
 *
 * Listing is deliberately not automatic: every list costs 50 provider
 * units, so the creator asks for it. The upload is two steps as well — a
 * file, a language and a name, then an explicit confirmation — because the
 * write costs 400 units and adds a public track to the video.
 */
export function YouTubeCaptionsSection({
  capability,
  videoId,
  onListCaptions,
  onUploadCaption,
}: YouTubeCaptionsSectionProps): JSX.Element {
  const { t } = useTranslation("accounts");
  const [tracks, setTracks] = useState<YouTubeCaptionTrack[] | null>(null);
  const [listing, setListing] = useState(false);
  const [listFailed, setListFailed] = useState(false);
  const uploadedDuringListRef = useRef<YouTubeCaptionTrack[]>([]);

  const available = capability?.state === "available";
  const unavailableReason = capability?.state === "unavailable" ? capability.reason : null;

  const loadTracks = async () => {
    if (!onListCaptions || listing) return;
    setListing(true);
    setListFailed(false);
    uploadedDuringListRef.current = [];
    try {
      const fetched = await onListCaptions(videoId);
      const concurrent = uploadedDuringListRef.current;
      const merged = [...fetched];
      for (const added of concurrent) {
        if (!merged.some((track) => track.id === added.id)) {
          merged.push(added);
        }
      }
      setTracks(merged);
    } catch {
      // A failed read never looks like an empty list: the creator is told
      // the list could not be read and offered a retry.
      setTracks(null);
      setListFailed(true);
    } finally {
      uploadedDuringListRef.current = [];
      setListing(false);
    }
  };

  return (
    <div className="space-y-2">
      <p className="text-sm font-semibold">{t("youtubeManagement.captions.title", "Captions")}</p>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={!available || !onListCaptions || listing}
          onClick={() => void loadTracks()}
        >
          {tracks === null
            ? t("youtubeManagement.captions.showTracks", "Show caption tracks")
            : t("youtubeManagement.captions.refreshTracks", "Refresh caption tracks")}
        </Button>
        {!available || !onListCaptions ? <CaptionsUnavailableReason reason={unavailableReason} /> : null}
      </div>

      {listing ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t("youtubeManagement.captions.loadingTracks", "Loading caption tracks…")}
        </p>
      ) : listFailed ? (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">
            {t(
              "youtubeManagement.captions.tracksError",
              "Postora could not read the caption tracks of this video.",
            )}
          </p>
          <Button type="button" size="sm" variant="outline" disabled={!available} onClick={() => void loadTracks()}>
            {t("youtubeManagement.captions.retryTracks", "Retry caption tracks")}
          </Button>
        </div>
      ) : tracks !== null ? (
        tracks.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {t("youtubeManagement.captions.noTracks", "No caption tracks found for this video.")}
          </p>
        ) : (
          <CaptionTracksTable tracks={tracks} />
        )
      ) : null}

      <CaptionUploadForm
        capability={capability}
        videoId={videoId}
        onUploadCaption={onUploadCaption}
        onUploaded={(created) => {
          // The new track is appended instead of listed again: a second list
          // would cost another 50 provider units for a row we already have.
          // A track already in the list is not added twice, in case the
          // creator refreshed the list while the upload was in flight.
          if (listing) {
            if (!uploadedDuringListRef.current.some((track) => track.id === created.id)) {
              uploadedDuringListRef.current = [...uploadedDuringListRef.current, created];
            }
          }
          setTracks((current) => {
            if (current === null) return [created];
            return current.some((track) => track.id === created.id) ? current : [...current, created];
          });
        }}
      />
    </div>
  );
}

/** The form that adds one caption track to the video. */
function CaptionUploadForm({
  capability,
  videoId,
  onUploadCaption,
  onUploaded,
}: {
  capability: YouTubeCapabilityState | null;
  videoId: string;
  onUploadCaption?: YouTubeCaptionsSectionProps["onUploadCaption"];
  onUploaded: (track: YouTubeCaptionTrack) => void;
}): JSX.Element {
  const { t } = useTranslation("accounts");
  const fileInputId = useId();
  const languageInputId = useId();
  const nameInputId = useId();

  const [file, setFile] = useState<CaptionFile | null>(null);
  const [fileError, setFileError] = useState<"tooLarge" | "unsupported" | "invalidEncoding" | null>(null);
  const [languageChoice, setLanguageChoice] = useState<string>(COMMON_LANGUAGES[0]);
  const [customLanguage, setCustomLanguage] = useState("");
  const [trackName, setTrackName] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [outcome, setOutcome] = useState<YouTubeCaptionUploadOutcome | null>(null);
  const fileReadSeqRef = useRef(0);

  const available = capability?.state === "available";
  const language = languageChoice === CUSTOM_LANGUAGE ? customLanguage.trim() : languageChoice;
  const languageValid = CAPTION_LANGUAGE_PATTERN.test(language);
  const nameValid = trackName.length <= CAPTION_TRACK_NAME_MAX_LENGTH;
  const canPrepare = file !== null && languageValid && nameValid;
  const formDisabled = !available || submitting;

  const chooseFile = async (chosen: File | undefined) => {
    const readSeq = ++fileReadSeqRef.current;
    setFile(null);
    setFileError(null);
    setConfirming(false);
    if (!chosen) {
      return;
    }
    const format = inferCaptionFormatFromFileName(chosen.name);
    if (format === null) {
      setFileError("unsupported");
      return;
    }
    const content = await chosen.text();
    if (readSeq !== fileReadSeqRef.current) {
      return;
    }
    if (content.includes("\uFFFD")) {
      setFileError("invalidEncoding");
      return;
    }
    const bytes = measureCaptionUtf8Bytes(content);
    if (bytes > CAPTION_CONTENT_MAX_BYTES) {
      // Refused in the browser, on the real byte count: an Arabic file of
      // 300,000 characters is 600,000 bytes and must not reach YouTube.
      setFileError("tooLarge");
      return;
    }
    setFile({ name: chosen.name, format, content, bytes });
  };

  const confirmUpload = async () => {
    if (!file || !canPrepare || !available || !onUploadCaption || submitting) return;
    setSubmitting(true);
    try {
      const result = await onUploadCaption({
        videoId,
        language,
        name: trackName.trim(),
        format: file.format,
        content: file.content,
      });
      setOutcome(result.outcome);
      setConfirming(false);
      if (result.outcome === "uploaded" && result.track) {
        onUploaded(result.track);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border p-3">
      <p className="text-sm font-medium">{t("youtubeManagement.captions.uploadTitle", "Upload caption track")}</p>

      <div className="space-y-1">
        <label htmlFor={fileInputId} className="text-xs font-medium">
          {t("youtubeManagement.captions.fileLabel", "Caption file (.srt or .vtt)")}
        </label>
        <Input
          id={fileInputId}
          type="file"
          accept=".srt,.vtt"
          disabled={formDisabled}
          onChange={(event) => void chooseFile(event.target.files?.[0])}
        />
        {fileError === "tooLarge" ? (
          <p className="text-xs text-muted-foreground">
            {t("youtubeManagement.captions.fileTooLarge", "Caption file exceeds the 512 KB UTF-8 limit.")}
          </p>
        ) : fileError === "unsupported" ? (
          <p className="text-xs text-muted-foreground">
            {t("youtubeManagement.captions.unsupportedFormat", "Choose an .srt or .vtt caption file.")}
          </p>
        ) : fileError === "invalidEncoding" ? (
          <p className="text-xs text-muted-foreground">
            {t("youtubeManagement.captions.invalidEncoding", "Caption file is not valid UTF-8. Save the file as UTF-8 and try again.")}
          </p>
        ) : file ? (
          <p className="text-xs text-muted-foreground">
            {t(
              "youtubeManagement.captions.fileSize",
              "File size: {{size}} KB (limit {{limit}} KB / {{bytes}} UTF-8 bytes)",
              {
                size: (file.bytes / 1024).toFixed(1),
                limit: CAPTION_CONTENT_MAX_BYTES / 1024,
                bytes: CAPTION_CONTENT_MAX_BYTES,
              },
            )}
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <label htmlFor={languageInputId} className="text-xs font-medium">
          {t("youtubeManagement.captions.languageLabel", "Caption language")}
        </label>
        <select
          id={languageInputId}
          className="rounded-md border bg-background px-3 py-2 text-sm"
          value={languageChoice}
          disabled={formDisabled}
          onChange={(event) => setLanguageChoice(event.target.value)}
        >
          {COMMON_LANGUAGES.map((code) => (
            <option key={code} value={code}>{code}</option>
          ))}
          <option value={CUSTOM_LANGUAGE}>
            {t("youtubeManagement.captions.languageCustomOption", "Other (BCP-47 code)")}
          </option>
        </select>
        {languageChoice === CUSTOM_LANGUAGE ? (
          <Input
            aria-label={t("youtubeManagement.captions.languageCustomLabel", "BCP-47 language code")}
            placeholder={t("youtubeManagement.captions.languageCustomLabel", "BCP-47 language code")}
            value={customLanguage}
            disabled={formDisabled}
            onChange={(event) => setCustomLanguage(event.target.value)}
          />
        ) : null}
        {!languageValid ? (
          <p className="text-xs text-muted-foreground">
            {t("youtubeManagement.captions.languageInvalid", "Enter a BCP-47 language code, for example en or ar-EG.")}
          </p>
        ) : null}
      </div>

      <div className="space-y-1">
        <label htmlFor={nameInputId} className="text-xs font-medium">
          {t("youtubeManagement.captions.nameLabel", "Track name (optional)")}
        </label>
        <Input
          id={nameInputId}
          value={trackName}
          disabled={formDisabled}
          maxLength={CAPTION_TRACK_NAME_MAX_LENGTH}
          onChange={(event) => setTrackName(event.target.value)}
        />
        {!nameValid ? (
          <p className="text-xs text-muted-foreground">
            {t("youtubeManagement.captions.nameTooLong", "Track name must be 150 characters or fewer.")}
          </p>
        ) : null}
      </div>

      <p className="text-xs text-muted-foreground">
        {t(
          "youtubeManagement.captions.allowance",
          "Daily caption upload allowance: up to {{count}} uploads per 24 hours (512 KB max per file).",
          { count: CAPTION_DAILY_UPLOAD_ALLOWANCE },
        )}
      </p>

      {confirming ? (
        <div className="space-y-2 rounded-md border p-3">
          <p className="text-xs font-medium">
            {t(
              "youtubeManagement.captions.confirmPrompt",
              "This uploads a new caption track to your YouTube video",
            )}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              disabled={!canPrepare || formDisabled || !onUploadCaption}
              onClick={() => void confirmUpload()}
            >
              {t("youtubeManagement.captions.confirm", "Confirm caption upload")}
            </Button>
            <Button type="button" size="sm" variant="outline" disabled={submitting} onClick={() => setConfirming(false)}>
              {t("common:cancel", "Cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <Button
          type="button"
          size="sm"
          disabled={!canPrepare || formDisabled || !onUploadCaption}
          onClick={() => setConfirming(true)}
        >
          {t("youtubeManagement.captions.prepare", "Prepare caption upload")}
        </Button>
      )}

      {outcome ? <CaptionOutcomeMessage outcome={outcome} /> : null}
    </div>
  );
}
