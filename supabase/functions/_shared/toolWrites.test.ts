import { assertEquals, assertRejects, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type CredentialVault,
  deleteAccountScopedTool,
  listToolsForUser,
  type ToolAdminClient,
  ToolWriteError,
  parseUpsertToolInput,
  upsertAccountScopedTool,
} from "./toolWrites.ts";

const OWNER = "user-1";
const OTHER = "user-2";
const ACCOUNT = "acc-1";

type Row = Record<string, unknown> & { id: string };

interface RecordedWrite {
  table: string;
  kind: "insert" | "update" | "delete";
  values?: Record<string, unknown>;
  filters: Record<string, unknown>;
}

/**
 * Stands in for the service-role client at the database boundary, in the
 * register of aiConfigScope.test.ts. Reads answer from `rows` and writes are
 * APPLIED, because the assertions that matter here span two saves: the second
 * save must see the row (and the vault secret id) the first one wrote. Every
 * write is also recorded, in order, so ordering against vault calls and the
 * exact columns a write sets stay assertable.
 */
function fakeAdmin(seed: Row[]) {
  // Copy: writes are applied to `rows`, and tests share seed constants that
  // must not leak rows (or mutations) into each other.
  const rows: Row[] = seed.map((row) => ({ ...row }));
  const writes: RecordedWrite[] = [];
  let counter = 0;

  const matching = (table: string, filters: Record<string, unknown>) =>
    rows.filter((row) =>
      row.__table === table &&
      Object.entries(filters).every(([column, value]) =>
        value && typeof value === "object" && "__in" in (value as Record<string, unknown>)
          ? ((value as { __in: unknown[] }).__in.includes(row[column]))
          : row[column] === value
      )
    );

  const apply = (write: RecordedWrite) => {
    writes.push(write);
    const targets = matching(write.table, write.filters);
    if (write.kind === "insert") {
      counter += 1;
      rows.push({ __table: write.table, id: `written-${counter}`, ...write.values });
    } else if (write.kind === "update") {
      for (const target of targets) Object.assign(target, write.values);
    } else if (write.kind === "delete") {
      for (const target of targets) {
        const index = rows.indexOf(target);
        if (index >= 0) rows.splice(index, 1);
      }
    }
  };

  const builder = (
    table: string,
    filters: Record<string, unknown>,
    pending: { kind: RecordedWrite["kind"]; values?: Record<string, unknown> } | null,
  ) => ({
    select: () => builder(table, filters, pending),
    eq: (column: string, value: unknown) => builder(table, { ...filters, [column]: value }, pending),
    in: (column: string, values: unknown[]) =>
      builder(table, { ...filters, [column]: { __in: values } }, pending),
    order: () => builder(table, filters, pending),
    insert: (values: Record<string, unknown>) => builder(table, filters, { kind: "insert", values }),
    update: (values: Record<string, unknown>) => builder(table, filters, { kind: "update", values }),
    delete: () => builder(table, filters, { kind: "delete" }),
    maybeSingle: () => Promise.resolve({ data: matching(table, filters)[0] ?? null, error: null }),
    single: () => {
      if (pending) {
        apply({ table, kind: pending.kind, values: pending.values, filters });
        const last = rows[rows.length - 1];
        return Promise.resolve({
          data: pending.kind === "insert" && last?.__table === table
            ? last
            : pending.values
              ? { ...pending.values }
              : matching(table, filters)[0] ?? null,
          error: null,
        });
      }
      return Promise.resolve({ data: matching(table, filters)[0] ?? null, error: null });
    },
    then: (
      onfulfilled: (value: { data: Array<Record<string, unknown>> | null; error: unknown }) => unknown,
      onrejected: (reason: unknown) => unknown,
    ) => {
      // A delete builder is executed by awaiting it; insert/update go through
      // .select().single() in the code under test.
      if (pending) apply({ table, kind: pending.kind, values: pending.values, filters });
      return Promise.resolve({ data: matching(table, filters), error: null }).then(onfulfilled, onrejected);
    },
  });

  return {
    writes,
    from: (table: string) => builder(table, {}, null),
  } as unknown as ToolAdminClient & { writes: RecordedWrite[] };
}

