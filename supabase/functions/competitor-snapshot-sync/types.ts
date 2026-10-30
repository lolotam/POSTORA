/**
 * The provider-neutral contracts of the competitor collector.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The vocabulary every other module of `competitor-snapshot-sync` speaks:
 *   what a capture is, what a provider failure is, what the store can do and
 *   what the worker needs in order to orchestrate a collection.
 *
 * WHY THE CONTRACTS ARE HERE AND NOT IN THE PROVIDERS
 *
 *   A provider is an adapter. The Graph adapter and the (deferred) Apify
 *   adapter both produce a `CompetitorCapture` and both fail with a
 *   `CompetitorProviderError`. The worker must not know which one it is
 *   talking to, and the store must not know what a provider returns. Keeping
 *   the vocabulary here is what lets the worker stay provider-neutral and
 *   lets the SQL contract stay provider-neutral.
 *
 * WHY NULL MEANS UNAVAILABLE
 *
 *   Every count is `number | null`. A missing count is unknown, not zero.
 *   The provider maps a hidden or negative value onto `null` BEFORE the
 *   value reaches the database, because the database refuses a negative
 *   count and a zero would be a lie about the target.
 *
 * WHY A CAPTURE CARRIES ITS SOURCE
 *
 *   The source is decided by the adapter, not by the caller, so a capture
 *   can never be filed under a source it did not come from. The database
 *   accepts exactly two sources and derives nothing.
 */

/** Where a capture came from. The database accepts exactly these two. */
export type CompetitorSource = "official" | "apify";

/** The terminal shape of one collection attempt. */
export type CompetitorOutcome = "completed" | "unavailable" | "retry";

/**
 * The stable reason codes.
 *
 * They are lower-case snake_case because the database validates them as
 * such. They carry no provider text: the raw provider message never becomes
 * a reason code, a stored `last_error`, a log line or a client response.
 */
export type CompetitorReasonCode =
  /** The confirmed-inaccessible-target outcome. It is the ONLY outcome that
   *  sets the weekly retry gate. */
  | "target_unavailable"
  /** No owned, active, page-linked viewer with a read-ok insights scope. */
  | "viewer_unavailable"
  /** A paid fallback would be needed and paid work is not authorised. */
  | "apify_disabled"
  /** The provider rejected the credential (Meta code 190). */
  | "token_invalid"
  /** The provider refused the permission (Meta codes 10 and 200). */
  | "scope_missing"
  /** The provider is rate limiting, or the usage budget is nearly spent. */
  | "rate_limited"
  /** The provider failed in a way that is worth retrying. */
  | "provider_error"
  /** The credential or the captured context changed under the attempt. */
  | "credential_changed"
  /** The result could not be stored. Nothing was written. */
  | "storage_error"
  /** A step did not finish inside the run budget. Worker-only; never stored. */
  | "deadline_exceeded";

/** The public counts of one profile observation. */
export interface CompetitorProfileObservation {
  readonly followers_count: number | null;
  readonly media_count: number | null;
}

/** One captured media row. */
export interface CompetitorMediaItem {
  readonly ig_media_id: string;
  /** FEED | REELS | STORY | AD, or null when the provider did not say. */
  readonly media_product_type: string | null;
  /** IMAGE | VIDEO | CAROUSEL_ALBUM, or null when the provider did not say. */
  readonly media_type: string | null;
  readonly thumbnail_url: string | null;
  readonly caption: string | null;
  readonly permalink: string | null;
  /** The publication instant. It is never "now". */
  readonly published_at: string;
  readonly like_count: number | null;
  readonly comments_count: number | null;
  readonly view_count: number | null;
}

/**
 * Why a capture stopped short of the target's whole feed.
 *
 * The set is CLOSED and lower-case snake_case, because the database
 * validates it against the same list. A free-text reason would eventually
 * carry provider text, and a provider text is not a reason code.
 */
export type CompetitorCoverageGapReason =
  /** The thirty row media window was reached. */
  | "media_cap_reached"
  /** The page budget of one capture was reached. */
  | "page_cap_reached"
  /** The provider offered a next page whose cursor cannot be sent. */
  | "cursor_unusable"
  /** The provider offered the same cursor twice. */
  | "cursor_loop"
  /** The feed returned the same media id twice. */
  | "duplicate_media"
  /** The provider usage budget stopped the walk. */
  | "usage_budget_stop";

