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

export async function syncEvolutionAccountConnection(
  admin: any,
  account: EvolutionQrAccount,
  state: string,
  identity: unknown,
): Promise<void> {
  const connection = state.toLowerCase();
  if (connection === "close") {
    await admin.from("social_accounts").update({ is_active: false }).eq("id", account.id);
    return;
  }
  if (connection !== "open") return;

  const updates: Record<string, unknown> = { is_active: true };
  const ownerJid = extractOwnerJid(identity);
  if (ownerJid && account.platform_user_id.startsWith("pending_")) {
    updates.platform_user_id = ownerJid;
  }
  const profileName = extractProfileName(identity);
  if (profileName) updates.platform_username = profileName;
  await admin.from("social_accounts").update(updates).eq("id", account.id);
}
