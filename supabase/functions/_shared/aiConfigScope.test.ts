import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type AdminClient,
  type ConfigScopeQuery,
  parseNamedAccountId,
  resolveConfigWriteAccount,
  resolveOwnedAccountId,
  writeAccountScopedConfig,
} from "./aiConfigScope.ts";

type Row = Record<string, unknown> & { id: string };

interface Write {
  table: string;
  kind: "update" | "upsert";
  values: Record<string, unknown>;
  filters: Record<string, unknown>;
}

/**
 * Stands in for the service-role client at the database boundary, in the
 * register of agentConfigLookup.test.ts. Reads answer from `rows`; writes are
 * recorded rather than applied, because the assertions that matter are which
 * row a write targets and what it sets -- not how the builder was called.
 */
function fakeAdmin(rows: Row[]) {
  const writes: Write[] = [];
  const matching = (table: string, filters: Record<string, unknown>) =>
    rows.filter((row) =>
      row.__table === table &&
      Object.entries(filters).every(([column, value]) => row[column] === value)
    );

  const builder = (
    table: string,
    filters: Record<string, unknown>,
    pending: { kind: Write["kind"]; values: Record<string, unknown> } | null,
  ): ConfigScopeQuery => ({
    select: () => builder(table, filters, pending),
    eq: (column: string, value: unknown) => builder(table, { ...filters, [column]: value }, pending),
    update: (values: Record<string, unknown>) => builder(table, filters, { kind: "update", values }),
    upsert: (values: Record<string, unknown>) => builder(table, filters, { kind: "upsert", values }),
    maybeSingle: () => Promise.resolve({ data: matching(table, filters)[0] ?? null, error: null }),
    single: () => {
      if (pending) writes.push({ table, kind: pending.kind, values: pending.values, filters });
      return Promise.resolve({
        data: pending ? { id: "written", ...pending.values } : matching(table, filters)[0] ?? null,
        error: null,
      });
    },
    then: (onfulfilled, onrejected) =>
      Promise.resolve({ data: matching(table, filters), error: null }).then(onfulfilled, onrejected),
  });

  return { writes, from: (table: string) => builder(table, {}, null) } as AdminClient & {
    writes: Write[];
  };
}

const OWNER = "user-1";

const ACCOUNTS: Row[] = [
  { __table: "social_accounts", id: "acc-live", user_id: OWNER, platform: "instagram", is_active: true },
  { __table: "social_accounts", id: "acc-dead", user_id: OWNER, platform: "instagram", is_active: false },
  { __table: "social_accounts", id: "acc-other", user_id: "user-2", platform: "instagram", is_active: true },
  { __table: "social_accounts", id: "acc-facebook", user_id: OWNER, platform: "facebook", is_active: true },
];

Deno.test("a malformed account id is refused, never read as an absent one", async (t) => {
  // "" / 0 / false reaching the unscoped path is a caller bug reinterpreted as
  // consent: the server then picks an account and writes to a different row
  // than the caller believed they had named.
  const cases: Array<[string, unknown, "absent" | "id" | "invalid"]> = [
    ["undefined", undefined, "absent"],
    ["null", null, "absent"],
    ["empty string", "", "invalid"],
    ["whitespace", "   ", "invalid"],
    ["zero", 0, "invalid"],
    ["false", false, "invalid"],
    ["a real id", "acc-live", "id"],
  ];

  for (const [label, input, expected] of cases) {
    await t.step(label, () => {
      const parsed = parseNamedAccountId(input);
      assertEquals(Object.keys(parsed)[0], expected);
    });
  }
});

Deno.test("a named account resolves even when it is deactivated", async () => {
  // Deliberate: the caller NAMED this account. A QR reconnect deactivates the
  // old row, and the operator must still be able to read and fix its config.
  // Choosing an account on the caller's behalf is the path that must refuse a
  // dead row -- see resolveConfigWriteAccount below.
  const admin = fakeAdmin(ACCOUNTS);
  assertEquals(await resolveOwnedAccountId(admin, OWNER, "instagram", "acc-dead"), "acc-dead");
});

