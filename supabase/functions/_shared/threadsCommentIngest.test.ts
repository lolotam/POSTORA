import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { ingestThreadsComment, type ThreadsCommentInput } from "./threadsCommentIngest.ts";

const SUBSCRIPTION_URL = "https://n8n.example.test/webhook/6a480f39/postora-comment";

const commentSubscription = {
  key: "n8n_webhook_user-1_sub-1",
  value: { webhook_url: SUBSCRIPTION_URL, events: ["comment.received"], is_active: true },
};

const account = {
  id: "acc-1",
  user_id: "user-1",
  platform: "threads",
  platform_user_id: "28097456199906758",
  platform_username: "danatfuture",
  access_token: "tok",
  account_metadata: { comment_automation_handler: "n8n" },
};

// Shape taken from a live GET /{threads-media-id}/conversation response.
const reply: ThreadsCommentInput = {
  comment: { id: "18140058247601027", kind: "reply", text: "hi dear", parentCommentId: "18490554892096769", mediaUrl: null },
  post: { id: "18490554892096769", url: null, caption: null },
  author: { id: null, name: null, username: "vigrox.kw" },
};

function fakeAdmin(options: {
  inserted?: unknown[];
  persistError?: { message: string };
  subscriptions?: unknown[];
  /** Funnel rules the account has. Absent means none, which is the pre-feature behaviour. */
  workflowRules?: unknown[];
} = {}) {
  return {
    // deno-lint-ignore no-explicit-any
    from(table: string): any {
      if (table === "comment_workflow_rules") {
        return {
          select: () => ({
            eq: () => ({ eq: () => Promise.resolve({ data: options.workflowRules ?? [], error: null }) }),
          }),
        };
      }
      if (table === "comment_workflow_events") {
        return {
          upsert: () => ({ select: () => Promise.resolve({ data: [{ id: "cw-event-1" }], error: null }) }),
          update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        };
      }
      if (table === "comment_workflow_usage") {
        return {
          insert: () => Promise.resolve({ error: null }),
          delete: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
        };
      }
      if (table === "social_inbox_events") {
        return {
          upsert: () => ({
            select: () =>
              Promise.resolve({
                data: options.persistError ? null : options.inserted ?? [{ id: "row-1" }],
                error: options.persistError ?? null,
              }),
          }),
        };
      }
      if (table === "app_settings") {
        return {
          select: () => ({ like: () => Promise.resolve({ data: options.subscriptions ?? [], error: null }) }),
          // A delivered event writes the destination's failure_count back to 0.
          update: () => ({ eq: () => Promise.resolve({ error: null }) }),
        };
      }
      // whatsapp_webhooks, the legacy registry, which never takes a comment envelope.
      return { select: () => ({ eq: () => Promise.resolve({ data: [], error: null }) }) };
    },
  };
}

