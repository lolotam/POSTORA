// Orchestrates inbound media understanding: resolve the per-account setting, enforce the
// daily cap, pick a fetcher, understand the bytes, persist the result.
//
// This is the only piece of the feature that touches the database. The understanding
// itself (inboundMediaUnderstanding.ts) and the byte-fetching (inboundMediaFetchers.ts)
// stay independent of it, so a new platform is a fetcher and a new model is a config
// change -- neither is a change here.
//
// Spec: docs/specs/2026-08-25-inbound-media-understanding.md (D4, D6, D7, D9).

import {
  classifyMime,
  DEFAULT_LIMITS,
  understandInboundMedia,
  type MediaKind,
  type UnderstandingLimits,
} from "./inboundMediaUnderstanding.ts";
import {
  CloudGraphFetcher,
  DirectUrlFetcher,
  MediaFetchError,
  selectFetcher,
  type InboundMediaFetcher,
  type MediaRef,
} from "./inboundMediaFetchers.ts";

export const MEDIA_UNDERSTANDING_MODES = ["off", "audio", "audio+image"] as const;
export type MediaUnderstandingMode = (typeof MEDIA_UNDERSTANDING_MODES)[number];

/**
 * Default "off", matching resolveCommentAutomationHandler: this spends money per inbound
 * message and reaches customers, so it is opted into deliberately rather than inherited.
 */
export function resolveMediaUnderstandingMode(metadata: unknown): MediaUnderstandingMode {
  if (!metadata || typeof metadata !== "object") return "off";
  const value = (metadata as Record<string, unknown>).media_understanding;
  return (MEDIA_UNDERSTANDING_MODES as readonly unknown[]).includes(value)
    ? value as MediaUnderstandingMode
    : "off";
}

export function modeAllows(mode: MediaUnderstandingMode, kind: MediaKind): boolean {
  if (mode === "off") return false;
  if (kind === "audio") return true;
  if (kind === "image") return mode === "audio+image";
  return false;
}

export const DEFAULT_DAILY_CAP = 100;

export interface PipelineAccount {
  id: string;
  user_id: string;
  platform_user_id?: string | null;
  connection_mode?: string | null;
  access_token?: string | null;
  account_metadata?: Record<string, unknown> | null;
}

export interface PipelineInput {
  account: PipelineAccount;
  /** Row id in whatsapp_messages, so the result can be written back. */
  messageRowId: string | null;
  mediaId?: string | null;
  mediaUrl?: string | null;
  rawBase64?: string | null;
  mimeType?: string | null;
  /** Any caption the customer typed alongside the media. */
  caption?: string | null;
  platform?: "whatsapp" | "instagram" | "facebook";
}

export type PipelineOutcome =
  | { understood: true; text: string; agentText: string }
  | { understood: false; reason: string };

export interface PipelineDeps {
  fetchers?: InboundMediaFetcher[];
  fetcher?: typeof fetch;
  limits?: UnderstandingLimits;
  dailyCap?: number;
  geminiKey?: string | null;
  openaiKey?: string | null;
  promptContext?: string | null;
}

/**
 * Counts today's understandings for this account. Cheap because the supporting index is
 * partial on media_understanding IS NOT NULL -- almost every row is text and is excluded.
 */
async function dailyCountReached(
  // deno-lint-ignore no-explicit-any
  admin: any,
  accountId: string,
  cap: number,
): Promise<boolean> {
  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  const { count, error } = await admin
    .from("whatsapp_messages")
    .select("id", { count: "exact", head: true })
    .eq("social_account_id", accountId)
    .not("media_understanding", "is", null)
    .gte("timestamp", since.toISOString());
  // Fail open on a counting error: refusing to understand because a COUNT failed would
  // degrade the customer experience for an internal fault. The per-message size and
  // timeout limits still bound the damage.
  if (error) return false;
  return (count ?? 0) >= cap;
}

/**
 * What the agent actually reads. The label matters: without it the model cannot tell a
 * transcript from something the customer typed, and a mis-transcription then reads as a
 * confident statement of fact.
 */
