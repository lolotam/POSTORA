import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DISCONNECT_BACKSTOP_MINUTES,
  DISCONNECT_GRACE_MINUTES,
  MAX_ACCOUNTS_PER_RUN,
  RUN_BUDGET_MS,
  classifyState,
  isAlertDue,
  runWatch,
  type Episode,
  type WatchCandidate,
  type WatchDeps,
} from "./run.ts";
import type { AlertDispatchResult } from "./dispatch.ts";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const NOW_DATE = new Date(NOW);

function episode(since: string, firstSeen: string, state = "close"): Episode {
  return { episode_id: "ep-1", since, first_seen: firstSeen, state, observed_at: since };
}

function minutesAgo(minutes: number): string {
  return new Date(NOW - minutes * 60_000).toISOString();
}

function candidate(id: string, isActive = true): WatchCandidate {
  return { id, instance_name: `postora_${id}`, is_active: isActive };
}

interface Recorder {
  calls: string[];
  observeCalls: Array<{ accountId: string; state: string; terminal: boolean }>;
  polled: Array<{ instanceName: string; at: Date }>;
  flaggedEpisodes: string[];
}

interface FakeOptions {
  /** What the sender reports back. */
  dispatch?: AlertDispatchResult;
  /** How much the monotonic clock advances per account read. */
  clockStepMs?: number;
}

/**
 * A recording fake. Everything the watcher decides is observable through the call order and
 * the arguments, so the tests assert behaviour rather than implementation.
 */
function fakeDeps(
  candidates: WatchCandidate[],
  states: Record<string, string | null>,
  observed: Episode | null = episode(minutesAgo(30), minutesAgo(30)),
  failingReads: Set<string> = new Set(),
  episodeStillOpen = true,
  options: FakeOptions = {},
): { deps: WatchDeps; rec: Recorder } {
  const rec: Recorder = { calls: [], observeCalls: [], polled: [], flaggedEpisodes: [] };
  // The run deadline runs on a monotonic clock the fake controls, so a run that overruns
  // its budget can be reproduced without waiting for it.
  let clock = 0;
  const dispatch: AlertDispatchResult = options.dispatch ?? {
    ownerSent: true,
    adminSent: true,
    failed: [],
    skipped: null,
  };

  const deps: WatchDeps = {
    listCandidates: (limit) => {
      rec.calls.push("listCandidates");
      return Promise.resolve(candidates.slice(0, limit));
    },
    readState: (instanceName) => {
      rec.calls.push(`readState:${instanceName}`);
      clock += options.clockStepMs ?? 0;
      if (failingReads.has(instanceName)) return Promise.reject(new Error("evolution down"));
      const account = candidates.find((c) => c.instance_name === instanceName);
      return Promise.resolve(account ? states[account.id] ?? null : null);
    },
    observe: (accountId, state, terminal) => {
      rec.calls.push(`observe:${accountId}`);
      rec.observeCalls.push({ accountId, state, terminal });
      return Promise.resolve(observed);
    },
    clear: (accountId) => {
      rec.calls.push(`clear:${accountId}`);
      return Promise.resolve();
    },
    markFlagged: (accountId, episodeId) => {
      rec.calls.push(`markFlagged:${accountId}`);
      rec.flaggedEpisodes.push(episodeId);
      return Promise.resolve(episodeStillOpen);
    },
    dispatchAlert: (accountId) => {
      rec.calls.push(`dispatchAlert:${accountId}`);
      return Promise.resolve(dispatch);
    },
    markPolled: (instanceName, at) => {
      rec.polled.push({ instanceName, at });
      return Promise.resolve();
    },
    monotonicNow: () => clock,
    now: () => NOW_DATE,
  };
  return { deps, rec };
}

