import { grantedScopes, youtubeCommentCapability } from "../_shared/youtubeCommentCapability.ts";
import {
  YOUTUBE_RESOURCE_QUOTA_POLICY,
  YOUTUBE_SCOPE,
  type YouTubeAccountCapabilities,
  type YouTubeCapabilityState,
  type YouTubeScopeState,
} from "./contracts.ts";

export interface YouTubeCapabilityAccountInput {
  id: string;
  channelId: string | null;
  channelTitle: string | null;
  authProvider: string | null;
  needsReauth: boolean;
  hasAccessToken: boolean;
  hasRefreshToken: boolean;
  accountMetadata: unknown;
}

const RECONNECT: YouTubeCapabilityState = { state: "unavailable", reason: "reconnect_required" };
const MISSING_SCOPE: YouTubeCapabilityState = { state: "unavailable", reason: "missing_scope" };
const AVAILABLE: YouTubeCapabilityState = { state: "available" };
const UNKNOWN: YouTubeCapabilityState = { state: "unknown" };

// Spec section 3.3: one pure function per row, no provider call, no I/O. The comment
// capability stays the existing rule (youtubeCommentCapability); no second rule is written.
export function deriveYouTubeCapabilities(
  account: YouTubeCapabilityAccountInput,
): YouTubeAccountCapabilities {
  const composio = account.authProvider === "composio";
  const recorded = composio ? [] : grantedScopes(account.accountMetadata);
  const scopeState = (scope: string): YouTubeScopeState =>
    recorded.length === 0 ? "unknown" : recorded.includes(scope) ? "granted" : "missing";
  const scopes = {
    readonly: scopeState(YOUTUBE_SCOPE.readonly),
    upload: scopeState(YOUTUBE_SCOPE.upload),
    force_ssl: scopeState(YOUTUBE_SCOPE.force_ssl),
  };
  const needsReconnect = account.needsReauth ||
    (!composio && !account.hasAccessToken && !account.hasRefreshToken);
  const connection = needsReconnect ? "reconnect_required" : "ok";

  let browse: YouTubeCapabilityState;
  if (composio) {
    browse = { state: "unavailable", reason: "provider_unsupported" };
  } else if (needsReconnect) {
    browse = RECONNECT;
  } else if (scopes.readonly === "granted") {
    browse = AVAILABLE;
  } else if (scopes.readonly === "unknown") {
    browse = UNKNOWN;
  } else {
    browse = MISSING_SCOPE;
  }

  let upload: YouTubeCapabilityState;
  if (needsReconnect) {
    upload = RECONNECT;
  } else if (composio) {
    upload = UNKNOWN;
  } else if (scopes.upload === "granted" || scopes.force_ssl === "granted") {
    upload = AVAILABLE;
  } else if (recorded.length === 0) {
    upload = UNKNOWN;
  } else {
    upload = MISSING_SCOPE;
  }

  const comments: YouTubeCapabilityState = needsReconnect
    ? RECONNECT
    : youtubeCommentCapability({
      auth_provider: account.authProvider,
      account_metadata: account.accountMetadata,
    }) === "capable"
    ? AVAILABLE
    : MISSING_SCOPE;

  return {
    account_id: account.id,
    channel_id: account.channelId,
    channel_title: account.channelTitle,
    provider: composio ? "composio" : "native",
    connection,
    scopes,
    capabilities: { browse, upload, comments },
    quota: YOUTUBE_RESOURCE_QUOTA_POLICY,
  };
}