/**
 * Mirrors the SQL wrapper contract (upsert_connector_credential_secret) the
 * Edge Function crosses: an existing secret id means decrypt-merge-re-encrypt
 * server-side; null (or a dangling id) creates a fresh secret. The merge here
 * is jsonb || semantics -- exactly what the migration implements -- so a bug
 * in the function under test that drops the secret id becomes visible as a
 * second create and a shrunken configured_fields list.
 */
function fakeVault() {
  const blobs = new Map<string, Record<string, string>>();
  const deleted: string[] = [];
  let counter = 0;
  const calls: Array<{ secretId: string | null; blob: Record<string, string> }> = [];
  const impl: CredentialVault = {
    upsertCredentials: async (secretId: string | null, blob: Record<string, string>) => {
      calls.push({ secretId, blob });
      if (secretId && blobs.has(secretId)) {
        const merged = { ...blobs.get(secretId)!, ...blob };
        blobs.set(secretId, merged);
        return { secretId, configuredFields: Object.keys(merged).sort() };
      }
      counter += 1;
      const id = `secret-${counter}`;
      blobs.set(id, { ...blob });
      return { secretId: id, configuredFields: Object.keys(blob).sort() };
    },
    deleteCredentials: async (secretId: string) => {
      deleted.push(secretId);
      blobs.delete(secretId);
    },
  };
  return { calls, deleted, ...impl };
}

const ACCOUNTS: Row[] = [
  { __table: "social_accounts", id: ACCOUNT, user_id: OWNER, platform: "whatsapp", workspace_id: "ws-1" },
  { __table: "social_accounts", id: "acc-2", user_id: OWNER, platform: "instagram", workspace_id: "ws-1" },
  { __table: "social_accounts", id: "acc-other", user_id: OTHER, platform: "whatsapp", workspace_id: "ws-2" },
];

const MEMBERSHIP: Row = { __table: "workspace_members", id: "member-1", workspace_id: "ws-1", user_id: OWNER };

function toolPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: "ai_upsert_tool",
    tool: {
      name: "store_lookup",
      description: "Looks up products in the store",
      url: "https://hooks.example.com/workflow",
      connector_type: "woocommerce",
      social_account_id: ACCOUNT,
      credentials: {
        store_url: "https://shop.example.com",
        consumer_key: "ck_live_abc",
        consumer_secret: "cs_live_xyz",
      },
      ...overrides,
    },
  };
}

function composioPayload(overrides: Record<string, unknown> = {}) {
  return toolPayload({ connector_type: "google_sheets", credentials: {}, connection_id: "connection-1", ...overrides });
}

Deno.test("Composio parsing requires a connection while native parsing strips one", () => {
  const missing = composioPayload();
  delete (missing.tool as Record<string, unknown>).connection_id;
  let caught: unknown;
  try {
    parseUpsertToolInput(missing);
  } catch (error) {
    caught = error;
  }
  assertEquals(caught instanceof ToolWriteError, true);
  assertEquals((caught as Error).message, "connection_required");

  const native = parseUpsertToolInput(toolPayload({ connection_id: "ignored" }));
  assertEquals(native.authStrategy, "manual_credentials");
  assertEquals(native.connectionId, undefined);
});

Deno.test("Composio writes refuse inactive and forbidden connections", async () => {
  const inactiveRows: Row[] = [
    ...ACCOUNTS, MEMBERSHIP,
    { __table: "connector_connections", id: "connection-1", workspace_id: "ws-1", connector_type: "google_sheets", toolkit: "googlesheets", composio_connected_account_id: "ca-1", tool_schema_cache: [], status: "revoked" },
  ];
  const inactive = await assertRejects(
    () => upsertAccountScopedTool(fakeAdmin(inactiveRows), fakeVault(), { userId: OWNER, input: parseUpsertToolInput(composioPayload()) }),
    ToolWriteError,
    "connection_inactive",
  );
  assertEquals(inactive.status, 409);

  const forbiddenRows: Row[] = [
    ...ACCOUNTS, MEMBERSHIP,
    { __table: "connector_connections", id: "connection-1", workspace_id: "ws-2", connector_type: "google_sheets", toolkit: "googlesheets", composio_connected_account_id: "ca-1", tool_schema_cache: [], status: "active" },
  ];
  const forbidden = await assertRejects(
    () => upsertAccountScopedTool(fakeAdmin(forbiddenRows), fakeVault(), { userId: OWNER, input: parseUpsertToolInput(composioPayload()) }),
    ToolWriteError,
    "connection_forbidden",
  );
  assertEquals(forbidden.status, 403);
});

