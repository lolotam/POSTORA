import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  FREE_TIER_MAX_SOCIAL_ACCOUNTS,
  resolveMaxSocialAccounts,
  type SocialAccountQuotaClient,
} from "./socialAccountQuota.ts";

/**
 * Stands in for the two reads the resolver makes. `quota` is the user_quotas
 * row (null = no row at all), `plan` the embedded subscription_plans payload.
 */
function quotaClient(options: {
  quota?: { max_social_accounts: unknown } | null;
  plan?: unknown;
  quotaError?: unknown;
  planError?: unknown;
}): { admin: SocialAccountQuotaClient; tablesRead: string[] } {
  const tablesRead: string[] = [];
  const admin = {
    from(table: string) {
      tablesRead.push(table);
      const result = table === "user_quotas"
        ? { data: options.quota ?? null, error: options.quotaError ?? null }
        : {
          data: options.plan === undefined ? null : { subscription_plans: options.plan },
          error: options.planError ?? null,
        };
      const leaf = { maybeSingle: () => Promise.resolve(result) };
      const chain = { eq: () => chain, maybeSingle: leaf.maybeSingle };
      return { select: () => chain };
    },
  };
  return { admin: admin as unknown as SocialAccountQuotaClient, tablesRead };
}

Deno.test("the allowance follows override, then plan, then the free floor", async (t) => {
  // Production shapes, in precedence order. The Pro and Business rows are the
  // regression: both subscribers were refused at 3 by the Direct QR connect
  // path while the UI showed them the allowance they had paid for.
  const cases: Array<{
    name: string;
    quota?: { max_social_accounts: unknown } | null;
    plan?: unknown;
    expected: number;
  }> = [
    { name: "explicit per-user override wins over the plan", quota: { max_social_accounts: 7 }, plan: { max_social_accounts: 30 }, expected: 7 },
    { name: "an override of -1 means unlimited", quota: { max_social_accounts: -1 }, plan: { max_social_accounts: 3 }, expected: -1 },
    { name: "Pro subscriber with no override gets the plan allowance", quota: { max_social_accounts: null }, plan: { max_social_accounts: 30 }, expected: 30 },
    { name: "Business subscriber inherits unlimited from the plan", quota: null, plan: { max_social_accounts: -1 }, expected: -1 },
    { name: "no quota row and no subscription falls back to the free floor", quota: null, expected: FREE_TIER_MAX_SOCIAL_ACCOUNTS },
    { name: "a quota row with a NULL allowance is not an override", quota: { max_social_accounts: null }, expected: FREE_TIER_MAX_SOCIAL_ACCOUNTS },
    { name: "an embedded plan returned as an array is still read", quota: null, plan: [{ max_social_accounts: 30 }], expected: 30 },
    { name: "a plan row with a NULL allowance falls back to the free floor", quota: null, plan: { max_social_accounts: null }, expected: FREE_TIER_MAX_SOCIAL_ACCOUNTS },
  ];

  for (const testCase of cases) {
    await t.step(testCase.name, async () => {
      const { admin } = quotaClient({ quota: testCase.quota, plan: testCase.plan });
      assertEquals(await resolveMaxSocialAccounts(admin, "user-1"), testCase.expected);
    });
  }
});

Deno.test("an override short-circuits the plan lookup entirely", async () => {
  const { admin, tablesRead } = quotaClient({ quota: { max_social_accounts: 7 }, plan: { max_social_accounts: 30 } });
  await resolveMaxSocialAccounts(admin, "user-1");
  assertEquals(tablesRead, ["user_quotas"]);
});

Deno.test("a failed plan lookup falls back to the free floor rather than throwing", async () => {
  // Refusing a connect outright would be worse than applying the free floor:
  // the user may legitimately be under it.
  const { admin } = quotaClient({ quota: null, planError: { message: "relation missing" } });
  assertEquals(await resolveMaxSocialAccounts(admin, "user-1"), FREE_TIER_MAX_SOCIAL_ACCOUNTS);
});

Deno.test("a failed quota read is raised, not silently widened", async () => {
  // The override read failing means the caller's entitlement is unknown; the
  // one thing that must never happen is inventing a larger allowance.
  const { admin } = quotaClient({ quotaError: { message: "permission denied" } });
  await assertRejects(() => resolveMaxSocialAccounts(admin, "user-1"));
});
