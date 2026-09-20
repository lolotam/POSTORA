// deno-lint-ignore-file no-import-prefix
// Cover for GET /v1/messages/{id}/media.
//
// The load-bearing tests here are the tenancy ones. The resolver this route
// calls authorises nothing of its own -- its single control is
// `.eq("social_account_id", access.accountId)` -- so the route's own lookup is
// the whole boundary. If that lookup ever stops anchoring on
// partner_api_key_accounts, these are the tests that fail.
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleRequest } from "../index.ts";
import { ACCOUNT_ID, agentFixture } from "../../_shared/agentConfigTestSupport.ts";

const MSG = "55555555-5555-4555-8555-555555555555";
const OTHER_ACCOUNT = "66666666-6666-4666-8666-666666666666";

function fixture(scopes: string[] = ["media:read"]) {
  const f = agentFixture();
  f.rows.partner_api_keys[0].scopes = scopes;
  return f;
}

function withMessage(f: ReturnType<typeof agentFixture>, overrides: Record<string, unknown> = {}) {
  f.rows.whatsapp_messages.push({
    id: MSG,
    social_account_id: ACCOUNT_ID,
    direction: "inbound",
    media_type: "image",
    media_metadata: { mime_type: "image/jpeg", size: 84213 },
    media_url: "owner/whatsapp/inbound/cached.jpg",
    ...overrides,
  });
  return f;
}

function request(path: string) {
  return new Request(`https://partner.example/functions/v1/partner-api/v1/${path}`, {
    method: "GET",
    headers: { "x-postora-key": "pk_live_test" },
  });
}

Deno.test("media for a message on an unbound account is not found, and the resolver never runs", async () => {
  const f = withMessage(fixture(), { social_account_id: OTHER_ACCOUNT });
  const response = await handleRequest(request(`messages/msg_${MSG}/media`), () => f.admin);
  assertEquals(response.status, 404);
  // The binding is part of the lookup, so a row on another account is never
  // selected. Reaching social_accounts at all would mean it had been.
  assert(
    !f.reads.some((url) => url.pathname.endsWith("/social_accounts")),
    "the account was hydrated for a message the key may not read",
  );
});

Deno.test("media lookup filters on the bound accounts, not the key's primary account", async () => {
  const f = withMessage(fixture());
  await handleRequest(request(`messages/msg_${MSG}/media`), () => f.admin);
  const read = f.reads.find((url) => url.pathname.endsWith("/whatsapp_messages"));
  assert(read, "the messages table was never read");
  // `in.(...)` is the bound set from partner_api_key_accounts. An `eq.` here
  // would mean someone swapped boundAccountIds for the primary-account column,
  // which keeps answering about the first account once a key binds a second.
  const filter = read.searchParams.get("social_account_id") ?? "";
  assert(filter.startsWith("in."), `expected a bound-set filter, got ${filter}`);
  assert(filter.includes(ACCOUNT_ID), filter);
});

Deno.test("a malformed or wrongly prefixed id is refused without touching the database", async () => {
  for (const id of ["not-an-id", `conv_${MSG}`]) {
    const f = fixture();
    const response = await handleRequest(request(`messages/${id}/media`), () => f.admin);
    assertEquals(response.status, 404);
    assert(
      !f.reads.some((url) => url.pathname.endsWith("/whatsapp_messages")),
      `id ${id} reached the database`,
    );
  }
});

Deno.test("a key without media:read cannot reach the bytes it can see described", async () => {
  // messages:read is enough for the media METADATA on a message, because that
  // is the same row the key already reads. The file itself needs its own grant.
  const f = withMessage(fixture(["messages:read"]));
  const response = await handleRequest(request(`messages/msg_${MSG}/media`), () => f.admin);
  assertEquals(response.status, 403);
});

Deno.test("a message carrying no media has no media sub-resource", async () => {
  const f = withMessage(fixture(), { media_type: null, media_url: null });
  const response = await handleRequest(request(`messages/msg_${MSG}/media`), () => f.admin);
  // 404 rather than a 200 full of nulls: the sub-resource does not exist.
  assertEquals(response.status, 404);
});

Deno.test("no response body ever carries a storage path or a signing URL", async () => {
  const f = withMessage(fixture());
  const response = await handleRequest(request(`messages/msg_${MSG}/media`), () => f.admin);
  const text = await response.text();
  // Whatever the outcome, the raw media_url must never be published: it is a
  // storage path or a provider URL, and neither is partner-usable.
  assert(!text.includes("owner/whatsapp/inbound/"), text);
  assert(!text.includes("media_url"), text);
});


Deno.test("a cached path owned by someone else is never signed", async () => {
  // The account binding proves who owns the message ROW. It says nothing about
  // who owns the storage OBJECT, and the resolver signs any non-http media_url
  // with the service-role client without checking. A bad restore is enough.
  const f = withMessage(fixture(), { media_url: "some-other-user/whatsapp/inbound/x.jpg" });
  const response = await handleRequest(request(`messages/msg_${MSG}/media`), () => f.admin);
  assertEquals(response.status, 404);
  const text = await response.text();
  assert(!text.includes("some-other-user"), text);
});

Deno.test("a traversal or absolute path in media_url is refused", async () => {
  for (const path of ["../../etc/passwd", "/absolute/x.jpg", "https://evil.test/x.jpg#"]) {
    const f = withMessage(fixture(), { media_url: path });
    const response = await handleRequest(request(`messages/msg_${MSG}/media`), () => f.admin);
    assert(response.status >= 400, `${path} produced ${response.status}`);
  }
});

Deno.test("an outbound message carrying media is not served by this route", async () => {
  // The contract describes an INBOUND sub-resource; an owner-sent echo must not
  // be published through it.
  const f = withMessage(fixture(), { direction: "outbound" });
  const response = await handleRequest(request(`messages/msg_${MSG}/media`), () => f.admin);
  assertEquals(response.status, 404);
  const read = f.reads.find((url) => url.pathname.endsWith("/whatsapp_messages"));
  assertEquals(read?.searchParams.get("direction"), "eq.inbound");
});

Deno.test("a transient resolution failure is reported as retryable", async () => {
  const f = withMessage(fixture(), { media_url: null });
  const response = await handleRequest(request(`messages/msg_${MSG}/media`), () => f.admin);
  assertEquals(response.status, 503);
  const body = await response.json();
  // media_unavailable, not temporarily_unavailable: the latter is a deliberate
  // suspension carrying retryable:false, which would tell a caller to give up on
  // a download the next attempt would have served.
  assertEquals(body.error.code, "media_unavailable");
  assertEquals(body.error.retryable, true);
});
