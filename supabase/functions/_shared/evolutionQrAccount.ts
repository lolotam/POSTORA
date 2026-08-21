// Both the CONNECTION_UPDATE webhook and the QR status poller decide when an
// evolution_qr account becomes usable. The rule lives here so the two paths cannot
// drift and store different platform_user_id values for the same linked session --
// conversation ids are built from that value, so a mismatch would split a chat in two.

export interface EvolutionQrAccount {
  id: string;
  platform_user_id: string;
}

// Evolution names the linked account differently per source: `wuid` on a
// connection.update webhook, `ownerJid` on fetchInstances. Both carry the same
// "<number>@s.whatsapp.net" form.
function extractOwnerJid(source: any): string | null {
  const jid = source?.wuid ?? source?.ownerJid ?? source?.wid ?? source?.user?.id ?? source?.jid;
  return typeof jid === "string" && jid.length > 0 ? jid : null;
}

// Without this the UI falls back to rendering the raw JID as the account name.
function extractProfileName(source: any): string | null {
  const name = source?.profileName;
  return typeof name === "string" && name.length > 0 ? name : null;
}

// Every other connection mode stores platform_user_id as digits, and the inbox reads
// that form back to build conversation ids, resolve the reply recipient and decide
// which bubbles are ours. Evolution reports "<number>[:<device>]@s.whatsapp.net", so
// the number is extracted rather than the JID stored verbatim. Anything that is not a
// plain number is rejected instead of being trimmed into a plausible-looking one.
function ownerNumberFromJid(jid: string): string | null {
  const local = jid.split("@")[0].split(":")[0];
  return /^\d{5,}$/.test(local) ? local : null;
}

// Returns the owner number now stored for the account. Callers need it because activation
// replaces a provisional "pending_<uuid>" placeholder, and anything that builds conversation
// ids straight afterwards would otherwise use the stale value it passed in -- writing a whole
// history import under ids no reply path can parse.
export async function syncEvolutionAccountConnection(
  admin: any,
  account: EvolutionQrAccount,
  state: string,
  identity: unknown,
): Promise<string> {
  const connection = state.toLowerCase();
  if (connection === "close") {
    await admin.from("social_accounts").update({ is_active: false }).eq("id", account.id);
    return account.platform_user_id;
  }
  if (connection !== "open") return account.platform_user_id;

  const updates: Record<string, unknown> = { is_active: true };
  const ownerJid = extractOwnerJid(identity);
  const ownerNumber = ownerJid ? ownerNumberFromJid(ownerJid) : null;
  if (ownerNumber && account.platform_user_id.startsWith("pending_")) {
    updates.platform_user_id = ownerNumber;
  }
  const profileName = extractProfileName(identity);
  if (profileName) updates.platform_username = profileName;
  await admin.from("social_accounts").update(updates).eq("id", account.id);
  return (updates.platform_user_id as string) ?? account.platform_user_id;
}
