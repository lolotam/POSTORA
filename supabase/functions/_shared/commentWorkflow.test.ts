import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { type CommentWorkflowInput, runCommentWorkflow } from "./commentWorkflow.ts";
import type { CommentAutomationAccount } from "./commentAutomation.ts";

const FACEBOOK: CommentAutomationAccount = {
  id: "acct-fb",
  user_id: "user-1",
  platform: "facebook",
  access_token: "page-token",
  platform_user_id: "page-1",
  account_metadata: {},
};

const THREADS: CommentAutomationAccount = {
  id: "acct-th",
  user_id: "user-1",
  platform: "threads",
  access_token: "threads-token",
  platform_user_id: "th-1",
  account_metadata: {},
};

const INPUT: CommentWorkflowInput = {
  comment: { id: "c1", text: "GUIDE" },
  post: { id: "p1" },
  author: { id: "a1", username: "fan" },
  timestamp: "2026-09-03T10:00:00Z",
};

const NOW = new Date("2026-09-03T10:05:00Z");

const RULE = {
  id: "rule-1",
  social_account_id: "acct-fb",
  platform: "facebook",
  name: "guide funnel",
  target_post_id: null,
  match_type: "exact",
  keywords: ["guide"],
  public_replies: ["Check your DM"],
  dm_message: "Here you go",
  media_file_id: null,
  send_once_per_user: true,
  is_active: true,
  created_at: "2026-01-01T00:00:00Z",
};

interface StubOptions {
  rules?: Array<Record<string, unknown>>;
  rulesError?: string;
  /** The event row already existed: another invocation owns this comment. */
  eventConflict?: boolean;
  eventError?: string;
  /** The usage claim collided: this person was already served. */
  usageConflict?: boolean;
  usageError?: string;
  media?: { file_path: string; storage_bucket?: string } | null;
  mediaError?: string;
  /** null makes signing fail. */
  signedUrl?: string | null;
}

interface Write {
  table: string;
  op: "insert" | "upsert" | "update" | "delete";
  row?: Record<string, unknown>;
}

// Database writes and network sends share ONE ordered timeline, because the ordering between
// them is the contract under test: the event row must exist and the usage claim must be taken
// BEFORE anything is sent. Two separate arrays could not tell "claim then send" from "send then
// claim" — each would look identical.
type TraceEntry = `db:${string}:${string}` | `net:${string}`;

// Records every write in order for the same reason.
function stubAdmin(options: StubOptions = {}, trace: TraceEntry[] = []) {
  const writes: Write[] = [];
  const deleteFilters: Record<string, string> = {};

  const client = {
    from(table: string) {
      let pendingOp: Write["op"] | null = null;

      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: string) => {
          if (pendingOp === "delete") deleteFilters[column] = value;
          return builder;
        },
        maybeSingle: () => {
          if (table === "media_files") {
            return Promise.resolve(
              options.mediaError
                ? { data: null, error: { message: options.mediaError } }
                : { data: options.media ?? null, error: null },
            );
          }
          return Promise.resolve({ data: null, error: null });
        },
        insert: (row: Record<string, unknown>) => {
          pendingOp = "insert";
          writes.push({ table, op: "insert", row });
          trace.push(`db:${table}:insert`);
          if (table === "comment_workflow_usage") {
            if (options.usageError) return Promise.resolve({ error: { message: options.usageError } });
            if (options.usageConflict) return Promise.resolve({ error: { code: "23505", message: "duplicate" } });
          }
          return Promise.resolve({ error: null });
        },
        upsert: (row: Record<string, unknown>) => {
          pendingOp = "upsert";
          writes.push({ table, op: "upsert", row });
          trace.push(`db:${table}:upsert`);
          return builder;
        },
        update: (row: Record<string, unknown>) => {
          pendingOp = "update";
          writes.push({ table, op: "update", row });
          trace.push(`db:${table}:update`);
          return builder;
        },
        delete: () => {
          pendingOp = "delete";
          writes.push({ table, op: "delete" });
          trace.push(`db:${table}:delete`);
          return builder;
        },
        then: (resolve: (value: unknown) => unknown) => {
          if (table === "comment_workflow_rules" && pendingOp === null) {
            return resolve(
              options.rulesError
                ? { data: null, error: { message: options.rulesError } }
                : { data: options.rules ?? [RULE], error: null },
            );
          }
          if (table === "comment_workflow_events" && pendingOp === "upsert") {
            if (options.eventError) return resolve({ data: null, error: { message: options.eventError } });
            return resolve({ data: options.eventConflict ? [] : [{ id: "event-1" }], error: null });
          }
          return resolve({ data: null, error: null });
        },
      };
      return builder;
    },
    storage: {
      from: () => ({
        createSignedUrl: () =>
          Promise.resolve(
            options.signedUrl === null
              ? { data: null, error: { message: "cannot sign" } }
              : { data: { signedUrl: options.signedUrl ?? "https://signed.example/file" }, error: null },
          ),
      }),
    },
  };

  return { client, writes, deleteFilters, trace };
}

