// deno-lint-ignore-file no-import-prefix
// In-process tests for the dispatch orchestration (3.2/3.3/3.4). The two
// REAL control-flow-abort crash cases live in partnerDispatch.crash.test.ts;
// this file covers the settled outcomes, the settle ladder, the
// double-post()-is-one-intent trap, and the in-process ordering property
// (the durable version of the ordering proof is the crash-before gate).
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";

import { dispatchPartnerTemplate } from "./partnerDispatch.ts";
import { createDispatchHarness, type DispatchHarness } from "./partnerDispatchDurableStub.ts";
import { WhatsAppOpError, type Fetcher } from "./whatsappPartnerOps.ts";

const KEY = "dispatch-test-key";

function freshHarness(): DispatchHarness {
  const h = createDispatchHarness(null);
  h.seedClaim("attempt-token", h.record.id, KEY);
  return h;
}

function deps(h: DispatchHarness, fetcher?: Fetcher) {
  return {
    admin: h.admin,
    record: h.record,
    ctx: h.ctx,
    idempotencyKey: KEY,
    attemptToken: "attempt-token",
    input: { recipientPhone: "96512345678", templateName: "t_v1", templateLanguage: "ar" },
    ...(fetcher ? { fetcher } : {}),
  };
}

const okFetcher: Fetcher = () =>
  Promise.resolve(new Response(JSON.stringify({ messages: [{ id: "wamid.OK" }] }), { status: 200 }));

Deno.test("dispatch: happy path records the intent BEFORE the fetch, then settles sent", async () => {
  const h = freshHarness();
  let intentAtFetch: Record<string, unknown> | null = null;
  let sentBodyText = "";
  const observingFetcher: Fetcher = (input, init) => {
    // In-process ordering check: at the moment the provider is invoked the
    // intent row is already committed (persisted by the stub) and intended.
    intentAtFetch = { ...(h.read().intents[0] ?? {}) };
    sentBodyText = String(init?.body ?? "");
    assertEquals(String(input).includes("/messages"), true);
    return Promise.resolve(
      new Response(JSON.stringify({ messages: [{ id: "wamid.OK" }] }), { status: 200 }),
    );
  };

  const result = await dispatchPartnerTemplate(deps(h, observingFetcher));

  assertEquals(result.outcome, "sent");
  // The fetcher saw a committed, intended row — not nothing.
  assertEquals(intentAtFetch?.state, "intended");
  assertEquals(h.read().log.indexOf("intent-inserted") < h.read().log.length, true);

  const final = h.read();
  assertEquals(final.intents[0].state, "sent");
  assertEquals(final.intents[0].wamid, "wamid.OK");
  assertEquals(final.idempotency[0].state, "completed");
  assertEquals(final.idempotency[0].http_status, 200);
  if (result.outcome !== "sent") throw new Error("unreachable");
  assertEquals(result.body.message_id, "wamid.OK");

  // 3.4: the provider payload carried the intent id as the correlator.
  const sentBody = JSON.parse(sentBodyText) as Record<string, unknown>;
  assertEquals(sentBody.biz_opaque_callback_data, final.intents[0].id);
});

Deno.test("dispatch: a definite provider rejection settles failed, releases quota, records the replay body", async () => {
  const h = freshHarness();
  const rejectingFetcher: Fetcher = () =>
    Promise.resolve(new Response(
      JSON.stringify({ error: { code: 131047, message: "Re-engagement message" } }),
      { status: 400 },
    ));

  const result = await dispatchPartnerTemplate(deps(h, rejectingFetcher));

  assertEquals(result.outcome, "failed");
  if (result.outcome !== "failed") throw new Error("unreachable");
  assertEquals(result.httpStatus, 422);
  assertEquals(result.errorCode, "outside_session_window");

  const final = h.read();
  assertEquals(final.intents[0].state, "failed");
  assertEquals(final.intents[0].http_status, 422);
  assertEquals(final.idempotency[0].state, "completed");
  assertEquals(final.quotaReserved, 0, "a proven non-delivery releases its quota unit");
});

