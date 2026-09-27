// Store-event webhook bindings (Spec B §8.1): one per WooCommerce connector, addressed by
// the webhook URL. The signing secret is returned to the caller once and never again.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { resolveToolsForAccount, type ResolvableTool, type ToolAccountLink } from "./toolResolution.ts";
import { resolveToolAccount, type ToolAdminClient, ToolWriteError } from "./toolWrites.ts";
import type { WorkspaceToolScope } from "./toolSharing.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BINDING_COLUMNS = "id, user_id, social_account_id, connector_id, secret_id, previous_secret_id, rotated_at, created_at";

export interface BindingRow {
  id: string;
  user_id: string;
  social_account_id: string;
  connector_id: string;
  secret_id: string;
  previous_secret_id: string | null;
  rotated_at: string | null;
  created_at: string;
}

export interface BindingView {
  id: string;
  social_account_id: string;
  connector_id: string;
  rotated_at: string | null;
  created_at: string;
}

export interface StoreConnector {
  id: string;
  user_id: string;
  connector_type: string | null;
  scope: "account" | "all_accounts";
  social_account_id: string | null;
  admin_only: boolean;
}

export interface StoreWebhookBindingPorts {
  /** Throws ToolWriteError 404/403 when the caller may not act for the account. */
  resolveAccount(socialAccountId: string): Promise<{ id: string; user_id: string; platform: string }>;
  loadConnector(connectorId: string): Promise<StoreConnector | null>;
  /** Links for this owner, connector, and account. A failed read throws; it is not an empty share list. */
  loadConnectorLinks(userId: string, connectorId: string, socialAccountId: string): Promise<ToolAccountLink[]>;
  loadBinding(bindingId: string): Promise<BindingRow | null>;
  createSecret(secret: string): Promise<string>;
  /** Null when the connector already has a binding. */
  insertBinding(row: Omit<BindingRow, "id" | "rotated_at" | "created_at">): Promise<BindingRow | null>;
  /** Compare-and-set on secret_id, so two concurrent rotations cannot both win. Null when lost. */
  rotateBinding(bindingId: string, expectedSecretId: string, newSecretId: string, at: string): Promise<BindingRow | null>;
  /**
   * True when a store_webhook_bindings row stores this id in secret_id or
   * previous_secret_id. Throws when the read fails — that is not "unreferenced".
   */
  secretReferenced(secretId: string): Promise<boolean>;
  /**
   * Deletes one Vault secret by id via public.delete_connector_credential_secret.
   * Used for a secret this call just minted and then failed to attach, and for
   * the previous secret that a successful rotation drops out of the two-slot window.
   */
  deleteSecret(secretId: string): Promise<void>;
  listBindings(): Promise<BindingRow[]>;
}

const notFound = () => new ToolWriteError("Binding not found", 404);

function uuidField(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) throw new ToolWriteError(`${field} must be a UUID`);
  return value;
}

function view(row: BindingRow): BindingView {
  return {
    id: row.id, social_account_id: row.social_account_id, connector_id: row.connector_id,
    rotated_at: row.rotated_at, created_at: row.created_at,
  };
}

function loggedFailure(error: unknown, secret: string): string {
  const message = error instanceof Error ? error.message : "binding write failed";
  return message.split(secret).join("[redacted]");
}

/**
 * Binding is the owner's own configuration, not a customer reply, so admin_only
 * does not hide a connector. The ranks are still resolveToolsForAccount's:
 * owned by this account, linked via ai_agent_tool_accounts, or scope all_accounts.
 */
function connectorVisibleToAccount(
  connector: StoreConnector,
  links: ToolAccountLink[],
  accountId: string,
): boolean {
  const tool: ResolvableTool = {
    id: connector.id,
    name: connector.id,
    description: "",
    url: "",
    secret: null,
    admin_only: connector.admin_only,
    scope: connector.scope,
    social_account_id: connector.social_account_id,
    connector_type: connector.connector_type ?? "",
  };
  return resolveToolsForAccount([tool], links, accountId, { includeAdminOnly: true })
    .tools.some((resolved) => resolved.id === connector.id);
}

