import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createYouTubeEditProvider } from "./editProvider.ts";

const CHANNEL = "UCfixturechannel000000001";
const VIDEO = "AbcD1234eFg";

function item() {
  return {
    id: VIDEO,
    etag: "fixture-etag",
    snippet: { channelId: CHANNEL, title: "Original", description: "Description", categoryId: "22", tags: ["a"] },
    status: { privacyStatus: "private", embeddable: false, license: "youtube", publicStatsViewable: false },
  };
}

function fetchReturning(body: unknown): typeof fetch {
  return (() => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  })) as unknown as typeof fetch;
}

Deno.test("the real videos.list envelope is unwrapped before the resource is validated", async () => {
  const provider = createYouTubeEditProvider({ fetchImpl: fetchReturning({ kind: "youtube#videoListResponse", items: [item()] }) });
  const read = await provider.getVideo("token", { videoId: VIDEO, channelId: CHANNEL });
  assertEquals(read.ok, true);
  if (read.ok) {
    assertEquals(read.value.id, VIDEO);
    assertEquals(read.value.snippet.title, "Original");
    assertEquals(read.value.status.privacyStatus, "private");
  }
});

Deno.test("an envelope that does not identify exactly one owned video is not found", async () => {
  for (const items of [[], [item(), item()]]) {
    const provider = createYouTubeEditProvider({ fetchImpl: fetchReturning({ items }) });
    const read = await provider.getVideo("token", { videoId: VIDEO, channelId: CHANNEL });
    assertEquals(read.ok, false);
    if (!read.ok) assertEquals(read.code, "not_found");
  }
});
