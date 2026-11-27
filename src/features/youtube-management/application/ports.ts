import type {
  YouTubeAccountCapabilities,
  YouTubeCategoryOption,
  YouTubeChannelDetails,
  YouTubePlaylistsPage,
  YouTubeResourceSuccess,
  YouTubeVideoDetails,
  YouTubeVideosPage,
} from "../domain/types";

// The port the query hooks depend on (ARCHITECTURE.md §4: application never
// imports infrastructure; the adapter arrives as this interface).
export interface YouTubeResourcesGateway {
  getCapabilities(accountId: string): Promise<YouTubeResourceSuccess<YouTubeAccountCapabilities>>;
  getEditSnapshot?(params: { accountId: string; videoId: string }): Promise<YouTubeResourceSuccess<{
    revision: string;
    values: { title: string; privacyStatus: string; categoryId: string | null };
  }>>;
  updateVideo?(params: {
    accountId: string;
    videoId: string;
    baseRevision: string;
    changes: {
      title?: string;
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
  getVideo(params: { accountId: string; videoId: string }): Promise<YouTubeResourceSuccess<YouTubeVideoDetails>>;
}