Deno.test("a named account belonging to someone else, or another platform, resolves to nothing", async (t) => {
  const cases: Array<[string, string, string]> = [
    ["another owner's account", "instagram", "acc-other"],
    ["the owner's account on a different platform", "instagram", "acc-facebook"],
    ["an id that matches nothing", "instagram", "acc-missing"],
  ];

  for (const [label, platform, requested] of cases) {
    await t.step(label, async () => {
      const admin = fakeAdmin(ACCOUNTS);
      assertEquals(await resolveOwnedAccountId(admin, OWNER, platform, requested), null);
    });
  }
});

Deno.test("an unscoped write is only resolved when one active account makes it unambiguous", async (t) => {
  const cases: Array<[string, Row[], string, unknown]> = [
    ["exactly one active account", ACCOUNTS, "instagram", { accountId: "acc-live" }],
    // The inactive sibling must not make this ambiguous, and must never be chosen.
    ["one active plus one dead", ACCOUNTS, "facebook", { accountId: "acc-facebook" }],
    ["no accounts at all", ACCOUNTS, "threads", { error: "social_account_id is required" }],
    [
      "two active accounts",
      [...ACCOUNTS, { __table: "social_accounts", id: "acc-live-2", user_id: OWNER, platform: "instagram", is_active: true }],
      "instagram",
      { error: "social_account_id is required" },
    ],
  ];

  for (const [label, rows, platform, expected] of cases) {
    await t.step(label, async () => {
      assertEquals(await resolveConfigWriteAccount(fakeAdmin(rows), OWNER, platform), expected);
    });
  }
});

Deno.test("a scoped write never moves a config that belongs to another account", async () => {
  // An earlier draft moved the platform's sole config onto the requested
  // account whenever the account holding it was inactive, calling that the QR
  // reconnect repair. "The other account is inactive" proves nothing of the
  // kind -- a temporarily deactivated page would have had its persona stolen
  // by an unrelated sibling. The write inserts instead, and the legacy
  // constraint's 23505 is surfaced as what it means.
  const admin = fakeAdmin([
    ...ACCOUNTS,
    { __table: "ai_agent_configs", id: "cfg-1", user_id: OWNER, platform: "instagram", social_account_id: "acc-dead" },
  ]);

  await writeAccountScopedConfig(admin, {
    userId: OWNER,
    platform: "instagram",
    accountId: "acc-live",
    updates: { is_enabled: true },
  });

  assertEquals(admin.writes.length, 1);
  // An insert against the account, NOT an update of cfg-1.
  assertEquals(admin.writes[0].kind, "upsert");
  assertEquals(admin.writes[0].values.social_account_id, "acc-live");
});

Deno.test("a scoped write updates the account's own config in place", async () => {
  const admin = fakeAdmin([
    ...ACCOUNTS,
    { __table: "ai_agent_configs", id: "cfg-live", user_id: OWNER, platform: "instagram", social_account_id: "acc-live" },
  ]);

  await writeAccountScopedConfig(admin, {
    userId: OWNER,
    platform: "instagram",
    accountId: "acc-live",
    updates: { is_enabled: true },
  });

  assertEquals(admin.writes[0].kind, "update");
  assertEquals(admin.writes[0].filters.id, "cfg-live");
  // The account is not restated: an in-place update must not touch the binding.
  assertEquals(admin.writes[0].values.social_account_id, undefined);
});

Deno.test("a platform with no config at all is inserted against the account", async () => {
  const admin = fakeAdmin(ACCOUNTS);

  await writeAccountScopedConfig(admin, {
    userId: OWNER,
    platform: "instagram",
    accountId: "acc-live",
    updates: { is_enabled: true },
  });

  assertEquals(admin.writes.length, 1);
  assertEquals(admin.writes[0].kind, "upsert");
  assertEquals(admin.writes[0].values.social_account_id, "acc-live");
  assertEquals(admin.writes[0].values.user_id, OWNER);
});
