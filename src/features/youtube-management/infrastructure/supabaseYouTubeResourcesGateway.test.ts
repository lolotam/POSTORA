import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import {
  EXAMPLE_ACCOUNT_ID,
  EXAMPLE_PAGE_TOKEN,
  EXAMPLE_VIDEO_ID,
  YOUTUBE_RESOURCE_REQUEST_EXAMPLES,
} from "../../../../supabase/functions/youtube-resources/requestExamples.fixture";
import { YouTubeResourceError } from "../domain/errors";
import { SupabaseYouTubeResourcesGateway } from "./supabaseYouTubeResourcesGateway";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: vi.fn() } },
}));

const envelope = <T,>(data: T) => ({
  schema_version: 1 as const,
  request_id: "req-1",
  freshness: { fetched_at: "2026-11-20T10:00:00.000Z", source: "provider" as const },
  data,
});

function validDataFor(operation: string): Record<string, unknown> {
  if (operation === "capabilities") {
    return {
      account_id: EXAMPLE_ACCOUNT_ID,
      channel_id: "UC",
      channel_title: "Channel",
      provider: "native",
      connection: "ok",
      scopes: { readonly: "granted", upload: "granted", force_ssl: "granted" },
      capabilities: { browse: { state: "available" }, upload: { state: "available" }, comments: { state: "available" } },
      quota: {
        provider_quota: "not_tracked",
        unit_costs: { channel: 1, videos_page: 2, video: 1, playlists_page: 1 },
        per_user_burst: { limit: 30, window_seconds: 600 },
        per_user_daily: { limit: 300, window_seconds: 86400 },
      },
    };
  }
  if (operation === "channel") {
    return {
      id: "UC", title: "Channel", description: "", custom_url: null, thumbnail_url: null,
      published_at: null, country: null, privacy_status: "public",
      statistics: { view_count: 1, subscriber_count: 1, subscriber_count_hidden: false, video_count: 1 },
    };
  }
  if (operation === "videos") return { items: [], next_page_token: null };
  return {
    id: EXAMPLE_VIDEO_ID, channel_id: "UC", title: "t", description: "", thumbnail_url: null, published_at: null,
    tags: [], category_id: null, default_language: null, duration_iso8601: null, privacy_status: "public",
    upload_status: null, made_for_kids: null, statistics: { view_count: null, like_count: null, comment_count: null },
    url: "https://www.youtube.com/watch?v=x",
  };
}

