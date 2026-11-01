/**
 * HTTP Handler for Instagram Insights Report (Slice O3).
 *
 * Implements authenticated endpoint `/functions/v1/instagram-insights-report`:
 * - Supports CORS preflight (OPTIONS)
 * - Authenticates caller (JWT or service-role proxy)
 * - Validates input parameters (social_account_id, period_days, limit, cursor)
 * - Fetches historical metrics and invokes assembleOwnerReport
 * - Returns frozen OwnerReport v1 DTO
 * - Guarantees non-enumerable 404 for missing or cross-owner accounts
 * - Redacts all secrets and never leaks SQL error traces
 */

import { corsHeaders, handleCorsOptions, jsonResponse } from "../_shared/cors.ts";
import { ReportHistoryUnavailableError } from "./readHistory.ts";
import { awaitWithAbort } from "../_shared/abort.ts";
import { readJsonBodyCapped } from "../_shared/cappedJsonBody.ts";
import {
  type OwnerReportCursor,
  type OwnerReportPeriodDays,
  OWNER_REPORT_PERIOD_DAYS,
  OWNER_REPORT_DEFAULT_LIMIT,
  OWNER_REPORT_MAX_LIMIT,
  OwnerReportContractError,
  decodeOwnerReportCursor,
} from "./contracts.ts";
import { ReportStore } from "./reportStore.ts";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ReportHandlerDeps {
  authenticate: (req: Request) => Promise<{ userId: string; isServiceRole: boolean }>;
  store: ReportStore;
  nowFn?: () => Date;
}

export function parseCursor(raw: unknown): OwnerReportCursor | null {
  return decodeOwnerReportCursor(raw);
}

