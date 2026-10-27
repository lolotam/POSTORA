/**
 * Protected Meta refresh gate.
 *
 * A correct refresh has to capture the token and its authority in one
 * transaction, then consume that capture on success and on failure. Failure
 * also has to keep the partner reauthorization event and the alert cooldown
 * in that same transaction. Those SQL contracts are not implemented.
 *
 * Scheduled and manual protected refresh therefore refuse before HTTP, the
 * attempt marker, health or token writes, alerts, and failure events. The
 * legacy failure handler is not a fallback.
 */

import {
  type FacebookCredentialMode,
  type LifecycleRefusal,
  refuseProtectedLifecycle,
} from "../_shared/facebookCredentialMode.ts";

export interface MetaRefreshPorts {
  exchange: () => Promise<unknown>;
  markAttempt: () => Promise<unknown>;
  writeHealth: () => Promise<unknown>;
  sendAlert: () => Promise<unknown>;
  recordEvent: () => Promise<unknown>;
}

export function isProtectedMetaRefreshPlatform(platform: string): boolean {
  return platform === "facebook" || platform === "instagram";
}

function assertUncalledPorts(ports: MetaRefreshPorts): void {
  if (
    typeof ports.exchange !== "function" ||
    typeof ports.markAttempt !== "function" ||
    typeof ports.writeHealth !== "function" ||
    typeof ports.sendAlert !== "function" ||
    typeof ports.recordEvent !== "function"
  ) {
    throw new Error("Meta refresh ports are incomplete");
  }
}

/** Tripwire used by production. Protected refresh must not call these. */
export function refreshTripwirePorts(): MetaRefreshPorts {
  const forbid = (kind: string) => () =>
    Promise.reject(new Error(`protected refresh ${kind} invoked`));
  return {
    exchange: forbid("exchange"),
    markAttempt: forbid("markAttempt"),
    writeHealth: forbid("writeHealth"),
    sendAlert: forbid("sendAlert"),
    recordEvent: forbid("recordEvent"),
  };
}

/**
 * Refuses protected Facebook and Instagram refresh. Every other platform, and
 * Meta while the mode is legacy, runs `legacy`. A thrown legacy error is the
 * caller's existing failure handler. A protected refusal never reaches it.
 */
export async function settleMetaRefreshAttempt<T>(input: {
  mode: FacebookCredentialMode;
  platform: string;
  trigger: "scheduled" | "manual";
  ports: MetaRefreshPorts;
  legacy: () => Promise<T>;
  onLegacyFailure: (error: unknown) => Promise<T>;
}): Promise<LifecycleRefusal | T> {
  assertUncalledPorts(input.ports);
  if (input.mode === "protected" && isProtectedMetaRefreshPlatform(input.platform)) {
    return refuseProtectedLifecycle("meta_refresh", input.trigger);
  }
  try {
    return await input.legacy();
  } catch (error) {
    return input.onLegacyFailure(error);
  }
}
