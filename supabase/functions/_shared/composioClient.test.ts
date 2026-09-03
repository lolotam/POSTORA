import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  COMPOSIO_API_BASE_URL,
  COMPOSIO_API_KEY_HEADER,
  COMPOSIO_BODY_CAP,
  ComposioClient,
  composioClientFromEnv,
  ComposioError,
  redirectUrlFrom,
} from "./composioClient.ts";

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

Deno.test("initiateConnection uses the live-verified v3.1 shape and redirect parser", async () => {
  let request: Request | undefined;
  const client = new ComposioClient({
    apiKey: "test-key",
    fetch: async (input, init) => {
      request = new Request(input, init);
      return json({
        id: "request-1",
        redirectUrl: "https://provider.invalid/connect",
      });
    },
  });

  const result = await client.initiateConnection({
    workspaceId: "workspace-1",
    authConfigId: "auth-1",
    callbackUrl: "https://callback.invalid",
  });

  assertEquals(request?.url, `${COMPOSIO_API_BASE_URL}/connected_accounts`);
  assertEquals(request?.method, "POST");
  assertEquals(request?.headers.get(COMPOSIO_API_KEY_HEADER), "test-key");
  assertEquals(await request?.json(), {
    auth_config: { id: "auth-1" },
    connection: {
      user_id: "workspace-1",
      callback_url: "https://callback.invalid",
    },
  });
  assertEquals(result, {
    connectionRequestId: "request-1",
    redirectUrl: "https://provider.invalid/connect",
  });
  assertEquals(redirectUrlFrom({ redirect_url: "a" }), "a");
  assertEquals(redirectUrlFrom({ redirectUrl: "b" }), "b");
  assertEquals(redirectUrlFrom({ redirect_url: 1 }), null);
});

Deno.test("connected-account and tool methods use their exact paths and shapes", async () => {
  const requests: Request[] = [];
  const responses = [
    json({
      id: "ca-1",
      status: "ACTIVE",
      user_id: "ws",
      auth_config_id: "ac",
      toolkit: "slack",
      created_at: "now",
      metadata: {},
    }),
    json({ items: [] }),
    new Response(null, { status: 204 }),
    json({
      items: [{
        slug: "SLACK_SEARCH_MESSAGES",
        description: "Search",
        input_parameters: { type: "object" },
        version: "latest",
      }],
    }),
    json({ successful: true, data: { ok: true } }),
  ];
  const client = new ComposioClient({
    apiKey: "key",
    fetch: async (input, init) => {
      requests.push(new Request(input, init));
      return responses.shift()!;
    },
  });

  assertEquals((await client.getConnectedAccount("ca-1")).userId, "ws");
  assertEquals(await client.listConnectedAccounts("workspace 1"), []);
  await client.deleteConnectedAccount("ca-1");
  assertEquals(
    (await client.listTools("slack", ["SLACK_SEARCH_MESSAGES"], "latest"))[0]
      .inputParameters,
    { type: "object" },
  );
  const signal = new AbortController().signal;
  await client.executeTool({
    slug: "SLACK_SEARCH_MESSAGES",
    version: "latest",
    workspaceId: "ws",
    connectedAccountId: "ca-1",
    arguments: { q: "x" },
    signal,
  });

  assertEquals(
    requests.map((
      request,
    ) => [
      new URL(request.url).pathname + new URL(request.url).search,
      request.method,
    ]),
    [
      ["/api/v3.1/connected_accounts/ca-1", "GET"],
      ["/api/v3.1/connected_accounts?user_ids=workspace+1", "GET"],
      ["/api/v3.1/connected_accounts/ca-1", "DELETE"],
      [
        "/api/v3.1/tools?toolkit_slug=slack&tool_slugs=SLACK_SEARCH_MESSAGES&version=latest",
        "GET",
      ],
      ["/api/v3.1/tools/execute/SLACK_SEARCH_MESSAGES", "POST"],
    ],
  );
  assertEquals(await requests[4].json(), {
    user_id: "ws",
    connected_account_id: "ca-1",
    arguments: { q: "x" },
    version: "latest",
  });
});

Deno.test("GET retries once for 503 and network errors but execute never retries", async () => {
  let getCalls = 0;
  const getClient = new ComposioClient({
    apiKey: "key",
    fetch: async () => {
      getCalls++;
      if (getCalls === 1) return json({}, 503);
      return json({ items: [] });
    },
  });
  await getClient.listConnectedAccounts("ws");
  assertEquals(getCalls, 2);

  let networkCalls = 0;
  const networkClient = new ComposioClient({
    apiKey: "key",
    fetch: async () => {
      networkCalls++;
      if (networkCalls === 1) throw new TypeError("network");
      return json({ items: [] });
    },
  });
  await networkClient.listTools("slack", [], "latest");
  assertEquals(networkCalls, 2);

  let executeCalls = 0;
  const executeClient = new ComposioClient({
    apiKey: "key",
    fetch: async () => {
      executeCalls++;
      return json({}, 503);
    },
  });
  await assertRejects(
    () =>
      executeClient.executeTool({
        slug: "SLACK_SEND_MESSAGE",
        version: "latest",
        workspaceId: "ws",
        connectedAccountId: "ca",
        arguments: {},
        signal: new AbortController().signal,
      }),
    ComposioError,
    "composio_unavailable",
  );
  assertEquals(executeCalls, 1);
});

