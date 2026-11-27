import {
  ANALYTICS_PURPOSE_ACCEPTED_VERSIONS,
  ANALYTICS_PURPOSE_VERSION,
  YOUTUBE_ANALYTICS_REQUIRED_SCOPES,
  YOUTUBE_ANALYTICS_REVISION_PATTERN,
  type YouTubeAnalyticsConsent,
  type YouTubeAnalyticsConsentState,
  type YouTubeAnalyticsErrorCode,
} from "./contracts.ts";

export interface YouTubeAnalyticsRpcResult {
  data: unknown;
  error: unknown;
}

export type YouTubeAnalyticsRpcRunner = (
  fn: string,
  args: Record<string, unknown>,
) => PromiseLike<YouTubeAnalyticsRpcResult>;

export interface YouTubeAnalyticsBinding {
  accountId: string;
  ownerId: string;
  channelId: string;
  bindingGeneration: number;
  bindingIncarnation: string;
  connectionRevision: string;
  provider: string;
  needsReauth: boolean;
  grantedScopes: string[];
  consent: YouTubeAnalyticsConsent;
}

export interface YouTubeAnalyticsCredentials {
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
}

export interface YouTubeAnalyticsDecisionDenial {
  code: YouTubeAnalyticsErrorCode;
  binding?: YouTubeAnalyticsBinding;
  consent?: YouTubeAnalyticsConsent;
}

export type YouTubeAnalyticsDecision =
  | {
    ok: true;
    binding: YouTubeAnalyticsBinding;
    credentials?: YouTubeAnalyticsCredentials;
  }
  | ({ ok: false } & YouTubeAnalyticsDecisionDenial);

export interface YouTubeAnalyticsDecisionInput {
  ownerId: string;
  accountId: string;
  expected?: YouTubeAnalyticsBinding;
  requiredScopes?: readonly string[];
  purposeVersion?: number;
  acceptedVersions?: readonly number[];
  withCredentials?: boolean;
}

