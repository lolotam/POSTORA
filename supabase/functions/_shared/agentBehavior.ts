/**
 * How the agent should sound and what it is trying to achieve.
 *
 * Stored in `ai_agent_configs.agent_behavior` and read by `buildSystemPrompt`.
 * Every field is optional and every field is additive: an empty behavior
 * contributes nothing to the prompt, so an account that has never opened the
 * new cards keeps exactly the prompt it had before this column existed.
 *
 * Note what is NOT here. The hallucination guard and the escalate-on-unknown
 * rule stay unconditional in ai-agent-reply — they were tightened after the
 * 2026-09-01 incident where an agent answered from a persona fallback instead
 * of the connector, and a config field able to switch them off would be a
 * loaded gun in a settings form.
 */

export type AgentTone = "friendly_professional" | "formal" | "enthusiastic" | "concise";
export type AgentResponseLength = "short" | "medium" | "detailed";
export type AgentGoal =
  | "recommend_products"
  | "answer_pricing"
  | "handle_complaints"
  | "capture_leads";

export const AGENT_TONES: readonly AgentTone[] = [
  "friendly_professional",
  "formal",
  "enthusiastic",
  "concise",
];
export const AGENT_RESPONSE_LENGTHS: readonly AgentResponseLength[] = [
  "short",
  "medium",
  "detailed",
];
export const AGENT_GOALS: readonly AgentGoal[] = [
  "recommend_products",
  "answer_pricing",
  "handle_complaints",
  "capture_leads",
];

export interface AgentInstructionBlock {
  title: string;
  body: string;
}

export interface AgentBehavior {
  tone?: AgentTone;
  response_length?: AgentResponseLength;
  goals?: AgentGoal[];
  greeting?: string;
  instruction_blocks?: AgentInstructionBlock[];
}

export class AgentBehaviorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentBehaviorError";
  }
}

const BEHAVIOR_KEYS = [
  "tone",
  "response_length",
  "goals",
  "greeting",
  "instruction_blocks",
] as const;

const MAX_GREETING = 500;
const MAX_BLOCKS = 10;
const MAX_BLOCK_TITLE = 120;
const MAX_BLOCK_BODY = 2000;

function asPlainObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AgentBehaviorError(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function asBoundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string") throw new AgentBehaviorError(`${field} must be a string`);
  if (value.length > max) {
    throw new AgentBehaviorError(`${field} is limited to ${max} characters`);
  }
  return value;
}

function asMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new AgentBehaviorError(`${field} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

/**
 * De-duplicated in first-seen order.
 *
 * The order is what the prompt renders, so a stable one keeps the same config
 * producing the same prompt — otherwise two saves of an unchanged form could
 * reorder the objectives the model reads.
 */
function parseGoals(value: unknown): AgentGoal[] {
  if (!Array.isArray(value)) throw new AgentBehaviorError("goals must be an array");
  const seen = new Set<AgentGoal>();
  const goals: AgentGoal[] = [];
  for (const entry of value) {
    const goal = asMember(entry, AGENT_GOALS, "goals");
    if (!seen.has(goal)) {
      seen.add(goal);
      goals.push(goal);
    }
  }
  return goals;
}

function parseInstructionBlocks(value: unknown): AgentInstructionBlock[] {
  if (!Array.isArray(value)) {
    throw new AgentBehaviorError("instruction_blocks must be an array");
  }
  if (value.length > MAX_BLOCKS) {
    throw new AgentBehaviorError(`instruction_blocks is limited to ${MAX_BLOCKS} entries`);
  }
  return value.map((entry, index) => {
    const source = asPlainObject(entry, `instruction_blocks[${index}]`);
    for (const key of Object.keys(source)) {
      if (key !== "title" && key !== "body") {
        throw new AgentBehaviorError(`Unknown instruction_blocks key: ${key}`);
      }
    }
    return {
      title: asBoundedText(source.title, `instruction_blocks[${index}].title`, MAX_BLOCK_TITLE),
      body: asBoundedText(source.body, `instruction_blocks[${index}].body`, MAX_BLOCK_BODY),
    };
  });
}

/**
 * The behavior as the database may store it.
 *
 * Rejects rather than drops, for the same reason the business profile does: a
 * silently discarded field is one the user filled in, saved, and finds empty
 * next visit with nothing to explain it.
 */
export function parseAgentBehavior(input: unknown): AgentBehavior {
  if (input === null || input === undefined) return {};
  const source = asPlainObject(input, "agent_behavior");
  for (const key of Object.keys(source)) {
    if (!(BEHAVIOR_KEYS as readonly string[]).includes(key)) {
      throw new AgentBehaviorError(`Unknown agent_behavior key: ${key}`);
    }
  }

  const behavior: AgentBehavior = {};
  if (source.tone !== undefined) behavior.tone = asMember(source.tone, AGENT_TONES, "tone");
  if (source.response_length !== undefined) {
    behavior.response_length = asMember(
      source.response_length,
      AGENT_RESPONSE_LENGTHS,
      "response_length",
    );
  }
  if (source.goals !== undefined) behavior.goals = parseGoals(source.goals);
  if (source.greeting !== undefined) {
    behavior.greeting = asBoundedText(source.greeting, "greeting", MAX_GREETING);
  }
  if (source.instruction_blocks !== undefined) {
    behavior.instruction_blocks = parseInstructionBlocks(source.instruction_blocks);
  }
  return behavior;
}
