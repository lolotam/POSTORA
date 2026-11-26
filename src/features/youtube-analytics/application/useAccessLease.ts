import { useCallback, useEffect, useRef, useState } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { YouTubeAnalyticsGateway } from "./ports";
import { isAccountAnalyticsQueryKey } from "./queryKeys";
import {
  asYouTubeAnalyticsClientError,
  isAccountScopedError,
  isLatchableProviderRefusal,
  YouTubeAnalyticsClientError,
} from "../domain/errors";
import type { YouTubeAnalyticsStatusData, YouTubeAnalyticsSuccess } from "../domain/types";

export const YOUTUBE_ANALYTICS_LEASE_MS = 90_000;
export const YOUTUBE_ANALYTICS_STATUS_DEADLINE_MS = 20_000;
export const YOUTUBE_ANALYTICS_STATUS_POLL_MS = 60_000;
const STATUS_BACKOFF_MS = [5_000, 15_000, 45_000, 60_000] as const;

interface LatchedRefusal {
  revision: string;
  error: YouTubeAnalyticsClientError;
}

interface AccessState {
  identity: string;
  status: YouTubeAnalyticsStatusData | null;
  pinnedWindowEnd: string | null;
  lastRevision: string | null;
  leaseStartedAt: number | null;
  denial: YouTubeAnalyticsClientError | null;
  latch: LatchedRefusal | null;
  statusError: YouTubeAnalyticsClientError | null;
  checking: boolean;
}

interface StatusFlight {
  epoch: number;
  issuedAt: number;
  controller: AbortController;
  promise: Promise<YouTubeAnalyticsSuccess<YouTubeAnalyticsStatusData>>;
}

function initialState(identity: string): AccessState {
  return {
    identity,
    status: null,
    pinnedWindowEnd: null,
    lastRevision: null,
    leaseStartedAt: null,
    denial: null,
    latch: null,
    statusError: null,
    checking: false,
  };
}

function purgeAccountReports(
  queryClient: QueryClient,
  userId: string,
  accountId: string,
  connectionRevision?: string,
) {
  setTimeout(() => {
    queryClient.removeQueries({
      predicate: (query) => isAccountAnalyticsQueryKey(query.queryKey, userId, accountId, connectionRevision),
    });
  }, 0);
}

export interface YouTubeAnalyticsAccessLease {
  status: YouTubeAnalyticsStatusData | null;
  connectionRevision: string | null;
  windowEnd: string | null;
  mayFetch: boolean;
  mayShow: boolean;
  checkingAccess: boolean;
  denial: YouTubeAnalyticsClientError | null;
  latchedError: YouTubeAnalyticsClientError | null;
  statusError: YouTubeAnalyticsClientError | null;
  refreshStatus: (options?: { advanceWindow?: boolean }) => Promise<YouTubeAnalyticsStatusData | null>;
  advancePinnedWindow: () => void;
  reportDataError: (error: unknown) => void;
  clearLatchForRetry: () => void;
  markWithdrawn: () => void;
}

