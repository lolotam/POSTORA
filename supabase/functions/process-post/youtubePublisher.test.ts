import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  buildYoutubeUploadRequest,
  type YoutubeUploadRequest,
} from "./youtubePublisher.ts";
import { YOUTUBE_DEFAULT_CATEGORY_ID } from "../_shared/youtubePublishOptions.ts";

function snippetOf(request: YoutubeUploadRequest): Record<string, unknown> {
  return request.body.snippet as Record<string, unknown>;
}

function statusOf(request: YoutubeUploadRequest): Record<string, unknown> {
  return request.body.status as Record<string, unknown>;
}

const baseInput = { title: "A video", description: "A description", tags: ["one"] };

Deno.test("upload request publishes privately when the post names no privacy", () => {
  const request = buildYoutubeUploadRequest({ metadata: {}, ...baseInput });

  assertEquals(statusOf(request).privacyStatus, "private");
  assertStringIncludes(request.url, "part=snippet,status");
});

Deno.test("upload request applies the privacy the post names", () => {
  const request = buildYoutubeUploadRequest({
    metadata: { youtube_visibility: "unlisted" },
    ...baseInput,
  });

  assertEquals(statusOf(request).privacyStatus, "unlisted");
});

Deno.test("upload request falls back to private for an unknown privacy", () => {
  const request = buildYoutubeUploadRequest({
    metadata: { youtube_visibility: "everyone" },
    ...baseInput,
  });

  assertEquals(statusOf(request).privacyStatus, "private");
});

Deno.test("upload request forwards containsSyntheticMedia", () => {
  const request = buildYoutubeUploadRequest({
    metadata: { youtube_contains_synthetic_media: true },
    ...baseInput,
  });

  assertEquals(statusOf(request).containsSyntheticMedia, true);
});

Deno.test("upload request never sends the read-only madeForKids property", () => {
  const request = buildYoutubeUploadRequest({
    metadata: { youtube_made_for_kids: true },
    ...baseInput,
  });

  assertEquals(statusOf(request).madeForKids, undefined);
  assertEquals(statusOf(request).selfDeclaredMadeForKids, true);
});

Deno.test("upload request sends paid product placement only when it was stated", () => {
  const stated = buildYoutubeUploadRequest({
    metadata: { youtube_has_paid_promotion: true },
    ...baseInput,
  });
  const statedDetails = stated.body.paidProductPlacementDetails as Record<string, unknown>;
  assertEquals(statedDetails.hasPaidProductPlacement, true);
  assertStringIncludes(stated.part, "paidProductPlacementDetails");

  const explicitFalse = buildYoutubeUploadRequest({
    metadata: { youtube_has_paid_product_placement: false },
    ...baseInput,
  });
  assertEquals(explicitFalse.body.paidProductPlacementDetails, { hasPaidProductPlacement: false });

  const unstated = buildYoutubeUploadRequest({
    metadata: { youtube_has_paid_promotion: false },
    ...baseInput,
  });
  assertEquals(unstated.body.paidProductPlacementDetails, undefined);
  assertEquals(unstated.part.includes("paidProductPlacementDetails"), false);
});

Deno.test("upload request reports the options YouTube does not document as settable", () => {
  const request = buildYoutubeUploadRequest({
    metadata: {
      youtube_audio_language: "en",
      youtube_allowed_countries: ["US"],
      youtube_blocked_countries: ["DE"],
    },
    ...baseInput,
  });

  assertEquals(request.warnings.length, 3);
  assertStringIncludes(request.warnings.join(" "), "youtube_default_audio_language");
  assertStringIncludes(request.warnings.join(" "), "youtube_allowed_countries");
  assertStringIncludes(request.warnings.join(" "), "youtube_blocked_countries");
});

Deno.test("upload request does not report documented options as unconfirmed", () => {
  const request = buildYoutubeUploadRequest({
    metadata: {
      youtube_visibility: "public",
      youtube_category: "22",
      youtube_allow_embedding: true,
      youtube_contains_synthetic_media: false,
      youtube_video_language: "en",
      youtube_recording_date: "2026-11-16",
    },
    ...baseInput,
  });

  assertEquals(request.warnings, []);
  assertEquals(snippetOf(request).defaultLanguage, "en");
  assertEquals((request.body.recordingDetails as Record<string, unknown>).recordingDate, "2026-11-16");
});

Deno.test("upload request turns off subscriber notifications when asked", () => {
  const request = buildYoutubeUploadRequest({
    metadata: { youtube_notify_subscribers: false },
    ...baseInput,
  });

  assertEquals(request.notifySubscribers, false);
  assertStringIncludes(request.url, "notifySubscribers=false");
});

Deno.test("upload request uses the category the post names", () => {
  const request = buildYoutubeUploadRequest({
    metadata: { youtube_category: "10" },
    ...baseInput,
  });

  assertEquals(snippetOf(request).categoryId, "10");
});

Deno.test("upload request falls back to the default category", () => {
  const request = buildYoutubeUploadRequest({ metadata: {}, ...baseInput });

  assertEquals(snippetOf(request).categoryId, YOUTUBE_DEFAULT_CATEGORY_ID);
});

Deno.test("upload request keeps the title and description within the provider limits", () => {
  const request = buildYoutubeUploadRequest({
    metadata: {},
    title: "t".repeat(200),
    description: "d".repeat(6000),
    tags: [],
  });

  assertEquals(String(snippetOf(request).title).length, 100);
  assertEquals(String(snippetOf(request).description).length, 5000);
  assert(Array.isArray(snippetOf(request).tags));
});
