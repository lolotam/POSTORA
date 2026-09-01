// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  sendTemplate,
  WhatsAppOpError,
} from "./whatsappPartnerOps.ts";

function stubAdmin(captured: { rows: unknown[] }) {
  return {
    from() {
      return {
        insert(row: unknown) { captured.rows.push(row); return Promise.resolve({ error: null }); },
        upsert(row: unknown) { captured.rows.push(row); return Promise.resolve({ error: null }); },
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      };
    },
  // deno-lint-ignore no-explicit-any
  } as any;
}

function ctx(captured: { rows: unknown[] }) {
  return {
    admin: stubAdmin(captured),
    accountId: "acct-1",
    ownerId: "owner-1",
    workspaceId: "ws-1",
    phoneNumberId: "999888777",
    accessToken: "tok",
  };
}

Deno.test("sendTemplate posts the Meta template payload and returns the message id", async () => {
  const captured = { rows: [] as unknown[] };
  let requestBody: Record<string, unknown> = {};

  const fetcher = (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return Promise.resolve(
      new Response(JSON.stringify({ messages: [{ id: "wamid.ABC" }] }), { status: 200 }),
    );
  };

  const result = await sendTemplate(ctx(captured), {
    recipientPhone: "96512345678",
    templateName: "invoice_due_v1",
    templateLanguage: "ar",
    components: [{ type: "body", parameters: [{ type: "text", text: "12.500 KWD" }] }],
  }, fetcher);

  assertEquals(result.messageId, "wamid.ABC");
  assertEquals(requestBody.messaging_product, "whatsapp");
  assertEquals(requestBody.type, "template");
  assertEquals((requestBody.template as Record<string, unknown>).name, "invoice_due_v1");
  assertEquals(
    ((requestBody.template as Record<string, unknown>).language as Record<string, string>).code,
    "ar",
  );
});

Deno.test("sendTemplate records the outbound message so it appears in the inbox", async () => {
  const captured = { rows: [] as unknown[] };
  const fetcher = () =>
    Promise.resolve(new Response(JSON.stringify({ messages: [{ id: "wamid.ABC" }] }), { status: 200 }));

  await sendTemplate(ctx(captured), {
    recipientPhone: "96512345678",
    templateName: "invoice_due_v1",
    templateLanguage: "ar",
  }, fetcher);

  const message = captured.rows.find((r) =>
    (r as Record<string, unknown>).direction === "outbound"
  ) as Record<string, unknown> | undefined;

  assertEquals(message?.user_id, "owner-1");
  assertEquals(message?.social_account_id, "acct-1");
  assertEquals(message?.message_id, "wamid.ABC");
  assertEquals(message?.conversation_id, "wa_999888777_96512345678");
  assertEquals(message?.message_type, "template");
});

Deno.test("sendTemplate auto-registers on 133010 and retries the send", async () => {
  const captured = { rows: [] as unknown[] };
  const calls: string[] = [];

  const fetcher = (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/register")) {
      return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
    }
    // First send fails "not registered"; the retry after registration succeeds.
    const isRetry = calls.filter((c) => c.endsWith("/messages")).length > 1;
    return Promise.resolve(new Response(
      JSON.stringify(isRetry
        ? { messages: [{ id: "wamid.AFTER" }] }
        : { error: { code: 133010, message: "not registered" } }),
      { status: isRetry ? 200 : 400 },
    ));
  };

  const result = await sendTemplate(ctx(captured), {
    recipientPhone: "96512345678",
    templateName: "invoice_due_v1",
    templateLanguage: "ar",
  }, fetcher);

  assertEquals(result.messageId, "wamid.AFTER");
  assertEquals(calls.filter((c) => c.endsWith("/register")).length, 1);
  assertEquals(calls.filter((c) => c.endsWith("/messages")).length, 2);
});

