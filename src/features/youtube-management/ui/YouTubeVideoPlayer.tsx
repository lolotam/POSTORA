import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { formatIsoDuration } from "../domain/formatIsoDuration";
import {
  YOUTUBE_EMBED_ORIGIN,
  YOUTUBE_PLAYBACK_RATES,
  buildYouTubeEmbedUrl,
  buildYouTubeListeningMessage,
  buildYouTubeWatchUrl,
  parsePlayerMessage,
  playerCommand,
  type YouTubePlayerCommand,
  type YouTubePlayerInfo,
  type YouTubePlayerSizeMode,
} from "../domain/player";

/**
 * How long the embed may stay silent before the toolbar stops pretending it
 * can drive the player. Past that point the native controls are the only
 * ones that work, and the creator is told so.
 */
const HANDSHAKE_TIMEOUT_MS = 3000;

export interface YouTubeVideoPlayerProps {
  videoId: string;
  title: string;
  thumbnailUrl: string | null;
  durationIso8601: string | null;
  privacyStatus: string | null;
  uploadStatus?: string | null;
  /** How large the player is drawn; the drawer owns it. */
  sizeMode?: YouTubePlayerSizeMode;
  onSizeModeChange?: (mode: YouTubePlayerSizeMode) => void;
}

/**
 * The poster shown until the creator presses Play.
 *
 * Nothing is loaded from YouTube before that press: no iframe, no request to
 * youtube-nocookie.com.
 */
