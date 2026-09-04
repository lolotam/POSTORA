import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import { handleRequest, syncContactsToSheet, type SyncDependencies } from "./index.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const WS = "22222222-2222-4222-8222-222222222222";
const CONNECTION = "33333333-3333-4333-8333-333333333333";
const CONTACT_A = "44444444-4444-4444-8444-444444444444";
const CONTACT_B = "44444444-4444-4444-8444-444444444445";

const CONNECTION_ROW = {
  id: CONNECTION,
  workspace_id: WS,
  connector_type: "google_sheets",
  toolkit: "googlesheets",
  composio_connected_account_id: "composio-ca-1",
  tool_schema_cache: [],
  status: "active",
};

const CONTACTS = [
  {
    id: CONTACT_A,
    platform: "instagram",
    platform_user_id: "178",
    display_name: "Dana KW",
    username: "dana.kw",
    phone_number: "96550000000",
    email: "dana@example.com",
    source: "organic_comment",
    last_comment_text: "price?",
  },
  {
    id: CONTACT_B,
    platform: "threads",
    platform_user_id: "vigrox.kw",
    display_name: "",
    username: "vigrox.kw",
    phone_number: null,
    email: null,
    source: "workflow_lead",
    last_comment_text: null,
  },
];

// Records its filters. The service role bypasses RLS, so `.eq("user_id", ...)`
// on social_contacts IS the tenancy boundary -- a fake that drops the argument
// lets that line be deleted with every test still green.
interface QueryRecorder { eq: Array<[string, unknown]>; in: Array<[string, unknown]> }

function queryable(result: { data: unknown; error: unknown }, calls?: QueryRecorder) {
  const q: Record<string, unknown> = {
    select: () => q,
    eq: (column: string, value: unknown) => { calls?.eq.push([column, value]); return q; },
    in: (column: string, value: unknown) => { calls?.in.push([column, value]); return q; },
    maybeSingle: () => Promise.resolve(result),
  };
  q.then = (
    resolve: (value: unknown) => unknown,
    reject: (reason?: unknown) => unknown = () => {},
  ) => Promise.resolve(result).then(resolve, reject);
  return q;
}

interface AdminOptions {
  connection?: { data: unknown; error: unknown } | null;
  member?: boolean;
  contacts?: { data: unknown; error: unknown } | null;
}

function fakeAdmin(options: AdminOptions = {}) {
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const ledger: Array<Record<string, unknown>> = [];
  const filters: Record<string, QueryRecorder> = {
    connector_connections: { eq: [], in: [] },
    social_contacts: { eq: [], in: [] },
  };
  return {
    rpcCalls,
    ledger,
    filters,
    from(table: string) {
      if (table === "connector_connections") {
        return queryable(options.connection ?? { data: CONNECTION_ROW, error: null }, filters.connector_connections);
      }
      if (table === "social_contacts") {
        return queryable(options.contacts ?? { data: CONTACTS, error: null }, filters.social_contacts);
      }
      if (table === "connector_call_logs") {
        return { insert: (row: Record<string, unknown>) => { ledger.push(row); return Promise.resolve({ error: null }); } };
      }
      throw new Error(`unexpected table: ${table}`);
    },
    rpc(fn: string, args: Record<string, unknown>) {
      rpcCalls.push({ fn, args });
      if (fn === "is_workspace_member") {
        return Promise.resolve({ data: options.member ?? true, error: null });
      }
      return Promise.resolve({ data: null, error: { message: `unexpected rpc: ${fn}` } });
    },
  };
}

function fakeComposio(outcome: { successful: boolean; error?: string } = { successful: true }) {
  const executions: Array<Record<string, unknown>> = [];
  return {
    executions,
    executeTool(input: Record<string, unknown>) {
      executions.push(input);
      return Promise.resolve(outcome);
    },
  };
}

function dependencies(
  admin: ReturnType<typeof fakeAdmin>,
  composio: ReturnType<typeof fakeComposio>,
): SyncDependencies {
  return {
    admin,
    composio,
    authenticate: () => Promise.resolve({ userId: USER }),
  };
}

function request(body: unknown) {
  return new Request("https://api.postora.cloud/functions/v1/audience-sheets-sync", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test-token" },
    body: JSON.stringify(body),
  });
}

const BODY = {
  connection_id: CONNECTION,
  spreadsheet_id: "1AbC_spreadsheet",
  sheet_name: "Sheet1",
  contact_ids: [CONTACT_A, CONTACT_B],
};

async function payload(response: Response) {
  return await response.json();
}

Deno.test("a non-member receives forbidden and no tool executes", async () => {
  const admin = fakeAdmin({ member: false });
  const composio = fakeComposio();
  const response = await handleRequest(request(BODY), () => dependencies(admin, composio));
  assertEquals(response.status, 200);
  assertEquals(await payload(response), { ok: false, error: "forbidden" });
  assertEquals(composio.executions.length, 0);
});

