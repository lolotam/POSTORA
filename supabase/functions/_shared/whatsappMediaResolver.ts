// Lazy materialization of WhatsApp inbound media: sign a cached object, or fetch
// through the existing inbound fetchers, upload, persist the storage path, then sign.
//
// media_url holds either an http(s):// provider URL (legacy/coexistence) or a
// bucket-relative storage path. This module branches on the http prefix.
// Spec: docs/specs/2026-08-25-whatsapp-chat-experience.md §7.

import {
  CloudGraphFetcher,
  DirectUrlFetcher,
  EvolutionFetcher,
  MediaFetchError,
  selectFetcher,
  type FetchedMedia,
  type InboundMediaFetcher,
  type MediaRef,
} from "./inboundMediaFetchers.ts";
import {
  attachmentKindFromMediaType,
  type WhatsAppAttachmentKind,
} from "./whatsappMessageView.ts";
import type { WhatsAppAccountAccess } from "./whatsappWorkspaceAccess.ts";

export const MEDIA_UNAVAILABLE = "MEDIA_UNAVAILABLE";
const MEDIA_BUCKET = "media";
const INBOUND_SIGN_TTL_SECONDS = 3600;
export const OUTBOUND_SIGN_TTL_SECONDS = 7 * 24 * 3600;
export const MAX_MEDIA_ROWS = 10;
const MAX_CONCURRENT_FETCHES = 2;
const PER_ITEM_MAX_BYTES = 16 * 1024 * 1024;
const AGGREGATE_BUDGET_BYTES = 24 * 1024 * 1024;
const BATCH_DEADLINE_MS = 20_000;

export interface ResolveWhatsAppMediaRequest {
  messageRowIds: string[];
}

export interface WhatsAppMediaItem {
  message_row_id: string;
  kind: WhatsAppAttachmentKind;
  url: string | null;
  expires_in?: number;
  mime_type?: string | null;
  file_name?: string;
  size_bytes?: number;
  error?: typeof MEDIA_UNAVAILABLE;
}

export interface ResolveWhatsAppMediaDeps {
  fetchers?: InboundMediaFetcher[];
  httpFetch?: typeof fetch;
  perItemMaxBytes?: number;
  aggregateBudgetBytes?: number;
  maxConcurrent?: number;
  maxRows?: number;
  deadlineMs?: number;
  signTtlSeconds?: number;
}

interface MessageMediaRow {
  id: string;
  message_id: string | null;
  media_url: string | null;
  media_type: string | null;
  media_metadata: unknown;
  social_account_id: string;
}

