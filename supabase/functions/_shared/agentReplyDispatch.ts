// The one way an inbound surface hands a message to the AI agent.
//
// Three webhooks used to carry their own copy of this POST, each with a different positional
// parameter list (the WhatsApp one had three adjacent strings a caller could transpose in
// silence) and each reading the answer by HTTP status -- which is wrong, because
// jsonResponse defaults to 200 and the agent's failures arrive as 200 {ok:false}. One
// function, one request shape, one reading of the answer.

import { type AgentReplyOutcome, parseAgentReplyResult } from "./agentReplyResult.ts";

export interface AgentReplyRequest {
  userId: string;
  platform: string;
  socialAccountId: string;
  conversationId: string;
  /** The customer's id: a PSID on Facebook/Instagram, a phone number on WhatsApp. */
  recipientId: string;
  inboundText: string;
  /** The business number. Required by the agent for WhatsApp, meaningless elsewhere. */
  phoneNumberId?: string | null;
  /** A language the caller already detected (a transcript's "ara"); beats counting. */
  languageHint?: string | null;
  /** Makes the reply a public comment reply instead of a DM. */
  commentId?: string | null;
  /** The pending_agent_replies row this request is working for. */
  outboxId?: string | null;
}

export function toAgentReplyBody(request: AgentReplyRequest): Record<string, unknown> {
  return {
    user_id: request.userId,
    platform: request.platform,
    social_account_id: request.socialAccountId,
    conversation_id: request.conversationId,
    recipient_phone: request.recipientId,
    inbound_text: request.inboundText,
    ...(request.phoneNumberId ? { phone_number_id: request.phoneNumberId } : {}),
    ...(request.languageHint ? { language_hint: request.languageHint } : {}),
    ...(request.commentId ? { comment_id: request.commentId } : {}),
    ...(request.outboxId ? { outbox_id: request.outboxId } : {}),
  };
}

/**
 * Posts to ai-agent-reply and returns what the answer MEANS.
 *
 * Never throws on the agent's own failures -- they come back as `retryable`, `permanent`
 * or `outage_handled` and the caller settles its outbox row accordingly. A network failure
 * reaching the agent at all is the one thing that does propagate, because nothing about the
 * row can be said then.
 */
export async function dispatchAgentReply(
  request: AgentReplyRequest,
  fetcher: typeof fetch = fetch,
): Promise<AgentReplyOutcome> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const response = await fetcher(`${supabaseUrl}/functions/v1/ai-agent-reply`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(toAgentReplyBody(request)),
  });
  const body = await response.json().catch(() => null);
  const outcome = parseAgentReplyResult(response.status, body);
  if (outcome.kind === "retryable" || outcome.kind === "permanent") {
    console.error(`[agent-dispatch] ${request.platform} reply ${outcome.kind}: ${outcome.detail}`);
  }
  return outcome;
}
