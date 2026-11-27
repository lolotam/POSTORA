import {
  classifyBenchmarkChannelInput,
  normalizeBenchmarkChannelInput,
} from "../../../../supabase/functions/youtube-channel-benchmark/contracts";
import {
  YOUTUBE_BENCHMARK_MAX_CHANNELS,
  type YouTubeBenchmarkChannel,
  type YouTubeBenchmarkRecentVideo,
} from "./types";

/**
 * The canonical form of one channel input.
 *
 * The rule belongs to the edge function's contract, which already uses it to
 * de-duplicate a request (ARCHITECTURE.md §22): the browser's cache key and
 * the server's request must agree, or the same channel would be read twice.
 */
export { normalizeBenchmarkChannelInput } from "../../../../supabase/functions/youtube-channel-benchmark/contracts";

/** Whether the input is a handle or a channel id the API accepts. */
export function isValidBenchmarkChannelInput(raw: string): boolean {
  return classifyBenchmarkChannelInput(raw) !== null;
}

export type BenchmarkInputParseFailure =
  | "empty"
  | "too_many"
  | "invalid_input"
  | "duplicate_input";

export type BenchmarkInputParseResult =
  | { ok: true; inputs: string[] }
  | { ok: false; reason: BenchmarkInputParseFailure; invalidValue?: string };

/**
 * Whether the parsed inputs were refused.
 *
 * A type guard rather than an inline `!result.ok`: this repository compiles
 * without `strictNullChecks`, where TypeScript does not narrow a union by a
 * boolean discriminant.
 */
export function isBenchmarkInputFailure(
  result: BenchmarkInputParseResult,
): result is { ok: false; reason: BenchmarkInputParseFailure; invalidValue?: string } {
  return result.ok === false;
}

/**
 * Validates the three raw inputs in the browser, BEFORE any provider call.
 *
 * The rules are the server's rules (spec §11.2): one to three unique entries,
 * each a handle or a channel id. A creator who typed the same channel twice
 * gets one column, not two columns and two rounds of provider units.
 */
export function parseBenchmarkInputs(rawInputs: readonly string[]): BenchmarkInputParseResult {
  const provided = rawInputs.map((raw) => raw.trim()).filter((raw) => raw.length > 0);

  if (provided.length === 0) return { ok: false, reason: "empty" };
  if (provided.length > YOUTUBE_BENCHMARK_MAX_CHANNELS) {
    return {
      ok: false,
      reason: "too_many",
      invalidValue: provided[YOUTUBE_BENCHMARK_MAX_CHANNELS],
    };
  }

  const normalized: string[] = [];
  for (const raw of provided) {
    if (!isValidBenchmarkChannelInput(raw)) {
      return { ok: false, reason: "invalid_input", invalidValue: raw };
    }
    normalized.push(normalizeBenchmarkChannelInput(raw));
  }

  const seen = new Set<string>();
  for (const [index, raw] of provided.entries()) {
    if (seen.has(normalized[index])) {
      return { ok: false, reason: "duplicate_input", invalidValue: raw };
    }
    seen.add(normalized[index]);
  }

  return { ok: true, inputs: normalized };
}

export interface YouTubeBenchmarkAverages {
  /** How many recent videos the averages were computed from. */
  sampleCount: number;
  averageViews: number | null;
  averageLikes: number | null;
  averageComments: number | null;
}

function averageOf(values: readonly (number | null)[]): number | null {
  let sum = 0;
  let count = 0;
  for (const value of values) {
    // A video whose counter YouTube does not expose must not drag the
    // average down: it is skipped, and the average is over the rest.
    if (value === null || !Number.isFinite(value)) continue;
    sum += value;
    count += 1;
  }
  if (count === 0) return null;
  return Math.round(sum / count);
}

/**
 * The per-recent-video averages of ONE channel, computed in the browser.
 *
 * The figures of different channels are never combined into one number: the
 * YouTube API Services Developer Policies forbid aggregating data across
 * unaffiliated channels, and a cross-channel score would be exactly that.
 */
export function computeRecentVideoAverages(
  videos: readonly YouTubeBenchmarkRecentVideo[],
): YouTubeBenchmarkAverages {
  return {
    sampleCount: videos.length,
    averageViews: averageOf(videos.map((video) => video.view_count)),
    averageLikes: averageOf(videos.map((video) => video.like_count)),
    averageComments: averageOf(videos.map((video) => video.comment_count)),
  };
}

/**
 * Whether a channel's answer is settled enough to be reused.
 *
 * Only two answers are settled: a channel that was read (`found` without an
 * error) and a channel the provider positively does not have (`not_found`).
 * A degraded or failed answer is never settled — reusing it would show a
 * quota notice for half an hour after the quota came back.
 */
export function isSettledBenchmarkChannel(channel: YouTubeBenchmarkChannel): boolean {
  if (channel.status === "not_found") return true;
  return channel.status === "found" && !channel.error;
}
