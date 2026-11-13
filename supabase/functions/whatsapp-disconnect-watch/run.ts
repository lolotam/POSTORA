// The pure state machine of the WhatsApp disconnect watcher. Everything the watcher decides
// lives here so it can be tested without Evolution, without Postgres and without a network.

import type { AlertDispatchResult } from "./dispatch.ts";

export type ConnectionClass = "healthy" | "transient" | "terminal" | "unknown";

/** How long a terminal state must persist before the account is alerted. */
export const DISCONNECT_GRACE_MINUTES = 10;
/** How long an episode may last, flapping or not, before the account is alerted. */
export const DISCONNECT_BACKSTOP_MINUTES = 60;
/** How many accounts one run polls. */
export const MAX_ACCOUNTS_PER_RUN = 50;
/** How often the cron polls. */
export const POLL_CRON_INTERVAL_MINUTES = 5;
/**
 * A candidate polled less than this many minutes ago is skipped: it was just checked.
 *
 * The window is deliberately SHORTER than the cron interval. `last_polled_at` is written
 * after the Evolution call, so on the next tick the row's age is a little under five
 * minutes -- a cutoff of exactly five minutes would skip that account and halve the
 * polling cadence to ten minutes. The margin keeps every account polled on every tick.
 */
export const POLL_FRESHNESS_MINUTES = POLL_CRON_INTERVAL_MINUTES - 1;
/**
 * How long one run may take. The candidates that are left over are not polled, so the next
 * run picks them up: a run that overruns its budget must not be cut off mid-account, and it
 * must not be allowed to run until the platform kills it either.
 */
export const RUN_BUDGET_MS = 50_000;
/** The message the dashboard banner shows under the headline. No phone number, ever. */
export const DISCONNECT_REASON = "WhatsApp session disconnected. Scan a new QR code to reconnect.";

export interface Episode {
  /** Identifies this episode: the claim returns it and the email's idempotency key uses it. */
  episode_id: string;
  /**
   * Start of the current continuous TERMINAL streak, or null when there is no terminal
   * streak: a transient observation clears it, and a terminal observation that follows a
   * transient starts a new one. A null `since` means the ten minute grace window has not
   * started yet -- only the backstop can fire.
   */
  since: string | null;
  first_seen: string;
  state: string;
  observed_at: string;
}

export interface WatchCandidate {
  id: string;
  instance_name: string;
  /**
   * Whether the account row is still active. A `close` webhook deactivates it, and an
   * inactive account is the one the dashboard banner asks the owner to reconnect.
   */
  is_active: boolean;
}

/**
 * open is healthy, connecting is the transient flap Baileys emits during a normal reconnect,
 * and everything else is terminal: the session is gone and the phone must scan a new QR code.
 * An unknown (empty) state is neither: an unverifiable state is not evidence, so the caller
 * skips the account entirely rather than alerting or clearing on it.
 */
export function classifyState(state: string | null): ConnectionClass {
  const normalized = (state ?? "").trim().toLowerCase();
  if (!normalized) return "unknown";
  if (normalized === "open") return "healthy";
  if (normalized === "connecting") return "transient";
  return "terminal";
}

/**
 * Whether the row was polled inside the freshness window, and must therefore not be polled
 * again in this run.
 *
 * An unreadable poll time is treated as never polled: the account is checked. A row that was
 * never polled has no timestamp at all.
 */
export function isPollFresh(lastPolledAt: string | null, now: Date): boolean {
  if (lastPolledAt === null) return false;
  const polledAt = Date.parse(lastPolledAt);
  if (!Number.isFinite(polledAt)) return false;
  return now.getTime() - polledAt < POLL_FRESHNESS_MINUTES * 60_000;
}

/**
 * The alert fires when the terminal state has persisted for the grace window, or when the
 * episode has lasted the backstop window however much it flapped.
 *
 * An episode without a terminal streak (`since` is null) has no grace window to count: only
 * the backstop can fire for it. That is what keeps a transient-only episode -- an account
 * stuck in `connecting` -- from alerting on the ten minute rule.
 */
export function isAlertDue(episode: Episode, now: Date): boolean {
  const firstSeen = Date.parse(episode.first_seen);
  if (!Number.isFinite(firstSeen)) return false;
  const since = episode.since === null ? Number.NaN : Date.parse(episode.since);
  const nowMs = now.getTime();
  const continuous = Number.isFinite(since) &&
    nowMs - since >= DISCONNECT_GRACE_MINUTES * 60_000;
  const backstop = nowMs - firstSeen >= DISCONNECT_BACKSTOP_MINUTES * 60_000;
  return continuous || backstop;
}

export interface WatchDeps {
  listCandidates(limit: number): Promise<WatchCandidate[]>;
  /** The live Evolution state, or null when Evolution cannot answer. */
  readState(instanceName: string): Promise<string | null>;
  observe(accountId: string, state: string, terminal: boolean): Promise<Episode | null>;
  clear(accountId: string): Promise<void>;
  /**
   * Reactivates an account the watcher itself deactivated, when the poll found it healthy
   * again. False means "not ours to restore": the account was not deactivated by this
   * watcher, or the owner disconnected it on purpose. The decision is made in SQL, under
   * the row lock, so the watcher only asks.
   */
  restore(accountId: string): Promise<boolean>;
  /**
   * Flags the account for reconnect, but only while `episodeId` is still its open episode.
   * False means the owner reconnected or disconnected on purpose since the observation, and
   * the watcher then sends no alert.
   */
  markFlagged(accountId: string, episodeId: string, reason: string): Promise<boolean>;
  dispatchAlert(accountId: string): Promise<AlertDispatchResult>;
  markPolled(instanceName: string, at: Date): Promise<void>;
  /** A monotonic clock, used only for the run deadline. */
  monotonicNow(): number;
  now(): Date;
}