Deno.test("an active Composio connection writes strategy and id without touching Vault", async () => {
  const admin = fakeAdmin([
    ...ACCOUNTS, MEMBERSHIP,
    { __table: "connector_connections", id: "connection-1", workspace_id: "ws-1", connector_type: "google_sheets", toolkit: "googlesheets", composio_connected_account_id: "ca-1", tool_schema_cache: [], status: "active" },
  ]);
  const vault = fakeVault();
  await upsertAccountScopedTool(admin, vault, { userId: OWNER, input: parseUpsertToolInput(composioPayload()) });
  const insert = admin.writes.find((write) => write.kind === "insert")!;
  assertEquals(insert.values?.auth_strategy, "composio_oauth");
  assertEquals(insert.values?.connection_id, "connection-1");
  assertEquals(vault.calls, []);
});

Deno.test("an unknown connector_type is refused by name, not downgraded to custom_rest", () => {
  // Today the deployed writer substitutes custom_rest and returns 200, so the
  // user picks Stripe and gets a success toast over a row they did not choose
  // (spec §1.6). The refusal must name the type; it must not mention the
  // substitute, which would read as a successful downgrade.
  let caught: unknown = null;
  try {
    parseUpsertToolInput(toolPayload({ connector_type: "stripe_v2" }));
  } catch (error) {
    caught = error;
  }
  assertEquals(caught instanceof ToolWriteError, true);
  if (caught instanceof ToolWriteError) {
    assertEquals(caught.status, 400);
    assertEquals(caught.message.includes("stripe_v2"), true);
    assertEquals(caught.message.includes("custom_rest"), false);
  }
});

Deno.test("a save without a social_account_id is refused rather than writing an unscoped row", () => {
  // An account-less row against an account-scoped table is the defect this
  // whole plan exists to fix; "" / 0 / false are caller bugs, not consent.
  const cases: Array<[string, unknown]> = [
    ["absent", undefined],
    ["null", null],
    ["empty string", ""],
    ["whitespace", "   "],
    ["zero", 0],
    ["false", false],
  ];
  for (const [label, value] of cases) {
    let caught: unknown = null;
    try {
      const base = toolPayload().tool as Record<string, unknown>;
      delete base.social_account_id;
      parseUpsertToolInput({ tool: value === undefined ? base : { ...base, social_account_id: value } });
    } catch (error) {
      caught = error;
    }
    assertEquals(caught instanceof ToolWriteError, true, `case: ${label}`);
    if (caught instanceof ToolWriteError) {
      assertEquals(caught.status, 400, `case: ${label}`);
      assertEquals(caught.message.includes("social_account_id"), true, `case: ${label}`);
    }
  }
});

Deno.test("a save naming an account the caller does not own is a 403, an unknown account a 404", async () => {
  const foreign = await assertRejects(
    () =>
      upsertAccountScopedTool(fakeAdmin(ACCOUNTS), fakeVault(), {
        userId: OWNER,
        input: parseUpsertToolInput(toolPayload({ social_account_id: "acc-other" })),
      }),
    ToolWriteError,
  );
  assertEquals(foreign.status, 403);

  const missing = await assertRejects(
    () =>
      upsertAccountScopedTool(fakeAdmin(ACCOUNTS), fakeVault(), {
        userId: OWNER,
        input: parseUpsertToolInput(toolPayload({ social_account_id: "acc-nope" })),
      }),
    ToolWriteError,
  );
  assertEquals(missing.status, 404);
});

Deno.test("a scoped save writes scope 'account' and derives platform from the account, never the client", async () => {
  const admin = fakeAdmin(ACCOUNTS);
  await upsertAccountScopedTool(admin, fakeVault(), {
    userId: OWNER,
    input: parseUpsertToolInput(toolPayload({ platform: "lies" })),
  });
  const insert = admin.writes.find((write) => write.kind === "insert");
  assertEquals(!!insert, true);
  assertEquals(insert!.values!.scope, "account");
  assertEquals(insert!.values!.social_account_id, ACCOUNT);
  assertEquals(insert!.values!.platform, "whatsapp");
});

