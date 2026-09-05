import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { ComposioError } from "../_shared/composioClient.ts";
import {
  publishYouTubeViaComposio,
  YOUTUBE_COMPOSIO_MAX_BYTES,
  type YouTubeComposioDeps,
} from "./youtubeComposio.ts";

function adminWithConnection(status = "active") {
  const ledger: Record<string, unknown>[] = [];
  const accountUpdates: Record<string, unknown>[] = [];
  const admin = {
    from(table: string) {
      if (table === "connector_call_logs") {
        return {
          insert: async (row: Record<string, unknown>) => {
            ledger.push(row);
            return { error: null };
          },
        };
      }
      if (table === "social_accounts") {
        return {
          update: (values: Record<string, unknown>) => ({
            eq: async () => {
              accountUpdates.push(values);
              return { error: null };
            },
          }),
        };
      }
      if (table === "workspaces") {
        // resolveWorkspaceForCall's personal-workspace fallback.
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          async maybeSingle() {
            return { data: { id: "personal-workspace-1" }, error: null };
          },
        };
      }
      return {
        select() {
          return this;
        },
        eq() {
          return this;
        },
        async maybeSingle() {
          return {
            data: {
              id: "connection-1",
              workspace_id: "workspace-1",
              connector_type: "youtube",
              toolkit: "youtube",
              composio_connected_account_id: status === "active"
                ? "ca-1"
                : null,
              tool_schema_cache: [],
              status,
            },
            error: null,
          };
        },
      };
    },
  };
  return { admin, ledger, accountUpdates };
}

const account = {
  id: "social-1",
  user_id: "owner-1",
  connection_id: "connection-1",
  workspace_id: "workspace-1",
};
const post = {
  id: "post-1",
  caption: "Caption first line\nsecond line",
  metadata: {},
};
const video = {
  id: "media-1",
  file_path: "videos/short.mp4",
  file_type: "video",
  storage_bucket: "media",
  mime_type: "video/mp4",
  file_size: 1024,
};
const VIDEO_BYTES = new Uint8Array([1, 2, 3]);
const STAGED = { name: "short.mp4", mimetype: "video/mp4", s3key: "youtube/upload/short.mp4" };

/** Fakes for the two network edges plus the client; every call is recorded. */
function harness(executeTool: (input: Record<string, unknown>) => Promise<unknown>) {
  const fetched: string[] = [];
  const uploads: Array<Record<string, unknown>> = [];
  const executions: Array<Record<string, unknown>> = [];
  const deps = {
    client: {
      executeTool: async (input: Record<string, unknown>) => {
        executions.push(input);
        return await executeTool(input);
      },
    } as never,
    signedUrlFor: async () => "https://signed.invalid/video",
    fetch: ((url: string | URL | Request) => {
      fetched.push(String(url));
      return Promise.resolve(new Response(VIDEO_BYTES, { status: 200 }));
    }) as typeof fetch,
    uploadFile: async (_client: unknown, input: Record<string, unknown>) => {
      uploads.push(input);
      return STAGED;
    },
  } satisfies Omit<YouTubeComposioDeps, "admin">;
  return { deps, fetched, uploads, executions };
}

Deno.test("Composio YouTube refuses when the client is unavailable and records one refused publish row", async () => {
  const state = adminWithConnection();
  await assertRejects(
    () =>
      publishYouTubeViaComposio(account, post, [video], {
        admin: state.admin,
        client: null,
        signedUrlFor: async () => "https://signed.invalid/video",
      }),
    Error,
    "connector_unavailable",
  );
  assertEquals(state.ledger.length, 1);
  assertEquals(state.ledger[0].status, "refused");
  assertEquals(state.ledger[0].source, "publish");
  assertEquals(state.ledger[0].action_name, "YOUTUBE_MULTIPART_UPLOAD_VIDEO");
});

Deno.test("Composio YouTube marks an inactive connection for reauthentication", async () => {
  const state = adminWithConnection("failed");
  await assertRejects(
    () =>
      publishYouTubeViaComposio(account, post, [video], {
        admin: state.admin,
        client: {} as never,
        signedUrlFor: async () => "unused",
      }),
    Error,
    "connection_inactive",
  );
  assertEquals(state.accountUpdates, [{ needs_reauth: true }]);
});

Deno.test("Composio YouTube refuses a missing video or an oversized file before reading any bytes", async () => {
  const state = adminWithConnection();
  const { deps, fetched, uploads } = harness(async () => ({ successful: true, data: { id: "v" } }));
  await assertRejects(
    () => publishYouTubeViaComposio(account, post, [], { admin: state.admin, ...deps }),
    Error,
    "YouTube requires a video file. Please upload a video to post to YouTube.",
  );
  await assertRejects(
    () =>
      publishYouTubeViaComposio(
        account,
        post,
        [{ ...video, file_size: YOUTUBE_COMPOSIO_MAX_BYTES + 1 }],
        { admin: state.admin, ...deps },
      ),
    Error,
    "youtube_file_too_large",
  );
  assertEquals(fetched, []);
  assertEquals(uploads, []);
  assertEquals(state.ledger.map((row) => row.status), ["refused", "refused"]);
});