Deno.test("appends one row per contact in caller order with the Composio append arguments", async () => {
  const admin = fakeAdmin();
  const composio = fakeComposio();
  const response = await handleRequest(request(BODY), () => dependencies(admin, composio));
  assertEquals(response.status, 200);
  assertEquals(await payload(response), { ok: true, appended: 2 });

  assertEquals(composio.executions.length, 1);
  const execution = composio.executions[0] as {
    slug: string;
    version: string;
    workspaceId: string;
    connectedAccountId: string;
    arguments: Record<string, unknown>;
  };
  assertEquals(execution.slug, "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND");
  assertEquals(execution.version, "20260902_00");
  assertEquals(execution.workspaceId, WS);
  assertEquals(execution.connectedAccountId, "composio-ca-1");
  assertEquals(execution.arguments.spreadsheetId, "1AbC_spreadsheet");
  assertEquals(execution.arguments.range, "'Sheet1'!A:H");
  assertEquals(execution.arguments.valueInputOption, "RAW");
  assertEquals(execution.arguments.majorDimension, "ROWS");

  const values = execution.arguments.values as string[][];
  assertEquals(values.length, 2);
  const [first, second] = values;
  assertEquals(first[1], "Dana KW");
  assertEquals(first[2], "instagram");
  assertEquals(first[3], "dana.kw");
  assertEquals(first[4], "96550000000");
  assertEquals(first[5], "dana@example.com");
  assertEquals(first[6], "organic_comment");
  assertEquals(first[7], "price?");
  assertEquals(Number.isNaN(Date.parse(first[0])), false);
  // Empty display_name falls back to the username in the label cell.
  assertEquals(second[1], "vigrox.kw");
});

Deno.test("a tool failure answers 200 with ok: false", async () => {
  const admin = fakeAdmin();
  const composio = fakeComposio({ successful: false, error: "sheets quota" });
  const response = await handleRequest(request(BODY), () => dependencies(admin, composio));
  assertEquals(response.status, 200);
  const body = await payload(response) as { ok: boolean; error: string };
  assertEquals(body.ok, false);
  assertEquals(typeof body.error, "string");
});

Deno.test("an unknown connection is refused before the membership rpc", async () => {
  const admin = fakeAdmin({ connection: { data: null, error: null } });
  const composio = fakeComposio();
  const response = await handleRequest(request(BODY), () => dependencies(admin, composio));
  assertEquals(response.status, 200);
  assertEquals(await payload(response), { ok: false, error: "connection_not_found" });
  assertEquals(admin.rpcCalls.length, 0);
  assertEquals(composio.executions.length, 0);
});

Deno.test("contact ids that are not uuids are a 400 invalid_request", async () => {
  const admin = fakeAdmin();
  const composio = fakeComposio();
  const response = await handleRequest(
    request({ ...BODY, contact_ids: ["not-a-uuid"] }),
    () => dependencies(admin, composio),
  );
  assertEquals(response.status, 400);
  assertEquals(await payload(response), { ok: false, error: "invalid_request" });
  assertEquals(composio.executions.length, 0);
});

Deno.test("more than 200 contact ids are a 400 invalid_request", async () => {
  const admin = fakeAdmin();
  const composio = fakeComposio();
  const ids = Array.from({ length: 201 }, (_, i) =>
    `44444444-4444-4444-8444-${String(i).padStart(12, "0")}`
  );
  const response = await handleRequest(
    request({ ...BODY, contact_ids: ids }),
    () => dependencies(admin, composio),
  );
  assertEquals(response.status, 400);
  assertEquals(await payload(response), { ok: false, error: "invalid_request" });
});

Deno.test("a failed authentication is a 401 and calls nothing", async () => {
  const admin = fakeAdmin();
  const composio = fakeComposio();
  const response = await handleRequest(request(BODY), () => ({
    admin,
    composio,
    authenticate: () => Promise.reject(new Error("Unauthorized: invalid or expired token")),
  }));
  assertEquals(response.status, 401);
  assertEquals(await payload(response), { error: "unauthorized" });
  assertEquals(composio.executions.length, 0);
});

Deno.test("contacts owned by another user are dropped from the append", async () => {
  const admin = fakeAdmin({
    contacts: { data: [CONTACTS[1]], error: null },
  });
  const composio = fakeComposio();
  const response = await handleRequest(request(BODY), () => dependencies(admin, composio));
  assertEquals(response.status, 200);
  assertEquals(await payload(response), { ok: true, appended: 1 });
  const values = (composio.executions[0] as { arguments: { values: string[][] } })
    .arguments.values;
  assertEquals(values.length, 1);
  assertEquals(values[0][1], "vigrox.kw");
});

