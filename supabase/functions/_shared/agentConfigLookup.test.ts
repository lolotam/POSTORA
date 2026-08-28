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

Deno.test("a reconnected account still finds the owner's config for its platform", async () => {
  // 2026-08-28 incident: relinking WhatsApp by QR inserts a NEW social_accounts
  // row, so the config stayed pinned to the deactivated predecessor. Reading
  // only by account id returned nothing and every inbound message was answered
  // with agent_not_configured.
  const admin = fakeAdmin([CONFIG]);
  const config = await loadAgentConfigForAccount(admin, {
    userId: OWNER,
    platform: "whatsapp",
    accountId: "acc-reconnected",
  });

  assertEquals(config?.id, "cfg-1");
  assertEquals(config?.persona_instructions, "the brand voice");
});

Deno.test("a caller naming no account reads the platform's config, assigned or not", async () => {
  // The settings form sends no account id. Requiring social_account_id IS NULL
  // here is what made ai_get_config return null for every user the moment the
  // expansion migration backfilled that column.
  const admin = fakeAdmin([CONFIG]);
  const config = await loadAgentConfigForAccount(admin, {
    userId: OWNER,
    platform: "whatsapp",
    accountId: null,
  });

  assertEquals(config?.id, "cfg-1");
  assertEquals(admin.queries[0].social_account_id, undefined);
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
