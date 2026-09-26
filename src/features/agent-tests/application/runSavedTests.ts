import { EdgeApiError } from "@/lib/messagingApi";
import {
  evaluateTestCase,
  replyExcerpt,
  summariseResults,
  testCaseKey,
  testThreadId,
} from "../domain/evaluateTestCase";
import {
  CASE_TIMEOUT_MS,
  MAX_CASES_PER_RUN,
  type CaseResult,
  type RunStatus,
  type RunSummary,
  type SandboxReply,
  type TestCase,
} from "../domain/types";

export interface RunPatch {
  status: RunStatus;
  finishedAt: string | null;
  summary: RunSummary;
  results: CaseResult[];
}

export interface RunSavedTestsDeps {
  cases: TestCase[];
  platform: string;
  accountId: string;
  createRun: () => Promise<{ id: string }>;
  updateRun: (id: string, patch: RunPatch) => Promise<void>;
  deleteThreads: (conversationIds: string[]) => Promise<void>;
  runCase: (input: { message: string; testCaseKey: string; signal: AbortSignal }) => Promise<SandboxReply>;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (current: number, total: number) => void;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function transportOutcome(error: unknown): { verdict: "errored" | "indeterminate"; reason: string } {
  if (isAbort(error)) return { verdict: "errored", reason: "timed out" };
  if (error instanceof EdgeApiError) {
    if (error.status === 502 || error.status === 503 || error.status === 504) {
      return { verdict: "indeterminate", reason: `gateway error (HTTP ${error.status})` };
    }
    if (error.status === null) return { verdict: "indeterminate", reason: "network error" };
    return { verdict: "errored", reason: `request failed (HTTP ${error.status})` };
  }
  return { verdict: "indeterminate", reason: "network error" };
}

function toolNames(reply: SandboxReply): string[] {
  return (reply.tool_calls ?? [])
    .map((call) => call.name)
    .filter((name): name is string => typeof name === "string");
}

function intentOf(reply: SandboxReply): CaseResult["intent"] {
  if (typeof reply.intent?.choice !== "string" || typeof reply.intent.confidence !== "number") return null;
  return { choice: reply.intent.choice, confidence: reply.intent.confidence };
}

function baseResult(testCase: TestCase, verdict: CaseResult["verdict"], reasons: string[]): CaseResult {
  return {
    case_id: testCase.id,
    expected: testCase.expected,
    verdict,
    reasons,
    reply_excerpt: null,
    intent: null,
    intent_status: null,
    tool_calls: [],
    escalated: false,
    used_model: null,
  };
}

function fromReply(testCase: TestCase, reply: SandboxReply): CaseResult {
  const evaluation = evaluateTestCase(testCase.expected, reply);
  return {
    ...baseResult(testCase, evaluation.verdict, evaluation.reasons),
    reply_excerpt: replyExcerpt(reply.reply),
    intent: intentOf(reply),
    intent_status: reply.intent_status ?? null,
    tool_calls: toolNames(reply),
    escalated: reply.escalated === true,
    used_model: typeof reply.used_model === "string" ? reply.used_model : null,
  };
}

function snapshot(results: CaseResult[]): CaseResult[] {
  return results.map((result) => ({ ...result, reasons: [...result.reasons], tool_calls: [...result.tool_calls] }));
}

async function writeCheckpoint(deps: RunSavedTestsDeps, id: string, patch: RunPatch): Promise<void> {
  await deps.updateRun(id, { ...patch, results: snapshot(patch.results) });
}

async function checkpoint(deps: RunSavedTestsDeps, id: string, patch: RunPatch): Promise<void> {
  try {
    await writeCheckpoint(deps, id, patch);
  } catch (error) {
    console.error(`[agent-tests] run checkpoint failed: ${error instanceof Error ? error.name : "Error"}`);
  }
}

/**
 * One case at a time, in position order, at most 25. A failed or errored case
 * is recorded and the run continues. Each finished case is written to the run
 * row before the next starts. Gateway and network failures are indeterminate
 * and are not retried. When the run ends, its exact sandbox threads are deleted.
 */
export async function runSavedTests(deps: RunSavedTestsDeps): Promise<{
  id: string;
  status: RunStatus;
  results: CaseResult[];
  savedOk: boolean;
}> {
  const ordered = [...deps.cases].sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
  const selected = ordered.slice(0, MAX_CASES_PER_RUN);
  const created = await deps.createRun();
  const results: CaseResult[] = [];
  const threadIds: string[] = [];
  let status: RunStatus = "completed";
  const timeoutMs = deps.timeoutMs ?? CASE_TIMEOUT_MS;

  try {
    for (let index = 0; index < selected.length; index += 1) {
      if (deps.signal?.aborted) {
        status = "interrupted";
        break;
      }
      const testCase = selected[index];
      deps.onProgress?.(index + 1, selected.length);
      if (!testCase.expectationValid) {
        results.push(baseResult(testCase, "errored", ["saved expectation is invalid"]));
        await checkpoint(deps, created.id, {
          status: "running",
          finishedAt: null,
          summary: summariseResults(results),
          results,
        });
        continue;
      }

      const key = testCaseKey(created.id, index);
      threadIds.push(testThreadId(deps.platform, deps.accountId, key));
      const caseAbort = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        caseAbort.abort();
      }, timeoutMs);
      const onRunAbort = () => caseAbort.abort();
      deps.signal?.addEventListener("abort", onRunAbort);
      try {
        const reply = await deps.runCase({ message: testCase.message, testCaseKey: key, signal: caseAbort.signal });
        results.push(fromReply(testCase, reply));
      } catch (error) {
        if (isAbort(error) && !timedOut) {
          status = "interrupted";
          break;
        }
        const outcome = timedOut
          ? { verdict: "errored" as const, reason: "timed out" }
          : transportOutcome(error);
        results.push(baseResult(testCase, outcome.verdict, [outcome.reason]));
      } finally {
        clearTimeout(timer);
        deps.signal?.removeEventListener("abort", onRunAbort);
      }
      await checkpoint(deps, created.id, {
        status: "running",
        finishedAt: null,
        summary: summariseResults(results),
        results,
      });
    }
  } catch (error) {
    status = "interrupted";
    console.error(`[agent-tests] run failed: ${error instanceof Error ? error.name : "Error"}`);
  }

  const finished: RunPatch = {
    status,
    finishedAt: new Date().toISOString(),
    summary: summariseResults(results),
    results,
  };
  let savedOk = true;
  try {
    await writeCheckpoint(deps, created.id, finished);
  } catch (error) {
    savedOk = false;
    status = "interrupted";
    console.error(`[agent-tests] run checkpoint failed: ${error instanceof Error ? error.name : "Error"}`);
  }
  try {
    await deps.deleteThreads(threadIds);
  } catch (error) {
    console.error(`[agent-tests] thread cleanup failed: ${error instanceof Error ? error.name : "Error"}`);
  }
  return { id: created.id, status, results, savedOk };
}
