import { PostoraTrigger } from "../nodes/PostoraTrigger/PostoraTrigger.node";

type WebhookRequest = {
  method: string;
  url: string;
  body?: unknown;
};

type RegisteredWebhook = { id?: string; webhook_url?: string; events?: string[]; is_active?: boolean };

const CALLBACK_URL = "https://n8n.example.test/webhook/postora";

function createHookContext(overrides: {
  staticData?: Record<string, unknown>;
  webhookResponse?: unknown;
  callbackUrl?: string | undefined;
  events?: string[];
  listing?: RegisteredWebhook[];
  listingError?: Error;
}) {
  const requests: WebhookRequest[] = [];
  const staticData = overrides.staticData ?? {};

  return {
    context: {
      getCredentials: async () => ({ baseUrl: "https://api.example.test" }),
      getNodeParameter: () => overrides.events ?? ["post.completed"],
      getNodeWebhookUrl: () => (
        "callbackUrl" in overrides ? overrides.callbackUrl : CALLBACK_URL
      ),
      getWorkflowStaticData: () => staticData,
      helpers: {
        httpRequestWithAuthentication: function (_credentialName: string, request: WebhookRequest) {
          requests.push(request);
          if (request.method === "GET") {
            if (overrides.listingError) return Promise.reject(overrides.listingError);
            return Promise.resolve({ webhooks: overrides.listing ?? [] });
          }
          return Promise.resolve(overrides.webhookResponse ?? { webhook: { id: "subscription-123" } });
        },
      },
    },
    requests,
    staticData,
  };
}

describe("Postora Trigger", () => {
  it("offers the four messaging trigger events alongside post.completed", () => {
    const trigger = new PostoraTrigger();
    const events = (trigger.description.properties?.find((property) => property.name === "events") as any).options;

    expect(events.map((event: { value: string }) => event.value)).toEqual([
      "post.completed",
      "message.received",
      "message.whatsapp",
      "message.instagram",
      "message.facebook",
    ]);
  });

  it("treats an unregistered node as having no subscription without calling Postora", async () => {
    const { context, requests } = createHookContext({});
    const trigger = new PostoraTrigger();

    await expect(trigger.webhookMethods?.default?.checkExists.call(context as any)).resolves.toBe(false);
    expect(requests).toEqual([]);
  });

  it("keeps a subscription whose URL and events still match the node", async () => {
    const { context, staticData } = createHookContext({
      staticData: { webhookId: "subscription-123" },
      events: ["message.received", "message.instagram"],
      // Order differs from the node's selection on purpose: the subscription is the same.
      listing: [{
        id: "subscription-123",
        webhook_url: CALLBACK_URL,
        events: ["message.instagram", "message.received"],
        is_active: true,
      }],
    });
    const trigger = new PostoraTrigger();

    await expect(trigger.webhookMethods?.default?.checkExists.call(context as any)).resolves.toBe(true);
    expect(staticData.webhookId).toBe("subscription-123");
  });

  it("retires and re-registers a subscription whose events no longer match the node", async () => {
    const { context, requests, staticData } = createHookContext({
      staticData: { webhookId: "subscription-123" },
      events: ["message.received", "message.instagram"],
      listing: [{
        id: "subscription-123",
        webhook_url: CALLBACK_URL,
        events: ["message.whatsapp"],
        is_active: true,
      }],
    });
    const trigger = new PostoraTrigger();

    await expect(trigger.webhookMethods?.default?.checkExists.call(context as any)).resolves.toBe(false);
    expect(requests).toEqual([
      { method: "GET", url: "https://api.example.test/api/v1/webhooks" },
      { method: "DELETE", url: "https://api.example.test/api/v1/webhooks/subscription-123" },
    ]);
    expect(staticData.webhookId).toBeUndefined();
  });

  it("re-registers when the subscription is gone from Postora, without a delete call", async () => {
    const { context, requests, staticData } = createHookContext({
      staticData: { webhookId: "subscription-123" },
      listing: [],
    });
    const trigger = new PostoraTrigger();

    await expect(trigger.webhookMethods?.default?.checkExists.call(context as any)).resolves.toBe(false);
    expect(requests.map((request) => request.method)).toEqual(["GET"]);
    expect(staticData.webhookId).toBeUndefined();
  });

  it.each([
    ["points at a different callback URL", { webhook_url: "https://n8n.example.test/webhook/stale" }],
    ["was deactivated by Postora after repeated delivery failures", { is_active: false }],
  ])("re-registers a subscription that %s", async (_reason, divergence) => {
    const { context } = createHookContext({
      staticData: { webhookId: "subscription-123" },
      listing: [{
        id: "subscription-123",
        webhook_url: CALLBACK_URL,
        events: ["post.completed"],
        is_active: true,
        ...divergence,
      }],
    });
    const trigger = new PostoraTrigger();

    await expect(trigger.webhookMethods?.default?.checkExists.call(context as any)).resolves.toBe(false);
  });

  it("keeps the saved subscription when Postora is unreachable", async () => {
    const { context, staticData } = createHookContext({
      staticData: { webhookId: "subscription-123" },
      listingError: new Error("ECONNREFUSED"),
    });
    const trigger = new PostoraTrigger();

    await expect(trigger.webhookMethods?.default?.checkExists.call(context as any)).resolves.toBe(true);
    expect(staticData.webhookId).toBe("subscription-123");
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
