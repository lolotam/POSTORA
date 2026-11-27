import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { YOUTUBE_SCOPE, type YouTubeResourceErrorCode, type YouTubeVideoDetails } from "./contracts.ts";
import type { YouTubeResourceAccount } from "./handler.ts";
import {
  createYouTubeThumbnailPort,
  type OwnedThumbnailMediaRow,
  type ThumbnailDownloadResult,
  type YouTubeThumbnailCompositionDeps,
} from "./thumbnailComposition.ts";
import { THUMBNAIL_MAX_BYTES } from "./thumbnailMedia.ts";

const USER_ID = "0ee00001-0000-4000-8000-000000000001";
const OTHER_USER_ID = "0ee00001-0000-4000-8000-000000000002";
const ACCOUNT_ID = "0ee20001-0000-4000-8000-000000000021";
const CHANNEL_ID = "UCfixturechannel000000001";
const VIDEO_ID = "videoAAAAAAA";
const MEDIA_ID = "0ee30001-0000-4000-8000-000000000031";
const BOUND_BEARER = "bound-fixture-123";

const JPEG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
const WEBP_BYTES = new TextEncoder().encode("RIFF\x24\x00\x00\x00WEBPVP8 ");

const VIDEO_DETAILS: YouTubeVideoDetails = {
  id: VIDEO_ID,
  channel_id: CHANNEL_ID,
  title: "Fixture Video",
  description: "",
  thumbnail_url: null,
  published_at: null,
  tags: [],
  category_id: null,
  default_language: null,
  duration_iso8601: "PT1M",
  privacy_status: "public",
  upload_status: "processed",
  made_for_kids: false,
  statistics: { view_count: 1, like_count: 0, comment_count: 0 },
  url: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
};

function makeAccount(overrides: Partial<YouTubeResourceAccount> = {}): YouTubeResourceAccount {
  return {
    id: ACCOUNT_ID,
    userId: USER_ID,
    channelId: CHANNEL_ID,
    channelTitle: "Fixture channel",
    authProvider: null,
    needsReauth: false,
    accessToken: BOUND_BEARER,
    refreshToken: "refresh-fixture-123",
    tokenExpiresAt: "2026-12-01T00:00:00Z",
    accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.readonly, YOUTUBE_SCOPE.upload] },
    ...overrides,
  };
}

function makeMediaRow(overrides: Partial<OwnedThumbnailMediaRow> = {}): OwnedThumbnailMediaRow {
  return {
    id: MEDIA_ID,
    userId: USER_ID,
    filePath: `${USER_ID}/thumb.jpg`,
    fileType: "image",
    fileSize: JPEG_BYTES.byteLength,
    mimeType: "image/jpeg",
    storageBucket: "media",
    scanState: "available",
    ...overrides,
  };
}

function makeHarness(overrides: {
  mediaRow?: OwnedThumbnailMediaRow | null;
  mediaReadError?: boolean;
  downloadResult?: ThumbnailDownloadResult;
  counterResult?: Awaited<ReturnType<YouTubeThumbnailCompositionDeps["writeLimits"]["checkUserWriteCounters"]>>;
  budgetResult?: Awaited<ReturnType<YouTubeThumbnailCompositionDeps["writeLimits"]["debitWriteBudget"]>>;
  stillBound?: boolean;
  getVideoResult?: Awaited<ReturnType<YouTubeThumbnailCompositionDeps["youtube"]["getVideo"]>>;
  uploadResponse?: () => Promise<Response>;
} = {}) {
  const counts = {
    loadOwned: 0,
    counters: 0,
    tokens: 0,
    getVideo: 0,
    download: 0,
    debit: 0,
    stillBound: 0,
    upload: 0,
  };
  const uploadRequests: Array<{ url: string; contentType: string | null; method: string }> = [];

  const port = createYouTubeThumbnailPort({
    media: {
      loadOwned: () => {
        counts.loadOwned += 1;
        if (overrides.mediaReadError) return Promise.resolve({ ok: false, reason: "read_error" });
        return Promise.resolve({
          ok: true,
          row: overrides.mediaRow === undefined ? makeMediaRow() : overrides.mediaRow,
        });
      },
      downloadBytes: () => {
        counts.download += 1;
        return Promise.resolve(overrides.downloadResult ?? { ok: true, bytes: JPEG_BYTES });
      },
    },
    writeLimits: {
      checkUserWriteCounters: () => {
        counts.counters += 1;
        return Promise.resolve(overrides.counterResult ?? { ok: true });
      },
      debitWriteBudget: () => {
        counts.debit += 1;
        return Promise.resolve(overrides.budgetResult ?? { ok: true, count: 50 });
      },
    },
    stillBound: () => {
      counts.stillBound += 1;
      return Promise.resolve(overrides.stillBound ?? true);
    },
    tokens: {
      get: () => {
        counts.tokens += 1;
        return Promise.resolve({ ok: true, accessToken: BOUND_BEARER, minted: false });
      },
    },
    youtube: {
      getVideo: () => {
        counts.getVideo += 1;
        return Promise.resolve(overrides.getVideoResult ?? { ok: true, value: VIDEO_DETAILS });
      },
    },
    fetchImpl: (input, init) => {
      counts.upload += 1;
      const headers = new Headers(init?.headers);
      uploadRequests.push({
        url: String(input),
        contentType: headers.get("Content-Type"),
        method: init?.method ?? "GET",
      });
      if (overrides.uploadResponse) return overrides.uploadResponse();
      return Promise.resolve(new Response(JSON.stringify({ items: [] }), { status: 200 }));
    },
  });

  return { port, counts, uploadRequests };
}