function isHttpMediaUrl(value: string | null | undefined): boolean {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

export function isUnusableProviderId(messageId: string | null | undefined): boolean {
  if (typeof messageId !== "string" || messageId.length === 0) return true;
  return messageId.startsWith("sched_");
}

/**
 * First path segment must be the caller's own uid. Rejects traversal, absolute
 * URLs, and a foreign uid so this cannot become an SSRF or cross-tenant read.
 */
export function ownedStoragePath(mediaPath: string, callerUserId: string): string {
  if (typeof mediaPath !== "string" || mediaPath.length === 0) {
    throw new Error("media_path is invalid");
  }
  if (mediaPath.includes("\\") || mediaPath.includes("\0") || mediaPath.includes("..")) {
    throw new Error("media_path is invalid");
  }
  if (mediaPath.startsWith("/") || mediaPath.startsWith("//") || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(mediaPath)) {
    throw new Error("media_path is invalid");
  }
  const first = mediaPath.split("/")[0];
  if (first !== callerUserId) {
    throw new Error("media_path is invalid");
  }
  return mediaPath;
}

export async function signMediaPath(
  // deno-lint-ignore no-explicit-any
  admin: any,
  path: string,
  ttlSeconds: number,
): Promise<string | null> {
  const { data, error } = await admin.storage.from(MEDIA_BUCKET).createSignedUrl(path, ttlSeconds);
  if (error || !data?.signedUrl) return null;
  return rewritePublicOrigin(data.signedUrl);
}

export async function resolveWhatsAppMedia(
  // deno-lint-ignore no-explicit-any
  admin: any,
  access: WhatsAppAccountAccess,
  request: ResolveWhatsAppMediaRequest,
  deps: ResolveWhatsAppMediaDeps = {},
): Promise<WhatsAppMediaItem[]> {
  const maxRows = deps.maxRows ?? MAX_MEDIA_ROWS;
  const requestedIds = uniqueStrings(request.messageRowIds);
  const ids = requestedIds.slice(0, maxRows);
  const extras = requestedIds.slice(maxRows);
  if (ids.length === 0 && extras.length === 0) return [];

  const { data, error } = await admin
    .from("whatsapp_messages")
    .select("id, message_id, media_url, media_type, media_metadata, social_account_id")
    .eq("social_account_id", access.accountId)
    .in("id", ids.length > 0 ? ids : [""]);

  if (error) {
    console.error("[whatsapp-media] row lookup failed:", error.message ?? error);
    return request.messageRowIds.slice(0, maxRows).map((id) => unavailable(id, "document"));
  }

  const byId = new Map<string, MessageMediaRow>();
  for (const row of (data ?? []) as MessageMediaRow[]) byId.set(row.id, row);

  const deadlineMs = deps.deadlineMs ?? BATCH_DEADLINE_MS;
  const deadline = abortAfter(deadlineMs);
  const budget = new ByteBudget(deps.aggregateBudgetBytes ?? AGGREGATE_BUDGET_BYTES);
  const perItemMax = deps.perItemMaxBytes ?? PER_ITEM_MAX_BYTES;
  const ttl = deps.signTtlSeconds ?? INBOUND_SIGN_TTL_SECONDS;
  const fetchers = deps.fetchers ?? await defaultFetchers(admin, access);

  const results = new Map<string, WhatsAppMediaItem>();
  const work = ids.map((id) => async () => {
    const row = byId.get(id);
    if (!row) {
      results.set(id, unavailable(id, "document"));
      return;
    }
    results.set(
      id,
      await resolveOne(admin, access, row, {
        fetchers,
        httpFetch: deps.httpFetch,
        budget,
        perItemMax,
        ttl,
        deadline,
      }),
    );
  });

  await runPool(work, deps.maxConcurrent ?? MAX_CONCURRENT_FETCHES);

  const ordered = ids.map((id) => results.get(id) ?? unavailable(id, "document"));
  for (const id of extras) ordered.push(unavailable(id, "document"));
  return ordered;
}

interface ResolveOneOpts {
  fetchers: InboundMediaFetcher[];
  httpFetch?: typeof fetch;
  budget: ByteBudget;
  perItemMax: number;
  ttl: number;
  deadline: AbortSignal;
}

async function resolveOne(
  // deno-lint-ignore no-explicit-any
  admin: any,
  access: WhatsAppAccountAccess,
  row: MessageMediaRow,
  opts: ResolveOneOpts,
): Promise<WhatsAppMediaItem> {
  const kind = attachmentKindFromMediaType(row.media_type);
  const meta = asRecord(row.media_metadata);
  const mime = stringField(meta, "mime_type");
  const fileName = stringField(meta, "filename") ?? stringField(meta, "file_name") ?? undefined;
  const cachedPath = isHttpMediaUrl(row.media_url) ? null : row.media_url;
  const inboundPath = inboundCachePath(access.ownerId, row.id, extensionFor(mime, row.media_type));

  const signedCached = await signExisting(admin, cachedPath ?? inboundPath, opts.ttl);
  if (signedCached) {
    return successItem(row.id, kind, signedCached, opts.ttl, mime, fileName, numberField(meta, "size") ?? numberField(meta, "file_length"));
  }

  if (opts.deadline.aborted) return unavailable(row.id, kind);

  if (access.connectionMode === "evolution_qr" && isUnusableProviderId(row.message_id)) {
    return unavailable(row.id, kind);
  }

  const knownSize = trustedSizeBytes(meta, opts.perItemMax);
  if (knownSize === "too_large") return unavailable(row.id, kind);
  const reservation = knownSize ?? opts.perItemMax;
  const admitted = await opts.budget.acquire(reservation, opts.deadline);
  if (!admitted) return unavailable(row.id, kind);

  // The budget models bytes currently resident in the isolate, so every exit path has to
  // hand them back -- including the successful one, whose bytes are gone the moment the
  // upload returns. `held` tracks what is actually charged: the reservation up front, then
  // the real size after reconcile. Releasing a stale `reservation` after reconciliation
  // would over-release and let more concurrent work in than the budget permits, which is
  // the one guarantee this class exists to provide.
  let held = reservation;
  try {
    const fetched = await fetchBytes(access, row, mime, opts);
    if (!fetched) {
      return unavailable(row.id, kind);
    }
    opts.budget.reconcile(reservation, fetched.bytes.byteLength);
    held = fetched.bytes.byteLength;

    const uploadPath = inboundPath.replace(/\.[^.]+$/, `.${extensionFor(fetched.mimeType, row.media_type)}`);
    const { error: uploadError } = await admin.storage.from(MEDIA_BUCKET).upload(
      uploadPath,
      fetched.bytes,
      { contentType: fetched.mimeType, upsert: true },
    );
    if (uploadError) {
      console.error("[whatsapp-media] upload failed:", uploadError.message ?? uploadError);
      return unavailable(row.id, kind);
    }

    const { error: updateError } = await admin
      .from("whatsapp_messages")
      .update({ media_url: uploadPath })
      .eq("id", row.id)
      .eq("social_account_id", access.accountId);
    if (updateError) {
      console.error("[whatsapp-media] persist path failed:", updateError.message ?? updateError);
    }

    const url = await signMediaPath(admin, uploadPath, opts.ttl);
    if (!url) return unavailable(row.id, kind);
    return successItem(
      row.id,
      kind,
      url,
      opts.ttl,
      fetched.mimeType,
      fileName,
      fetched.bytes.byteLength,
    );
  } catch (error) {
    logFetchFailure(row.id, error);
    return unavailable(row.id, kind);
  } finally {
    opts.budget.release(held);
  }
}

async function fetchBytes(
  access: WhatsAppAccountAccess,
  row: MessageMediaRow,
  mime: string | null,
  opts: ResolveOneOpts,
): Promise<FetchedMedia | null> {
  const ref: MediaRef = {
    platform: "whatsapp",
    connectionMode: access.connectionMode,
    mediaId: isUnusableProviderId(row.message_id) ? null : row.message_id,
    mediaUrl: isHttpMediaUrl(row.media_url) ? row.media_url : null,
    accessToken: access.accessToken,
    mimeType: mime,
  };
  const chosen = selectFetcher(ref, opts.fetchers);
  if (!chosen) return null;
  try {
    return await chosen.fetchMediaBytes(
      ref,
      { maxBytes: opts.perItemMax, timeoutMs: remainingMs(opts.deadline) },
      opts.httpFetch,
      opts.deadline,
    );
  } catch (error) {
    logFetchFailure(row.id, error);
    return null;
  }
}

function logFetchFailure(rowId: string, error: unknown) {
  const reason = error instanceof MediaFetchError
    ? error.reason
    : ((error as Error)?.name === "AbortError" ? "timeout" : "failed");
  console.error(`[whatsapp-media] ${rowId} ${reason}`);
}

function successItem(
  id: string,
  kind: WhatsAppAttachmentKind,
  url: string,
  expiresIn: number,
  mimeType: string | null,
  fileName: string | undefined,
  sizeBytes: number | null | undefined,
): WhatsAppMediaItem {
  const item: WhatsAppMediaItem = {
    message_row_id: id,
    kind,
    url,
    expires_in: expiresIn,
    mime_type: mimeType,
  };
  if (fileName) item.file_name = fileName;
  if (typeof sizeBytes === "number" && Number.isFinite(sizeBytes) && sizeBytes >= 0) {
    item.size_bytes = sizeBytes;
  }
  return item;
}

function unavailable(id: string, kind: WhatsAppAttachmentKind): WhatsAppMediaItem {
  return { message_row_id: id, kind, url: null, error: MEDIA_UNAVAILABLE };
}

async function signExisting(
  // deno-lint-ignore no-explicit-any
  admin: any,
  path: string | null,
  ttl: number,
): Promise<string | null> {
  if (!path) return null;
  return await signMediaPath(admin, path, ttl);
}

async function defaultFetchers(
  // deno-lint-ignore no-explicit-any
  admin: any,
  access: WhatsAppAccountAccess,
): Promise<InboundMediaFetcher[]> {
  const fetchers: InboundMediaFetcher[] = [new CloudGraphFetcher()];
  const baseUrl = Deno.env.get("EVOLUTION_API_URL");
  const apiKey = Deno.env.get("EVOLUTION_API_KEY");
  if (baseUrl && apiKey && access.connectionMode === "evolution_qr") {
    const { data } = await admin
      .from("whatsapp_evolution_instances")
      .select("instance_name")
      .eq("social_account_id", access.accountId)
      .maybeSingle();
    const instanceName = data?.instance_name as string | undefined;
    if (instanceName) fetchers.push(new EvolutionFetcher(baseUrl, apiKey, instanceName));
  }
  fetchers.push(new DirectUrlFetcher());
  return fetchers;
}

export function inboundCachePath(ownerUserId: string, rowId: string, ext: string): string {
  return `${ownerUserId}/whatsapp/inbound/${rowId}.${ext}`;
}

function extensionFor(mime: string | null, mediaType: string | null): string {
  const bare = (mime ?? "").split(";")[0].trim().toLowerCase();
  const fromMime: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/heic": "heic",
    "video/mp4": "mp4",
    "audio/ogg": "ogg",
    "audio/opus": "ogg",
    "audio/mpeg": "mp3",
    "application/pdf": "pdf",
  };
  if (fromMime[bare]) return fromMime[bare];
  if (mediaType === "image" || mediaType === "sticker") return mediaType === "sticker" ? "webp" : "jpg";
  if (mediaType === "video") return "mp4";
  if (mediaType === "audio") return "ogg";
  return "bin";
}

