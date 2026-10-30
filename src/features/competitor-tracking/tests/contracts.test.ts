import { describe, expect, it } from "vitest";

import {
  COMPETITOR_REPORT_SCHEMA_VERSION,
  CompetitorReportContractError,
  parseCompetitorReport,
} from "../domain/contracts";

/**
 * The fixtures below are the REAL envelope shapes of
 * `competitor-tracking-report` (spec §5, DTO v1). They are written by
 * hand from the frozen contract, not invented for the test: the field
 * names, the nullability and the version are the wire's.
 */

const WATCHLIST_ID = "3f2b6c1e-9a44-4f0a-8b21-7c5d9e0a1b23";

const QUOTA = {
  max_tracked_competitors: 5,
  unlimited: false,
  tracked_active: 2,
  remaining: 3,
};

const ENTRY = {
  watchlist_id: WATCHLIST_ID,
  username: "northwind",
  label: "Northwind",
  is_active: true,
  removed_at: null,
  status: "ok",
  last_error_code: null,
  next_retry_at: null,
  cleanup_eligible_at: null,
  profile: {
    followers_count: 18234,
    media_count: 412,
    captured_at: "2026-10-29T04:00:00+00:00",
    captured_on: "2026-10-29",
    source: "official",
  },
  freshness: {
    last_capture_at: "2026-10-29T04:00:00+00:00",
    last_full_success_at: "2026-10-29T04:00:00+00:00",
    last_partial_at: null,
    job_status: "completed",
    reason_code: null,
  },
  growth_7d: {
    absolute: 120,
    percent: 0.66,
    baseline_at: "2026-10-22T04:00:00+00:00",
    observed_at: "2026-10-29T04:00:00+00:00",
    interval_days: 7,
    reason: null,
  },
  growth_30d: {
    absolute: null,
    percent: null,
    baseline_at: null,
    observed_at: "2026-10-29T04:00:00+00:00",
    interval_days: null,
    reason: "missing_baseline",
  },
  weekly: {
    observed_count: 3,
    posts_per_week: null,
    interval_start: "2026-10-23T04:00:00+00:00",
    interval_end: "2026-10-29T04:00:00+00:00",
    coverage: "partial",
    reason: "ordering_unverified",
  },
};

const MEDIA = {
  ig_media_id: "3123",
  published_at: "2026-10-28T10:00:00+00:00",
  captured_at: "2026-10-29T04:00:00+00:00",
  media_product_type: "FEED",
  media_type: "IMAGE",
  thumbnail_url: "https://cdn.example.com/a.jpg",
  permalink: "https://www.instagram.com/p/abc/",
  caption: "a plain caption",
  like_count: 120,
  comments_count: 4,
  view_count: null,
  source: "official",
  outlier: {
    id: "3123",
    score: 1.8,
    label: "above",
    baselineMedian: 60,
    baselineSize: 9,
    metric_basis: "public_interactions",
    source: "official",
    reason: null,
  },
};

function listEnvelope(): Record<string, unknown> {
  return {
    version: COMPETITOR_REPORT_SCHEMA_VERSION,
    as_of: "2026-10-30T09:15:00+00:00",
    capture_timezone: "Asia/Kuwait",
    quota: QUOTA,
    next_cursor: null,
    entries: [structuredClone(ENTRY)],
  };
}

function detailEnvelope(): Record<string, unknown> {
  return {
    version: COMPETITOR_REPORT_SCHEMA_VERSION,
    as_of: "2026-10-30T09:15:00+00:00",
    capture_timezone: "Asia/Kuwait",
    quota: QUOTA,
    next_cursor: "opaque-cursor",
    entry: structuredClone(ENTRY),
    media: [structuredClone(MEDIA)],
  };
}