export function composeAgentText(kind: MediaKind, understood: string, caption?: string | null): string {
  const label = kind === "audio" ? "Voice note transcription" : "Image description & OCR";
  const head = `[${label}: "${understood}"]`;
  const tail = caption?.trim();
  return tail ? `${head}\n${tail}` : head;
}

/**
 * Never throws. Every failure path returns `understood: false` and the caller keeps the
 * placeholder, so a media message is never dropped because understanding failed (D7).
 */
export async function runInboundMediaUnderstanding(
  // deno-lint-ignore no-explicit-any
  admin: any,
  input: PipelineInput,
  deps: PipelineDeps = {},
): Promise<PipelineOutcome> {
  try {
    const mode = resolveMediaUnderstandingMode(input.account.account_metadata);
    if (mode === "off") return { understood: false, reason: "disabled" };

    const kind = classifyMime(input.mimeType);
    if (!kind) return { understood: false, reason: "unsupported_type" };
    if (!modeAllows(mode, kind)) return { understood: false, reason: "kind_not_enabled" };

    const cap = deps.dailyCap ?? DEFAULT_DAILY_CAP;
    if (await dailyCountReached(admin, input.account.id, cap)) {
      return { understood: false, reason: "daily_cap_reached" };
    }

    const limits = deps.limits ?? DEFAULT_LIMITS;
    const ref: MediaRef = {
      platform: input.platform ?? "whatsapp",
      connectionMode: input.account.connection_mode ?? null,
      mediaId: input.mediaId ?? null,
      mediaUrl: input.mediaUrl ?? null,
      rawBase64: input.rawBase64 ?? null,
      accessToken: input.account.access_token ?? null,
      mimeType: input.mimeType ?? null,
    };

    const fetchers = deps.fetchers ?? [new CloudGraphFetcher(), new DirectUrlFetcher()];
    const chosen = selectFetcher(ref, fetchers);
    if (!chosen) return { understood: false, reason: "no_fetcher" };

    let bytes: Uint8Array;
    let resolvedMime: string;
    try {
      const fetched = await chosen.fetchMediaBytes(
        ref,
        { maxBytes: limits.maxBytes, timeoutMs: limits.timeoutMs },
        deps.fetcher,
      );
      bytes = fetched.bytes;
      resolvedMime = fetched.mimeType;
    } catch (error) {
      const reason = error instanceof MediaFetchError ? error.reason : "download_failed";
      console.error(`[media-understanding] fetch failed (${chosen.name}/${reason}):`, (error as Error)?.message);
      return { understood: false, reason };
    }

    const outcome = await understandInboundMedia(
      bytes,
      kind,
      resolvedMime || input.mimeType || "application/octet-stream",
      {
        promptContext: deps.promptContext ?? undefined,
        limits,
        fetcher: deps.fetcher,
        geminiKey: deps.geminiKey ?? Deno.env.get("GOOGLE_AI_STUDIO_KEY") ?? null,
        openaiKey: deps.openaiKey ?? Deno.env.get("OPENAI_API_KEY") ?? null,
      },
    );

    if (!outcome.ok) {
      console.error(`[media-understanding] ${outcome.reason}: ${outcome.detail ?? ""}`);
      return { understood: false, reason: outcome.reason };
    }

    const { result } = outcome;
    const agentText = composeAgentText(kind, result.text, input.caption);

    if (input.messageRowId) {
      // A persistence failure must not discard a transcript we already paid for, so the
      // agent still gets the text -- only the audit record is lost, and it is logged.
      const { error } = await admin
        .from("whatsapp_messages")
        .update({
          media_understanding: result.text,
          media_understanding_meta: {
            provider: result.provider,
            model: result.model,
            kind: result.kind,
            duration_seconds: result.duration_seconds ?? null,
            confidence: result.confidence ?? null,
            extracted_data: result.extracted_data ?? null,
            bytes: bytes.byteLength,
            attempted_at: new Date().toISOString(),
          },
        })
        .eq("id", input.messageRowId);
      if (error) {
        console.error("[media-understanding] persist failed:", error.message);
      }
    }

    return { understood: true, text: result.text, agentText };
  } catch (error) {
    console.error("[media-understanding] unexpected:", (error as Error)?.message ?? error);
    return { understood: false, reason: "unexpected" };
  }
}
