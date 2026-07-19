"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PostoraTrigger = void 0;
const n8n_workflow_1 = require("n8n-workflow");
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
                    ],
                    default: ["post.completed"],
                },
            ],
        };
        this.webhookMethods = {
            default: {
                async checkExists() {
                    return Boolean(this.getWorkflowStaticData("node").webhookId);
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
                    await this.helpers.httpRequestWithAuthentication.call(this, "postoraApi", {
                        method: "DELETE",
                        url: `${credentials.baseUrl}/api/v1/webhooks/${webhookId}`,
                    });
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