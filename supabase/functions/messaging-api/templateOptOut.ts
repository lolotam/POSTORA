// Operator template sends (messaging-api) stop for messaging_opt_outs.
// Free-form session messages never call this. A failed lookup does not send.
import { digitsOnly, logSendRefused, optedOutPhones, type OptOutLookupAdmin } from "../_shared/optOutLookup.ts";

export type OperatorTemplateAction = "whatsapp_send_message" | "whatsapp_send_template";

export type GracefulError = (message: string, errorType: string) => Response;

const OPTED_OUT_MESSAGE = "This customer has opted out of WhatsApp messages. Templates cannot be sent to them.";
const INVALID_RECIPIENT_MESSAGE = "The recipient is not a valid WhatsApp phone number.";
const LOOKUP_FAILED_MESSAGE = "WhatsApp opt-out status could not be checked. The template was not sent.";

interface TemplateRefusal {
  message: string;
  errorType: "INVALID_RECIPIENT" | "RECIPIENT_OPTED_OUT" | "OPT_OUT_LOOKUP_FAILED";
}

/** 8–15 digits. An @lid (or any address containing '@') is never a phone. */
function recipientDigits(recipientPhone: string): string | null {
  if (recipientPhone.includes("@")) return null;
  const digits = digitsOnly(recipientPhone);
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

async function templateOptOutRefusal(
  admin: OptOutLookupAdmin,
  input: { ownerId: string; recipientPhone: string; action: OperatorTemplateAction },
): Promise<TemplateRefusal | null> {
  const digits = recipientDigits(input.recipientPhone);
  if (!digits) {
    return { message: INVALID_RECIPIENT_MESSAGE, errorType: "INVALID_RECIPIENT" };
  }

  let optedOut: Set<string>;
  try {
    optedOut = await optedOutPhones(admin, input.ownerId, [input.recipientPhone]);
  } catch (err) {
    // optedOutPhones throws this when the read fails. Anything else is a bug
    // and must still not reach the provider, so the caller sees a throw
    // before `send` — but only this known failure is a logged refusal.
    if (!(err instanceof Error) || err.message !== "opt_out_lookup_failed") throw err;
    await logSendRefused(admin, {
      source: "messaging-api",
      userId: input.ownerId,
      reason: "opt_out_lookup_failed",
      metadata: { action: input.action },
    });
    return { message: LOOKUP_FAILED_MESSAGE, errorType: "OPT_OUT_LOOKUP_FAILED" };
  }

  if (!optedOut.has(digits)) return null;
  await logSendRefused(admin, {
    source: "messaging-api",
    userId: input.ownerId,
    reason: "opted_out",
    metadata: { action: input.action },
  });
  return { message: OPTED_OUT_MESSAGE, errorType: "RECIPIENT_OPTED_OUT" };
}

/**
 * Runs `send` only when this owner has no opt-out for the recipient.
 * `ownerId` is the WhatsApp account owner, including when a workspace member
 * is the signed-in caller. Returns the provider result, or a graceful error
 * Response when the template must not be sent.
 */
export async function refuseOptedOutTemplate<T>(
  admin: OptOutLookupAdmin,
  input: { ownerId: string; recipientPhone: string; action: OperatorTemplateAction },
  gracefulError: GracefulError,
  send: () => Promise<T>,
): Promise<Response | T> {
  const refusal = await templateOptOutRefusal(admin, input);
  if (refusal) return gracefulError(refusal.message, refusal.errorType);
  return send();
}

/** `whatsapp_send_message`: templates go through the opt-out gate; text does not. */
export async function sendOperatorWhatsAppMessage<T>(
  admin: OptOutLookupAdmin,
  input: { ownerId: string; recipientPhone: string; messageType: string | undefined },
  gracefulError: GracefulError,
  send: () => Promise<T>,
): Promise<Response | T> {
  if (input.messageType === "template") {
    return refuseOptedOutTemplate(admin, {
      ownerId: input.ownerId,
      recipientPhone: input.recipientPhone,
      action: "whatsapp_send_message",
    }, gracefulError, send);
  }
  return send();
}
