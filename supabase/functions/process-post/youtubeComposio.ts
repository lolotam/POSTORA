import {
  type ComposioClient,
  ComposioError,
} from "../_shared/composioClient.ts";
import { loadActiveConnection } from "../_shared/composioConnections.ts";
import { uploadFileForTool } from "../_shared/composioFiles.ts";
import { composioBinding } from "../_shared/connectorRegistry.ts";
import {
  ConnectorRefusal,
  resolveWorkspaceForCall,
  withConnectorCall,
} from "../_shared/connectorTelemetry.ts";

// Provisional (spec §10.6): Composio does not fetch from a URL, so the bytes
// cross this worker twice (storage read, then the presigned PUT) inside one
// 50 s budget under the 60 s worker ceiling. Raise only after a measured
// production upload.
export const YOUTUBE_COMPOSIO_MAX_BYTES = 64 * 1024 * 1024;
export const YOUTUBE_COMPOSIO_TIMEOUT_MS = 50_000;

const UPLOAD_TOOL = "YOUTUBE_MULTIPART_UPLOAD_VIDEO";
const THUMBNAIL_TOOL = "YOUTUBE_UPDATE_THUMBNAIL";

export interface YouTubeComposioAccount {
  id: string;
  user_id: string;
  connection_id?: string | null;
  workspace_id?: string | null;
}

