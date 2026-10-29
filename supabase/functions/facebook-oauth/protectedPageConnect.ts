/**
 * Protected OAuth gate and the Facebook-route dispatch.
 *
 * WHAT THIS IS
 *
 *   The seam every Meta OAuth entrypoint already used, extended with the
 *   supported protected dispatch.
 *
 *   The accepted lifecycle SQL exists now. A protected route therefore has
 *   two supported shapes and one unsupported shape:
 *
 *     - a supported action runs the captured lifecycle: begin, claim,
 *       complete, read, commit;
 *     - an unsupported action (the JavaScript-SDK and provider-token-only
 *       paths) still refuses before provider exchange, token stash and
 *       account mutation;
 *     - a legacy callback that arrives while protected mode is selected
 *       refuses and asks for a restart.
 *
 *   The refusal is not a typed disclosure wrapped around the old writer. The
 *   ports passed by the caller are validated and then left uncalled.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN
 *
 *   The provider calls. The Facebook Graph calls stay with the entrypoint
 *   that owns them. This module owns the gate, the supported-action table and
 *   the Facebook-route mapping of the safe picker projection.
 */

import {
  type AppSettingLookup,
  type FacebookCredentialMode,
  type LifecycleRefusal,
  loadFacebookCredentialSettings,
  refuseProtectedLifecycle,
} from "../_shared/facebookCredentialMode.ts";
import type {
  MetaOAuthAttemptStore,
  MetaOAuthFlow,
} from "../_shared/metaOAuthAttemptStore.ts";
import {
  ProtectedOAuthError,
  type PendingLinkageReader,
  type ProtectedAttemptReader,
  type ProtectedReceiptReader,
  type ProtectedRouteContext,
} from "../_shared/metaOAuthProtectedFlow.ts";
import { isProtectedPilotUser } from "../_shared/protectedAccountCutover.ts";

export interface OAuthLifecyclePorts {
  provider: () => Promise<unknown>;
  stash: () => Promise<unknown>;
  mutateAccount: () => Promise<unknown>;
}

function assertUncalledPorts(ports: OAuthLifecyclePorts): void {
  if (
    typeof ports.provider !== "function" ||
    typeof ports.stash !== "function" ||
    typeof ports.mutateAccount !== "function"
  ) {
    throw new Error("OAuth lifecycle ports are incomplete");
  }
}

/**
 * Tripwire used by production routes. Protected mode must not call these.
 * If a later edit does, the route fails instead of exchanging or writing.
 */
export function oauthTripwirePorts(): OAuthLifecyclePorts {
  const forbid = (kind: string) => () =>
    Promise.reject(new Error(`protected oauth ${kind} invoked`));
  return {
    provider: forbid("provider"),
    stash: forbid("stash"),
    mutateAccount: forbid("mutate"),
  };
}

/**
 * The flow identifiers the gate uses. They are the entrypoint names, not the
 * SQL flows.
 */
export type OAuthGateFlow = "facebook_oauth" | "instagram_business_oauth" | "instagram_oauth";

/**
 * Which actions each route supports in protected mode.
 *
 * A supported action runs the captured lifecycle. An unsupported action
 * refuses before any provider call, token read or account write:
 *
 *   - `list_pages` and `store_account` need a JavaScript-SDK provider token
 *     and cannot substitute for a captured preauthorization;
 *   - `store_instagram` stores a standalone Instagram account from a
 *     provider token and has no captured Page-linked or direct identity;
 *   - the direct Instagram POST `callback` shim carries no signed attempt
 *     and stays refused.
 */
const SUPPORTED_PROTECTED_ACTIONS: Record<OAuthGateFlow, readonly string[]> = {
  facebook_oauth: [
    "authorize",
    "get_pending_selection",
    "store_page",
  ],
  instagram_business_oauth: [
    "authorize",
    "get_pending_selection",
    "store_ig_account",
    "clear_pending_selection",
  ],
  instagram_oauth: [
    "authorize",
  ],
};

export function isProtectedActionSupported(flow: OAuthGateFlow, action: string): boolean {
  return SUPPORTED_PROTECTED_ACTIONS[flow].includes(action);
}

/**
 * Loads the server-controlled mode, then either dispatches the supported
 * protected continuation, refuses, or runs the legacy continuation.
 *
 * Protected mode does not call provider, stash, or account mutation ports
 * for a refused action, and it does not call `legacy`.
 *
 * `attemptOwned` marks a request whose pending reference carries an attempt
 * linkage. Such a request keeps its protected lifecycle in legacy mode too:
 * a captured attempt never downgrades to the legacy writer.
 *
 * Under a global `legacy`, `authorize` for a user in the protected pilot list
 * (`protectedAccountCutover.ts`) begins a protected attempt. That is the one
 * way an account gets a protected authority while everyone else stays legacy.
 */
export async function beginOAuthRequest<T>(input: {
  lookup: AppSettingLookup;
  flow: OAuthGateFlow;
  action: string;
  ports: OAuthLifecyclePorts;
  legacy: () => Promise<T>;
  /** The supported protected dispatch. When absent, protected mode refuses. */
  protected?: () => Promise<T>;
  /** True when the request is owned by a captured OAuth attempt. */
  attemptOwned?: boolean;
  /**
   * The authenticated caller. Only used to ask whether this user is in the
   * protected pilot list, and only for `authorize` under a global `legacy`.
   */
  userId?: string;
}): Promise<LifecycleRefusal | T> {
  const { credentialMode } = await loadFacebookCredentialSettings(input.lookup);
  const protectedPilot = credentialMode === "legacy" &&
    input.action === "authorize" &&
    typeof input.userId === "string" &&
    await isProtectedPilotUser(input.lookup, input.userId);
  return continueOAuthRequest({
    mode: credentialMode,
    flow: input.flow,
    action: input.action,
    ports: input.ports,
    legacy: input.legacy,
    protected: input.protected,
    attemptOwned: input.attemptOwned,
    protectedPilot,
  });
}

