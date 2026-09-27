// Pure split of a broadcast batch. Opt-out matching is digits-only; order and ids are kept.
import { digitsOnly } from "../_shared/optOutLookup.ts";

export interface SkippedRecipientUpdate {
  from(table: string): {
    update(values: { status: string; error_message: string }): {
      eq(column: string, value: string): {
        eq(column: string, value: string): {
          in(column: string, values: string[]): PromiseLike<{ error: { message?: string } | null }>;
        };
      };
    };
  };
}

export function partitionOptedOut<T extends { id: string; phone_number: string }>(
  recipients: readonly T[],
  optedOut: ReadonlySet<string>,
): { send: T[]; skipped: T[] } {
  const send: T[] = [];
  const skipped: T[] = [];
  for (const recipient of recipients) {
    if (optedOut.has(digitsOnly(recipient.phone_number))) skipped.push(recipient);
    else send.push(recipient);
  }
  return { send, skipped };
}

/** Pending rows of this broadcast only. Throws when the write does not succeed. */
export async function markRecipientsSkipped(
  admin: SkippedRecipientUpdate,
  broadcastId: string,
  ids: string[],
): Promise<void> {
  const { error } = await admin
    .from("whatsapp_broadcast_recipients")
    .update({ status: "skipped", error_message: "opted_out" })
    .eq("broadcast_id", broadcastId)
    .eq("status", "pending")
    .in("id", ids);
  if (error) throw new Error("opt_out_skip_failed");
}
