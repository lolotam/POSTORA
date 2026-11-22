import type {
  YouTubeAccountCapabilities,
  YouTubeCategoryOption,
  YouTubeChannelDetails,
  YouTubeResourceSuccess,
  YouTubeVideoDetails,
  YouTubeVideosPage,
} from "../domain/types";

// The port the query hooks depend on (ARCHITECTURE.md §4: application never
// imports infrastructure; the adapter arrives as this interface).
export interface YouTubeResourcesGateway {
  getCapabilities(accountId: string): Promise<YouTubeResourceSuccess<YouTubeAccountCapabilities>>;
  getCategories?(params: { accountId: string; region?: string; locale?: string }): Promise<YouTubeResourceSuccess<{
    region: string;
    locale: string;
    categories: YouTubeCategoryOption[];
  }>>;
  getChannel(accountId: string): Promise<YouTubeResourceSuccess<YouTubeChannelDetails>>;
  listVideos(params: { accountId: string; pageToken?: string | null }): Promise<YouTubeResourceSuccess<YouTubeVideosPage>>;
  getVideo(params: { accountId: string; videoId: string }): Promise<YouTubeResourceSuccess<YouTubeVideoDetails>>;
}