Deno.test("a partial credential update preserves the unsubmitted secret field", async () => {
  // The silent-drop bug §4.3 warns about: update_secret replaces the WHOLE
  // blob, so writing only the submitted field would silently drop
  // consumer_key and leave a connector authenticating with half its
  // credentials. The fix is decrypt-merge-re-encrypt keyed on the EXISTING
  // secret id -- so the observable contract is that the second save passes
  // the first save's secret id and only the submitted field, and the derived
  // configured_secret_fields still names both fields afterwards.
  const admin = fakeAdmin(ACCOUNTS);
  const vault = fakeVault();

  await upsertAccountScopedTool(admin, vault, {
    userId: OWNER,
    input: parseUpsertToolInput(toolPayload()),
  });
  const storedRow = admin.writes.find((write) => write.kind === "insert")!.values as Record<string, unknown>;
  const firstSecretId = storedRow.credentials_secret_id as string;

  await upsertAccountScopedTool(admin, vault, {
    userId: OWNER,
    input: parseUpsertToolInput(
      toolPayload({ credentials: { consumer_secret: "cs_live_rotated" } }),
    ),
  });

  const secondCall = vault.calls[vault.calls.length - 1];
  assertEquals(secondCall.secretId, firstSecretId);
  // Only the submitted field crosses the seam; the merge is the SQL's.
  assertEquals(secondCall.blob, { consumer_secret: "cs_live_rotated" });

  const update = admin.writes.find((write) => write.kind === "update");
  assertEquals(!!update, true);
  assertEquals(update!.values!.configured_secret_fields, ["consumer_key", "consumer_secret"]);
  // Exactly one secret exists for this connector after both saves -- a null
  // secret id on the second call would have created a second.
  assertEquals(vault.calls.length, 2);
});

Deno.test("configured_secret_fields is derived from the blob on every write, never accepted from the client", async () => {
  const admin = fakeAdmin(ACCOUNTS);
  await upsertAccountScopedTool(admin, fakeVault(), {
    userId: OWNER,
    input: parseUpsertToolInput(
      toolPayload({
        credentials: { consumer_key: "ck_live_abc" },
        configured_secret_fields: ["consumer_key", "consumer_secret", "bogus"],
      }),
    ),
  });
  const insert = admin.writes.find((write) => write.kind === "insert");
  // Derived from what the blob actually holds after the write, which is only
  // the one submitted field -- the client's array was ignored entirely.
  assertEquals(insert!.values!.configured_secret_fields, ["consumer_key"]);
});

Deno.test("the row decision is read-then-update-or-insert, never onConflict user_id,name", async (t) => {
  await t.step("an existing account row is updated by its id", async () => {
    const rows: Row[] = [
      ...ACCOUNTS,
      {
        __table: "ai_agent_tools",
        id: "tool-9",
        user_id: OWNER,
        social_account_id: ACCOUNT,
        name: "store_lookup",
        settings: { store_url: "https://shop.example.com" },
        credentials_secret_id: "secret-9",
        configured_secret_fields: ["consumer_key"],
        secret: null,
      },
    ];
    const admin = fakeAdmin(rows);
    await upsertAccountScopedTool(admin, fakeVault(), {
      userId: OWNER,
      input: parseUpsertToolInput(toolPayload()),
    });
    const update = admin.writes.find((write) => write.kind === "update");
    assertEquals(!!update, true);
    assertEquals(update!.filters.id, "tool-9");
  });

  await t.step("no matching row is a plain insert carrying scope and account", async () => {
    const admin = fakeAdmin(ACCOUNTS);
    await upsertAccountScopedTool(admin, fakeVault(), {
      userId: OWNER,
      input: parseUpsertToolInput(toolPayload()),
    });
    const insert = admin.writes.find((write) => write.kind === "insert");
    assertEquals(!!insert, true);
    assertEquals(insert!.values!.social_account_id, ACCOUNT);
    assertEquals(insert!.values!.scope, "account");
  });

  await t.step("a legacy unscoped row of the same name is not hijacked", async () => {
    // Rows written before Migration A carry social_account_id NULL; the read
    // must be scoped to the account so an account-scoped save never updates
    // (or silently merges into) the legacy row.
    const rows: Row[] = [
      ...ACCOUNTS,
      {
        __table: "ai_agent_tools",
        id: "tool-legacy",
        user_id: OWNER,
        social_account_id: null,
        name: "store_lookup",
        settings: {},
        credentials_secret_id: null,
        configured_secret_fields: [],
        secret: null,
      },
    ];
    const admin = fakeAdmin(rows);
    await upsertAccountScopedTool(admin, fakeVault(), {
      userId: OWNER,
      input: parseUpsertToolInput(toolPayload()),
    });
    assertEquals(!!admin.writes.find((write) => write.kind === "insert"), true);
    assertEquals(!!admin.writes.find((write) => write.kind === "update"), false);
  });
});

