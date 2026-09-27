// The phone an Evolution opt-out is stored under. Pure: the webhook handler
// cannot be imported (it starts a server), and the raw JID is the wrong address
// once WhatsApp sends an @lid with the subscriber number on remoteJidAlt.
import { buildEvolutionMessageRow, type EvolutionMessageAccount } from "../_shared/evolutionMessage.ts";

export function evolutionOptOutTarget(
  account: EvolutionMessageAccount,
  message: unknown,
): { phone: string; conversationId: string } | null {
  const built = buildEvolutionMessageRow(account, message);
  if (!built || built.sentByOwner) return null;
  const phone = built.row.from_phone;
  if (typeof phone !== "string" || phone.length === 0) return null;
  return { phone, conversationId: built.conversationId };
}
