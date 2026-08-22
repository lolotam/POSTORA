import { IAllExecuteFunctions, IHookFunctions } from "n8n-workflow";

export type WebhookRegistration = { webhook: { id: string } };

export type RegisteredWebhook = {
  id?: string;
  webhook_url?: string;
  events?: string[];
  is_active?: boolean;
  platform?: string | null;
  social_account_id?: string | null;
};

export type WebhookListing = { webhooks?: RegisteredWebhook[] };

export function sameEventSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  const sortedRight = [...right].sort();
  return [...left].sort().every((event, index) => event === sortedRight[index]);
}

/**
 * A 404 means the subscription is already gone, which is the outcome the delete wanted. n8n
 * surfaces the upstream status differently depending on the HTTP helper, so several shapes
 * are checked rather than assuming one.
 */
export function isAlreadyGone(error: unknown): boolean {
  const candidate = error as { statusCode?: number; httpCode?: number | string; response?: { status?: number } };
  return candidate?.statusCode === 404 ||
    candidate?.response?.status === 404 ||
    Number(candidate?.httpCode) === 404;
}

export async function unregisterWebhook(context: IHookFunctions, baseUrl: string, webhookId: string): Promise<void> {
  await context.helpers.httpRequestWithAuthentication.call(
    context as unknown as IAllExecuteFunctions,
    "postoraApi",
    { method: "DELETE", url: `${baseUrl}/api/v1/webhooks/${webhookId}` },
  );
}

export async function listWebhooks(context: IHookFunctions, baseUrl: string): Promise<WebhookListing> {
  return await context.helpers.httpRequestWithAuthentication.call(
    context as unknown as IAllExecuteFunctions,
    "postoraApi",
    { method: "GET", url: `${baseUrl}/api/v1/webhooks` },
  ) as WebhookListing;
}