function stubFetch(
  responses: { reply?: { status: number; body: unknown }; dm?: { status: number; body: unknown } } = {},
  trace: TraceEntry[] = [],
) {
  const calls: Array<{ url: string; body: any }> = [];
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, body: init?.body ? JSON.parse(String(init.body)) : null });
    trace.push(href.includes("/messages") ? "net:private_reply" : "net:public_reply");
    const chosen = href.includes("/messages")
      ? responses.dm ?? { status: 200, body: { recipient_id: "r", message_id: "m-1" } }
      : responses.reply ?? { status: 200, body: { id: "reply-1" } };
    return new Response(JSON.stringify(chosen.body), { status: chosen.status });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

const FIXED_PICK = (replies: string[]) => replies[0];

Deno.test("no matching rule leaves the comment to the rest of the pipeline", async () => {
  const { client, writes } = stubAdmin({ rules: [] });
  const { fetcher, calls } = stubFetch();

  assertEquals(await runCommentWorkflow(client, FACEBOOK, INPUT, { fetcher, now: NOW }), "unclaimed");
  assertEquals(writes.length, 0);
  assertEquals(calls.length, 0);
});

Deno.test("a failed rule read is unclaimed, never mistaken for 'no rules'", async () => {
  const { client, writes } = stubAdmin({ rulesError: "statement timeout" });
  const { fetcher, calls } = stubFetch();

  assertEquals(await runCommentWorkflow(client, FACEBOOK, INPUT, { fetcher, now: NOW }), "unclaimed");
  assertEquals(writes.length, 0);
  assertEquals(calls.length, 0);
});

Deno.test("a match records the event, claims the person, then replies publicly and privately", async () => {
  const { client, writes } = stubAdmin();
  const { fetcher, calls } = stubFetch();

  assertEquals(
    await runCommentWorkflow(client, FACEBOOK, INPUT, { fetcher, now: NOW, pick: FIXED_PICK }),
    "claimed",
  );

  // Order is the contract: event row, then claim, then sends.
  assertEquals(writes[0].table, "comment_workflow_events");
  assertEquals(writes[0].op, "upsert");
  assertEquals(writes[0].row!.public_reply_status, "pending");
  assertEquals(writes[0].row!.dm_status, "pending");
  assertEquals(writes[1].table, "comment_workflow_usage");
  assertEquals(writes[1].op, "insert");
  assertEquals(writes[1].row!.external_post_id, "p1");
  assertEquals(writes[1].row!.author_key, "a1");

  assertEquals(calls.length, 2);
  // Facebook comment replies go to /comments; /replies is Instagram's edge.
  assertStringIncludes(calls[0].url, "/c1/comments");
  assertEquals(calls[0].body.message, "Check your DM");
  assertStringIncludes(calls[1].url, "/page-1/messages");
  assertEquals(calls[1].body.recipient, { comment_id: "c1" });
  assertEquals(calls[1].body.message, { text: "Here you go" });

  const final = writes.at(-1)!;
  assertEquals(final.table, "comment_workflow_events");
  assertEquals(final.op, "update");
  assertEquals(final.row!.public_reply_status, "sent");
  assertEquals(final.row!.dm_status, "sent");
  assertEquals(final.row!.public_reply_id, "reply-1");
  assertEquals(final.row!.error_message, null);
});

Deno.test("a comment another invocation already claimed is not answered twice", async () => {
  const { client, writes } = stubAdmin({ eventConflict: true });
  const { fetcher, calls } = stubFetch();

  assertEquals(await runCommentWorkflow(client, FACEBOOK, INPUT, { fetcher, now: NOW }), "claimed");
  assertEquals(calls.length, 0);
  assertEquals(writes.filter((w) => w.table === "comment_workflow_usage").length, 0);
});

