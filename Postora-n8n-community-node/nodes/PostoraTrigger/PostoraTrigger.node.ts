import {
  IAllExecuteFunctions,
  IHookFunctions,
  INodeType,
  INodeTypeDescription,
  IWebhookFunctions,
  IWebhookResponseData,
  NodeConnectionTypes,
} from "n8n-workflow";

type WebhookRegistration = {
  webhook: {
    id: string;
  };
};

export class PostoraTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Postora Trigger",
    name: "postoraTrigger",
    icon: "fa:bolt",
    group: ["trigger"],
    version: 1,
    description: "Starts a workflow when Postora sends an event",
    defaults: {
      name: "Postora Trigger",
    },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [
      {
        name: "postoraApi",
        required: true,
      },
    ],
    webhooks: [
      {
        name: "default",
        httpMethod: "POST",
        path: "postora",
      },
    ],
    properties: [
      {
        displayName: "Events",
        name: "events",
        type: "multiOptions",
        options: [
          {
            name: "Post Completed",
            value: "post.completed",
          },
        ],
        default: ["post.completed"],
      },
    ],
  };

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        return Boolean(this.getWorkflowStaticData("node").webhookId);
      },
      async create(this: IHookFunctions): Promise<boolean> {
        const credentials = await this.getCredentials<{ baseUrl: string }>("postoraApi");
        const events = this.getNodeParameter("events") as string[];
        const callbackUrl = this.getNodeWebhookUrl("default");
        if (!callbackUrl) {
          throw new Error("Postora webhook registration requires an n8n callback URL.");
        }
        const registration = await this.helpers.httpRequestWithAuthentication.call(
          this as unknown as IAllExecuteFunctions,
          "postoraApi",
          {
            method: "POST",
            url: `${credentials.baseUrl}/api/v1/webhooks`,
            body: { webhook_url: callbackUrl, events },
          },
        ) as WebhookRegistration;

        this.getWorkflowStaticData("node").webhookId = registration.webhook.id;
        return true;
      },
      async delete(this: IHookFunctions): Promise<boolean> {
        const staticData = this.getWorkflowStaticData("node");
        const webhookId = staticData.webhookId as string | undefined;
        if (!webhookId) return true;

        const credentials = await this.getCredentials<{ baseUrl: string }>("postoraApi");
        await this.helpers.httpRequestWithAuthentication.call(
          this as unknown as IAllExecuteFunctions,
          "postoraApi",
          {
            method: "DELETE",
            url: `${credentials.baseUrl}/api/v1/webhooks/${webhookId}`,
          },
        );
        delete staticData.webhookId;
        return true;
      },
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    return {
      workflowData: [[{ json: this.getBodyData() }]],
      webhookResponse: { status: 200 },
    };
  }
}
