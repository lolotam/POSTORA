import { grantedScopes, youtubeCommentCapability } from "../_shared/youtubeCommentCapability.ts";
import {
  YOUTUBE_RESOURCE_QUOTA_POLICY,
  YOUTUBE_SCOPE,
  type YouTubeAccountCapabilities,
  type YouTubeCapabilityState,
  type YouTubeScopeState,
} from "./contracts.ts";
import { PUBLISHED_EDIT_WRITE_ENABLED } from "./editComposition.ts";

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

/** The facts every per-capability rule of spec section 3.3 reads. */
interface DerivationContext {
  composio: boolean;
  needsReconnect: boolean;
  scopes: { readonly: YouTubeScopeState; upload: YouTubeScopeState; force_ssl: YouTubeScopeState };
  hasRecordedList: boolean;
}

// Spec section 3.3 rule 4: Composio first, then connection, then the readonly scope.
function browseCapability({ composio, needsReconnect, scopes }: DerivationContext): YouTubeCapabilityState {
  if (composio) return { state: "unavailable", reason: "provider_unsupported" };
  if (needsReconnect) return RECONNECT;
  if (scopes.readonly === "granted") return AVAILABLE;
  return scopes.readonly === "unknown" ? UNKNOWN : MISSING_SCOPE;
}

// Rule 5: connection first; an unverified managed-provider upload is never presented as
// available; upload or force-ssl both allow uploads; an empty recorded list stays unknown.
function uploadCapability({ composio, needsReconnect, scopes, hasRecordedList }: DerivationContext): YouTubeCapabilityState {
  if (needsReconnect) return RECONNECT;
  if (composio) return UNKNOWN;
  if (scopes.upload === "granted" || scopes.force_ssl === "granted") return AVAILABLE;
  return hasRecordedList ? MISSING_SCOPE : UNKNOWN;
}

// Rule 6: reconnect wins, then the existing comment rule unchanged - no second rule.
// The row's auth_provider is passed through untouched; the shared rule owns its meaning.
function commentsCapability({ needsReconnect, authProvider, accountMetadata }: {
  needsReconnect: boolean;
  authProvider: string | null;
  accountMetadata: unknown;
}): YouTubeCapabilityState {
  if (needsReconnect) return RECONNECT;
  const capable = youtubeCommentCapability({
    auth_provider: authProvider,
    account_metadata: accountMetadata,
  }) === "capable";
  return capable ? AVAILABLE : MISSING_SCOPE;
}

// Spec section 8: thumbnail replacement is independent of PUBLISHED_EDIT_WRITE_ENABLED;
// composio is unsupported, reconnect wins, readonly is required for admission and video
// ownership pre-check, and upload or force-ssl both cover thumbnails.set.
function manageThumbnailCapability({ composio, needsReconnect, scopes, hasRecordedList }: DerivationContext): YouTubeCapabilityState {
  if (composio) return { state: "unavailable", reason: "provider_unsupported" };
  if (needsReconnect) return RECONNECT;
  if (scopes.readonly === "missing") return MISSING_SCOPE;
  if (scopes.readonly === "granted" && (scopes.upload === "granted" || scopes.force_ssl === "granted")) {
    return AVAILABLE;
  }
  return hasRecordedList ? MISSING_SCOPE : UNKNOWN;
}

// Spec section 8 & 11.1: caption listing and upload are independent of
// PUBLISHED_EDIT_WRITE_ENABLED; composio is unsupported, reconnect wins, readonly is
// required for admission and video ownership pre-check, and force-ssl covers captions.
function manageCaptionsCapability({ composio, needsReconnect, scopes, hasRecordedList }: DerivationContext): YouTubeCapabilityState {
  if (composio) return { state: "unavailable", reason: "provider_unsupported" };
  if (needsReconnect) return RECONNECT;
  if (scopes.readonly === "missing") return MISSING_SCOPE;
  if (scopes.readonly === "granted" && scopes.force_ssl === "granted") {
    return AVAILABLE;
  }
  return hasRecordedList ? MISSING_SCOPE : UNKNOWN;
}

// Spec section 14.4 (OD-10): playlists.insert requires youtube.readonly (for admission)
// and youtube.force-ssl (youtube.upload does not authorize playlists.insert).
function managePlaylistsCapability({ composio, needsReconnect, scopes, hasRecordedList }: DerivationContext): YouTubeCapabilityState {
  if (composio) return { state: "unavailable", reason: "provider_unsupported" };
  if (needsReconnect) return RECONNECT;
  if (scopes.readonly === "missing") return MISSING_SCOPE;
  if (scopes.readonly === "granted" && scopes.force_ssl === "granted") {
    return AVAILABLE;
  }
  return hasRecordedList ? MISSING_SCOPE : UNKNOWN;
}

// Spec section 8.1: published metadata editing requires native provider, active
// connection, PUBLISHED_EDIT_WRITE_ENABLED, readonly (for admission and
// ownership pre-check), and force-ssl (for videos.update).
function editMetadataCapability(
  { composio, needsReconnect, scopes, hasRecordedList }: DerivationContext,
  editWriteEnabled: boolean,
): YouTubeCapabilityState {
  if (composio || !editWriteEnabled) return { state: "unavailable", reason: "provider_unsupported" };
  if (needsReconnect) return RECONNECT;
  if (scopes.readonly === "missing") return MISSING_SCOPE;
  if (scopes.readonly === "granted" && scopes.force_ssl === "granted") {
    return AVAILABLE;
  }
  return hasRecordedList ? MISSING_SCOPE : UNKNOWN;
}

// Spec section 3.3: one pure function per row, no provider call, no I/O. The comment
// capability stays the existing rule (youtubeCommentCapability); no second rule is written.
export function deriveYouTubeCapabilities(
  account: YouTubeCapabilityAccountInput,
  options?: { editWriteEnabled?: boolean },
): YouTubeAccountCapabilities {
  const editWriteEnabled = options?.editWriteEnabled ?? PUBLISHED_EDIT_WRITE_ENABLED;
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
  const context: DerivationContext = {
    composio,
    needsReconnect,
    scopes,
    hasRecordedList: recorded.length > 0,
  };

  return {
    account_id: account.id,
    channel_id: account.channelId,
    channel_title: account.channelTitle,
    provider: composio ? "composio" : "native",
    connection: needsReconnect ? "reconnect_required" : "ok",
    scopes,
    capabilities: {
      browse: browseCapability(context),
      upload: uploadCapability(context),
      edit_metadata: editMetadataCapability(context, editWriteEnabled),
      manage_thumbnail: manageThumbnailCapability(context),
      manage_captions: manageCaptionsCapability(context),
      manage_playlists: managePlaylistsCapability(context),
      comments: commentsCapability({
        needsReconnect,
        authProvider: account.authProvider,
        accountMetadata: account.accountMetadata,
      }),
    },
    quota: YOUTUBE_RESOURCE_QUOTA_POLICY,
  };
}
