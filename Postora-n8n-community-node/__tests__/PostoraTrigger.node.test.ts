import { PostoraTrigger } from "../nodes/PostoraTrigger/PostoraTrigger.node";

type WebhookRequest = {
  method: string;
  url: string;
  body?: unknown;
};

function createHookContext(overrides: {
  staticData?: Record<string, unknown>;
  webhookResponse?: unknown;
  callbackUrl?: string | undefined;
}) {
  const requests: WebhookRequest[] = [];
  const staticData = overrides.staticData ?? {};

  return {
    context: {
      getCredentials: async () => ({ baseUrl: "https://api.example.test" }),
      getNodeParameter: () => ["post.completed"],
      getNodeWebhookUrl: () => (
        "callbackUrl" in overrides ? overrides.callbackUrl : "https://n8n.example.test/webhook/postora"
      ),
      getWorkflowStaticData: () => staticData,
      helpers: {
        httpRequestWithAuthentication: function (_credentialName: string, request: WebhookRequest) {
          requests.push(request);
          return Promise.resolve(overrides.webhookResponse ?? { webhook: { id: "subscription-123" } });
        },
      },
    },
    requests,
    staticData,
  };
}

describe("Postora Trigger", () => {
  it("reports whether a subscription ID is saved in node static data", async () => {
    const existing = createHookContext({ staticData: { webhookId: "subscription-123" } });
    const absent = createHookContext({});
    const trigger = new PostoraTrigger();

    await expect(trigger.webhookMethods?.default?.checkExists.call(existing.context as any)).resolves.toBe(true);
    await expect(trigger.webhookMethods?.default?.checkExists.call(absent.context as any)).resolves.toBe(false);
  });

  it("registers the n8n callback URL and selected events using the Postora API contract", async () => {
    const { context, requests, staticData } = createHookContext({});
    const trigger = new PostoraTrigger();

    await expect(trigger.webhookMethods?.default?.create.call(context as any)).resolves.toBe(true);

    expect(requests).toEqual([
      {
        method: "POST",
        url: "https://api.example.test/api/v1/webhooks",
        body: {
          webhook_url: "https://n8n.example.test/webhook/postora",
          events: ["post.completed"],
        },
      },
    ]);
    expect(staticData.webhookId).toBe("subscription-123");
  });

  it("rejects registration when n8n does not provide a callback URL", async () => {
    const { context, requests } = createHookContext({ callbackUrl: undefined });
    const trigger = new PostoraTrigger();

    await expect(trigger.webhookMethods?.default?.create.call(context as any)).rejects.toThrow(
      /callback URL/i,
    );

    expect(requests).toEqual([]);
  });

  it("deletes the saved subscription and clears its static state", async () => {
    const { context, requests, staticData } = createHookContext({
      staticData: { webhookId: "subscription-123" },
    });
    const trigger = new PostoraTrigger();

    await expect(trigger.webhookMethods?.default?.delete.call(context as any)).resolves.toBe(true);

    expect(requests).toEqual([
      {
        method: "DELETE",
        url: "https://api.example.test/api/v1/webhooks/subscription-123",
      },
    ]);
    expect(staticData.webhookId).toBeUndefined();
  });

  it("returns an incoming request body as workflow data with an HTTP 200 response", async () => {
    const trigger = new PostoraTrigger();
    const body = { event: "post.completed", post: { id: "post-1" } };

    const response = await trigger.webhook?.call({ getBodyData: () => body } as any);

    expect(response).toEqual({
      workflowData: [[{ json: body }]],
      webhookResponse: { status: 200 },
    });
  });
});
