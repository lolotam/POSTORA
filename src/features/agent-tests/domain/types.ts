import { z } from "zod";

export const TEST_INTENTS = ["pricing", "order_status", "complaint", "lead", "greeting", "other"] as const;

export const testExpectationSchema = z.object({
  intent: z.enum(TEST_INTENTS).optional(),
  connector: z.string().trim().min(1).max(100).optional(),
  contains: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
  avoids: z.array(z.string().trim().min(1).max(200)).max(10).optional(),
  escalates: z.boolean().optional(),
}).strict();

export type TestExpectation = z.infer<typeof testExpectationSchema>;

export const testCaseInputSchema = z.object({
  message: z.string().trim().min(1).max(2000),
  expected: testExpectationSchema,
});

export type TestVerdict = "passed" | "failed" | "errored" | "indeterminate" | "no_assertions";
export type IntentStatus = "off" | "uncertain" | "classified";
export type RunStatus = "running" | "completed" | "interrupted";

export interface TestCase {
  id: string;
  userId: string;
  socialAccountId: string;
  platform: string;
  message: string;
  expected: TestExpectation;
  position: number;
  expectationValid: boolean;
}

export interface SandboxReply {
  ok?: boolean;
  reply?: unknown;
  skipped?: unknown;
  error?: unknown;
  escalated?: boolean;
  tool_calls?: Array<{ name?: string }>;
  intent?: { choice?: string; confidence?: number } | null;
  intent_status?: IntentStatus;
  used_model?: string | null;
}

/** One checkpointed case. `expected` is the expectation as it ran. */
export interface CaseResult {
  case_id: string;
  expected: TestExpectation;
  verdict: TestVerdict;
  reasons: string[];
  reply_excerpt: string | null;
  intent: { choice: string; confidence: number } | null;
  intent_status: IntentStatus | null;
  tool_calls: string[];
  escalated: boolean;
  used_model: string | null;
}

export interface RunSummary {
  passed: number;
  failed: number;
  errored: number;
  indeterminate: number;
  no_assertions: number;
  used_models: string[];
  triage_states: IntentStatus[];
}

export interface TestRun {
  id: string;
  status: RunStatus;
  startedAt: string;
  finishedAt: string | null;
  summary: RunSummary;
  results: CaseResult[];
}

export const MAX_CASES_PER_RUN = 25;
export const CASE_TIMEOUT_MS = 70_000;
export const STALE_RUN_MS = 30 * 60 * 1000;
