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
  awayUsageCount?: number;
}

// Records every table read and write so tests can assert on the side effects the pipeline is
// responsible for, without standing up Postgres.
function stubAdmin(options: StubOptions = {}) {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  const likeFilters: string[] = [];

  const client = {
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        gte: () => builder,
        like: (_column: string, pattern: string) => {
          likeFilters.push(pattern);
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
              : { count: options.awayUsageCount ?? 0, error: null },
          ),
      };
      return builder;
    },
  };

  return { client, inserts, likeFilters };
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

Deno.test("the agent conversation id is scoped to this post and this commenter", async () => {
  const { client } = stubAdmin({ rules: [] });
  const calls: Array<{ url: string; body: unknown }> = [];

  await handleCommentInternally(client, ACCOUNT, INPUT, { fetcher: stubFetch(calls), now: NOW });

  assertEquals((calls[0].body as Record<string, string>).conversation_id, `${ACCOUNT.id}:comment:p1:a1`);
});

Deno.test("a Threads reply with no author id falls back to the handle for continuity", async () => {
  const { client } = stubAdmin({ rules: [] });
  const calls: Array<{ url: string; body: unknown }> = [];

  await handleCommentInternally(
    client,
    { ...ACCOUNT, platform: "threads" },
    { ...INPUT, author: { id: null, username: "fan" } },
    { fetcher: stubFetch(calls), now: NOW },
  );

  assertEquals((calls[0].body as Record<string, string>).conversation_id, `${ACCOUNT.id}:comment:p1:fan`);
});

Deno.test("a mention with no root post keys the thread by the mention itself", async () => {
  const { client } = stubAdmin({ rules: [] });
  const calls: Array<{ url: string; body: unknown }> = [];

  await handleCommentInternally(client, ACCOUNT, { ...INPUT, post: { id: null } }, {
    fetcher: stubFetch(calls),
    now: NOW,
  });

  assertEquals((calls[0].body as Record<string, string>).conversation_id, `${ACCOUNT.id}:comment:c1:a1`);
});

Deno.test("an away rule that already answered on this post today does not answer again", async () => {
  const { client, likeFilters } = stubAdmin({
    rules: [keywordRule({ id: "rule-away", rule_type: "away", keywords: null })],
    awayUsageCount: 1,
  });
  const calls: Array<{ url: string; body: unknown }> = [];

  const outcome = await handleCommentInternally(client, ACCOUNT, INPUT, {
    fetcher: stubFetch(calls),
    now: NOW,
  });

  assertEquals(outcome, "rule_suppressed");
  assertEquals(calls.length, 0);
  assertEquals(likeFilters, [`${ACCOUNT.id}:comment:p1:%`]);
});

Deno.test("an away rule with no prior reply on the post does answer", async () => {
  const { client } = stubAdmin({
    rules: [keywordRule({ id: "rule-away", rule_type: "away", keywords: null })],
    awayUsageCount: 0,
  });
  const calls: Array<{ url: string; body: unknown }> = [];

  assertEquals(
    await handleCommentInternally(client, ACCOUNT, INPUT, { fetcher: stubFetch(calls), now: NOW }),
    "rule_replied",
  );
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