// The service role bypasses RLS, so these two filters ARE the tenancy boundary.
// Without this test, deleting either .eq() leaves every other case green.
Deno.test("the contact read is scoped to the caller and the connection to its id", async () => {
  const admin = fakeAdmin();
  const composio = fakeComposio();
  const result = await syncContactsToSheet(dependencies(admin, composio), {
    userId: USER,
    connectionId: CONNECTION,
    spreadsheetId: "sheet-1",
    sheetName: "Sheet1",
    contactIds: [CONTACT_A],
  });
  assertEquals(result.ok, true);
  assertEquals(admin.filters.social_contacts.eq, [["user_id", USER]]);
  assertEquals(admin.filters.social_contacts.in, [["id", [CONTACT_A]]]);
  // loadActiveConnection queries the same table again, so assert containment
  // rather than an exact list: what matters is that the id is always a filter.
  const connectionFilters = admin.filters.connector_connections.eq.map(([c, v]) => `${c}=${v}`);
  assertEquals(connectionFilters.includes(`id=${CONNECTION}`), true);
  assertEquals(connectionFilters.includes(`workspace_id=${WS}`), true);
});

// A tab named anything but Sheet1 needs its title quoted, or Sheets answers an
// unparseable range that the user only ever sees as composio_failed.
Deno.test("a sheet name with a space is quoted in the A1 range", async () => {
  const admin = fakeAdmin();
  const composio = fakeComposio();
  await syncContactsToSheet(dependencies(admin, composio), {
    userId: USER,
    connectionId: CONNECTION,
    spreadsheetId: "sheet-1",
    sheetName: "Contacts 2026",
    contactIds: [CONTACT_A],
  });
  const args = composio.executions[0].arguments as Record<string, unknown>;
  assertEquals(args.range, "'Contacts 2026'!A:H");
});

Deno.test("an apostrophe in the sheet name is doubled", async () => {
  const admin = fakeAdmin();
  const composio = fakeComposio();
  await syncContactsToSheet(dependencies(admin, composio), {
    userId: USER,
    connectionId: CONNECTION,
    spreadsheetId: "sheet-1",
    sheetName: "Dana's tab",
    contactIds: [CONTACT_A],
  });
  const args = composio.executions[0].arguments as Record<string, unknown>;
  assertEquals(args.range, "'Dana''s tab'!A:H");
});

// Every requested id belonged to someone else: there is nothing to append, and
// spending a Composio execution to append nothing is waste, not safety.
Deno.test("no owned contacts appends nothing and never calls the tool", async () => {
  const admin = fakeAdmin({ contacts: { data: [], error: null } });
  const composio = fakeComposio();
  const result = await syncContactsToSheet(dependencies(admin, composio), {
    userId: USER,
    connectionId: CONNECTION,
    spreadsheetId: "sheet-1",
    sheetName: "Sheet1",
    contactIds: [CONTACT_A],
  });
  assertEquals(result, { ok: true, appended: 0 });
  assertEquals(composio.executions.length, 0);
});

// AGENTS.md rule 4: two silent early exits in ai-agent-reply once turned hours of
// no replies into an afternoon of blind debugging. Every outcome writes a row.
Deno.test("a successful append is recorded in the connector ledger", async () => {
  const admin = fakeAdmin();
  await syncContactsToSheet(dependencies(admin, fakeComposio()), {
    userId: USER, connectionId: CONNECTION, spreadsheetId: "s", sheetName: "Sheet1",
    contactIds: [CONTACT_A],
  });
  assertEquals(admin.ledger.length, 1);
  assertEquals(admin.ledger[0].status, "success");
  assertEquals(admin.ledger[0].source, "audience");
  assertEquals(admin.ledger[0].connector_type, "google_sheets");
  assertEquals(admin.ledger[0].action_name, "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND");
  assertEquals(admin.ledger[0].workspace_id, WS);
});

Deno.test("a refusal for a non-member is recorded, not just returned", async () => {
  const admin = fakeAdmin({ member: false });
  const composio = fakeComposio();
  const result = await syncContactsToSheet(dependencies(admin, composio), {
    userId: USER, connectionId: CONNECTION, spreadsheetId: "s", sheetName: "Sheet1",
    contactIds: [CONTACT_A],
  });
  assertEquals(result, { ok: false, error: "forbidden" });
  assertEquals(composio.executions.length, 0);
  assertEquals(admin.ledger.length, 1);
  assertEquals(admin.ledger[0].status, "refused");
  assertEquals(admin.ledger[0].error_code, "forbidden");
});

Deno.test("a failed append is recorded as failed", async () => {
  const admin = fakeAdmin();
  await syncContactsToSheet(dependencies(admin, fakeComposio({ successful: false, error: "quota" })), {
    userId: USER, connectionId: CONNECTION, spreadsheetId: "s", sheetName: "Sheet1",
    contactIds: [CONTACT_A],
  });
  assertEquals(admin.ledger.length, 1);
  assertEquals(admin.ledger[0].status, "refused");
  assertEquals(admin.ledger[0].error_code, "composio_failed");
});
