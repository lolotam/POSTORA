// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { canStartAnotherWave, runWebhookWorker, WORKER_LIMITS } from "./worker.ts";
import { RETRY_BACKOFF_SECONDS } from "../_shared/partnerWebhookDelivery.ts";

// ---------------------------------------------------------------------------
// The delivery worker (5.3) and its operational visibility (5.4).
//
// The load-bearing tests are Y2 and Y5.
//
//   Y2  A claim CHARGES AN ATTEMPT. Claiming rows the tick's deadline then
//       cuts off spends attempts on deliveries that never happened -- six such
//       ticks exhaust a row and auto-disable a partner's endpoint without a
//       single request having been made. The budget check must therefore run
//       BEFORE the claim, and asking "does a whole wave still fit" rather than
//       "is there any time left".
//
//   Y5  Every exit path settles. A path that returns without settling leaves
//       the row leased for 90 seconds, which is invisible except as backlog
//       age -- the exact failure a correct-looking outbox hides.
// ---------------------------------------------------------------------------

const WEBHOOK = {
  id: "wh-1",
  url: "https://hooks.example.com/postora",
  secret: "whsec_current",
  secret_version: 1,
  previous_secret: null,
  previous_secret_version: null,
  previous_secret_expires_at: null,
};

function delivery(overrides: Record<string, unknown> = {}) {
  return {
    id: "del-1",
    webhook_id: "wh-1",
    workspace_id: "ws-1",
    event_type: "webhook.test",
    event_occurrence_id: "webhook.test:abc",
    payload: { hello: "world" },
    secret_version: 1,
    attempts: 1,
    ...overrides,
  };
}

interface StubOpts {
  /** One array per claim call, in order. Missing entries claim nothing. */
  waves?: any[][];
  targets?: any[];
  backlog?: Record<string, unknown>;
  settleReturns?: string;
}

