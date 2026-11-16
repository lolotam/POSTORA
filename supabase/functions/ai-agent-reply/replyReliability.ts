import { POST_TOOL_RESERVE_MS } from "../_shared/connectorBudgets.ts";
import { iterationBudget, type ReplyLanguage } from "./logic.ts";

export type ReplyRoundMode = "tools" | "text_only" | "stop";
export type SynthesisReason = "round_reserved" | "time_reserve" | "procedure_completion";

export function replyRoundPolicy(input: {
  configuredLimit: number;
  iteration: number;
  procedureActive: boolean;
  procedureToolRanOnLastRound: boolean;
  remainingModelMs: number;
}): { mode: ReplyRoundMode; synthesisReason: SynthesisReason | null } {
  if (input.remainingModelMs <= 0) return { mode: "stop", synthesisReason: null };

  const procedureRound = input.procedureActive || input.procedureToolRanOnLastRound;
  let mode: ReplyRoundMode;
  if (procedureRound) {
    mode = iterationBudget(
      input.configuredLimit,
      input.procedureToolRanOnLastRound,
      input.iteration,
    );
  } else {
    const limit = Math.max(1, input.configuredLimit);
    mode = input.iteration < limit - 1
      ? "tools"
      : input.iteration === limit - 1
      ? "text_only"
      : "stop";
  }

  if (mode === "tools" && input.remainingModelMs <= POST_TOOL_RESERVE_MS) {
    return { mode: "text_only", synthesisReason: "time_reserve" };
  }
  return {
    mode,
    synthesisReason: mode === "text_only"
      ? procedureRound ? "procedure_completion" : "round_reserved"
      : null,
  };
}

export function modelCallBudget(remainingModelMs: number, mode: ReplyRoundMode): number {
  if (mode === "stop") return 0;
  return Math.max(0, remainingModelMs - (mode === "tools" ? POST_TOOL_RESERVE_MS : 0));
}

export function finalSynthesisInstruction(): string {
  return "Final synthesis round. No tools are available. Answer concisely using only evidence already present in this conversation. If required verification is incomplete or a lookup failed, say so honestly; never infer current price, stock, a completed action, or a handoff.";
}

export function limitationText(language: ReplyLanguage): string {
  return language === "ar"
    ? "تعذّر إكمال التحقق الآن. يُرجى المحاولة مرة أخرى بعد قليل."
    : "I couldn’t complete verification just now. Please try again shortly.";
}
