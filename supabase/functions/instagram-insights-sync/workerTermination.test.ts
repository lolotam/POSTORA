/**
 * The termination of an OWNER collection job across MANY visits.
 *
 * WHAT THIS SUITE COVERS
 *
 *   The worker is driven through repeated `runOwnerDrain` visits against a
 *   store that keeps the job the way the accepted SQL keeps it: the
 *   checkpoint, the open operations, the stored media and the status of the
 *   job survive the visit that wrote them, and the claim hands the job out
 *   again only while it is DUE.
 *
 *   1. twelve media, all of them fine: the job completes in
 *      ceil(12 / 5) visits, and every media is collected exactly once;
 *   2. one media that always fails transiently: the job reaches a terminal
 *      state at the continuation bound, never an endless cycle, and the
 *      other media are all collected;
 *   3. a media the provider answers with an EMPTY data set: the answer is
 *      a fact, and the job completes;
 *   4. a usage stop on the first media page: the job stays resumable and a
 *      later visit completes it;
 *   5. a visit after the completion: the claim hands out nothing.
 *
 * THE BOUNDS
 *
 *   Every bound below is a bound of the WORKER, not of the test:
 *
 *   - the media continuation collects at most MEDIA_INSIGHTS_PER_VISIT
 *     media per visit, so twelve media need ceil(12 / 5) visits;
 *   - a continuation may be continued on the capture day and on the next
 *     Kuwait day, so a job that cannot finish is FINISHED on the visit
 *     after that: CONTINUATION_MAX_AGE_DAYS + 2 visits at most.
 */
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { InstagramGraphProvider } from "./graphProvider.ts";
import { InstagramDirectGraphProvider } from "./directGraphProvider.ts";
import {
  CONTINUATION_MAX_AGE_DAYS,
  MEDIA_INSIGHTS_PER_VISIT,
  runOwnerDrain,
  THROTTLE_WINDOW_MS,
  type OwnerDrainSummary,
  type OwnerWorkerPorts,
} from "./worker.ts";
import {
  accountDayAnswer,
  createPersistingStore,
  mediaInsightAnswer,
  type PersistingStoreState,
} from "./workerTestSupport.ts";

/** The instant the first visit of every test runs at. */
const FIRST_VISIT_MS = Date.parse("2026-10-28T12:00:00.000Z");

/** One Kuwait day, in milliseconds. */
const KUWAIT_DAY_MS = 24 * 60 * 60_000;

/** One media of the scripted feed. */
interface ScriptedMedia {
  readonly id: string;
  readonly media_type?: string;
  readonly media_product_type?: string;
  readonly timestamp: string;
}

/** The answers of the scripted provider. */
interface ScriptedGraphOptions {
  readonly media: readonly ScriptedMedia[];
  /** The usage percent each media call reports, in order. */
  readonly mediaUsage?: readonly number[];
  /** The answers of the media insights, keyed by media id. */
  readonly insights?: Record<string, unknown>;
  /** The refusals of the media insights, keyed by media id. */
  readonly refusals?: Record<string, unknown>;
}

/**
 * The scripted provider.
 *
 * It answers by URL shape, and the media connection can report a different
 * usage on every call, so a usage stop can be placed on the first page
 * only.
 */
