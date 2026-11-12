// The pure state machine of the WhatsApp disconnect watcher. Everything the watcher decides
// lives here so it can be tested without Evolution, without Postgres and without a network.

export type ConnectionClass = "healthy" | "transient" | "terminal" | "unknown";

/** How long a terminal state must persist before the account is alerted. */
export const DISCONNECT_GRACE_MINUTES = 10;
/** How long an episode may last, flapping or not, before the account is alerted. */
export const DISCONNECT_BACKSTOP_MINUTES = 60;
/** How many accounts one run polls. */
export const MAX_ACCOUNTS_PER_RUN = 50;
/** The message the dashboard banner shows under the headline. No phone number, ever. */
export const DISCONNECT_REASON = "WhatsApp session disconnected. Scan a new QR code to reconnect.";

export interface Episode {
  since: string;
  first_seen: string;
  state: string;
  observed_at: string;
}

export interface WatchCandidate {
  id: string;
  instance_name: string;
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
 * The alert fires when the terminal state has persisted for the grace window, or when the
 * episode has lasted the backstop window however much it flapped.
 */
export function isAlertDue(episode: Episode, now: Date): boolean {
  const since = Date.parse(episode.since);
  const firstSeen = Date.parse(episode.first_seen);
  if (!Number.isFinite(since) || !Number.isFinite(firstSeen)) return false;
  const nowMs = now.getTime();
  const continuous = nowMs - since >= DISCONNECT_GRACE_MINUTES * 60_000;
  const backstop = nowMs - firstSeen >= DISCONNECT_BACKSTOP_MINUTES * 60_000;
  return continuous || backstop;
}

export interface WatchDeps {
  listCandidates(limit: number): Promise<WatchCandidate[]>;
  /** The live Evolution state, or null when Evolution cannot answer. */
  readState(instanceName: string): Promise<string | null>;
  observe(accountId: string, state: string, terminal: boolean): Promise<Episode | null>;
  clear(accountId: string): Promise<void>;
  markFlagged(accountId: string, reason: string): Promise<void>;
  dispatchAlert(accountId: string): Promise<void>;
  markPolled(instanceName: string, at: Date): Promise<void>;
  now(): Date;
}

export interface WatchSummary {
  polled: number;
  skipped: number;
  episodes: number;
  flagged: number;
  alerted: number;
  failed: string[];
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
      await deps.clear(candidate.id);
      return outcome;
    }

    const terminal = classification === "terminal";
    const episode = await deps.observe(candidate.id, state ?? "", terminal);
    if (!episode) return outcome;

    if (terminal) outcome.episodes = 1;
    if (!isAlertDue(episode, deps.now())) return outcome;

    await deps.markFlagged(candidate.id, DISCONNECT_REASON);
    outcome.flagged = 1;
    await deps.dispatchAlert(candidate.id);
    outcome.alerted = 1;
  } catch {
    console.error(`[whatsapp-disconnect-watch] account ${candidate.id}: handling failed`);
    outcome.failed = true;
  }
  return outcome;
}

export async function runWatch(deps: WatchDeps): Promise<WatchSummary> {
  const summary: WatchSummary = { polled: 0, skipped: 0, episodes: 0, flagged: 0, alerted: 0, failed: [] };
  const candidates = await deps.listCandidates(MAX_ACCOUNTS_PER_RUN);

  for (const candidate of candidates) {
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