Deno.test("Composio YouTube stages the bytes, uploads with the staged file, and returns the canonical URL", async () => {
  const state = adminWithConnection();
  const { deps, fetched, uploads, executions } = harness(async () => ({
    successful: true,
    data: { id: "video-1" },
  }));
  const result = await publishYouTubeViaComposio(
    account,
    {
      ...post,
      metadata: {
        youtube_title: "Title",
        youtube_description: "Description",
        youtube_category: "24",
        youtube_visibility: "unlisted",
        youtube_tags: ["one", "two"],
      },
    },
    [video],
    { admin: state.admin, ...deps },
  );

  assertEquals(result, { id: "video-1", url: "https://youtu.be/video-1" });
  assertEquals(fetched, ["https://signed.invalid/video"]);
  assertEquals(uploads.length, 1);
  assertEquals(uploads[0].tool, "YOUTUBE_MULTIPART_UPLOAD_VIDEO");
  assertEquals(uploads[0].toolkit, "youtube");
  assertEquals(uploads[0].filename, "short.mp4");
  assertEquals(uploads[0].bytes, VIDEO_BYTES);
  assertEquals(executions.length, 1);
  assertEquals(executions[0].slug, "YOUTUBE_MULTIPART_UPLOAD_VIDEO");
  assertEquals(executions[0].version, "20260721_00");
  assertEquals(executions[0].connectedAccountId, "ca-1");
  assertEquals(executions[0].arguments, {
    title: "Title",
    description: "Description",
    categoryId: "24",
    privacyStatus: "unlisted",
    tags: ["one", "two"],
    videoFile: STAGED,
  });
  assertEquals(JSON.stringify(executions).includes("videoFilePath"), false);
  assertEquals(state.ledger.map((row) => [row.status, row.source, row.action_name]), [
    ["success", "publish", "YOUTUBE_MULTIPART_UPLOAD_VIDEO"],
  ]);
});

Deno.test("Composio YouTube thumbnail failure is recorded but does not fail the upload", async () => {
  const state = adminWithConnection();
  const { deps, executions } = harness(async (input) => {
    if (input.slug === "YOUTUBE_UPDATE_THUMBNAIL") throw new Error("provider_failed");
    return { successful: true, data: { id: "video-2" } };
  });
  const result = await publishYouTubeViaComposio(
    account,
    { ...post, metadata: { youtube_thumbnail_url: "https://thumb.invalid/image.jpg" } },
    [video],
    { admin: state.admin, ...deps },
  );
  assertEquals(result.id, "video-2");
  assertEquals(executions[1].arguments, {
    videoId: "video-2",
    thumbnailUrl: "https://thumb.invalid/image.jpg",
  });
  assertEquals(state.ledger.map((row) => [row.status, row.action_name]), [
    ["success", "YOUTUBE_MULTIPART_UPLOAD_VIDEO"],
    ["failed", "YOUTUBE_UPDATE_THUMBNAIL"],
  ]);
});

// connector_call_logs.workspace_id is a NOT NULL uuid: a null social_accounts
// workspace_id must resolve to the owner's personal workspace, never the
// empty string that made every ledger insert throw on 2026-09-03.
Deno.test("Composio YouTube resolves a null account workspace to the owner's personal workspace in the ledger", async () => {
  const state = adminWithConnection();
  const { deps, executions } = harness(async () => ({
    successful: true,
    data: { id: "video-3" },
  }));
  const result = await publishYouTubeViaComposio(
    { ...account, workspace_id: null },
    post,
    [video],
    { admin: state.admin, ...deps },
  );
  assertEquals(result.id, "video-3");
  assertEquals(executions.length, 1);
  assertEquals(state.ledger.length, 1);
  assertEquals(state.ledger[0].workspace_id, "personal-workspace-1");
});

Deno.test("Composio YouTube records our abort and Composio's own timeout both as timeout", async () => {
  for (
    const failure of [
      new DOMException("aborted", "AbortError"),
      new ComposioError("composio_timeout"),
    ]
  ) {
    const state = adminWithConnection();
    const { deps } = harness(async () => {
      throw failure;
    });
    await assertRejects(
      () => publishYouTubeViaComposio(account, post, [video], { admin: state.admin, ...deps }),
      DOMException,
    );
    assertEquals(state.ledger.map((row) => row.status), ["timeout"]);
  }
});
