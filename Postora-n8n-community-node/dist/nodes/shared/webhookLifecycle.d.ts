import { IHookFunctions } from "n8n-workflow";
export type WebhookRegistration = {
    webhook: {
        id: string;
    };
};
export type RegisteredWebhook = {
    id?: string;
    webhook_url?: string;
    events?: string[];
    is_active?: boolean;
    platform?: string | null;
    social_account_id?: string | null;
};
export type WebhookListing = {
    webhooks?: RegisteredWebhook[];
};
export declare function sameEventSet(left: string[], right: string[]): boolean;
/**
 * A 404 means the subscription is already gone, which is the outcome the delete wanted. n8n
 * surfaces the upstream status differently depending on the HTTP helper, so several shapes
 * are checked rather than assuming one.
 */
export declare function isAlreadyGone(error: unknown): boolean;
export declare function unregisterWebhook(context: IHookFunctions, baseUrl: string, webhookId: string): Promise<void>;
export declare function listWebhooks(context: IHookFunctions, baseUrl: string): Promise<WebhookListing>;
