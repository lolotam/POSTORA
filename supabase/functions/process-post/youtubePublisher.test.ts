import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  buildYoutubeUploadRequest,
  initiateYoutubeUpload,
  type YoutubeUploadRequest,
} from "./youtubePublisher.ts";
import { YOUTUBE_DEFAULT_CATEGORY_ID } from "../_shared/youtubePublishOptions.ts";

interface RecordedCall {
  url: string;
  init: RequestInit;
}

/**
 * A fake YouTube provider. It records what Postora sent and answers with the
 * response the test asks for, so the request contract can be asserted without
 * touching the live API.
 */
function fakeYouTube(options: {
  status?: number;
  payload?: unknown;
  location?: string | null;
} = {}) {
  const calls: RecordedCall[] = [];
  const status = options.status ?? 200;
  const location = options.location === undefined
    ? "https://upload.example/fake-session"
    : options.location;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const headers = new Headers();
    if (location) headers.set("Location", location);
    return new Response(
      status >= 400 ? JSON.stringify(options.payload ?? { error: { message: "nope" } }) : "{}",
      { status, headers },
    );
  }) as unknown as typeof fetch;

  return { calls, fetchImpl };
}

function bodyOf(call: RecordedCall): Record<string, any> {
  return JSON.parse(String(call.init.body)) as Record<string, any>;
}

function headersOf(call: RecordedCall): Headers {
  return new Headers(call.init.headers as HeadersInit);
}

function snippetOf(request: YoutubeUploadRequest): Record<string, any> {
  return request.body.snippet as Record<string, any>;
}

function statusOf(request: YoutubeUploadRequest): Record<string, any> {
  return request.body.status as Record<string, any>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const statedDetails = stated.body.paidProductPlacementDetails as Record<string, any>;
  assertEquals(statedDetails.hasPaidProductPlacement, true);
  assertStringIncludes(stated.part, "paidProductPlacementDetails");

  const unstated = buildYoutubeUploadRequest({ metadata: {}, ...baseInput });
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
  assertEquals((request.body.recordingDetails as Record<string, any>).recordingDate, "2026-11-16");
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

Deno.test("upload handshake sends the built request to the provider", async () => {
  const provider = fakeYouTube();
  const request = buildYoutubeUploadRequest({
    metadata: { youtube_visibility: "public", youtube_contains_synthetic_media: true },
    ...baseInput,
  });

  const uploadUrl = await initiateYoutubeUpload({
    accessToken: "token-123",
    videoSize: 2048,
    mimeType: "video/mp4",
    request,
    fetchImpl: provider.fetchImpl,
  });

  assertEquals(uploadUrl, "https://upload.example/fake-session");
  assertEquals(provider.calls.length, 1);

  const call = provider.calls[0];
  assertEquals(call.init.method, "POST");
  assertStringIncludes(call.url, "uploadType=resumable");
  assertStringIncludes(call.url, "part=snippet,status");
  assertEquals(headersOf(call).get("Authorization"), "Bearer token-123");
  assertEquals(headersOf(call).get("X-Upload-Content-Length"), "2048");
  assertEquals(headersOf(call).get("X-Upload-Content-Type"), "video/mp4");

  const body = bodyOf(call);
  assertEquals(body.status.privacyStatus, "public");
  assertEquals(body.status.containsSyntheticMedia, true);
});

Deno.test("upload handshake reports an expired authorization", async () => {
  const provider = fakeYouTube({ status: 401 });

  const error = await assertRejects(() =>
    initiateYoutubeUpload({
      accessToken: "stale",
      videoSize: 1,
      mimeType: "video/mp4",
      request: buildYoutubeUploadRequest({ metadata: {}, ...baseInput }),
      fetchImpl: provider.fetchImpl,
    })
  );

  assertStringIncludes(errorMessage(error), "authentication expired");
});

Deno.test("upload handshake reports an exhausted quota", async () => {
  const provider = fakeYouTube({
    status: 403,
    payload: { error: { errors: [{ reason: "quotaExceeded" }], message: "quota" } },
  });

  const error = await assertRejects(() =>
    initiateYoutubeUpload({
      accessToken: "token",
      videoSize: 1,
      mimeType: "video/mp4",
      request: buildYoutubeUploadRequest({ metadata: {}, ...baseInput }),
      fetchImpl: provider.fetchImpl,
    })
  );

  assertStringIncludes(errorMessage(error), "quota exceeded");
});

Deno.test("upload handshake reports a missing upload location", async () => {
  const provider = fakeYouTube({ location: null });

  const error = await assertRejects(() =>
    initiateYoutubeUpload({
      accessToken: "token",
      videoSize: 1,
      mimeType: "video/mp4",
      request: buildYoutubeUploadRequest({ metadata: {}, ...baseInput }),
      fetchImpl: provider.fetchImpl,
    })
  );

  assertStringIncludes(errorMessage(error), "did not return an upload URL");
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
