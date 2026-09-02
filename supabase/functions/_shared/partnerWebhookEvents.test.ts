// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  CERTIFIED_EVENT_TYPES,
  enqueuePartnerWebhookEvent,
  isCertifiedEventType,
} from "./partnerWebhookEvents.ts";

// ---------------------------------------------------------------------------
// The plan's Phase 5 cardinality exit criteria, asserted directly.
//
// They are worth asserting directly because a test that only checks "the event
// was delivered at least once" passes with the UNIQUE constraint missing
// entirely -- which is the invariant actually at stake. v1.1 of the plan got
// this wrong in BOTH directions, and both directions are pinned below:
//
//   F1  exactly one row per (webhook_id, event_occurrence_id)
//   F2  THREE rows for one event matching three subscriptions
//   F3  ZERO rows for non-matching subscriptions
//   F4  DISTINCT occurrence ids for distinct transitions of one resource
//
// The stub ENFORCES the unique constraint rather than recording the call, so
// F1 means something.
// ---------------------------------------------------------------------------

interface Subscription {
  id: string;
  secret_version: number;
  platform: string | null;
  social_account_id: string | null;
  events?: string[];
  is_active?: boolean;
  workspace_id?: string;
}

function stub(subscriptions: Subscription[]) {
  const deliveries: any[] = [];
  const seen = new Set<string>();

  function builder(table: string) {
    const filters: Array<[string, unknown]> = [];
    let containsEvent: string | null = null;
    const self: any = {
      select: () => self,
      eq: (column: string, value: unknown) => (filters.push([column, value]), self),
      contains: (_column: string, values: string[]) => (containsEvent = values[0]!, self),
      upsert: (rows: any[]) => {
        const inserted: any[] = [];
        for (const row of rows) {
          // The UNIQUE (webhook_id, event_occurrence_id) anchor, honoured.
          const key = `${row.webhook_id}::${row.event_occurrence_id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          deliveries.push(row);
          inserted.push({ id: `del-${deliveries.length}` });
        }
        return { select: () => Promise.resolve({ data: inserted, error: null }) };
      },
      then: (resolve: (v: unknown) => unknown) => {
        if (table !== "partner_webhooks") return resolve({ data: [], error: null });
        const data = subscriptions.filter((row) =>
          filters.every(([column, value]) =>
            (row as any)[column] === value ||
            (column === "workspace_id" && row.workspace_id === undefined && value === "ws-1") ||
            (column === "is_active" && row.is_active === undefined && value === true)
          ) &&
          (containsEvent === null || (row.events ?? ["webhook.test"]).includes(containsEvent))
        );
        return resolve({ data, error: null });
      },
    };
    return self;
  }

  return { deliveries, from: builder } as any;
}

const OCCURRENCE = {
  workspaceId: "ws-1",
  eventType: "webhook.test" as const,
  occurrenceId: "webhook.test:abc",
  payload: { hello: "world" },
  platform: "whatsapp" as string | null,
  accountId: "acct-1" as string | null,
};

Deno.test("F2: one event matching three subscriptions produces THREE rows", async () => {
  const admin = stub([
    { id: "wh-1", secret_version: 1, platform: null, social_account_id: null },
    { id: "wh-2", secret_version: 3, platform: "whatsapp", social_account_id: null },
    { id: "wh-3", secret_version: 1, platform: null, social_account_id: "acct-1" },
  ]);

  const result = await enqueuePartnerWebhookEvent(admin, OCCURRENCE);

  assertEquals(result.matched, 3);
  assertEquals(result.enqueued, 3);
  // Deduplication is per SUBSCRIPTION because delivery is. Collapsing these to
  // one row would silently drop two partners' events.
  assertEquals(admin.deliveries.map((row: any) => row.webhook_id).sort(), ["wh-1", "wh-2", "wh-3"]);
  // Each row captures ITS OWN subscription's secret version, not a shared one.
  assertEquals(admin.deliveries.find((r: any) => r.webhook_id === "wh-2").secret_version, 3);
});

Deno.test("F3: non-matching subscriptions produce ZERO rows", async () => {
  const admin = stub([
    { id: "match", secret_version: 1, platform: null, social_account_id: null },
    { id: "wrong-platform", secret_version: 1, platform: "instagram", social_account_id: null },
    { id: "wrong-account", secret_version: 1, platform: null, social_account_id: "acct-9" },
    { id: "inactive", secret_version: 1, platform: null, social_account_id: null, is_active: false },
    {
      id: "not-subscribed",
      secret_version: 1,
      platform: null,
      social_account_id: null,
      events: ["message.received"],
    },
    { id: "other-workspace", secret_version: 1, platform: null, social_account_id: null, workspace_id: "ws-2" },
  ]);

  const result = await enqueuePartnerWebhookEvent(admin, OCCURRENCE);

  // The half a "delivered at least once" test never notices is missing. Each
  // of the five non-matching rows is a different way to leak an event to a
  // subscription that did not ask for it -- and `other-workspace` is a
  // cross-tenant leak.
  assertEquals(result.matched, 1);
  assertEquals(admin.deliveries.length, 1);
  assertEquals(admin.deliveries[0].webhook_id, "match");
});

Deno.test("F1: re-enqueuing the same occurrence adds nothing", async () => {
  const admin = stub([{ id: "wh-1", secret_version: 1, platform: null, social_account_id: null }]);

  const first = await enqueuePartnerWebhookEvent(admin, OCCURRENCE);
  const second = await enqueuePartnerWebhookEvent(admin, OCCURRENCE);

  assertEquals(first.enqueued, 1);
  // A producer retry re-enqueuing is the NORMAL case, and absorbing it is what
  // the outbox is for. `matched` still reports 1 -- the subscription did match;
  // the row simply already existed.
  assertEquals(second.enqueued, 0);
  assertEquals(second.matched, 1);
  assertEquals(admin.deliveries.length, 1);
});

Deno.test("F4: distinct transitions of one resource get distinct rows", async () => {
  const admin = stub([{ id: "wh-1", secret_version: 1, platform: null, social_account_id: null }]);

  // The collision v1.1's wording would have caused: `message.delivered` and
  // `message.read` for ONE message share a provider id. Keyed on the resource
  // the second is silently dropped -- the outbox discarding exactly the events
  // it exists to guarantee. The event type is therefore part of the key.
  await enqueuePartnerWebhookEvent(admin, {
    ...OCCURRENCE,
    occurrenceId: "message.delivered:wamid.ABC",
  });
  await enqueuePartnerWebhookEvent(admin, {
    ...OCCURRENCE,
    occurrenceId: "message.read:wamid.ABC",
  });

  assertEquals(admin.deliveries.length, 2);
});

Deno.test("F6: restrictToWebhookId narrows to one subscription", async () => {
  const subs = [
    { id: "wh-1", secret_version: 1, platform: null, social_account_id: null },
    { id: "wh-2", secret_version: 1, platform: null, social_account_id: null },
    { id: "wh-3", secret_version: 1, platform: null, social_account_id: null },
  ];
  // F2 is this test's control: the SAME three subscriptions, unrestricted,
  // produce three rows. Without that pairing, this would pass against a
  // fan-out that had simply stopped working.
  const admin = stub(subs);
  const result = await enqueuePartnerWebhookEvent(admin, {
    ...OCCURRENCE,
    restrictToWebhookId: "wh-2",
  });

  assertEquals(result.matched, 1);
  assertEquals(admin.deliveries.length, 1);
  assertEquals(admin.deliveries[0].webhook_id, "wh-2");
});

Deno.test("F6b: the restriction can only narrow, never widen", async () => {
  // A restriction naming a subscription that fails the other axes must still
  // match nothing -- otherwise "restrict" would be a way to bypass the
  // platform and account filters rather than to add to them.
  const admin = stub([
    { id: "wh-9", secret_version: 1, platform: "instagram", social_account_id: null },
  ]);
  const result = await enqueuePartnerWebhookEvent(admin, {
    ...OCCURRENCE,
    restrictToWebhookId: "wh-9",
  });

  assertEquals(result.matched, 0);
  assertEquals(admin.deliveries.length, 0);
});

Deno.test("F5: the certified allowlist has exactly one entry in this phase", () => {
  // Not a tautology: this phase ships NO event family (D6), and the closed
  // allowlist is the mechanism that stops the substrate becoming an implicit
  // promise. Widening it is a Phase 6 act with a producer ledger row behind it,
  // and this fails when someone widens it without one.
  assertEquals(CERTIFIED_EVENT_TYPES, ["webhook.test"]);
  assert(isCertifiedEventType("webhook.test"));
  assert(!isCertifiedEventType("message.received"));
});
