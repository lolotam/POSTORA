import { useTranslation } from "react-i18next";

type FollowUpState = "not_requested" | "applied" | "skipped" | "failed" | "unknown";

interface FollowUpEvidence {
  state: FollowUpState;
  reason: string | null;
}

export interface CaptionFollowUpEvidence extends FollowUpEvidence {
  language?: string | null;
  format?: "srt" | "vtt" | null;
  byte_length?: number | null;
}

export interface YoutubePublishEvidenceView {
  requested_privacy: string;
  effective_privacy: string;
  thumbnail: FollowUpEvidence;
  first_comment: FollowUpEvidence;
  /** Absent on rows settled before a video could be added to a playlist. */
  playlist?: FollowUpEvidence;
  /** Absent on rows settled before upload-time captions were introduced. */
  caption?: CaptionFollowUpEvidence;
}

interface Props {
  evidence: YoutubePublishEvidenceView | null | undefined;
}

function FollowUpLine({ label, value }: { label: string; value: FollowUpEvidence }) {
  const { t } = useTranslation("history");
  const text = value.state === "not_requested"
    ? t("youtube.notRequested", "Not requested")
    : value.state === "applied"
      ? t("youtube.applied", "Applied")
      : value.state === "failed"
        ? t("youtube.failed", "Failed")
        : value.state === "skipped"
          ? t("youtube.skipped", "Skipped")
          : t("youtube.unconfirmed", "Unconfirmed");
  return (
    <li className="text-xs text-muted-foreground">
      {label}: {text}
      {value.reason ? ` (${value.reason})` : ""}
    </li>
  );
}

/** Requested privacy is never presented as the verified outcome. */
export function YouTubePublishEvidence({ evidence }: Props): JSX.Element | null {
  const { t } = useTranslation("history");
  if (!evidence) return null;
  return (
    <div data-testid="youtube-publish-evidence" className="space-y-1">
      <p className="text-xs text-muted-foreground">
        {t("youtube.privacyRequested", "Requested privacy: {{privacy}}", { privacy: evidence.requested_privacy })}
        {" · "}
        {t("youtube.privacyEffective", "Verified privacy: {{privacy}}", { privacy: evidence.effective_privacy })}
      </p>
      <ul>
        <FollowUpLine
          label={t("youtube.thumbnail", "Thumbnail")}
          value={evidence.thumbnail}
        />
        <FollowUpLine
          label={t("youtube.firstComment", "First comment")}
          value={evidence.first_comment}
        />
        <FollowUpLine
          label={t("youtube.playlist", "Playlist")}
          value={evidence.playlist ?? { state: "not_requested", reason: null }}
        />
        <FollowUpLine
          label={t("youtube.caption", "Subtitles / CC")}
          value={evidence.caption ?? { state: "not_requested", reason: null }}
        />
      </ul>
    </div>
  );
}
