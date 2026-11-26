import { z } from "npm:zod@3.23.8";
import { readJsonBodyCapped } from "../_shared/cappedJsonBody.ts";
import type { YouTubeRefreshOutcome, YouTubeStoredAccount } from "../_shared/youtubeTokenRefresh.ts";
import { restrictedCorsHeaders } from "../_shared/cors.ts";
import type {
  YouTubeAnalyticsReadClient,
  YouTubeAnalyticsReadResult,
} from "./analyticsReadClient.ts";
import {
  ANALYTICS_PURPOSE_VERSION,
  YOUTUBE_ANALYTICS_DATE_PATTERN,
  YOUTUBE_ANALYTICS_ERRORS,
  YOUTUBE_ANALYTICS_LIMITS,
  YOUTUBE_ANALYTICS_PERIOD_DAYS,
  YOUTUBE_ANALYTICS_REQUIRED_SCOPES,
  YOUTUBE_ANALYTICS_REVISION_PATTERN,
  YOUTUBE_ANALYTICS_SCHEMA_VERSION,
  YOUTUBE_ANALYTICS_TOP_VIDEOS_MAX_RESULTS,
  YOUTUBE_ANALYTICS_TOP_VIDEOS_MAX_START_INDEX,
  YOUTUBE_ANALYTICS_TOP_VIDEOS_PAGE_SIZE,
  YOUTUBE_ANALYTICS_VIDEO_ID_PATTERN,
  type YouTubeAnalyticsConsentData,
  type YouTubeAnalyticsDataOperation,
  type YouTubeAnalyticsErrorCode,
  type YouTubeAnalyticsErrorResponse,
  type YouTubeAnalyticsMetric,
  type YouTubeAnalyticsOperation,
  type YouTubeAnalyticsStatusData,
  type YouTubeAnalyticsSuccess,
} from "./contracts.ts";
import type {
  YouTubeAnalyticsBinding,
  YouTubeAnalyticsDecision,
  YouTubeAnalyticsDecisionDenial,
  YouTubeAnalyticsDecisionInput,
} from "./decision.ts";
import type { YouTubeAnalyticsLimitResult } from "./limits.ts";
import type { YouTubeAnalyticsConsentResult } from "./consent.ts";
import type { YouTubeAnalyticsAudit } from "./audit.ts";
import { sanitiseYouTubeAnalyticsOperation } from "./audit.ts";
import { acceptedWindowEndDates, isIsoCalendarDate, reportingEndDate, resolveRequestedWindow } from "./window.ts";

const AccountId = z.string().uuid();
const PeriodDays = z.union([
  z.literal(7),
  z.literal(14),
  z.literal(30),
  z.literal(90),
]);
const WindowEnd = z.string().regex(YOUTUBE_ANALYTICS_DATE_PATTERN).refine(isIsoCalendarDate);
const VideoId = z.string().regex(YOUTUBE_ANALYTICS_VIDEO_ID_PATTERN);
const StatusRequest = z.object({ operation: z.literal("status"), account_id: AccountId }).strict();
const ConsentAcceptRequest = z.object({
  operation: z.literal("consent_accept"),
  account_id: AccountId,
  purpose_version: z.number().int().positive(),
  locale: z.enum(["en", "ar"]),
  connection_revision: z.string().regex(YOUTUBE_ANALYTICS_REVISION_PATTERN),
}).strict();
const ConsentWithdrawRequest = z.object({
  operation: z.literal("consent_withdraw"),
  account_id: AccountId,
  locale: z.enum(["en", "ar"]).optional(),
}).strict();
const SummaryRequest = z.object({
  operation: z.literal("summary"),
  account_id: AccountId,
  period_days: PeriodDays,
  window_end: WindowEnd,
  video_id: VideoId.optional(),
}).strict();
const DailyRequest = z.object({
  operation: z.literal("daily"),
  account_id: AccountId,
  period_days: PeriodDays,
  window_end: WindowEnd,
  video_id: VideoId.optional(),
}).strict();
const TopVideosRequest = z.object({
  operation: z.literal("top_videos"),
  account_id: AccountId,
  period_days: PeriodDays,
  window_end: WindowEnd,
  start_index: z.number().int().min(1).max(YOUTUBE_ANALYTICS_TOP_VIDEOS_MAX_START_INDEX).optional(),
}).strict();
const RequestSchema = z.discriminatedUnion("operation", [
  StatusRequest,
  ConsentAcceptRequest,
  ConsentWithdrawRequest,
  SummaryRequest,
  DailyRequest,
  TopVideosRequest,
]);