Deno.test("errors are bounded, mapped, and never contain the API key", async () => {
  for (
    const [response, code, status] of [
      [json({ error: "rejected" }, 400), "composio_rejected", 400],
      [
        new Response("x".repeat(COMPOSIO_BODY_CAP + 1)),
        "composio_rejected",
        undefined,
      ],
    ] as const
  ) {
    const client = new ComposioClient({
      apiKey: "secret-key",
      fetch: async () => response,
    });
    const error = await assertRejects(
      () => client.getConnectedAccount("id"),
      ComposioError,
      code,
    );
    assertEquals(error.status, status);
    assert(!String(error).includes("secret-key"));
  }

  const timeoutClient = new ComposioClient({
    apiKey: "secret-key",
    fetch: async () => {
      throw new DOMException("aborted", "AbortError");
    },
  });
  const timeout = await assertRejects(
    () => timeoutClient.getConnectedAccount("id"),
    ComposioError,
    "composio_timeout",
  );
  assert(!String(timeout).includes("secret-key"));
});

Deno.test("composioClientFromEnv fails closed when the key is absent", () => {
  assertEquals(composioClientFromEnv(() => undefined), null);
  assert(
    composioClientFromEnv((name) =>
      name === "COMPOSIO_API_KEY" ? "key" : undefined
    ) instanceof ComposioClient,
  );
});

Deno.test("a listed connected account is read from Composio's live nested shape", async () => {
  const client = new ComposioClient({
    apiKey: "test-key",
    fetch: () =>
      Promise.resolve(json({
        items: [{
          id: "ca_live",
          user_id: "workspace-1",
          status: "ACTIVE",
          auth_config: { id: "ac_HPEDCbqyWtqr", auth_scheme: "OAUTH2", is_composio_managed: true },
          toolkit: { slug: "googlesheets" },
          word_id: "googlesheets_talose-acyl",
          alias: null,
          created_at: "2026-09-03T13:13:11.175Z",
        }],
      })),
  });
  const [account] = await client.listConnectedAccounts("workspace-1");
  assertEquals(account.authConfigId, "ac_HPEDCbqyWtqr");
  assertEquals(account.toolkit, "googlesheets");
  assertEquals(account.userId, "workspace-1");
  assertEquals(account.wordId, "googlesheets_talose-acyl");
  assertEquals(account.alias, null);
  assertEquals(account.metadata, {});
});

Deno.test("requestFileUpload posts the md5-bearing request and returns the key and presigned URL", async () => {
  let request: Request | undefined;
  const client = new ComposioClient({
    apiKey: "test-key",
    fetch: async (input, init) => {
      request = new Request(input, init);
      return json({
        id: "703b5008",
        key: "250199/youtube/YOUTUBE_MULTIPART_UPLOAD_VIDEO/request/abc",
        new_presigned_url: "https://r2.example/put?X-Amz-Signature=s",
        newPresignedUrl: "https://r2.example/put?X-Amz-Signature=s",
        type: "request",
        metadata: {},
      });
    },
  });
  const ticket = await client.requestFileUpload({
    toolkit: "youtube",
    tool: "YOUTUBE_MULTIPART_UPLOAD_VIDEO",
    filename: "short.mp4",
    mimetype: "video/mp4",
    md5: "d41d8cd98f00b204e9800998ecf8427e",
  });
  assertEquals(request?.url, `${COMPOSIO_API_BASE_URL}/files/upload/request`);
  assertEquals(await request?.json(), {
    toolkit_slug: "youtube",
    tool_slug: "YOUTUBE_MULTIPART_UPLOAD_VIDEO",
    filename: "short.mp4",
    mimetype: "video/mp4",
    md5: "d41d8cd98f00b204e9800998ecf8427e",
  });
  assertEquals(ticket, {
    key: "250199/youtube/YOUTUBE_MULTIPART_UPLOAD_VIDEO/request/abc",
    presignedUrl: "https://r2.example/put?X-Amz-Signature=s",
  });
});

Deno.test("a file upload request without a key is a rejection, not an empty ticket", async () => {
  const client = new ComposioClient({ apiKey: "k", fetch: () => Promise.resolve(json({ id: "x" })) });
  const error = await assertRejects(
    () => client.requestFileUpload({ toolkit: "youtube", tool: "T", filename: "f", mimetype: "video/mp4", md5: "0" }),
    ComposioError,
  );
  assertEquals(error.code, "composio_rejected");
});
