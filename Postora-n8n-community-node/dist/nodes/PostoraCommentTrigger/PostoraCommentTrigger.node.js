"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PostoraCommentTrigger = void 0;
const n8n_workflow_1 = require("n8n-workflow");
const webhookLifecycle_1 = require("../shared/webhookLifecycle");
function readParams(context) {
    return {
        platform: context.getNodeParameter("platform") || "",
        socialAccountId: context.getNodeParameter("socialAccountId") || "",
        events: context.getNodeParameter("events"),
    };
}
function registrationBody(callbackUrl, params) {
    const body = { webhook_url: callbackUrl, events: params.events };
    if (params.platform)
        body.platform = params.platform;
    if (params.socialAccountId)
        body.social_account_id = params.socialAccountId;
    return body;
}
class PostoraCommentTrigger {
    constructor() {
        this.description = {
            displayName: "Postora Comment Trigger",
            name: "postoraCommentTrigger",
            icon: "fa:comments",
            group: ["trigger"],
            version: 1,
            description: "Starts a workflow when a new comment, reply or mention reaches a connected Facebook, Instagram or Threads account",
            defaults: { name: "Postora Comment Trigger" },
            inputs: [],
            outputs: [n8n_workflow_1.NodeConnectionTypes.Main],
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
        this.methods = {
            loadOptions: {
                async getCommentAccounts() {
                    const credentials = await this.getCredentials("postoraApi");
                    const baseUrl = credentials.baseUrl;
                    const platform = this.getCurrentNodeParameter("platform") || "";
                    const url = platform ? `${baseUrl}/api/v1/accounts?platform=${encodeURIComponent(platform)}` : `${baseUrl}/api/v1/accounts`;
                    const response = await this.helpers.httpRequestWithAuthentication.call(this, "postoraApi", { method: "GET", url, json: true });
                    const accounts = Array.isArray(response?.accounts) ? response.accounts : [];
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
        this.webhookMethods = {
            default: {
                async checkExists() {
                    const staticData = this.getWorkflowStaticData("node");
                    const webhookId = staticData.webhookId;
                    if (!webhookId)
                        return false;
                    const credentials = await this.getCredentials("postoraApi");
                    const params = readParams(this);
                    const callbackUrl = this.getNodeWebhookUrl("default");
                    if (!callbackUrl)
                        return true;
                    let listing;
                    try {
                        listing = await (0, webhookLifecycle_1.listWebhooks)(this, credentials.baseUrl);
                    }
                    catch {
                        return true;
                    }
                    const existing = (listing.webhooks || []).find((webhook) => webhook.id === webhookId);
                    const matches = Boolean(existing &&
                        existing.is_active !== false &&
                        existing.webhook_url === callbackUrl &&
                        (0, webhookLifecycle_1.sameEventSet)(existing.events || [], params.events) &&
                        (existing.platform || "") === params.platform &&
                        (existing.social_account_id || "") === params.socialAccountId);
                    if (matches)
                        return true;
                    if (existing) {
                        try {
                            await (0, webhookLifecycle_1.unregisterWebhook)(this, credentials.baseUrl, webhookId);
                        }
                        catch (error) {
                            if (!(0, webhookLifecycle_1.isAlreadyGone)(error)) {
                                throw new Error(`Postora could not retire the previous webhook subscription (${webhookId}), so re-registering would deliver some events twice. Resolve the Postora API error and activate again.`);
                            }
                        }
                    }
                    delete staticData.webhookId;
                    return false;
                },
                async create() {
                    const credentials = await this.getCredentials("postoraApi");
                    const callbackUrl = this.getNodeWebhookUrl("default");
                    if (!callbackUrl)
                        throw new Error("Postora webhook registration requires an n8n callback URL.");
                    const registration = await this.helpers.httpRequestWithAuthentication.call(this, "postoraApi", { method: "POST", url: `${credentials.baseUrl}/api/v1/webhooks`, body: registrationBody(callbackUrl, readParams(this)) });
                    this.getWorkflowStaticData("node").webhookId = registration.webhook.id;
                    return true;
                },
                async delete() {
                    const staticData = this.getWorkflowStaticData("node");
                    const webhookId = staticData.webhookId;
                    if (!webhookId)
                        return true;
                    const credentials = await this.getCredentials("postoraApi");
                    try {
                        await (0, webhookLifecycle_1.unregisterWebhook)(this, credentials.baseUrl, webhookId);
                    }
                    catch (error) {
                        if (!(0, webhookLifecycle_1.isAlreadyGone)(error))
                            throw error;
                    }
                    delete staticData.webhookId;
                    return true;
                },
            },
        };
    }
    async webhook() {
        return { workflowData: [[{ json: this.getBodyData() }]], webhookResponse: { status: 200 } };
    }
}
exports.PostoraCommentTrigger = PostoraCommentTrigger;
//# sourceMappingURL=PostoraCommentTrigger.node.js.map