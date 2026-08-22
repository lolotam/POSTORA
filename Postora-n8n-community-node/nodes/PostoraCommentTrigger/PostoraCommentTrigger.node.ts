import {
  IAllExecuteFunctions,
  IHookFunctions,
  ILoadOptionsFunctions,
  INodePropertyOptions,
  INodeType,
  INodeTypeDescription,
  IWebhookFunctions,
  IWebhookResponseData,
  NodeConnectionTypes,
} from "n8n-workflow";
import {
  isAlreadyGone,
  listWebhooks,
  sameEventSet,
  unregisterWebhook,
  WebhookListing,
  WebhookRegistration,
} from "../shared/webhookLifecycle";

type CommentTriggerParams = { platform: string; socialAccountId: string; events: string[] };

function readParams(context: IHookFunctions): CommentTriggerParams {
  return {
    platform: (context.getNodeParameter("platform") as string) || "",
    socialAccountId: (context.getNodeParameter("socialAccountId") as string) || "",
    events: context.getNodeParameter("events") as string[],
  };
}

function registrationBody(callbackUrl: string, params: CommentTriggerParams): Record<string, unknown> {
  const body: Record<string, unknown> = { webhook_url: callbackUrl, events: params.events };
  if (params.platform) body.platform = params.platform;
  if (params.socialAccountId) body.social_account_id = params.socialAccountId;
  return body;
}

export class PostoraCommentTrigger implements INodeType {
  description: INodeTypeDescription = {
    displayName: "Postora Comment Trigger",
    name: "postoraCommentTrigger",
    icon: "fa:comments",
    group: ["trigger"],
    version: 1,
    description: "Starts a workflow when a new comment, reply or mention reaches a connected Facebook, Instagram or Threads account",
    defaults: { name: "Postora Comment Trigger" },
    inputs: [],
    outputs: [NodeConnectionTypes.Main],
    credentials: [{ name: "postoraApi", required: true }],
    webhooks: [{ name: "default", httpMethod: "POST", path: "postora-comment" }],
    properties: [
      {
        displayName: "Platform",
        name: "platform",
        type: "options",
        options: [
          { name: "All", value: "" },
          { name: "Facebook", value: "facebook" },
          { name: "Instagram", value: "instagram" },
          { name: "Threads", value: "threads" },
        ],
        default: "",
      },
      {
        displayName: "Account",
        name: "socialAccountId",
        type: "options",
        typeOptions: { loadOptionsMethod: "getCommentAccounts", loadOptionsDependsOn: ["platform"] },
        default: "",
        description: "Only comments on this account trigger the workflow. The account's Comments automation handler must be set to n8n in Postora (Messaging → Auto Replies → Automation), otherwise no events are sent.",
      },
      {
        displayName: "Events",
        name: "events",
        type: "multiOptions",
        options: [
          { name: "New Comment Received", value: "comment.received", description: "Facebook/Instagram comments and replies, Threads replies and mentions (see comment.kind)" },
          { name: "Threads Mention Created (legacy payload)", value: "threads.mention.created" },
          { name: "Threads Mention Replied (legacy payload)", value: "threads.mention.replied" },
        ],
        default: ["comment.received"],
      },
    ],
  };

  methods = {
    loadOptions: {
      async getCommentAccounts(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
        const credentials = await this.getCredentials("postoraApi");
        const baseUrl = credentials.baseUrl as string;
        const platform = (this.getCurrentNodeParameter("platform") as string) || "";
        const url = platform ? `${baseUrl}/api/v1/accounts?platform=${encodeURIComponent(platform)}` : `${baseUrl}/api/v1/accounts`;
        const response = await this.helpers.httpRequestWithAuthentication.call(
          this as unknown as IAllExecuteFunctions,
          "postoraApi",
          { method: "GET", url, json: true },
        );
        const accounts: Array<{ id: string; platform: string; platform_username?: string | null; name?: string | null }> =
          Array.isArray(response?.accounts) ? response.accounts : [];
        return [
          { name: "All accounts", value: "" },
          ...accounts
            .filter((account) => ["facebook", "instagram", "threads"].includes(account.platform))
            .map((account) => ({
              name: `${account.platform_username || account.name || account.id} (${account.platform})`,
              value: account.id,
            })),
        ];
      },
    },
  };

  webhookMethods = {
    default: {
      async checkExists(this: IHookFunctions): Promise<boolean> {
        const staticData = this.getWorkflowStaticData("node");
        const webhookId = staticData.webhookId as string | undefined;
        if (!webhookId) return false;

        const credentials = await this.getCredentials<{ baseUrl: string }>("postoraApi");
        const params = readParams(this);
        const callbackUrl = this.getNodeWebhookUrl("default");
        if (!callbackUrl) return true;

        let listing: WebhookListing;
        try {
          listing = await listWebhooks(this, credentials.baseUrl);
        } catch {
          return true;
        }

        const existing = (listing.webhooks || []).find((webhook) => webhook.id === webhookId);
        const matches = Boolean(
          existing &&
          existing.is_active !== false &&
          existing.webhook_url === callbackUrl &&
          sameEventSet(existing.events || [], params.events) &&
          (existing.platform || "") === params.platform &&
          (existing.social_account_id || "") === params.socialAccountId,
        );
        if (matches) return true;

        if (existing) {
          try {
            await unregisterWebhook(this, credentials.baseUrl, webhookId);
          } catch (error) {
            if (!isAlreadyGone(error)) {
              throw new Error(
                `Postora could not retire the previous webhook subscription (${webhookId}), so re-registering would deliver some events twice. Resolve the Postora API error and activate again.`,
              );
            }
          }
        }
        delete staticData.webhookId;
        return false;
      },
      async create(this: IHookFunctions): Promise<boolean> {
        const credentials = await this.getCredentials<{ baseUrl: string }>("postoraApi");
        const callbackUrl = this.getNodeWebhookUrl("default");
        if (!callbackUrl) throw new Error("Postora webhook registration requires an n8n callback URL.");
        const registration = await this.helpers.httpRequestWithAuthentication.call(
          this as unknown as IAllExecuteFunctions,
          "postoraApi",
          { method: "POST", url: `${credentials.baseUrl}/api/v1/webhooks`, body: registrationBody(callbackUrl, readParams(this)) },
        ) as WebhookRegistration;
        this.getWorkflowStaticData("node").webhookId = registration.webhook.id;
        return true;
      },
      async delete(this: IHookFunctions): Promise<boolean> {
        const staticData = this.getWorkflowStaticData("node");
        const webhookId = staticData.webhookId as string | undefined;
        if (!webhookId) return true;
        const credentials = await this.getCredentials<{ baseUrl: string }>("postoraApi");
        try {
          await unregisterWebhook(this, credentials.baseUrl, webhookId);
        } catch (error) {
          if (!isAlreadyGone(error)) throw error;
        }
        delete staticData.webhookId;
        return true;
      },
    },
  };

  async webhook(this: IWebhookFunctions): Promise<IWebhookResponseData> {
    return { workflowData: [[{ json: this.getBodyData() }]], webhookResponse: { status: 200 } };
  }
}