Deno.test("custom_rest credentials still reach the plaintext secret column the deployed reader uses", async (t) => {
  // executeCustomTool (ai-agent-reply/tools.ts:409) sets X-Webhook-Secret
  // from the `secret` column. Until PR-6's dual-read ships, the vault copy of
  // a custom_rest secret must ALSO land in that column or every live n8n
  // call silently stops authenticating (spec §4.3).
  await t.step("credentials.secret dual-writes the column", async () => {
    const admin = fakeAdmin(ACCOUNTS);
    await upsertAccountScopedTool(admin, fakeVault(), {
      userId: OWNER,
      input: parseUpsertToolInput(
        toolPayload({
          connector_type: "custom_rest",
          credentials: {
            url: "https://hooks.example.com/x",
            header_name: "X-Webhook-Secret",
            secret: "whsec_123",
          },
        }),
      ),
    });
    const insert = admin.writes.find((write) => write.kind === "insert");
    assertEquals(insert!.values!.secret, "whsec_123");
  });

  await t.step("the legacy tool.secret path still writes the column for every type", async () => {
    const admin = fakeAdmin(ACCOUNTS);
    await upsertAccountScopedTool(admin, fakeVault(), {
      userId: OWNER,
      input: parseUpsertToolInput(toolPayload({ credentials: {}, secret: "legacy_secret" })),
    });
    const insert = admin.writes.find((write) => write.kind === "insert");
    assertEquals(insert!.values!.secret, "legacy_secret");
  });

  await t.step("clear_secret still removes the stored column value", async () => {
    const rows: Row[] = [
      ...ACCOUNTS,
      {
        __table: "ai_agent_tools",
        id: "tool-4",
        user_id: OWNER,
        social_account_id: ACCOUNT,
        name: "store_lookup",
        settings: {},
        credentials_secret_id: null,
        configured_secret_fields: [],
        secret: "old",
      },
    ];
    const admin = fakeAdmin(rows);
    await upsertAccountScopedTool(admin, fakeVault(), {
      userId: OWNER,
      input: parseUpsertToolInput(toolPayload({ credentials: {}, clear_secret: true })),
    });
    const update = admin.writes.find((write) => write.kind === "update");
    assertEquals(update!.values!.secret, null);
  });
});

Deno.test("ai_list_tools never returns a decrypted credential, a secret value, or a vault id", async () => {
  // configured_secret_fields exists precisely so the list can render
  // "Consumer secret: set" without touching Vault at all (§4.3).
  const rows: Row[] = [
    {
      __table: "ai_agent_tools",
      id: "tool-1",
      user_id: OWNER,
      social_account_id: ACCOUNT,
      name: "store_lookup",
      secret: "cs_live_xyz",
      credentials_secret_id: "vault-uuid-1",
      configured_secret_fields: ["consumer_key", "consumer_secret"],
      settings: { store_url: "https://shop.example.com" },
    },
  ];
  const tools = await listToolsForUser(fakeAdmin(rows), OWNER);
  const serialized = JSON.stringify(tools);
  assertEquals(serialized.includes("cs_live_xyz"), false);
  assertEquals(serialized.includes("vault-uuid-1"), false);
  assertEquals(serialized.includes("credentials_secret_id"), false);
  const tool = tools[0] as Record<string, unknown>;
  assertEquals(tool.has_secret, true);
  assertEquals(tool.settings, { store_url: "https://shop.example.com" });
  assertEquals(tool.configured_secret_fields, ["consumer_key", "consumer_secret"]);
});

