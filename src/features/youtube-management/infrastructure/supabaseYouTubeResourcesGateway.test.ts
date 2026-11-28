import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import {
  EXAMPLE_ACCOUNT_ID,
  EXAMPLE_PAGE_TOKEN,
  EXAMPLE_VIDEO_ID,
  YOUTUBE_RESOURCE_REQUEST_EXAMPLES,
} from "../../../../supabase/functions/youtube-resources/requestExamples.fixture";
import { YouTubeResourceError } from "../domain/errors";
import { CAPTION_CONTENT_MAX_BYTES } from "../domain/types";
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
        unit_costs: {
          channel: 1,
          videos_page: 2,
          video: 1,
          playlists_page: 1,
          captions_list: 50,
          caption_upload: 400,
        },
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

  it.each([
    ["a non-record item", null],
    ["a missing id", { title: "Valid title" }],
    ["an empty id", { id: "", title: "Valid title" }],
    ["a non-string id", { id: 123, title: "Valid title" }],
    ["a missing title", { id: "vid-1" }],
    ["a non-string title", { id: "vid-1", title: 456 }],
    ["a non-string description", { id: "vid-1", title: "Valid title", description: 123 }],
    ["a non-string duration_iso8601", { id: "vid-1", title: "Valid title", duration_iso8601: 123 }],
    ["null statistics", { id: "vid-1", title: "Valid title", statistics: null }],
    ["a malformed statistics view_count", { id: "vid-1", title: "Valid title", statistics: { view_count: "NaN", like_count: 1, comment_count: 0 } }],
  ])("rejects a videos page containing an item with %s as upstream_unavailable", async (_scenario, badItem) => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: envelope({ items: [badItem], next_page_token: null }),
      error: null,
    });
    const failure = await new SupabaseYouTubeResourcesGateway()
      .listVideos({ accountId: "acc-1" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(YouTubeResourceError);
    expect((failure as YouTubeResourceError).code).toBe("upstream_unavailable");
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
  ])("rejects a thumbnail answer with %s as outcome_unknown", async (_scenario, data) => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: envelope(data), error: null });
    await expect(new SupabaseYouTubeResourcesGateway().setThumbnail({
      accountId: "acc-1",
      videoId: EXAMPLE_VIDEO_ID,
      mediaFileId: "media-1",
    })).rejects.toMatchObject({ code: "outcome_unknown" });
  });

  it("maps a timed-out or unreadable set_thumbnail call to outcome_unknown", async () => {
    vi.mocked(supabase.functions.invoke).mockRejectedValue(
      Object.assign(new Error("The operation was aborted due to timeout"), { name: "FunctionsFetchError" }),
    );
    await expect(new SupabaseYouTubeResourcesGateway().setThumbnail({
      accountId: "acc-1",
      videoId: EXAMPLE_VIDEO_ID,
      mediaFileId: "media-1",
    })).rejects.toMatchObject({ code: "outcome_unknown" });
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

describe("YouTube resources gateway — published metadata edit", () => {
  beforeEach(() => vi.resetAllMocks());

  it("sends the title, description, tags and category of the draft in one conditional write", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: envelope({ revision: "rev-2" }),
      error: null,
    });

    const received = await new SupabaseYouTubeResourcesGateway().updateVideo({
      accountId: "acc-1",
      videoId: EXAMPLE_VIDEO_ID,
      baseRevision: "rev-1",
      changes: {
        title: "Renamed",
        description: "Body text",
        tags: ["one", "two"],
        category_id: "22",
      },
    });

    expect(supabase.functions.invoke).toHaveBeenCalledWith("youtube-resources", {
      body: {
        operation: "update_video",
        account_id: "acc-1",
        video_id: EXAMPLE_VIDEO_ID,
        base_revision: "rev-1",
        changes: {
          title: "Renamed",
          description: "Body text",
          tags: ["one", "two"],
          category_id: "22",
        },
      },
      timeout: 15000,
    });
    expect(received.data).toEqual({ revision: "rev-2" });
  });

  it("maps a timed-out or unreadable write to outcome_unknown", async () => {
    vi.mocked(supabase.functions.invoke).mockRejectedValue(
      Object.assign(new Error("The operation was aborted due to timeout"), { name: "FunctionsFetchError" }),
    );
    await expect(new SupabaseYouTubeResourcesGateway().updateVideo({
      accountId: "acc-1",
      videoId: EXAMPLE_VIDEO_ID,
      baseRevision: "rev-1",
      changes: { title: "Renamed" },
    })).rejects.toMatchObject({ code: "outcome_unknown" });

    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: Object.assign(new Error("Edge Function returned a non-2xx status code"), {
        context: Response.json({ message: "Bad Gateway" }, { status: 502 }),
      }),
    });
    await expect(new SupabaseYouTubeResourcesGateway().updateVideo({
      accountId: "acc-1",
      videoId: EXAMPLE_VIDEO_ID,
      baseRevision: "rev-1",
      changes: { title: "Renamed" },
    })).rejects.toMatchObject({ code: "outcome_unknown" });
  });

  it("turns a write refusal into the server's stable code", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: Object.assign(new Error("Edge Function returned a non-2xx status code"), {
        context: Response.json({ error: "edit_conflict", request_id: "req-5" }, { status: 409 }),
      }),
    });
    const failure = await new SupabaseYouTubeResourcesGateway()
      .updateVideo({
        accountId: "acc-1",
        videoId: EXAMPLE_VIDEO_ID,
        baseRevision: "rev-1",
        changes: { title: "Renamed" },
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(YouTubeResourceError);
    expect((failure as YouTubeResourceError).code).toBe("edit_conflict");
  });
});