Deno.test("dispatch: an INDETERMINATE provider outcome keeps the intent `intended` and never releases quota (invariant 5)", async () => {
  const h = freshHarness();
  // HTTP 500 from Meta: it failed to RESPOND, not to accept.
  const fiveHundredFetcher: Fetcher = () =>
    Promise.resolve(new Response(JSON.stringify({ error: { code: 2, message: "Partial Error" } }), { status: 500 }));

  const result = await dispatchPartnerTemplate(deps(h, fiveHundredFetcher));

  assertEquals(result.outcome, "indeterminate");
  const final = h.read();
  // Only a takeover writes `indeterminate` on the intent (decision record
  // section 2): the original attempt leaves the row `intended`, and the
  // IDEMPOTENCY row carries the partner-facing verdict.
  assertEquals(final.intents[0].state, "intended");
  assertEquals(final.idempotency[0].state, "indeterminate");
  assertEquals(final.quotaReserved, 1, "an unknown outcome may have been delivered — quota is kept");
});

Deno.test("dispatch: a refused quota leaves NO intent row (an orphan `intended` would poison the key)", async () => {
  const h = freshHarness();
  const origRpc = h.admin.rpc.bind(h.admin);
  // deno-lint-ignore no-explicit-any
  h.admin.rpc = (name: string, params: any) =>
    name === "reserve_partner_quota"
      ? Promise.resolve({ data: { allowed: false }, error: null })
      : origRpc(name, params);

  const result = await dispatchPartnerTemplate(deps(h, okFetcher));

  assertEquals(result.outcome, "failed");
  if (result.outcome !== "failed") throw new Error("unreachable");
  assertEquals(result.httpStatus, 429);
  assertEquals(result.errorCode, "quota_exceeded");
  const final = h.read();
  assertEquals(final.intents.length, 0, "a request that never dispatched must leave no intent");
  assertEquals(final.idempotency[0].state, "completed");
  assertEquals(final.idempotency[0].http_status, 429);
});

