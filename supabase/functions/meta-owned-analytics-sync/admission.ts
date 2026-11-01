import { AnalyticsWorkerDeadline } from "./deadline.ts";
import { verifyAdmissionPermission, type AdmissionApp } from "./permissionProvider.ts";
import { OwnedAnalyticsAdmissionStore, type OwnedAnalyticsPlatform } from "./store.ts";

export type AdmissionResult = { status: "complete" } | { status: "refused"; reason: string };

export async function admitOwnedAnalyticsAccount(input: {
  platform: OwnedAnalyticsPlatform; accountId: string; store: OwnedAnalyticsAdmissionStore;
  app: AdmissionApp; deadline: AnalyticsWorkerDeadline; fetch?: typeof fetch;
}): Promise<AdmissionResult> {
  const credential = await input.store.read(input.platform, input.accountId, null);
  const verified = await verifyAdmissionPermission({ platform: input.platform, credential, app: input.app,
    signal: input.deadline.signal, startedAt: input.deadline.startedAt, fetch: input.fetch,
    beforeRequest: async () => { await input.store.read(input.platform, credential.account_id, credential.authority); } });
  if (!verified.ok) return { status: "refused", reason: verified.reason };
  await input.store.observe(input.platform, credential, verified.scopes, verified.observedAt);
  const required = input.platform === "facebook" ? ["read_insights", "pages_read_engagement"] : ["threads_basic", "threads_manage_insights"];
  return required.every((scope) => verified.scopes.includes(scope)) ? { status: "complete" } : { status: "refused", reason: "permission_missing" };
}
