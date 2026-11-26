import {
  ANALYTICS_PURPOSE_VERSION,
  YOUTUBE_ANALYTICS_REVISION_PATTERN,
  type YouTubeAnalyticsConsent,
  type YouTubeAnalyticsErrorCode,
} from "./contracts.ts";
import type { YouTubeAnalyticsRpcRunner } from "./decision.ts";

export type YouTubeAnalyticsConsentResult =
  | {
    ok: true;
    recorded: boolean;
    connectionRevision: string;
    consent: YouTubeAnalyticsConsent;
  }
  | { ok: false; code: YouTubeAnalyticsErrorCode };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REASONS = new Set<YouTubeAnalyticsErrorCode>([
  "invalid_request",
  "not_found",
  "provider_unsupported",
  "not_enabled",
  "connection_changed",
]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export async function recordYouTubeAnalyticsConsent(
  rpc: YouTubeAnalyticsRpcRunner,
  input: {
    ownerId: string;
    accountId: string;
    event: "accepted" | "withdrawn";
    purposeVersion?: number;
    locale?: "en" | "ar";
    requestId: string;
    expectedRevision?: string;
  },
): Promise<YouTubeAnalyticsConsentResult> {
  const purposeVersion = input.purposeVersion ?? ANALYTICS_PURPOSE_VERSION;
  const locale = input.locale ?? "en";
  if (!UUID_PATTERN.test(input.ownerId) || !UUID_PATTERN.test(input.accountId) ||
    (input.event === "accepted" && purposeVersion !== ANALYTICS_PURPOSE_VERSION)) {
    return {
      ok: false,
      code: input.event === "accepted" && purposeVersion !== ANALYTICS_PURPOSE_VERSION
        ? "consent_version_stale"
        : "invalid_request",
    };
  }
  if (input.event === "accepted" &&
    (!input.expectedRevision || !YOUTUBE_ANALYTICS_REVISION_PATTERN.test(input.expectedRevision))) {
    return { ok: false, code: "invalid_request" };
  }
  try {
    const { data: raw, error } = await rpc("youtube_analytics_stage5_record_consent", {
      p_owner_id: input.ownerId,
      p_account_id: input.accountId,
      p_event: input.event,
      p_purpose_version: purposeVersion,
      p_locale: locale,
      p_request_id: input.requestId,
      p_expected_revision: input.event === "accepted" ? input.expectedRevision : null,
    });
    const data = record(raw);
    if (error || !data || typeof data.ok !== "boolean") {
      return { ok: false, code: "settings_unavailable" };
    }
    if (!data.ok) {
      return typeof data.reason === "string" && REASONS.has(data.reason as YouTubeAnalyticsErrorCode)
        ? { ok: false, code: data.reason as YouTubeAnalyticsErrorCode }
        : { ok: false, code: "settings_unavailable" };
    }
    const consent = record(data.consent);
    if (typeof data.recorded !== "boolean" ||
      typeof data.connection_revision !== "string" ||
      !YOUTUBE_ANALYTICS_REVISION_PATTERN.test(data.connection_revision) ||
      consent?.state !== input.event || consent.version !== purposeVersion) {
      return { ok: false, code: "settings_unavailable" };
    }
    return {
      ok: true,
      recorded: data.recorded,
      connectionRevision: data.connection_revision,
      consent: { state: input.event, version: purposeVersion },
    };
  } catch {
    return { ok: false, code: "settings_unavailable" };
  }
}