Deno.test("sendTemplate records cloud_api_registered after auto-registering", async () => {
  // WhatsAppCoexistenceSetupBanner.tsx reads this flag. Without the write the
  // send succeeds but the operator keeps seeing a "finish setup" prompt.
  const updates: Array<Record<string, unknown>> = [];
  const admin = {
    from(table: string) {
      return {
        insert() { return Promise.resolve({ error: null }); },
        upsert() { return Promise.resolve({ error: null }); },
        update(row: Record<string, unknown>) {
          if (table === "social_accounts") updates.push(row);
          return { eq: () => Promise.resolve({ error: null }) };
        },
        select() { return this; },
        eq() { return this; },
        maybeSingle() {
          return Promise.resolve({ data: { account_metadata: { waba_id: "w1" } }, error: null });
        },
      };
    },
  // deno-lint-ignore no-explicit-any
  } as any;

  const calls: string[] = [];
  const fetcher = (url: string | URL | Request) => {
    const u = String(url);
    calls.push(u);
    if (u.endsWith("/register")) {
      return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
    }
    const isRetry = calls.filter((c) => c.endsWith("/messages")).length > 1;
    return Promise.resolve(new Response(
      JSON.stringify(isRetry
        ? { messages: [{ id: "wamid.AFTER" }] }
        : { error: { code: 133010, message: "not registered" } }),
      { status: isRetry ? 200 : 400 },
    ));
  };

  await sendTemplate({
    admin, accountId: "acct-1", ownerId: "owner-1", workspaceId: "ws-1",
    phoneNumberId: "999888777", accessToken: "tok",
  }, {
    recipientPhone: "96512345678",
    templateName: "invoice_due_v1",
    templateLanguage: "ar",
  }, fetcher);

  const flagged = updates.find((u) =>
    ((u.account_metadata ?? {}) as Record<string, unknown>).cloud_api_registered === true
  );
  assertEquals(flagged !== undefined, true);
  // The pre-existing metadata must survive the merge, not be replaced.
  assertEquals(
    ((flagged!.account_metadata as Record<string, unknown>).waba_id),
    "w1",
  );
});

Deno.test("sendTemplate upserts the conversation so it appears in the inbox", async () => {
  const captured = { rows: [] as unknown[] };
  const tables: string[] = [];

  const admin = {
    from(table: string) {
      tables.push(table);
      return {
        insert(row: unknown) { captured.rows.push(row); return Promise.resolve({ error: null }); },
        upsert(row: unknown) { captured.rows.push(row); return Promise.resolve({ error: null }); },
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      };
    },
  // deno-lint-ignore no-explicit-any
  } as any;

  const fetcher = () =>
    Promise.resolve(new Response(JSON.stringify({ messages: [{ id: "wamid.ABC" }] }), { status: 200 }));

  await sendTemplate({
    admin, accountId: "acct-1", ownerId: "owner-1", workspaceId: "ws-1",
    phoneNumberId: "999888777", accessToken: "tok",
  }, {
    recipientPhone: "96512345678",
    templateName: "invoice_due_v1",
    templateLanguage: "ar",
  }, fetcher);

  // Without messaging_cache the inbox never shows the conversation.
  assertEquals(tables.includes("whatsapp_messages"), true);
  assertEquals(tables.includes("whatsapp_contacts"), true);
  assertEquals(tables.includes("messaging_cache"), true);

  const cacheRow = captured.rows.find((r) =>
    (r as Record<string, unknown>).platform === "whatsapp" &&
    (r as Record<string, unknown>).last_message_preview !== undefined
  ) as Record<string, unknown> | undefined;
  assertEquals(cacheRow?.last_message_preview, "[Template: invoice_due_v1]");
});

Deno.test("sendTemplate labels the message with the template name", async () => {
  const captured = { rows: [] as unknown[] };
  const fetcher = () =>
    Promise.resolve(new Response(JSON.stringify({ messages: [{ id: "wamid.ABC" }] }), { status: 200 }));

  await sendTemplate(ctx(captured), {
    recipientPhone: "96512345678",
    templateName: "invoice_due_v1",
    templateLanguage: "ar",
  }, fetcher);

  const message = captured.rows.find((r) =>
    (r as Record<string, unknown>).direction === "outbound"
  ) as Record<string, unknown> | undefined;
  // The UI shows this string in the inbox; "[Template message]" would lose the name.
  assertEquals(message?.message_text, "[Template: invoice_due_v1]");
});

Deno.test("sendTemplate returns the raw Meta body for the existing UI contract", async () => {
  const captured = { rows: [] as unknown[] };
  const fetcher = () =>
    Promise.resolve(new Response(
      JSON.stringify({ messages: [{ id: "wamid.ABC" }], messaging_product: "whatsapp" }),
      { status: 200 },
    ));

  const result = await sendTemplate(ctx(captured), {
    recipientPhone: "96512345678",
    templateName: "invoice_due_v1",
    templateLanguage: "ar",
  }, fetcher);

  assertEquals((result.raw as Record<string, unknown>).messaging_product, "whatsapp");
});

Deno.test("sendTemplate maps Meta error 131047 to outside_session_window", async () => {
  const captured = { rows: [] as unknown[] };
  const fetcher = () =>
    Promise.resolve(new Response(
      JSON.stringify({ error: { code: 131047, message: "Re-engagement message" } }),
      { status: 400 },
    ));

  const error = await assertRejects(
    () => sendTemplate(ctx(captured), {
      recipientPhone: "96512345678",
      templateName: "invoice_due_v1",
      templateLanguage: "ar",
    }, fetcher),
    WhatsAppOpError,
  );
  assertEquals(error.code, "outside_session_window");
  assertEquals(error.metaCode, 131047);
});

