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
const OTHER = "44444444-4444-4444-8444-444444444444";
const NOW = new Date("2026-09-27T12:00:00Z");
const input = { social_account_id: ACCOUNT, connector_id: CONNECTOR };

function wooConnector(over: {
  id?: string;
  user_id?: string;
  connector_type?: string | null;
  scope?: "account" | "all_accounts";
  social_account_id?: string | null;
  admin_only?: boolean;
} = {}) {
  return {
    id: CONNECTOR,
    user_id: "owner",
    connector_type: "woocommerce" as string | null,
    scope: "all_accounts" as "account" | "all_accounts",
    social_account_id: null as string | null,
    admin_only: false,
    ...over,
  };
}

function fakePorts(overrides: Partial<StoreWebhookBindingPorts> = {}) {
  const secrets: string[] = [];
  const deleted: string[] = [];
  const rows = new Map<string, BindingRow>();
  const ports: StoreWebhookBindingPorts = {
    resolveAccount: async (id) => ({ id, user_id: "owner", platform: "whatsapp" }),
    loadConnector: async (id) => wooConnector({ id }),
    loadConnectorLinks: async () => [],
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
    secretReferenced: async () => false,
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
  assertEquals(await status(createStoreWebhookBinding(fakePorts({
    resolveAccount: async (id) => ({ id, user_id: "owner", platform: "instagram" }),
  }).ports, input)), 400);
  assertEquals(await status(createStoreWebhookBinding(fakePorts({
    loadConnector: async (id) => wooConnector({ id, user_id: "someone-else" }),
  }).ports, input)), 404);
  assertEquals(await status(createStoreWebhookBinding(fakePorts({
    loadConnector: async (id) => wooConnector({ id, connector_type: "shopify" }),
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

Deno.test("a same-owner WooCommerce connector is bindable when this account owns it, inherits it, or is linked to it", async () => {
  const cases = [
    { label: "owned", connector: wooConnector({ scope: "account", social_account_id: ACCOUNT }), links: [] as { tool_id: string; social_account_id: string }[] },
    { label: "all_accounts", connector: wooConnector({ scope: "all_accounts", social_account_id: OTHER }), links: [] },
    {
      label: "linked",
      connector: wooConnector({ scope: "account", social_account_id: OTHER }),
      links: [{ tool_id: CONNECTOR, social_account_id: ACCOUNT }],
    },
  ];
  for (const scenario of cases) {
    const fake = fakePorts({
      loadConnector: async (id) => ({ ...scenario.connector, id }),
      loadConnectorLinks: async () => scenario.links,
    });
    const result = await createStoreWebhookBinding(fake.ports, input);
    assertEquals(result.binding.social_account_id, ACCOUNT, scenario.label);
    assertEquals(result.binding.connector_id, CONNECTOR, scenario.label);
    assertEquals(fake.secrets.length, 1, scenario.label);
    assertEquals(fake.deleted, [], scenario.label);
  }
});

Deno.test("a same-owner WooCommerce connector this account cannot see is a 404 and mints nothing", async () => {
  const checked: string[] = [];
  const fake = fakePorts({
    loadConnector: async (id) => wooConnector({ id, scope: "account", social_account_id: OTHER }),
    loadConnectorLinks: async () => [{ tool_id: CONNECTOR, social_account_id: OTHER }],
    createSecret: async () => { checked.push("secret"); return "secret-1"; },
  });
  const error = await assertRejects(
    () => createStoreWebhookBinding(fake.ports, input),
    ToolWriteError,
    "Connector not found",
  );
  assertEquals((error as ToolWriteError).status, 404);
  assertEquals(checked, []);
  assertEquals(fake.deleted, []);
});

Deno.test("a thrown insert or rotate deletes the new secret when no binding references it", async () => {
  const created = fakePorts({
    insertBinding: async () => { throw new Error("insert failed"); },
  });
  const createdReads: string[] = [];
  created.ports.secretReferenced = async (id) => { createdReads.push(id); return false; };
  await assertRejects(() => createStoreWebhookBinding(created.ports, input), Error, "insert failed");
  assertEquals(createdReads, ["secret-1"]);
  assertEquals(created.deleted, ["secret-1"]);

  const rotated = fakePorts({
    rotateBinding: async () => { throw new Error("rotate failed"); },
  });
  const rotatedReads: string[] = [];
  rotated.ports.secretReferenced = async (id) => { rotatedReads.push(id); return false; };
  await createStoreWebhookBinding(rotated.ports, input);
  await assertRejects(
    () => rotateStoreWebhookSecret(rotated.ports, { binding_id: BINDING }, NOW),
    Error,
    "rotate failed",
  );
  assertEquals(rotatedReads, ["secret-2"]);
  assertEquals(rotated.deleted, ["secret-2"]);
  assertEquals(rotated.rows.get(BINDING)?.secret_id, "secret-1");
});

Deno.test("a thrown insert or rotate keeps the new secret when a binding references it", async () => {
  const created = fakePorts({
    insertBinding: async () => { throw new Error("insert failed"); },
    secretReferenced: async () => true,
  });
  await assertRejects(() => createStoreWebhookBinding(created.ports, input), Error, "insert failed");
  assertEquals(created.deleted, []);

  const rotated = fakePorts({
    rotateBinding: async () => { throw new Error("rotate failed"); },
    secretReferenced: async () => true,
  });
  await createStoreWebhookBinding(rotated.ports, input);
  await assertRejects(
    () => rotateStoreWebhookSecret(rotated.ports, { binding_id: BINDING }, NOW),
    Error,
    "rotate failed",
  );
  assertEquals(rotated.deleted, []);
  assertEquals(rotated.rows.get(BINDING)?.secret_id, "secret-1");
});

Deno.test("a thrown write does not delete the new secret when the reference read fails", async () => {
  const fake = fakePorts({
    insertBinding: async () => { throw new Error("insert failed"); },
    secretReferenced: async () => { throw new Error("binding read failed"); },
  });
  await assertRejects(() => createStoreWebhookBinding(fake.ports, input), Error, "insert failed");
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

Deno.test("the connector load reads visibility columns and the link load is scoped to owner, connector, and account", async () => {
  let toolSelect = "";
  const linkFilters: Array<[string, string]> = [];
  const admin = {
    from(table: string) {
      if (table === "ai_agent_tools") {
        return {
          select(columns: string) {
            toolSelect = columns;
            return {
              eq() {
                return {
                  maybeSingle: () => Promise.resolve({
                    data: {
                      id: CONNECTOR,
                      user_id: "owner",
                      connector_type: "woocommerce",
                      scope: "all_accounts",
                      social_account_id: null,
                      admin_only: false,
                    },
                    error: null,
                  }),
                };
              },
            };
          },
        };
      }
      if (table === "ai_agent_tool_accounts") {
        const filters: Array<[string, string]> = [];
        const builder = {
          select() { return builder; },
          eq(column: string, value: string) { filters.push([column, value]); return builder; },
          then(resolve: (value: unknown) => void) {
            linkFilters.push(...filters);
            resolve({ data: [], error: null });
          },
        };
        return builder;
      }
      throw new Error(table);
    },
    rpc() { throw new Error("rpc"); },
  };
  const ports = storeWebhookBindingPorts(admin as never, { userId: "owner" });
  const connector = await ports.loadConnector(CONNECTOR);
  assertEquals(connector?.scope, "all_accounts");
  assertEquals(toolSelect.includes("scope"), true);
  assertEquals(toolSelect.includes("social_account_id"), true);
  assertEquals(toolSelect.includes("admin_only"), true);
  assertEquals(await ports.loadConnectorLinks("owner", CONNECTOR, ACCOUNT), []);
  assertEquals(linkFilters, [
    ["user_id", "owner"],
    ["tool_id", CONNECTOR],
    ["social_account_id", ACCOUNT],
  ]);
});

Deno.test("secretReferenced is true when secret_id or previous_secret_id matches, and a read error is not unreferenced", async () => {
  const secretId = "99999999-9999-4999-8999-999999999999";
  const query = (answer: (column: string) => { data: { id: string } | null; error: { message: string } | null }) => {
    const columns: string[] = [];
    const admin = {
      from() {
        return {
          select() {
            return {
              eq(column: string) {
                columns.push(column);
                return { limit: () => ({ maybeSingle: () => Promise.resolve(answer(column)) }) };
              },
            };
          },
        };
      },
      rpc() { throw new Error("rpc"); },
    };
    return { admin, columns };
  };

  const onCurrent = query((column) => (
    column === "secret_id" ? { data: { id: BINDING }, error: null } : { data: null, error: null }
  ));
  assertEquals(await storeWebhookBindingPorts(onCurrent.admin as never, { userId: "owner" }).secretReferenced(secretId), true);
  assertEquals(onCurrent.columns, ["secret_id"]);

  const onPrevious = query((column) => (
    column === "previous_secret_id" ? { data: { id: BINDING }, error: null } : { data: null, error: null }
  ));
  assertEquals(
    await storeWebhookBindingPorts(onPrevious.admin as never, { userId: "owner" }).secretReferenced(secretId),
    true,
  );
  assertEquals(onPrevious.columns, ["secret_id", "previous_secret_id"]);

  const empty = query(() => ({ data: null, error: null }));
  assertEquals(await storeWebhookBindingPorts(empty.admin as never, { userId: "owner" }).secretReferenced(secretId), false);

  const failed = query(() => ({ data: null, error: { message: "timeout" } }));
  await assertRejects(
    () => storeWebhookBindingPorts(failed.admin as never, { userId: "owner" }).secretReferenced(secretId),
    Error,
    "Binding read failed",
  );
});

Deno.test("the workspace scope refuses an account outside the key's bound set without a query", async () => {
  let queried = false;
  const admin = { from: () => { queried = true; throw new Error("unexpected query"); } };
  const ports = storeWebhookBindingPorts(admin as never, { workspaceId: "ws-1", accountIds: ["other"] });
  assertEquals(await status(ports.resolveAccount(ACCOUNT)), 404);
  assertEquals(queried, false);
});