function captureDeliveries(): { urls: string[]; bodies: unknown[]; restore: () => void } {
  const original = globalThis.fetch;
  const urls: string[] = [];
  const bodies: unknown[] = [];
  globalThis.fetch = ((url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  return { urls, bodies, restore: () => { globalThis.fetch = original; } };
}

// Production incident, 2026-08-23: every n8n comment trigger for Threads sat silent while the
// replies were plainly visible in Postora's Reply Center. The mention path only ever emitted
// `threads.mention.created`, whose family alias resolves to "threads.threads", so it matched
// none of the three live `comment.received` subscriptions; replies had no dispatch path at
// all. This asserts the envelope those subscriptions actually listen for.
Deno.test("a Threads reply reaches a comment.received subscription", async () => {
  const sent = captureDeliveries();
  try {
    const outcome = await ingestThreadsComment(
      fakeAdmin({ subscriptions: [commentSubscription] }),
      account,
      reply,
      { rawPayload: reply },
    );
    assertEquals(outcome, "dispatched_n8n");
    assertEquals(sent.urls, [SUBSCRIPTION_URL]);
    // deno-lint-ignore no-explicit-any
    const body = sent.bodies[0] as any;
    assertEquals(body.event, "comment.received");
    assertEquals(body.platform, "threads");
    assertEquals(body.comment.id, "18140058247601027");
    assertEquals(body.author.username, "vigrox.kw");
  } finally {
    sent.restore();
  }
});

// The webhook and the poller both see the same reply, and the poller sees it again on every
// run. Each of these is a reason the door must refuse to fire a second time; if any one of
// them leaked, a single comment would run the user's workflow repeatedly.
const suppressed: Array<{ scenario: string; outcome: string; run: () => Promise<string> }> = [
  {
    scenario: "already recorded by the other source",
    outcome: "duplicate",
    run: () =>
      ingestThreadsComment(
        fakeAdmin({ inserted: [], subscriptions: [commentSubscription] }),
        account,
        reply,
        { rawPayload: reply },
      ),
  },
  {
    scenario: "the poller's first pass over an account",
    outcome: "seeded",
    run: () =>
      ingestThreadsComment(
        fakeAdmin({ subscriptions: [commentSubscription] }),
        account,
        reply,
        { rawPayload: reply, dispatch: false },
      ),
  },
  {
    scenario: "written by the connected account itself",
    outcome: "own_comment",
    run: () =>
      ingestThreadsComment(
        fakeAdmin({ subscriptions: [commentSubscription] }),
        account,
        { ...reply, author: { id: null, name: null, username: "danatfuture" } },
        { rawPayload: reply },
      ),
  },
  {
    scenario: "comment automation switched off for the account",
    outcome: "no_handler",
    run: () =>
      ingestThreadsComment(
        fakeAdmin({ subscriptions: [commentSubscription] }),
        { ...account, account_metadata: {} },
        reply,
        { rawPayload: reply },
      ),
  },
  {
    scenario: "the inbox row could not be written",
    outcome: "persist_failed",
    run: () =>
      ingestThreadsComment(
        fakeAdmin({ persistError: { message: "boom" }, subscriptions: [commentSubscription] }),
        account,
        reply,
        { rawPayload: reply },
      ),
  },
];

for (const { scenario, outcome, run } of suppressed) {
  Deno.test(`no workflow runs when the comment is ${scenario}`, async () => {
    const sent = captureDeliveries();
    try {
      assertEquals(await run(), outcome);
      assertEquals(sent.urls, []);
    } finally {
      sent.restore();
    }
  });
}

// A Threads funnel rule that claims the comment must stop BOTH the n8n dispatch and the
// internal automation. The account below is on the n8n handler, so a delivery here would be
// the double reply this precedence exists to prevent.
const publicFunnelRule = {
  id: "cw-rule-1",
  social_account_id: "acc-1",
  platform: "threads",
  name: "price funnel",
  target_post_id: null,
  match_type: "contains",
  keywords: ["hi"],
  public_replies: ["DM us"],
  dm_message: null,
  media_file_id: null,
  send_once_per_user: true,
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
};

Deno.test("a claimed Threads comment reaches neither n8n nor the internal automation", async () => {
  const sent = captureDeliveries();
  try {
    await ingestThreadsComment(
      fakeAdmin({ subscriptions: [commentSubscription], workflowRules: [publicFunnelRule] }),
      account,
      reply,
      { rawPayload: reply },
    );
    // The only outbound call is the funnel's own public reply to Threads. The n8n
    // subscription URL must not appear.
    assertEquals(sent.urls.includes(SUBSCRIPTION_URL), false);
    assertEquals(sent.urls.some((url) => url.includes("graph.threads.net")), true);
  } finally {
    sent.restore();
  }
});

Deno.test("a Threads MENTION is never funnelled, and still reaches its n8n subscription", async () => {
  // Mentions come through this same door (threads-webhook, threads-mentions). A mention is a
  // stranger naming the account in their own thread, not a comment under the account's post.
  const sent = captureDeliveries();
  try {
    const outcome = await ingestThreadsComment(
      fakeAdmin({ subscriptions: [commentSubscription], workflowRules: [publicFunnelRule] }),
      account,
      { ...reply, comment: { ...reply.comment, kind: "mention" } },
      { rawPayload: reply },
    );
    assertEquals(outcome, "dispatched_n8n");
    assertEquals(sent.urls, [SUBSCRIPTION_URL]);
  } finally {
    sent.restore();
  }
});

Deno.test("an account with no funnel rules behaves exactly as before", async () => {
  const sent = captureDeliveries();
  try {
    const outcome = await ingestThreadsComment(
      fakeAdmin({ subscriptions: [commentSubscription] }),
      account,
      reply,
      { rawPayload: reply },
    );
    assertEquals(outcome, "dispatched_n8n");
    assertEquals(sent.urls, [SUBSCRIPTION_URL]);
  } finally {
    sent.restore();
  }
});