Deno.test("dispatch: takeover finds `intended` -> indeterminate, zero provider calls (invariant 1)", async () => {
  const h = freshHarness();
  // A previous attempt committed an intent and died before any outcome: the
  // durable state the crash-before gate leaves behind (the worker-based test
  // produces it by real termination; this tests the takeover decision in
  // isolation, deterministically).
  h.admin.from("partner_dispatch_intents").insert({
    id: "33333333-3333-4333-8333-333333333333",
    workspace_id: "ws-crash",
    key_id: h.record.id,
    social_account_id: "acct-crash",
    idempotency_key: KEY,
    state: "intended",
    request_summary: {},
  });
  h.simulateTakeoverClaim("attempt-2");

  let fetchCalls = 0;
  const counting: Fetcher = (_i, _init) => {
    fetchCalls += 1;
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  const result = await dispatchPartnerTemplate({
    admin: h.admin, record: h.record, ctx: h.ctx,
    idempotencyKey: KEY, attemptToken: "attempt-2",
    input: { recipientPhone: "96512345678", templateName: "t_v1", templateLanguage: "ar" },
    fetcher: counting,
  });

  assertEquals(result.outcome, "indeterminate");
  assertEquals(fetchCalls, 0, "the takeover must not call the provider");
  const final = h.read();
  assertEquals(final.intents[0].state, "indeterminate");
  assertEquals(final.idempotency[0].state, "indeterminate");
});

Deno.test("dispatch: takeover finds `sent` -> replays the recorded outcome verbatim, zero provider calls", async () => {
  const h = freshHarness();
  // A previous attempt succeeded at Meta, recorded `sent` + the response
  // body, and died before settling the idempotency row.
  h.admin.from("partner_dispatch_intents").insert({
    id: "22222222-2222-4222-8222-222222222222",
    workspace_id: "ws-crash",
    key_id: h.record.id,
    social_account_id: "acct-crash",
    idempotency_key: KEY,
    state: "sent",
    wamid: "wamid.EARLIER",
    http_status: 200,
    response_body: {
      success: true, message_id: "wamid.EARLIER",
      state: "accepted_by_meta", recorded_in_inbox: true,
    },
    request_summary: {},
  });
  h.simulateTakeoverClaim("attempt-2");

  let fetchCalls = 0;
  const counting: Fetcher = () => {
    fetchCalls += 1;
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  const result = await dispatchPartnerTemplate({
    admin: h.admin, record: h.record, ctx: h.ctx,
    idempotencyKey: KEY, attemptToken: "attempt-2",
    input: { recipientPhone: "96512345678", templateName: "t_v1", templateLanguage: "ar" },
    fetcher: counting,
  });

  assertEquals(fetchCalls, 0, "replaying is not re-dispatching: the provider is never touched");
  assertEquals(result.outcome, "replayed");
  if (result.outcome !== "replayed") throw new Error("unreachable");
  assertEquals(result.httpStatus, 200);
  assertEquals((result.body as Record<string, unknown>).message_id, "wamid.EARLIER");
  assertEquals(h.read().idempotency[0].state, "completed", "the claim is settled so future retries replay directly");
});

Deno.test("dispatch: the auto-registration double post() is ONE dispatch attempt under ONE intent row (the 3.3 trap)", async () => {
  const h = freshHarness();
  const calls: string[] = [];
  const bodies: string[] = [];
  // Meta error 133010 on the first send -> register -> retry succeeds: the
  // pair of posts sendTemplate performs internally.
  const registeringFetcher: Fetcher = (url, init) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/register")) {
      return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
    }
    bodies.push(String(init?.body ?? ""));
    const isRetry = calls.filter((c) => c.endsWith("/messages")).length > 1;
    return Promise.resolve(new Response(
      JSON.stringify(isRetry ? { messages: [{ id: "wamid.AFTER_REGISTER" }] } : { error: { code: 133010, message: "not registered" } }),
      { status: isRetry ? 200 : 400 },
    ));
  };

  const result = await dispatchPartnerTemplate(deps(h, registeringFetcher));

  assertEquals(result.outcome, "sent");
  assertEquals(calls.filter((c) => c.endsWith("/messages")).length, 2, "one dispatch attempt, two posts");
  assertEquals(calls.filter((c) => c.endsWith("/register")).length, 1);

  const final = h.read();
  assertEquals(final.intents.length, 1, "the register+retry pair shares ONE intent row");
  assertEquals(final.intents[0].state, "sent");
  assertEquals(final.intents[0].wamid, "wamid.AFTER_REGISTER");
  // Both posts of the attempt carry the SAME correlator: the second post is
  // not a takeover, and the bookkeeping must never treat it as one.
  const first = JSON.parse(bodies[0]) as Record<string, unknown>;
  const second = JSON.parse(bodies[1]) as Record<string, unknown>;
  assertEquals(first.biz_opaque_callback_data, final.intents[0].id);
  assertEquals(second.biz_opaque_callback_data, final.intents[0].id);
});

Deno.test("dispatch: a settle failure after a successful send never reports the delivered message as failed", async () => {
  const h = freshHarness();
  // Make every idempotency-row write fail AFTER the send: the dispatch must
  // still answer `sent` (Meta accepted; the customer may have the message),
  // and the fallback marks the claim indeterminate — which fails too, and
  // that is swallowed by design.
  // deno-lint-ignore no-explicit-any
  const origFrom = h.admin.from.bind(h.admin);
  // deno-lint-ignore no-explicit-any
  h.admin.from = (table: string): any => {
    if (table === "partner_api_idempotency") {
      return {
        update: () => ({
          eq: () => ({
            eq: () => ({
              eq: () => Promise.resolve({ error: { message: "db down" } }),
            }),
          }),
        }),
      };
    }
    return origFrom(table);
  };

  const result = await dispatchPartnerTemplate(deps(h, okFetcher));
  assertEquals(result.outcome, "sent", "a bookkeeping failure must not turn an accepted send into a failure");
  const final = h.read();
  assertEquals(final.intents[0].state, "sent", "the intent settle still ran (it is not allowed to fail the send)");
});