function trustedSizeBytes(
  meta: Record<string, unknown> | null,
  perItemMax: number,
): number | "too_large" | null {
  const raw = numberField(meta, "size") ?? numberField(meta, "file_length") ?? numberField(meta, "size_bytes");
  if (raw == null) return null;
  if (raw > perItemMax) return "too_large";
  return raw;
}

function remainingMs(signal: AbortSignal): number {
  const at = (signal as AbortSignal & { _deadlineAt?: number })._deadlineAt;
  if (typeof at === "number") return Math.max(1, at - Date.now());
  return 10_000;
}

function abortAfter(ms: number): AbortSignal {
  const controller = new AbortController();
  (controller.signal as AbortSignal & { _deadlineAt?: number })._deadlineAt = Date.now() + ms;
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function rewritePublicOrigin(signedUrl: string): string {
  // SUPABASE_URL is the in-cluster Kong address; a URL built from it is
  // unreachable from the browser and from Evolution (same reason generate-image rewrites).
  const base = (
    Deno.env.get("SUPABASE_PUBLIC_URL") ||
    Deno.env.get("API_EXTERNAL_URL") ||
    Deno.env.get("SUPABASE_URL") ||
    ""
  ).replace(/\/$/, "");
  if (!base) return signedUrl;
  try {
    const signed = new URL(signedUrl);
    return `${base}${signed.pathname}${signed.search}`;
  } catch {
    return signedUrl;
  }
}

function uniqueStrings(values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringField(meta: Record<string, unknown> | null, key: string): string | null {
  const value = meta?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(meta: Record<string, unknown> | null, key: string): number | null {
  const value = meta?.[key];
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
}

class ByteBudget {
  private used = 0;
  private waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(bytes: number, signal: AbortSignal): Promise<boolean> {
    while (this.used + bytes > this.limit) {
      if (signal.aborted) return false;
      await this.wait(signal);
    }
    if (signal.aborted) return false;
    this.used += bytes;
    return true;
  }

  reconcile(reserved: number, actual: number) {
    this.used = Math.max(0, this.used - reserved + actual);
    this.notify();
  }

  release(bytes: number) {
    this.used = Math.max(0, this.used - bytes);
    this.notify();
  }

  private notify() {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  private wait(signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        signal.removeEventListener("abort", done);
        resolve();
      };
      this.waiters.push(done);
      signal.addEventListener("abort", done, { once: true });
    });
  }
}

async function runPool(jobs: Array<() => Promise<void>>, concurrency: number): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (next < jobs.length) {
      const current = next;
      next += 1;
      await jobs[current]();
    }
  });
  await Promise.all(workers);
}
