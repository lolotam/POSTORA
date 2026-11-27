import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { formatAnalyticsDate, formatCount, formatMinutes, formatSeconds, startDateForWindow } from "../domain/format";
import { buildTrendSeries } from "../domain/trendSeries";
import { ANALYTICS_PURPOSE_TEXT } from "../domain/purposeText";
import { ANALYTICS_PURPOSE_VERSION, YOUTUBE_ANALYTICS_DAILY_METRICS, type YouTubeAnalyticsTopVideoRow } from "../domain/types";
import { mergeTopVideoPages, sortTopVideoRows } from "../domain/topVideosView";
import {
  buildYouTubeAnalyticsCsv,
  buildYouTubeAnalyticsCsvFilename,
  sanitizeCsvStringCell,
} from "../domain/exportCsv";
import { requestedWindow, success, topVideosData, WINDOW_END } from "./fixtures";

describe("analytics formatting", () => {
  it("keeps null explicit and formats units", () => {
    expect(formatCount(null)).toBe("—");
    expect(formatCount(1234, "en")).toBe("1,234");
    expect(formatCount(0, "en")).toBe("0");
    expect(formatCount(-2, "en")).toBe("-2");
    expect(formatMinutes(null)).toBe("—");
    expect(formatMinutes(125)).toBe("2h 5m");
    expect(formatMinutes(12.5)).toBe("12.5m");
    expect(formatSeconds(null)).toBe("—");
    expect(formatSeconds(65)).toBe("1:05");
    expect(formatSeconds(3661)).toBe("1h 1m");
    expect(formatAnalyticsDate(null)).toBe("—");
    expect(formatAnalyticsDate("not-a-date")).toBe("—");
    expect(startDateForWindow(WINDOW_END, 7)).toBe("2026-11-11");
  });
});

describe("daily trend series", () => {
  it("builds every requested day and never substitutes zero for a missing row or metric", () => {
    const points = buildTrendSeries(requestedWindow(), [{
      day: "2026-11-12",
      metrics: YOUTUBE_ANALYTICS_DAILY_METRICS.map((definition) => ({ key: definition.key, unit: definition.unit, value: definition.key === "views" ? 5 : null })),
    }]);
    expect(points).toHaveLength(7);
    expect(points[0]).toEqual({ day: "2026-11-11", views: null, watch_time: null, subscribers_gained: null, subscribers_lost: null });
    expect(points[1]).toEqual({ day: "2026-11-12", views: 5, watch_time: null, subscribers_gained: null, subscribers_lost: null });
    expect(points.at(-1)?.day).toBe(WINDOW_END);
    expect(points.flatMap((point) => Object.values(point))).not.toContain(0);
  });

  it("keeps an explicit provider zero while missing days remain null", () => {
    const points = buildTrendSeries(requestedWindow(7), [{
      day: WINDOW_END,
      metrics: [{ key: "subscribers_lost", unit: "count", value: 0 }],
    }]);
    expect(points.at(-1)?.subscribers_lost).toBe(0);
    expect(points.at(-1)?.views).toBeNull();
  });
});

const PINNED_PURPOSE_DIGESTS: Record<number, { en: string; ar: string }> = {
  1: {
    en: "1c30c0f2b02e8c2978ea7f2263fe15bb84b4201553d9ffde32dba9b5f81ca422",
    ar: "a51ea364e48978289d428b404867e9b425083d3bb0c17e0af031264f4e0dc0a1",
  },
  2: {
    en: "87e5cd2779bd380db104c1a33bc7f8762ec6af0cafc62e2b885519bed0a95516",
    ar: "5da4c581e67b4b5acdf75eb8396499eef45d57922b12bcefc0c1f6d8fd8ca90b",
  },
};

describe("Analytics Purpose Clause version guard", () => {
  it("pins every English and Arabic purpose string to the purpose version", () => {
    const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    for (const version of [1, 2] as const) {
      const localized = ANALYTICS_PURPOSE_TEXT[version];
      expect(PINNED_PURPOSE_DIGESTS[version]).toEqual({
        en: digest(localized.en),
        ar: digest(localized.ar),
      });
    }
    expect(ANALYTICS_PURPOSE_VERSION).toBe(2);
  });
});