Deno.test("an event row that cannot be written still claims, rather than handing the comment to the agent", async () => {
  const { client } = stubAdmin({ eventError: "connection reset" });
  const { fetcher, calls } = stubFetch();

  assertEquals(await runCommentWorkflow(client, FACEBOOK, INPUT, { fetcher, now: NOW }), "claimed");
  assertEquals(calls.length, 0);
});

Deno.test("a person already served on this post is skipped with a reason and nothing is sent", async () => {
  const { client, writes } = stubAdmin({ usageConflict: true });
  const { fetcher, calls } = stubFetch();

  assertEquals(await runCommentWorkflow(client, FACEBOOK, INPUT, { fetcher, now: NOW }), "claimed");
  assertEquals(calls.length, 0);

  const final = writes.at(-1)!;
  assertEquals(final.op, "update");
  assertEquals(final.row!.public_reply_status, "skipped");
  assertEquals(final.row!.dm_status, "skipped");
  assertEquals(final.row!.error_message, "already_served");
});

Deno.test("send_once_per_user=false never touches the claim table", async () => {
  const { client, writes } = stubAdmin({ rules: [{ ...RULE, send_once_per_user: false }] });
  const { fetcher, calls } = stubFetch();

  await runCommentWorkflow(client, FACEBOOK, INPUT, { fetcher, now: NOW, pick: FIXED_PICK });
  assertEquals(writes.some((w) => w.table === "comment_workflow_usage"), false);
  assertEquals(calls.length, 2);
});

Deno.test("when both legs fail the claim is released so the next comment can be served", async () => {
  const { client, writes, deleteFilters } = stubAdmin();
  const { fetcher } = stubFetch({
    reply: { status: 400, body: { error: { message: "rejected" } } },
    dm: { status: 400, body: { error: { message: "rejected" } } },
  });

  await runCommentWorkflow(client, FACEBOOK, INPUT, { fetcher, now: NOW, pick: FIXED_PICK });

  assertEquals(writes.some((w) => w.table === "comment_workflow_usage" && w.op === "delete"), true);
  assertEquals(deleteFilters.rule_id, "rule-1");
  assertEquals(deleteFilters.author_key, "a1");
  assertEquals(deleteFilters.external_post_id, "p1");

  const final = writes.at(-1)!;
  assertEquals(final.row!.public_reply_status, "failed");
  assertEquals(final.row!.dm_status, "failed");
});

Deno.test("a failed DM does not undo a delivered public reply, and the claim stands", async () => {
  const { client, writes } = stubAdmin();
  const { fetcher } = stubFetch({
    dm: { status: 400, body: { error: { error_user_msg: "This comment can no longer receive a private reply." } } },
  });

  await runCommentWorkflow(client, FACEBOOK, INPUT, { fetcher, now: NOW, pick: FIXED_PICK });

  assertEquals(writes.some((w) => w.table === "comment_workflow_usage" && w.op === "delete"), false);
  const final = writes.at(-1)!;
  assertEquals(final.row!.public_reply_status, "sent");
  assertEquals(final.row!.dm_status, "failed");
  assertStringIncludes(String(final.row!.error_message), "can no longer receive");
});

Deno.test("a Threads rule is public-only: no DM call and dm_status not_applicable", async () => {
  const threadsRule = { ...RULE, id: "rule-th", social_account_id: "acct-th", platform: "threads", dm_message: null };
  const { client, writes } = stubAdmin({ rules: [threadsRule] });
  const { fetcher, calls } = stubFetch({ reply: { status: 200, body: { id: "container-1", status: "FINISHED" } } });

  await runCommentWorkflow(client, THREADS, INPUT, { fetcher, now: NOW, pick: FIXED_PICK });

  assertEquals(calls.some((call) => call.url.includes("/messages")), false);
  assertEquals(writes[0].row!.dm_status, "not_applicable");
  assertEquals(writes.at(-1)!.row!.dm_status, "not_applicable");
});

Deno.test("a Threads rule that somehow carries DM copy is still recorded as not_applicable", async () => {
  // The CHECK constraint forbids this row, so it can only arrive through a bug. The platform
  // test, not the presence of the column, is what must decide.
  //
  // dm_status is the assertion that matters here rather than the absence of a /messages call:
  // a Threads account has no linked Page, so sendPrivateReply would fail before reaching the
  // network anyway, and "no call was made" would hold even with the platform guard removed.
  const rogue = { ...RULE, id: "rule-th2", social_account_id: "acct-th", platform: "threads", dm_message: "should never send" };
  const { client, writes } = stubAdmin({ rules: [rogue] });
  const { fetcher, calls } = stubFetch({ reply: { status: 200, body: { id: "container-1", status: "FINISHED" } } });

  await runCommentWorkflow(client, THREADS, INPUT, { fetcher, now: NOW, pick: FIXED_PICK });

  assertEquals(calls.some((call) => call.url.includes("/messages")), false);
  assertEquals(writes[0].row!.dm_status, "not_applicable");
  assertEquals(writes.at(-1)!.row!.dm_status, "not_applicable");
});

