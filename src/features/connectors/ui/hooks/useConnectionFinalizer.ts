import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { finalizeConnection, type FinalizeResult } from "../../infrastructure/connectorsApi";
import { connectorKeys } from "./useConnectorConnections";

/** Composio activates an account within seconds of the consent screen; three
 *  seconds keeps the wait short without hammering the edge function. */
export const CONNECTION_POLL_MS = 3_000;
/** The signed connect state's own TTL: past it the server refuses anyway. */
export const CONNECTION_POLL_DEADLINE_MS = 10 * 60_000;
/** Transient request failures tolerated in a row before giving up. */
const MAX_CONSECUTIVE_ERRORS = 5;

export type FinalizerStatus = "idle" | "waiting" | "active" | "failed";

export interface FinalizerState {
  status: FinalizerStatus;
  /** The server's failure code, `timeout` past the deadline, or `request_failed`. */
  failureCode: string | null;
}

export interface ConnectionFinalizerOptions {
  /** The row to complete; null stops the poll. */
  connectionId: string | null;
  /** YouTube only: the profile tab the channel should land on. */
  socialProfileId?: string | null;
  onActive?: () => void;
  onFailed?: (code: string) => void;
  finalize?: typeof finalizeConnection;
}

/**
 * Polls `composio-connect/finalize` for a connection the user is authorising
 * on Composio's own page. Composio's hosted page never sends the browser back,
 * so completion is something the app asks for, not something it is told.
 */
export function useConnectionFinalizer(options: ConnectionFinalizerOptions): FinalizerState {
  const queryClient = useQueryClient();
  const [state, setState] = useState<FinalizerState>({ status: "idle", failureCode: null });
  // Callbacks live in refs so a re-render never restarts the poll.
  const callbacks = useRef(options);
  callbacks.current = options;
  const { connectionId, socialProfileId = null } = options;

  useEffect(() => {
    if (!connectionId) {
      setState({ status: "idle", failureCode: null });
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let consecutiveErrors = 0;
    const startedAt = Date.now();
    setState({ status: "waiting", failureCode: null });

    const refreshEverythingConnectionsTouch = () => {
      queryClient.invalidateQueries({ queryKey: connectorKeys.connections() });
      queryClient.invalidateQueries({ queryKey: connectorKeys.usage() });
      for (const key of ["social_accounts", "social_profiles", "all_social_accounts", "social_accounts_by_profile"]) {
        queryClient.invalidateQueries({ queryKey: [key] });
      }
    };
    const finish = (result: FinalizeResult | { status: "failed"; failure_code: string }) => {
      refreshEverythingConnectionsTouch();
      if (result.status === "active") {
        setState({ status: "active", failureCode: null });
        callbacks.current.onActive?.();
      } else {
        // A failed verdict, or a payload this client does not understand:
        // either way the wait is over and the user must be told.
        const code = result.status === "failed" ? result.failure_code : "request_failed";
        setState({ status: "failed", failureCode: code });
        callbacks.current.onFailed?.(code);
      }
    };

    const tick = async () => {
      if (cancelled) return;
      try {
        const result = await (callbacks.current.finalize ?? finalizeConnection)(
          connectionId,
          socialProfileId ?? undefined,
        );
        if (cancelled) return;
        consecutiveErrors = 0;
        if (result.status !== "pending") {
          finish(result);
          return;
        }
      } catch {
        if (cancelled) return;
        if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
          finish({ status: "failed", failure_code: "request_failed" });
          return;
        }
      }
      if (Date.now() - startedAt >= CONNECTION_POLL_DEADLINE_MS) {
        finish({ status: "failed", failure_code: "timeout" });
        return;
      }
      timer = setTimeout(tick, CONNECTION_POLL_MS);
    };
    timer = setTimeout(tick, 0);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [connectionId, socialProfileId, queryClient]);

  return state;
}

/**
 * Opens the tab the provider page will load into, synchronously inside the
 * click so popup blockers allow it. Returns null when blocked; the caller then
 * falls back to navigating the current tab.
 */
export function openAuthorisationTab(): Window | null {
  try {
    return window.open("", "_blank");
  } catch {
    return null;
  }
}
