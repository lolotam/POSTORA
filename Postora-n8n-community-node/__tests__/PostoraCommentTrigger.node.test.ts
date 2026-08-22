import { PostoraCommentTrigger } from "../nodes/PostoraCommentTrigger/PostoraCommentTrigger.node";

type WebhookRequest = { method: string; url: string; body?: unknown };
const CALLBACK_URL = "https://n8n.example.test/webhook/postora-comment";

function createHookContext(overrides: {
  staticData?: Record<string, unknown>;
  params?: Record<string, unknown>;
  listing?: unknown[];
  callbackUrl?: string | undefined;
}) {
  const requests: WebhookRequest[] = [];
  const staticData = overrides.staticData ?? {};
  const params = { platform: "", socialAccountId: "", events: ["comment.received"], ...(overrides.params ?? {}) };
  return {
    context: {
      getCredentials: async () => ({ baseUrl: "https://api.example.test" }),
      getNodeParameter: (name: string) => (params as Record<string, unknown>)[name],
      getNodeWebhookUrl: () => ("callbackUrl" in overrides ? overrides.callbackUrl : CALLBACK_URL),
      getWorkflowStaticData: () => staticData,
      helpers: {
        httpRequestWithAuthentication: function (_c: string, request: WebhookRequest) {
          requests.push(request);
          if (request.method === "GET") return Promise.resolve({ webhooks: overrides.listing ?? [] });
          return Promise.resolve({ webhook: { id: "sub-1" } });
        },
      },
    },
    requests,
    staticData,
  };
}

describe("Postora Comment Trigger", () => {
  it("exposes platform, account and events properties in that order", () => {
    const names = new PostoraCommentTrigger().description.properties.map((p) => p.name);
    expect(names).toEqual(["platform", "socialAccountId", "events"]);
  });

  it("registers the callback with platform and account filters", async () => {
    const { context, requests, staticData } = createHookContext({ params: { platform: "instagram", socialAccountId: "acc-1" } });
    await new PostoraCommentTrigger().webhookMethods.default.create.call(context as any);
    expect(requests[0]).toEqual({
      method: "POST",
      url: "https://api.example.test/api/v1/webhooks",
      body: { webhook_url: CALLBACK_URL, events: ["comment.received"], platform: "instagram", social_account_id: "acc-1" },
    });
    expect(staticData.webhookId).toBe("sub-1");
  });

  it("omits empty filters (All platforms / All accounts)", async () => {
    const { context, requests } = createHookContext({});
    await new PostoraCommentTrigger().webhookMethods.default.create.call(context as any);
    expect(requests[0].body).toEqual({ webhook_url: CALLBACK_URL, events: ["comment.received"] });
  });

  it("keeps a subscription whose url, events and filters still match", async () => {
    const { context, requests } = createHookContext({
      staticData: { webhookId: "sub-1" },
      params: { platform: "threads", socialAccountId: "acc-2" },
      listing: [{ id: "sub-1", webhook_url: CALLBACK_URL, events: ["comment.received"], is_active: true, platform: "threads", social_account_id: "acc-2" }],
    });
    expect(await new PostoraCommentTrigger().webhookMethods.default.checkExists.call(context as any)).toBe(true);
    expect(requests.map((r) => r.method)).toEqual(["GET"]);
  });

  it("retires a subscription whose account filter changed", async () => {
    const { context, requests, staticData } = createHookContext({
      staticData: { webhookId: "sub-1" },
      params: { platform: "threads", socialAccountId: "acc-3" },
      listing: [{ id: "sub-1", webhook_url: CALLBACK_URL, events: ["comment.received"], is_active: true, platform: "threads", social_account_id: "acc-2" }],
    });
    expect(await new PostoraCommentTrigger().webhookMethods.default.checkExists.call(context as any)).toBe(false);
    expect(requests.map((r) => r.method)).toEqual(["GET", "DELETE"]);
    expect(staticData.webhookId).toBeUndefined();
  });

  it("loads accounts filtered by the selected platform with an All option first", async () => {
    const node = new PostoraCommentTrigger();
    const ctx = {
      getCredentials: async () => ({ baseUrl: "https://api.example.test" }),
      getCurrentNodeParameter: () => "facebook",
      helpers: {
        httpRequestWithAuthentication: async (_c: string, req: { url: string }) => {
          expect(req.url).toBe("https://api.example.test/api/v1/accounts?platform=facebook");
          return { accounts: [{ id: "acc-1", platform: "facebook", platform_username: "My Page" }] };
        },
      },
    };
    const options = await node.methods.loadOptions.getCommentAccounts.call(ctx as any);
    expect(options).toEqual([
      { name: "All accounts", value: "" },
      { name: "My Page (facebook)", value: "acc-1" },
    ]);
  });

  it("emits the request body as workflow data", async () => {
    const body = { event: "comment.received", comment: { id: "c1" } };
    const result = await new PostoraCommentTrigger().webhook.call({ getBodyData: () => body } as any);
    expect(result).toEqual({ workflowData: [[{ json: body }]], webhookResponse: { status: 200 } });
  });
});