Deno.test("ai_list_tools returns the last-connection-test columns so a card can show stored state", async () => {
  // last_test_at / last_test_ok / last_test_error are written by the
  // ai-agent-adapters test_connection path, not the browser. The list must
  // carry them back (they are not secrets) or every card renders blank until
  // someone clicks Test — a future column allow-list that drops them is
  // exactly the regression this pins.
  const rows: Row[] = [
    {
      __table: "ai_agent_tools",
      id: "tool-1",
      user_id: OWNER,
      social_account_id: ACCOUNT,
      name: "store_lookup",
      secret: null,
      credentials_secret_id: null,
      configured_secret_fields: [],
      settings: {},
      last_test_at: "2026-08-31T10:00:00Z",
      last_test_ok: false,
      last_test_error: "woocommerce_http_error: WooCommerce rejected the request.",
    },
  ];
  const tools = await listToolsForUser(fakeAdmin(rows), OWNER);
  const tool = tools[0] as Record<string, unknown>;
  assertEquals(tool.last_test_at, "2026-08-31T10:00:00Z");
  assertEquals(tool.last_test_ok, false);
  assertEquals(tool.last_test_error, "woocommerce_http_error: WooCommerce rejected the request.");
});

Deno.test("deleting a tool reclaims the vault secret before the row is gone", async (t) => {
  await t.step("secret deleted first, row second", async () => {
    const rows: Row[] = [
      { __table: "ai_agent_tools", id: "tool-1", user_id: OWNER, credentials_secret_id: "secret-77" },
    ];
    const admin = fakeAdmin(rows);
    const vault = fakeVault();
    await deleteAccountScopedTool(admin, vault, { userId: OWNER, toolId: "tool-1" });
    assertEquals(vault.deleted, ["secret-77"]);
    const rowDelete = admin.writes.find((write) => write.kind === "delete");
    assertEquals(!!rowDelete, true);
    assertEquals(rowDelete!.filters.id, "tool-1");
  });

  await t.step("a vault failure leaves the row alive rather than an orphaned secret", async () => {
    const rows: Row[] = [
      { __table: "ai_agent_tools", id: "tool-1", user_id: OWNER, credentials_secret_id: "secret-77" },
    ];
    const admin = fakeAdmin(rows);
    const failing: CredentialVault = {
      upsertCredentials: () => Promise.reject(new Error("not used")),
      deleteCredentials: () => Promise.reject(new Error("vault unavailable")),
    };
    await assertRejects(
      () => deleteAccountScopedTool(admin, failing, { userId: OWNER, toolId: "tool-1" }),
      Error,
    );
    assertEquals(admin.writes.some((write) => write.kind === "delete"), false);
  });

  await t.step("an unknown or foreign tool id is a 404", async () => {
    const error = await assertRejects(
      () => deleteAccountScopedTool(fakeAdmin([]), fakeVault(), { userId: OWNER, toolId: "nope" }),
      ToolWriteError,
    );
    assertEquals(error.status, 404);
  });
});

Deno.test("credential keys outside the connector's registry fields are refused by name", () => {
  // The registry is the single definition of every type's fields (§5.1); a
  // key it does not declare is either a drifted client or a probe, and both
  // are told exactly which key was refused.
  let caught: unknown = null;
  try {
    parseUpsertToolInput(toolPayload({ credentials: { store_url: "https://x", api_key: "nope" } }));
  } catch (error) {
    caught = error;
  }
  assertEquals(caught instanceof ToolWriteError, true);
  if (caught instanceof ToolWriteError) {
    assertEquals(caught.status, 400);
    assertEquals(caught.message.includes("api_key"), true);
  }
});

Deno.test("a Composio tool needs no URL and records null for it", () => {
  const parsed = parseUpsertToolInput(
    toolPayload({
      url: "",
      connector_type: "google_sheets",
      connection_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      credentials: {},
    }),
  );
  assertEquals(parsed.url, null);
  assertEquals(parsed.authStrategy, "composio_oauth");
});

Deno.test("a native tool still refuses a missing or private URL", () => {
  assertThrows(
    () => parseUpsertToolInput(toolPayload({ url: "" })),
    ToolWriteError,
    "https://",
  );
  assertThrows(
    () => parseUpsertToolInput(toolPayload({ url: "https://10.0.0.5/hook" })),
    ToolWriteError,
    "public host",
  );
});

Deno.test("a native tool refuses a URL with a user name before the host", () => {
  for (const url of ["https://shop@gmail.com", "https://user:pass@example.com/wp"]) {
    assertThrows(() => parseUpsertToolInput(toolPayload({ url })), ToolWriteError, "@");
  }
});
