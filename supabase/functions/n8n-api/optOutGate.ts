// n8n WhatsApp sends: a customer who wrote in on this account in the last 24 hours
// is a reply and goes out as today. Outside that window, an opted-out phone is refused.
// An @lid (or any non-phone recipient) cannot be keyed in messaging_opt_outs, which stores
// the account owner's user_id plus digits-only phone — never @lid digits. Outside the
// window those recipients are allowed, and this gate does not strip digits out of an @lid.
// The 24 h check matches the recipient's own phone only: a caller-supplied conversation_id
// is not bound to the recipient, so it must not open the window for someone else.
import {
  logSendRefused,
  optedOutPhones,
  recipientDigits,
  type OptOutLookupAdmin,
  type OptOutRefusalReason,
} from "../_shared/optOutLookup.ts";

const WINDOW_MS = 24 * 60 * 60 * 1000;

const OPTED_OUT_MESSAGE =
  "This customer has opted out of WhatsApp messages and has not written in the last 24 hours.";
const LOOKUP_FAILED_MESSAGE = "WhatsApp opt-out status could not be checked. The message was not sent.";
const INBOUND_FAILED_MESSAGE = "Recent WhatsApp messages could not be checked. The message was not sent.";

export interface N8nWhatsAppSendInput {
  ownerId: string;
  accountId: string;
  recipientId: string;
  route: string;
  now: Date;
}

export interface N8nSendRefusal {
  status: 422 | 503;
  code: "RECIPIENT_OPTED_OUT" | "OPT_OUT_LOOKUP_FAILED" | "INBOUND_LOOKUP_FAILED";
  message: string;
  reason: OptOutRefusalReason;
}

type InboundAnswer = "yes" | "no" | "error";

async function inboundExists(
  admin: OptOutLookupAdmin,
  accountId: string,
  cutoff: string,
  phoneDigits: string,
): Promise<InboundAnswer> {
  try {
    const { data, error } = await admin
      .from("whatsapp_messages")
      .select("id")
      .eq("social_account_id", accountId)
      .eq("direction", "inbound")
      .eq("from_phone", phoneDigits)
      .gte("timestamp", cutoff)
      .limit(1);
    if (error) return "error";
    return Array.isArray(data) && data.length > 0 ? "yes" : "no";
  } catch {
    return "error";
  }
}

async function refuse(
  admin: OptOutLookupAdmin,
  input: N8nWhatsAppSendInput,
  refusal: N8nSendRefusal,
): Promise<N8nSendRefusal> {
  await logSendRefused(admin, {
    source: "n8n-api",
    userId: input.ownerId,
    reason: refusal.reason,
    metadata: { route: input.route, social_account_id: input.accountId },
  });
  return refusal;
}

/**
 * `null` means send. A refusal is returned before any provider call.
 * A failed read is a refusal: unknown inbound or opt-out state never sends.
 */
export async function n8nWhatsAppSendRefusal(
  admin: OptOutLookupAdmin,
  input: N8nWhatsAppSendInput,
): Promise<N8nSendRefusal | null> {
  const cutoff = new Date(input.now.getTime() - WINDOW_MS).toISOString();
  const digits = recipientDigits(input.recipientId);

  if (digits) {
    const byPhone = await inboundExists(admin, input.accountId, cutoff, digits);
    if (byPhone === "error") {
      return refuse(admin, input, {
        status: 503,
        code: "INBOUND_LOOKUP_FAILED",
        message: INBOUND_FAILED_MESSAGE,
        reason: "inbound_lookup_failed",
      });
    }
    if (byPhone === "yes") return null;
  }

  // No recent inbound. A non-phone recipient (for example an @lid) has no opt-out key.
  if (!digits) return null;

  let optedOut: Set<string>;
  try {
    optedOut = await optedOutPhones(admin, input.ownerId, [input.recipientId]);
  } catch {
    return refuse(admin, input, {
      status: 503,
      code: "OPT_OUT_LOOKUP_FAILED",
      message: LOOKUP_FAILED_MESSAGE,
      reason: "opt_out_lookup_failed",
    });
  }

  if (!optedOut.has(digits)) return null;
  return refuse(admin, input, {
    status: 422,
    code: "RECIPIENT_OPTED_OUT",
    message: OPTED_OUT_MESSAGE,
    reason: "opted_out",
  });
}
