import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { syncUserQuotas } from "./syncUserQuotas.ts";

// I1 (2026-08-23 final review): the sync-user-quotas button exists for
// exactly one case — "webhooks are delayed or missed" — meaning Stripe shows
// a paying customer but user_subscriptions has no row for them. Clearing the
// per-user override alone does nothing for that user: with no
// user_subscriptions row, effective_user_quotas() falls through to the free
// plan. The fix must write user_subscriptions (the resolved plan_id, from a
// real Stripe subscription) BEFORE clearing the override, so the arbiter
// actually has the paid plan to resolve to.

interface Call {
  table: string;
  op: "upsert" | "select";
  payload?: unknown;
}

function fakeSupabase(planRowId: string | null) {
  const calls: Call[] = [];
  const client = {
    from: (table: string) => ({
      select: (_columns: string) => ({
        eq: (_col: string, _val: unknown) => ({
          maybeSingle: () => {
            calls.push({ table, op: "select" });
            return Promise.resolve({ data: planRowId ? { id: planRowId } : null, error: null });
          },
        }),
      }),
      upsert: (payload: unknown, _opts: unknown) => {
        calls.push({ table, op: "upsert", payload });
        return Promise.resolve({ error: null });
      },
    }),
  };
  return { client, calls };
}

function fakeStripeWithActiveSubscription(priceId: string) {
  return {
    customers: {
      // deno-lint-ignore require-await
      list: async (_args: unknown) => ({ data: [{ id: "cus_123" }] }),
    },
    subscriptions: {
      // deno-lint-ignore require-await
      list: async (_args: unknown) => ({
        data: [
          {
            id: "sub_123",
            items: { data: [{ price: { id: priceId } }] },
            current_period_start: 1700000000,
            current_period_end: 1702592000,
            cancel_at_period_end: false,
          },
        ],
      }),
    },
    // deno-lint-ignore no-explicit-any
  } as any;
}

function fakeStripeWithNoCustomer() {
  return {
    customers: {
      // deno-lint-ignore require-await
      list: async (_args: unknown) => ({ data: [] }),
    },
    subscriptions: {
      // deno-lint-ignore require-await
      list: async (_args: unknown) => ({ data: [] }),
    },
    // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("syncUserQuotas repairs user_subscriptions with the resolved plan BEFORE clearing overrides (missed webhook)", async () => {
  const { client, calls } = fakeSupabase("plan-row-pro");
  const stripe = fakeStripeWithActiveSubscription("price_1SpPKL0hJJ11XlNONGaoHAI0"); // pro

  const planSlug = await syncUserQuotas(client, stripe, "user-1", "user1@example.com");

  assertEquals(planSlug, "pro");

  const subUpsert = calls.find((c) => c.table === "user_subscriptions" && c.op === "upsert");
  const quotaUpsert = calls.find((c) => c.table === "user_quotas" && c.op === "upsert");

  // The whole point of the fix: a missed-webhook repair must actually write
  // user_subscriptions with the resolved plan, or the arbiter has nothing to
  // resolve the paid plan from.
  if (!subUpsert) {
    throw new Error("syncUserQuotas never wrote user_subscriptions — the resolved plan never takes effect");
  }
  assertEquals((subUpsert.payload as any).plan_id, "plan-row-pro");
  assertEquals((subUpsert.payload as any).status, "active");
  assertEquals((subUpsert.payload as any).user_id, "user-1");

  if (!quotaUpsert) {
    throw new Error("syncUserQuotas never cleared the per-user override");
  }

  // Ordering: the subscription repair must happen before the override clear,
  // or a concurrent read between the two calls could still see "no plan".
  const subIndex = calls.indexOf(subUpsert);
  const quotaIndex = calls.indexOf(quotaUpsert);
  if (subIndex === -1 || quotaIndex === -1 || subIndex >= quotaIndex) {
    throw new Error(
      `user_subscriptions must be repaired before user_quotas overrides are cleared (subIndex=${subIndex}, quotaIndex=${quotaIndex})`,
    );
  }
});

Deno.test("syncUserQuotas writes nothing to user_subscriptions for a free (no Stripe subscription) user", async () => {
  const { client, calls } = fakeSupabase(null);
  const stripe = fakeStripeWithNoCustomer();

  const planSlug = await syncUserQuotas(client, stripe, "user-2", "user2@example.com");

  assertEquals(planSlug, "free");
  const subUpsert = calls.find((c) => c.table === "user_subscriptions" && c.op === "upsert");
  assertEquals(subUpsert, undefined);

  const quotaUpsert = calls.find((c) => c.table === "user_quotas" && c.op === "upsert");
  if (!quotaUpsert) {
    throw new Error("syncUserQuotas never cleared the per-user override for a free user");
  }
});
