/**
 * The embedded YouTube player of the `/youtube` drawer (spec §14.1.2).
 *
 * Pure rules only: no React, no DOM, no Supabase. The embed URL, the
 * postMessage handshake and the defensive parsing of the player's reports all
 * live here, so the component holds no provider knowledge and the rules can be
 * tested without a browser.
 */

/** A YouTube video id is exactly eleven URL-safe characters. */
export const YOUTUBE_VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{11}$/;

/**
 * The privacy-enhanced embed host.
 *
 * It is also the only origin the parent posts to and the only origin it
 * accepts a report from: a message from anywhere else is not the player.
 */
export const YOUTUBE_EMBED_ORIGIN = "https://www.youtube-nocookie.com";

/** The playback rates the speed control offers. */
export const YOUTUBE_PLAYBACK_RATES = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** How large the player is drawn inside the drawer. */
export type YouTubePlayerSizeMode = "compact" | "theater" | "mini";

/**
 * The largest message the parent accepts from the embed.
 *
 * A report is a few dozen bytes; anything bigger is not a report and is
 * refused before it is parsed.
 */
export const PLAYER_MESSAGE_MAX_BYTES = 16 * 1024;

/** The events the embed uses to describe its own state. */
const PLAYER_REPORT_EVENTS = new Set(["infoDelivery", "initialDelivery", "onStateChange", "onReady"]);

/** The command names the parent may send to the embed. */
export type YouTubePlayerCommand =
  | "playVideo"
  | "pauseVideo"
  | "stopVideo"
  | "mute"
  | "unMute"
  | "setVolume"
  | "setPlaybackRate";

/** The state the embed reports back about the video it plays. */
export interface YouTubePlayerInfo {
  playerState?: number;
  volume?: number;
  muted?: boolean;
  playbackRate?: number;
  availablePlaybackRates?: number[];
  playbackQuality?: string;
}

/** An origin is a scheme, a host and a port — never a path or a query. */
function isHttpOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.pathname === "/" && url.search === "" && url.hash === "";
}

/**
 * The embed URL of one video.
 *
 * `null` when the id is not a video id or the page origin is not an origin:
 * the caller then keeps the poster and offers no Play button at all, because
 * an embed URL built from an unproven id is a request to a host that has no
 * such video.
 *
 * `origin` accompanies `enablejsapi=1` because the embed uses it to decide
 * which page may talk to it. `modestbranding` is deliberately absent: it is
 * deprecated and has no effect.
 */
export function buildYouTubeEmbedUrl(videoId: string, pageOrigin: string): string | null {
  if (!YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) return null;
  if (!isHttpOrigin(pageOrigin)) return null;
  return `${YOUTUBE_EMBED_ORIGIN}/embed/${videoId}`
    + "?enablejsapi=1&playsinline=1&rel=0&autoplay=1"
    + `&origin=${encodeURIComponent(pageOrigin)}`;
}

/**
 * The watch URL of one video, used by "Open on YouTube" and the pop-out.
 *
 * It is built from the id alone, never from a string a message carried.
 */
export function buildYouTubeWatchUrl(videoId: string): string | null {
  if (!YOUTUBE_VIDEO_ID_PATTERN.test(videoId)) return null;
  return `https://www.youtube.com/watch?v=${videoId}`;
}

/**
 * The message that starts the embed's reports.
 *
 * The embed stays silent until the parent says it is listening; the shape is
 * the one Google's own wrapper uses.
 */
export function buildYouTubeListeningMessage(): string {
  return JSON.stringify({ event: "listening", id: 1, channel: "widget" });
}

/** One command for the embed. */
export function playerCommand(
  func: YouTubePlayerCommand,
  args: readonly (number | string | boolean)[] = [],
): string {
  return JSON.stringify({ event: "command", func, args, id: 1, channel: "widget" });
}

/** Reads a string or an object into the record shape the parser expects. */
function toMessageRecord(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "string") {
    if (new TextEncoder().encode(raw).byteLength > PLAYER_MESSAGE_MAX_BYTES) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, unknown>;
  return null;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The volume the player reports, when it is one it could actually be. */
function readVolume(value: unknown): number | undefined {
  if (!isFiniteNumber(value) || value < 0 || value > 100) return undefined;
  return value;
}

/** The rate the player reports, when the control offers it. */
function readPlaybackRate(value: unknown): number | undefined {
  if (!isFiniteNumber(value)) return undefined;
  return (YOUTUBE_PLAYBACK_RATES as readonly number[]).includes(value) ? value : undefined;
}

/** The rates this video can play at, when the player reported any. */
function readAvailablePlaybackRates(value: unknown): number[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rates = value
    .slice(0, 32)
    .filter((rate): rate is number => isFiniteNumber(rate) && rate >= 0.25 && rate <= 2);
  return rates.length > 0 ? rates : undefined;
}

/** The quality label the player reports, when it is a plain label. */
function readPlaybackQuality(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 32) return undefined;
  return /^[A-Za-z0-9]+$/.test(value) ? value : undefined;
}

/**
 * Reads one report from the embed.
 *
 * The report is untrusted input from another origin: only the fields the
 * player actually publishes are read, each one is range-checked, and anything
 * that is not a report yields `null` instead of a half-filled object.
 */
export function parsePlayerMessage(raw: unknown): YouTubePlayerInfo | null {
  const message = toMessageRecord(raw);
  if (message === null) return null;
  const event = message.event;
  if (typeof event !== "string" || !PLAYER_REPORT_EVENTS.has(event)) return null;
  const info = message.info;
  if (!info || typeof info !== "object" || Array.isArray(info)) return null;
  const record = info as Record<string, unknown>;

  const parsed: YouTubePlayerInfo = {};
  if (isFiniteNumber(record.playerState)) parsed.playerState = record.playerState;
  const volume = readVolume(record.volume);
  if (volume !== undefined) parsed.volume = volume;
  if (typeof record.muted === "boolean") parsed.muted = record.muted;
  const playbackRate = readPlaybackRate(record.playbackRate);
  if (playbackRate !== undefined) parsed.playbackRate = playbackRate;
  const availablePlaybackRates = readAvailablePlaybackRates(record.availablePlaybackRates);
  if (availablePlaybackRates !== undefined) parsed.availablePlaybackRates = availablePlaybackRates;
  const playbackQuality = readPlaybackQuality(record.playbackQuality);
  if (playbackQuality !== undefined) parsed.playbackQuality = playbackQuality;

  return Object.keys(parsed).length > 0 ? parsed : null;
}
