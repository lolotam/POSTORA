import {
  YOUTUBE_ANALYTICS_ERRORS,
  type YouTubeAnalyticsConsent,
  type YouTubeAnalyticsErrorCode,
  type YouTubeAnalyticsErrorResponse,
  type YouTubeAnalyticsPageScope,
} from "./types";

export interface YouTubeAnalyticsClientErrorOptions {
  requestId?: string | null;
  scope?: YouTubeAnalyticsPageScope;
  retryAfterSeconds?: number | null;
  connectionRevision?: string | null;
  reportingEndDate?: string | null;
  acceptedWindowEnds?: [string, string] | null;
  consent?: YouTubeAnalyticsConsent | null;
  purposeVersion?: number | null;
  detail?: "grant_not_effective" | null;
}

export class YouTubeAnalyticsClientError extends Error {
  readonly code: YouTubeAnalyticsErrorCode;
  readonly requestId: string | null;
  readonly scope: YouTubeAnalyticsPageScope;
  readonly retryAfterSeconds: number | null;
  readonly connectionRevision: string | null;
  readonly reportingEndDate: string | null;
  readonly acceptedWindowEnds: [string, string] | null;
  readonly consent: YouTubeAnalyticsConsent | null;
  readonly purposeVersion: number | null;
  readonly detail: "grant_not_effective" | null;

  constructor(code: YouTubeAnalyticsErrorCode, options: YouTubeAnalyticsClientErrorOptions = {}) {
    super(code);
    this.name = "YouTubeAnalyticsClientError";
    this.code = code;
    this.requestId = options.requestId ?? null;
    this.scope = options.scope ?? YOUTUBE_ANALYTICS_ERRORS[code].scope;
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    this.connectionRevision = options.connectionRevision ?? null;
    this.reportingEndDate = options.reportingEndDate ?? null;
    this.acceptedWindowEnds = options.acceptedWindowEnds ?? null;
    this.consent = options.consent ?? null;
    this.purposeVersion = options.purposeVersion ?? null;
    this.detail = options.detail ?? null;
  }

  static fromResponse(payload: YouTubeAnalyticsErrorResponse): YouTubeAnalyticsClientError {
    return new YouTubeAnalyticsClientError(payload.error, {
      requestId: payload.request_id,
      retryAfterSeconds: payload.retry_after_seconds,
      connectionRevision: payload.connection_revision,
      reportingEndDate: payload.reporting_end_date,
      acceptedWindowEnds: payload.accepted_window_ends,
      consent: payload.consent,
      purposeVersion: payload.purpose_version,
      detail: payload.detail,
    });
  }
}

export function isYouTubeAnalyticsErrorCode(value: unknown): value is YouTubeAnalyticsErrorCode {
  return typeof value === "string" && value in YOUTUBE_ANALYTICS_ERRORS;
}

export function isAccountScopedError(code: YouTubeAnalyticsErrorCode): boolean {
  return YOUTUBE_ANALYTICS_ERRORS[code].scope === "account";
}

export function isLatchableProviderRefusal(error: YouTubeAnalyticsClientError): boolean {
  return error.code === "missing_scope" || error.code === "reconnect_required";
}

export function asYouTubeAnalyticsClientError(error: unknown): YouTubeAnalyticsClientError {
  return error instanceof YouTubeAnalyticsClientError
    ? error
    : new YouTubeAnalyticsClientError("upstream_unavailable");
}