describe("YouTube resources gateway", () => {
  beforeEach(() => vi.resetAllMocks());

  it("asks for a page of videos with the account, the size and the cursor, and no user id", async () => {
    const page = envelope({ items: [], next_page_token: null, total_results: 0 });
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: page, error: null });

    const received = await new SupabaseYouTubeResourcesGateway().listVideos({ accountId: "acc-1", pageToken: "PAGE2" });

    expect(supabase.functions.invoke).toHaveBeenCalledWith("youtube-resources", {
      body: { operation: "videos", account_id: "acc-1", page_token: "PAGE2" },
      timeout: 15000,
    });
    expect(received).toEqual(page);
  });

  it("omits the cursor on the first page", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: envelope({ items: [], next_page_token: null, total_results: 0 }),
      error: null,
    });
    await new SupabaseYouTubeResourcesGateway().listVideos({ accountId: "acc-1", pageToken: null });
    expect(supabase.functions.invoke).toHaveBeenCalledWith("youtube-resources", {
      body: { operation: "videos", account_id: "acc-1" },
      timeout: 15000,
    });
  });

  it("asks for a page of playlists with the account and the cursor, and no user id", async () => {
    const page = envelope({ items: [{ id: "PL1", title: "Launch", privacy_status: "private", thumbnail_url: null }], next_page_token: null });
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: page, error: null });

    const received = await new SupabaseYouTubeResourcesGateway().listPlaylists({ accountId: "acc-1", pageToken: "PAGE2" });

    expect(supabase.functions.invoke).toHaveBeenCalledWith("youtube-resources", {
      body: { operation: "playlists", account_id: "acc-1", page_token: "PAGE2" },
      timeout: 15000,
    });
    expect(received).toEqual(page);
  });

  it("omits the playlist cursor on the first page", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: envelope({ items: [], next_page_token: null }),
      error: null,
    });
    await new SupabaseYouTubeResourcesGateway().listPlaylists({ accountId: "acc-1" });
    expect(supabase.functions.invoke).toHaveBeenCalledWith("youtube-resources", {
      body: { operation: "playlists", account_id: "acc-1" },
      timeout: 15000,
    });
  });

  it("rejects a playlist page without an items list", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: envelope({ next_page_token: null }),
      error: null,
    });
    await expect(new SupabaseYouTubeResourcesGateway().listPlaylists({ accountId: "acc-1" }))
      .rejects.toMatchObject({ code: "upstream_unavailable" });
  });

  it("sends exactly the request bodies the edge handler's shared examples define", async () => {
    vi.mocked(supabase.functions.invoke).mockImplementation(async (_fn, options) => ({
      data: envelope(validDataFor((options?.body as { operation: string }).operation)),
      error: null,
    }));
    const gateway = new SupabaseYouTubeResourcesGateway();

    await gateway.getCapabilities(EXAMPLE_ACCOUNT_ID);
    await gateway.getChannel(EXAMPLE_ACCOUNT_ID);
    await gateway.listVideos({ accountId: EXAMPLE_ACCOUNT_ID });
    await gateway.listVideos({ accountId: EXAMPLE_ACCOUNT_ID, pageToken: EXAMPLE_PAGE_TOKEN });
    await gateway.getVideo({ accountId: EXAMPLE_ACCOUNT_ID, videoId: EXAMPLE_VIDEO_ID });

    const sent = vi.mocked(supabase.functions.invoke).mock.calls.map((call) => call[1]?.body);
    expect(sent).toEqual([
      YOUTUBE_RESOURCE_REQUEST_EXAMPLES.capabilities,
      YOUTUBE_RESOURCE_REQUEST_EXAMPLES.channel,
      YOUTUBE_RESOURCE_REQUEST_EXAMPLES.videosFirstPage,
      YOUTUBE_RESOURCE_REQUEST_EXAMPLES.videosNextPage,
      YOUTUBE_RESOURCE_REQUEST_EXAMPLES.video,
    ]);
    for (const call of vi.mocked(supabase.functions.invoke).mock.calls) {
      expect(call[1]?.timeout).toBe(15000);
    }
  });

  it("rejects a malformed {} answer for every operation", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: envelope({}), error: null });
    const gateway = new SupabaseYouTubeResourcesGateway();

    await expect(gateway.getCapabilities(EXAMPLE_ACCOUNT_ID)).rejects.toMatchObject({ code: "upstream_unavailable" });
    await expect(gateway.getChannel(EXAMPLE_ACCOUNT_ID)).rejects.toMatchObject({ code: "upstream_unavailable" });
    await expect(gateway.listVideos({ accountId: EXAMPLE_ACCOUNT_ID })).rejects.toMatchObject({ code: "upstream_unavailable" });
    await expect(gateway.getVideo({ accountId: EXAMPLE_ACCOUNT_ID, videoId: EXAMPLE_VIDEO_ID })).rejects.toMatchObject({ code: "upstream_unavailable" });
  });

  it("accepts a valid empty page that still carries a cursor", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: envelope({ items: [], next_page_token: "PAGE2" }),
      error: null,
    });
    const received = await new SupabaseYouTubeResourcesGateway().listVideos({ accountId: "acc-1" });
    expect(received.data).toEqual({ items: [], next_page_token: "PAGE2" });
  });

  it("converts a timed-out invoke into upstream_unavailable", async () => {
    vi.mocked(supabase.functions.invoke).mockRejectedValue(
      Object.assign(new Error("The operation was aborted due to timeout"), { name: "FunctionsFetchError" }),
    );
    await expect(new SupabaseYouTubeResourcesGateway().getChannel("acc-1"))
      .rejects.toMatchObject({ code: "upstream_unavailable" });
  });

  it("turns a refusal into the server's stable code", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: Object.assign(new Error("Edge Function returned a non-2xx status code"), {
        context: Response.json({ error: "quota_exceeded", request_id: "req-2" }, { status: 429 }),
      }),
    });
    const failure = await new SupabaseYouTubeResourcesGateway().getChannel("acc-1").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(YouTubeResourceError);
    expect((failure as YouTubeResourceError).code).toBe("quota_exceeded");
  });

  it("treats a failure without a readable body as upstream_unavailable", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: null, error: new Error("network down") });
    await expect(new SupabaseYouTubeResourcesGateway().getVideo({ accountId: "acc-1", videoId: "videoAAAAAAA" }))
      .rejects.toMatchObject({ code: "upstream_unavailable" });
  });

  it("treats an empty success as a failure, never as an empty resource", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: null, error: null });
    await expect(new SupabaseYouTubeResourcesGateway().getCapabilities("acc-1"))
      .rejects.toMatchObject({ code: "upstream_unavailable" });
  });

  it("sends the set_thumbnail operation with the account, the video and the media id, and no user id", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: envelope({ video_id: EXAMPLE_VIDEO_ID, applied: true }),
      error: null,
    });

    const received = await new SupabaseYouTubeResourcesGateway().setThumbnail({
      accountId: "acc-1",
      videoId: EXAMPLE_VIDEO_ID,
      mediaFileId: "media-1",
    });

    expect(supabase.functions.invoke).toHaveBeenCalledWith("youtube-resources", {
      body: {
        operation: "set_thumbnail",
        account_id: "acc-1",
        video_id: EXAMPLE_VIDEO_ID,
        media_file_id: "media-1",
      },
      timeout: 15000,
    });
    expect(received.data).toEqual({ video_id: EXAMPLE_VIDEO_ID, applied: true });
  });

  it.each([
    ["an answer for another video", { video_id: "another-video", applied: true }],
    ["an answer that does not say the write was applied", { video_id: EXAMPLE_VIDEO_ID, applied: false }],
  ])("rejects a thumbnail answer with %s", async (_scenario, data) => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: envelope(data), error: null });
    await expect(new SupabaseYouTubeResourcesGateway().setThumbnail({
      accountId: "acc-1",
      videoId: EXAMPLE_VIDEO_ID,
      mediaFileId: "media-1",
    })).rejects.toMatchObject({ code: "upstream_unavailable" });
  });

  it("turns a thumbnail refusal into the server's stable code", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: Object.assign(new Error("Edge Function returned a non-2xx status code"), {
        context: Response.json({ error: "thumbnail_not_allowed", request_id: "req-3" }, { status: 403 }),
      }),
    });
    const failure = await new SupabaseYouTubeResourcesGateway()
      .setThumbnail({ accountId: "acc-1", videoId: EXAMPLE_VIDEO_ID, mediaFileId: "media-1" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(YouTubeResourceError);
    expect((failure as YouTubeResourceError).code).toBe("thumbnail_not_allowed");
  });
});
