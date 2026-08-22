import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { callMessagingApi } from "@/lib/messagingApi";
import { normalizeE164Phone } from "@/lib/phone";

export type AiAgentPlatform = "whatsapp" | "facebook" | "instagram" | "threads";
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
  language_mode: AiAgentLanguageMode;
  model: string;
  fallback_model_1: string | null;
  fallback_model_2: string | null;
  temperature: number;
  admin_phone_numbers: string[];
  daily_message_cap: number;
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
  "language_mode",
  "model",
  "fallback_model_1",
  "fallback_model_2",
  "temperature",
  "admin_phone_numbers",
  "daily_message_cap",
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

export function useAiAgentConfig(platform: AiAgentPlatform = "whatsapp") {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["ai-agent-config", platform],
    queryFn: async () => {
      const data = await callMessagingApi("ai_get_config", { platform });
      return (data.config || null) as AiAgentConfig | null;
    },
    enabled: !!session,
  });

  const upsertConfig = useMutation({
    mutationFn: async (input: AiAgentConfigInput) => {
      const data = await callMessagingApi("ai_upsert_config", {
        platform,
        config: buildAiAgentConfigPayload(input),
      });
      return data.config as AiAgentConfig;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["ai-agent-config", platform] }),
  });

  return { config: query.data, isLoading: query.isLoading, error: query.error, upsertConfig };
}