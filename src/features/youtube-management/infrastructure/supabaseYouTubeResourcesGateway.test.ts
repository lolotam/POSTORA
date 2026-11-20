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

describe("YouTube resources gateway", () => {
  beforeEach(() => vi.clearAllMocks());

  it("asks for a page of videos with the account, the size and the cursor, and no user id", async () => {
    const page = envelope({ items: [], next_page_token: null, total_results: 0 });
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: page, error: null });

    const received = await new SupabaseYouTubeResourcesGateway().listVideos({ accountId: "acc-1", pageToken: "PAGE2" });

    expect(supabase.functions.invoke).toHaveBeenCalledWith("youtube-resources", {
      body: { operation: "videos", account_id: "acc-1", page_token: "PAGE2" },
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
    });
  });

  it("sends exactly the request bodies the edge handler's shared examples define", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: envelope({}), error: null });
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
});
