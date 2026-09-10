// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { ACTION_FEATURE_KEYS, AGENT_PLATFORM_FEATURE_KEYS, assertEntitled } from "./partnerEntitlement.ts";

const WORKSPACE = "ws-1";
const OWNER = "svc-user-1";
const REQUEST = "req-1";
const MESSAGING = "feature_msg_whatsapp";
const QR = "feature_wa_evolution_qr_enabled";
const PHASE_ONE_ACTIONS = [
  "list_whatsapp_numbers", "get_whatsapp_number", "register_whatsapp_number",
  "create_whatsapp_pairing", "get_whatsapp_pairing", "end_whatsapp_session",
  "start_whatsapp_history_sync", "get_whatsapp_history_sync",
  "get_whatsapp_profile", "update_whatsapp_profile",
];

interface Override {
  user_id: string;
  feature_key: string;
  enabled: boolean;
  expires_at: string | null;
}

interface StubOptions {
  ownerRow?: { owner_user_id: string | null } | null;
  globalRows?: Array<{ key: string; value: unknown }>;
  overrides?: Override[];
  failedTable?: string;
  throws?: boolean;
}

/** Only the database boundary is faked. Filters are applied so a wrong owner
 *  or key column cannot accidentally read an unrelated user's grant. */
function adminStub(opts: StubOptions = {}) {
  const logs: Array<Record<string, unknown>> = [];
  const reads: string[] = [];
  const admin = {
    from(table: string) {
      if (table === "system_logs") {
        return { insert(row: Record<string, unknown>) {
          logs.push(row);
          return Promise.resolve({ error: null });
        } };
      }
      reads.push(table);
      const rows: Record<string, unknown>[] = table === "partner_provisioned_workspaces"
        ? (opts.ownerRow === null ? [] : [{ workspace_id: WORKSPACE,
          ...("ownerRow" in opts ? opts.ownerRow : { owner_user_id: OWNER }) }])
        : table === "app_settings"
        ? opts.globalRows ?? [{ key: MESSAGING, value: true }, { key: QR, value: true }]
        : table === "user_feature_overrides" ? (opts.overrides ?? []).map((row) => ({ ...row })) : [];
      assert(["partner_provisioned_workspaces", "app_settings", "user_feature_overrides"].includes(table));
      let filtered = rows;
      const result = () => {
        if (opts.failedTable === table && opts.throws) throw new Error("private database failure");
        return { data: filtered, error: opts.failedTable === table
          ? { message: "private database failure" } : null };
      };
      return {
        select(_columns: string) { return this; },
        eq(column: string, value: unknown) {
          filtered = filtered.filter((row) => row[column] === value);
          return this;
        },
        in(column: string, values: readonly string[]) {
          filtered = filtered.filter((row) => values.includes(row[column] as string));
          return this;
        },
        maybeSingle() {
          const response = result();
          return Promise.resolve({ ...response, data: response.data[0] ?? null });
        },
        then(resolve: (value: ReturnType<typeof result>) => unknown) {
          return Promise.resolve(result()).then(resolve);
        },
      };
    },
  };
  return { admin, logs, reads };
}

async function expectRefusal(
  opts: StubOptions,
  code = "feature_not_entitled",
  action = "list_whatsapp_numbers",
  missing?: string[],
) {
  const stub = adminStub(opts);
  const response = await assertEntitled(stub.admin, WORKSPACE, action, REQUEST);
  assert(response);
  assertEquals(response.status, code === "internal_error" ? 500 : 403);
  const body = await response.json();
  assertEquals(body.error.code, code);
  assertEquals(body.error.retryable, code === "internal_error");
  assertEquals(body.error.request_id, REQUEST);
  assertEquals(response.headers.get("X-Postora-Request-Id"), REQUEST);
  assertEquals(JSON.stringify(body).includes("private database failure"), false);
  if (missing) assertEquals(body.error.details.missing_feature_keys, missing);
  assertEquals(stub.logs.length, 1, "every refusal must persist one audit row");
  const metadata = stub.logs[0].metadata as Record<string, unknown>;
  assertEquals(metadata.request_id, REQUEST);
  assertEquals(metadata.workspace_id, WORKSPACE);
  assertEquals(metadata.action, action);
  assertEquals(metadata.error_code, code);
  return stub;
}

Deno.test("every Phase 1 action has a non-empty policy and passes when entitled", async () => {
  for (const action of PHASE_ONE_ACTIONS) {
    assert(Object.hasOwn(ACTION_FEATURE_KEYS, action), action);
    assert(ACTION_FEATURE_KEYS[action].length > 0, action);
    const stub = adminStub();
    assertEquals(await assertEntitled(stub.admin, WORKSPACE, action, REQUEST), null, action);
    assertEquals(stub.logs, []);
  }
});

Deno.test("a per-platform action refuses when the caller names no platform", async () => {
  const stub = adminStub();
  const response = await assertEntitled(stub.admin, WORKSPACE, "update_agent_config", REQUEST);
  assert(response);
  assertEquals(response.status, 403);
  assertEquals((await response.json()).error.code, "feature_not_entitled");
  assertEquals(stub.logs.length, 1, "every refusal must persist one audit row");
});

Deno.test("each agent platform is checked against its own flag, not WhatsApp's", async () => {
  for (const [name, keys] of Object.entries(AGENT_PLATFORM_FEATURE_KEYS)) {
    const stub = adminStub({ globalRows: keys.map((key) => ({ key, value: true })) });
    assertEquals(await assertEntitled(stub.admin, WORKSPACE, "update_agent_config", REQUEST, name), null, name);
    const denied = adminStub({ globalRows: [{ key: "feature_msg_whatsapp", value: true }] });
    const response = await assertEntitled(denied.admin, WORKSPACE, "update_agent_config", REQUEST, name);
    if (name === "whatsapp") assertEquals(response, null);
    else assertEquals(response?.status, 403, name);
  }
});

