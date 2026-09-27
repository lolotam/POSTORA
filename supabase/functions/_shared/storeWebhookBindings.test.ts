import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import {
  type BindingRow,
  createStoreWebhookBinding,
  rotateStoreWebhookSecret,
  storeWebhookBindingPorts,
  type StoreWebhookBindingPorts,
} from "./storeWebhookBindings.ts";
import { ToolWriteError } from "./toolWrites.ts";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const CONNECTOR = "22222222-2222-4222-8222-222222222222";
const BINDING = "33333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-09-27T12:00:00Z");

function fakePorts(overrides: Partial<StoreWebhookBindingPorts> = {}) {
  const secrets: string[] = [];
  const deleted: string[] = [];
  const rows = new Map<string, BindingRow>();
  const ports: StoreWebhookBindingPorts = {
    resolveAccount: async (id) => ({ id, user_id: "owner", platform: "whatsapp" }),
    loadConnector: async (id) => ({ id, user_id: "owner", connector_type: "woocommerce" }),
    loadBinding: async (id) => rows.get(id) ?? null,
    createSecret: async (secret) => { secrets.push(secret); return `secret-${secrets.length}`; },
    insertBinding: async (row) => {
      if ([...rows.values()].some((existing) => existing.connector_id === row.connector_id)) return null;
      const stored = {
        ...row, id: BINDING, previous_secret_id: null, rotated_at: null, created_at: NOW.toISOString(),
      };
      rows.set(BINDING, stored);
      return stored;
    },
    rotateBinding: async (id, expected, next, at) => {
      const row = rows.get(id);
      if (!row || row.secret_id !== expected) return null;
      const updated = { ...row, previous_secret_id: expected, secret_id: next, rotated_at: at };
      rows.set(id, updated);
      return updated;
    },
    deleteSecret: async (id) => { deleted.push(id); },
    listBindings: async () => [...rows.values()],
    ...overrides,
  };
  return { ports, secrets, deleted, rows };
}

const status = async (promise: Promise<unknown>) => {
  const error = await assertRejects(() => promise, ToolWriteError);
  return (error as ToolWriteError).status;
};

Deno.test("creating a binding mints a 43-character base64url secret and returns it once", async () => {
  const fake = fakePorts();
  const result = await createStoreWebhookBinding(fake.ports, { social_account_id: ACCOUNT, connector_id: CONNECTOR });
  assertEquals(result.secret.length, 43);
  assertEquals(/^[A-Za-z0-9_-]+$/.test(result.secret), true);
  assertEquals(fake.secrets, [result.secret]);
  assertEquals(fake.rows.get(BINDING)?.secret_id, "secret-1");
  assertEquals(Object.hasOwn(result.binding, "secret_id"), false);
});

Deno.test("a second binding for the same connector is a 409", async () => {
  const fake = fakePorts();
  await createStoreWebhookBinding(fake.ports, { social_account_id: ACCOUNT, connector_id: CONNECTOR });
  assertEquals(await status(createStoreWebhookBinding(fake.ports, { social_account_id: ACCOUNT, connector_id: CONNECTOR })), 409);
});

Deno.test("creation is refused for a non-WhatsApp account, a foreign connector, or a non-WooCommerce connector", async () => {
  const input = { social_account_id: ACCOUNT, connector_id: CONNECTOR };
  assertEquals(await status(createStoreWebhookBinding(fakePorts({
    resolveAccount: async (id) => ({ id, user_id: "owner", platform: "instagram" }),
  }).ports, input)), 400);
  assertEquals(await status(createStoreWebhookBinding(fakePorts({
    loadConnector: async (id) => ({ id, user_id: "someone-else", connector_type: "woocommerce" }),
  }).ports, input)), 404);
  assertEquals(await status(createStoreWebhookBinding(fakePorts({
    loadConnector: async (id) => ({ id, user_id: "owner", connector_type: "shopify" }),
  }).ports, input)), 400);
  assertEquals(await status(createStoreWebhookBinding(fakePorts().ports, { ...input, connector_id: "not-a-uuid" })), 400);
});

Deno.test("an account the caller does not own is refused before any secret is minted", async () => {
  const fake = fakePorts({
    resolveAccount: async () => { throw new ToolWriteError("Account does not belong to the caller", 403); },
  });
  assertEquals(await status(createStoreWebhookBinding(fake.ports, { social_account_id: ACCOUNT, connector_id: CONNECTOR })), 403);
  assertEquals(fake.secrets, []);
});

Deno.test("rotation moves the current secret to previous and stamps rotated_at", async () => {
  const fake = fakePorts();
  await createStoreWebhookBinding(fake.ports, { social_account_id: ACCOUNT, connector_id: CONNECTOR });
  const rotated = await rotateStoreWebhookSecret(fake.ports, { binding_id: BINDING }, NOW);
  assertEquals(rotated.secret.length, 43);
  assertEquals(fake.rows.get(BINDING)?.previous_secret_id, "secret-1");
  assertEquals(fake.rows.get(BINDING)?.secret_id, "secret-2");
  assertEquals(rotated.binding.rotated_at, NOW.toISOString());
});

Deno.test("a lost create deletes only the secret minted for that attempt", async () => {
  const fake = fakePorts();
  await createStoreWebhookBinding(fake.ports, { social_account_id: ACCOUNT, connector_id: CONNECTOR });
  assertEquals(await status(createStoreWebhookBinding(fake.ports, { social_account_id: ACCOUNT, connector_id: CONNECTOR })), 409);
  assertEquals(fake.deleted, ["secret-2"]);
  assertEquals(fake.rows.get(BINDING)?.secret_id, "secret-1");
});