function PlayerPoster({
  thumbnailUrl,
  durationLabel,
  canPlay,
  privateNotice,
  privacyNote,
  onPlay,
}: {
  thumbnailUrl: string | null;
  durationLabel: string | null;
  canPlay: boolean;
  privateNotice: string | null;
  privacyNote: string;
  onPlay: () => void;
}): JSX.Element {
  const { t } = useTranslation("accounts");
  return (
    <div className="relative h-full w-full">
      {thumbnailUrl ? (
        <img src={thumbnailUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full w-full items-center justify-center px-4 text-center text-xs text-muted-foreground">
          {t("youtubeManagement.player.noThumbnail", "No preview image for this video")}
        </div>
      )}
      {durationLabel ? (
        <span dir="ltr" className="absolute bottom-1 right-1 rounded bg-black/80 px-1.5 py-0.5 text-xs text-white">
          {durationLabel}
        </span>
      ) : null}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-3 text-center">
        {canPlay ? (
          <Button type="button" size="sm" onClick={onPlay}>
            {t("youtubeManagement.player.playVideo", "Play video")}
          </Button>
        ) : null}
        <p className="text-xs text-muted-foreground">{privacyNote}</p>
        {privateNotice ? (
          <p className="text-xs text-muted-foreground">{privateNotice}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The controls that drive the embed.
 *
 * They are hidden when the embed never answered: the native controls inside
 * the player are the only ones that work then, and the creator is told so.
 */
function PlaybackControls({
  disabled,
  volume,
  muted,
  speed,
  speedOptions,
  onPlay,
  onPause,
  onToggleMute,
  onVolumeChange,
  onSpeedChange,
}: {
  disabled: boolean;
  volume: number;
  muted: boolean;
  speed: number;
  speedOptions: readonly number[];
  onPlay: () => void;
  onPause: () => void;
  onToggleMute: () => void;
  onVolumeChange: (volume: number) => void;
  onSpeedChange: (speed: number) => void;
}): JSX.Element {
  const { t } = useTranslation("accounts");
  const speedSelectId = useId();
  return (
    <>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onPlay}>
        {t("youtubeManagement.player.play", "Play")}
      </Button>
      <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onPause}>
        {t("youtubeManagement.player.pause", "Pause")}
      </Button>
      <div dir="ltr" className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={disabled} onClick={onToggleMute}>
          {muted
            ? t("youtubeManagement.player.unmute", "Unmute")
            : t("youtubeManagement.player.mute", "Mute")}
        </Button>
        <input
          type="range"
          min={0}
          max={100}
          value={volume}
          disabled={disabled}
          aria-label={t("youtubeManagement.player.volume", "Volume")}
          onChange={(event) => onVolumeChange(Number(event.target.value))}
          className="w-24"
        />
        <span className="text-xs tabular-nums">{volume}</span>
      </div>
      <div dir="ltr" className="flex items-center gap-2">
        <label htmlFor={speedSelectId} className="text-xs">
          {t("youtubeManagement.player.speed", "Speed")}
        </label>
        <select
          id={speedSelectId}
          value={speed}
          disabled={disabled}
          onChange={(event) => onSpeedChange(Number(event.target.value))}
          className="rounded-md border bg-background px-2 py-1 text-xs"
        >
          {speedOptions.map((rate) => (
            <option key={rate} value={rate}>{rate}x</option>
          ))}
        </select>
      </div>
    </>
  );
}

/** The size the creator asked for. */
function SizeModeButtons({
  activeMode,
  onChoose,
}: {
  activeMode: YouTubePlayerSizeMode;
  onChoose: (mode: YouTubePlayerSizeMode) => void;
}): JSX.Element {
  const { t } = useTranslation("accounts");
  return (
    <div className="flex items-center gap-1">
      <Button
        type="button"
        size="sm"
        variant={activeMode === "compact" ? "default" : "outline"}
        aria-pressed={activeMode === "compact"}
        onClick={() => onChoose("compact")}
      >
        {t("youtubeManagement.player.sizeCompact", "Compact")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant={activeMode === "theater" ? "default" : "outline"}
        aria-pressed={activeMode === "theater"}
        onClick={() => onChoose("theater")}
      >
        {t("youtubeManagement.player.sizeTheater", "Theater")}
      </Button>
      <Button
        type="button"
        size="sm"
        variant={activeMode === "mini" ? "default" : "outline"}
        aria-pressed={activeMode === "mini"}
        onClick={() => onChoose("mini")}
      >
        {t("youtubeManagement.player.sizeMini", "Mini")}
      </Button>
    </div>
  );
}

/**
 * The embedded player of one published video (spec §14.1.2).
 *
 * The iframe is mounted only after the creator presses Play, and the toolbar
 * below it drives the embed over the postMessage API. Every message is
 * accepted only from the embed's own origin and only from the frame that is
 * mounted, and nothing a message carries is ever rendered as markup.
 */
export function YouTubeVideoPlayer({
  videoId,
  title,
  thumbnailUrl,
  durationIso8601,
  privacyStatus,
  uploadStatus,
  sizeMode,
  onSizeModeChange,
}: YouTubeVideoPlayerProps): JSX.Element {
  const { t } = useTranslation("accounts");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const handshakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playerInfo, setPlayerInfo] = useState<YouTubePlayerInfo | null>(null);
  const [handshakeFailed, setHandshakeFailed] = useState(false);
  const [volume, setVolume] = useState(100);
  const [muted, setMuted] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [fallbackSizeMode, setFallbackSizeMode] = useState<YouTubePlayerSizeMode>("compact");

  const activeSizeMode = sizeMode ?? fallbackSizeMode;
  const embedUrl = buildYouTubeEmbedUrl(videoId, window.location.origin);
  const watchUrl = buildYouTubeWatchUrl(videoId);
  const durationLabel = formatIsoDuration(durationIso8601);

  const clearHandshakeTimer = useCallback(() => {
    if (handshakeTimerRef.current !== null) {
      clearTimeout(handshakeTimerRef.current);
      handshakeTimerRef.current = null;
    }
  }, []);

  // A report is only a report when it comes from the embed's own origin and
  // from the frame that is mounted right now; anything else is ignored.
  useEffect(() => {
    if (!playing) return;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== YOUTUBE_EMBED_ORIGIN) return;
      const frame = iframeRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const parsed = parsePlayerMessage(event.data);
      if (!parsed) return;
      setPlayerInfo((current) => ({ ...current, ...parsed }));
      setHandshakeFailed(false);
      clearHandshakeTimer();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [playing, clearHandshakeTimer]);

  useEffect(() => clearHandshakeTimer, [clearHandshakeTimer]);

  // The shown speed and volume follow what the player reports, not what the
  // toolbar last asked for.
  useEffect(() => {
    if (playerInfo?.playbackRate !== undefined) setSpeed(playerInfo.playbackRate);
  }, [playerInfo?.playbackRate]);

  useEffect(() => {
    if (playerInfo?.volume !== undefined) setVolume(playerInfo.volume);
    if (playerInfo?.muted !== undefined) setMuted(playerInfo.muted);
  }, [playerInfo?.volume, playerInfo?.muted]);

  const speedOptions = useMemo(() => {
    const reported = playerInfo?.availablePlaybackRates;
    if (!reported || reported.length === 0) return YOUTUBE_PLAYBACK_RATES;
    return reported.includes(speed) ? reported : [...reported, speed].sort((a, b) => a - b);
  }, [playerInfo?.availablePlaybackRates, speed]);

  const sendCommand = useCallback((func: YouTubePlayerCommand, args: readonly (number | string | boolean)[] = []) => {
    const frame = iframeRef.current;
    if (!frame?.contentWindow) return;
    frame.contentWindow.postMessage(playerCommand(func, args), YOUTUBE_EMBED_ORIGIN);
  }, []);

  const handleFrameLoad = useCallback(() => {
    const frame = iframeRef.current;
    if (!frame?.contentWindow) return;
    // The embed stays silent until the parent says it is listening.
    frame.contentWindow.postMessage(buildYouTubeListeningMessage(), YOUTUBE_EMBED_ORIGIN);
    clearHandshakeTimer();
    setHandshakeFailed(false);
    handshakeTimerRef.current = setTimeout(() => setHandshakeFailed(true), HANDSHAKE_TIMEOUT_MS);
  }, [clearHandshakeTimer]);

  const handlePlay = () => {
    if (!playing) {
      setPlaying(true);
      return;
    }
    sendCommand("playVideo");
  };

  const handleStop = () => {
    sendCommand("stopVideo");
    clearHandshakeTimer();
    // Unmounting the frame ends the connection to YouTube and returns the
    // poster, so nothing keeps playing out of sight.
    setPlaying(false);
    setHandshakeFailed(false);
    setPlayerInfo(null);
  };

  const handleVolumeChange = (next: number) => {
    setVolume(next);
    sendCommand("setVolume", [next]);
  };

  const handleToggleMute = () => {
    const nextMuted = !muted;
    setMuted(nextMuted);
    sendCommand(nextMuted ? "mute" : "unMute");
  };

  const handleSpeedChange = (next: number) => {
    sendCommand("setPlaybackRate", [next]);
  };

  const chooseSizeMode = (mode: YouTubePlayerSizeMode) => {
    setFallbackSizeMode(mode);
    onSizeModeChange?.(mode);
  };

  const privateNotice = privacyStatus === "private"
    ? t(
      "youtubeManagement.player.privateNotice",
      "This video is private. It plays here only if this browser is signed in to the Google account that owns it. Otherwise open it on YouTube.",
    )
    : null;
  const processingNotice = uploadStatus && uploadStatus !== "processed"
    ? t("youtubeManagement.player.processingNotice", "YouTube may still be processing this video.")
    : null;
  const fullscreenAvailable = typeof document === "undefined" || document.fullscreenEnabled !== false;

  const outerClass = activeSizeMode === "mini"
    ? "space-y-2 sticky top-0 z-10 bg-background pb-2"
    : "space-y-2";
  const playerBoxClass = activeSizeMode === "mini"
    ? "relative h-[200px] w-[356px] max-w-full min-h-[200px] min-w-[200px] sticky top-0 z-10 overflow-hidden rounded-md border bg-muted"
    : "relative aspect-video w-full min-h-[200px] min-w-[200px] overflow-hidden rounded-md border bg-muted";

  return (
    <div className={outerClass}>
      <div ref={wrapperRef} className="space-y-2">
        <div className={playerBoxClass}>
          {playing && embedUrl ? (
            <iframe
              ref={iframeRef}
              src={embedUrl}
              title={title}
              allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
              allowFullScreen
              referrerPolicy="strict-origin-when-cross-origin"
              onLoad={handleFrameLoad}
              className="h-full w-full border-0"
            />
          ) : (
            <PlayerPoster
              thumbnailUrl={thumbnailUrl}
              durationLabel={durationLabel}
              canPlay={embedUrl !== null}
              privateNotice={privateNotice}
              privacyNote={t(
                "youtubeManagement.player.privacyNote",
                "Click Play to load the video from youtube-nocookie.com",
              )}
              onPlay={handlePlay}
            />
          )}
        </div>

        <div
          role="toolbar"
          aria-label={t("youtubeManagement.player.toolbar", "Video playback controls")}
          className="flex flex-wrap items-center gap-2"
        >
          {handshakeFailed ? (
            <p className="text-xs text-muted-foreground">
              {t("youtubeManagement.player.useNativeControls", "Use the controls inside the video player.")}
            </p>
          ) : (
            <PlaybackControls
              disabled={embedUrl === null}
              volume={volume}
              muted={muted}
              speed={speed}
              speedOptions={speedOptions}
              onPlay={handlePlay}
              onPause={() => sendCommand("pauseVideo")}
              onToggleMute={handleToggleMute}
              onVolumeChange={handleVolumeChange}
              onSpeedChange={handleSpeedChange}
            />
          )}

          <Button type="button" size="sm" variant="outline" disabled={embedUrl === null} onClick={handleStop}>
            {t("youtubeManagement.player.stop", "Stop")}
          </Button>

          <SizeModeButtons activeMode={activeSizeMode} onChoose={chooseSizeMode} />

          <span className="text-xs text-muted-foreground">
            {t("youtubeManagement.player.qualityHint", "Change quality from the gear menu in the player")}
            {playerInfo?.playbackQuality ? ` · ${playerInfo.playbackQuality}` : ""}
          </span>

          {fullscreenAvailable ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void wrapperRef.current?.requestFullscreen?.().catch(() => {})}
            >
              {t("youtubeManagement.player.fullscreen", "Fullscreen")}
            </Button>
          ) : null}

          {watchUrl ? (
            <>
              <a
                href={watchUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center rounded-md border px-3 py-1.5 text-sm font-medium hover:bg-accent"
              >
                {t("youtubeManagement.player.openOnYouTube", "Open on YouTube")}
              </a>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => window.open(watchUrl, "_blank", "noopener,noreferrer,width=960,height=600")}
              >
                {t("youtubeManagement.player.popOut", "Pop out")}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      {privateNotice ? <p className="text-xs text-muted-foreground">{privateNotice}</p> : null}
      {processingNotice ? <p className="text-xs text-muted-foreground">{processingNotice}</p> : null}
    </div>
  );
}