const DECISION_REASONS = new Set<YouTubeAnalyticsErrorCode>([
  "invalid_request",
  "not_found",
  "connection_changed",
  "provider_unsupported",
  "not_enabled",
  "consent_required",
  "reconnect_required",
  "missing_scope",
]);
const CONSENT_STATES = new Set<YouTubeAnalyticsConsentState>([
  "none",
  "accepted",
  "outdated",
  "withdrawn",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function parseConsent(value: unknown): YouTubeAnalyticsConsent | null {
  const raw = record(value);
  const state = raw?.state;
  if (!raw || !CONSENT_STATES.has(state as YouTubeAnalyticsConsentState) ||
    typeof raw.version !== "number" || !Number.isInteger(raw.version) || raw.version < 1) {
    return null;
  }
  return { state: state as YouTubeAnalyticsConsentState, version: raw.version };
}

function parseBinding(
  raw: Record<string, unknown>,
  input: YouTubeAnalyticsDecisionInput,
): YouTubeAnalyticsBinding | null {
  const consent = parseConsent(raw.consent);
  if (nullableText(raw.channel_id) === null || typeof raw.binding_generation !== "number" ||
    !Number.isSafeInteger(raw.binding_generation) || raw.binding_generation < 0 ||
    nullableText(raw.binding_incarnation) === null ||
    !UUID_PATTERN.test(raw.binding_incarnation as string) ||
    nullableText(raw.connection_revision) === null ||
    !YOUTUBE_ANALYTICS_REVISION_PATTERN.test(raw.connection_revision as string) ||
    nullableText(raw.provider) === null || typeof raw.needs_reauth !== "boolean" ||
    !Array.isArray(raw.granted_scopes) ||
    !raw.granted_scopes.every((scope) => typeof scope === "string") || consent === null) {
    return null;
  }
  return {
    accountId: input.accountId,
    ownerId: input.ownerId,
    channelId: raw.channel_id as string,
    bindingGeneration: raw.binding_generation,
    bindingIncarnation: raw.binding_incarnation as string,
    connectionRevision: raw.connection_revision as string,
    provider: raw.provider as string,
    needsReauth: raw.needs_reauth,
    grantedScopes: raw.granted_scopes as string[],
    consent,
  };
}

function parseCredentials(value: unknown): YouTubeAnalyticsCredentials | null {
  const raw = record(value);
  if (!raw || !("access_token" in raw) || !("refresh_token" in raw) ||
    !("token_expires_at" in raw)) {
    return null;
  }
  const accessToken = raw.access_token === null ? null : nullableText(raw.access_token);
  const refreshToken = raw.refresh_token === null ? null : nullableText(raw.refresh_token);
  const tokenExpiresAt = raw.token_expires_at === null ? null : nullableText(raw.token_expires_at);
  if ((raw.access_token !== null && accessToken === null) ||
    (raw.refresh_token !== null && refreshToken === null) ||
    (raw.token_expires_at !== null && tokenExpiresAt === null)) {
    return null;
  }
  return { accessToken, refreshToken, tokenExpiresAt };
}

function settingsUnavailable(): YouTubeAnalyticsDecision {
  return { ok: false, code: "settings_unavailable" };
}

export async function decideYouTubeAnalytics(
  rpc: YouTubeAnalyticsRpcRunner,
  input: YouTubeAnalyticsDecisionInput,
): Promise<YouTubeAnalyticsDecision> {
  const expected = input.expected;
  const candidateVersions = input.purposeVersion !== undefined
    ? [input.purposeVersion]
    : [...(input.acceptedVersions ?? ANALYTICS_PURPOSE_ACCEPTED_VERSIONS)].sort((a, b) => b - a);
  if (candidateVersions.length === 0) return settingsUnavailable();

  let firstOutdatedDenial: YouTubeAnalyticsDecision | null = null;
  for (let index = 0; index < candidateVersions.length; index += 1) {
    const candidateVersion = candidateVersions[index];
    try {
      const { data: raw, error } = await rpc("youtube_analytics_stage5_decide", {
        p_owner_id: input.ownerId,
        p_account_id: input.accountId,
        p_expected_channel: expected?.channelId ?? null,
        p_expected_generation: expected?.bindingGeneration ?? null,
        p_expected_incarnation: expected?.bindingIncarnation ?? null,
        p_required_scopes: [...(input.requiredScopes ?? YOUTUBE_ANALYTICS_REQUIRED_SCOPES)],
        p_purpose_version: candidateVersion,
        p_with_credentials: input.withCredentials === true,
      });
      if (error) return settingsUnavailable();
      const data = record(raw);
      if (!data || typeof data.ok !== "boolean") return settingsUnavailable();
      const binding = parseBinding(data, input);
      if (data.ok === true) {
        if (data.reason !== "ok" || binding === null) return settingsUnavailable();
        if (expected && (binding.channelId !== expected.channelId ||
          binding.bindingGeneration !== expected.bindingGeneration ||
          binding.bindingIncarnation !== expected.bindingIncarnation ||
          binding.connectionRevision !== expected.connectionRevision)) {
          return settingsUnavailable();
        }
        if (input.withCredentials === true) {
          const credentials = parseCredentials(data.credentials);
          if (credentials === null) return settingsUnavailable();
          return { ok: true, binding, credentials };
        }
        return { ok: true, binding };
      }
      if (typeof data.reason !== "string" ||
        !DECISION_REASONS.has(data.reason as YouTubeAnalyticsErrorCode)) {
        return settingsUnavailable();
      }
      const code = data.reason as YouTubeAnalyticsErrorCode;
      const bindingExpected = code !== "invalid_request" && code !== "not_found" && code !== "connection_changed";
      if (bindingExpected && binding === null) {
        return settingsUnavailable();
      }
      const consent = parseConsent(data.consent);
      const denial: YouTubeAnalyticsDecision = {
        ok: false,
        code,
        ...(binding ? { binding } : {}),
        ...(consent ? { consent } : {}),
      };
      const effectiveConsentState = consent?.state ?? binding?.consent.state;
      if (code === "consent_required" && effectiveConsentState === "outdated" && index + 1 < candidateVersions.length) {
        if (firstOutdatedDenial === null) firstOutdatedDenial = denial;
        continue;
      }
      return firstOutdatedDenial ?? denial;
    } catch {
      return settingsUnavailable();
    }
  }
  return firstOutdatedDenial ?? settingsUnavailable();
}
