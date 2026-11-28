// Request bodies both sides agree on. The Deno handler test proves the handler accepts each one;
// the Vitest gateway test proves the browser sends each one. Keep it import-free.
export const EXAMPLE_ACCOUNT_ID = "0ee20001-0000-4000-8000-000000000021";
export const EXAMPLE_VIDEO_ID = "videoAAAAAAA";
export const EXAMPLE_PAGE_TOKEN = "CAUQAA";

export const YOUTUBE_RESOURCE_REQUEST_EXAMPLES = {
  capabilities: { operation: "capabilities", account_id: EXAMPLE_ACCOUNT_ID },
  channel: { operation: "channel", account_id: EXAMPLE_ACCOUNT_ID },
  videosFirstPage: { operation: "videos", account_id: EXAMPLE_ACCOUNT_ID },
  videosNextPage: { operation: "videos", account_id: EXAMPLE_ACCOUNT_ID, page_token: EXAMPLE_PAGE_TOKEN },
  video: { operation: "video", account_id: EXAMPLE_ACCOUNT_ID, video_id: EXAMPLE_VIDEO_ID },
  createPlaylist: {
    operation: "create_playlist",
    account_id: EXAMPLE_ACCOUNT_ID,
    title: "Product Launches",
    description: "Official release videos",
    privacy_status: "unlisted",
  },
} as const;