Deno.test("dispatch: a transport error mid-send (fetch throws) is indeterminate, never failed", async () => {
  const h = freshHarness();
  const explodingFetcher: Fetcher = () => Promise.reject(new Error("connection reset mid-flight"));

  const result = await dispatchPartnerTemplate(deps(h, explodingFetcher));

  assertEquals(result.outcome, "indeterminate");
  const final = h.read();
  assertEquals(final.intents[0].state, "intended", "unknown outcome: the row stays intended for a later takeover/webhook");
  assertEquals(final.idempotency[0].state, "indeterminate");
  assertEquals(final.quotaReserved, 1, "the unit is kept: the message may have been delivered");
});

Deno.test("dispatch: an unparseable success body is indeterminate, never failed (invariant 5)", async () => {
  const h = freshHarness();
  // 2xx, but no message id: Meta very likely accepted; never a rejection.
  const noWamidFetcher: Fetcher = () =>
    Promise.resolve(new Response(JSON.stringify({}), { status: 200 }));

  const result = await dispatchPartnerTemplate(deps(h, noWamidFetcher));

  assertEquals(result.outcome, "indeterminate");
  assertEquals(h.read().intents[0].state, "intended");
  assertEquals(h.read().idempotency[0].state, "indeterminate");
});

Deno.test("WhatsAppOpError with indeterminate=true is distinguishable at the dispatch boundary", () => {
  // Guards the classification the two tests above depend on: timeouts, 5xx
  // and missing-wamid map to indeterminate=true; typed 4xx rejections do not.
  const indeterminate = new WhatsAppOpError("Partial Error", "meta_error", 502, 2, true);
  const definite = new WhatsAppOpError("nope", "template_not_approved", 422, 132001, false);
  assertEquals(indeterminate.indeterminate, true);
  assertEquals(definite.indeterminate, false);
});

Deno.test("dispatch: success calls reserve then confirm and never release", async () => {
  const h = freshHarness();
  const result = await dispatchPartnerTemplate(deps(h, okFetcher));
  assertEquals(result.outcome, "sent");
  assertEquals(h.read().rpcCalls, ["reserve_partner_quota", "confirm_partner_quota"]);
});

Deno.test("dispatch: definite rejection calls reserve then release and never confirm", async () => {
  const h = freshHarness();
  const rejectingFetcher: Fetcher = () =>
    Promise.resolve(new Response(
      JSON.stringify({ error: { code: 131047, message: "Re-engagement message" } }),
      { status: 400 },
    ));
  const result = await dispatchPartnerTemplate(deps(h, rejectingFetcher));
  assertEquals(result.outcome, "failed");
  assertEquals(h.read().rpcCalls, ["reserve_partner_quota", "release_partner_quota"]);
});

Deno.test("dispatch: indeterminate fetcher throw calls reserve then indeterminate and never release", async () => {
  const h = freshHarness();
  const explodingFetcher: Fetcher = () => Promise.reject(new Error("connection reset mid-flight"));
  const result = await dispatchPartnerTemplate(deps(h, explodingFetcher));
  assertEquals(result.outcome, "indeterminate");
  assertEquals(h.read().rpcCalls, ["reserve_partner_quota", "indeterminate_partner_quota"]);
});

Deno.test("dispatch: takeover of an existing intended row calls reserve then release and never confirm or indeterminate", async () => {
  const h = freshHarness();
  h.admin.from("partner_dispatch_intents").insert({
    id: "33333333-3333-4333-8333-333333333333",
    workspace_id: "ws-crash",
    key_id: h.record.id,
    social_account_id: "acct-crash",
    idempotency_key: KEY,
    state: "intended",
    request_summary: {},
  });
  h.simulateTakeoverClaim("attempt-2");
  let fetchCalls = 0;
  const counting: Fetcher = () => {
    fetchCalls += 1;
    return Promise.resolve(new Response("{}", { status: 200 }));
  };
  const result = await dispatchPartnerTemplate({
    admin: h.admin, record: h.record, ctx: h.ctx,
    idempotencyKey: KEY, attemptToken: "attempt-2",
    input: { recipientPhone: "96512345678", templateName: "t_v1", templateLanguage: "ar" },
    fetcher: counting,
  });
  assertEquals(result.outcome, "indeterminate");
  assertEquals(fetchCalls, 0);
  assertEquals(h.read().rpcCalls, ["reserve_partner_quota", "release_partner_quota"]);
});
