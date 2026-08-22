import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleCommentInternally, type CommentAutomationAccount } from "./commentAutomation.ts";

const ACCOUNT: CommentAutomationAccount = {
  id: "11111111-2222-3333-4444-555555555555",
  user_id: "user-1",
  platform: "facebook",
  access_token: "token",
  platform_user_id: "page-1",
};

const INPUT = {
  comment: { id: "c1", text: "what is the price" },
  post: { id: "p1" },
  author: { id: "a1", username: "fan" },
};

const NOW = new Date(2026, 7, 19, 14, 30);

interface StubOptions {
  rules?: Array<Record<string, unknown>>;
  rulesError?: string;
  // Usage rows already recorded, addressed the way the pipeline queries for them: away rules
  // look up a post-scoped LIKE prefix, keyword rules an exact conversation id. The stub
  // honours whichever the pipeline sent, so a lookup scoped to the wrong thing changes the
  // outcome rather than merely reading differently.
  priorUsage?: string[];
}

function stubAdmin(options: StubOptions = {}) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];

  const client = {
    from(table: string) {
      let usageKey = "";
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: string) => {
          if (column === "conversation_id") usageKey = value;
          return builder;
        },
        gte: () => builder,
        like: (_column: string, pattern: string) => {
          usageKey = pattern;
          return builder;
        },
        order: () => builder,
        insert: (row: Record<string, unknown>) => {
          inserts.push({ table, row });
          return Promise.resolve({ error: null });
        },
        then: (resolve: (value: unknown) => unknown) =>
          resolve(
            table === "messenger_auto_replies"
              ? { data: options.rules || [], error: options.rulesError ? { message: options.rulesError } : null }
              : { count: (options.priorUsage || []).filter((key) => key === usageKey).length, error: null },
          ),
      };
      return builder;
    },
  };

  return { client, inserts };
}