Deno.test("setThumbnail succeeds for JPEG and PNG with matching Content-Type", async () => {
  const jpegHarness = makeHarness();
  const jpegResult = await jpegHarness.port.setThumbnail({
    account: makeAccount(),
    userId: USER_ID,
    videoId: VIDEO_ID,
    mediaFileId: MEDIA_ID,
  });
  assertEquals(jpegResult, { ok: true, value: { video_id: VIDEO_ID, applied: true } });
  assertEquals(jpegHarness.counts, {
    loadOwned: 1,
    counters: 1,
    tokens: 1,
    getVideo: 1,
    download: 1,
    debit: 1,
    stillBound: 1,
    upload: 1,
  });
  assertEquals(jpegHarness.uploadRequests[0], {
    url: `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${VIDEO_ID}`,
    contentType: "image/jpeg",
    method: "POST",
  });

  const pngHarness = makeHarness({
    mediaRow: makeMediaRow({ mimeType: "image/png", fileSize: PNG_BYTES.byteLength }),
    downloadResult: { ok: true, bytes: PNG_BYTES },
  });
  const pngResult = await pngHarness.port.setThumbnail({
    account: makeAccount(),
    userId: USER_ID,
    videoId: VIDEO_ID,
    mediaFileId: MEDIA_ID,
  });
  assertEquals(pngResult, { ok: true, value: { video_id: VIDEO_ID, applied: true } });
  assertEquals(pngHarness.uploadRequests[0].contentType, "image/png");
});

Deno.test("setThumbnail refuses missing scope or composio before media lookup, budget debit, or upload", async () => {
  const missingScope = makeHarness();
  const res1 = await missingScope.port.setThumbnail({
    account: makeAccount({ accountMetadata: { granted_scopes: [YOUTUBE_SCOPE.readonly] } }),
    userId: USER_ID,
    videoId: VIDEO_ID,
    mediaFileId: MEDIA_ID,
  });
  assertEquals(res1, { ok: false, code: "missing_scope" });
  assertEquals(missingScope.counts.loadOwned, 0);
  assertEquals(missingScope.counts.debit, 0);
  assertEquals(missingScope.counts.upload, 0);

  const composio = makeHarness();
  const res2 = await composio.port.setThumbnail({
    account: makeAccount({ authProvider: "composio" }),
    userId: USER_ID,
    videoId: VIDEO_ID,
    mediaFileId: MEDIA_ID,
  });
  assertEquals(res2, { ok: false, code: "provider_unsupported" });
  assertEquals(composio.counts.debit, 0);
  assertEquals(composio.counts.upload, 0);
});

Deno.test("setThumbnail refuses foreign/absent media, image/webp, non-image, and oversize row with zero budget debit and zero upload", async () => {
  const cases = [
    makeHarness({ mediaRow: null }),
    makeHarness({ mediaRow: makeMediaRow({ userId: OTHER_USER_ID }) }),
    makeHarness({ mediaRow: makeMediaRow({ fileType: "video", mimeType: "video/mp4" }) }),
    makeHarness({ mediaRow: makeMediaRow({ mimeType: "image/webp" }) }),
    makeHarness({ mediaRow: makeMediaRow({ fileSize: THUMBNAIL_MAX_BYTES + 1 }) }),
    makeHarness({ mediaRow: makeMediaRow({ storageBucket: "cloudinary" }) }),
    makeHarness({ mediaRow: makeMediaRow({ storageBucket: "partner-media" }) }),
    makeHarness({ mediaRow: makeMediaRow({ filePath: `${OTHER_USER_ID}/thumb.jpg` }) }),
    makeHarness({ mediaRow: makeMediaRow({ filePath: `${USER_ID}/../${OTHER_USER_ID}/thumb.jpg` }) }),
  ];

  for (const harness of cases) {
    const result = await harness.port.setThumbnail({
      account: makeAccount(),
      userId: USER_ID,
      videoId: VIDEO_ID,
      mediaFileId: MEDIA_ID,
    });
    assertEquals(result, { ok: false, code: "media_not_usable" });
    assertEquals(harness.counts.counters, 0);
    assertEquals(harness.counts.download, 0);
    assertEquals(harness.counts.debit, 0);
    assertEquals(harness.counts.upload, 0);
  }
});