Deno.test("a comment older than Meta's 7-day window skips the DM but still replies publicly", async () => {
  const { client, writes } = stubAdmin();
  const { fetcher, calls } = stubFetch();

  await runCommentWorkflow(
    client,
    FACEBOOK,
    { ...INPUT, timestamp: "2026-08-20T00:00:00Z" },
    { fetcher, now: NOW, pick: FIXED_PICK },
  );

  assertEquals(calls.length, 1);
  assertEquals(calls[0].url.includes("/messages"), false);
  const final = writes.at(-1)!;
  assertEquals(final.row!.public_reply_status, "sent");
  assertEquals(final.row!.dm_status, "skipped");
  assertStringIncludes(String(final.row!.error_message), "private_reply_window_elapsed");
});

Deno.test("an attached file becomes a signed link on its own line in the DM", async () => {
  const withMedia = { ...RULE, media_file_id: "media-1" };
  const { client } = stubAdmin({
    rules: [withMedia],
    media: { file_path: "user-1/guide.pdf", storage_bucket: "media" },
    signedUrl: "https://signed.example/guide",
  });
  const { fetcher, calls } = stubFetch();

  await runCommentWorkflow(client, FACEBOOK, INPUT, { fetcher, now: NOW, pick: FIXED_PICK });
  assertEquals(calls[1].body.message.text, "Here you go\n\nhttps://signed.example/guide");
});

Deno.test("a signing failure still delivers the copy and records why the link is missing", async () => {
  const withMedia = { ...RULE, media_file_id: "media-1" };
  const { client, writes } = stubAdmin({
    rules: [withMedia],
    media: { file_path: "user-1/guide.pdf", storage_bucket: "media" },
    signedUrl: null,
  });
  const { fetcher, calls } = stubFetch();

  await runCommentWorkflow(client, FACEBOOK, INPUT, { fetcher, now: NOW, pick: FIXED_PICK });

  assertEquals(calls[1].body.message.text, "Here you go");
  const final = writes.at(-1)!;
  assertEquals(final.row!.dm_status, "sent");
  assertStringIncludes(String(final.row!.error_message), "media_sign_failed");
});

Deno.test("a file that has moved out of the media bucket is not linked", async () => {
  const withMedia = { ...RULE, media_file_id: "media-1" };
  const { client, writes } = stubAdmin({
    rules: [withMedia],
    media: { file_path: "user-1/guide.pdf", storage_bucket: "ai-knowledge" },
  });
  const { fetcher, calls } = stubFetch();

  await runCommentWorkflow(client, FACEBOOK, INPUT, { fetcher, now: NOW, pick: FIXED_PICK });

  assertEquals(calls[1].body.message.text, "Here you go");
  assertStringIncludes(String(writes.at(-1)!.row!.error_message), "media_wrong_bucket");
});

Deno.test("a failed media read is not treated as a missing file", async () => {
  const withMedia = { ...RULE, media_file_id: "media-1" };
  const { client, writes } = stubAdmin({ rules: [withMedia], mediaError: "statement timeout" });
  const { fetcher } = stubFetch();

  await runCommentWorkflow(client, FACEBOOK, INPUT, { fetcher, now: NOW, pick: FIXED_PICK });
  assertStringIncludes(String(writes.at(-1)!.row!.error_message), "media_lookup_failed");
});

Deno.test("a rule with no public replies sends only the DM", async () => {
  const dmOnly = { ...RULE, public_replies: [] };
  const { client, writes } = stubAdmin({ rules: [dmOnly] });
  const { fetcher, calls } = stubFetch();

  await runCommentWorkflow(client, FACEBOOK, INPUT, { fetcher, now: NOW });

  assertEquals(calls.length, 1);
  assertStringIncludes(calls[0].url, "/messages");
  const final = writes.at(-1)!;
  assertEquals(final.row!.public_reply_status, "skipped");
  assertEquals(final.row!.dm_status, "sent");
});