function stub(opts: StubOpts = {}) {
  const waves = [...(opts.waves ?? [])];
  const calls: Array<{ name: string; args: any }> = [];
  const writes: Array<{ table: string; values: any }> = [];
  const updates: Array<{ table: string; values: any }> = [];

  const admin: any = {
    calls,
    writes,
    updates,
    rpc(name: string, args: any) {
      calls.push({ name, args });
      if (name === "claim_partner_webhook_deliveries") {
        return Promise.resolve({ data: waves.shift() ?? [], error: null });
      }
      if (name === "settle_partner_webhook_delivery") {
        return Promise.resolve({
          data: opts.settleReturns ?? (args.p_ok ? "delivered" : "pending"),
          error: null,
        });
      }
      if (name === "partner_webhook_backlog") {
        // A SET-RETURNING function reaches supabase-js as an ARRAY even for one
        // row. Returning a bare object here would let a worker that forgot that
        // pass, and the probe would silently never fire in production.
        return Promise.resolve({ data: [opts.backlog ?? emptyBacklog()], error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from(table: string) {
      const self: any = {
        select: () => self,
        in: () => self,
        eq: () => self,
        update: (values: any) => (updates.push({ table, values }), self),
        insert: (values: any) => {
          writes.push({ table, values });
          return Promise.resolve({ error: null });
        },
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: table === "partner_webhooks" ? (opts.targets ?? [WEBHOOK]) : [], error: null }),
      };
      return self;
    },
  };
  return admin;
}

function emptyBacklog() {
  return {
    pending_count: 0,
    delivering_count: 0,
    exhausted_count: 0,
    stuck_lease_count: 0,
    oldest_pending_age_secs: 0,
    disabled_webhook_count: 0,
  };
}

const ok = () => Promise.resolve(new Response(null, { status: 200 }));

// --- Y1: the happy path, so the rest means something -----------------------

Deno.test("Y1: a delivered row is settled as delivered, with the signed headers", async () => {
  let seen: Headers | undefined;
  const admin = stub({ waves: [[delivery()]] });

  const summary = await runWebhookWorker({
    admin,
    fetcher: (_input, init) => {
      seen = new Headers(init?.headers);
      return ok();
    },
    now: () => 1_800_000_000_000,
  });

  assertEquals(summary.delivered, 1);
  assertEquals(seen?.get("X-Postora-Event"), "webhook.test");
  // The DELIVERY ROW's id, not the occurrence's: one row per (subscription,
  // occurrence), so a partner deduplicating on this deduplicates on the
  // occurrence for their subscription.
  assertEquals(seen?.get("X-Postora-Event-Id"), "evt_del-1");
  assert(seen?.get("X-Postora-Signature")?.startsWith("sha256="));

  const settle = admin.calls.find((c: any) => c.name === "settle_partner_webhook_delivery");
  assertEquals(settle.args.p_ok, true);
});

// --- Y2: the budget --------------------------------------------------------

Deno.test("Y2: the budget is checked BEFORE claiming, by whole waves", () => {
  assertEquals(canStartAnotherWave(0, WORKER_LIMITS), true);
  // 30s in, a 25s worst-case wave no longer fits inside the 45s budget. A naive
  // "is there time left" check would say yes here and get killed mid-wave,
  // leaving every claimed row with a charged attempt and no result.
  assertEquals(canStartAnotherWave(30_000, WORKER_LIMITS), false);
  assertEquals(canStartAnotherWave(WORKER_LIMITS.tickBudgetMs, WORKER_LIMITS), false);
});

Deno.test("Y2b: a tick already out of budget claims nothing at all", async () => {
  const admin = stub({ waves: [[delivery()]] });
  let clock = 0;
  const summary = await runWebhookWorker({
    admin,
    fetcher: ok,
    // The first now() sets startedAt; the next is already past the budget.
    now: () => (clock += 40_000),
  });

  assertEquals(summary.claimed, 0);
  assertEquals(
    admin.calls.filter((c: any) => c.name === "claim_partner_webhook_deliveries").length,
    0,
    "claiming would charge an attempt for a delivery this tick cannot make",
  );
});

Deno.test("Y2c: claiming stops at claimLimit even with budget to spare", async () => {
  const full = () => Array.from({ length: 5 }, (_, i) => delivery({ id: `del-${i}` }));
  const admin = stub({ waves: [full(), full(), full(), full(), full(), full()] });

  const summary = await runWebhookWorker({ admin, fetcher: ok, now: () => 1_000 });

  assertEquals(summary.claimed, WORKER_LIMITS.claimLimit);
  assertEquals(summary.delivered, WORKER_LIMITS.claimLimit);
});

// --- Y3: the ladder, as the worker actually spends it ----------------------

Deno.test("Y3: each failed attempt asks for the next rung, in order", async () => {
  const backoffs: number[] = [];
  for (let attemptsSpent = 1; attemptsSpent <= RETRY_BACKOFF_SECONDS.length; attemptsSpent++) {
    const admin = stub({ waves: [[delivery({ attempts: attemptsSpent })]] });
    await runWebhookWorker({
      admin,
      fetcher: () => Promise.resolve(new Response(null, { status: 500 })),
      now: () => 1_000,
    });
    const settle = admin.calls.find((c: any) => c.name === "settle_partner_webhook_delivery");
    backoffs.push(settle.args.p_backoff_seconds);
    assertEquals(settle.args.p_ok, false);
    assertEquals(settle.args.p_max_attempts, WORKER_LIMITS.maxAttempts);
  }
  // The ladder is observed end to end, not asserted as a constant.
  assertEquals(backoffs, [...RETRY_BACKOFF_SECONDS]);
});

// --- Y4: operational visibility -------------------------------------------

Deno.test("Y4: an aged backlog writes a system_logs row", async () => {
  const admin = stub({
    waves: [[]],
    backlog: { ...emptyBacklog(), pending_count: 12, oldest_pending_age_secs: 1_200 },
  });

  await runWebhookWorker({ admin, fetcher: ok, now: () => 1_000 });

  const logged = admin.writes.find((w: any) => w.table === "system_logs");
  assert(logged, "a correct outbox accumulates undelivered rows in perfect silence");
  assertEquals(logged.values.source, "process-partner-webhooks");
  assertEquals(logged.values.metadata.pending, 12);
});

Deno.test("Y4b: a stuck lease alone is enough, and a healthy queue says nothing", async () => {
  const stuck = stub({ waves: [[]], backlog: { ...emptyBacklog(), stuck_lease_count: 3 } });
  await runWebhookWorker({ admin: stuck, fetcher: ok, now: () => 1_000 });
  assert(stuck.writes.find((w: any) => w.table === "system_logs"), "a stuck lease is a fault");

  // The control. Without it, Y4 would pass against a worker that logged on
  // every tick -- which is the same as not logging at all.
  const healthy = stub({ waves: [[]] });
  await runWebhookWorker({ admin: healthy, fetcher: ok, now: () => 1_000 });
  assertEquals(healthy.writes.length, 0);
});

// --- Y5: every exit path settles ------------------------------------------

Deno.test("Y5: a delivery whose subscription vanished is spent, not looped", async () => {
  const admin = stub({ waves: [[delivery()]], targets: [], settleReturns: "exhausted" });

  const summary = await runWebhookWorker({ admin, fetcher: ok, now: () => 1_000 });

  const settle = admin.calls.find((c: any) => c.name === "settle_partner_webhook_delivery");
  assert(settle, "returning without settling would leave the row leased for 90s");
  // Expressed as "the ladder is shorter than what has been spent" so that ONE
  // place -- the SQL -- decides what exhausted means.
  assertEquals(settle.args.p_max_attempts, 0);
  assertEquals(summary.exhausted, 1);
});

Deno.test("Y5b: one row throwing does not abandon the rest of the wave", async () => {
  const admin = stub({ waves: [[delivery({ id: "del-a" }), delivery({ id: "del-b" })]] });
  let call = 0;
  const summary = await runWebhookWorker({
    admin,
    fetcher: () => {
      call++;
      if (call === 1) throw new Error("boom");
      return ok();
    },
    now: () => 1_000,
  });

  // deliverWebhook catches a thrown fetch, so the first row settles as a
  // retry rather than an error -- but the second must be delivered either way.
  assertEquals(summary.delivered + summary.retried, 2);
});

// --- Y6: the re-versioned secret is recorded -------------------------------

Deno.test("Y6: a re-signed row records the version it was ACTUALLY signed with", async () => {
  const rotatedLongAgo = {
    ...WEBHOOK,
    secret_version: 3,
    previous_secret: "whsec_old",
    previous_secret_version: 2,
    previous_secret_expires_at: "2026-01-01T00:00:00.000Z",
  };
  const admin = stub({ waves: [[delivery({ secret_version: 1 })]], targets: [rotatedLongAgo] });

  await runWebhookWorker({ admin, fetcher: ok, now: () => Date.parse("2026-09-02T00:00:00Z") });

  const update = admin.updates.find((u: any) => u.table === "partner_webhook_deliveries");
  assert(update, "an unrecorded re-signing is one event id under two signatures");
  assertEquals(update.values.secret_version, 3);
});

Deno.test("Y6b: a row on the current version is NOT re-versioned", async () => {
  // The control for Y6: without it, Y6 passes against a worker that rewrites
  // secret_version on every single delivery.
  const admin = stub({ waves: [[delivery({ secret_version: 1 })]] });
  await runWebhookWorker({ admin, fetcher: ok, now: () => 1_000 });
  assertEquals(admin.updates.length, 0);
});
