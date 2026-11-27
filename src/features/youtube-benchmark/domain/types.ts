/**
 * The YouTube public channel benchmark contract.
 *
 * The authoritative definition lives with the edge function that answers the
 * read (`supabase/functions/youtube-channel-benchmark/contracts.ts`) and is
 * re-exported here (ARCHITECTURE.md §22): the browser and the server must
 * never disagree about a channel's state, a failure's code, or what a valid
 * channel input is.
 *
 * Pure TypeScript: no React, no Supabase client, no browser API.
 */

export {
  YOUTUBE_BENCHMARK_CHANNEL_ID_PATTERN,
  YOUTUBE_BENCHMARK_HANDLE_PATTERN,
  YOUTUBE_BENCHMARK_MAX_CHANNELS,
} from "../../../../supabase/functions/youtube-channel-benchmark/contracts";

export type {
  YouTubeBenchmarkChannel,
  YouTubeBenchmarkChannelErrorCode,
  YouTubeBenchmarkChannelStatus,
  YouTubeBenchmarkErrorCode,
  YouTubeBenchmarkRecentVideo,
  YouTubeBenchmarkResponseData,
  YouTubeBenchmarkSuccess,
} from "../../../../supabase/functions/youtube-channel-benchmark/contracts";
