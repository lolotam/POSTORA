/**
 * Protected OAuth gate.
 *
 * Facebook Page connect, Page-linked Instagram connect, and direct Instagram
 * login all create or reactivate accounts and stash provider tokens. The
 * accepted SQL has no atomic create/reactivate/rebind, no captured absence
 * fence, and no attempt-nonce authority. Protected mode therefore refuses
 * before provider exchange, token stash, and account mutation.
 *
 * The refusal is not a typed disclosure wrapped around the old writer. The
 * ports passed by the caller are validated and then left uncalled.
 */

import {
  type AppSettingLookup,
  type FacebookCredentialMode,
  type LifecycleRefusal,
  loadFacebookCredentialSettings,
  refuseProtectedLifecycle,
} from "../_shared/facebookCredentialMode.ts";

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
 * Loads the server-controlled mode, then either refuses or runs the legacy
 * continuation. Protected mode does not call provider, stash, or account
 * mutation ports, and it does not call `legacy`.
 */
export async function beginOAuthRequest<T>(input: {
  lookup: AppSettingLookup;
  flow: string;
  action: string;
  ports: OAuthLifecyclePorts;
  legacy: () => Promise<T>;
}): Promise<LifecycleRefusal | T> {
  const { credentialMode } = await loadFacebookCredentialSettings(input.lookup);
  return continueOAuthRequest({
    mode: credentialMode,
    flow: input.flow,
    action: input.action,
    ports: input.ports,
    legacy: input.legacy,
  });
}

export async function continueOAuthRequest<T>(input: {
  mode: FacebookCredentialMode;
  flow: string;
  action: string;
  ports: OAuthLifecyclePorts;
  legacy: () => Promise<T>;
}): Promise<LifecycleRefusal | T> {
  assertUncalledPorts(input.ports);
  if (input.mode === "protected") {
    return refuseProtectedLifecycle(input.flow, input.action);
  }
  return input.legacy();
}
