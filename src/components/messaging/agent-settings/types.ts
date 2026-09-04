import type { AiAgentConfigInput } from "@/hooks/useAiAgentConfig";
import type { AgentBehavior } from "@/lib/agentProfile";

/**
 * The shape every settings card takes.
 *
 * Cards are presentational on purpose. `AiAgentManager` owns the whole state
 * machine — `configLoaded`, the merge-on-refresh effect, the `confirm_clear`
 * computation, the dirty guard — because each of those encodes a production
 * outage (2026-08-28 blank save, 2026-08-30 blank save over a live persona, and
 * the account-switch write). A card that held its own copy of any of them would
 * reopen one of those doors.
 */
export interface AgentCardProps {
  form: AiAgentConfigInput;
  update: <K extends keyof AiAgentConfigInput>(key: K, value: AiAgentConfigInput[K]) => void;
}

/**
 * A card that writes into agent_behavior.
 *
 * `updateBehavior` MERGES. Four cards share that one jsonb column, so a setter
 * that replaced the object would make whichever card the user touched last
 * silently erase the other three.
 */
export interface BehaviorCardProps extends AgentCardProps {
  behavior: AgentBehavior;
  updateBehavior: <K extends keyof AgentBehavior>(key: K, value: AgentBehavior[K]) => void;
}
