/**
 * The port of the competitor tracking feature.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The ONE interface the application layer talks to. It is implemented
 *   by the infrastructure adapter and faked in the tests. It carries no
 *   Supabase, no HTTP and no DTO parsing: the wire names live in the
 *   adapter, and only there (ARCHITECTURE §4, §22).
 *
 * THE CONTRACT IN ONE PARAGRAPH
 *
 *   A gateway reads the owner's tracked competitors (`list`, `detail`),
 *   the owner's quota (`quota`) and the collection state of one entry
 *   (`status`); it mutates the owner's list through the owner RPCs
 *   (`add`, `setActive`); and it asks the collector to work on one entry
 *   (`enqueue`). Every read is abortable. A mutation is NOT abortable on
 *   purpose: a half-cancelled write is an indeterminate write, and the
 *   feature would rather wait for the truth than invent it.
 */

import type {
  CompetitorReportDetail,
  CompetitorReportList,
  CompetitorReportQuota,
} from "../domain/contracts";

/** The abort handle of a read. */
export type CompetitorReadOptions = {
  readonly signal?: AbortSignal;
};

/** The active or removed list the owner asked for. */
export type CompetitorListRequest = {
  readonly state: "active" | "removed";
  readonly limit?: number;
  readonly cursor?: string | null;
};

/** One entry, over one period. */
export type CompetitorDetailRequest = {
  readonly watchlistId: string;
  readonly periodDays: 7 | 30;
  readonly limit?: number;
  readonly cursor?: string | null;
};

/** The owner asks for one entry's collection state. */
export type CompetitorStatusRequest = {
  readonly watchlistId: string;
};

/** The owner asks for a handle to be tracked. */
export type CompetitorAddInput = {
  readonly username: string;
  readonly label?: string | null;
};

/**
 * The reply of the owner add RPC.
 *
 * `quota` is null on an ALREADY-TRACKED reply, and that is not a defect:
 * the database deliberately omits the quota there because no slot was
 * consumed. The application must not treat a missing quota as a failure.
 */
export type CompetitorAddResult = {
  readonly watchlistId: string;
  readonly username: string;
  readonly isActive: boolean;
  readonly status: string;
  readonly reactivated: boolean;
  readonly alreadyTracked: boolean;
  readonly quota: CompetitorReportQuota | null;
};

/** The owner activates or removes one entry. */
export type CompetitorSetActiveInput = {
  readonly watchlistId: string;
  readonly isActive: boolean;
  readonly label?: string | null;
};

/** The reply of the owner update RPC. */
export type CompetitorSetActiveResult = {
  readonly watchlistId: string;
  readonly username: string;
  readonly label: string | null;
  readonly isActive: boolean;
  readonly removedAt: string | null;
  readonly status: string;
  readonly quota: CompetitorReportQuota | null;
};

/** The owner asks the collector to work on one entry. */
export type CompetitorEnqueueInput = {
  readonly watchlistId: string;
  /** `true` is the explicit "Retry collection" gesture, never the default. */
  readonly force: boolean;
};

/**
 * The reply of the collection endpoint.
 *
 * An accepted enqueue means QUEUED. It does not mean the snapshot was
 * collected, and it never means the collection succeeded.
 *
 * The discriminant is a STRING, not a boolean: this repository compiles
 * with `strictNullChecks: false`, and TypeScript does not narrow a
 * union on a boolean literal in that mode.
 */
export type CompetitorEnqueueResult =
  | {
      readonly outcome: "accepted";
      readonly reason: string;
      readonly jobId: string | null;
      readonly jobGeneration: number | null;
      readonly status: string | null;
      readonly capturedOn: string | null;
    }
  | {
      readonly outcome: "deferred";
      readonly reason: string;
      readonly retryAfterSeconds: number;
      readonly capturedOn: string | null;
    };

/**
 * The collection state of one entry.
 *
 * `status` is `"none"` when there is no job at all. That is a FACT about
 * the data, not a failed read: a failed read is an error, never a
 * "no job" answer.
 */
export type CompetitorCollectionStatus = {
  readonly targetKind: string;
  readonly targetId: string;
  readonly capturedOn: string;
  readonly status: string;
  readonly jobGeneration: number;
  readonly attempts: number;
  readonly dueAt: string | null;
  readonly nextRetryAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastSuccessAt: string | null;
  readonly reasonCode: string | null;
  readonly pendingOperations: number;
};

/**
 * The one interface the competitor tracking application layer uses.
 */
export interface CompetitorTrackingGateway {
  /** The owner's tracked competitors, active or removed. */
  list(
    request: CompetitorListRequest,
    options?: CompetitorReadOptions,
  ): Promise<CompetitorReportList>;

  /** One tracked competitor, over one period, with its media. */
  detail(
    request: CompetitorDetailRequest,
    options?: CompetitorReadOptions,
  ): Promise<CompetitorReportDetail>;

  /** The owner's own entitlement and usage. */
  quota(options?: CompetitorReadOptions): Promise<CompetitorReportQuota>;

  /** The collection state of one tracked competitor. */
  status(
    request: CompetitorStatusRequest,
    options?: CompetitorReadOptions,
  ): Promise<CompetitorCollectionStatus>;

  /**
   * Tracks a handle.
   *
   * An already-active handle is returned as `alreadyTracked` without a
   * new slot and without a status reset.
   */
  add(input: CompetitorAddInput): Promise<CompetitorAddResult>;

  /**
   * Activates or removes one entry.
   *
   * A removal is SOFT: the history outlives it. A null label preserves
   * the stored label - this feature has no convention for clearing one.
   */
  setActive(input: CompetitorSetActiveInput): Promise<CompetitorSetActiveResult>;

  /** Asks the collector to work on one entry. */
  enqueue(input: CompetitorEnqueueInput): Promise<CompetitorEnqueueResult>;
}