Deno.test("sendTemplate maps an unapproved template to template_not_approved", async () => {
  const captured = { rows: [] as unknown[] };
  const fetcher = () =>
    Promise.resolve(new Response(
      JSON.stringify({ error: { code: 132001, message: "Template does not exist" } }),
      { status: 400 },
    ));

  const error = await assertRejects(
    () => sendTemplate(ctx(captured), {
      recipientPhone: "96512345678",
      templateName: "nope_v1",
      templateLanguage: "ar",
    }, fetcher),
    WhatsAppOpError,
  );
  assertEquals(error.code, "template_not_approved");
});

Deno.test("sendTemplate reports persisted=false when Meta accepted but the DB write failed", async () => {
  const failingAdmin = {
    from() {
      return {
        insert() { return Promise.resolve({ error: { message: "db down" } }); },
        upsert() { return Promise.resolve({ error: { message: "db down" } }); },
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      };
    },
  // deno-lint-ignore no-explicit-any
  } as any;

  const fetcher = () =>
    Promise.resolve(new Response(JSON.stringify({ messages: [{ id: "wamid.ABC" }] }), { status: 200 }));

  const result = await sendTemplate({
    admin: failingAdmin, accountId: "acct-1", ownerId: "owner-1",
    workspaceId: "ws-1", phoneNumberId: "999888777", accessToken: "tok",
  }, {
    recipientPhone: "96512345678",
    templateName: "invoice_due_v1",
    templateLanguage: "ar",
  }, fetcher);

  // The message really was sent; the caller must be able to tell it was not recorded.
  assertEquals(result.messageId, "wamid.ABC");
  assertEquals(result.persisted, false);
});

Deno.test("sendTemplate stamps callbackData into biz_opaque_callback_data when provided", async () => {
  const captured = { rows: [] as unknown[] };
  let requestBody: Record<string, unknown> = {};

  const fetcher = (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return Promise.resolve(
      new Response(JSON.stringify({ messages: [{ id: "wamid.ABC" }] }), { status: 200 }),
    );
  };

  await sendTemplate(ctx(captured), {
    recipientPhone: "96512345678",
    templateName: "invoice_due_v1",
    templateLanguage: "ar",
    callbackData: "33333333-3333-4333-8333-333333333333",
  }, fetcher);

  // The D13 reconciliation channel (3.4): this is the value a status webhook
  // must echo back for a dispatch intent to resolve.
  assertEquals(
    requestBody.biz_opaque_callback_data,
    "33333333-3333-4333-8333-333333333333",
  );
});

Deno.test("sendTemplate omits biz_opaque_callback_data entirely when no callbackData is given", async () => {
  const captured = { rows: [] as unknown[] };
  let requestBody: Record<string, unknown> = {};

  const fetcher = (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body));
    return Promise.resolve(
      new Response(JSON.stringify({ messages: [{ id: "wamid.ABC" }] }), { status: 200 }),
    );
  };

  await sendTemplate(ctx(captured), {
    recipientPhone: "96512345678",
    templateName: "invoice_due_v1",
    templateLanguage: "ar",
  }, fetcher);

  // The JWT door sends without an intent: its payload must be byte-identical
  // to before this change, so absence has to be absence, not null.
  assertEquals(
    Object.hasOwn(requestBody, "biz_opaque_callback_data"),
    false,
  );
});

Deno.test("sendTemplate's auto-registration retry re-posts the SAME correlator (one attempt, not a takeover)", async () => {
  const captured = { rows: [] as unknown[] };
  const messageBodies: string[] = [];

  const fetcher = (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/register")) {
      return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
    }
    messageBodies.push(String(init?.body ?? ""));
    const isRetry = messageBodies.length > 1;
    return Promise.resolve(new Response(
      JSON.stringify(isRetry
        ? { messages: [{ id: "wamid.AFTER" }] }
        : { error: { code: 133010, message: "not registered" } }),
      { status: isRetry ? 200 : 400 },
    ));
  };

  await sendTemplate(ctx(captured), {
    recipientPhone: "96512345678",
    templateName: "invoice_due_v1",
    templateLanguage: "ar",
    callbackData: "44444444-4444-4444-8444-444444444444",
  }, fetcher);

  assertEquals(messageBodies.length, 2);
  const first = JSON.parse(messageBodies[0]) as Record<string, unknown>;
  const second = JSON.parse(messageBodies[1]) as Record<string, unknown>;
  // Both posts of the register+retry pair carry ONE correlator: the pair is
  // one dispatch attempt under one intent row. If the second post ever
  // carried a different value, the bookkeeping would mistake its own retry
  // for a takeover (the 3.3 trap).
  assertEquals(first.biz_opaque_callback_data, "44444444-4444-4444-8444-444444444444");
  assertEquals(second.biz_opaque_callback_data, "44444444-4444-4444-8444-444444444444");
});
