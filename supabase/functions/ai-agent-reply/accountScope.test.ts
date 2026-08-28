import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type AccountByIdQuery, resolveAgentAccountId, SANDBOX_ACCOUNT_ID } from "./accountScope.ts";

interface Filters {
  id?: string;
  user_id?: string;
  platform?: string;
}

/** Fake service-role client at the database boundary; the filters are the
 *  behaviour under test. See agentConfigLookup.test.ts for the register. */
function fakeAdmin(rows: Array<Record<string, unknown> & { id: string }>) {
  const queries: Filters[] = [];
  const builder = (filters: Filters): AccountByIdQuery => ({
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
const REQUEST_BASE = { user_id: OWNER, platform: "instagram" };

Deno.test("resolves the caller's account when id, owner and platform all match", async () => {
  const admin = fakeAdmin([
    { id: "acc-ig", user_id: OWNER, platform: "instagram" },
  ]);
  const id = await resolveAgentAccountId(admin, { ...REQUEST_BASE, social_account_id: "acc-ig" });
  assertEquals(id, "acc-ig");
});

Deno.test("refuses an account whose platform differs from the request", async () => {
  // An internal request naming platform "instagram" with a Facebook account
  // id used to resolve and then load the Facebook persona for an Instagram
  // customer -- same owner, wrong brand.
  const admin = fakeAdmin([
    { id: "acc-fb", user_id: OWNER, platform: "facebook" },
  ]);
  const id = await resolveAgentAccountId(admin, { ...REQUEST_BASE, social_account_id: "acc-fb" });
  assertEquals(id, null);
});

Deno.test("refuses another owner's account and names no account at all", async (t) => {
  await t.step("another owner", async () => {
    const admin = fakeAdmin([
      { id: "acc-ig", user_id: "user-2", platform: "instagram" },
    ]);
    const id = await resolveAgentAccountId(admin, { ...REQUEST_BASE, social_account_id: "acc-ig" });
    assertEquals(id, null);
  });

  await t.step("no account id", async () => {
    const admin = fakeAdmin([{ id: "acc-ig", user_id: OWNER, platform: "instagram" }]);
    const id = await resolveAgentAccountId(admin, { ...REQUEST_BASE, social_account_id: null });
    assertEquals(id, null);
  });
});

Deno.test("the sandbox placeholder stays an unscoped request", async () => {
  // The test sandbox has no connected account behind it; treating "test" as
  // a real id would query (and miss) instead of falling back to the
  // user-wide rows that keep the sandbox working.
  const admin = fakeAdmin([{ id: "acc-ig", user_id: OWNER, platform: "instagram" }]);
  const id = await resolveAgentAccountId(admin, {
    ...REQUEST_BASE,
    social_account_id: SANDBOX_ACCOUNT_ID,
  });
  assertEquals(id, null);
  assertEquals(admin.queries.length, 0);
});
