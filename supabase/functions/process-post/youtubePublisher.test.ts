import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  buildYoutubeUploadRequest,
  buildYoutubeUploadUrl,
  youtubeUploadSettingsFromBody,
  type YoutubeUploadRequest,
} from "./youtubePublisher.ts";
import { createYoutubeResumableSession } from "./youtubeResumableUpload.ts";
import {
  YOUTUBE_DEFAULT_CATEGORY_ID,
  YOUTUBE_STALE_SCHEDULE_WARNING_MESSAGE,
} from "../_shared/youtubePublishOptions.ts";

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

Deno.test("upload request never asserts a declaration the creator did not make", () => {
  const request = buildYoutubeUploadRequest({ metadata: {}, ...baseInput });

  assertEquals(statusOf(request).selfDeclaredMadeForKids, undefined);
  assertEquals(statusOf(request).containsSyntheticMedia, undefined);

  const explicitNo = buildYoutubeUploadRequest({
    metadata: {
      youtube_made_for_kids: false,
      youtube_contains_synthetic_media: false,
    },
    ...baseInput,
  });
  assertEquals(statusOf(explicitNo).selfDeclaredMadeForKids, false);
  assertEquals(statusOf(explicitNo).containsSyntheticMedia, false);
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

// ───────────────────────────────────────────────────────────────────────────
// Native scheduling
//
// A post that asks for no schedule has to keep producing EXACTLY the request
// it produced before native scheduling existed. `undefined`, `null` and `""`
// all mean "no schedule", and not one of them may change a byte of it.
//
// The baselines below were recorded from the publisher before this feature
// existed. They are the contract, not a description of the current behaviour.
// ───────────────────────────────────────────────────────────────────────────

/** The clock the schedule is judged against. */
const SCHEDULE_NOW = new Date("2026-11-27T00:00:00.000Z");
/** A time the provider can be given: far enough ahead, and not too far. */
const SCHEDULED_PUBLISH_AT = "2026-12-01T10:00:00.000Z";

interface BaselineCase {
  /** What the case is, so a failure says which request changed. */
  name: string;
  metadata: Record<string, unknown>;
  request: {
    url: string;
    part: string;
    body: Record<string, unknown>;
    notifySubscribers: boolean;
    warnings: string[];
  };
}

const BASELINE_CASES: BaselineCase[] = [
  {
    name: "a post that names no YouTube option",
    metadata: {},
    request: {
      url: "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      part: "snippet,status",
      body: {
        snippet: {
          title: "A video",
          description: "A description",
          tags: ["one"],
          categoryId: "22",
        },
        status: {
          privacyStatus: "private",
          embeddable: true,
          publicStatsViewable: true,
          license: "youtube",
        },
      },
      notifySubscribers: true,
      warnings: [],
    },
  },
  {
    name: "a post that names the documented options",
    metadata: {
      youtube_visibility: "public",
      youtube_category: "10",
      youtube_video_language: "en",
      youtube_allow_embedding: false,
      youtube_public_stats_viewable: false,
      youtube_license: "creativeCommon",
    },
    request: {
      url: "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      part: "snippet,status",
      body: {
        snippet: {
          title: "A video",
          description: "A description",
          tags: ["one"],
          categoryId: "10",
          defaultLanguage: "en",
        },
        status: {
          privacyStatus: "public",
          embeddable: false,
          publicStatsViewable: false,
          license: "creativeCommon",
        },
      },
      notifySubscribers: true,
      warnings: [],
    },
  },
  {
    name: "a post that declares and adds the extras",
    metadata: {
      youtube_visibility: "unlisted",
      youtube_made_for_kids: false,
      youtube_contains_synthetic_media: true,
      youtube_notify_subscribers: false,
      youtube_recording_date: "2026-11-16",
      youtube_has_paid_product_placement: true,
    },
    request: {
      url: "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status,recordingDetails,paidProductPlacementDetails&notifySubscribers=false",
      part: "snippet,status,recordingDetails,paidProductPlacementDetails",
      body: {
        snippet: {
          title: "A video",
          description: "A description",
          tags: ["one"],
          categoryId: "22",
        },
        status: {
          privacyStatus: "unlisted",
          embeddable: true,
          publicStatsViewable: true,
          license: "youtube",
          selfDeclaredMadeForKids: false,
          containsSyntheticMedia: true,
        },
        recordingDetails: { recordingDate: "2026-11-16" },
        paidProductPlacementDetails: { hasPaidProductPlacement: true },
      },
      notifySubscribers: false,
      warnings: [],
    },
  },
  {
    name: "a post that names the options YouTube does not document",
    metadata: {
      youtube_audio_language: "en",
      youtube_allowed_countries: ["US"],
      youtube_blocked_countries: ["DE"],
    },
    request: {
      url: "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status,contentDetails",
      part: "snippet,status,contentDetails",
      body: {
        snippet: {
          title: "A video",
          description: "A description",
          tags: ["one"],
          categoryId: "22",
          defaultAudioLanguage: "en",
        },
        status: {
          privacyStatus: "private",
          embeddable: true,
          publicStatsViewable: true,
          license: "youtube",
        },
        contentDetails: {
          regionRestriction: {
            allowed: ["US"],
            blocked: ["DE"],
          },
        },
      },
      notifySubscribers: true,
      warnings: [
        "YouTube does not document youtube_default_audio_language as settable at upload time. It was sent on a best-effort basis and may not have been applied.",
        "YouTube does not document youtube_allowed_countries as settable at upload time. It was sent on a best-effort basis and may not have been applied.",
        "YouTube does not document youtube_blocked_countries as settable at upload time. It was sent on a best-effort basis and may not have been applied.",
      ],
    },
  },
];

Deno.test("a post that asks for no schedule keeps the recorded request", () => {
  for (const baseline of BASELINE_CASES) {
    // The key omitted, the key present and empty, and the key present and
    // null all mean the same thing: no schedule.
    const requests = [
      buildYoutubeUploadRequest({ metadata: baseline.metadata, ...baseInput }),
      buildYoutubeUploadRequest({
        metadata: { ...baseline.metadata, youtube_publish_at: undefined },
        ...baseInput,
      }),
      buildYoutubeUploadRequest({
        metadata: { ...baseline.metadata, youtube_publish_at: null },
        ...baseInput,
      }),
      buildYoutubeUploadRequest({
        metadata: { ...baseline.metadata, youtube_publish_at: "" },
        ...baseInput,
      }),
    ];

    for (const request of requests) {
      assertEquals(
        {
          url: request.url,
          part: request.part,
          body: request.body,
          notifySubscribers: request.notifySubscribers,
          warnings: request.warnings,
        },
        baseline.request,
        baseline.name,
      );
    }
  }
});

Deno.test("a scheduled upload is private and carries the publish time", () => {
  const request = buildYoutubeUploadRequest({
    metadata: { youtube_visibility: "public", youtube_publish_at: SCHEDULED_PUBLISH_AT },
    ...baseInput,
    now: SCHEDULE_NOW,
  });

  // YouTube only accepts a publish time on a private video, and it makes the
  // video public at that time.
  assertEquals(statusOf(request).privacyStatus, "private");
  assertEquals(statusOf(request).publishAt, SCHEDULED_PUBLISH_AT);
  assertEquals(request.scheduleWarning, undefined);
  assertEquals(request.warnings, []);
});

Deno.test("a schedule that cannot be honoured ends private and unscheduled", () => {
  const unusable: Array<{ name: string; value: unknown }> = [
    { name: "a value that is not a date", value: "not-a-date" },
    { name: "a time that is too soon", value: new Date(SCHEDULE_NOW.getTime() + 5 * 60_000).toISOString() },
    { name: "a time that has passed", value: new Date(SCHEDULE_NOW.getTime() - 60 * 60_000).toISOString() },
    {
      name: "a time that is too far ahead",
      value: new Date(SCHEDULE_NOW.getTime() + 3 * 365 * 24 * 60 * 60_000).toISOString(),
    },
    { name: "a value that is not a string", value: 12345 },
  ];

  for (const schedule of unusable) {
    const request = buildYoutubeUploadRequest({
      metadata: { youtube_visibility: "public", youtube_publish_at: schedule.value },
      ...baseInput,
      now: SCHEDULE_NOW,
    });

    // The video is never published earlier or wider than the post asked for.
    assertEquals(statusOf(request).privacyStatus, "private", schedule.name);
    assertEquals(statusOf(request).publishAt, undefined, schedule.name);
    assertEquals(request.scheduleWarning, "stale_schedule", schedule.name);
    assert(
      request.warnings.includes(YOUTUBE_STALE_SCHEDULE_WARNING_MESSAGE),
      `${schedule.name}: ${request.warnings.join(" ")}`,
    );
  }
});

// ───────────────────────────────────────────────────────────────────────────
// The settings of a request that is made later
//
// A worker that opens the provider session later has to make the SAME request
// as the one that was approved: the same parts, and the same answer to the
// subscriber notification. A request that notifies when the approved one did
// not tells the channel's subscribers about a video the customer wanted quiet.
// ───────────────────────────────────────────────────────────────────────────

Deno.test("the request url keeps the parts the request writes", () => {
  const url = buildYoutubeUploadUrl({ part: "snippet,status,recordingDetails", notifySubscribers: true });
  assertStringIncludes(url, "part=snippet,status,recordingDetails");
});

Deno.test("the request url says when the subscribers are not notified", () => {
  const url = buildYoutubeUploadUrl({ part: "snippet,status", notifySubscribers: false });
  assertStringIncludes(url, "notifySubscribers=false");
});

Deno.test("the request url leaves the notification out when the subscribers are notified", () => {
  const url = buildYoutubeUploadUrl({ part: "snippet,status", notifySubscribers: true });
  assertEquals(url.includes("notifySubscribers"), false);
});

Deno.test("the request the post builds carries its own settings", () => {
  const request = buildYoutubeUploadRequest({
    metadata: { youtube_notify_subscribers: false },
    ...baseInput,
  });

  // The url and the settings are the same thing: a request that is rebuilt
  // from the settings cannot drift away from the one that was approved.
  assertStringIncludes(request.url, `part=${request.part}`);
  assertStringIncludes(request.url, "notifySubscribers=false");
  assertEquals(request.notifySubscribers, false);
});

Deno.test("a request that notifies says so in its url", () => {
  const request = buildYoutubeUploadRequest({ metadata: {}, ...baseInput });

  assertEquals(request.notifySubscribers, true);
  assertEquals(request.url.includes("notifySubscribers"), false);
});

Deno.test("the fallback settings name the fields the body carries", () => {
  const settings = youtubeUploadSettingsFromBody({
    snippet: { title: "A video" },
    status: { privacyStatus: "private" },
  });

  assertEquals(settings.part, "snippet,status");
});

Deno.test("the fallback settings notify the way the provider does by default", () => {
  const settings = youtubeUploadSettingsFromBody({ snippet: { title: "A video" } });
  assertEquals(settings.notifySubscribers, true);
});

Deno.test("the fallback settings of an empty body still name a writable part", () => {
  const settings = youtubeUploadSettingsFromBody({});
  assertEquals(settings.part, "snippet,status");
});

Deno.test("native upload initialization refuses redirects at the fetch boundary", async () => {
  const request = buildYoutubeUploadRequest({ metadata: {}, ...baseInput });
  const redirectModes: Array<RequestRedirect | undefined> = [];
  const transport: typeof fetch = (_url, init) => {
    redirectModes.push(init?.redirect);
    return Promise.resolve(new Response(null, {
      status: 307,
      headers: { Location: "https://redirect.invalid/upload" },
    }));
  };

  await assertRejects(() => createYoutubeResumableSession({
    fetchImpl: transport,
    accessToken: "fixture-oauth",
    url: request.url,
    body: request.body,
    totalBytes: 1024,
    mimeType: "video/mp4",
  }), Error, "redirect");
  assertEquals(redirectModes, ["manual"]);
});