describe("competitor tracking report contract", () => {
  describe("the happy path", () => {
    it("reads a list envelope", () => {
      const report = parseCompetitorReport(listEnvelope());

      expect("entries" in report).toBe(true);
      if (!("entries" in report)) return;

      expect(report.version).toBe(1);
      expect(report.as_of).toBe("2026-10-30T09:15:00+00:00");
      expect(report.capture_timezone).toBe("Asia/Kuwait");
      expect(report.quota).toEqual(QUOTA);
      expect(report.next_cursor).toBeNull();
      expect(report.entries).toHaveLength(1);
      expect(report.entries[0]?.username).toBe("northwind");
      expect(report.entries[0]?.growth_7d.absolute).toBe(120);
      expect(report.entries[0]?.weekly.coverage).toBe("partial");
    });

    it("reads a detail envelope with its media", () => {
      const report = parseCompetitorReport(detailEnvelope());

      expect("media" in report).toBe(true);
      if (!("media" in report)) return;

      expect(report.next_cursor).toBe("opaque-cursor");
      expect(report.entry?.watchlist_id).toBe(WATCHLIST_ID);
      expect(report.media).toHaveLength(1);
      expect(report.media[0]?.outlier.label).toBe("above");
      expect(report.media[0]?.outlier.baselineSize).toBe(9);
      expect(report.media[0]?.view_count).toBeNull();
    });

    it("keeps a null measurement null instead of zero", () => {
      const report = parseCompetitorReport(listEnvelope());
      if (!("entries" in report)) throw new Error("expected a list report");

      const entry = report.entries[0];
      expect(entry?.growth_30d.absolute).toBeNull();
      expect(entry?.growth_30d.percent).toBeNull();
      expect(entry?.growth_30d.reason).toBe("missing_baseline");
      expect(entry?.weekly.posts_per_week).toBeNull();
      expect(entry?.freshness.last_partial_at).toBeNull();
      expect(entry?.profile?.followers_count).toBe(18234);
    });
  });

  describe("the refusals", () => {
    it("refuses an unknown envelope version", () => {
      const envelope = { ...listEnvelope(), version: 2 };

      expect(() => parseCompetitorReport(envelope)).toThrow(CompetitorReportContractError);
      try {
        parseCompetitorReport(envelope);
      } catch (error) {
        expect((error as CompetitorReportContractError).code).toBe("REPORT_UNAVAILABLE");
      }
    });

    it("refuses a missing field", () => {
      const envelope = listEnvelope();
      delete (envelope.entries as Array<Record<string, unknown>>)[0]?.growth_7d;

      expect(() => parseCompetitorReport(envelope)).toThrow(CompetitorReportContractError);
    });

    it("refuses a missing nullable key, because the key itself is part of the contract", () => {
      const envelope = listEnvelope();
      const entry = (envelope.entries as Array<Record<string, unknown>>)[0];
      delete entry?.freshness;

      expect(() => parseCompetitorReport(envelope)).toThrow(CompetitorReportContractError);
    });

    it("refuses a missing nullable string key", () => {
      const envelope = listEnvelope();
      const entry = (envelope.entries as Array<Record<string, unknown>>)[0];
      delete entry?.label;

      expect(() => parseCompetitorReport(envelope)).toThrow(CompetitorReportContractError);
    });

    it("refuses a missing nullable count key", () => {
      const envelope = listEnvelope();
      const entry = (envelope.entries as Array<Record<string, unknown>>)[0];
      const profile = entry?.profile as Record<string, unknown>;
      delete profile.followers_count;

      expect(() => parseCompetitorReport(envelope)).toThrow(CompetitorReportContractError);
    });

    it("refuses a missing nullable instant key", () => {
      const envelope = listEnvelope();
      const entry = (envelope.entries as Array<Record<string, unknown>>)[0];
      delete entry?.removed_at;

      expect(() => parseCompetitorReport(envelope)).toThrow(CompetitorReportContractError);
    });

    it("refuses an unsafe count", () => {
      const envelope = listEnvelope();
      const entry = (envelope.entries as Array<Record<string, unknown>>)[0];
      const profile = entry?.profile as Record<string, unknown>;
      profile.followers_count = Number.MAX_SAFE_INTEGER + 2;

      expect(() => parseCompetitorReport(envelope)).toThrow(CompetitorReportContractError);
    });

    it("refuses a non-finite measurement", () => {
      const envelope = listEnvelope();
      const entry = (envelope.entries as Array<Record<string, unknown>>)[0];
      const growth = entry?.growth_7d as Record<string, unknown>;
      growth.percent = Number.POSITIVE_INFINITY;

      expect(() => parseCompetitorReport(envelope)).toThrow(CompetitorReportContractError);
    });

    it("refuses an unknown growth reason instead of publishing it verbatim", () => {
      const envelope = listEnvelope();
      const entry = (envelope.entries as Array<Record<string, unknown>>)[0];
      const growth = entry?.growth_7d as Record<string, unknown>;
      growth.reason = "because_i_said_so";

      expect(() => parseCompetitorReport(envelope)).toThrow(CompetitorReportContractError);
    });

    it("refuses a payload that is not a report at all", () => {
      expect(() => parseCompetitorReport(null)).toThrow(CompetitorReportContractError);
      expect(() => parseCompetitorReport([])).toThrow(CompetitorReportContractError);
      expect(() => parseCompetitorReport({})).toThrow(CompetitorReportContractError);
    });

    it("refuses a report that carries neither entries nor media", () => {
      const envelope = listEnvelope();
      delete envelope.entries;

      expect(() => parseCompetitorReport(envelope)).toThrow(CompetitorReportContractError);
    });

    it("refuses a report that carries a list and a detail at the same time", () => {
      const envelope = { ...listEnvelope(), ...detailEnvelope() };

      expect(() => parseCompetitorReport(envelope)).toThrow(CompetitorReportContractError);
    });

    it("refuses a capture timezone it does not know", () => {
      const envelope = { ...listEnvelope(), capture_timezone: "Europe/Berlin" };

      expect(() => parseCompetitorReport(envelope)).toThrow(CompetitorReportContractError);
    });
  });
});
