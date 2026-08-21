"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PostoraTrigger = void 0;
const n8n_workflow_1 = require("n8n-workflow");
function sameEventSet(left, right) {
    if (left.length !== right.length)
        return false;
    const sortedRight = [...right].sort();
    return [...left].sort().every((event, index) => event === sortedRight[index]);
}
async function unregisterWebhook(context, baseUrl, webhookId) {
    await context.helpers.httpRequestWithAuthentication.call(context, "postoraApi", { method: "DELETE", url: `${baseUrl}/api/v1/webhooks/${webhookId}` });
}
class PostoraTrigger {
    constructor() {
        this.description = {
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
            outputs: [n8n_workflow_1.NodeConnectionTypes.Main],
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
                        {
                            name: "New Message Received (All Platforms)",
                            value: "message.received",
                        },
                        {
                            name: "WhatsApp Message Received",
                            value: "message.whatsapp",
                        },
                        {
                            name: "Instagram DM Received",
                            value: "message.instagram",
                        },
                        {
                            name: "Facebook Message Received",
                            value: "message.facebook",
                        },
                    ],
                    default: ["post.completed"],
                },
            ],
        };
        this.webhookMethods = {
            default: {
                // Answered from the server rather than from static data. A cached id alone says
                // nothing about what Postora is actually subscribed to, so editing the Events
                // selection used to leave the original subscription in place forever and the
                // workflow silently received the wrong events.
                async checkExists() {
                    const staticData = this.getWorkflowStaticData("node");
                    const webhookId = staticData.webhookId;
                    if (!webhookId)
                        return false;
                    const credentials = await this.getCredentials("postoraApi");
                    const events = this.getNodeParameter("events");
                    const callbackUrl = this.getNodeWebhookUrl("default");
                    let listing;
                    try {
                        listing = await this.helpers.httpRequestWithAuthentication.call(this, "postoraApi", { method: "GET", url: `${credentials.baseUrl}/api/v1/webhooks` });
                    }
                    catch {
                        // Postora being unreachable is not evidence the registration is gone, and
                        // re-registering on every transient error would pile up duplicates.
                        return true;
                    }
                    const existing = (listing.webhooks || []).find((webhook) => webhook.id === webhookId);
                    const matches = Boolean(existing &&
                        existing.is_active !== false &&
                        existing.webhook_url === callbackUrl &&
                        sameEventSet(existing.events || [], events));
                    if (matches)
                        return true;
                    // Returning false makes n8n call create(), which registers a fresh id. Without
                    // retiring the superseded row first, every Events edit would leave another live
                    // subscription pointing at this same workflow and duplicate its executions.
                    if (existing) {
                        try {
                            await unregisterWebhook(this, credentials.baseUrl, webhookId);
                        }
                        catch {
                            // A failed cleanup must not block re-registration; the stale row stops
                            // matching this workflow's parameters and is inert apart from its own delivery.
                        }
                    }
                    delete staticData.webhookId;
                    return false;
                },
                async create() {
                    const credentials = await this.getCredentials("postoraApi");
                    const events = this.getNodeParameter("events");
                    const callbackUrl = this.getNodeWebhookUrl("default");
                    if (!callbackUrl) {
                        throw new Error("Postora webhook registration requires an n8n callback URL.");
                    }
                    const registration = await this.helpers.httpRequestWithAuthentication.call(this, "postoraApi", {
                        method: "POST",
                        url: `${credentials.baseUrl}/api/v1/webhooks`,
                        body: { webhook_url: callbackUrl, events },
                    });
                    this.getWorkflowStaticData("node").webhookId = registration.webhook.id;
                    return true;
                },
                async delete() {
                    const staticData = this.getWorkflowStaticData("node");
                    const webhookId = staticData.webhookId;
                    if (!webhookId)
                        return true;
                    const credentials = await this.getCredentials("postoraApi");
                    await unregisterWebhook(this, credentials.baseUrl, webhookId);
                    delete staticData.webhookId;
                    return true;
                },
            },
        };
    }
    async webhook() {
        return {
            workflowData: [[{ json: this.getBodyData() }]],
            webhookResponse: { status: 200 },
        };
    }
}
exports.PostoraTrigger = PostoraTrigger;
//# sourceMappingURL=PostoraTrigger.node.js.map