// Shared teardown for a refused phone: one module owns the "kill the remote session"
// step so the bridge poll, the partner pairing poll and the webhook cannot drift into
// three slightly different mismatch states. The refusal itself -- the account flag and
// the instance state -- is recorded by the flag RPC inside its tenant-scoped
// transaction; this handler only stops the session from answering further polls.

interface MismatchApi {
  logout(instanceName: string): Promise<unknown>;
}

export async function handleNumberMismatch(
  api: MismatchApi,
  input: { instanceName: string },
): Promise<void> {
  try {
    await api.logout(input.instanceName);
  } catch {
    // Provider error text can carry internal hosts, and phone numbers never belong in
    // a log; the instance name identifies the session for anyone diagnosing it.
    console.error(`[whatsapp] instance ${input.instanceName}: mismatch logout failed`);
  }
}
