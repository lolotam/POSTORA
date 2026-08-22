"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PostoraTrigger = void 0;
const n8n_workflow_1 = require("n8n-workflow");
const webhookLifecycle_1 = require("../shared/webhookLifecycle");
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
                        {
                            name: "New Comment Received (All Platforms)",
                            value: "comment.received",
                        },
                        {
                            name: "Facebook Comment Received",
                            value: "comment.facebook",
                        },
                        {
                            name: "Instagram Comment Received",
                            value: "comment.instagram",
                        },
                        {
                            name: "Threads Reply / Mention Received",
                            value: "comment.threads",
                        },
                        {
                            name: "Threads Mention Created (legacy payload)",
                            value: "threads.mention.created",
                        },
                        {
                            name: "Threads Mention Replied (legacy payload)",
                            value: "threads.mention.replied",
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
                    // Without a callback URL every registration compares as mismatched, which would retire a
                    // perfectly good subscription and then fail in create() for the very same missing URL.
                    // Keep what is registered and let create() report the problem if it is ever reached.
                    if (!callbackUrl)
                        return true;
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
                        (0, webhookLifecycle_1.sameEventSet)(existing.events || [], events));
                    if (matches)
                        return true;
                    // Returning false makes n8n call create(), which registers a fresh id. Without
                    // retiring the superseded row first, every Events edit would leave another live
                    // subscription pointing at this same workflow and duplicate its executions.
                    if (existing) {
                        try {
                            await (0, webhookLifecycle_1.unregisterWebhook)(this, credentials.baseUrl, webhookId);
                        }
                        catch (error) {
                            // A surviving subscription is not inert: it keeps the same callback URL, and
                            // Postora's post-event fan-out does not deduplicate by URL, so any event kept
                            // across the edit would run this workflow twice. Refuse to re-register rather
                            // than leave two live subscriptions behind.
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
                    await (0, webhookLifecycle_1.unregisterWebhook)(this, credentials.baseUrl, webhookId);
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