function createScriptedGraph(options: ScriptedGraphOptions) {
  const calls: string[] = [];
  let mediaCalls = 0;

  const fetchFn = (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const isInsights = url.includes("/insights");
    const isAccountDay = isInsights && url.includes("metric_type=total_value");
    const kind = isAccountDay
      ? "accountDay"
      : isInsights
      ? "mediaInsight"
      : url.includes("/media")
      ? "media"
      : "profile";
    calls.push(kind);

    if (kind === "profile") {
      return Promise.resolve(
        new Response(JSON.stringify({ followers_count: 3200, media_count: 42 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    if (kind === "accountDay") {
      return Promise.resolve(
        new Response(JSON.stringify(accountDayAnswer({ reach: 450, views: 890 })), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }

    if (kind === "media") {
      const index = mediaCalls;
      mediaCalls += 1;
      const usage = options.mediaUsage?.[index];
      return Promise.resolve(
        new Response(JSON.stringify({ data: options.media }), {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            ...(usage === undefined
              ? {}
              : { "x-app-usage": JSON.stringify({ call_count: usage }) }),
          },
        }),
      );
    }

    const mediaId = /\/v\d+\.\d+\/([^/?]+)\/insights/.exec(url)?.[1] ?? "";
    const answer = options.refusals?.[mediaId] ??
      options.insights?.[mediaId] ??
      mediaInsightAnswer({ reach: 100, views: 200 });
    return Promise.resolve(
      new Response(JSON.stringify(answer), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
  };

  return { fetchFn: fetchFn as unknown as typeof fetch, calls };
}

/** The media of a scripted feed, newest first. */
function mediaFixture(count: number): ScriptedMedia[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `media-${index + 1}`,
    media_type: "IMAGE",
    media_product_type: "FEED",
    timestamp: `2026-10-${String(20 - index).padStart(2, "0")}T12:00:00Z`,
  }));
}

/** A clock the test moves by hand between the visits. */
function createClock(startMs: number) {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

interface TerminationHarness {
  readonly ports: OwnerWorkerPorts;
  readonly state: PersistingStoreState;
  readonly graphCalls: string[];
  readonly logs: Array<Record<string, unknown>>;
  readonly clock: { now: () => number; advance: (ms: number) => void };
}

function createHarness(options: {
  readonly graph?: ScriptedGraphOptions;
} = {}): TerminationHarness {
  const clock = createClock(FIRST_VISIT_MS);
  const { store, state } = createPersistingStore({ now: clock.now });
  const { fetchFn, calls } = createScriptedGraph(options.graph ?? { media: [] });
  const logs: Array<Record<string, unknown>> = [];

  const ports: OwnerWorkerPorts = {
    store,
    provider: new InstagramGraphProvider({ fetchFn }),
    directProvider: new InstagramDirectGraphProvider({ fetchFn }),
    bucketKeyFor: async () => "b".repeat(64),
    now: clock.now,
    log: (event) => logs.push({ ...event }),
  };

  return { ports, state, graphCalls: calls, logs, clock };
}

/**
 * Runs the visits of ONE job.
 *
 * The clock moves by `stepMs` between the visits, so a job the accepted SQL
 * makes due again is claimed again, and a job it made terminal is not.
 */
async function runVisits(
  harness: TerminationHarness,
  options: { readonly visits: number; readonly stepMs: number },
): Promise<OwnerDrainSummary[]> {
  const summaries: OwnerDrainSummary[] = [];
  for (let visit = 0; visit < options.visits; visit += 1) {
    summaries.push(await runOwnerDrain(harness.ports));
    harness.clock.advance(options.stepMs);
  }
  return summaries;
}

/** The media rows whose insights were collected. */
function collectedMedia(state: PersistingStoreState): string[] {
  return state.media()
    .filter((row) => row.views !== null || row.reach !== null)
    .map((row) => row.igMediaId)
    .sort();
}

// ---------------------------------------------------------------------------
// The media continuation
// ---------------------------------------------------------------------------

/**
 * Twelve media need ceil(12 / 5) visits.
 *
 * The continuation collects at most five media per visit, and the queue is
 * RESUMED, so the media are not collected twice and none is left behind.
 */
Deno.test("twelve media are collected in ceil(12/5) visits", async () => {
  const harness = createHarness({ graph: { media: mediaFixture(12) } });

  const bound = Math.ceil(12 / MEDIA_INSIGHTS_PER_VISIT);
  assertEquals(bound, 3);

  const summaries = await runVisits(harness, {
    visits: bound,
    stepMs: 2 * 60_000,
  });

  // The first two visits collected five media each and left the job
  // claimable: the queue still owed work.
  assertEquals(summaries[0]!.partial, 1);
  assertEquals(summaries[1]!.partial, 1);
  assertEquals(summaries[0]!.completed, 0);
  assertEquals(summaries[1]!.completed, 0);

  // The third visit collected the last two media and completed the job.
  assertEquals(summaries[2]!.completed, 1);
  assertEquals(summaries[2]!.partial, 0);
  assertEquals(harness.state.status(), "completed");

  // Nothing is owed any more.
  assertEquals(harness.state.checkpoint().inventory_remaining_ids, []);

  // Every media was collected, exactly once.
  assertEquals(collectedMedia(harness.state).length, 12);

  // The provider was asked for five media insights per visit and no more.
  const insightCalls = harness.graphCalls.filter((call) => call === "mediaInsight").length;
  assertEquals(insightCalls, 12);
});

// ---------------------------------------------------------------------------
// The end of a continuation
// ---------------------------------------------------------------------------

/**
 * A media that keeps failing does not keep the job coming back for ever.
 *
 * The failing media goes to the BACK of the queue, so the media behind it
 * are collected, and the continuation itself is bounded: the job is
 * finished with a terminal outcome instead of being claimed again for ever.
 */
Deno.test("a media that keeps failing ends the job at the continuation bound", async () => {
  const harness = createHarness({
    graph: {
      media: mediaFixture(3),
      // A transient refusal: the provider failed, it did not say the media
      // has no insights.
      refusals: { "media-1": { error: { message: "temporary" } } },
    },
  });

  // The continuation may run on the capture day and on the next Kuwait
  // day; the visit after that finishes the job.
  const bound = CONTINUATION_MAX_AGE_DAYS + 2;
  assertEquals(bound, 3);

  const summaries = await runVisits(harness, {
    visits: bound + 2,
    stepMs: KUWAIT_DAY_MS,
  });

  // The job reached a terminal state inside the bound.
  const terminal = summaries.findIndex((summary) => summary.unavailable > 0);
  assertEquals(terminal >= 0, true);
  assertEquals(terminal < bound, true);

  // The terminal outcome says why, and the job is never claimed again.
  assertEquals(harness.state.status(), "unavailable");
  const last = harness.state.completions().at(-1)!;
  assertEquals(last, { outcome: "unavailable", reasonCode: "continuation_expired" });

  // The visits after the terminal one claimed nothing: the cycle ended.
  for (const summary of summaries.slice(terminal + 1)) {
    assertEquals(summary.claimed, 0);
    assertEquals(summary.processed, 0);
  }

  // The media behind the failing one were ALL collected, and the failing
  // one was not: it is the only media still owed.
  assertEquals(collectedMedia(harness.state), ["media-2", "media-3"]);
  assertEquals(harness.state.checkpoint().inventory_remaining_ids, ["media-1"]);
});

// ---------------------------------------------------------------------------
// An empty answer
// ---------------------------------------------------------------------------

/**
 * A media the provider answers with an EMPTY data set is collected.
 *
 * The answer was well formed and it was empty, so the media owes nothing
 * and the job does not keep it.
 */
Deno.test("a media the provider answers with an empty data set completes the job", async () => {
  const harness = createHarness({
    graph: {
      media: mediaFixture(1),
      insights: { "media-1": { data: [] } },
    },
  });

  const summaries = await runVisits(harness, {
    visits: 2,
    stepMs: 2 * 60_000,
  });

  assertEquals(summaries[0]!.completed, 1);
  assertEquals(summaries[0]!.partial, 0);
  assertEquals(harness.state.status(), "completed");
  assertEquals(harness.state.checkpoint().inventory_remaining_ids, []);

  // The media was asked: the answer was empty, and the media still left the
  // queue.
  assertEquals(harness.graphCalls.filter((call) => call === "mediaInsight").length, 1);
});

// ---------------------------------------------------------------------------
// A usage stop
// ---------------------------------------------------------------------------

/**
 * A usage stop is temporary.
 *
 * The job stays resumable, the shared bucket carries the window, and the
 * visit after the window collects the job.
 */
Deno.test("a usage stop on the first media page leaves the job resumable and it completes after", async () => {
  const harness = createHarness({
    graph: {
      media: mediaFixture(2),
      // Only the FIRST media page reports the usage.
      mediaUsage: [85],
    },
  });

  const summaries = await runVisits(harness, {
    visits: 1,
    stepMs: 0,
  });

  // The first visit stopped on the usage: the job is left partial and
  // resumable, and it is NOT closed as unavailable.
  assertEquals(summaries[0]!.partial, 1);
  assertEquals(summaries[0]!.completed, 0);
  assertEquals(summaries[0]!.unavailable, 0);
  assertEquals(harness.state.completions().at(-1), {
    outcome: "partial",
    reasonCode: "rate_limited",
  });

  // The shared bucket carries the window.
  assertEquals(harness.state.bucket()?.throttledUntil !== null, true);

  // The visit after the window collected the job.
  harness.clock.advance(THROTTLE_WINDOW_MS + 60_000);
  const second = await runOwnerDrain(harness.ports);

  assertEquals(second.completed, 1);
  assertEquals(harness.state.status(), "completed");
  assertEquals(harness.state.checkpoint().inventory_remaining_ids, []);
});

// ---------------------------------------------------------------------------
// The end of the job
// ---------------------------------------------------------------------------

/**
 * A completed job is never claimed again.
 */
Deno.test("a visit after the completion claims nothing", async () => {
  const harness = createHarness({ graph: { media: mediaFixture(1) } });

  const first = await runOwnerDrain(harness.ports);
  assertEquals(first.completed, 1);
  assertEquals(harness.state.status(), "completed");

  const second = await runOwnerDrain(harness.ports);

  assertEquals(second.claimed, 0);
  assertEquals(second.processed, 0);
  assertEquals(second.completed, 0);
  assertEquals(second.jobs.length, 0);
  assertEquals(harness.state.claims(), 1);
});