Deno.test("classifyState reads the Evolution connection states", () => {
  assertEquals(classifyState("open"), "healthy");
  assertEquals(classifyState("OPEN"), "healthy");
  assertEquals(classifyState("open "), "healthy");
  assertEquals(classifyState("connecting"), "transient");
  assertEquals(classifyState("close"), "terminal");
  assertEquals(classifyState("timeout"), "terminal");
  assertEquals(classifyState("unpaired"), "terminal");
  assertEquals(classifyState("qr"), "terminal");
});

Deno.test("classifyState treats an unknown future state as terminal, fail-safe", () => {
  assertEquals(classifyState("some-future-state"), "terminal");
});

Deno.test("classifyState treats an empty state as unknown", () => {
  assertEquals(classifyState(null), "unknown");
  assertEquals(classifyState(""), "unknown");
  assertEquals(classifyState("   "), "unknown");
});

Deno.test("isAlertDue waits for the grace window of a continuous terminal streak", () => {
  const nine = episode(minutesAgo(9), minutesAgo(9));
  assertEquals(isAlertDue(nine, NOW_DATE), false);

  const ten = episode(minutesAgo(DISCONNECT_GRACE_MINUTES), minutesAgo(DISCONNECT_GRACE_MINUTES));
  assertEquals(isAlertDue(ten, NOW_DATE), true);
});

Deno.test("isAlertDue fires on the backstop when the streak keeps restarting", () => {
  const flapping = episode(minutesAgo(1), minutesAgo(59));
  assertEquals(isAlertDue(flapping, NOW_DATE), false);

  const long = episode(minutesAgo(1), minutesAgo(DISCONNECT_BACKSTOP_MINUTES));
  assertEquals(isAlertDue(long, NOW_DATE), true);
});

Deno.test("isAlertDue refuses an episode with an unreadable anchor", () => {
  assertEquals(isAlertDue(episode("not-a-date", minutesAgo(30)), NOW_DATE), false);
  assertEquals(isAlertDue(episode(minutesAgo(30), "not-a-date"), NOW_DATE), false);
});

Deno.test("a healthy account is cleared and nothing else happens", async () => {
  const { deps, rec } = fakeDeps([candidate("acc-1")], { "acc-1": "open" });

  const summary = await runWatch(deps);

  assertEquals(rec.calls, ["listCandidates", "readState:postora_acc-1", "clear:acc-1"]);
  assertEquals(summary, {
    polled: 1,
    skipped: 0,
    episodes: 0,
    flagged: 0,
    alerted: 0,
    failed: [],
    deferred: 0,
  });
});

Deno.test("a healthy but inactive account keeps its episode and its reconnect flag", async () => {
  // A `close` webhook set is_active = false, and the owner still has to scan a new QR
  // code. Evolution reporting "open" again must not clear the episode: the clear removes
  // needs_reauth without reactivating the row, so the banner would stop asking for the
  // QR code the owner still needs.
  const { deps, rec } = fakeDeps([candidate("acc-1", false)], { "acc-1": "open" });

  const summary = await runWatch(deps);

  assertEquals(rec.calls.includes("clear:acc-1"), false);
  assertEquals(summary.polled, 1);
  assertEquals(summary.failed, []);
});

Deno.test("a transient account is observed but never flagged or dispatched", async () => {
  // A transient observation restarts the streak, so `since` is now. The episode is still
  // young, so neither window is due and nothing is alerted.
  const { deps, rec } = fakeDeps(
    [candidate("acc-1")],
    { "acc-1": "connecting" },
    episode(minutesAgo(0), minutesAgo(30)),
  );

  const summary = await runWatch(deps);

  assertEquals(rec.observeCalls, [{ accountId: "acc-1", state: "connecting", terminal: false }]);
  assertEquals(rec.calls.includes("markFlagged:acc-1"), false);
  assertEquals(rec.calls.includes("dispatchAlert:acc-1"), false);
  assertEquals(summary.flagged, 0);
  assertEquals(summary.alerted, 0);
});