Deno.test("a comment with no post id claims under the empty-string key", async () => {
  const { client, writes } = stubAdmin();
  const { fetcher } = stubFetch();

  await runCommentWorkflow(
    client,
    FACEBOOK,
    { ...INPUT, post: { id: null } },
    { fetcher, now: NOW, pick: FIXED_PICK },
  );

  const claim = writes.find((w) => w.table === "comment_workflow_usage")!;
  assertEquals(claim.row!.external_post_id, "");
});

Deno.test("an author with no id falls back to the username, then to the comment id", async () => {
  const byUsername = stubAdmin();
  await runCommentWorkflow(
    byUsername.client,
    FACEBOOK,
    { ...INPUT, author: { id: null, username: "fan" } },
    { fetcher: stubFetch().fetcher, now: NOW, pick: FIXED_PICK },
  );
  assertEquals(byUsername.writes.find((w) => w.table === "comment_workflow_usage")!.row!.author_key, "fan");

  const byComment = stubAdmin();
  await runCommentWorkflow(
    byComment.client,
    FACEBOOK,
    { ...INPUT, author: { id: null, username: null } },
    { fetcher: stubFetch().fetcher, now: NOW, pick: FIXED_PICK },
  );
  assertEquals(byComment.writes.find((w) => w.table === "comment_workflow_usage")!.row!.author_key, "c1");
});

Deno.test("a claim table that errors for a reason other than a collision does not send", async () => {
  const { client, writes } = stubAdmin({ usageError: "deadlock detected" });
  const { fetcher, calls } = stubFetch();

  assertEquals(await runCommentWorkflow(client, FACEBOOK, INPUT, { fetcher, now: NOW }), "claimed");
  assertEquals(calls.length, 0);
  assertEquals(writes.at(-1)!.row!.error_message, "usage_claim_failed");
});

Deno.test("the public reply is chosen from the rotation, not fixed to the first", async () => {
  const rotating = { ...RULE, public_replies: ["one", "two", "three"] };
  const { client } = stubAdmin({ rules: [rotating] });
  const { fetcher, calls } = stubFetch();

  await runCommentWorkflow(client, FACEBOOK, INPUT, { fetcher, now: NOW, pick: (replies) => replies[2] });
  assertEquals(calls[0].body.message, "three");
});

Deno.test("a Threads mention is left to the rest of the pipeline, never funnelled", async () => {
  // Threads routes mentions through the same ingest door as replies. A mention is a stranger
  // naming the account in their own thread, not a comment under the account's post; DMing them
  // is not what "comment GUIDE under my post" asked for.
  const { client, writes } = stubAdmin();
  const { fetcher, calls } = stubFetch();

  const outcome = await runCommentWorkflow(
    client,
    FACEBOOK,
    { ...INPUT, comment: { ...INPUT.comment, kind: "mention" } },
    { fetcher, now: NOW },
  );

  assertEquals(outcome, "unclaimed");
  assertEquals(writes.length, 0);
  assertEquals(calls.length, 0);
});

Deno.test("a reply is funnelled like a top-level comment", async () => {
  const { client } = stubAdmin();
  const { fetcher, calls } = stubFetch();

  const outcome = await runCommentWorkflow(
    client,
    FACEBOOK,
    { ...INPUT, comment: { ...INPUT.comment, kind: "reply" } },
    { fetcher, now: NOW, pick: FIXED_PICK },
  );

  assertEquals(outcome, "claimed");
  assertEquals(calls.length, 2);
});

Deno.test("a timed-out DM is indeterminate and KEEPS the claim, so nobody is messaged twice", async () => {
  // callGraph reports a timeout as an unreachable upstream precisely because Meta may have
  // accepted the request before the answer was lost. Releasing the claim here would let this
  // person's next comment send a second DM for something they may already have.
  const { client, writes } = stubAdmin();
  const timingOutFetch = (async (url: string | URL, init?: RequestInit) => {
    if (String(url).includes("/messages")) throw new DOMException("timed out", "TimeoutError");
    return new Response(JSON.stringify({ error: { message: "rejected" } }), { status: 400 });
  }) as unknown as typeof fetch;

  await runCommentWorkflow(client, FACEBOOK, INPUT, { fetcher: timingOutFetch, now: NOW, pick: FIXED_PICK });

  assertEquals(writes.some((w) => w.table === "comment_workflow_usage" && w.op === "delete"), false);
  const final = writes.at(-1)!;
  assertEquals(final.row!.public_reply_status, "failed");
  assertEquals(final.row!.dm_status, "indeterminate");
});

