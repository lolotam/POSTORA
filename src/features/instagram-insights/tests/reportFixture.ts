import { assembleOwnerReport } from "../../../../supabase/functions/instagram-insights-report/assemble";
import type {
  MediaSnapshotRow,
  OwnerReportAssemblyInput,
} from "../../../../supabase/functions/instagram-insights-report/contracts";

const NOW = "2026-10-29T00:00:00.000Z";

export function mediaFixture(overrides: Partial<MediaSnapshotRow> = {}): MediaSnapshotRow {
  return {
    id: "snapshot-media-999",
    ownerId: "test-user-id",
    socialAccountId: "acc-123",
    mediaId: "media-999",
    publishedAt: "2026-10-26T12:00:00.000Z",
    capturedAt: NOW,
    capturedOn: "2026-10-29",
    captureTimezone: "UTC",
    mediaProductType: "REELS",
    mediaType: "VIDEO",
    permalink: "https://www.instagram.com/p/test-media/",
    status: "ok",
    views: 12500,
    reach: 8400,
    likes: 620,
    comments: 85,
    saved: 90,
    shares: 45,
    totalInteractions: 840,
    ...overrides,
  };
}

// Frontend tests consume the real server assembler's DTO, so a hand-built older
// response shape cannot make a broken UI contract appear healthy.
export function reportFixture(overrides: Partial<OwnerReportAssemblyInput> = {}) {
  const display = mediaFixture();
  const history = Array.from({ length: 8 }, (_, index) => mediaFixture({
    id: `baseline-snapshot-${index}`,
    mediaId: `baseline-${index}`,
    publishedAt: "2026-09-15T12:00:00.000Z",
    views: 5000,
  }));
  return assembleOwnerReport({
    scope: { ownerId: "test-user-id", socialAccountId: "acc-123", platform: "instagram" },
    now: new Date(NOW),
    request: { periodDays: 30, limit: 20, cursor: null },
    mediaSnapshots: [display],
    baselineHistory: [display, ...history],
    accountDaily: [
      { id: "daily-1", metricDate: "2026-10-27", providerDate: "2026-10-27", capturedAt: NOW, status: "ok", reach: 1200, views: 3500, totalInteractions: 380 },
      { id: "daily-2", metricDate: "2026-10-28", providerDate: "2026-10-28", capturedAt: NOW, status: "ok", reach: 1800, views: 4900, totalInteractions: 520 },
    ],
    profileObservations: [{
      id: "profile-1", observedAt: NOW, observedOn: "2026-10-29", captureTimezone: "UTC",
      status: "ok", followersCount: 14200, mediaCount: 156,
    }],
    freshness: {
      status: "ok", lastAttemptAt: NOW, lastSuccessAt: NOW, lastPartialAt: null,
      partial: false, truncated: false, retryAt: null, reason: "ok",
    },
    completeness: {
      baselineHistoryComplete: true, inventoryTruncated: false, coverage: "complete",
      oldestMediaPublishedAt: history[0].publishedAt, newestMediaPublishedAt: display.publishedAt,
    },
    ...overrides,
  });
}
