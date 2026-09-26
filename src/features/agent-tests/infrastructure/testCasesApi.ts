import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { testExpectationSchema } from "../domain/types";
import type {
  CaseResult,
  IntentStatus,
  RunStatus,
  RunSummary,
  TestCase,
  TestExpectation,
  TestRun,
  TestVerdict,
} from "../domain/types";
import { callEdgeApi } from "@/lib/messagingApi";
import type { SandboxReply } from "../domain/types";

function asJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseExpected(value: unknown): { expected: TestExpectation; expectationValid: boolean } {
  const parsed = testExpectationSchema.safeParse(value ?? {});
  if (!parsed.success) return { expected: {}, expectationValid: false };
  return { expected: parsed.data, expectationValid: true };
}

function parseVerdict(value: unknown): TestVerdict {
  if (value === "passed" || value === "failed" || value === "errored" || value === "indeterminate" || value === "no_assertions") {
    return value;
  }
  return "errored";
}

function parseIntentStatus(value: unknown): IntentStatus | null {
  if (value === "off" || value === "uncertain" || value === "classified") return value;
  return null;
}

function parseResult(value: unknown): CaseResult | null {
  if (!isRecord(value) || typeof value.case_id !== "string") return null;
  const expected = parseExpected(value.expected);
  const intent = isRecord(value.intent) && typeof value.intent.choice === "string" && typeof value.intent.confidence === "number"
    ? { choice: value.intent.choice, confidence: value.intent.confidence }
    : null;
  return {
    case_id: value.case_id,
    expected: expected.expected,
    verdict: parseVerdict(value.verdict),
    reasons: Array.isArray(value.reasons) ? value.reasons.filter((reason): reason is string => typeof reason === "string") : [],
    reply_excerpt: typeof value.reply_excerpt === "string" ? value.reply_excerpt : null,
    intent,
    intent_status: parseIntentStatus(value.intent_status),
    tool_calls: Array.isArray(value.tool_calls) ? value.tool_calls.filter((name): name is string => typeof name === "string") : [],
    escalated: value.escalated === true,
    used_model: typeof value.used_model === "string" ? value.used_model : null,
  };
}

function emptySummary(): RunSummary {
  return { passed: 0, failed: 0, errored: 0, indeterminate: 0, no_assertions: 0, used_models: [], triage_states: [] };
}

function parseSummary(value: unknown): RunSummary {
  if (!isRecord(value)) return emptySummary();
  const count = (key: keyof RunSummary) => typeof value[key] === "number" ? value[key] as number : 0;
  return {
    passed: count("passed"),
    failed: count("failed"),
    errored: count("errored"),
    indeterminate: count("indeterminate"),
    no_assertions: count("no_assertions"),
    used_models: Array.isArray(value.used_models) ? value.used_models.filter((model): model is string => typeof model === "string") : [],
    triage_states: Array.isArray(value.triage_states)
      ? value.triage_states.filter((state): state is IntentStatus => state === "off" || state === "uncertain" || state === "classified")
      : [],
  };
}

function parseStatus(value: unknown): RunStatus {
  if (value === "running" || value === "completed" || value === "interrupted") return value;
  return "interrupted";
}

export async function listTestCases(accountId: string, platform: string): Promise<TestCase[]> {
  const { data, error } = await supabase
    .from("ai_agent_test_cases")
    .select("id, user_id, social_account_id, platform, message, expected, position")
    .eq("social_account_id", accountId)
    .eq("platform", platform)
    .order("position", { ascending: true });
  if (error) throw error;
  return (data ?? []).map((row) => {
    const expected = parseExpected(row.expected);
    return {
      id: row.id,
      userId: row.user_id,
      socialAccountId: row.social_account_id,
      platform: row.platform,
      message: row.message,
      expected: expected.expected,
      position: row.position,
      expectationValid: expected.expectationValid,
    };
  });
}

export async function insertTestCase(input: {
  userId: string;
  socialAccountId: string;
  platform: string;
  message: string;
  expected: TestExpectation;
  position: number;
}): Promise<void> {
  const { error } = await supabase.from("ai_agent_test_cases").insert({
    user_id: input.userId,
    social_account_id: input.socialAccountId,
    platform: input.platform,
    message: input.message,
    expected: asJson(input.expected),
    position: input.position,
  });
  if (error) throw error;
}

export async function updateTestCase(id: string, input: {
  message: string;
  expected: TestExpectation;
  socialAccountId: string;
  platform: string;
}): Promise<void> {
  const { error } = await supabase.from("ai_agent_test_cases").update({
    message: input.message,
    expected: asJson(input.expected),
  }).eq("id", id).eq("social_account_id", input.socialAccountId).eq("platform", input.platform);
  if (error) throw error;
}

export async function deleteTestCase(id: string, scope: { socialAccountId: string; platform: string }): Promise<void> {
  const { error } = await supabase
    .from("ai_agent_test_cases")
    .delete()
    .eq("id", id)
    .eq("social_account_id", scope.socialAccountId)
    .eq("platform", scope.platform);
  if (error) throw error;
}

export async function listTestRuns(accountId: string, platform: string): Promise<TestRun[]> {
  const { data, error } = await supabase
    .from("ai_agent_test_runs")
    .select("id, status, started_at, finished_at, summary, results")
    .eq("social_account_id", accountId)
    .eq("platform", platform)
    .order("started_at", { ascending: false });
  if (error) throw error;
  return (data ?? []).map((row) => ({
    id: row.id,
    status: parseStatus(row.status),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    summary: parseSummary(row.summary),
    results: Array.isArray(row.results) ? row.results.map(parseResult).filter((row): row is CaseResult => row !== null) : [],
  }));
}

export async function insertRun(input: {
  userId: string;
  socialAccountId: string;
  platform: string;
}): Promise<{ id: string }> {
  const { data, error } = await supabase.from("ai_agent_test_runs").insert({
    user_id: input.userId,
    social_account_id: input.socialAccountId,
    platform: input.platform,
    status: "running",
    summary: asJson(emptySummary()),
    results: [],
  }).select("id").single();
  if (error) throw error;
  return { id: data.id };
}

export async function updateRun(id: string, patch: {
  status: RunStatus;
  finishedAt: string | null;
  summary: RunSummary;
  results: CaseResult[];
}): Promise<void> {
  const { error } = await supabase.from("ai_agent_test_runs").update({
    status: patch.status,
    finished_at: patch.finishedAt,
    summary: asJson(patch.summary),
    results: asJson(patch.results),
  }).eq("id", id);
  if (error) throw error;
}

/** Exact conversation ids only. A prefix delete would remove the shared sandbox thread. */
export async function deleteRunThreads(input: {
  userId: string;
  platform: string;
  conversationIds: string[];
}): Promise<void> {
  if (input.conversationIds.length === 0) return;
  const { error } = await supabase
    .from("ai_threads")
    .delete()
    .eq("user_id", input.userId)
    .eq("platform", input.platform)
    .in("conversation_id", input.conversationIds);
  if (error) throw error;
}

export async function runTestCase(input: {
  platform: string;
  socialAccountId: string;
  message: string;
  testCaseKey: string;
  signal: AbortSignal;
}): Promise<SandboxReply> {
  const data = await callEdgeApi("ai-agent-reply", "test", {
    platform: input.platform,
    social_account_id: input.socialAccountId,
    inbound_text: input.message,
    test_case_key: input.testCaseKey,
  }, { retry: false, signal: input.signal });
  if (!isRecord(data)) return { ok: false };
  return data as SandboxReply;
}