/**
 * insert/rotate threw after the secret row existed. Delete it only when a
 * re-read shows no binding points at it: a network error after commit must
 * not remove a live binding's secret. A failed re-read is not that proof.
 */
async function reclaimUnreferencedSecret(
  ports: StoreWebhookBindingPorts,
  secretId: string,
  secret: string,
): Promise<void> {
  let referenced: boolean;
  try {
    referenced = await ports.secretReferenced(secretId);
  } catch (error) {
    console.error(
      "[store-webhook] could not check whether the new secret is referenced:",
      loggedFailure(error, secret),
    );
    return;
  }
  if (referenced) return;
  try {
    await ports.deleteSecret(secretId);
  } catch (error) {
    // The write already failed. A Vault failure must not replace that error.
    console.error(
      "[store-webhook] unattached webhook secret could not be deleted:",
      loggedFailure(error, secret),
    );
  }
}

async function withMintedSecret<T>(
  ports: StoreWebhookBindingPorts,
  secretId: string,
  secret: string,
  write: () => Promise<T>,
): Promise<T> {
  try {
    return await write();
  } catch (error) {
    console.error(
      "[store-webhook] binding write failed after the secret was stored:",
      loggedFailure(error, secret),
    );
    await reclaimUnreferencedSecret(ports, secretId, secret);
    throw error;
  }
}