Deno.test("an unreachable public reply is indeterminate too and keeps the claim", async () => {
  const { client, writes } = stubAdmin({ rules: [{ ...RULE, dm_message: null }] });
  const unreachable = (() => {
    throw new TypeError("network error");
  }) as unknown as typeof fetch;

  await runCommentWorkflow(client, FACEBOOK, INPUT, { fetcher: unreachable, now: NOW, pick: FIXED_PICK });

  assertEquals(writes.some((w) => w.table === "comment_workflow_usage" && w.op === "delete"), false);
  assertEquals(writes.at(-1)!.row!.public_reply_status, "indeterminate");
});

Deno.test("a media row pointing outside the owner's own storage prefix is never signed", async () => {
  // media_files' insert policy checks only that the ROW's user_id is the caller's; file_path is
  // unconstrained. Without ownedStoragePath a user could name someone else's object and have
  // the service role sign it into a DM.
  const withMedia = { ...RULE, media_file_id: "media-1" };
  const { client, writes } = stubAdmin({
    rules: [withMedia],
    media: { file_path: "some-other-user/private.pdf", storage_bucket: "media" },
    signedUrl: "https://signed.example/should-never-appear",
  });
  const { fetcher, calls } = stubFetch();

  await runCommentWorkflow(client, FACEBOOK, INPUT, { fetcher, now: NOW, pick: FIXED_PICK });

  assertEquals(calls[1].body.message.text, "Here you go");
  assertEquals(String(calls[1].body.message.text).includes("signed.example"), false);
  assertStringIncludes(String(writes.at(-1)!.row!.error_message), "media_path_not_owned");
});

Deno.test("a traversal path in a media row is refused rather than signed", async () => {
  const withMedia = { ...RULE, media_file_id: "media-1" };
  const { client, writes } = stubAdmin({
    rules: [withMedia],
    media: { file_path: "user-1/../other/secret.pdf", storage_bucket: "media" },
  });
  const { fetcher, calls } = stubFetch();

  await runCommentWorkflow(client, FACEBOOK, INPUT, { fetcher, now: NOW, pick: FIXED_PICK });

  assertEquals(calls[1].body.message.text, "Here you go");
  assertStringIncludes(String(writes.at(-1)!.row!.error_message), "media_path_not_owned");
});

Deno.test("the full ordering holds against the network: event row, claim, sends, finalize", async () => {
  // One timeline shared by the database stub and the fetch stub. This is the assertion that
  // catches a send moved ahead of the claim — with the writes and the calls in separate arrays,
  // "claim then send" and "send then claim" look identical.
  const trace: Array<string> = [];
  const { client } = stubAdmin({}, trace as never);
  const { fetcher } = stubFetch({}, trace as never);

  await runCommentWorkflow(client, FACEBOOK, INPUT, { fetcher, now: NOW, pick: FIXED_PICK });

  assertEquals(trace, [
    "db:comment_workflow_events:upsert",
    "db:comment_workflow_usage:insert",
    "net:public_reply",
    "net:private_reply",
    "db:comment_workflow_events:update",
  ]);
});

Deno.test("nothing is sent before the claim exists, even when the claim collides", async () => {
  const trace: Array<string> = [];
  const { client } = stubAdmin({ usageConflict: true }, trace as never);
  const { fetcher } = stubFetch({}, trace as never);

  await runCommentWorkflow(client, FACEBOOK, INPUT, { fetcher, now: NOW, pick: FIXED_PICK });

  assertEquals(trace, [
    "db:comment_workflow_events:upsert",
    "db:comment_workflow_usage:insert",
    "db:comment_workflow_events:update",
  ]);
});

Deno.test("the release happens after the sends and before the final status write", async () => {
  const trace: Array<string> = [];
  const { client } = stubAdmin({}, trace as never);
  const { fetcher } = stubFetch({
    reply: { status: 400, body: { error: { message: "no" } } },
    dm: { status: 400, body: { error: { message: "no" } } },
  }, trace as never);

  await runCommentWorkflow(client, FACEBOOK, INPUT, { fetcher, now: NOW, pick: FIXED_PICK });

  assertEquals(trace, [
    "db:comment_workflow_events:upsert",
    "db:comment_workflow_usage:insert",
    "net:public_reply",
    "net:private_reply",
    "db:comment_workflow_usage:delete",
    "db:comment_workflow_events:update",
  ]);
});