describe("YouTube resources gateway — caption tracks", () => {
  beforeEach(() => vi.resetAllMocks());

  const track = {
    id: "track-1",
    language: "en",
    name: "English",
    track_kind: "standard",
    is_draft: false,
    status: "published",
    last_updated: null,
  };

  it("asks for the caption tracks of one video with the account, and no user id", async () => {
    const page = envelope({ video_id: EXAMPLE_VIDEO_ID, items: [track] });
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: page, error: null });

    const received = await new SupabaseYouTubeResourcesGateway().listCaptions({
      accountId: "acc-1",
      videoId: EXAMPLE_VIDEO_ID,
    });

    expect(supabase.functions.invoke).toHaveBeenCalledWith("youtube-resources", {
      body: { operation: "captions", account_id: "acc-1", video_id: EXAMPLE_VIDEO_ID },
      timeout: 15000,
    });
    expect(received.data.items).toEqual([track]);
  });

  it.each([
    ["a list for another video", { video_id: "another-video", items: [] }],
    ["a list without tracks", { video_id: EXAMPLE_VIDEO_ID }],
  ])("rejects %s as upstream_unavailable", async (_scenario, data) => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: envelope(data), error: null });
    await expect(new SupabaseYouTubeResourcesGateway().listCaptions({
      accountId: "acc-1",
      videoId: EXAMPLE_VIDEO_ID,
    })).rejects.toMatchObject({ code: "upstream_unavailable" });
  });

  it("sends the caption upload with the account, the video, the language, the name, the format and the text", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: envelope({ video_id: EXAMPLE_VIDEO_ID, track }),
      error: null,
    });

    const received = await new SupabaseYouTubeResourcesGateway().uploadCaption({
      accountId: "acc-1",
      videoId: EXAMPLE_VIDEO_ID,
      language: "en",
      name: "English",
      format: "vtt",
      content: "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n",
    });

    expect(supabase.functions.invoke).toHaveBeenCalledWith("youtube-resources", {
      body: {
        operation: "upload_caption",
        account_id: "acc-1",
        video_id: EXAMPLE_VIDEO_ID,
        language: "en",
        name: "English",
        format: "vtt",
        content: "WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n",
      },
      timeout: 15000,
    });
    expect(received.data.track).toEqual(track);
  });

  it("sends the caption text as raw UTF-8, never as escaped code points", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: envelope({ video_id: EXAMPLE_VIDEO_ID, track }),
      error: null,
    });

    await new SupabaseYouTubeResourcesGateway().uploadCaption({
      accountId: "acc-1",
      videoId: EXAMPLE_VIDEO_ID,
      language: "ar",
      name: "العربية",
      format: "srt",
      content: "1\n00:00:00,000 --> 00:00:01,000\nمرحبا بالعالم\n",
    });

    const body = vi.mocked(supabase.functions.invoke).mock.calls[0][1]?.body as { content: string };
    expect(body.content).toContain("مرحبا بالعالم");
    expect(JSON.stringify(body)).toContain("مرحبا بالعالم");
    expect(JSON.stringify(body)).not.toContain("\\u");
  });

  it("refuses an oversize caption file in the browser, before any provider call", async () => {
    // Arabic letters cost two UTF-8 bytes each: 300,000 characters are
    // 600,000 bytes, over the 512 KB ceiling the page enforces.
    const oversize = "مرحبا".repeat(75_000);

    const failure = await new SupabaseYouTubeResourcesGateway()
      .uploadCaption({
        accountId: "acc-1",
        videoId: EXAMPLE_VIDEO_ID,
        language: "ar",
        name: "العربية",
        format: "srt",
        content: oversize,
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(YouTubeResourceError);
    expect((failure as YouTubeResourceError).code).toBe("caption_invalid");
    expect(supabase.functions.invoke).not.toHaveBeenCalled();
  });

  it("accepts a caption file of exactly 524,288 UTF-8 bytes", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: envelope({ video_id: EXAMPLE_VIDEO_ID, track }),
      error: null,
    });
    const exact = "a".repeat(CAPTION_CONTENT_MAX_BYTES);

    await new SupabaseYouTubeResourcesGateway().uploadCaption({
      accountId: "acc-1",
      videoId: EXAMPLE_VIDEO_ID,
      language: "en",
      name: "English",
      format: "srt",
      content: exact,
    });

    expect(supabase.functions.invoke).toHaveBeenCalledTimes(1);
  });

  it("turns a caption conflict into the server's stable code", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: Object.assign(new Error("Edge Function returned a non-2xx status code"), {
        context: Response.json({ error: "caption_conflict", request_id: "req-4" }, { status: 409 }),
      }),
    });
    const failure = await new SupabaseYouTubeResourcesGateway()
      .uploadCaption({
        accountId: "acc-1",
        videoId: EXAMPLE_VIDEO_ID,
        language: "en",
        name: "English",
        format: "srt",
        content: "1\n00:00:00,000 --> 00:00:01,000\nHello\n",
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(YouTubeResourceError);
    expect((failure as YouTubeResourceError).code).toBe("caption_conflict");
  });

  it("maps a timed-out or unreadable caption upload to outcome_unknown", async () => {
    vi.mocked(supabase.functions.invoke).mockRejectedValue(
      Object.assign(new Error("The operation was aborted due to timeout"), { name: "FunctionsFetchError" }),
    );
    await expect(new SupabaseYouTubeResourcesGateway().uploadCaption({
      accountId: "acc-1",
      videoId: EXAMPLE_VIDEO_ID,
      language: "en",
      name: "English",
      format: "srt",
      content: "1\n00:00:00,000 --> 00:00:01,000\nHello\n",
    })).rejects.toMatchObject({ code: "outcome_unknown" });

    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: Object.assign(new Error("Edge Function returned a non-2xx status code"), {
        context: Response.json({ message: "Bad Gateway" }, { status: 502 }),
      }),
    });
    await expect(new SupabaseYouTubeResourcesGateway().uploadCaption({
      accountId: "acc-1",
      videoId: EXAMPLE_VIDEO_ID,
      language: "en",
      name: "English",
      format: "srt",
      content: "1\n00:00:00,000 --> 00:00:01,000\nHello\n",
    })).rejects.toMatchObject({ code: "outcome_unknown" });
  });

  it("rejects a caption answer that names another video as outcome_unknown", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: envelope({ video_id: "another-video", track }),
      error: null,
    });
    await expect(new SupabaseYouTubeResourcesGateway().uploadCaption({
      accountId: "acc-1",
      videoId: EXAMPLE_VIDEO_ID,
      language: "en",
      name: "English",
      format: "srt",
      content: "1\n00:00:00,000 --> 00:00:01,000\nHello\n",
    })).rejects.toMatchObject({ code: "outcome_unknown" });

    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: Object.assign(new Error("Edge Function returned a non-2xx status code"), {
        context: Response.json({ message: "Bad Gateway" }, { status: 502 }),
      }),
    });
    await expect(new SupabaseYouTubeResourcesGateway().uploadCaption({
      accountId: "acc-1",
      videoId: EXAMPLE_VIDEO_ID,
      language: "en",
      name: "English",
      format: "srt",
      content: "1\n00:00:00,000 --> 00:00:01,000\nHello\n",
    })).rejects.toMatchObject({ code: "outcome_unknown" });
  });
});

