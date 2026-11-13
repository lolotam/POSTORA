import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  DISCONNECT_BACKSTOP_MINUTES,
  DISCONNECT_GRACE_MINUTES,
  MAX_ACCOUNTS_PER_RUN,
  POLL_CRON_INTERVAL_MINUTES,
  POLL_FRESHNESS_MINUTES,
  RUN_BUDGET_MS,
  classifyState,
  isAlertDue,
  isPollFresh,
  runWatch,
  type Episode,
  type WatchCandidate,
  type WatchDeps,
} from "./run.ts";
import type { AlertDispatchResult } from "./dispatch.ts";

const NOW = Date.parse("2026-11-13T12:00:00Z");
const NOW_DATE = new Date(NOW);

function episode(since: string | null, firstSeen: string, state = "close"): Episode {
  return { episode_id: "ep-1", since, first_seen: firstSeen, state, observed_at: since ?? firstSeen };
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
  /** What the conditional restore answers: true means "the account was restored". */
  restored?: boolean;
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
    restore: (accountId) => {
      rec.calls.push(`restore:${accountId}`);
      return Promise.resolve(options.restored === true);
    },
    clearUnflagged: (accountId) => {
      rec.calls.push(`clearUnflagged:${accountId}`);
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

Deno.test("classifyState does not infer a disconnect from an undocumented state", () => {
  assertEquals(classifyState("some-future-state"), "unknown");
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

Deno.test("isAlertDue only counts the backstop for an episode without a terminal streak", () => {
  // A transient observation clears `since`: the episode has no continuous terminal streak,
  // so the ten minute grace window never applies to it. The sixty minute backstop still
  // does -- that is what catches an account stuck in `connecting`.
  const young = episode(null, minutesAgo(30));
  assertEquals(isAlertDue(young, NOW_DATE), false);

  const old = episode(null, minutesAgo(DISCONNECT_BACKSTOP_MINUTES));
  assertEquals(isAlertDue(old, NOW_DATE), true);
});

Deno.test("isPollFresh keeps the freshness window below the cron interval", () => {
  // The cutoff must be shorter than the cron interval: `last_polled_at` is written after
  // the Evolution call, so on the next tick the row's age is a little under five minutes.
  assertEquals(POLL_FRESHNESS_MINUTES < POLL_CRON_INTERVAL_MINUTES, true);

  assertEquals(isPollFresh(null, NOW_DATE), false);
  assertEquals(isPollFresh("not-a-date", NOW_DATE), false);
  assertEquals(isPollFresh(minutesAgo(1), NOW_DATE), true);
  assertEquals(isPollFresh(minutesAgo(POLL_FRESHNESS_MINUTES - 1), NOW_DATE), true);
  assertEquals(isPollFresh(minutesAgo(POLL_FRESHNESS_MINUTES), NOW_DATE), false);
  assertEquals(isPollFresh(minutesAgo(POLL_CRON_INTERVAL_MINUTES), NOW_DATE), false);
});

Deno.test("a candidate polled five minutes ago is polled again", async () => {
  // The cron runs every five minutes and `last_polled_at` is written AFTER the Evolution
  // call, so on the next tick the row's age is a little under five minutes. A freshness
  // window of exactly five minutes would skip that account and halve the polling cadence
  // to ten minutes.
  const start = Date.parse("2026-11-13T12:00:00Z");
  let now = new Date(start);
  let lastPolledAt: string | null = null;
  const polled: string[] = [];

  const deps: WatchDeps = {
    listCandidates: () =>
      Promise.resolve(
        isPollFresh(lastPolledAt, now)
          ? []
          : [{ id: "acc-1", instance_name: "postora_acc-1", is_active: true }],
      ),
    readState: () => {
      polled.push(now.toISOString());
      return Promise.resolve("open");
    },
    observe: () => Promise.resolve(null),
    clear: () => Promise.resolve(),
    restore: () => Promise.resolve(false),
    clearUnflagged: () => Promise.resolve(),
    markFlagged: () => Promise.resolve(false),
    dispatchAlert: () =>
      Promise.resolve({ ownerSent: false, adminSent: false, failed: [], skipped: null }),
    markPolled: (_instanceName, at) => {
      lastPolledAt = at.toISOString();
      return Promise.resolve();
    },
    monotonicNow: () => 0,
    now: () => now,
  };

  await runWatch(deps);
  now = new Date(start + POLL_CRON_INTERVAL_MINUTES * 60_000);
  await runWatch(deps);

  assertEquals(polled.length, 2);
});

Deno.test("a candidate polled inside the freshness window is skipped", async () => {
  // The freshness window still does its job: an account that was just checked is not
  // polled again in the same window.
  const start = Date.parse("2026-11-13T12:00:00Z");
  let now = new Date(start);
  let lastPolledAt: string | null = null;
  const polled: string[] = [];

  const deps: WatchDeps = {
    listCandidates: () =>
      Promise.resolve(
        isPollFresh(lastPolledAt, now)
          ? []
          : [{ id: "acc-1", instance_name: "postora_acc-1", is_active: true }],
      ),
    readState: () => {
      polled.push(now.toISOString());
      return Promise.resolve("open");
    },
    observe: () => Promise.resolve(null),
    clear: () => Promise.resolve(),
    restore: () => Promise.resolve(false),
    clearUnflagged: () => Promise.resolve(),
    markFlagged: () => Promise.resolve(false),
    dispatchAlert: () =>
      Promise.resolve({ ownerSent: false, adminSent: false, failed: [], skipped: null }),
    markPolled: (_instanceName, at) => {
      lastPolledAt = at.toISOString();
      return Promise.resolve();
    },
    monotonicNow: () => 0,
    now: () => now,
  };

  await runWatch(deps);
  now = new Date(start + (POLL_FRESHNESS_MINUTES - 1) * 60_000);
  await runWatch(deps);

  assertEquals(polled.length, 1);
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

Deno.test("a healthy inactive account with nothing to restore drops the unflagged episode", async () => {
  // Restore is only for an episode this watcher flagged. When it refuses, the episode
  // was never flagged: leaving it would keep a stale episode on an inactive row, and the
  // ordinary clear would also wipe needs_reauth, which is the banner on that row.
  const { deps, rec } = fakeDeps([candidate("acc-1", false)], { "acc-1": "open" });

  const summary = await runWatch(deps);

  assertEquals(rec.calls, [
    "listCandidates",
    "readState:postora_acc-1",
    "restore:acc-1",
    "clearUnflagged:acc-1",
  ]);
  assertEquals(rec.calls.includes("clear:acc-1"), false);
  assertEquals(summary.polled, 1);
  assertEquals(summary.failed, []);
});

Deno.test("a healthy poll restores an account the watcher deactivated", async () => {
  // The watcher sets is_active = false when it flags an account, and the account stays
  // inactive until the owner scans a new QR code. The session can come back on its own,
  // and then the restore reactivates the account and clears the episode in one statement.
  const { deps, rec } = fakeDeps(
    [candidate("acc-1", false)],
    { "acc-1": "open" },
    episode(minutesAgo(30), minutesAgo(30)),
    new Set(),
    true,
    { restored: true },
  );

  const summary = await runWatch(deps);

  assertEquals(rec.calls, ["listCandidates", "readState:postora_acc-1", "restore:acc-1"]);
  assertEquals(rec.calls.includes("clearUnflagged:acc-1"), false);
  assertEquals(summary.polled, 1);
  assertEquals(summary.failed, []);
});

Deno.test("a transient account is observed but never flagged or dispatched", async () => {
  // A transient observation clears the terminal streak, so `since` is null: the episode is
  // still young, so neither window is due and nothing is alerted.
  const { deps, rec } = fakeDeps(
    [candidate("acc-1")],
    { "acc-1": "connecting" },
    episode(null, minutesAgo(30)),
  );

  const summary = await runWatch(deps);

  assertEquals(rec.observeCalls, [{ accountId: "acc-1", state: "connecting", terminal: false }]);
  assertEquals(rec.calls.includes("markFlagged:acc-1"), false);
  assertEquals(rec.calls.includes("dispatchAlert:acc-1"), false);
  assertEquals(summary.flagged, 0);
  assertEquals(summary.alerted, 0);
});

Deno.test("an episode that keeps flapping still alerts at the backstop", async () => {
  // The episode itself is an hour old and there is no terminal streak at all: an account
  // stuck in `connecting` never reaches the grace window, and the backstop is what stops
  // it from never alerting.
  const { deps, rec } = fakeDeps(
    [candidate("acc-1")],
    { "acc-1": "connecting" },
    episode(null, minutesAgo(DISCONNECT_BACKSTOP_MINUTES)),
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

Deno.test("a state read that fails is an account failure and is still marked polled", async () => {
  // Candidates are ordered by last_polled_at, nulls first. A read that throws and is
  // left unmarked stays at the head of every run and the other accounts are never
  // reached. The poll time rotates the queue. The failure stays in the summary, and
  // nothing is observed, cleared, or alerted: an unreachable Evolution is not evidence.
  const { deps, rec } = fakeDeps(
    [candidate("acc-1")],
    { "acc-1": "open" },
    episode(minutesAgo(30), minutesAgo(30)),
    new Set(["postora_acc-1"]),
  );

  const summary = await runWatch(deps);

  assertEquals(summary.polled, 0);
  assertEquals(summary.failed, ["acc-1"]);
  assertEquals(rec.polled, [{ instanceName: "postora_acc-1", at: NOW_DATE }]);
  assertEquals(rec.calls.includes("clear:acc-1"), false);
  assertEquals(rec.calls.includes("clearUnflagged:acc-1"), false);
  assertEquals(rec.calls.includes("observe:acc-1"), false);
  assertEquals(rec.calls.includes("dispatchAlert:acc-1"), false);
});

Deno.test("a failed read stays a failure when recording the poll time throws", async () => {
  const { deps } = fakeDeps(
    [candidate("acc-1")],
    { "acc-1": "open" },
    episode(minutesAgo(30), minutesAgo(30)),
    new Set(["postora_acc-1"]),
  );
  const summary = await runWatch({
    ...deps,
    markPolled: () => Promise.reject(new Error("poll mark failed")),
  });

  assertEquals(summary.polled, 0);
  assertEquals(summary.failed, ["acc-1"]);
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

Deno.test("fifty persistent read failures rotate out so the next account is polled", async () => {
  // PR #411: unmarked failures monopolized the oldest-first limit on every cron tick.
  const candidates = Array.from({ length: 51 }, (_, index) => candidate(`acc-${index}`));
  const failures = new Set(candidates.slice(0, 50).map((row) => row.instance_name));
  const { deps, rec } = fakeDeps(candidates, { "acc-50": "open" }, null, failures);
  const lastAttempt = new Map<string, number>();
  let now = NOW_DATE;
  const rotating: WatchDeps = {
    ...deps,
    listCandidates: (limit) => Promise.resolve(
      [...candidates].sort((a, b) =>
        (lastAttempt.get(a.instance_name) ?? 0) - (lastAttempt.get(b.instance_name) ?? 0)
      ).slice(0, limit),
    ),
    markPolled: (name, at) => {
      lastAttempt.set(name, at.getTime());
      return Promise.resolve();
    },
    now: () => now,
  };
  const first = await runWatch(rotating);
  now = new Date(NOW + POLL_CRON_INTERVAL_MINUTES * 60_000);
  const second = await runWatch(rotating);

  assertEquals(first.failed.length, 50);
  assertEquals(second.polled, 1);
  assertEquals(rec.calls.includes("clear:acc-50"), true);
});

Deno.test("a failed poll timestamp write never applies state and does not stop the next account", async () => {
  const { deps, rec } = fakeDeps(
    [candidate("acc-1"), candidate("acc-2")],
    { "acc-1": "close", "acc-2": "open" },
  );
  const summary = await runWatch({
    ...deps,
    markPolled: (name, at) => name === "postora_acc-1"
      ? Promise.reject(new Error("timestamp unavailable"))
      : deps.markPolled(name, at),
  });
  assertEquals(summary.failed, ["acc-1"]);
  assertEquals(summary.polled, 1);
  assertEquals(rec.calls.includes("observe:acc-1"), false);
  assertEquals(rec.calls.includes("clear:acc-2"), true);
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

Deno.test("an inactive emailed episode is polled again without reflagging or dispatching", async () => {
  const observed = {
    ...episode(minutesAgo(30), minutesAgo(30)),
    flagged_at: minutesAgo(20),
    user_email_at: minutesAgo(19),
    admin_email_at: minutesAgo(19),
  };
  const { deps, rec } = fakeDeps([candidate("acc-1", false)], { "acc-1": "close" }, observed);
  const first = await runWatch(deps);
  const second = await runWatch(deps);
  assertEquals(first.flagged + second.flagged, 0);
  assertEquals(first.alerted + second.alerted, 0);
  assertEquals(rec.flaggedEpisodes, []);
  assertEquals(rec.calls.filter((call) => call.startsWith("dispatchAlert:")), []);
  assertEquals(observed.flagged_at, minutesAgo(20));
});

Deno.test("a flagged episode retries either unfinished recipient group without reflagging", async () => {
  for (const completed of ["user_email_at", "admin_email_at"]) {
    const observed = {
      ...episode(minutesAgo(30), minutesAgo(30)),
      flagged_at: minutesAgo(20),
      [completed]: minutesAgo(19),
    };
    const { deps, rec } = fakeDeps([candidate("acc-1", false)], { "acc-1": "close" }, observed);
    await runWatch(deps);
    const second = await runWatch(deps);
    assertEquals(second.flagged, 0);
    assertEquals(rec.flaggedEpisodes, []);
    assertEquals(rec.calls.filter((call) => call.startsWith("dispatchAlert:" )).length, 2);
  }
});

Deno.test("watcher logs distinguish operational codes without exposing error text or arbitrary codes", async () => {
  const logged: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { logged.push(args.join(" ")); };
  try {
    for (const operation of ["read", "poll", "observe"]) {
      for (const code of ["PGRST202", "network_error", "owner@example.invalid +96512345678"]) {
        const { deps } = fakeDeps([candidate("acc-1")], { "acc-1": "close" });
        const failure = () => Promise.reject({ code, message: "secret@example.invalid token=private" });
        const summary = await runWatch({ ...deps,
          ...(operation === "read" ? { readState: failure } : operation === "poll" ? { markPolled: failure } : { observe: failure }),
        });
        assertEquals(summary.failed, ["acc-1"]);
      }
    }
  } finally { console.error = original; }
  assertEquals(logged.some((line) => line.includes("error_code=PGRST202")), true);
  assertEquals(logged.some((line) => line.includes("error_code=network_error")), true);
  assertEquals(logged.some((line) => line.includes("error_code=unknown_error")), true);
  assertEquals(logged.some((line) => /@|private|96512345678/.test(line)), false);
});