Deno.test("policy keys exist in the browser's FLAG_KEYS, without importing React into Deno", async () => {
  const source = await Deno.readTextFile(new URL("../../../src/hooks/useFeatureFlags.tsx", import.meta.url));
  const declaration = source.match(/export const FLAG_KEYS = \[([\s\S]*?)\];/);
  assert(declaration);
  const keys = [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  // Every platform variant, not just the one ACTION_FEATURE_KEYS happens to
  // name: a key reachable only through the per-platform policy would otherwise
  // drift out of the browser's list unnoticed, and refuse that platform for good.
  const policies = [...Object.values(ACTION_FEATURE_KEYS), ...Object.values(AGENT_PLATFORM_FEATURE_KEYS)];
  for (const required of policies) {
    for (const key of required) assert(keys.includes(key), `unknown FLAG_KEYS entry: ${key}`);
  }
});

for (const value of [true, "true", JSON.stringify("true")]) {
  Deno.test(`browser-compatible global true ${JSON.stringify(value)} grants`, async () => {
    const { admin } = adminStub({ globalRows: [{ key: MESSAGING, value }] });
    assertEquals(await assertEntitled(admin, WORKSPACE, "list_whatsapp_numbers", REQUEST), null);
  });
}

for (const value of [false, "false", JSON.stringify(JSON.stringify("true")), "invalid", 1, null]) {
  Deno.test(`disabled or non-browser truth ${JSON.stringify(value)} refuses`, async () => {
    await expectRefusal({ globalRows: [{ key: MESSAGING, value }] }, undefined, undefined, [MESSAGING]);
  });
}

for (const expires_at of [null, "2999-01-01T00:00:00Z"]) {
  Deno.test(`an active owner override (${expires_at}) beats a false global`, async () => {
    const { admin } = adminStub({
      globalRows: [{ key: MESSAGING, value: false }],
      overrides: [{ user_id: OWNER, feature_key: MESSAGING, enabled: true, expires_at }],
    });
    assertEquals(await assertEntitled(admin, WORKSPACE, "list_whatsapp_numbers", REQUEST), null);
  });
}

Deno.test("an active false override revokes a global grant", async () => {
  await expectRefusal({ overrides: [
    { user_id: OWNER, feature_key: MESSAGING, enabled: false, expires_at: null },
  ] }, undefined, undefined, [MESSAGING]);
});

for (const expires_at of ["2020-01-01T00:00:00Z", "invalid"]) {
  Deno.test(`an expired or invalid override (${expires_at}) cannot grant`, async () => {
    await expectRefusal({ globalRows: [{ key: MESSAGING, value: false }], overrides: [
      { user_id: OWNER, feature_key: MESSAGING, enabled: true, expires_at },
    ] });
  });
}

Deno.test("an expired override is ignored entirely, preserving a global grant", async () => {
  const { admin } = adminStub({ overrides: [
    { user_id: OWNER, feature_key: MESSAGING, enabled: false, expires_at: "2020-01-01T00:00:00Z" },
  ] });
  assertEquals(await assertEntitled(admin, WORKSPACE, "list_whatsapp_numbers", REQUEST), null);
});

Deno.test("another owner's override cannot grant this workspace access", async () => {
  await expectRefusal({ globalRows: [{ key: MESSAGING, value: false }], overrides: [
    { user_id: "other-owner", feature_key: MESSAGING, enabled: true, expires_at: null },
  ] });
});

for (const failedTable of ["partner_provisioned_workspaces", "app_settings", "user_feature_overrides"]) {
  for (const throws of [false, true]) {
    Deno.test(`${failedTable} ${throws ? "throws" : "returns error with data"}: internal_error and a log row`, async () => {
      await expectRefusal({ failedTable, throws }, "internal_error");
    });
  }
}

Deno.test("a missing global row refuses even with an owner override", async () => {
  for (const overrides of [[], [{ user_id: OWNER, feature_key: MESSAGING, enabled: true, expires_at: null }]]) {
    await expectRefusal({ globalRows: [], overrides }, undefined, undefined, [MESSAGING]);
  }
});

for (const ownerRow of [null, { owner_user_id: null }]) {
  Deno.test(`missing provisioned owner ${JSON.stringify(ownerRow)} refuses`, async () => {
    const stub = await expectRefusal({ ownerRow });
    assertEquals(stub.reads, ["partner_provisioned_workspaces"]);
  });
}

for (const action of ["unlisted_action", "toString", "constructor", "__proto__"]) {
  Deno.test(`policy gap ${action} refuses before database reads`, async () => {
    const stub = await expectRefusal({}, "internal_error", action);
    assertEquals(stub.reads, []);
  });
}

for (const action of ["create_whatsapp_pairing", "register_whatsapp_number", "get_whatsapp_pairing"]) {
  Deno.test(`${action} requires messaging AND Direct QR`, async () => {
    for (const [messaging, qr, missing] of [
      [true, false, [QR]], [false, true, [MESSAGING]], [false, false, [MESSAGING, QR]],
    ] as const) {
      await expectRefusal({ globalRows: [
        { key: MESSAGING, value: messaging }, { key: QR, value: qr },
      ] }, undefined, action, [...missing]);
    }
  });
}