export async function continueOAuthRequest<T>(input: {
  mode: FacebookCredentialMode;
  flow: OAuthGateFlow;
  action: string;
  ports: OAuthLifecyclePorts;
  legacy: () => Promise<T>;
  protected?: () => Promise<T>;
  /** True when the request is owned by a captured OAuth attempt. */
  attemptOwned?: boolean;
  /**
   * True when a pilot user starts `authorize` under a global `legacy`. The
   * protected attempt it begins then carries the rest of the lifecycle
   * through `attemptOwned`, so no later step needs the pilot list.
   */
  protectedPilot?: boolean;
}): Promise<LifecycleRefusal | T> {
  assertUncalledPorts(input.ports);
  if (input.mode === "protected") {
    if (!input.protected || !isProtectedActionSupported(input.flow, input.action)) {
      return refuseProtectedLifecycle(input.flow, input.action);
    }
    return input.protected();
  }
  if (input.attemptOwned && input.protected) {
    return input.protected();
  }
  if (
    input.protectedPilot && input.action === "authorize" && input.protected &&
    isProtectedActionSupported(input.flow, input.action)
  ) {
    return input.protected();
  }
  return input.legacy();
}

// ---------------------------------------------------------------------------
// Facebook-route dispatch
// ---------------------------------------------------------------------------

/**
 * The shared dependencies of the Facebook protected route.
 */
export interface FacebookProtectedRuntime {
  store: MetaOAuthAttemptStore;
  linkage: PendingLinkageReader;
  attempts: ProtectedAttemptReader;
  receipts: ProtectedReceiptReader;
}

/**
 * The SQL flow the Facebook route acts on.
 *
 * A Facebook authorization that targets Instagram is a Page-linked
 * Instagram authorization. A Facebook authorization that targets a Page is a
 * Facebook Page authorization. The signed state carries the same
 * distinction, so the callback can check the flow it was minted for.
 */
export function facebookRouteFlow(targetPlatform: unknown): MetaOAuthFlow {
  return targetPlatform === "instagram" ? "instagram_page_linked" : "facebook_page";
}

export function createFacebookRouteContext(
  runtime: FacebookProtectedRuntime,
  userId: string,
  expectedFlows: MetaOAuthFlow[],
): ProtectedRouteContext {
  return {
    store: runtime.store,
    linkage: runtime.linkage,
    attempts: runtime.attempts,
    receipts: runtime.receipts,
    userId,
    expectedFlows,
  };
}

export interface FacebookProtectedCandidate {
  /** The opaque authority for this candidate. */
  selection_key: string;
  /** The Facebook Page id. */
  id: string;
  /** The Facebook Page name. */
  name: string;
  /** True when the candidate carries a linked Instagram identity. */
  has_instagram: boolean;
  ig_user_id: string | null;
  ig_username: string | null;
  ig_profile_picture_url: string | null;
}

export interface FacebookProtectedProjection {
  attempt_id: string;
  flow: MetaOAuthFlow;
  intent: string;
  social_profile_id: string | null;
  expired: boolean;
  committed_selection_keys: string[];
  pages: FacebookProtectedCandidate[];
  standalone_instagram: FacebookProtectedCandidate[];
}

/**
 * Maps the safe picker projection onto the shape the existing Facebook picker
 * already consumes.
 *
 * A `facebook_page` candidate is a Page. An `instagram_page_linked` candidate
 * is a linked Instagram account. Both keep their opaque selection key, which
 * is the only authority the store action accepts.
 */
export function projectFacebookPicker(projection: {
  attempt_id: string;
  flow: MetaOAuthFlow;
  intent: string;
  social_profile_id: string | null;
  expired: boolean;
  committed_selection_keys: string[];
  candidates: Array<{
    selection_key: string;
    ig_user_id: string | null;
    ig_username: string | null;
    ig_profile_picture_url: string | null;
    facebook_page_id: string | null;
    facebook_page_name: string | null;
  }>;
}): FacebookProtectedProjection {
  const pages: FacebookProtectedCandidate[] = [];
  const standalone: FacebookProtectedCandidate[] = [];

  for (const candidate of projection.candidates) {
    const entry: FacebookProtectedCandidate = {
      selection_key: candidate.selection_key,
      id: candidate.facebook_page_id ?? candidate.ig_user_id ?? "",
      name: candidate.facebook_page_name ?? candidate.ig_username ?? "",
      has_instagram: candidate.ig_user_id !== null,
      ig_user_id: candidate.ig_user_id,
      ig_username: candidate.ig_username,
      ig_profile_picture_url: candidate.ig_profile_picture_url,
    };
    if (candidate.facebook_page_id !== null) pages.push(entry);
    else standalone.push(entry);
  }

  return {
    attempt_id: projection.attempt_id,
    flow: projection.flow,
    intent: projection.intent,
    social_profile_id: projection.social_profile_id,
    expired: projection.expired,
    committed_selection_keys: [...projection.committed_selection_keys],
    pages,
    standalone_instagram: standalone,
  };
}

/**
 * The refusal a route returns when the server mode cannot be resolved.
 *
 * An unreadable mode is a typed failure. It never falls back to the legacy
 * writer and never admits a new protected attempt.
 */
export function protectedModeUnavailable(): ProtectedOAuthError {
  return new ProtectedOAuthError(
    "PROTECTED_OAUTH_MODE_UNAVAILABLE",
    "The Meta credential mode could not be read.",
    503,
  );
}
