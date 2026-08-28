import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { loadAgentConfigForAccount } from "./agentConfigLookup.ts";

interface Filters {
  user_id?: string;
  platform?: string;
  social_account_id?: string;
}

/**
 * Stands in for the Supabase client. The database is a system boundary, so the
 * assertions are on which row comes back for a given table, not on how the
 * query builder was called -- except for the filters, which ARE the behaviour
 * under test: the whole defect was one filter too many.
 */
function fakeAdmin(rows: Array<Record<string, unknown>>) {
  const queries: Filters[] = [];
  const builder = (filters: Filters): any => ({
    select: () => builder(filters),
    eq: (column: string, value: string) => builder({ ...filters, [column]: value }),
    maybeSingle: () => {
      queries.push(filters);
      const match = rows.find((row) =>
        Object.entries(filters).every(([column, value]) => row[column] === value)
      );
      return Promise.resolve({ data: match ?? null, error: null });
    },
  });
  return { queries, from: () => builder({}) };
}

const OWNER = "user-1";
const CONFIG = {
  id: "cfg-1",
  user_id: OWNER,
  platform: "whatsapp",
  social_account_id: "acc-live",
  persona_instructions: "the brand voice",
};

Deno.test("an account reads its own config", async () => {
  const admin = fakeAdmin([CONFIG]);
  const config = await loadAgentConfigForAccount(admin, {
    userId: OWNER,
    platform: "whatsapp",
    accountId: "acc-live",
  });

  assertEquals(config?.id, "cfg-1");
  // One query: the account matched, so the platform fallback never ran.
  assertEquals(admin.queries.length, 1);
});

Deno.test("an account with no config of its own is unconfigured, not inherited", async () => {
  // 20260828200000 dropped ai_agent_configs_user_id_platform_key and gave every
  // active account its own row, so the platform fallback that used to answer
  // here became a genuine cross-account read -- page B replying in page A's
  // brand voice. An unconfigured account now reads as exactly that, and the
  // caller logs agent_not_configured instead of guessing.
  const admin = fakeAdmin([CONFIG]);
  const config = await loadAgentConfigForAccount(admin, {
    userId: OWNER,
    platform: "whatsapp",
    accountId: "acc-reconnected",
  });

  assertEquals(config, null);
});

Deno.test("a caller naming no account gets nothing", async () => {
  // The settings form always names an account since PR B-1. A caller that does
  // not cannot be answered without picking a brand voice on its behalf.
  const admin = fakeAdmin([CONFIG]);
  const config = await loadAgentConfigForAccount(admin, {
    userId: OWNER,
    platform: "whatsapp",
    accountId: null,
  });

  assertEquals(config, null);
  // And it must not have queried at all -- no account, no lookup.
  assertEquals(admin.queries.length, 0);
});

Deno.test("nothing is borrowed across owners or platforms", async (t) => {
  const cases: Array<[string, string, string, string | null]> = [
    ["another owner", "user-2", "whatsapp", "acc-live"],
    ["another platform", OWNER, "instagram", null],
    ["another owner, no account named", "user-2", "whatsapp", null],
  ];

  for (const [label, userId, platform, accountId] of cases) {
    await t.step(label, async () => {
      const config = await loadAgentConfigForAccount(fakeAdmin([CONFIG]), {
        userId,
        platform,
        accountId,
      });
      assertEquals(config, null);
    });
  }
});
