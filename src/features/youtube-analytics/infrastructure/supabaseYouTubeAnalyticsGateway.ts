import { supabase } from "@/integrations/supabase/client";
import type { YouTubeAnalyticsGateway, YouTubeAnalyticsDataParams } from "../application/ports";
import { YouTubeAnalyticsClientError, isYouTubeAnalyticsErrorCode } from "../domain/errors";
import type {
  YouTubeAnalyticsConsentData,
  YouTubeAnalyticsDailyData,
  YouTubeAnalyticsErrorResponse,
  YouTubeAnalyticsRequest,
  YouTubeAnalyticsStatusData,
  YouTubeAnalyticsSuccess,
  YouTubeAnalyticsSummaryData,
  YouTubeAnalyticsTopVideosData,
} from "../domain/types";

const GATEWAY_TIMEOUT_MS = 20_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSuccess<T>(payload: unknown): payload is YouTubeAnalyticsSuccess<T> {
  return isRecord(payload)
    && payload.schema_version === 1
    && typeof payload.request_id === "string"
    && typeof payload.connection_revision === "string"
    && isRecord(payload.freshness)
    && typeof payload.freshness.fetched_at === "string"
    && isRecord(payload.data);
}

async function call<T>(body: YouTubeAnalyticsRequest, signal?: AbortSignal): Promise<YouTubeAnalyticsSuccess<T>> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, GATEWAY_TIMEOUT_MS);

  try {
    const { data: sessionData } = await supabase.auth.getSession();
    const accessToken = sessionData.session?.access_token;
    if (!accessToken) throw new YouTubeAnalyticsClientError("unauthorized");
    const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/youtube-analytics`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      if (isRecord(payload) && isYouTubeAnalyticsErrorCode(payload.error)) {
        throw YouTubeAnalyticsClientError.fromResponse(payload as unknown as YouTubeAnalyticsErrorResponse);
      }
      throw new YouTubeAnalyticsClientError(response.status === 401 ? "unauthorized" : "upstream_unavailable");
    }
    if (isRecord(payload) && isYouTubeAnalyticsErrorCode(payload.error)) {
      throw YouTubeAnalyticsClientError.fromResponse(payload as unknown as YouTubeAnalyticsErrorResponse);
    }
    if (!isSuccess<T>(payload)) throw new YouTubeAnalyticsClientError("upstream_unavailable");
    return payload;
  } catch (error) {
    if (error instanceof YouTubeAnalyticsClientError) throw error;
    throw new YouTubeAnalyticsClientError("upstream_unavailable");
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

function dataBody(params: YouTubeAnalyticsDataParams) {
  return {
    account_id: params.accountId,
    period_days: params.periodDays,
    window_end: params.windowEnd,
    ...(params.videoId ? { video_id: params.videoId } : {}),
  };
}

export class SupabaseYouTubeAnalyticsGateway implements YouTubeAnalyticsGateway {
  status(accountId: string, signal?: AbortSignal) {
    return call<YouTubeAnalyticsStatusData>({ operation: "status", account_id: accountId }, signal);
  }

  acceptConsent(params: {
    accountId: string;
    purposeVersion: number;
    locale: "en" | "ar";
    connectionRevision: string;
    signal?: AbortSignal;
  }) {
    return call<YouTubeAnalyticsConsentData>({
      operation: "consent_accept",
      account_id: params.accountId,
      purpose_version: params.purposeVersion,
      locale: params.locale,
      connection_revision: params.connectionRevision,
    }, params.signal);
  }

  withdrawConsent(params: { accountId: string; locale: "en" | "ar"; signal?: AbortSignal }) {
    return call<YouTubeAnalyticsConsentData>({
      operation: "consent_withdraw",
      account_id: params.accountId,
      locale: params.locale,
    }, params.signal);
  }

  summary(params: YouTubeAnalyticsDataParams) {
    return call<YouTubeAnalyticsSummaryData>({ operation: "summary", ...dataBody(params) }, params.signal);
  }

  daily(params: YouTubeAnalyticsDataParams) {
    return call<YouTubeAnalyticsDailyData>({ operation: "daily", ...dataBody(params) }, params.signal);
  }

  topVideos(params: YouTubeAnalyticsDataParams) {
    return call<YouTubeAnalyticsTopVideosData>({ operation: "top_videos", ...dataBody(params) }, params.signal);
  }
}

export const defaultYouTubeAnalyticsGateway = new SupabaseYouTubeAnalyticsGateway();
