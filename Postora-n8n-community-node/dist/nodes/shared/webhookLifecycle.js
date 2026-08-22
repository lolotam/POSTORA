"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.sameEventSet = sameEventSet;
exports.isAlreadyGone = isAlreadyGone;
exports.unregisterWebhook = unregisterWebhook;
exports.listWebhooks = listWebhooks;
function sameEventSet(left, right) {
    if (left.length !== right.length)
        return false;
    const sortedRight = [...right].sort();
    return [...left].sort().every((event, index) => event === sortedRight[index]);
}
/**
 * A 404 means the subscription is already gone, which is the outcome the delete wanted. n8n
 * surfaces the upstream status differently depending on the HTTP helper, so several shapes
 * are checked rather than assuming one.
 */
function isAlreadyGone(error) {
    const candidate = error;
    return candidate?.statusCode === 404 ||
        candidate?.response?.status === 404 ||
        Number(candidate?.httpCode) === 404;
}
async function unregisterWebhook(context, baseUrl, webhookId) {
    await context.helpers.httpRequestWithAuthentication.call(context, "postoraApi", { method: "DELETE", url: `${baseUrl}/api/v1/webhooks/${webhookId}` });
}
async function listWebhooks(context, baseUrl) {
    return await context.helpers.httpRequestWithAuthentication.call(context, "postoraApi", { method: "GET", url: `${baseUrl}/api/v1/webhooks` });
}
//# sourceMappingURL=webhookLifecycle.js.map