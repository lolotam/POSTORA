import { AnalyticsWorkerDeadline } from "./deadline.ts";
import { verifyAdmissionPermission, OWNED_ANALYTICS_REQUIRED_SCOPES, type AdmissionApp } from "./permissionProvider.ts";
import { OwnedAnalyticsStore, type OwnedAnalyticsPlatform } from "./store.ts";

export type AdmissionResult = { status: "complete" } | { status: "refused"; reason: string };

export async function admitOwnedAnalyticsAccount(input: {
  platform: OwnedAnalyticsPlatform; accountId: string; store: OwnedAnalyticsStore;
  app: AdmissionApp; deadline: AnalyticsWorkerDeadline; fetch?: typeof fetch;
}): Promise<AdmissionResult> {
  const credential = await input.store.read(input.platform, input.accountId, null);
  const verified = await verifyAdmissionPermission({ platform: input.platform, credential, app: input.app,
    signal: input.deadline.signal, startedAt: input.deadline.startedAt, fetch: input.fetch,
    beforeRequest: async () => { await input.store.read(input.platform, credential.account_id, credential.authority); } });
  if (!verified.ok) return { status: "refused", reason: verified.reason };
  await input.store.observe(input.platform, credential, verified.scopes, verified.observedAt);
  const required = OWNED_ANALYTICS_REQUIRED_SCOPES[input.platform];
  return required.every((scope) => verified.scopes.includes(scope)) ? { status: "complete" } : { status: "refused", reason: "permission_missing" };
}
