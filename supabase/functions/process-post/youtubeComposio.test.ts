/**
 * Managed YouTube publishing is disabled at final dispatch.
 *
 * The provider cannot send either mandatory declaration (an explicit No is
 * still a declaration), and the exactly-once pre-execute receipt is not
 * proven. Every call therefore refuses BEFORE a signed URL, a ledger row, a
 * connection lookup or a tool call. These tests are the receipt for that
 * fence; the older happy-path tests were removed because the path is not
 * reachable in this delivery.
 */

import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  YoutubeComposioDispatchUnavailableError,
} from "../_shared/youtubePublishSafety.ts";
import {
  publishYouTubeViaComposio,
  type YouTubeComposioDeps,
} from "./youtubeComposio.ts";
import type { ComposioFileUploadInput } from "../_shared/composioFiles.ts";

function harness() {
  const calls = {
    ledger: [] as Record<string, unknown>[],
    accountUpdates: [] as Record<string, unknown>[],
    signed: [] as string[],
    fetched: [] as string[],
    uploads: [] as ComposioFileUploadInput[],
    executions: [] as Record<string, unknown>[],
  };
  const admin = {
    from(table: string) {
      if (table === "connector_call_logs") {
        return {
          insert: async (row: Record<string, unknown>) => {
            calls.ledger.push(row);
            return { error: null };
          },
        };
      }
      if (table === "social_accounts") {
        return {
          update: (values: Record<string, unknown>) => ({
            eq: async () => {
              calls.accountUpdates.push(values);
              return { error: null };
            },
          }),
        };
      }
      // The owner-workspace fallback and the connection lookup must never be
      // reached either: the refusal comes first.
      return {
        select() { return this; },
        eq() { return this; },
        async maybeSingle() {
          throw new Error("managed lookup must not happen before the dispatch refusal");
        },
      };
    },
  };
  const deps: YouTubeComposioDeps = {
    admin,
    client: {
      executeTool: async (input: Record<string, unknown>) => {
        calls.executions.push(input);
        return { successful: true, data: { id: "never" } };
      },
    } as never,
    signedUrlFor: async (file) => {
      calls.signed.push(file.file_path);
      return "https://signed.invalid/video";
    },
    fetch: ((url: string | URL | Request) => {
      calls.fetched.push(String(url));
      return Promise.resolve(new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    }) as typeof fetch,
    uploadFile: async (_client: unknown, input: ComposioFileUploadInput) => {
      calls.uploads.push(input);
      return { name: "short.mp4", mimetype: "video/mp4", s3key: "youtube/upload/short.mp4" };
    },
  };
  return { deps, calls };
}

const account = { id: "social-1", user_id: "owner-1", connection_id: "connection-1", workspace_id: "workspace-1" };
const video = {
  id: "media-1",
  file_path: "owner-1/video.mp4",
  file_type: "video",
  storage_bucket: "media",
  mime_type: "video/mp4",
  file_size: 1024,
};

Deno.test("managed dispatch refuses a queued post with no declarations", async () => {
  const { deps, calls } = harness();
  await assertRejects(
    () => publishYouTubeViaComposio(account, { id: "post-1", metadata: {} }, [video], deps),
    YoutubeComposioDispatchUnavailableError,
  );
  assertEquals(calls.ledger, []);
  assertEquals(calls.accountUpdates, []);
  assertEquals(calls.signed, []);
  assertEquals(calls.fetched, []);
  assertEquals(calls.uploads, []);
  assertEquals(calls.executions, []);
});

Deno.test("an explicit No/No is a declaration but still cannot be sent by the provider", async () => {
  const { deps, calls } = harness();
  await assertRejects(
    () => publishYouTubeViaComposio(
      account,
      {
        id: "post-2",
        metadata: { youtube_made_for_kids: false, youtube_contains_synthetic_media: false },
      },
      [video],
      deps,
    ),
    YoutubeComposioDispatchUnavailableError,
  );
  assertEquals(calls.ledger, []);
  assertEquals(calls.signed, []);
  assertEquals(calls.executions, []);
});

Deno.test("an affirmative declaration is refused before any ledger or provider work", async () => {
  const { deps, calls } = harness();
  await assertRejects(
    () => publishYouTubeViaComposio(
      account,
      {
        id: "post-3",
        metadata: { youtube_made_for_kids: true, youtube_contains_synthetic_media: false },
      },
      [video],
      deps,
    ),
    YoutubeComposioDispatchUnavailableError,
  );
  assertEquals(calls.ledger, []);
  assertEquals(calls.signed, []);
  assertEquals(calls.executions, []);
});