export function useAccessLease(params: {
  userId: string;
  accountId: string | null;
  gateway: YouTubeAnalyticsGateway;
}): YouTubeAnalyticsAccessLease {
  const { userId, accountId, gateway } = params;
  const queryClient = useQueryClient();
  const identity = `${userId}:${accountId ?? ""}`;
  const [state, setState] = useState<AccessState>(() => initialState(identity));
  const [now, setNow] = useState(() => Date.now());
  const stateRef = useRef(state);
  const epochRef = useRef(0);
  const flightRef = useRef<StatusFlight | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failuresRef = useRef(0);
  const mountedRef = useRef(true);
  const previousIdentityRef = useRef<{ userId: string; accountId: string | null } | null>(null);

  const update = useCallback((recipe: (current: AccessState) => AccessState) => {
    const next = recipe(stateRef.current);
    stateRef.current = next;
    if (mountedRef.current) setState(next);
  }, []);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const bumpEpoch = useCallback(() => {
    epochRef.current += 1;
    flightRef.current?.controller.abort();
    flightRef.current = null;
  }, []);

  const issueStatus = useCallback(async (manual = false, advanceWindow = false): Promise<YouTubeAnalyticsStatusData | null> => {
    if (!accountId || !userId || flightRef.current) return null;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return null;
    if (typeof navigator !== "undefined" && !navigator.onLine) return null;
    if (stateRef.current.denial && !manual) return null;

    clearTimer();
    const issuedAt = Date.now();
    const epoch = epochRef.current;
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), YOUTUBE_ANALYTICS_STATUS_DEADLINE_MS);
    update((current) => ({
      ...current,
      checking: true,
      denial: manual ? null : current.denial,
      statusError: manual ? null : current.statusError,
    }));

    const promise = gateway.status(accountId, controller.signal);
    flightRef.current = { epoch, issuedAt, controller, promise };
    let nextDelay: number | null = null;
    let acceptedRevision: string | null = null;

    try {
      const response = await promise;
      if (epochRef.current !== epoch || flightRef.current?.promise !== promise) return null;
      const status = response.data;
      const previousRevision = stateRef.current.lastRevision;
      const revisionChanged = previousRevision !== null && previousRevision !== status.connection_revision;
      if (revisionChanged) {
        purgeAccountReports(queryClient, userId, accountId, previousRevision);
        epochRef.current += 1;
      }
      failuresRef.current = 0;
      update((current) => ({
        ...current,
        status,
        pinnedWindowEnd: current.pinnedWindowEnd === null || advanceWindow || revisionChanged
          ? status.reporting_end_date
          : current.pinnedWindowEnd,
        lastRevision: status.connection_revision,
        leaseStartedAt: issuedAt,
        denial: null,
        latch: current.latch?.revision === status.connection_revision ? current.latch : null,
        statusError: null,
        checking: false,
      }));
      setNow(Date.now());
      nextDelay = YOUTUBE_ANALYTICS_STATUS_POLL_MS;
      acceptedRevision = status.connection_revision;
      return status;
    } catch (thrown) {
      if (epochRef.current !== epoch || flightRef.current?.promise !== promise) return null;
      const error = asYouTubeAnalyticsClientError(thrown);
      if (isAccountScopedError(error.code)) {
        bumpEpoch();
        purgeAccountReports(queryClient, userId, accountId);
        update((current) => ({
          ...current,
          status: null,
          leaseStartedAt: null,
          denial: error,
          statusError: null,
          checking: false,
        }));
      } else {
        failuresRef.current += 1;
        const backoff = STATUS_BACKOFF_MS[Math.min(failuresRef.current - 1, STATUS_BACKOFF_MS.length - 1)];
        nextDelay = Math.max(backoff, (error.retryAfterSeconds ?? 0) * 1000);
        update((current) => ({ ...current, statusError: error, checking: false }));
      }
      return null;
    } finally {
      clearTimeout(deadline);
      if (flightRef.current?.promise === promise) flightRef.current = null;
      if (nextDelay !== null
        && (acceptedRevision === null
          ? epochRef.current === epoch
          : stateRef.current.status?.connection_revision === acceptedRevision)
        && !stateRef.current.denial) {
        clearTimer();
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          void issueStatus();
        }, nextDelay);
      }
    }
  }, [accountId, bumpEpoch, clearTimer, gateway, queryClient, update, userId]);

  useEffect(() => {
    mountedRef.current = true;
    const previous = previousIdentityRef.current;
    if (previous?.accountId && (previous.userId !== userId || previous.accountId !== accountId)) {
      queryClient.removeQueries({
        predicate: (query) => isAccountAnalyticsQueryKey(query.queryKey, previous.userId, previous.accountId!),
      });
    }
    previousIdentityRef.current = { userId, accountId };
    bumpEpoch();
    clearTimer();
    failuresRef.current = 0;
    update(() => initialState(identity));
    setNow(Date.now());
    void issueStatus();
    return () => {
      clearTimer();
      bumpEpoch();
    };
  }, [accountId, bumpEpoch, clearTimer, identity, issueStatus, queryClient, update, userId]);

  useEffect(() => () => {
    mountedRef.current = false;
    clearTimer();
    bumpEpoch();
  }, [bumpEpoch, clearTimer]);

  useEffect(() => {
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, []);

  useEffect(() => {
    const suspend = () => {
      bumpEpoch();
      clearTimer();
      update((current) => ({ ...current, status: null, leaseStartedAt: null, statusError: null, checking: false }));
      setNow(Date.now());
    };
    const resume = () => {
      if (document.visibilityState === "visible" && navigator.onLine) void issueStatus();
    };
    const visibility = () => {
      if (document.visibilityState === "hidden") suspend();
      else resume();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("offline", suspend);
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("offline", suspend);
      window.removeEventListener("online", resume);
      window.removeEventListener("focus", resume);
    };
  }, [bumpEpoch, clearTimer, issueStatus, update]);

  const reportDataError = useCallback((thrown: unknown) => {
    if (!accountId) return;
    const error = asYouTubeAnalyticsClientError(thrown);
    if (!isAccountScopedError(error.code)) return;
    bumpEpoch();
    purgeAccountReports(queryClient, userId, accountId);
    setNow(Date.now());
    if (isLatchableProviderRefusal(error)) {
      const revision = error.connectionRevision ?? stateRef.current.lastRevision ?? stateRef.current.status?.connection_revision;
      if (!revision) return;
      update((current) => ({
        ...current,
        latch: { revision, error },
        statusError: null,
        checking: false,
      }));
      clearTimer();
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void issueStatus();
      }, YOUTUBE_ANALYTICS_STATUS_POLL_MS);
      return;
    }
    clearTimer();
    update((current) => ({
      ...current,
      status: null,
      leaseStartedAt: null,
      denial: error.connectionRevision
        ? error
        : new YouTubeAnalyticsClientError(error.code, {
          requestId: error.requestId,
          scope: error.scope,
          retryAfterSeconds: error.retryAfterSeconds,
          connectionRevision: current.lastRevision,
          reportingEndDate: error.reportingEndDate,
          acceptedWindowEnds: error.acceptedWindowEnds,
          consent: error.consent,
          purposeVersion: error.purposeVersion,
          detail: error.detail,
        }),
      statusError: null,
      checking: false,
    }));
  }, [accountId, bumpEpoch, clearTimer, issueStatus, queryClient, update, userId]);

  const clearLatchForRetry = useCallback(() => {
    update((current) => ({ ...current, latch: null }));
  }, [update]);

  const advancePinnedWindow = useCallback(() => {
    update((current) => ({
      ...current,
      pinnedWindowEnd: current.status?.reporting_end_date ?? current.pinnedWindowEnd,
    }));
  }, [update]);

  const markWithdrawn = useCallback(() => {
    if (!accountId) return;
    const revision = stateRef.current.lastRevision ?? stateRef.current.status?.connection_revision ?? null;
    bumpEpoch();
    clearTimer();
    purgeAccountReports(queryClient, userId, accountId);
    update((current) => ({
      ...current,
      status: null,
      leaseStartedAt: null,
      latch: null,
      denial: new YouTubeAnalyticsClientError("consent_required", {
        connectionRevision: revision,
        consent: { state: "withdrawn", version: current.status?.purpose_version ?? 1 },
        purposeVersion: current.status?.purpose_version ?? 1,
      }),
      statusError: null,
      checking: false,
    }));
  }, [accountId, bumpEpoch, clearTimer, queryClient, update, userId]);

  const current = state.identity === identity ? state : initialState(identity);
  const status = current.status;
  const latch = current.latch;
  const leaseValid = current.leaseStartedAt !== null
    && now - current.leaseStartedAt >= 0
    && now - current.leaseStartedAt < YOUTUBE_ANALYTICS_LEASE_MS;

  return {
    status,
    connectionRevision: status?.connection_revision ?? current.lastRevision ?? null,
    windowEnd: current.pinnedWindowEnd ?? status?.reporting_end_date ?? null,
    mayFetch: Boolean(accountId && userId && status && !current.denial && !latch),
    mayShow: Boolean(status && leaseValid && !current.denial && !latch),
    checkingAccess: current.checking || (!current.denial && !latch && !leaseValid),
    denial: current.denial,
    latchedError: latch?.error ?? null,
    statusError: current.statusError,
    refreshStatus: (options) => issueStatus(true, options?.advanceWindow === true),
    advancePinnedWindow,
    reportDataError,
    clearLatchForRetry,
    markWithdrawn,
  };
}