/** 32 random bytes, base64url without padding: 43 characters. */
export function newWebhookSecret(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function createStoreWebhookBinding(
  ports: StoreWebhookBindingPorts,
  body: Record<string, unknown>,
): Promise<{ binding: BindingView; secret: string }> {
  const socialAccountId = uuidField(body.social_account_id, "social_account_id");
  const connectorId = uuidField(body.connector_id, "connector_id");
  const account = await ports.resolveAccount(socialAccountId);
  if (account.platform !== "whatsapp") throw new ToolWriteError("Store events need a WhatsApp account");
  const connector = await ports.loadConnector(connectorId);
  if (!connector || connector.user_id !== account.user_id) throw new ToolWriteError("Connector not found", 404);
  const links = await ports.loadConnectorLinks(account.user_id, connector.id, account.id);
  if (!connectorVisibleToAccount(connector, links, account.id)) throw new ToolWriteError("Connector not found", 404);
  if (connector.connector_type !== "woocommerce") throw new ToolWriteError("Store events need a WooCommerce connector");
  const secret = newWebhookSecret();
  const secretId = await ports.createSecret(secret);
  const row = await withMintedSecret(ports, secretId, secret, () => ports.insertBinding({
    user_id: account.user_id,
    social_account_id: account.id,
    connector_id: connector.id,
    secret_id: secretId,
    previous_secret_id: null,
  }));
  if (!row) {
    await ports.deleteSecret(secretId);
    throw new ToolWriteError("This connector already has a webhook; rotate its secret instead", 409);
  }
  return { binding: view(row), secret };
}

export async function rotateStoreWebhookSecret(
  ports: StoreWebhookBindingPorts,
  body: Record<string, unknown>,
  now: Date,
): Promise<{ binding: BindingView; secret: string }> {
  const bindingId = uuidField(body.binding_id, "binding_id");
  const binding = await ports.loadBinding(bindingId);
  if (!binding) throw notFound();
  const account = await ports.resolveAccount(binding.social_account_id);
  if (account.user_id !== binding.user_id) throw notFound();
  const secret = newWebhookSecret();
  const secretId = await ports.createSecret(secret);
  const droppedSecretId = binding.previous_secret_id;
  const row = await withMintedSecret(ports, secretId, secret, () =>
    ports.rotateBinding(binding.id, binding.secret_id, secretId, now.toISOString()),
  );
  if (!row) {
    await ports.deleteSecret(secretId);
    throw new ToolWriteError("The secret was rotated by another request; reload and try again", 409);
  }
  // The row now holds the new secret and the one just replaced. The secret that
  // was already `previous_secret_id` has left the two-slot window.
  if (droppedSecretId) {
    try {
      await ports.deleteSecret(droppedSecretId);
    } catch (error) {
      console.error(
        "[store-webhook] rotated-out secret could not be deleted:",
        (error as Error).message,
      );
    }
  }
  return { binding: view(row), secret };
}

export async function listStoreWebhookBindings(ports: StoreWebhookBindingPorts): Promise<BindingView[]> {
  return (await ports.listBindings()).map(view);
}

export function storeWebhookBindingPorts(
  admin: SupabaseClient,
  scope: { userId: string } | WorkspaceToolScope,
): StoreWebhookBindingPorts {
  const bindings = () => admin.from("store_webhook_bindings");
  return {
    resolveAccount: (socialAccountId) => resolveToolAccount(admin as unknown as ToolAdminClient, scope, socialAccountId),
    async loadConnector(connectorId) {
      const { data, error } = await admin.from("ai_agent_tools")
        .select("id, user_id, connector_type, scope, social_account_id, admin_only")
        .eq("id", connectorId).maybeSingle();
      if (error) throw new Error("Connector read failed");
      if (!data) return null;
      return {
        id: data.id,
        user_id: data.user_id,
        connector_type: data.connector_type,
        scope: data.scope === "all_accounts" ? "all_accounts" : "account",
        social_account_id: data.social_account_id ?? null,
        admin_only: data.admin_only === true,
      };
    },
    async loadConnectorLinks(userId, connectorId, socialAccountId) {
      const { data, error } = await admin.from("ai_agent_tool_accounts")
        .select("tool_id, social_account_id")
        .eq("user_id", userId)
        .eq("tool_id", connectorId)
        .eq("social_account_id", socialAccountId);
      if (error) throw new Error("Connector link read failed");
      return data ?? [];
    },
    async loadBinding(bindingId) {
      const { data, error } = await bindings().select(BINDING_COLUMNS).eq("id", bindingId).maybeSingle();
      if (error) throw new Error("Binding read failed");
      return data;
    },
    async createSecret(secret) {
      const { data, error } = await admin.rpc("create_store_webhook_secret", { p_secret: secret });
      if (error || typeof data !== "string") throw new Error("Webhook secret could not be stored");
      return data;
    },
    async insertBinding(row) {
      const { data, error } = await bindings().insert(row).select(BINDING_COLUMNS).single();
      if (error?.code === "23505") return null;
      if (error || !data) throw new Error("Binding write failed");
      return data;
    },
    async rotateBinding(bindingId, expectedSecretId, newSecretId, at) {
      const { data, error } = await bindings()
        .update({ previous_secret_id: expectedSecretId, secret_id: newSecretId, rotated_at: at })
        .eq("id", bindingId).eq("secret_id", expectedSecretId)
        .select(BINDING_COLUMNS).maybeSingle();
      if (error) throw new Error("Binding rotation failed");
      return data;
    },
    async secretReferenced(secretId) {
      const referencedBy = async (column: "secret_id" | "previous_secret_id") => {
        const { data, error } = await bindings().select("id").eq(column, secretId).limit(1).maybeSingle();
        if (error) throw new Error("Binding read failed");
        return data != null;
      };
      if (await referencedBy("secret_id")) return true;
      return referencedBy("previous_secret_id");
    },
    async deleteSecret(secretId) {
      const { error } = await admin.rpc("delete_connector_credential_secret", { p_secret_id: secretId });
      if (error) throw new Error("Webhook secret could not be reclaimed");
    },
    async listBindings() {
      let query = bindings().select(BINDING_COLUMNS);
      query = "userId" in scope ? query.eq("user_id", scope.userId) : query.in("social_account_id", scope.accountIds);
      const { data, error } = await query.order("created_at", { ascending: true });
      if (error) throw new Error("Binding read failed");
      return data ?? [];
    },
  };
}