const USER_ID_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_REQUEST_BODY_BYTES = 16 * 1024;
const REQUEST_BODY_READ_TIMEOUT_MS = 2_000;

export interface YouTubeAnalyticsTokenPort {
  readonly lastDenial: YouTubeAnalyticsDecisionDenial | null;
  get(snapshot: Partial<YouTubeStoredAccount>, force: boolean): Promise<YouTubeRefreshOutcome>;
}

export interface YouTubeAnalyticsPorts {
  auth: { authenticate(req: Request): Promise<{ userId: string }> };
  clock: { now(): Date };
  ids: { requestId(): string };
  decide(input: YouTubeAnalyticsDecisionInput): Promise<YouTubeAnalyticsDecision>;
  limits: {
    admission(userId: string): Promise<YouTubeAnalyticsLimitResult>;
    data(userId: string): Promise<YouTubeAnalyticsLimitResult>;
    debit(kind: "data" | "analytics", now: Date): Promise<YouTubeAnalyticsLimitResult>;
  };
  tokens: { bind(binding: YouTubeAnalyticsBinding): YouTubeAnalyticsTokenPort };
  reader: YouTubeAnalyticsReadClient;
  consent: {
    record(input: {
      ownerId: string;
      accountId: string;
      event: "accepted" | "withdrawn";
      purposeVersion?: number;
      locale?: "en" | "ar";
      requestId: string;
      expectedRevision?: string;
    }): Promise<YouTubeAnalyticsConsentResult>;
  };
  audit: YouTubeAnalyticsAudit;
}

type AttemptResult<T> =
  | { ok: true; value: T; cause: "provider" }
  | {
    ok: false;
    code: YouTubeAnalyticsErrorCode;
    cause: "provider" | "decision" | "budget" | "token";
    retryAfterSeconds?: number;
  };

function headers(req: Request): Record<string, string> {
  return {
    ...restrictedCorsHeaders(req),
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  };
}

function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: headers(req) });
}

function videoLink(videoId: string): string {
  const url = new URL("https://www.youtube.com/watch");
  url.searchParams.set("v", videoId);
  return url.toString();
}

function tokenFailure(outcome: Extract<YouTubeRefreshOutcome, { ok: false }>): YouTubeAnalyticsErrorCode {
  return outcome.status === "needs_reauth" || outcome.reason === "invalid_grant" ||
      outcome.reason === "needs_reauth" || outcome.reason === "no_refresh_token"
    ? "reconnect_required"
    : "upstream_unavailable";
}

function scheduleBackground(task: Promise<unknown>): void {
  const edgeRuntime = (globalThis as { EdgeRuntime?: { waitUntil?: (promise: Promise<unknown>) => void } })
    .EdgeRuntime;
  if (typeof edgeRuntime?.waitUntil === "function") {
    edgeRuntime.waitUntil(task);
    return;
  }
  queueMicrotask(() => {
    void task;
  });
}