/**
 * What ONE capture actually saw of the target's feed.
 *
 * WHY THIS IS EVIDENCE AND NOT A VERDICT
 *
 *   A successful capture is not evidence of a complete weekly inventory.
 *   These fields are the raw facts a provider observed while walking the
 *   feed, and the report decides what they mean. The database stores them;
 *   it does not read a conclusion into them.
 *
 * WHY ORDERING IS A SEPARATE FLAG
 *
 *   `orderingVerified` says the provider's row order is a tested,
 *   version-compatible contract. It is FALSE until such a contract
 *   exists. Sorting the array we received does not prove the provider
 *   orders its feed chronologically, so nothing in this repository may
 *   claim otherwise.
 *
 * WHY exhausted AND truncated ARE SEPARATE
 *
 *   `exhausted` is "the walk reached the end of the feed". `truncated` is
 *   "the media window was capped". A capture can be truncated and not
 *   exhausted (the cap stopped it) and it can be exhausted and not
 *   truncated (the feed ended on its own).
 */
export interface CompetitorCaptureCoverage {
  /** When the capture started. */
  readonly captureStartedAt: string;
  /** When the capture ended. Never before the start. */
  readonly captureEndedAt: string;
  /**
   * The oldest publication instant the capture actually returned, or null
   * for a genuinely empty feed. It is never a substitute instant.
   */
  readonly oldestReturnedAt: string | null;
  /** Whether the provider's row order is a verified contract. */
  readonly orderingVerified: boolean;
  /**
   * Whether there was MORE to fetch: the provider offered a next page in
   * its last response. Null when the provider has no such notion.
   */
  readonly cursorPresent: boolean | null;
  /** Whether the walk reached the end of the feed. */
  readonly exhausted: boolean;
  /** Whether the media window was capped. */
  readonly truncated: boolean;
  /** Why the walk stopped early, or null when it did not. */
  readonly gapReason: CompetitorCoverageGapReason | null;
}

/** One complete capture of a tracked competitor. */
export interface CompetitorCapture {
  readonly source: CompetitorSource;
  readonly profile: CompetitorProfileObservation;
  readonly media: readonly CompetitorMediaItem[];
  /**
   * True when the provider's media window was capped, so the capture is a
   * partial view of the target's feed and must not be read as "the target
   * has exactly this many posts".
   */
  readonly truncated: boolean;
  /**
   * The evidence this capture produced about the target's feed.
   *
   * It travels with the capture because only the provider knows what it
   * observed. The worker never infers it and the browser never sees it.
   */
  readonly coverage: CompetitorCaptureCoverage;
}

/**
 * The oldest publication instant among the returned rows.
 *
 * It is the MINIMUM and not the last row's instant: a provider's order is
 * not a verified contract, so the last row is no evidence of the oldest
 * one. A genuinely empty feed has no oldest instant, and that is null
 * rather than a substitute.
 *
 * Both adapters use it, so it lives here rather than in either of them.
 */
export function oldestPublishedAt(
  media: readonly { readonly published_at: string }[],
): string | null {
  let oldest: string | null = null;
  let oldestInstant = Number.POSITIVE_INFINITY;

  for (const item of media) {
    const instant = Date.parse(item.published_at);
    if (Number.isNaN(instant)) continue;
    if (instant < oldestInstant) {
      oldestInstant = instant;
      oldest = item.published_at;
    }
  }

  return oldest;
}

/** The failure kinds a provider adapter may report. */
export type CompetitorProviderFailureKind =
  /** The provider says, unambiguously, that the target cannot be analysed. */
  | "target_unavailable"
  /** The credential was rejected. */
  | "token_invalid"
  /** The permission was refused. */
  | "scope_missing"
  /** The provider is throttling, or the usage budget is nearly spent. */
  | "rate_limited"
  /** Anything else that is worth retrying. */
  | "provider_error";

/**
 * A provider failure.
 *
 * The message is a STABLE string. The raw provider text is never copied
 * onto it, never attached as a cause and never returned to a client: a
 * provider message can quote a token, an account id or an internal URL.
 */
export class CompetitorProviderError extends Error {
  readonly kind: CompetitorProviderFailureKind;
  /** The highest usage percentage the provider reported, 0-100. */
  readonly usagePercent: number;
  /** When the provider asked us to stop, if it said so. */
  readonly throttledUntil: Date | null;
  /**
   * Whether repeating the SAME request could plausibly succeed.
   *
   * Only a transport failure and a 5xx are retryable. A rejected
   * credential, a refused permission, a malformed response and a throttle
   * are not: repeating them spends the budget and, in the case of a
   * throttle, deepens the throttle.
   */
  readonly retryable: boolean;

