import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { callMessagingApi } from "@/lib/messagingApi";
import { normalizeE164Phone } from "@/lib/phone";
import type { AgentBehavior, BusinessProfile } from "@/lib/agentProfile";

export type AiAgentPlatform = "whatsapp" | "facebook" | "instagram" | "threads" | "youtube";
export type AiAgentMode = "ai_first" | "human_first" | "human_then_ai";
export type AiAgentLanguageMode = "auto" | "ar" | "en";

export interface AiAgentConfig {
  id: string;
  user_id: string;
  platform: AiAgentPlatform;
  is_enabled: boolean;
  default_mode: AiAgentMode;
  persona_instructions: string | null;
  business_profile_text: string | null;
  /** Structured input. The server renders business_profile_text from it. */
  business_profile: BusinessProfile;
  /** Tone, length, goals, greeting, instruction blocks. Read by buildSystemPrompt. */
  agent_behavior: AgentBehavior;
  language_mode: AiAgentLanguageMode;
  model: string;
  fallback_model_1: string | null;
  fallback_model_2: string | null;
  temperature: number;
  admin_phone_numbers: string[];
  daily_message_cap: number;
  escalation_timeout_minutes: number;
  reply_cooldown_seconds: number;
  max_tool_iterations: number;
  handoff_on_request: boolean;
  handoff_on_low_confidence: boolean;
  created_at: string;
  updated_at: string;
}

export type AiAgentConfigInput = Partial<Omit<AiAgentConfig, "id" | "user_id" | "platform" | "created_at" | "updated_at">>;

const CONFIG_FIELDS = [
  "is_enabled",
  "default_mode",
  "persona_instructions",
  "business_profile_text",
  "business_profile",
  "agent_behavior",
  "language_mode",
  "model",
  "fallback_model_1",
  "fallback_model_2",
  "temperature",
  "admin_phone_numbers",
  "daily_message_cap",
  "escalation_timeout_minutes",
  "reply_cooldown_seconds",
  "max_tool_iterations",
  "handoff_on_request",
  "handoff_on_low_confidence",
] as const;

export function buildAiAgentConfigPayload(input: Record<string, unknown>): AiAgentConfigInput {
  const payload: Record<string, unknown> = {};
  for (const field of CONFIG_FIELDS) {
    if (field in input) payload[field] = input[field];
  }

  if (Array.isArray(payload.admin_phone_numbers)) {
    payload.admin_phone_numbers = payload.admin_phone_numbers
      .filter((phone): phone is string => typeof phone === "string")
      .map(normalizeE164Phone)
      .filter((phone): phone is string => phone !== null);
  }

  return payload as AiAgentConfigInput;
}

export function useAiAgentConfig(platform: AiAgentPlatform = "whatsapp", socialAccountId?: string | null) {
  const { session, user } = useAuth();
  const queryClient = useQueryClient();
  // Keyed by user id so a cache written by one login is never served to
  // another after a same-tab account switch, and by account so switching the
  // account selector reads the selected account's config instead of flashing
  // the previous account's persona. null (no account named) is its own key
  // element on purpose -- a fixed-shape key stays unambiguous.
  const query = useQuery({
    queryKey: ["ai-agent-config", user?.id, platform, socialAccountId ?? null],
    queryFn: async () => {
      // JSON.stringify drops undefined keys, so an absent account travels
      // exactly as it did before the parameter existed.
      const data = await callMessagingApi("ai_get_config", {
        platform,
        social_account_id: socialAccountId ?? undefined,
      });
      return (data.config || null) as AiAgentConfig | null;
    },
    enabled: !!session,
  });

  const upsertConfig = useMutation({
    // confirm_clear widens the input rather than being cast at the call site: an
    // object literal carrying a property absent from AiAgentConfigInput trips
    // TypeScript's excess-property check whatever `strict` says.
    mutationFn: async (input: AiAgentConfigInput & { confirm_clear?: boolean }) => {
      const data = await callMessagingApi("ai_upsert_config", {
        platform,
        social_account_id: socialAccountId ?? undefined,
        // Travels beside `config`, which is where the server reads it.
        // buildAiAgentConfigPayload filters to CONFIG_FIELDS, so the flag can
        // never reach the column payload.
        confirm_clear: input.confirm_clear,
        config: buildAiAgentConfigPayload(input),
      });
      return data.config as AiAgentConfig;
    },
    // The written account's exact key, not the platform prefix. Both the settings
    // form and the knowledge tab read this same entry, so a prefix invalidation
    // made a write from one tab refetch -- and reset -- the other. Every other
    // account's cached entry is still accurate after an account-scoped write.
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: ["ai-agent-config", user?.id, platform, socialAccountId ?? null],
      }),
  });

  return { config: query.data, isLoading: query.isLoading, error: query.error, upsertConfig };
}