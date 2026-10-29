import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { CredentialConfigurationError } from "./facebookCredentialMode.ts";
import {
  accountCredentialMode,
  type AuthorityReaderClient,
  parseProtectedPilotUserIds,
  readProtectedAuthorities,
  resolveAccountCredentialMode,
} from "./protectedAccountCutover.ts";

const OWNER = "0f300001-0000-4000-8000-000000000001";
const OTHER = "0f300002-0000-4000-8000-000000000002";
const BOUND_PAGE = "0f3a0001-0000-4000-8000-000000000011";
const DIRECT_IG = "0f3a0002-0000-4000-8000-000000000012";
const LEGACY_IG = "0f3a0003-0000-4000-8000-000000000013";

type Rows = Record<string, Array<Record<string, unknown>>>;

interface Recorded {
  table: string;
  columns: string;
  inValues: unknown[] | null;
}

function fakeClient(
  rows: Rows,
  options: { fail?: string; malformed?: string; reject?: string } = {},
): { client: AuthorityReaderClient; reads: Recorded[] } {
  const reads: Recorded[] = [];
  const client: AuthorityReaderClient = {
    from(table: string) {
      const record: Recorded = { table, columns: "", inValues: null };
      const query = {
        select(columns: string) {
          record.columns = columns;
          reads.push(record);
          return query;
        },
        in(_column: string, values: readonly string[]) {
          record.inValues = [...values];
          return query;
        },
        then(ok: (value: unknown) => unknown, bad?: (reason: unknown) => unknown) {
          if (options.reject === table) return Promise.reject(new Error("transport")).then(ok, bad);
          if (options.fail === table) {
            return Promise.resolve({ data: null, error: { message: "denied" } }).then(ok, bad);
          }
          if (options.malformed === table) {
            return Promise.resolve({ data: [{ social_account_id: 7 }], error: null }).then(ok, bad);
          }
          const all = rows[table] ?? [];
          const data = record.inValues
            ? all.filter((row) => record.inValues!.includes(row.social_account_id))
            : all;
          return Promise.resolve({ data, error: null }).then(ok, bad);
        },
      };
      return query;
    },
  };
  return { client, reads };
}

const ROWS: Rows = {
  facebook_user_credential_bindings: [{ social_account_id: BOUND_PAGE, user_id: OWNER }],
  instagram_account_credentials: [{ social_account_id: DIRECT_IG, user_id: OWNER }],
};

Deno.test("an account with an authority owned by the same user is protected", async () => {
  const { client } = fakeClient(ROWS);
  const authorities = await readProtectedAuthorities(client);
  assertEquals(
    accountCredentialMode("legacy", authorities, { id: BOUND_PAGE, userId: OWNER, platform: "facebook" }),
    "protected",
  );
  assertEquals(
    accountCredentialMode("legacy", authorities, { id: DIRECT_IG, userId: OWNER, platform: "instagram" }),
    "protected",
  );
});

Deno.test("an account without an authority stays legacy", async () => {
  const { client } = fakeClient(ROWS);
  const authorities = await readProtectedAuthorities(client);
  assertEquals(
    accountCredentialMode("legacy", authorities, { id: LEGACY_IG, userId: OWNER, platform: "instagram" }),
    "legacy",
  );
});

Deno.test("an authority row of another owner does not move the account", async () => {
  const { client } = fakeClient(ROWS);
  const authorities = await readProtectedAuthorities(client);
  assertEquals(
    accountCredentialMode("legacy", authorities, { id: DIRECT_IG, userId: OTHER, platform: "instagram" }),
    "legacy",
  );
});

Deno.test("a global protected moves every Meta account and no other platform", () => {
  const none = { has: () => false };
  assertEquals(
    accountCredentialMode("protected", none, { id: LEGACY_IG, userId: OWNER, platform: "instagram" }),
    "protected",
  );
  assertEquals(
    accountCredentialMode("protected", none, { id: LEGACY_IG, userId: OWNER, platform: "tiktok" }),
    "legacy",
  );
});

Deno.test("the authority read selects existence columns only", async () => {
  const { client, reads } = fakeClient(ROWS);
  await readProtectedAuthorities(client, [DIRECT_IG]);
  assertEquals(reads.map((read) => read.table), [
    "facebook_user_credential_bindings",
    "instagram_account_credentials",
  ]);
  for (const read of reads) {
    assertEquals(read.columns, "social_account_id, user_id");
    assertEquals(read.inValues, [DIRECT_IG]);
  }
});

Deno.test("a failed, rejected or malformed authority read is a configuration failure", async () => {
  for (const options of [
    { fail: "facebook_user_credential_bindings" },
    { fail: "instagram_account_credentials" },
    { reject: "instagram_account_credentials" },
    { malformed: "facebook_user_credential_bindings" },
  ]) {
    const { client } = fakeClient(ROWS, options);
    await assertRejects(() => readProtectedAuthorities(client), CredentialConfigurationError);
  }
});

Deno.test("resolving one account reads nothing when the answer is already fixed", async () => {
  const { client, reads } = fakeClient(ROWS);
  assertEquals(
    await resolveAccountCredentialMode("protected", client, { id: LEGACY_IG, userId: OWNER }),
    "protected",
  );
  assertEquals(
    await resolveAccountCredentialMode("legacy", client, {
      id: DIRECT_IG,
      userId: OWNER,
      platform: "tiktok",
    }),
    "legacy",
  );
  assertEquals(
    await resolveAccountCredentialMode("legacy", client, { id: "not-a-uuid", userId: OWNER }),
    "legacy",
  );
  assertEquals(reads.length, 0);
});

Deno.test("resolving one account narrows the read to that account", async () => {
  const { client, reads } = fakeClient(ROWS);
  assertEquals(
    await resolveAccountCredentialMode("legacy", client, { id: DIRECT_IG, userId: OWNER }),
    "protected",
  );
  assertEquals(
    await resolveAccountCredentialMode("legacy", client, {
      id: LEGACY_IG,
      userId: OWNER,
      platform: "instagram",
    }),
    "legacy",
  );
  assertEquals(reads.every((read) => read.inValues?.length === 1), true);
});

Deno.test("the pilot list parses strictly and reads absent as nobody", () => {
  assertEquals(parseProtectedPilotUserIds(null)?.size, 0);
  assertEquals(parseProtectedPilotUserIds(undefined)?.size, 0);
  assertEquals(parseProtectedPilotUserIds([OWNER.toUpperCase()])?.has(OWNER), true);
  assertEquals(parseProtectedPilotUserIds("x"), null);
  assertEquals(parseProtectedPilotUserIds({ ids: [OWNER] }), null);
  assertEquals(parseProtectedPilotUserIds([OWNER, null]), null);
  assertEquals(parseProtectedPilotUserIds(["0f300001"]), null);
});
