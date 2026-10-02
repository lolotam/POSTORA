// Clearing the durable number_mismatch flag when a fresh reconnect QR is issued: the
// flag blocks a refused phone, and issuing a new QR is what gives the right phone the
// chance to lift it. Extracted from index.ts so the ownership scoping is testable on
// its own.
// The clear runs through the SECURITY DEFINER RPC with the caller's user id as the
// tenant scope, so a guessed account id can never touch another user's row, and only
// the number_mismatch key changes -- atomically, so a concurrent account_metadata
// write between a read and a whole-object write can no longer be overwritten.
export async function clearMismatchFor(admin: any, userId: string, accountId: string): Promise<void> {
  const { error } = await admin.rpc("clear_whatsapp_number_mismatch", {
    p_account_id: accountId,
    p_user_id: userId,
    p_workspace_id: null,
  });
  if (error) throw error;
}
