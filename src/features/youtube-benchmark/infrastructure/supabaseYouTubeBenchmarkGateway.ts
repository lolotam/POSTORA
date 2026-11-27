import { supabase } from "@/integrations/supabase/client";
import { toYouTubeBenchmarkError, YouTubeBenchmarkError } from "../domain/errors";
import type { YouTubeBenchmarkSuccess } from "../domain/types";
import type { YouTubeBenchmarkGateway } from "../application/ports";

// A stalled edge call must not hang the screen: abort after 25 seconds (above
// the server's worst-case multi-channel lookup budget).
export const YOUTUBE_BENCHMARK_TIMEOUT_MS = 25000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The envelope the benchmark function answers with.
 *
 * Every field the screen reads is checked before the payload is handed over:
 * a malformed answer must never reach a component as if it were data.
 */
function isBenchmarkEnvelope(
  payload: unknown,
  accountId: string,
): payload is YouTubeBenchmarkSuccess {
  if (!isRecord(payload)) return false;
  if (payload.schema_version !== 1) return false;
  if (typeof payload.request_id !== "string") return false;
  if (!isRecord(payload.freshness) || typeof payload.freshness.fetched_at !== "string") return false;
  if (!isRecord(payload.data)) return false;
  if (payload.data.account_id !== accountId) return false;
  return Array.isArray(payload.data.channels);
}

/**
 * The Supabase adapter of the benchmark read.
 *
 * The body carries the creator's OWN connected channel id — the server loads
 * it by id and owner and uses it only for the credential — and the handles or
 * channel ids the creator typed. Nothing else is sent, and a failure always
 * becomes a typed error the screen can explain.
 */
export class SupabaseYouTubeBenchmarkGateway implements YouTubeBenchmarkGateway {
  async lookupChannels(params: {
    accountId: string;
    channels: string[];
  }): Promise<YouTubeBenchmarkSuccess> {
    let data: unknown = null;
    let error: unknown = null;
    try {
      const result = await supabase.functions.invoke("youtube-channel-benchmark", {
        body: { account_id: params.accountId, channels: params.channels },
        timeout: YOUTUBE_BENCHMARK_TIMEOUT_MS,
      });
      data = result.data ?? null;
      error = result.error ?? null;
    } catch (thrown) {
      // A network failure or the timeout above rejects; both are upstream
      // failures for a read.
      error = thrown;
    }

    if (error) {
      const context = (error as { context?: unknown }).context;
      const payload: unknown =
        context instanceof Response ? await context.clone().json().catch(() => null) : null;
      throw toYouTubeBenchmarkError(payload);
    }

    if (!isBenchmarkEnvelope(data, params.accountId)) {
      throw new YouTubeBenchmarkError("upstream_unavailable");
    }

    return data;
  }
}

export const defaultYouTubeBenchmarkGateway = new SupabaseYouTubeBenchmarkGateway();
