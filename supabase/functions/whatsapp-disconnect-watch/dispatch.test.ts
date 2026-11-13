import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { dispatchDisconnectAlert } from "./dispatch.ts";

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: string;
  signal: AbortSignal | null | undefined;
}

function recorder(response: () => Response | Promise<Response>): {
  calls: RecordedCall[];
  fetcher: typeof fetch;
} {
  const calls: RecordedCall[] = [];
  const fetcher = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: String(init?.body ?? ""),
      signal: init?.signal,
    });
    return Promise.resolve(response());
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

const OPTIONS = {
  url: "https://api.postora.cloud/functions/v1/send-whatsapp-disconnect-alert",
  serviceRoleKey: "service_role_test_key",
  accountId: "acc-1",
};

const summary = (body: Record<string, unknown>) =>
  new Response(JSON.stringify({ ok: true, ...body }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

Deno.test("the dispatch posts the account and carries a timeout signal", async () => {
  const { calls, fetcher } = recorder(() =>
    summary({ ownerSent: true, adminSent: false, skipped: null, failed: [] })
  );

  await dispatchDisconnectAlert({ ...OPTIONS, fetcher });

  assertEquals(calls.length, 1);
  assertEquals(calls[0].body, JSON.stringify({ account_id: "acc-1" }));
  assertEquals(calls[0].signal instanceof AbortSignal, true);
  assertEquals(calls[0].signal?.aborted, false);
});

Deno.test("the dispatch reports what the sender actually did", async () => {
  const { fetcher } = recorder(() =>
    summary({ ownerSent: true, adminSent: true, skipped: null, failed: [] })
  );

  const result = await dispatchDisconnectAlert({ ...OPTIONS, fetcher });

  assertEquals(result, { ownerSent: true, adminSent: true, failed: [], skipped: null });
});

Deno.test("the dispatch reports the recipients the sender could not reach", async () => {
  // The sender answers 200 even when a recipient failed, so the summary is the only
  // evidence of what happened.
  const { fetcher } = recorder(() =>
    summary({ ownerSent: false, adminSent: false, skipped: null, failed: ["acc-1"] })
  );

  const result = await dispatchDisconnectAlert({ ...OPTIONS, fetcher });

  assertEquals(result.ownerSent, false);
  assertEquals(result.adminSent, false);
  assertEquals(result.failed, ["acc-1"]);
});

Deno.test("a sender that answers with a failure is a dispatch failure", async () => {
  const { fetcher } = recorder(() => new Response("nope", { status: 500 }));

  await assertRejects(() => dispatchDisconnectAlert({ ...OPTIONS, fetcher }));
});

Deno.test("a sender that answers 200 without a summary is a dispatch failure", async () => {
  // There is no evidence that an alert went out, so the watcher must not claim one.
  const { fetcher } = recorder(() => new Response("not json", { status: 200 }));

  await assertRejects(() => dispatchDisconnectAlert({ ...OPTIONS, fetcher }));
});

Deno.test("a sender that answers 200 with an empty body is a dispatch failure", async () => {
  // `{}` is not a summary: it says nothing about what the sender did. Reading it as an
  // empty summary would report a clean run for an alert that never went out.
  const { fetcher } = recorder(() =>
    new Response(JSON.stringify({}), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );

  await assertRejects(() => dispatchDisconnectAlert({ ...OPTIONS, fetcher }));
});

Deno.test("a summary that is missing a field is a dispatch failure", async () => {
  // The sender always answers with all four fields. A body without them is not a
  // summary, and the watcher must not read the missing ones as "nothing went out".
  const { fetcher } = recorder(() =>
    new Response(JSON.stringify({ ownerSent: true, adminSent: false }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  );

  await assertRejects(() => dispatchDisconnectAlert({ ...OPTIONS, fetcher }));
});

Deno.test("a summary whose fields have the wrong type is a dispatch failure", async () => {
  // `ownerSent: "true"` is not a boolean. A summary that cannot be read is not evidence
  // that an alert went out.
  const { fetcher } = recorder(() =>
    summary({ ownerSent: "true", adminSent: false, skipped: null, failed: [] })
  );

  await assertRejects(() => dispatchDisconnectAlert({ ...OPTIONS, fetcher }));
});

Deno.test("a summary whose failed list holds a non-string is a dispatch failure", async () => {
  const { fetcher } = recorder(() =>
    summary({ ownerSent: false, adminSent: false, skipped: null, failed: ["acc-1", 7] })
  );

  await assertRejects(() => dispatchDisconnectAlert({ ...OPTIONS, fetcher }));
});

Deno.test("a dispatch that times out is a dispatch failure", async () => {
  const { fetcher } = recorder(() => {
    const error = new Error("The operation was aborted due to timeout");
    error.name = "TimeoutError";
    throw error;
  });

  await assertRejects(() => dispatchDisconnectAlert({ ...OPTIONS, fetcher, timeoutMs: 10 }));
});