export interface WatchSummary {
  polled: number;
  skipped: number;
  episodes: number;
  flagged: number;
  alerted: number;
  failed: string[];
  /** The candidates this run did not reach because it ran out of time. */
  deferred: number;
}

/** What one account did in this run. */
interface AccountOutcome {
  skipped: number;
  episodes: number;
  flagged: number;
  alerted: number;
  failed: boolean;
}

type StateRead = { kind: "read"; state: string | null } | { kind: "failed" };

/**
 * The live state of one account, and the poll time that proves we looked. A read that throws
 * is a failed account, never a state: an unreachable Evolution is not evidence.
 */
async function readStateFor(deps: WatchDeps, candidate: WatchCandidate): Promise<StateRead> {
  try {
    const state = await deps.readState(candidate.instance_name);
    await deps.markPolled(candidate.instance_name, deps.now());
    return { kind: "read", state };
  } catch {
    // One broken account must never stop the others. The account id identifies the row.
    console.error(`[whatsapp-disconnect-watch] account ${candidate.id}: state read failed`);
    return { kind: "failed" };
  }
}

/** Applies one observed state to one account. */
async function applyAccountState(
  deps: WatchDeps,
  candidate: WatchCandidate,
  state: string | null,
): Promise<AccountOutcome> {
  const outcome: AccountOutcome = { skipped: 0, episodes: 0, flagged: 0, alerted: 0, failed: false };
  const classification = classifyState(state);

  if (classification === "unknown") {
    // Evolution could not tell us. Never open an episode and never clear one on an
    // unverifiable state.
    outcome.skipped = 1;
    return outcome;
  }

  try {
    if (classification === "healthy") {
      // The episode and the reconnect flag are only cleared for an account that is still
      // active. A `close` webhook deactivates the row, and clearing the flag then would
      // remove `needs_reauth` from an account that is still disconnected: the banner would
      // stop asking for the QR code the owner still needs.
      //
      // An account THIS WATCHER deactivated is the exception: the watcher set the flag
      // because Evolution reported a dead session, and Evolution now reports a live one.
      // The restore is conditional in SQL -- the open episode must be the one the watcher
      // flagged, and the account must carry no deliberate-disconnect marker -- so an
      // account the owner disconnected on purpose, or one that was inactive for another
      // reason, is never resurrected. The RPC decides; the watcher only asks.
      if (candidate.is_active) await deps.clear(candidate.id);
      else await deps.restore(candidate.id);
      return outcome;
    }

    const terminal = classification === "terminal";
    const episode = await deps.observe(candidate.id, state ?? "", terminal);
    if (!episode) return outcome;

    if (terminal) outcome.episodes = 1;
    if (!isAlertDue(episode, deps.now())) return outcome;

    const flagged = await deps.markFlagged(candidate.id, episode.episode_id, DISCONNECT_REASON);
    if (!flagged) return outcome;
    outcome.flagged = 1;

    // The sender answers 200 even when it could not reach a recipient, so the alert is
    // counted only for a mail that really went out, and a recipient the sender could not
    // reach is reported as a failure of this account.
    const dispatch = await deps.dispatchAlert(candidate.id);
    if (dispatch.ownerSent || dispatch.adminSent) outcome.alerted = 1;
    if (dispatch.failed.length > 0) {
      outcome.failed = true;
    }
  } catch {
    console.error(`[whatsapp-disconnect-watch] account ${candidate.id}: handling failed`);
    outcome.failed = true;
  }
  return outcome;
}

export async function runWatch(deps: WatchDeps): Promise<WatchSummary> {
  const summary: WatchSummary = {
    polled: 0,
    skipped: 0,
    episodes: 0,
    flagged: 0,
    alerted: 0,
    failed: [],
    deferred: 0,
  };
  const candidates = await deps.listCandidates(MAX_ACCOUNTS_PER_RUN);
  const startedAt = deps.monotonicNow();

  for (const [index, candidate] of candidates.entries()) {
    if (deps.monotonicNow() - startedAt >= RUN_BUDGET_MS) {
      // The run is out of time. The candidates that were not reached are left untouched:
      // they were not polled, so the next run picks them up.
      summary.deferred = candidates.length - index;
      break;
    }

    const read = await readStateFor(deps, candidate);
    if (read.kind === "failed") {
      summary.failed.push(candidate.id);
      continue;
    }
    summary.polled += 1;

    const outcome = await applyAccountState(deps, candidate, read.state);
    summary.skipped += outcome.skipped;
    summary.episodes += outcome.episodes;
    summary.flagged += outcome.flagged;
    summary.alerted += outcome.alerted;
    if (outcome.failed) summary.failed.push(candidate.id);
  }

  return summary;
}