  constructor(
    kind: CompetitorProviderFailureKind,
    message: string,
    options: {
      readonly usagePercent?: number;
      readonly throttledUntil?: Date | null;
      readonly retryable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = "CompetitorProviderError";
    this.kind = kind;
    this.usagePercent = options.usagePercent ?? 0;
    this.throttledUntil = options.throttledUntil ?? null;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * The result of one provider capture.
 *
 * The usage percentage is reported even when the capture failed, because
 * the caller has to persist the shared bucket state after EVERY provider
 * response.
 */
export interface CompetitorProviderResult {
  readonly capture: CompetitorCapture;
  /** The highest usage percentage the provider reported, 0-100. */
  readonly usagePercent: number;
  /** When the provider asked us to stop, if it said so. */
  readonly throttledUntil: Date | null;
}

/** What a provider adapter is asked to do. */
export interface CompetitorProviderRequest {
  /** The normalised target handle. */
  readonly username: string;
  /** The Instagram user id of the viewer that performs the discovery. */
  readonly viewerIgUserId: string;
  /** The protected Facebook User token. Never logged, never serialised. */
  readonly token: string;
  readonly signal: AbortSignal;
}

/** The provider port. Both adapters implement it. */
export interface CompetitorProvider {
  readonly source: CompetitorSource;
  fetch(request: CompetitorProviderRequest): Promise<CompetitorProviderResult>;
}

/**
 * The outcome of a paid capture.
 *
 * `indeterminate` is its own state and it matters: a paid actor start that
 * was sent but whose response was lost may or may not have started a run.
 * The answer is unknown, so the collection records that and stops. It never
 * starts a second run, because a second run is a second bill.
 */
export type PaidCaptureOutcome =
  | { readonly status: "completed"; readonly capture: CompetitorCapture }
  | { readonly status: "indeterminate"; readonly reason: CompetitorReasonCode }
  | { readonly status: "failed"; readonly reason: CompetitorReasonCode };

/** The paid provider port. */
export interface PaidCaptureProvider {
  readonly source: CompetitorSource;
  /**
   * The paid provider holds its own credential.
   *
   * The paid adapter is configured server-side with its API token, so the
   * caller never carries it and it never reaches a request payload.
   */
  capture(request: {
    readonly username: string;
    readonly signal: AbortSignal;
  }): Promise<PaidCaptureOutcome>;
}

/**
 * The paid fallback policy.
 *
 * Scheduled paid work is DEFERRED (plan decision P5). The policy is
 * therefore INJECTED, never read from a setting, and the shipped
 * composition injects a disabled policy. Nothing in this module can turn
 * paid work on.
 */
export interface PaidFallbackPolicy {
  /** Whether a paid fallback is authorised at all. */
  readonly enabled: boolean;
  /** The bounded paid adapter, present only when it is authorised. */
  readonly provider?: PaidCaptureProvider;
  /** The stable reason recorded when the fallback is not authorised. */
  readonly refusalReason: CompetitorReasonCode;
}

/** A claimed competitor job. */
export interface ClaimedCompetitorJob {
  readonly jobId: string;
  readonly userId: string;
  readonly watchlistId: string;
  readonly capturedOn: string;
  readonly jobGeneration: number;
  readonly claimToken: string;
  readonly leaseExpiresAt: string;
  readonly attempts: number;
}

/** The context the database captured when the viewer was attached. */
export interface AttachedViewerContext {
  readonly viewerSocialAccountId: string;
  readonly credentialGeneration: number;
  readonly loginKind: string;
}

/** The result of persisting one collection attempt. */
export interface PersistResultReceipt {
  readonly outcome: CompetitorOutcome;
  readonly source: CompetitorSource | null;
  readonly reasonCode: CompetitorReasonCode | null;
  readonly written: number;
  readonly mediaCount: number;
  readonly capturedAt: string | null;
  /**
   * The coverage the database STORED, or null for a failed attempt.
   *
   * It is the read-back of the row, not the submission: a receipt that
   * disagrees with the stored evidence is not evidence that the write
   * happened as asked.
   */
  readonly coverage: PersistedCompetitorCoverage | null;
}

/**
 * The coverage row the database stored.
 *
 * It is the table's own columns plus the one derived verdict the report
 * needs: `inventoryComplete` is "the walk reached the end of the feed and
 * nothing was capped". The VERIFIED ORDER is deliberately not part of it:
 * a complete set of posts with an unverified order is still a complete set
 * of posts.
 */
export interface PersistedCompetitorCoverage {
  readonly watchlistId: string;
  readonly userId: string;
  readonly capturedOn: string;
  readonly capturedAt: string;
  readonly source: CompetitorSource;
  readonly jobGeneration: number;
  readonly captureStartedAt: string;
  readonly captureEndedAt: string;
  readonly oldestReturnedAt: string | null;
  readonly orderingVerified: boolean;
  readonly cursorPresent: boolean | null;
  readonly exhausted: boolean;
  readonly truncated: boolean;
  readonly gapReason: CompetitorCoverageGapReason | null;
  readonly inventoryComplete: boolean;
}

/** The owner-facing enqueue receipt. */
export interface EnqueueReceipt {
  readonly accepted: boolean;
  readonly reason: string;
  readonly jobId: string | null;
  readonly jobGeneration: number | null;
  readonly status: string | null;
  readonly capturedOn: string | null;
  readonly retryAfterSeconds: number | null;
}

/** The owner-facing status projection. */
export interface OwnerStatusProjection {
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
}

/** One due watchlist entry. */
export interface DueCompetitorTarget {
  readonly userId: string;
  readonly watchlistId: string;
  readonly username: string;
  readonly dueAt: string;
}

/** The page cursor of the due-target read. */
export interface DueTargetCursor {
  readonly dueAt: string;
  readonly id: string;
}

/** The resolved protected credential of the chosen viewer. */
export interface ResolvedViewerCredential {
  readonly token: string;
  readonly credentialId: string;
  /** The credential generation the database reported with the token. */
  readonly capabilityGeneration: number;
}

/** The shared provider throttle bucket. */
export interface ThrottleBucketState {
  readonly usagePercent: number | null;
  readonly throttledUntil: string | null;
}

/**
 * The coverage evidence as the database expects it.
 *
 * It is the WIRE shape: the field names are the ones the SQL function
 * declares. The camelCase contract above is the provider-neutral one; this
 * one exists only at the database boundary.
 */
export interface CompetitorCoveragePayload {
  readonly capture_started_at: string;
  readonly capture_ended_at: string;
  readonly oldest_returned_at: string | null;
  readonly ordering_verified: boolean;
  readonly cursor_present: boolean | null;
  readonly exhausted: boolean;
  readonly truncated: boolean;
  readonly gap_reason: CompetitorCoverageGapReason | null;
}

/** The payload of one collection attempt, as the database expects it. */
export interface CompetitorResultPayload {
  readonly outcome: CompetitorOutcome;
  readonly source?: CompetitorSource;
  readonly reason_code?: CompetitorReasonCode;
  readonly error_message?: string;
  readonly profile?: {
    readonly metrics: {
      readonly followers_count?: number | null;
      readonly media_count?: number | null;
    };
  };
  readonly media?: readonly {
    readonly ig_media_id: string;
    readonly media_product_type?: string | null;
    readonly media_type?: string | null;
    readonly thumbnail_url?: string | null;
    readonly caption?: string | null;
    readonly permalink?: string | null;
    readonly published_at: string;
    readonly metrics: {
      readonly like_count?: number | null;
      readonly comments_count?: number | null;
      readonly view_count?: number | null;
    };
  }[];
  /**
   * The coverage evidence.
   *
   * It is REQUIRED for a successful v2 write and FORBIDDEN on a failure:
   * a failed attempt observed no inventory, and a coverage row for it would
   * claim a walk that never happened.
   */
  readonly coverage?: CompetitorCoveragePayload;
}

/** The outcome of one processed job. */
export interface ProcessedCompetitorJob {
  readonly jobId: string;
  readonly watchlistId: string;
  readonly username: string;
  /**
   * `abandoned` means no outcome was stored: the job was left to its lease
   * because a step failed or ran out of budget. It is not a recovery.
   */
  readonly outcome: CompetitorOutcome | "abandoned";
  readonly source: CompetitorSource | null;
  readonly reasonCode: CompetitorReasonCode | null;
  readonly mediaCount: number;
}

/** The summary of one drain run. */
export interface CompetitorDrainSummary {
  readonly claimed: number;
  readonly processed: number;
  readonly completed: number;
  readonly unavailable: number;
  readonly retried: number;
  /** Jobs left to their lease with no stored outcome. */
  readonly abandoned: number;
  readonly stoppedEarly: boolean;
  readonly jobs: readonly ProcessedCompetitorJob[];
}
