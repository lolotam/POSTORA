import { supabase } from "@/integrations/supabase/client";
import { fetchCdnStorageConfig, type CdnStorageConfig } from "@/lib/cdnConfig";
import { resolveMediaPublicUrl, type MediaProviderRow } from "@/lib/mediaUrl";
import type { TikTokReviewGateway } from "../application/ports";
import { ReviewGatewayError } from "../application/ports";
import type { MediaPreview, TikTokAccount } from "../domain/types";
import {
  envelopeError,
  parseCreatorInfo,
  parseDraft,
  parseDraftList,
  parsePublishStatus,
  parseSubmissionResult,
  unwrapData,
} from "./reviewPayload";

type InvokeError = { message?: string; context?: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function errorFromInvoke(error: InvokeError): Promise<ReviewGatewayError> {
  const context = error.context;
  if (context instanceof Response) {
    const body: unknown = await context.clone().json().catch(() => null);
    return envelopeError(body, context.status);
  }
  if (isRecord(context)) {
    const status = typeof context.status === "number" ? context.status : 500;
    return envelopeError(context, status);
  }
  return new ReviewGatewayError("INTERNAL", error.message || "TikTok review request failed.", 500);
}

async function invoke(body: Record<string, unknown>): Promise<unknown> {
  const invoked = await supabase.functions.invoke("tiktok-review", { body });
  if (invoked.error) {
    throw await errorFromInvoke(invoked.error);
  }
  return unwrapData(invoked.data);
}

function storagePublicUrl(bucket: string, path: string): string {
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

function durationFromMetadata(metadata: unknown): number | null {
  if (!isRecord(metadata)) return null;
  const duration = metadata.duration;
  return typeof duration === "number" && Number.isFinite(duration) ? duration : null;
}

function asFileType(value: string): MediaPreview["fileType"] {
  if (value === "image" || value === "video" || value === "gif") return value;
  throw new ReviewGatewayError("INTERNAL", "That library file is not a supported video.", 500);
}


export function createSupabaseReviewGateway(): TikTokReviewGateway {
  let cdnConfig: CdnStorageConfig | null = null;

  async function cdn(): Promise<CdnStorageConfig> {
    if (cdnConfig) return cdnConfig;
    const loaded = await fetchCdnStorageConfig();
    cdnConfig = loaded;
    return loaded;
  }

  return {
    async listAccounts() {
      const { data, error } = await supabase
        .from("social_accounts")
        .select("id, platform_username, avatar_url")
        .eq("platform", "tiktok")
        .eq("is_active", true);
      if (error) throw new ReviewGatewayError(error.code || "INTERNAL", error.message, 500);
      return (data ?? []).map((row): TikTokAccount => ({
        id: row.id,
        username: row.platform_username ?? "",
        avatarUrl: row.avatar_url,
      }));
    },

    async creatorInfo(accountId) {
      return parseCreatorInfo(await invoke({ action: "creator_info", accountId }));
    },

    async list(accountId, state) {
      return parseDraftList(await invoke({ action: "list", accountId, state }));
    },

    async get(draftId) {
      return parseDraft(await invoke({ action: "get", draftId }));
    },

    async create(accountId) {
      return parseDraft(await invoke({ action: "create", accountId }));
    },

    async save(draftId, expectedRevision, patch) {
      return parseDraft(await invoke({
        action: "save",
        draftId,
        expectedRevision,
        caption: patch.caption,
        mediaFileId: patch.mediaFileId,
        mediaDurationSec: patch.mediaDurationSec,
        settings: patch.settings,
      }));
    },

    async reject(draftId, expectedRevision, reason) {
      return parseDraft(await invoke({ action: "reject", draftId, expectedRevision, reason }));
    },

    async archive(draftId, expectedRevision) {
      return parseDraft(await invoke({ action: "archive", draftId, expectedRevision }));
    },

    async restore(draftId, expectedRevision) {
      return parseDraft(await invoke({ action: "restore", draftId, expectedRevision }));
    },

    async reopen(draftId, expectedRevision) {
      return parseDraft(await invoke({ action: "reopen", draftId, expectedRevision }));
    },

    async submit(command) {
      return parseSubmissionResult(await invoke({
        action: "submit",
        draftId: command.draftId,
        expectedRevision: command.expectedRevision,
        requestId: command.requestId,
        mode: command.mode,
        scheduledAt: command.scheduledAt,
        timeZone: command.timeZone,
        consent: command.consent,
      }));
    },

    async status(submissionId) {
      return parsePublishStatus(await invoke({ action: "status", submissionId }));
    },

    async resolveMediaPreview(mediaFileId) {
      const { data, error } = await supabase
        .from("media_files")
        .select("id, file_path, file_type, storage_bucket, current_object_version, metadata, media_file_providers(provider, object_version, status, delivery_url)")
        .eq("id", mediaFileId)
        .maybeSingle();
      if (error) throw new ReviewGatewayError(error.code || "INTERNAL", error.message, 500);
      if (!data) return null;
      const providers: MediaProviderRow[] = (data.media_file_providers ?? []).flatMap((row) => {
        if (!row.provider || !row.status) return [];
        return [{
          provider: row.provider,
          status: row.status,
          object_version: row.object_version,
          delivery_url: row.delivery_url,
        }];
      });
      const previewUrl = resolveMediaPublicUrl(data, storagePublicUrl, providers, await cdn());
      if (!previewUrl) return null;
      return {
        previewUrl,
        fileType: asFileType(data.file_type),
        durationSec: durationFromMetadata(data.metadata),
      };
    },
  };
}
