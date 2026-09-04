import type { AiAgentConfigInput } from "@/hooks/useAiAgentConfig";

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