describe("YouTube resources gateway — createPlaylist", () => {
  beforeEach(() => vi.resetAllMocks());

  const validPlaylist = {
    id: "PL1234567890",
    title: "New Playlist",
    privacy_status: "private",
    thumbnail_url: null,
  };

  it("sends create_playlist with account, title, description and privacy_status, and omits description when undefined", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: envelope({ playlist: validPlaylist }),
      error: null,
    });

    const received = await new SupabaseYouTubeResourcesGateway().createPlaylist({
      accountId: "acc-1",
      title: "New Playlist",
      description: "Notes",
      privacyStatus: "private",
    });

    expect(supabase.functions.invoke).toHaveBeenCalledWith("youtube-resources", {
      body: {
        operation: "create_playlist",
        account_id: "acc-1",
        title: "New Playlist",
        description: "Notes",
        privacy_status: "private",
      },
      timeout: 25000,
    });
    expect(received.data.playlist).toEqual(validPlaylist);

    await new SupabaseYouTubeResourcesGateway().createPlaylist({
      accountId: "acc-1",
      title: "New Playlist",
      privacyStatus: "unlisted",
    });

    expect(supabase.functions.invoke).toHaveBeenLastCalledWith("youtube-resources", {
      body: {
        operation: "create_playlist",
        account_id: "acc-1",
        title: "New Playlist",
        privacy_status: "unlisted",
      },
      timeout: 25000,
    });
  });

  it.each([
    ["missing playlist object", {}],
    ["short playlist id (< 10 chars)", { playlist: { ...validPlaylist, id: "PL123" } }],
    ["invalid characters in playlist id", { playlist: { ...validPlaylist, id: "PL1234567890/bad" } }],
    ["missing title string", { playlist: { id: "PL1234567890", title: null } }],
  ])("rejects a create_playlist response with %s as outcome_unknown", async (_scenario, data) => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: envelope(data),
      error: null,
    });

    await expect(
      new SupabaseYouTubeResourcesGateway().createPlaylist({
        accountId: "acc-1",
        title: "New Playlist",
        privacyStatus: "private",
      }),
    ).rejects.toMatchObject({ code: "outcome_unknown" });
  });

  it("maps a timed-out or unreadable create_playlist call to outcome_unknown and preserves server refusal codes", async () => {
    vi.mocked(supabase.functions.invoke).mockRejectedValue(
      Object.assign(new Error("The operation was aborted due to timeout"), { name: "FunctionsFetchError" }),
    );

    await expect(
      new SupabaseYouTubeResourcesGateway().createPlaylist({
        accountId: "acc-1",
        title: "New Playlist",
        privacyStatus: "private",
      }),
    ).rejects.toMatchObject({ code: "outcome_unknown" });

    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: Object.assign(new Error("Edge Function returned a non-2xx status code"), {
        context: Response.json({ error: "rate_limited", retry_after_seconds: 3600, request_id: "req-9" }, { status: 429 }),
      }),
    });

    const failure = await new SupabaseYouTubeResourcesGateway()
      .createPlaylist({
        accountId: "acc-1",
        title: "New Playlist",
        privacyStatus: "private",
      })
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(YouTubeResourceError);
    expect((failure as YouTubeResourceError).code).toBe("rate_limited");
    expect((failure as YouTubeResourceError).retryAfterSeconds).toBe(3600);
  });
});