export function createInstagramInsightsReportHandler(deps: ReportHandlerDeps) {
  return async (req: Request): Promise<Response> => {
    // 1. CORS Preflight
    if (req.method === "OPTIONS") {
      return handleCorsOptions();
    }
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(20_000)]);

    // 2. HTTP Method Check
    if (req.method !== "GET" && req.method !== "POST") {
      return new Response(
        JSON.stringify({
          error: { code: "METHOD_NOT_ALLOWED", message: "Method not allowed. Use GET or POST." },
        }),
        {
          status: 405,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json",
            Allow: "GET, POST, OPTIONS",
          },
        }
      );
    }

    // 3. Authenticate Caller
    let auth: { userId: string; isServiceRole: boolean };
    try {
      auth = await awaitWithAbort(() => deps.authenticate(req), signal);
    } catch {
      if (signal.aborted) return jsonResponse({ error: { code: "HISTORY_UNAVAILABLE", message: "Report request exceeded its deadline." } }, 503);
      return jsonResponse(
        { error: { code: "UNAUTHORIZED", message: "Missing or invalid authorization" } },
        401
      );
    }

    if (!auth.isServiceRole && (!auth.userId || !UUID_RE.test(auth.userId))) {
      return jsonResponse(
        { error: { code: "UNAUTHORIZED", message: "Missing or invalid authorization" } },
        401
      );
    }

    // 4. Extract parameters from searchParams or JSON body
    let rawAccountId: unknown;
    let rawPeriod: unknown;
    let rawLimit: unknown;
    let rawCursor: unknown;
    let rawContractVersion: unknown;
    let targetUserId = auth.userId.toLowerCase();

    if (req.method === "GET") {
      const url = new URL(req.url);
      rawAccountId = url.searchParams.get("social_account_id");
      rawPeriod = url.searchParams.get("period_days");
      rawLimit = url.searchParams.get("limit");
      rawCursor = url.searchParams.get("cursor");
      rawContractVersion = url.searchParams.has("analyticsContractVersion") ? Number(url.searchParams.get("analyticsContractVersion")) : undefined;
    } else {
      let body: Record<string, unknown>;
      try {
        const parsed = await readJsonBodyCapped(req, 8192, signal);
        if (!parsed.ok) throw new Error("Invalid report request");
        body = parsed.value as Record<string, unknown>;
      } catch {
        if (signal.aborted) return jsonResponse({ error: { code: "HISTORY_UNAVAILABLE", message: "Report request exceeded its deadline." } }, 503);
        return jsonResponse(
          { error: { code: "INVALID_REQUEST", message: "Request body must be valid JSON" } },
          400
        );
      }
      if (!body || typeof body !== "object") {
        return jsonResponse(
          { error: { code: "INVALID_REQUEST", message: "Request body must be an object" } },
          400
        );
      }
      rawAccountId = body.social_account_id;
      rawPeriod = body.period_days;
      rawLimit = body.limit;
      rawCursor = body.cursor;
      rawContractVersion = body.analyticsContractVersion;

      // When called via service role (e.g. from serviceProxy / n8n-api), require acting for specified user_id
      if (auth.isServiceRole) {
        if (typeof body.user_id === "string" && UUID_RE.test(body.user_id)) {
          targetUserId = body.user_id.toLowerCase();
        } else {
          return jsonResponse(
            { error: { code: "INVALID_REQUEST", message: "Service-role call requires valid user_id in request body" } },
            400
          );
        }
      }
    }

    // 5. Validate social_account_id
    if (!rawAccountId || typeof rawAccountId !== "string" || !UUID_RE.test(rawAccountId)) {
      return jsonResponse(
        { error: { code: "INVALID_REQUEST", message: "social_account_id must be a valid UUID" } },
        400
      );
    }
    const socialAccountId = rawAccountId.toLowerCase();

    if (rawContractVersion !== undefined) {
      if (rawContractVersion !== 1) return jsonResponse({ ok: false, reason: "unsupported_contract_version", message: "Unsupported analytics contract version." }, 400);
      try {
        const account = await awaitWithAbort(() => deps.store.loadAccount(socialAccountId, targetUserId), signal);
        if (!account) return jsonResponse({ ok: false, reason: "account_not_found", message: "Instagram account not found." }, 404);
        // No Instagram calendar/metric cell has accepted capability evidence yet.
        // Do not relabel the legacy DTO or invent a canonical provider timezone.
        return jsonResponse({ ok: false, reason: "window_mismatch", message: "Instagram reporting periods have not been verified for this connection yet." }, 409);
      } catch {
        return jsonResponse({ ok: false, reason: "storage_unavailable", message: "Saved analytics could not be read. Please retry." }, 503);
      }
    }

    // 6. Validate period_days
    let periodDays: OwnerReportPeriodDays = 30;
    if (rawPeriod !== undefined && rawPeriod !== null && rawPeriod !== "") {
      const parsedPeriod = Number(rawPeriod);
      if (
        !Number.isInteger(parsedPeriod) ||
        !OWNER_REPORT_PERIOD_DAYS.includes(parsedPeriod as OwnerReportPeriodDays)
      ) {
        return jsonResponse(
          {
            error: {
              code: "INVALID_PERIOD",
              message: `period_days must be one of: ${OWNER_REPORT_PERIOD_DAYS.join(", ")}`,
            },
          },
          400
        );
      }
      periodDays = parsedPeriod as OwnerReportPeriodDays;
    }

    // 7. Validate limit
    let limit = OWNER_REPORT_DEFAULT_LIMIT;
    if (rawLimit !== undefined && rawLimit !== null && rawLimit !== "") {
      const parsedLimit = Number(rawLimit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > OWNER_REPORT_MAX_LIMIT) {
        return jsonResponse(
          {
            error: {
              code: "INVALID_LIMIT",
              message: `limit must be an integer between 1 and ${OWNER_REPORT_MAX_LIMIT}`,
            },
          },
          400
        );
      }
      limit = parsedLimit;
    }

    // 8. Validate cursor
    let cursor: OwnerReportCursor | null = null;
    try {
      cursor = parseCursor(rawCursor);
    } catch (err) {
      if (err instanceof OwnerReportContractError) {
        return jsonResponse({ error: { code: err.code, message: err.message } }, 400);
      }
      return jsonResponse(
        { error: { code: "INVALID_CURSOR", message: "cursor is not a valid cursor" } },
        400
      );
    }

    // 9. Load report data and assemble
    try {
      const now = deps.nowFn ? deps.nowFn() : new Date();
      const report = await awaitWithAbort(() => deps.store.loadReportData(
        socialAccountId,
        targetUserId,
        {
          periodDays,
          limit,
          cursor,
        },
        now
      ), signal);

      return jsonResponse(report, 200);
    } catch (err) {
      if (err instanceof OwnerReportContractError) {
        if (err.code === "ACCOUNT_MISMATCH") {
          return jsonResponse(
            { error: { code: "ACCOUNT_NOT_FOUND", message: "Instagram account not found" } },
            404
          );
        }
        return jsonResponse({ error: { code: err.code, message: err.message } }, 400);
      }

      if (err instanceof ReportHistoryUnavailableError || signal.aborted) {
        console.error("Instagram report refused an incomplete history read");
        return jsonResponse(
          { error: { code: "HISTORY_UNAVAILABLE", message: "Report history could not be read completely. Try again later." } },
          503,
        );
      }
      console.error("Failed to generate Instagram insights report:", err);
      return jsonResponse(
        { error: { code: "INTERNAL_ERROR", message: "Failed to generate report" } },
        500
      );
    }
  };
}