function keywordRule(overrides: Record<string, unknown> = {}) {
  return {
    id: "rule-kw",
    rule_type: "keyword",
    keywords: ["price"],
    reply_message: "DM us for a quote",
    schedule_days: null,
    schedule_start: null,
    schedule_end: null,
    created_at: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

function stubFetch(record: Array<{ url: string; body: unknown }>, ok = true): typeof fetch {
  return ((url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    let body: unknown = init?.body;
    if (typeof init?.body === "string") body = JSON.parse(init.body);
    else if (init?.body instanceof URLSearchParams) body = Object.fromEntries(init.body);
    record.push({ url: href, body });
    return Promise.resolve(
      new Response(JSON.stringify(ok ? { id: "reply-1" } : { error: { message: "nope" } }), {
        status: ok ? 200 : 400,
      }),
    );
  }) as unknown as typeof fetch;
}

Deno.test("a matched rule replies to the comment and never reaches the AI agent", async () => {
  const { client, inserts } = stubAdmin({ rules: [keywordRule()] });
  const calls: Array<{ url: string; body: unknown }> = [];

  const outcome = await handleCommentInternally(client, ACCOUNT, INPUT, {
    fetcher: stubFetch(calls),
    now: NOW,
  });

  assertEquals(outcome, "rule_replied");
  assertEquals(calls.length, 1);
  assertStringIncludes(calls[0].url, "/c1/replies");
  assertEquals((calls[0].body as { message: string }).message, "DM us for a quote");
  assertEquals(inserts[0].table, "messenger_auto_reply_usage");
});

Deno.test("an unmatched comment is handed to the AI agent with its comment id", async () => {
  const { client, inserts } = stubAdmin({ rules: [keywordRule({ keywords: ["refund"] })] });
  const calls: Array<{ url: string; body: unknown }> = [];

  const outcome = await handleCommentInternally(client, ACCOUNT, INPUT, {
    fetcher: stubFetch(calls),
    now: NOW,
  });

  assertEquals(outcome, "agent_dispatched");
  assertStringIncludes(calls[0].url, "/functions/v1/ai-agent-reply");
  const body = calls[0].body as Record<string, string>;
  assertEquals(body.comment_id, "c1");
  assertEquals(body.social_account_id, ACCOUNT.id);
  assertEquals(inserts.length, 0);
});

// The agent thread is what carries reply history into the next public reply, so a wrong key
// either loses continuity or leaks one post's conversation into another post's audience.
Deno.test("agent threads are keyed by post and commenter, with platform-specific fallbacks", async () => {
  const cases: Array<{ name: string; platform: string; input: typeof INPUT; expected: string }> = [
    { name: "Meta comment", platform: "facebook", input: INPUT, expected: `${ACCOUNT.id}:comment:p1:a1` },
    {
      name: "Threads reply, which carries a handle but no author id",
      platform: "threads",
      input: { ...INPUT, author: { id: null, username: "fan" } },
      expected: `${ACCOUNT.id}:comment:p1:fan`,
    },
    {
      name: "Threads mention, which has no root post",
      platform: "threads",
      input: { ...INPUT, post: { id: null } },
      expected: `${ACCOUNT.id}:comment:c1:a1`,
    },
    {
      name: "anonymous event with neither a post nor an author",
      platform: "facebook",
      input: { ...INPUT, post: { id: null }, author: { id: null, username: null } },
      expected: `${ACCOUNT.id}:comment:c1:c1`,
    },
  ];

  for (const { name, platform, input, expected } of cases) {
    const { client } = stubAdmin({ rules: [] });
    const calls: Array<{ url: string; body: unknown }> = [];
    await handleCommentInternally(client, { ...ACCOUNT, platform }, input, {
      fetcher: stubFetch(calls),
      now: NOW,
    });
    assertEquals((calls[0].body as Record<string, string>).conversation_id, expected, name);
  }
});

const awayRule = keywordRule({ id: "rule-away", rule_type: "away", keywords: null });

Deno.test("an away rule that already answered on this post today does not answer again", async () => {
  const { client } = stubAdmin({ rules: [awayRule], priorUsage: [`${ACCOUNT.id}:comment:p1:%`] });
  const calls: Array<{ url: string; body: unknown }> = [];

  const outcome = await handleCommentInternally(client, ACCOUNT, INPUT, {
    fetcher: stubFetch(calls),
    now: NOW,
  });

  assertEquals(outcome, "rule_suppressed");
  assertEquals(calls.length, 0);
});

Deno.test("an away reply on a different post does not suppress this one", async () => {
  // The away guard is per post, not per account: one busy post must not silence the notice
  // everywhere else.
  const { client } = stubAdmin({
    rules: [awayRule],
    priorUsage: [`${ACCOUNT.id}:comment:some-other-post:%`],
  });
  const calls: Array<{ url: string; body: unknown }> = [];

  assertEquals(
    await handleCommentInternally(client, ACCOUNT, INPUT, { fetcher: stubFetch(calls), now: NOW }),
    "rule_replied",
  );
  assertStringIncludes(calls[0].url, "/c1/replies");
});

Deno.test("a keyword rule does not repeat itself at the same commenter within the cooldown", async () => {
  const { client } = stubAdmin({ rules: [keywordRule()], priorUsage: [`${ACCOUNT.id}:comment:p1:a1`] });
  const calls: Array<{ url: string; body: unknown }> = [];

  const outcome = await handleCommentInternally(client, ACCOUNT, INPUT, {
    fetcher: stubFetch(calls),
    now: NOW,
  });

  assertEquals(outcome, "rule_suppressed");
  assertEquals(calls.length, 0);
});

Deno.test("a keyword rule still answers a different commenter on the same post", async () => {
  // Keyword throttling is per commenter, not per post -- everyone asking the price deserves
  // the answer, the same person asking five times does not deserve it five times.
  const { client } = stubAdmin({ rules: [keywordRule()], priorUsage: [`${ACCOUNT.id}:comment:p1:someone-else`] });
  const calls: Array<{ url: string; body: unknown }> = [];

  assertEquals(
    await handleCommentInternally(client, ACCOUNT, INPUT, { fetcher: stubFetch(calls), now: NOW }),
    "rule_replied",
  );
  assertStringIncludes(calls[0].url, "/c1/replies");
});

Deno.test("usage is recorded even when the reply send throws, so the throttle still holds", async () => {
  const { client, inserts } = stubAdmin({ rules: [keywordRule()] });
  const exploding = (() => Promise.reject(new Error("socket hang up"))) as unknown as typeof fetch;

  await handleCommentInternally(client, ACCOUNT, INPUT, { fetcher: exploding, now: NOW })
    .catch(() => {});

  assertEquals(inserts[0].table, "messenger_auto_reply_usage");
  assertEquals(inserts[0].row.conversation_id, `${ACCOUNT.id}:comment:p1:a1`);
});

Deno.test("a rule reply the platform rejects still claims the comment", async () => {
  const { client, inserts } = stubAdmin({ rules: [keywordRule()] });
  const calls: Array<{ url: string; body: unknown }> = [];

  const outcome = await handleCommentInternally(client, ACCOUNT, INPUT, {
    fetcher: stubFetch(calls, false),
    now: NOW,
  });

  // Falling through to the AI here would post a second public reply after the first failed.
  assertEquals(outcome, "rule_replied");
  assertEquals(inserts[0].table, "messenger_auto_reply_usage");
});

Deno.test("a rule lookup failure fails closed instead of letting the AI reply publicly", async () => {
  const { client } = stubAdmin({ rulesError: "connection reset" });
  const calls: Array<{ url: string; body: unknown }> = [];

  const outcome = await handleCommentInternally(client, ACCOUNT, INPUT, {
    fetcher: stubFetch(calls),
    now: NOW,
  });

  assertEquals(outcome, "skipped");
  assertEquals(calls.length, 0);
});
