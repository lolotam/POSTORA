import { parseMetaUsagePercent } from "../_shared/metaUsage.ts";
import { CollectionProviderRefused, CollectionVisitPaused } from "./collectionProvider.ts";
import type { AnalyticsWorkerDeadline } from "./deadline.ts";
import { AnalyticsWorkerStopped } from "./deadline.ts";
import { OwnedAnalyticsStore, type AnalyticsClaim } from "./store.ts";

export async function collectionBucketKey(job: AnalyticsClaim, appId: string): Promise<string> {
  // App usage survives account and credential rotation. Conservatively share
  // business usage/backoff in this bucket too, rather than bypass an app limit.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`owned_analytics:app:${job.platform}:${appId}`));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class CollectionThrottle {
  constructor(private readonly store: OwnedAnalyticsStore, private readonly bucket: string, private readonly deadline: AnalyticsWorkerDeadline) {}

  async beforeRequest(): Promise<void> {
    if (this.deadline.remainingMs < 25_000) throw new CollectionVisitPaused();
    const current = await this.store.throttle(this.bucket);
    if (current?.throttled_until && Date.parse(current.throttled_until) > Date.now()) {
      throw new CollectionProviderRefused("rate_limited", current.throttled_until);
    }
  }

  async afterResponse(status: number, headers: Headers): Promise<void> {
    const usage = Math.ceil(parseMetaUsagePercent(headers));
    if (!usage && status !== 429) return;
    const rawRetry = headers.get("retry-after");
    const retry = rawRetry && /^\d{1,7}$/.test(rawRetry) ? Date.now() + Number(rawRetry) * 1000 : Date.parse(rawRetry ?? "");
    const requested = Number.isFinite(retry) && retry > Date.now() ? retry : Date.now() + 15 * 60_000;
    // A provider-supplied instant is untrusted: never park the shared app bucket beyond one day.
    const until = status === 429 || usage >= 80 ? new Date(Math.min(requested, Date.now() + 86_000_000)).toISOString() : null;
    await this.store.recordThrottle(this.bucket, usage, until);
  }

  async refuse(retryAt: string | null): Promise<string> {
    await this.store.recordThrottle(this.bucket, 0, retryAt ?? new Date(Date.now() + 15 * 60_000).toISOString());
    const current = await this.store.throttle(this.bucket);
    if (!current?.throttled_until) throw new AnalyticsWorkerStopped("invalid_contract");
    return current.throttled_until;
  }
}
