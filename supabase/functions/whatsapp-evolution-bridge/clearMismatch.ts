// Clearing the durable number_mismatch flag when a fresh reconnect QR is issued: the
// flag blocks a refused phone, and issuing a new QR is what gives the right phone the
// chance to lift it. Extracted from index.ts so the ownership scoping is testable on
// its own.
// The admin seam is the service-role Supabase client, same as the sibling bridge
// modules; every operation here filters by the caller's user id AND the account id, so
// a guessed account id can never touch another user's row.
export async function clearMismatchFor(admin: any, userId: string, accountId: string): Promise<void> {
  const { data, error } = await admin
    .from("social_accounts")
    .select("account_metadata")
    .eq("id", accountId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  const stored = data?.account_metadata;
  // No row (or no flag) is nothing to clear; building the update anyway would write
  // identical state and bump updated_at for no reason.
  if (!stored || typeof stored !== "object" || Array.isArray(stored) || stored.number_mismatch === undefined) return;
  const metadata = { ...(stored as Record<string, unknown>) };
  delete metadata.number_mismatch;
  const { error: updateError } = await admin
    .from("social_accounts")
    .update({ account_metadata: metadata })
    .eq("id", accountId)
    .eq("user_id", userId);
  if (updateError) throw updateError;
}