Deno.test("an episode that keeps flapping still alerts at the backstop", async () => {
  // The streak restarted a moment ago, but the episode itself is an hour old: the backstop
  // is what stops a pathological flap from never alerting.
  const { deps, rec } = fakeDeps(
    [candidate("acc-1")],
    { "acc-1": "connecting" },
    episode(minutesAgo(0), minutesAgo(DISCONNECT_BACKSTOP_MINUTES)),
  );

  const summary = await runWatch(deps);

  assertEquals(rec.calls.includes("markFlagged:acc-1"), true);
  assertEquals(rec.calls.includes("dispatchAlert:acc-1"), true);
  assertEquals(summary.flagged, 1);
  assertEquals(summary.alerted, 1);
});

Deno.test("an episode that closed after the observation is neither flagged nor alerted", async () => {
  // The owner reconnected (or disconnected on purpose) between observe and flag: the
  // conditional flag refuses, so the banner is not re-raised and no email goes out.
  const { deps, rec } = fakeDeps(
    [candidate("acc-1")],
    { "acc-1": "close" },
    episode(minutesAgo(30), minutesAgo(30)),
    new Set(),
    false,
  );

  const summary = await runWatch(deps);

  assertEquals(rec.flaggedEpisodes, ["ep-1"]);
  assertEquals(rec.calls.includes("dispatchAlert:acc-1"), false);
  assertEquals(summary.flagged, 0);
  assertEquals(summary.alerted, 0);
});

Deno.test("an unknown state skips the account entirely", async () => {
  const { deps, rec } = fakeDeps([candidate("acc-1")], { "acc-1": null });

  const summary = await runWatch(deps);

  assertEquals(rec.calls, ["listCandidates", "readState:postora_acc-1"]);
  assertEquals(summary, {
    polled: 1,
    skipped: 1,
    episodes: 0,
    flagged: 0,
    alerted: 0,
    failed: [],
    deferred: 0,
  });
});

Deno.test("a terminal episode that is not yet due flags nothing", async () => {
  const { deps, rec } = fakeDeps(
    [candidate("acc-1")],
    { "acc-1": "close" },
    episode(minutesAgo(2), minutesAgo(2)),
  );

  const summary = await runWatch(deps);

  assertEquals(rec.observeCalls, [{ accountId: "acc-1", state: "close", terminal: true }]);
  assertEquals(rec.calls.includes("markFlagged:acc-1"), false);
  assertEquals(rec.calls.includes("dispatchAlert:acc-1"), false);
  assertEquals(summary.episodes, 1);
  assertEquals(summary.flagged, 0);
  assertEquals(summary.alerted, 0);
});

Deno.test("a due terminal episode is flagged and dispatched once, in that order", async () => {
  const { deps, rec } = fakeDeps(
    [candidate("acc-1")],
    { "acc-1": "close" },
    episode(minutesAgo(30), minutesAgo(30)),
  );

  const summary = await runWatch(deps);

  assertEquals(rec.calls, [
    "listCandidates",
    "readState:postora_acc-1",
    "observe:acc-1",
    "markFlagged:acc-1",
    "dispatchAlert:acc-1",
  ]);
  assertEquals(summary.episodes, 1);
  assertEquals(summary.flagged, 1);
  assertEquals(summary.alerted, 1);
});

Deno.test("a sender that reached no recipient is not counted as an alert", async () => {
  // The sender answers 200 even when it could not reach anybody. Counting the alert from
  // the HTTP status alone would claim an alert that never went out.
  const { deps, rec } = fakeDeps(
    [candidate("acc-1")],
    { "acc-1": "close" },
    episode(minutesAgo(30), minutesAgo(30)),
    new Set(),
    true,
    { dispatch: { ownerSent: false, adminSent: false, failed: ["acc-1"], skipped: null } },
  );

  const summary = await runWatch(deps);

  assertEquals(rec.calls.includes("dispatchAlert:acc-1"), true);
  assertEquals(summary.alerted, 0);
  assertEquals(summary.failed, ["acc-1"]);
});