Deno.test("a second rotation deletes the secret that left the two-slot window", async () => {
  const fake = fakePorts();
  await createStoreWebhookBinding(fake.ports, { social_account_id: ACCOUNT, connector_id: CONNECTOR });
  await rotateStoreWebhookSecret(fake.ports, { binding_id: BINDING }, NOW);
  assertEquals(fake.deleted, []);
  assertEquals(fake.rows.get(BINDING)?.previous_secret_id, "secret-1");
  const second = await rotateStoreWebhookSecret(fake.ports, { binding_id: BINDING }, NOW);
  assertEquals(fake.deleted, ["secret-1"]);
  assertEquals(fake.rows.get(BINDING)?.previous_secret_id, "secret-2");
  assertEquals(fake.rows.get(BINDING)?.secret_id, "secret-3");
  assertEquals(second.secret, fake.secrets[2]);
  assertEquals(fake.deleted.includes("secret-2"), false);
  assertEquals(fake.deleted.includes("secret-3"), false);
});

Deno.test("a failed delete of the rotated-out secret still returns the new secret", async () => {
  const fake = fakePorts();
  await createStoreWebhookBinding(fake.ports, { social_account_id: ACCOUNT, connector_id: CONNECTOR });
  await rotateStoreWebhookSecret(fake.ports, { binding_id: BINDING }, NOW);
  fake.ports.deleteSecret = async (id) => {
    if (id === "secret-1") throw new Error("vault down");
    fake.deleted.push(id);
  };
  const second = await rotateStoreWebhookSecret(fake.ports, { binding_id: BINDING }, NOW);
  assertEquals(second.binding.connector_id, CONNECTOR);
  assertEquals(fake.rows.get(BINDING)?.secret_id, "secret-3");
  assertEquals(fake.rows.get(BINDING)?.previous_secret_id, "secret-2");
  assertEquals(fake.deleted, []);
});

Deno.test("a lost rotate deletes only the newly minted secret", async () => {
  const fake = fakePorts({ rotateBinding: async () => null });
  await createStoreWebhookBinding(fake.ports, { social_account_id: ACCOUNT, connector_id: CONNECTOR });
  assertEquals(await status(rotateStoreWebhookSecret(fake.ports, { binding_id: BINDING }, NOW)), 409);
  assertEquals(fake.deleted, ["secret-2"]);
  assertEquals(fake.rows.get(BINDING)?.secret_id, "secret-1");
});

Deno.test("a same-owner WooCommerce connector is accepted for this WhatsApp account", async () => {
  const fake = fakePorts({
    loadConnector: async (id) => ({ id, user_id: "owner", connector_type: "woocommerce" }),
  });
  const result = await createStoreWebhookBinding(fake.ports, { social_account_id: ACCOUNT, connector_id: CONNECTOR });
  assertEquals(result.binding.social_account_id, ACCOUNT);
  assertEquals(result.binding.connector_id, CONNECTOR);
  assertEquals(fake.deleted, []);
});

Deno.test("deleteSecret calls delete_connector_credential_secret with that id", async () => {
  const rpcCalls: Array<{ name: string; args: unknown }> = [];
  const admin = {
    rpc(name: string, args: unknown) {
      rpcCalls.push({ name, args });
      return Promise.resolve({ data: null, error: null });
    },
    from() {
      throw new Error("no table");
    },
  };
  const ports = storeWebhookBindingPorts(admin as never, { userId: "owner" });
  const secretId = "99999999-9999-4999-8999-999999999999";
  await ports.deleteSecret(secretId);
  assertEquals(rpcCalls, [{ name: "delete_connector_credential_secret", args: { p_secret_id: secretId } }]);
});

Deno.test("rotation of an unknown binding is a 404, and a lost race is a 409", async () => {
  assertEquals(await status(rotateStoreWebhookSecret(fakePorts().ports, { binding_id: BINDING }, NOW)), 404);
  const fake = fakePorts({ rotateBinding: async () => null });
  await createStoreWebhookBinding(fake.ports, { social_account_id: ACCOUNT, connector_id: CONNECTOR });
  assertEquals(await status(rotateStoreWebhookSecret(fake.ports, { binding_id: BINDING }, NOW)), 409);
});

Deno.test("rotation refused when the account owner differs creates no new secret", async () => {
  const fake = fakePorts();
  await createStoreWebhookBinding(fake.ports, { social_account_id: ACCOUNT, connector_id: CONNECTOR });
  fake.ports.resolveAccount = async (id) => ({ id, user_id: "someone-else", platform: "whatsapp" });
  assertEquals(await status(rotateStoreWebhookSecret(fake.ports, { binding_id: BINDING }, NOW)), 404);
  assertEquals(fake.secrets.length, 1);
  assertEquals(fake.rows.get(BINDING)?.secret_id, "secret-1");
  assertEquals(fake.rows.get(BINDING)?.previous_secret_id, null);
});

Deno.test("rotation checks the caller owns the binding's account", async () => {
  const fake = fakePorts();
  await createStoreWebhookBinding(fake.ports, { social_account_id: ACCOUNT, connector_id: CONNECTOR });
  fake.ports.resolveAccount = async () => { throw new ToolWriteError("Account not found", 404); };
  assertEquals(await status(rotateStoreWebhookSecret(fake.ports, { binding_id: BINDING }, NOW)), 404);
});

Deno.test("the workspace scope refuses an account outside the key's bound set without a query", async () => {
  let queried = false;
  const admin = { from: () => { queried = true; throw new Error("unexpected query"); } };
  const ports = storeWebhookBindingPorts(admin as never, { workspaceId: "ws-1", accountIds: ["other"] });
  assertEquals(await status(ports.resolveAccount(ACCOUNT)), 404);
  assertEquals(queried, false);
});