describe("top videos view", () => {
  const row = (id: string, views: number | null, likes: number | null = 0, title: string | null = id): YouTubeAnalyticsTopVideoRow => ({
    video_id: id,
    title,
    published_at: null,
    thumbnail_url: null,
    link: `https://www.youtube.com/watch?v=${id}`,
    metrics: [
      { key: "views", unit: "count", value: views },
      { key: "watch_time", unit: "minutes", value: views },
      { key: "likes", unit: "count", value: likes },
      { key: "subscribers_gained", unit: "count", value: 1 },
    ],
  });

  it("merges pages in order and keeps the first copy of each video", () => {
    const first = topVideosData();
    const second = topVideosData("Duplicate");
    second.rows.push(row("videoBBBBBBB", 20));
    const merged = mergeTopVideoPages([success(first), success(second)]);
    expect(merged.map((item) => item.video_id)).toEqual([first.rows[0].video_id, "videoBBBBBBB"]);
    expect(merged[0].title).toBe("Fixture video");
  });

  it("sorts every metric numerically with nulls last in both directions", () => {
    const rows = [row("videoAAAAAAA", 10, -2), row("videoBBBBBBB", null, 4), row("videoCCCCCCC", 10, -5)];
    expect(sortTopVideoRows(rows, "views", "ascending").map((item) => item.video_id)).toEqual(["videoAAAAAAA", "videoCCCCCCC", "videoBBBBBBB"]);
    expect(sortTopVideoRows(rows, "views", "descending").map((item) => item.video_id)).toEqual(["videoAAAAAAA", "videoCCCCCCC", "videoBBBBBBB"]);
    expect(sortTopVideoRows(rows, "likes", "ascending").map((item) => item.video_id)).toEqual(["videoCCCCCCC", "videoAAAAAAA", "videoBBBBBBB"]);
  });

  it("sorts titles and publication dates with stable ties", () => {
    const rows = [row("videoAAAAAAA", 1, 0, "Beta"), row("videoBBBBBBB", 2, 0, "alpha"), row("videoCCCCCCC", 3, 0, null)];
    expect(sortTopVideoRows(rows, "video", "ascending").map((item) => item.video_id)).toEqual(["videoBBBBBBB", "videoAAAAAAA", "videoCCCCCCC"]);
    rows[0].published_at = "2026-01-01T00:00:00Z";
    rows[1].published_at = "2026-02-01T00:00:00Z";
    expect(sortTopVideoRows(rows, "published_at", "descending").map((item) => item.video_id)).toEqual(["videoBBBBBBB", "videoAAAAAAA", "videoCCCCCCC"]);
  });
});

