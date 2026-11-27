import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { YouTubeBenchmarkError } from "../domain/errors";
import { SupabaseYouTubeBenchmarkGateway } from "./supabaseYouTubeBenchmarkGateway";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: vi.fn() } },
}));

const CHANNEL_ID = "UCabcdefghijklmnopqrstuv";

function envelope(channels: unknown[], accountId = "acc-1") {
  return {
    schema_version: 1 as const,
    request_id: "req-1",
    freshness: { fetched_at: "2026-11-27T10:00:00.000Z", source: "provider" as const },
    data: { account_id: accountId, channels },
  };
}

function foundChannel(input: string) {
  return {
    input,
    status: "found",
    channel_id: CHANNEL_ID,
    title: "Someone",
    thumbnail_url: null,
    subscriber_count: 10,
    subscriber_count_hidden: false,
    view_count: 100,
    video_count: 5,
    recent_videos: [],
  };
}

describe("YouTube benchmark gateway", () => {
  beforeEach(() => vi.resetAllMocks());

  it("asks for the named channels with the creator's own account and no user id", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: envelope([foundChannel("@someone")]),
      error: null,
    });

    const received = await new SupabaseYouTubeBenchmarkGateway().lookupChannels({
      accountId: "acc-1",
      channels: ["@someone"],
    });

    expect(supabase.functions.invoke).toHaveBeenCalledWith("youtube-channel-benchmark", {
      body: { account_id: "acc-1", channels: ["@someone"] },
      timeout: 25000,
    });
    expect(received.data.channels).toHaveLength(1);
  });

  it("carries the server's stable failure code", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: null,
      error: {
        context: Response.json(
          { error: "quota_exceeded", retry_after_seconds: 60 },
          { status: 429 },
        ),
      },
    });

    await expect(
      new SupabaseYouTubeBenchmarkGateway().lookupChannels({ accountId: "acc-1", channels: ["@a"] }),
    ).rejects.toMatchObject({ code: "quota_exceeded", retryAfterSeconds: 60 });
  });

  it("refuses an answer for another account", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({
      data: envelope([foundChannel("@someone")], "acc-other"),
      error: null,
    });

    await expect(
      new SupabaseYouTubeBenchmarkGateway().lookupChannels({ accountId: "acc-1", channels: ["@a"] }),
    ).rejects.toBeInstanceOf(YouTubeBenchmarkError);
  });

  it("refuses a malformed envelope instead of handing it to the screen", async () => {
    const malformed = [
      { ...envelope([foundChannel("@someone")]), schema_version: 2 },
      { ...envelope([foundChannel("@someone")]), request_id: 7 },
      { ...envelope([foundChannel("@someone")]), freshness: { source: "provider" } },
      { schema_version: 1, request_id: "r", freshness: { fetched_at: "x" }, data: { account_id: "acc-1" } },
    ];

    for (const payload of malformed) {
      vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: payload, error: null });
      await expect(
        new SupabaseYouTubeBenchmarkGateway().lookupChannels({ accountId: "acc-1", channels: ["@a"] }),
      ).rejects.toBeInstanceOf(YouTubeBenchmarkError);
    }
  });

  it("turns a thrown call into a typed upstream failure", async () => {
    vi.mocked(supabase.functions.invoke).mockRejectedValue(new Error("network down"));

    await expect(
      new SupabaseYouTubeBenchmarkGateway().lookupChannels({ accountId: "acc-1", channels: ["@a"] }),
    ).rejects.toMatchObject({ code: "upstream_unavailable" });
  });
});