Deno.test("setThumbnail refuses per-user write counter limit before token, getVideo, download, debit, or upload", async () => {
  const harness = makeHarness({
    counterResult: { ok: false, code: "rate_limited", retryAfterSeconds: 120 },
  });
  const result = await harness.port.setThumbnail({
    account: makeAccount(),
    userId: USER_ID,
    videoId: VIDEO_ID,
    mediaFileId: MEDIA_ID,
  });
  assertEquals(result, { ok: false, code: "rate_limited", retryAfterSeconds: 120 });
  assertEquals(harness.counts.tokens, 0);
  assertEquals(harness.counts.getVideo, 0);
  assertEquals(harness.counts.download, 0);
  assertEquals(harness.counts.debit, 0);
  assertEquals(harness.counts.upload, 0);
});

Deno.test("setThumbnail refuses foreign/missing video id with zero budget debit and zero upload", async () => {
  const harness = makeHarness({
    getVideoResult: { ok: false, code: "not_found", unauthorized: false },
  });
  const result = await harness.port.setThumbnail({
    account: makeAccount(),
    userId: USER_ID,
    videoId: VIDEO_ID,
    mediaFileId: MEDIA_ID,
  });
  assertEquals(result, { ok: false, code: "not_found" });
  assertEquals(harness.counts.download, 0);
  assertEquals(harness.counts.debit, 0);
  assertEquals(harness.counts.upload, 0);
});

Deno.test("setThumbnail refuses WebP bytes under image/jpeg label or oversize download with zero budget debit and zero upload", async () => {
  const spoofed = makeHarness({ downloadResult: { ok: true, bytes: WEBP_BYTES } });
  const res1 = await spoofed.port.setThumbnail({
    account: makeAccount(),
    userId: USER_ID,
    videoId: VIDEO_ID,
    mediaFileId: MEDIA_ID,
  });
  assertEquals(res1, { ok: false, code: "media_not_usable" });
  assertEquals(spoofed.counts.debit, 0);
  assertEquals(spoofed.counts.upload, 0);

  const tooLarge = makeHarness({ downloadResult: { ok: false, reason: "too_large" } });
  const res2 = await tooLarge.port.setThumbnail({
    account: makeAccount(),
    userId: USER_ID,
    videoId: VIDEO_ID,
    mediaFileId: MEDIA_ID,
  });
  assertEquals(res2, { ok: false, code: "media_not_usable" });
  assertEquals(tooLarge.counts.debit, 0);
  assertEquals(tooLarge.counts.upload, 0);
});

Deno.test("setThumbnail refuses budget exhaustion and lost stillBound with zero upload", async () => {
  const overBudget = makeHarness({
    budgetResult: { ok: false, code: "quota_exceeded", retryAfterSeconds: 600 },
  });
  const res1 = await overBudget.port.setThumbnail({
    account: makeAccount(),
    userId: USER_ID,
    videoId: VIDEO_ID,
    mediaFileId: MEDIA_ID,
  });
  assertEquals(res1, { ok: false, code: "quota_exceeded", retryAfterSeconds: 600 });
  assertEquals(overBudget.counts.upload, 0);

  const unbound = makeHarness({ stillBound: false });
  const res2 = await unbound.port.setThumbnail({
    account: makeAccount(),
    userId: USER_ID,
    videoId: VIDEO_ID,
    mediaFileId: MEDIA_ID,
  });
  assertEquals(res2, { ok: false, code: "reconnect_required" });
  assertEquals(unbound.counts.upload, 0);
});

Deno.test("setThumbnail classifies 403, 401, 404, 429, 400, 5xx, and thrown fetch without ever retrying upload", async () => {
  const statusCases: Array<[number, YouTubeResourceErrorCode]> = [
    [403, "thumbnail_not_allowed"],
    [401, "reconnect_required"],
    [404, "not_found"],
    [429, "quota_exceeded"],
    [400, "upstream_unavailable"],
    [500, "outcome_unknown"],
    [503, "outcome_unknown"],
  ];

  for (const [status, expectedCode] of statusCases) {
    const harness = makeHarness({
      uploadResponse: () => Promise.resolve(new Response("", { status })),
    });
    const result = await harness.port.setThumbnail({
      account: makeAccount(),
      userId: USER_ID,
      videoId: VIDEO_ID,
      mediaFileId: MEDIA_ID,
    });
    assertEquals(result, { ok: false, code: expectedCode });
    assertEquals(harness.counts.upload, 1);
  }

  const lostAnswer = makeHarness({
    uploadResponse: () => Promise.reject(new Error("socket hang up")),
  });
  const lostResult = await lostAnswer.port.setThumbnail({
    account: makeAccount(),
    userId: USER_ID,
    videoId: VIDEO_ID,
    mediaFileId: MEDIA_ID,
  });
  assertEquals(lostResult, { ok: false, code: "outcome_unknown" });
  assertEquals(lostAnswer.counts.upload, 1);
});
