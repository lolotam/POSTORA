import type { IntentStatus, SandboxReply, TestExpectation, TestVerdict } from "./types";

// Built-in names are not connectors. Source of truth: `toolDefinitions` in
// supabase/functions/ai-agent-reply/tools.ts, plus `adminToolDefinitions` in
// supabase/functions/ai-agent-reply/admin-tools.ts. Both must change together.
const BUILTIN_TOOLS = new Set([
  "search_knowledge",
  "escalate_to_human",
  "notify_admin",
  "list_connected_accounts",
  "search_posts",
  "get_posting_summary",
  "create_scheduled_post",
]);

/** Case-insensitive, trimmed, with Arabic alef variants and taa marbuta folded. */
export function normaliseForMatch(value: string): string {
  return value.trim().toLowerCase().replace(/[أإآ]/g, "ا").replace(/ة/g, "ه");
}

function connectorNames(result: SandboxReply): string[] {
  return (result.tool_calls ?? [])
    .map((call) => call.name)
    .filter((name): name is string => typeof name === "string" && name.length > 0 && !BUILTIN_TOOLS.has(name));
}

function contractFailure(result: SandboxReply): string | null {
  if (result.ok === true && typeof result.reply === "string") return null;
  if (typeof result.skipped === "string" && /^[a-z0-9_]+$/.test(result.skipped)) {
    return `skipped: ${result.skipped}`;
  }
  return "the agent did not return a reply";
}

export interface TestEvaluation {
  verdict: TestVerdict;
  reasons: string[];
}

/**
 * Live smoke check. Only `ok === true` with a string reply is evaluated.
 * An intent check while triage is off or unsure is errored, not failed.
 * An empty expectation is "no assertions", which is not a pass.
 * Connector checks mean the tool was called, not that the vendor succeeded.
 */
export function evaluateTestCase(expected: TestExpectation, result: SandboxReply): TestEvaluation {
  const contract = contractFailure(result);
  if (contract) return { verdict: "errored", reasons: [contract] };

  const reply = result.reply as string;
  const hasAssertion = expected.intent !== undefined
    || expected.connector !== undefined
    || expected.contains !== undefined
    || expected.avoids !== undefined
    || expected.escalates !== undefined;
  if (!hasAssertion) return { verdict: "no_assertions", reasons: [] };

  const failures: string[] = [];
  const errors: string[] = [];

  if (expected.intent) {
    if (result.intent_status === "off") {
      errors.push("triage is off");
    } else if (result.intent_status !== "classified" || typeof result.intent?.choice !== "string") {
      errors.push("triage did not classify (is Reply triage on?)");
    } else if (result.intent.choice !== expected.intent) {
      failures.push(`expected intent ${expected.intent}, got ${result.intent.choice}`);
    }
  }

  if (expected.connector !== undefined) {
    const called = connectorNames(result);
    if (expected.connector === "none") {
      if (called.length > 0) failures.push("expected no connector to be called");
    } else if (!called.includes(expected.connector)) {
      failures.push(`expected connector ${expected.connector} to be called`);
    }
  }

  const normalisedReply = normaliseForMatch(reply);
  for (const phrase of expected.contains ?? []) {
    if (!normalisedReply.includes(normaliseForMatch(phrase))) {
      failures.push(`reply does not contain "${phrase}"`);
    }
  }
  for (const phrase of expected.avoids ?? []) {
    if (normalisedReply.includes(normaliseForMatch(phrase))) {
      failures.push(`reply contains "${phrase}"`);
    }
  }

  if (expected.escalates === true && result.escalated !== true) failures.push("expected a handoff");
  if (expected.escalates === false && result.escalated === true) failures.push("expected no handoff");

  if (errors.length > 0) return { verdict: "errored", reasons: [...errors, ...failures] };
  if (failures.length > 0) return { verdict: "failed", reasons: failures };
  return { verdict: "passed", reasons: [] };
}

export function replyExcerpt(reply: unknown): string | null {
  if (typeof reply !== "string") return null;
  const trimmed = reply.trim();
  if (!trimmed) return null;
  return trimmed.length > 180 ? `${trimmed.slice(0, 180)}…` : trimmed;
}

export function summariseResults(results: Array<{
  verdict: TestVerdict;
  used_model: string | null;
  intent_status: IntentStatus | null;
}>): {
  passed: number;
  failed: number;
  errored: number;
  indeterminate: number;
  no_assertions: number;
  used_models: string[];
  triage_states: IntentStatus[];
} {
  const summary = {
    passed: 0,
    failed: 0,
    errored: 0,
    indeterminate: 0,
    no_assertions: 0,
    used_models: [] as string[],
    triage_states: [] as IntentStatus[],
  };
  const models = new Set<string>();
  const states = new Set<IntentStatus>();
  for (const result of results) {
    summary[result.verdict] += 1;
    if (result.used_model) models.add(result.used_model);
    if (result.intent_status) states.add(result.intent_status);
  }
  summary.used_models = [...models];
  summary.triage_states = [...states];
  return summary;
}

export function compareRuns(
  previous: Array<{ case_id: string; verdict: TestVerdict }> | null,
  current: Array<{ case_id: string; verdict: TestVerdict }>,
): { newlyFailing: string[]; newlyPassing: string[] } {
  if (!previous) return { newlyFailing: [], newlyPassing: [] };
  const prior = new Map(previous.map((row) => [row.case_id, row.verdict]));
  const newlyFailing: string[] = [];
  const newlyPassing: string[] = [];
  for (const row of current) {
    const before = prior.get(row.case_id);
    if (before === "passed" && row.verdict === "failed") newlyFailing.push(row.case_id);
    if (before === "failed" && row.verdict === "passed") newlyPassing.push(row.case_id);
  }
  return { newlyFailing, newlyPassing };
}

export function displayRunStatus(
  status: "running" | "completed" | "interrupted",
  startedAt: string,
  now: number,
  staleMs: number,
): "running" | "completed" | "interrupted" {
  if (status !== "running") return status;
  const started = Date.parse(startedAt);
  if (!Number.isFinite(started) || now - started > staleMs) return "interrupted";
  return "running";
}

/** Hyphens removed and truncated so `${compact}-${index}` stays within 64 characters. */
export function testCaseKey(runId: string, caseIndex: number): string {
  const compact = runId.replace(/-/g, "").slice(0, 32);
  const key = `${compact}-${caseIndex}`;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) {
    throw new Error("Invalid test_case_key");
  }
  return key;
}

export function testThreadId(platform: string, accountId: string, key: string): string {
  return `test_${platform}_${accountId}_${key}`;
}

/** Positions survive deletes, so a new case goes after the highest one, not at cases.length. */
export function nextCasePosition(cases: ReadonlyArray<{ position: number }>): number {
  return cases.reduce((highest, testCase) => Math.max(highest, testCase.position + 1), 0);
}