Deno.test("a recipient the sender could not reach is reported as a failure", async () => {
  const { deps, rec } = fakeDeps(
    [candidate("acc-1")],
    { "acc-1": "close" },
    episode(minutesAgo(30), minutesAgo(30)),
    new Set(),
    true,
    { dispatch: { ownerSent: false, adminSent: true, failed: ["acc-1"], skipped: null } },
  );

  const summary = await runWatch(deps);

  assertEquals(summary.alerted, 1);
  assertEquals(summary.failed, ["acc-1"]);
});

Deno.test("one failing account does not stop the others", async () => {
  const { deps, rec } = fakeDeps(
    [candidate("acc-1"), candidate("acc-2")],
    { "acc-2": "close" },
    episode(minutesAgo(30), minutesAgo(30)),
    new Set(["postora_acc-1"]),
  );

  const summary = await runWatch(deps);

  assertEquals(rec.calls.includes("observe:acc-1"), false);
  assertEquals(rec.calls.includes("observe:acc-2"), true);
  assertEquals(summary.failed, ["acc-1"]);
  assertEquals(summary.alerted, 1);
});

Deno.test("a state read that fails is an account failure, not a poll", async () => {
  // An unreachable Evolution is not evidence about the account. Recording it as polled
  // would skip the account for the whole freshness window, and the outage behind it
  // would go unnoticed.
  const { deps, rec } = fakeDeps(
    [candidate("acc-1")],
    { "acc-1": "open" },
    episode(minutesAgo(30), minutesAgo(30)),
    new Set(["postora_acc-1"]),
  );

  const summary = await runWatch(deps);

  assertEquals(summary.polled, 0);
  assertEquals(summary.failed, ["acc-1"]);
  assertEquals(rec.polled, []);
  assertEquals(rec.calls.includes("clear:acc-1"), false);
});

Deno.test("one run polls at most MAX_ACCOUNTS_PER_RUN accounts", async () => {
  const candidates = Array.from({ length: MAX_ACCOUNTS_PER_RUN + 10 }, (_, index) =>
    candidate(`acc-${index}`)
  );
  const states: Record<string, string | null> = {};
  for (const c of candidates) states[c.id] = "open";
  const { deps, rec } = fakeDeps(candidates, states);

  const summary = await runWatch(deps);

  assertEquals(summary.polled, MAX_ACCOUNTS_PER_RUN);
  assertEquals(rec.calls.filter((call) => call.startsWith("readState:")).length, MAX_ACCOUNTS_PER_RUN);
});

Deno.test("a run that overruns its budget leaves the remaining candidates for the next run", async () => {
  // The run is bounded: the candidates it did not reach are not polled, so the next run
  // picks them up. A run that was killed by the platform would leave the same accounts
  // unpolled, but without saying so.
  const candidates = Array.from({ length: 5 }, (_, index) => candidate(`acc-${index}`));
  const states: Record<string, string | null> = {};
  for (const c of candidates) states[c.id] = "open";
  const { deps, rec } = fakeDeps(candidates, states, episode(minutesAgo(30), minutesAgo(30)), new Set(), true, {
    clockStepMs: 30_000,
  });

  const summary = await runWatch(deps);

  assertEquals(summary.polled, 2);
  assertEquals(summary.deferred, 3);
  assertEquals(rec.calls.filter((call) => call.startsWith("readState:")).length, 2);
  // The deferred accounts were not polled, so they stay candidates for the next run.
  assertEquals(rec.calls.includes("clear:acc-3"), false);
  assertEquals(RUN_BUDGET_MS, 50_000);
});

Deno.test("the poll time is recorded for every account that was read, skipped ones included", async () => {
  const { deps, rec } = fakeDeps(
    [candidate("acc-1"), candidate("acc-2")],
    { "acc-1": "open", "acc-2": null },
  );

  await runWatch(deps);

  assertEquals(rec.polled, [
    { instanceName: "postora_acc-1", at: NOW_DATE },
    { instanceName: "postora_acc-2", at: NOW_DATE },
  ]);
});