export function createYouTubeAnalyticsHandler(
  ports: YouTubeAnalyticsPorts,
): (req: Request) => Promise<Response> {
  async function refuse(
    req: Request,
    input: {
      operation: YouTubeAnalyticsOperation | "unknown";
      code: YouTubeAnalyticsErrorCode;
      requestId: string;
      userId: string | null;
      accountId?: string;
      auditKind?: "admission" | "standard";
      retryAfterSeconds?: number;
      detail?: "grant_not_effective";
      extra?: Record<string, unknown>;
    },
  ): Promise<Response> {
    if (input.userId !== null && input.code !== "unauthorized" && input.code !== "method_not_allowed") {
      await ports.audit.refusal({
        operation: input.operation,
        code: input.code,
        requestId: input.requestId,
        userId: input.userId,
        ...(input.accountId ? { accountId: input.accountId } : {}),
      }, input.auditKind ?? "standard");
    }
    const body: YouTubeAnalyticsErrorResponse = {
      error: input.code,
      request_id: input.requestId,
      ...(input.retryAfterSeconds !== undefined
        ? { retry_after_seconds: input.retryAfterSeconds }
        : {}),
      ...(input.detail ? { detail: input.detail } : {}),
      ...(input.extra ?? {}),
    };
    return json(req, body, YOUTUBE_ANALYTICS_ERRORS[input.code].status);
  }

  function success<T>(
    req: Request,
    input: {
      requestId: string;
      connectionRevision: string;
      source: "database" | "provider";
      data: T;
      requestedWindow?: YouTubeAnalyticsSuccess<T>["requested_window"];
    },
  ): Response {
    const envelope: YouTubeAnalyticsSuccess<T> = {
      schema_version: YOUTUBE_ANALYTICS_SCHEMA_VERSION,
      request_id: input.requestId,
      connection_revision: input.connectionRevision,
      freshness: { fetched_at: ports.clock.now().toISOString(), source: input.source },
      ...(input.requestedWindow ? { requested_window: input.requestedWindow } : {}),
      data: input.data,
    };
    return json(req, envelope);
  }

  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...restrictedCorsHeaders(req), "Cache-Control": "no-store" },
      });
    }
    const requestId = ports.ids.requestId();
    if (req.method !== "POST") {
      return await refuse(req, {
        operation: "unknown",
        code: "method_not_allowed",
        requestId,
        userId: null,
      });
    }

    let userId: string;
    try {
      userId = (await ports.auth.authenticate(req)).userId;
    } catch {
      return await refuse(req, {
        operation: "unknown",
        code: "unauthorized",
        requestId,
        userId: null,
      });
    }
    if (!USER_ID_UUID_RE.test(userId)) {
      return await refuse(req, {
        operation: "unknown",
        code: "unauthorized",
        requestId,
        userId: null,
      });
    }

    const bodyResult = await readJsonBodyCapped(
      req,
      MAX_REQUEST_BODY_BYTES,
      AbortSignal.timeout(REQUEST_BODY_READ_TIMEOUT_MS),
    ).catch(() => ({ ok: false as const, reason: "invalid_json" as const }));
    const body = bodyResult.ok ? bodyResult.value : undefined;
    const bodyParsed = bodyResult.ok;
    const requestedOperation = sanitiseYouTubeAnalyticsOperation(body);
    const admission = await ports.limits.admission(userId);
    if (!admission.ok) {
      return await refuse(req, {
        operation: requestedOperation,
        code: admission.code,
        requestId,
        userId,
        auditKind: "admission",
        retryAfterSeconds: admission.retryAfterSeconds,
      });
    }
    const parsed = RequestSchema.safeParse(body);
    if (!bodyParsed || !parsed.success) {
      return await refuse(req, { operation: requestedOperation, code: "invalid_request", requestId, userId });
    }

    let admittedAccountId: string | undefined;
    try {
      if (parsed.data.operation === "consent_accept" || parsed.data.operation === "consent_withdraw") {
        const input = parsed.data;
        const result = await ports.consent.record({
          ownerId: userId,
          accountId: input.account_id,
          event: input.operation === "consent_accept" ? "accepted" : "withdrawn",
          purposeVersion: input.operation === "consent_accept"
            ? input.purpose_version
            : ANALYTICS_PURPOSE_VERSION,
          locale: input.locale ?? "en",
          requestId,
          expectedRevision: input.operation === "consent_accept" ? input.connection_revision : undefined,
        });
        if (!result.ok) {
          const accountVerified = result.code !== "not_found" && result.code !== "invalid_request" &&
            result.code !== "settings_unavailable" && result.code !== "consent_version_stale";
          return await refuse(req, {
            operation: input.operation,
            code: result.code,
            requestId,
            userId,
            ...(accountVerified ? { accountId: input.account_id } : {}),
          });
        }
        const data: YouTubeAnalyticsConsentData = {
          recorded: result.recorded,
          consent: result.consent,
          purpose_version: ANALYTICS_PURPOSE_VERSION,
        };
        const response = success(req, {
          requestId,
          connectionRevision: result.connectionRevision,
          source: "database",
          data,
        });
        await ports.audit.success({
          operation: input.operation,
          code: "ok",
          requestId,
          userId,
          accountId: input.account_id,
        });
        return response;
      }

      if (parsed.data.operation === "status") {
        const now = ports.clock.now();
        const decision = await ports.decide({
          ownerId: userId,
          accountId: parsed.data.account_id,
          withCredentials: false,
        });
        const statusExtra = {
          reporting_end_date: reportingEndDate(now),
          accepted_window_ends: acceptedWindowEndDates(now),
          purpose_version: ANALYTICS_PURPOSE_VERSION,
        };
        if (!decision.ok) {
          return await refuse(req, {
            operation: "status",
            code: decision.code,
            requestId,
            userId,
            ...(decision.binding ? { accountId: parsed.data.account_id } : {}),
            extra: {
              ...statusExtra,
              ...(decision.binding ? { connection_revision: decision.binding.connectionRevision } : {}),
              ...(decision.consent ?? decision.binding?.consent
                ? { consent: decision.consent ?? decision.binding?.consent }
                : {}),
            },
          });
        }
        const data: YouTubeAnalyticsStatusData = {
          available: true,
          reason: "ok",
          connection_revision: decision.binding.connectionRevision,
          ...statusExtra,
          consent: decision.binding.consent,
          periods: YOUTUBE_ANALYTICS_PERIOD_DAYS,
          limits: YOUTUBE_ANALYTICS_LIMITS,
        };
        return success(req, {
          requestId,
          connectionRevision: decision.binding.connectionRevision,
          source: "database",
          data,
        });
      }

      const input = parsed.data;
      const operation = input.operation;
      const admissionDecision = await ports.decide({
        ownerId: userId,
        accountId: input.account_id,
        withCredentials: false,
      });
      if (!admissionDecision.ok) {
        return await refuse(req, {
          operation,
          code: admissionDecision.code,
          requestId,
          userId,
          ...(admissionDecision.binding ? { accountId: input.account_id } : {}),
        });
      }
      const binding = admissionDecision.binding;
      admittedAccountId = input.account_id;
      const resolved = resolveRequestedWindow({
        windowEnd: input.window_end,
        periodDays: input.period_days,
        now: ports.clock.now(),
      });
      if (!resolved.ok) {
        return await refuse(req, { operation, code: resolved.code, requestId, userId, accountId: input.account_id });
      }
      const dataLimit = await ports.limits.data(userId);
      if (!dataLimit.ok) {
        return await refuse(req, {
          operation,
          code: dataLimit.code,
          requestId,
          userId,
          accountId: input.account_id,
          retryAfterSeconds: dataLimit.retryAfterSeconds,
        });
      }
      const credentialDecision = await ports.decide({
        ownerId: userId,
        accountId: input.account_id,
        expected: binding,
        withCredentials: true,
      });
      if (!credentialDecision.ok) {
        return await refuse(req, {
          operation,
          code: credentialDecision.code,
          requestId,
          userId,
          ...(credentialDecision.binding ? { accountId: input.account_id } : {}),
        });
      }
      const credentials = credentialDecision.credentials!;
      const snapshot: Partial<YouTubeStoredAccount> = {
        id: input.account_id,
        access_token: credentials.accessToken,
        refresh_token: credentials.refreshToken,
        token_expires_at: credentials.tokenExpiresAt,
        needs_reauth: credentialDecision.binding.needsReauth,
        is_active: true,
        auth_provider: "native",
      };
      const tokenPort = ports.tokens.bind(binding);
      let token = await tokenPort.get(snapshot, false);
      if (tokenPort.lastDenial) {
        return await refuse(req, {
          operation,
          code: tokenPort.lastDenial.code,
          requestId,
          userId,
          accountId: input.account_id,
        });
      }
      if (!token.ok) {
        return await refuse(req, {
          operation,
          code: tokenFailure(token),
          requestId,
          userId,
          accountId: input.account_id,
        });
      }
      let currentAccessToken = token.accessToken;
      let tokenWasRefreshedInRequest = token.status === "refreshed";
      let forcedRefreshUsed = false;

      const runAttempt = async <T>(
        kind: "data" | "analytics",
        send: (accessToken: string) => Promise<YouTubeAnalyticsReadResult<T>>,
      ): Promise<AttemptResult<T>> => {
        const debit = await ports.limits.debit(kind, ports.clock.now());
        if (!debit.ok) {
          return {
            ok: false,
            code: debit.code,
            cause: "budget",
            retryAfterSeconds: debit.retryAfterSeconds,
          };
        }
        const decision = await ports.decide({
          ownerId: userId,
          accountId: input.account_id,
          expected: binding,
          withCredentials: false,
        });
        if (!decision.ok) {
          return { ok: false, code: decision.code, cause: "decision" };
        }
        const result = await send(currentAccessToken);
        return result.ok
          ? { ok: true, value: result.value, cause: "provider" }
          : { ok: false, code: result.code, cause: "provider" };
      };

      const runAttemptWithRefresh = async <T>(
        kind: "data" | "analytics",
        send: (accessToken: string) => Promise<YouTubeAnalyticsReadResult<T>>,
      ): Promise<AttemptResult<T>> => {
        const first = await runAttempt(kind, send);
        if (first.ok || first.code !== "unauthorized") return first;
        if (tokenWasRefreshedInRequest || forcedRefreshUsed) {
          return { ok: false, code: "reconnect_required", cause: "provider" };
        }
        forcedRefreshUsed = true;
        token = await tokenPort.get({ ...snapshot, access_token: currentAccessToken }, true);
        if (tokenPort.lastDenial) {
          return { ok: false, code: tokenPort.lastDenial.code, cause: "decision" };
        }
        if (!token.ok) return { ok: false, code: tokenFailure(token), cause: "token" };
        currentAccessToken = token.accessToken;
        tokenWasRefreshedInRequest = true;
        const repeated = await runAttempt(kind, send);
        if (!repeated.ok && repeated.code === "unauthorized") {
          return { ok: false, code: "reconnect_required", cause: "provider" };
        }
        return repeated;
      };

      const refuseAttempt = async (result: Extract<AttemptResult<unknown>, { ok: false }>): Promise<Response> => {
        const grantNotEffective = result.cause === "provider" && result.code === "missing_scope" &&
          YOUTUBE_ANALYTICS_REQUIRED_SCOPES.every((scope) => binding.grantedScopes.includes(scope));
        return await refuse(req, {
          operation,
          code: result.code,
          requestId,
          userId,
          accountId: input.account_id,
          retryAfterSeconds: result.retryAfterSeconds,
          ...(grantNotEffective ? { detail: "grant_not_effective" } : {}),
        });
      };

      if ((input.operation === "summary" || input.operation === "daily") && input.video_id !== undefined) {
        const ownership = await runAttemptWithRefresh(
          "data",
          (accessToken) => ports.reader.lookupVideoOwnership(accessToken, {
            channelId: binding.channelId,
            videoId: input.video_id!,
          }),
        );
        if (!ownership.ok) return await refuseAttempt(ownership);
      }

      let reportData: unknown;
      let topVideoRows: Array<{ videoId: string; metrics: YouTubeAnalyticsMetric[] }> = [];
      if (input.operation === "summary") {
        const report = await runAttemptWithRefresh(
          "analytics",
          (accessToken) => ports.reader.readSummary(accessToken, {
            channelId: binding.channelId,
            window: resolved.window,
            days: resolved.days,
            ...(input.video_id ? { videoId: input.video_id } : {}),
          }),
        );
        if (!report.ok) return await refuseAttempt(report);
        reportData = report.value;
      } else if (input.operation === "daily") {
        const report = await runAttemptWithRefresh(
          "analytics",
          (accessToken) => ports.reader.readDaily(accessToken, {
            channelId: binding.channelId,
            window: resolved.window,
            days: resolved.days,
            ...(input.video_id ? { videoId: input.video_id } : {}),
          }),
        );
        if (!report.ok) return await refuseAttempt(report);
        reportData = report.value;
      } else {
        const report = await runAttemptWithRefresh(
          "analytics",
          (accessToken) => ports.reader.readTopVideos(accessToken, {
            channelId: binding.channelId,
            window: resolved.window,
            days: resolved.days,
            startIndex: input.start_index ?? 1,
          }),
        );
        if (!report.ok) return await refuseAttempt(report);
        topVideoRows = report.value.rows;
        const startIndex = input.start_index ?? 1;
        let titles: Record<string, string> = {};
        let details: Record<string, { published_at: string | null; thumbnail_url: string | null }> = {};
        let titleState: "complete" | "partial" | "unavailable" = "unavailable";
        if (topVideoRows.length > 0) {
          const titleResult = await runAttempt(
            "data",
            (accessToken) => ports.reader.lookupVideoTitles(accessToken, {
              channelId: binding.channelId,
              videoIds: topVideoRows.map((row) => row.videoId),
            }),
          );
          if (titleResult.ok) {
            titles = titleResult.value.titles;
            details = titleResult.value.details;
            const matchedCount = topVideoRows.filter((row) => typeof titles[row.videoId] === "string").length;
            titleState = matchedCount === topVideoRows.length
              ? "complete"
              : matchedCount > 0
              ? "partial"
              : "unavailable";
          }
        }
        const hasMore = topVideoRows.length === YOUTUBE_ANALYTICS_TOP_VIDEOS_PAGE_SIZE &&
          startIndex + YOUTUBE_ANALYTICS_TOP_VIDEOS_PAGE_SIZE <= YOUTUBE_ANALYTICS_TOP_VIDEOS_MAX_RESULTS;
        reportData = {
          rows: topVideoRows.map((row) => ({
            video_id: row.videoId,
            title: titles[row.videoId] ?? null,
            published_at: details[row.videoId]?.published_at ?? null,
            thumbnail_url: details[row.videoId]?.thumbnail_url ?? null,
            link: videoLink(row.videoId),
            metrics: row.metrics,
          })),
          titles: titleState,
          has_more: hasMore,
          next_start_index: hasMore ? startIndex + YOUTUBE_ANALYTICS_TOP_VIDEOS_PAGE_SIZE : null,
        };
      }

      const finalDecision = await ports.decide({
        ownerId: userId,
        accountId: input.account_id,
        expected: binding,
        withCredentials: false,
      });
      if (!finalDecision.ok) {
        return await refuse(req, {
          operation,
          code: finalDecision.code,
          requestId,
          userId,
          ...(finalDecision.binding ? { accountId: input.account_id } : {}),
        });
      }
      const response = success(req, {
        requestId,
        connectionRevision: binding.connectionRevision,
        source: "provider",
        data: reportData,
        requestedWindow: resolved.window,
      });
      scheduleBackground(
        ports.audit.success({
          operation: operation as YouTubeAnalyticsDataOperation,
          code: "ok",
          requestId,
          userId,
          accountId: input.account_id,
        }).catch(() => {}),
      );
      return response;
    } catch {
      return await refuse(req, {
        operation: parsed.data.operation,
        code: "internal_error",
        requestId,
        userId,
        ...(admittedAccountId ? { accountId: admittedAccountId } : {}),
      });
    }
  };
}