export interface YouTubeComposioPost {
  id: string;
  caption?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface YouTubeComposioMediaFile {
  id: string;
  file_path: string;
  file_type: string;
  storage_bucket: string;
  mime_type?: string | null;
  file_size?: number | null;
}

export interface YouTubeComposioResult {
  id: string;
  url: string;
}

export interface YouTubeComposioDeps {
  // deno-lint-ignore no-explicit-any
  admin: any;
  client: ComposioClient | null;
  signedUrlFor: (file: YouTubeComposioMediaFile) => Promise<string>;
  /** Reads the signed storage URL and PUTs to Composio's presigned slot. */
  fetch?: typeof fetch;
  uploadFile?: typeof uploadFileForTool;
  timeoutMs?: number;
}

const NATIVE_VIDEO_REQUIRED_MESSAGE =
  "YouTube requires a video file. Please upload a video to post to YouTube.";

function isVideo(file: YouTubeComposioMediaFile): boolean {
  return file.file_type === "video" ||
    file.mime_type?.startsWith("video/") === true;
}

function safeTitle(post: YouTubeComposioPost): string {
  const configured = post.metadata?.youtube_title;
  if (typeof configured === "string" && configured.trim()) return configured;
  const firstLine = post.caption?.split(/\r?\n/, 1)[0]?.trim();
  return firstLine || "New Video";
}

function stringMetadata(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringArrayMetadata(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string[] {
  const value = metadata?.[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** A Composio-side timeout is the same outcome as our own abort: a `timeout` row. */
function asTimeoutIfComposioTimedOut(error: unknown): unknown {
  return error instanceof ComposioError && error.code === "composio_timeout"
    ? new DOMException("Composio YouTube request timed out", "AbortError")
    : error;
}

async function readVideoBytes(
  url: string,
  signal: AbortSignal,
  fetchImpl: typeof fetch,
): Promise<Uint8Array<ArrayBuffer>> {
  const response = await fetchImpl(url, { signal });
  if (!response.ok) throw new Error("youtube_media_download_failed");
  const declaredSize = Number(response.headers.get("content-length"));
  if (declaredSize > YOUTUBE_COMPOSIO_MAX_BYTES) {
    throw new ConnectorRefusal("youtube_file_too_large");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > YOUTUBE_COMPOSIO_MAX_BYTES) {
    throw new ConnectorRefusal("youtube_file_too_large");
  }
  return bytes;
}

function uploadFilename(file: YouTubeComposioMediaFile): string {
  return file.file_path.split(/[\\/]/).at(-1)?.split("?", 1)[0] ||
    `${file.id}.mp4`;
}

function uploadArguments(
  post: YouTubeComposioPost,
  videoFile: { name: string; mimetype: string; s3key: string },
): Record<string, unknown> {
  const metadata = post.metadata;
  return {
    title: safeTitle(post),
    description: stringMetadata(metadata, "youtube_description") ??
      post.caption ?? "",
    categoryId: stringMetadata(metadata, "youtube_category") ?? "22",
    privacyStatus: stringMetadata(metadata, "youtube_visibility") ?? "public",
    tags: stringArrayMetadata(metadata, "youtube_tags"),
    videoFile,
  };
}

function videoIdFrom(result: { successful: boolean; data: unknown }): string {
  const data = result.data && typeof result.data === "object"
    ? result.data as Record<string, unknown>
    : null;
  const id = data && typeof data.id === "string" ? data.id : null;
  if (!result.successful || !id) throw new Error("youtube_upload_failed");
  return id;
}

export async function publishYouTubeViaComposio(
  account: YouTubeComposioAccount,
  post: YouTubeComposioPost,
  mediaFiles: YouTubeComposioMediaFile[],
  deps: YouTubeComposioDeps,
): Promise<YouTubeComposioResult> {
  const timeoutMs = deps.timeoutMs ?? YOUTUBE_COMPOSIO_TIMEOUT_MS;
  const fetchImpl = deps.fetch ?? fetch;
  const uploadFile = deps.uploadFile ?? uploadFileForTool;
  const binding = composioBinding("youtube");
  // social_accounts.workspace_id is nullable but connector_call_logs.workspace_id
  // is a NOT NULL uuid: the `?? ""` this replaces made the ledger insert throw
  // `invalid input syntax for type uuid` and the swallow in recordConnectorCall
  // hid it, so Composio YouTube uploads went unledgered. Spec §4.3: the
  // account's workspace when known, else the owner's personal workspace.
  // Resolved before withConnectorCall so the meta never carries an invalid id.
  const workspaceId = account.workspace_id ??
    await resolveWorkspaceForCall(deps.admin, { userId: account.user_id });
  const meta = (actionName: string) => ({
    workspaceId,
    connectionId: account.connection_id ?? null,
    socialAccountId: account.id,
    connectorType: "youtube",
    authStrategy: "composio_oauth" as const,
    actionName,
    source: "publish" as const,
  });

  // One ledger row and one abort signal for the whole upload: preflight, the
  // storage read, the presigned PUT and the execute share the 50 s budget, so
  // the worker ceiling can never kill a step that is still recording nothing.
  const { client, connection, videoId } = await withConnectorCall(
    deps.admin,
    meta(UPLOAD_TOOL),
    async (signal) => {
      if (!deps.client || !binding) {
        throw new ConnectorRefusal("connector_unavailable");
      }
      if (!account.connection_id) {
        throw new ConnectorRefusal("connection_inactive");
      }
      const lookup = await loadActiveConnection(
        deps.admin,
        account.connection_id,
        workspaceId,
      );
      if (!lookup.ok) {
        if (lookup.code === "connection_inactive") {
          const { error } = await deps.admin.from("social_accounts")
            .update({ needs_reauth: true }).eq("id", account.id);
          if (error) throw new Error("account_reauth_update_failed");
        }
        throw new ConnectorRefusal(lookup.code);
      }
      const video = mediaFiles.find(isVideo);
      if (!video) {
        throw new ConnectorRefusal(
          "youtube_video_required",
          NATIVE_VIDEO_REQUIRED_MESSAGE,
        );
      }
      if ((video.file_size ?? 0) > YOUTUBE_COMPOSIO_MAX_BYTES) {
        throw new ConnectorRefusal("youtube_file_too_large");
      }

      const bytes = await readVideoBytes(
        await deps.signedUrlFor(video),
        signal,
        fetchImpl,
      );
      try {
        const videoFile = await uploadFile(deps.client, {
          toolkit: binding.toolkit,
          tool: UPLOAD_TOOL,
          filename: uploadFilename(video),
          mimetype: video.mime_type || "video/mp4",
          bytes,
          signal,
        }, { fetch: fetchImpl });
        const upload = await deps.client.executeTool({
          slug: UPLOAD_TOOL,
          version: binding.toolkitVersion,
          workspaceId: lookup.connection.workspaceId,
          connectedAccountId: lookup.connection.composioConnectedAccountId,
          arguments: uploadArguments(post, videoFile),
          signal,
        });
        return {
          client: deps.client,
          connection: lookup.connection,
          videoId: videoIdFrom(upload),
        };
      } catch (error) {
        throw asTimeoutIfComposioTimedOut(error);
      }
    },
    { timeoutMs },
  );

  const thumbnailUrl = stringMetadata(post.metadata, "youtube_thumbnail_url");
  if (thumbnailUrl) {
    try {
      await withConnectorCall(
        deps.admin,
        meta(THUMBNAIL_TOOL),
        async (signal) => {
          const updated = await client.executeTool({
            slug: THUMBNAIL_TOOL,
            version: binding!.toolkitVersion,
            workspaceId: connection.workspaceId,
            connectedAccountId: connection.composioConnectedAccountId,
            arguments: { videoId, thumbnailUrl },
            signal,
          });
          if (!updated.successful) {
            throw new Error("youtube_thumbnail_update_failed");
          }
        },
        { timeoutMs },
      );
    } catch {
      // Best effort by contract (spec §10.3 step 4); the failed row is already written.
    }
  }

  return { id: videoId, url: `https://youtu.be/${videoId}` };
}
