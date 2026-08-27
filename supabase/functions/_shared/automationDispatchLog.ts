// The n8n half of the agent activity log. `ai_agent_logs` records what the Postora agent
// did; nothing recorded what the n8n handler did, so an account on "n8n" showed an empty
// log and a silent workflow looked identical to a working one.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { N8nEnvelope } from "./n8nMessagingDispatch.ts";

export interface DispatchLogSubject {
  conversationId: string | null;
  inboundText: string | null;
}

function readString(source: unknown, key: string): string | null {
  if (!source || typeof source !== "object") return null;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" && value ? value : null;
}

/**
 * What to show for one dispatched envelope: the thread it belongs to and what the customer
 * said. Pure, because the two envelope shapes name these differently and getting it wrong
 * shows the wrong customer's message next to the wrong conversation.
 *
 * A message carries `conversation_id` and `message.text`; a comment has no conversation of
 * its own, so its own id stands in — the same key the internal handler threads comments by.
 */
export function describeDispatchSubject(payload: N8nEnvelope): DispatchLogSubject {
  const comment = (payload as { comment?: unknown }).comment;
  if (comment) {
    return { conversationId: readString(comment, "id"), inboundText: readString(comment, "text") };
  }
  return {
    conversationId: readString(payload, "conversation_id"),
    inboundText: readString((payload as { message?: unknown }).message, "text"),
  };
}

/**
 * Best-effort. A log write must never cost a delivery: the caller has already handed the
 * event to the user's workflow by the time this runs, and throwing here would surface as a
 * dispatch failure that never happened.
 */
export async function recordN8nDispatch(
  adminClient: any,
  userId: string,
  payload: N8nEnvelope,
  destinationCount: number,
): Promise<void> {
  const { conversationId, inboundText } = describeDispatchSubject(payload);
  try {
    const { error } = await adminClient.from("automation_dispatch_log").insert({
      user_id: userId,
      social_account_id: payload.social_account_id || null,
      platform: payload.platform,
      event: payload.event,
      conversation_id: conversationId,
      inbound_text: inboundText,
      destination_count: destinationCount,
    });
    if (error) console.warn(`[n8n-dispatch] activity log write failed: ${error.message}`);
  } catch (err) {
    console.warn(`[n8n-dispatch] activity log write threw: ${(err as Error).message}`);
  }
}
