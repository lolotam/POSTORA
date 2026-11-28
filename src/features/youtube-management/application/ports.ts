import type {
  YouTubeAccountCapabilities,
  YouTubeCategoryOption,
  YouTubeChannelDetails,
  YouTubeCaptionFormat,
  YouTubeCaptionsListData,
  YouTubeCreatePlaylistData,
  YouTubePlaylistsPage,
  YouTubeResourceSuccess,
  YouTubeSetThumbnailResult,
  YouTubeUploadCaptionData,
  YouTubeVideoDetails,
  YouTubeVideosPage,
} from "../domain/types";
import type { YouTubeThumbnailCandidate } from "../domain/thumbnail";

// The port the query hooks depend on (ARCHITECTURE.md §4: application never
// imports infrastructure; the adapter arrives as this interface).
export interface YouTubeResourcesGateway {
  getCapabilities(accountId: string): Promise<YouTubeResourceSuccess<YouTubeAccountCapabilities>>;
  getEditSnapshot?(params: { accountId: string; videoId: string }): Promise<YouTubeResourceSuccess<{
    revision: string;
    values: {
      title: string;
      description?: string;
      tags?: string[];
      privacyStatus: string;
      categoryId: string | null;
    };
  }>>;
  updateVideo?(params: {
    accountId: string;
    videoId: string;
    baseRevision: string;
    changes: {
      title?: string;
      description?: string;
      tags?: string[];
      category_id?: string;
      privacy_status?: "private" | "unlisted" | "public";
    };
    privacyConfirmation?: { to: "private" | "unlisted" | "public" };
  }): Promise<YouTubeResourceSuccess<{ revision: string }>>;
  getCategories?(params: { accountId: string; region?: string; locale?: string }): Promise<YouTubeResourceSuccess<{
    region: string;
    locale: string;
    categories: YouTubeCategoryOption[];
  }>>;
  getChannel(accountId: string): Promise<YouTubeResourceSuccess<YouTubeChannelDetails>>;
  listVideos(params: { accountId: string; pageToken?: string | null }): Promise<YouTubeResourceSuccess<YouTubeVideosPage>>;
  /** The playlists of the account's own channel, one page at a time. */
  listPlaylists?(params: { accountId: string; pageToken?: string | null }): Promise<YouTubeResourceSuccess<YouTubePlaylistsPage>>;
  /**
   * Creates one playlist on the account's own channel (`playlists.insert`).
   * Requires `youtube.force-ssl` and costs 50 provider units.
   */
  createPlaylist?(params: {
    accountId: string;
    title: string;
    description?: string;
    privacyStatus: "public" | "unlisted" | "private";
  }): Promise<YouTubeResourceSuccess<YouTubeCreatePlaylistData>>;
  getVideo(params: { accountId: string; videoId: string }): Promise<YouTubeResourceSuccess<YouTubeVideoDetails>>;
  /**
   * Replaces the thumbnail of an already published video with an image the
   * creator already owns. The server resolves the media row by id and owner,
   * so no URL ever crosses the wire.
   */
  setThumbnail?(params: {
    accountId: string;
    videoId: string;
    mediaFileId: string;
  }): Promise<YouTubeResourceSuccess<YouTubeSetThumbnailResult>>;
  /**
   * The caption tracks of one owned video. Every list costs 50 provider
   * units, so the caller asks for it explicitly and never on open.
   */
  listCaptions?(params: { accountId: string; videoId: string }): Promise<YouTubeResourceSuccess<YouTubeCaptionsListData>>;
  /**
   * Adds one caption track to an owned video. The text is the caption file
   * itself, read as UTF-8 in the browser and capped at 512 KB there before
   * the request leaves the page.
   */
  uploadCaption?(params: {
    accountId: string;
    videoId: string;
    language: string;
    name: string;
    format: YouTubeCaptionFormat;
    content: string;
  }): Promise<YouTubeResourceSuccess<YouTubeUploadCaptionData>>;
}

/**
 * The creator's own media-library images, so the thumbnail picker can offer a
 * file Postora already stores. Deliberately a separate port: this reads the
 * creator's library, not the channel's YouTube resources.
 */
export interface YouTubeThumbnailMediaGateway {
  listOwnedImages(params: { userId: string }): Promise<YouTubeThumbnailCandidate[]>;
  /**
   * Stores one image the creator picked on this device and returns it as a
   * candidate of the same library.
   *
   * The owner is read from the session by the adapter, never from a
   * parameter: the browser writes under the creator's own JWT, so the
   * adapter has no owner to be told.
   */
  uploadOwnedImage?(params: {
    blob: Blob;
    fileName: string;
    mimeType: "image/jpeg" | "image/png";
  }): Promise<YouTubeThumbnailCandidate>;
}

/**
 * Generates a thumbnail image with the app's own image generator.
 *
 * The generated image is a starting point, not the file that reaches
 * YouTube: it is materialised in the browser and stored like any other owned
 * image first.
 */
export interface YouTubeThumbnailAiGateway {
  generate(params: {
    prompt: string;
    referenceImage?: string;
    referenceImages?: readonly string[];
    signal?: AbortSignal;
  }): Promise<{ imageUrl: string }>;
}

export interface YouTubePackagingScoreResult {
  overall_score: number;
  breakdown: {
    hook: number;
    clarity: number;
    mobile_length: number;
    thumbnail_synergy: number | null;
  };
  strengths: string[];
  fixes: string[];
  better_titles: [string, string, string];
}

export interface YouTubePackagingScoreGateway {
  scorePackaging(params: {
    title: string;
    thumbnailText?: string;
    description?: string;
    language: "english" | "arabic";
  }): Promise<YouTubePackagingScoreResult>;
}