describe("CSV export", () => {
  it("builds safe filenames with channel slug and date range", () => {
    const window = requestedWindow();
    expect(buildYouTubeAnalyticsCsvFilename("My Channel! 2026", window))
      .toBe("youtube-analytics_my-channel-2026_2026-11-11_2026-11-17.csv");
    expect(buildYouTubeAnalyticsCsvFilename("قناة بوستورا", window))
      .toBe("youtube-analytics_قناة-بوستورا_2026-11-11_2026-11-17.csv");
    expect(buildYouTubeAnalyticsCsvFilename("!!!", window))
      .toBe("youtube-analytics_channel_2026-11-11_2026-11-17.csv");
  });

  it("prefixes dangerous formula string cells but leaves numbers unprefixed", () => {
    expect(sanitizeCsvStringCell("=CMD()")).toBe("'=CMD()");
    expect(sanitizeCsvStringCell("+1")).toBe("'+1");
    expect(sanitizeCsvStringCell("-1")).toBe("'-1");
    expect(sanitizeCsvStringCell("@import")).toBe("'@import");
    expect(sanitizeCsvStringCell("\thello")).toBe("'\thello");
    expect(sanitizeCsvStringCell("\rhello")).toBe("'\rhello");
    expect(sanitizeCsvStringCell("Normal title")).toBe("Normal title");
  });

  it("writes UTF-8 BOM, CRLF endings, RFC 4180 quoting, negative numeric cells, and Arabic text", () => {
    const csv = buildYouTubeAnalyticsCsv({
      tab: "overview",
      channelTitle: 'قناة "بوستورا", الرسمية',
      window: requestedWindow(),
      fetchedAt: "2026-11-20T12:00:00.000Z",
      summary: {
        has_data: true,
        metrics: [
          { key: "views", unit: "count", value: 100 },
          { key: "likes", unit: "count", value: -2 },
          { key: "shares", unit: "count", value: null },
        ],
      },
      daily: {
        rows: [{
          day: "2026-11-11",
          metrics: [
            { key: "views", unit: "count", value: 40 },
            { key: "watch_time", unit: "minutes", value: 12 },
            { key: "subscribers_gained", unit: "count", value: 3 },
            { key: "subscribers_lost", unit: "count", value: 1 },
          ],
        }],
        coverage: { first_day: "2026-11-11", last_day: "2026-11-11", days_returned: 1, days_missing: 6 },
      },
      topVideos: [{
        video_id: "videoAAAAAAA",
        title: '=HYPERLINK("http://evil", "فيديو, رائع")',
        published_at: "2026-11-01T00:00:00Z",
        link: "https://www.youtube.com/watch?v=videoAAAAAAA",
        metrics: [
          { key: "views", unit: "count", value: 50 },
          { key: "watch_time", unit: "minutes", value: 25 },
          { key: "likes", unit: "count", value: -2 },
          { key: "subscribers_gained", unit: "count", value: 1 },
        ],
      }],
    });

    expect(csv.startsWith("\uFEFF")).toBe(true);
    expect(csv).toContain("\r\n");
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe('Channel,"قناة ""بوستورا"", الرسمية"');
    expect(lines[1]).toBe("Period,2026-11-11 to 2026-11-17 (7 days)");
    expect(lines[2]).toBe("Time zone,America/Los_Angeles");
    expect(lines[3]).toBe("Fetched at,2026-11-20T12:00:00.000Z");
    expect(lines).toContain("Summary,likes,count,-2");
    expect(lines).toContain("Summary,shares,count,");
    expect(lines).toContain('videoAAAAAAA,"\'=HYPERLINK(""http://evil"", ""فيديو, رائع"")",2026-11-01T00:00:00Z,50,25,-2,1');
  });

  it("exports audience, traffic, and empty reports cleanly", () => {
    const audienceCsv = buildYouTubeAnalyticsCsv({
      tab: "audience",
      channelTitle: "Channel",
      window: requestedWindow(),
      fetchedAt: "2026-11-20T12:00:00.000Z",
      geography: {
        dimension: "country",
        has_data: true,
        rows: [{
          key: "EG",
          metrics: [
            { key: "views", unit: "count", value: 140 },
            { key: "watch_time", unit: "minutes", value: 50 },
          ],
        }],
      },
      devices: {
        dimension: "device",
        has_data: true,
        rows: [{
          key: "MOBILE",
          metrics: [
            { key: "views", unit: "count", value: 150 },
            { key: "watch_time", unit: "minutes", value: 55 },
          ],
        }],
      },
      resolveCountryLabel: (code) => (code === "EG" ? "Egypt" : code),
      resolveDeviceLabel: (key) => (key === "MOBILE" ? "Mobile" : key),
    });
    expect(audienceCsv).toContain("Country code,Country,Views,Watch time (minutes)\r\nEG,Egypt,140,50");
    expect(audienceCsv).toContain("Device key,Device,Views,Watch time (minutes)\r\nMOBILE,Mobile,150,55");

    const trafficCsv = buildYouTubeAnalyticsCsv({
      tab: "traffic",
      channelTitle: "Channel",
      window: requestedWindow(),
      fetchedAt: "2026-11-20T12:00:00.000Z",
      trafficSources: {
        dimension: "traffic_source",
        has_data: false,
        rows: [],
      },
    });
    expect(trafficCsv).toContain("Traffic source key,Traffic source,Views,Watch time (minutes)");
    expect(trafficCsv.endsWith("Traffic source key,Traffic source,Views,Watch time (minutes)")).toBe(true);
  });
});
