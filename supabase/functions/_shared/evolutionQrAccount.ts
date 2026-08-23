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

// A user-chosen connection name is rejected rather than silently substituted: a
// substituted name would be attributed to the user's choice and shown as the account
// label everywhere the inbox renders it.
export function normalizeConnectionName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 60) return null;
  return trimmed;
}

// Merges the chosen name into existing metadata on the display_name key only. Creation
// builds fresh metadata with the consent trail; every later merge keeps what is there.
export function mergeDisplayName(
  metadata: Record<string, unknown>,
  name: string,
): Record<string, unknown> {
  return { ...metadata, display_name: name };
}

// Owner-scoped lookup for every user-initiated bridge action. The user_id term in the
// query IS the tenant boundary: an account id belonging to another user resolves to
// null, so no action can name its way into someone else's account. Kept here so the
// name feature cannot grow a generic update path that bypasses it.
export interface OwnedEvolutionAccount extends EvolutionQrAccount {
  user_id: string;
  workspace_id: string | null;
  platform: string;
  connection_mode: string | null;
  platform_username: string | null;
  is_active: boolean;
}

export async function findOwnedEvolutionAccount(
  admin: any,
  userId: string,
  socialAccountId: string,
): Promise<OwnedEvolutionAccount | null> {
  const { data, error } = await admin
    .from("social_accounts")
    .select("id, user_id, workspace_id, platform, connection_mode, platform_user_id, platform_username, is_active")
    .eq("id", socialAccountId)
    .eq("user_id", userId)
    .eq("platform", "whatsapp")
    .maybeSingle();
  if (error) throw error;
  return (data as OwnedEvolutionAccount | null) ?? null;
}

// The user-chosen-name marker lives in account_metadata, and syncEvolutionAccountConnection
// is the only writer of platform_username on the WhatsApp path -- but it has three call
// sites (bridge open, bridge close reconciliation, webhook connection.update). Reading the
// metadata there rather than taking it as an argument means no caller can silently omit it
// and let the phone profile clobber the user's name on a reconnect.
async function loadAccountMetadata(
  admin: any,
  accountId: string,
): Promise<Record<string, unknown>> {
  const { data, error } = await admin
    .from("social_accounts")
    .select("account_metadata")
    .eq("id", accountId)
    .maybeSingle();
  if (error) throw error;
  const stored = data?.account_metadata;
  return stored && typeof stored === "object" && !Array.isArray(stored)
    ? { ...(stored as Record<string, unknown>) }
    : {};
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
    const { error } = await admin
      .from("social_accounts")
      .update({ is_active: false })
      .eq("id", account.id);
    if (error) throw error;
    return account.platform_user_id;
  }
  if (connection !== "open") return account.platform_user_id;

  const updates: Record<string, unknown> = { is_active: true };
  const ownerJid = extractOwnerJid(identity);
  const ownerNumber = ownerJid ? ownerNumberFromJid(ownerJid) : null;
  const isProvisional = account.platform_user_id.startsWith("pending_");
  const metadata = await loadAccountMetadata(admin, account.id);

  // Re-pairing a different number leaves platform_user_id at the old value (the claim
  // below is gated on the pending_ placeholder), and a rename can mask that. Migration is
  // out of scope, so the mismatch is detected and flagged for follow-up instead.
  if (ownerNumber && !isProvisional && ownerNumber !== account.platform_user_id) {
    // The numbers themselves stay out of the log: these are the end user's and their
    // contact's phone numbers, and a function log is not the place for them. The account
    // id identifies the row, and account_metadata.number_mismatch is the durable record
    // for anyone diagnosing it.
    console.error(
      `[evolution-qr] account ${account.id}: the linked number does not match the stored one; ` +
        `conversations may be split across two identities`,
    );
    // Read-modify-merge on the named key: account_metadata already carries the
    // connection mode and the consent trail, and replacing the object would erase them.
    metadata.number_mismatch = true;
    updates.account_metadata = metadata;
  }

  const profileName = extractProfileName(identity);
  if (profileName && !metadata.display_name) {
    updates.platform_username = profileName;
  }
  // This write used to be issued without looking at its result. Claiming the owner number
  // through it could raise 23505 against
  // social_accounts_user_id_platform_platform_user_id_key when the same phone was already
  // linked, and the discarded error left the connection inactive on its pending_ id with
  // nothing logged anywhere -- the QR screen simply never finished.
  const { error: updateError } = await admin
    .from("social_accounts")
    .update(updates)
    .eq("id", account.id);
  if (updateError) throw updateError;

  // Only a provisional row takes on an identity. A row that already resolved to a number
  // keeps it even when a different phone pairs into the session -- the mismatch flag above
  // is the record of that, because rewriting the number would orphan every conversation id
  // already derived from it.
  if (!ownerNumber || !isProvisional) return account.platform_user_id;

  // Identity is claimed in SQL because resolving that collision is a multi-statement merge
  // (move the older session's messages, release its unique key, take the number) and a
  // half-applied merge would leave two rows deriving the same conversation ids.
  const { data: claimed, error: claimError } = await admin.rpc("activate_evolution_qr_account", {
    p_account_id: account.id,
    p_owner_number: ownerNumber,
  });
  if (claimError) throw claimError;
  return (claimed as string | null) ?? account.platform_user_id;
}
