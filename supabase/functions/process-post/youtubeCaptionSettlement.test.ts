import { assertEquals, assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  canScrubSettledPostCaptionNow,
  hasUnscrubbedYoutubeCaptionContent,
  scrubSettledPostCaptionInDb,
  scrubSettledYoutubeCaptionMetadata,
} from "./youtubeCaptionSettlement.ts";

Deno.test("scrubSettledYoutubeCaptionMetadata removes content and keeps language, name, format and sibling keys", () => {
  const original: Record<string, unknown> = {
    youtube_title: "Demo video",
    youtube_visibility: "private",
    youtube_caption: {
      language: "en",
      name: "English CC",
      format: "vtt",
      content: "WEBVTT\n\n00:00.000 --> 00:02.000\nSecret line\n",
    },
  };

  assertEquals(hasUnscrubbedYoutubeCaptionContent(original), true);
  const scrubbed = scrubSettledYoutubeCaptionMetadata(original);
  assertEquals(scrubbed, {
    youtube_title: "Demo video",
    youtube_visibility: "private",
    youtube_caption: {
      language: "en",
      name: "English CC",
      format: "vtt",
    },
  });
  assertEquals(hasUnscrubbedYoutubeCaptionContent(scrubbed), false);
  // Original is not mutated in place
  assertEquals("content" in (original.youtube_caption as Record<string, unknown>), true);
});

Deno.test("scrubSettledYoutubeCaptionMetadata returns metadata reference-identical when youtube_caption is absent, null, or already scrubbed", () => {
  assertStrictEquals(scrubSettledYoutubeCaptionMetadata(null), null);
  assertStrictEquals(scrubSettledYoutubeCaptionMetadata(undefined), undefined);

  const withoutCaption: Record<string, unknown> = { youtube_title: "No caption" };
  assertStrictEquals(scrubSettledYoutubeCaptionMetadata(withoutCaption), withoutCaption);
  assertEquals(hasUnscrubbedYoutubeCaptionContent(withoutCaption), false);

  const nullCaption: Record<string, unknown> = { youtube_caption: null };
  assertStrictEquals(scrubSettledYoutubeCaptionMetadata(nullCaption), nullCaption);
  assertEquals(hasUnscrubbedYoutubeCaptionContent(nullCaption), false);

  const alreadyScrubbed: Record<string, unknown> = {
    youtube_caption: { language: "ar", name: "Arabic", format: "srt" },
  };
  assertStrictEquals(scrubSettledYoutubeCaptionMetadata(alreadyScrubbed), alreadyScrubbed);
  assertEquals(hasUnscrubbedYoutubeCaptionContent(alreadyScrubbed), false);
});

Deno.test("scrubSettledYoutubeCaptionMetadata behaves identically across completed, partial, and failed terminal post settlements", () => {
  for (const terminalStatus of ["completed", "partial", "failed"] as const) {
    const postUpdate = {
      status: terminalStatus,
      metadata: scrubSettledYoutubeCaptionMetadata({
        youtube_visibility: "unlisted",
        youtube_caption: {
          language: "en-US",
          name: "Main Track",
          format: "srt",
          content: "1\n00:00:00,000 --> 00:00:02,000\nHello\n",
        },
      }),
    };
    assertEquals(postUpdate.status, terminalStatus);
    assertEquals(postUpdate.metadata, {
      youtube_visibility: "unlisted",
      youtube_caption: {
        language: "en-US",
        name: "Main Track",
        format: "srt",
      },
    });
  }
});

Deno.test("canScrubSettledPostCaptionNow and scrubSettledPostCaptionInDb preserve notification content-hash fences until consumed and never clobber fresh DB keys", async () => {
  const captionWithContent = {
    language: "en",
    name: "English",
    format: "vtt",
    content: "WEBVTT\n\n00:00.000 --> 00:02.000\nSecret\n",
  };

  // 1. Non-terminal post is not scrubbed
  assertEquals(
    canScrubSettledPostCaptionNow({
      status: "processing",
      metadata: { youtube_caption: captionWithContent },
    }),
    false,
  );

  // 2. Unconsumed legacy_notification_candidate blocks scrubbing so content_hash stays valid
  assertEquals(
    canScrubSettledPostCaptionNow({
      status: "completed",
      metadata: {
        youtube_caption: captionWithContent,
        legacy_notification_candidate: {
          candidate_id: "cand-1",
          ready: true,
          consumed: false,
          content_hash: "md5-before-scrub",
        },
      },
    }),
    false,
  );

  // 3. Unnotified final_notification_intent blocks scrubbing so content fence stays valid
  assertEquals(
    canScrubSettledPostCaptionNow({
      status: "completed",
      metadata: {
        youtube_caption: captionWithContent,
        final_notification_intent: {
          notified: false,
        },
      },
    }),
    false,
  );

  // 4. Once legacy_notification_candidate is consumed, scrubSettledPostCaptionInDb reads fresh DB metadata and preserves final_notified_at and consumed=true
  let storedRow: { status: string; metadata: Record<string, unknown> } = {
    status: "completed",
    metadata: {
      youtube_title: "Live video",
      youtube_caption: captionWithContent,
      final_notified_at: "2026-11-28T00:00:00.000Z",
      settlement_rollup_status: "completed",
      legacy_notification_candidate: {
        candidate_id: "cand-1",
        ready: true,
        consumed: true,
        content_hash: "md5-before-scrub",
        content_fence: {
          metadata: {
            youtube_caption: captionWithContent,
          },
        },
      },
    },
  };

  let observedExpectedStatus: string | undefined;
  const didScrub = await scrubSettledPostCaptionInDb(
    {
      readPostRow: () => Promise.resolve({ data: storedRow, error: null }),
      updatePostMetadata: (_postId, metadata, expectedStatus) => {
        observedExpectedStatus = expectedStatus;
        storedRow = { ...storedRow, metadata };
        return Promise.resolve({ error: null });
      },
    },
    "post-1",
  );

  assertEquals(didScrub, true);
  assertEquals(observedExpectedStatus, "completed");
  assertEquals(storedRow.metadata, {
    youtube_title: "Live video",
    youtube_caption: {
      language: "en",
      name: "English",
      format: "vtt",
    },
    final_notified_at: "2026-11-28T00:00:00.000Z",
    settlement_rollup_status: "completed",
    legacy_notification_candidate: {
      candidate_id: "cand-1",
      ready: true,
      consumed: true,
      content_hash: "md5-before-scrub",
      content_fence: {
        metadata: {
          youtube_caption: {
            language: "en",
            name: "English",
            format: "vtt",
          },
        },
      },
    },
  });
});
