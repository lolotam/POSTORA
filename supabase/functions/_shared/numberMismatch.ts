// Shared teardown for a refused phone: one module owns the "kill the remote session and
// record why" sequence so the bridge poll, the partner pairing poll and the webhook cannot
// drift into three slightly different mismatch states.

// The admin seam is the Supabase service client, spelled structurally so this module
// neither takes an explicit-any nor imports its callers' types.
interface MismatchAdmin {
  from(table: string): {
    update(values: Record<string, unknown>): {
      eq(column: string, value: unknown): Promise<{ error: unknown }>;
    };
  };
}

interface MismatchApi {
  logout(instanceName: string): Promise<unknown>;
}

export async function handleNumberMismatch(
  admin: MismatchAdmin,
  api: MismatchApi,
  input: { accountId: string; instanceName: string },
): Promise<void> {
  try {
    await api.logout(input.instanceName);
  } catch {
    // Provider error text can carry internal hosts; the account id is enough to find it,
    // and the phone numbers themselves never belong in a log.
    console.error(`[whatsapp] account ${input.accountId}: mismatch logout failed`);
  }
  const { error } = await admin
    .from("whatsapp_evolution_instances")
    .update({ last_connection_state: "number_mismatch" })
    .eq("social_account_id", input.accountId);
  if (error) throw error;
}
