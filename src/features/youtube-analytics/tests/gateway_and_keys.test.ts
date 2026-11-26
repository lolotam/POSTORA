import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { SupabaseYouTubeAnalyticsGateway } from "../infrastructure/supabaseYouTubeAnalyticsGateway";
import { youtubeAnalyticsQueryKey } from "../application/queryKeys";
import { YouTubeAnalyticsClientError } from "../domain/errors";
import { YOUTUBE_ANALYTICS_ERRORS, type YouTubeAnalyticsErrorCode } from "../domain/types";
import { ACCOUNT_ID, PERIOD, REVISION, statusData, success, topVideosData, USER_ID, VIDEO_ID, WINDOW_END } from "./fixtures";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    auth: { getSession: vi.fn(async () => ({ data: { session: { access_token: "fixture-session-token" } } })) },
  },
}));

const gateway = new SupabaseYouTubeAnalyticsGateway();
let fetchMock: ReturnType<typeof vi.fn>;

function answer(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock = vi.fn(async () => answer(success(statusData(), REVISION, false)));
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(supabase.auth.getSession).mockResolvedValue({ data: { session: { access_token: "fixture-session-token" } } } as never);
});

describe("Supabase gateway contract fixtures", () => {
  it("sends the shared status and consent request shapes with the session token", async () => {
    fetchMock
      .mockResolvedValueOnce(answer(success(statusData(), REVISION, false)))
      .mockResolvedValueOnce(answer(success({ recorded: true, consent: { state: "accepted", version: 1 }, purpose_version: 1 }, REVISION, false)))
      .mockResolvedValueOnce(answer(success({ recorded: true, consent: { state: "withdrawn", version: 1 }, purpose_version: 1 }, REVISION, false)));
    await gateway.status(ACCOUNT_ID);
    await gateway.acceptConsent({ accountId: ACCOUNT_ID, purposeVersion: 1, locale: "ar", connectionRevision: REVISION });
    await gateway.withdrawConsent({ accountId: ACCOUNT_ID, locale: "en" });

    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(call[1].body));
    expect(bodies).toEqual([
      { operation: "status", account_id: ACCOUNT_ID },
      { operation: "consent_accept", account_id: ACCOUNT_ID, purpose_version: 1, locale: "ar", connection_revision: REVISION },
      { operation: "consent_withdraw", account_id: ACCOUNT_ID, locale: "en" },
    ]);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe("http://127.0.0.1:54321/functions/v1/youtube-analytics");
      expect(call[1].method).toBe("POST");
      expect(call[1].headers.Authorization).toBe("Bearer fixture-session-token");
      expect(call[1].headers.apikey).toBe("test-publishable-key");
    }
  });

  it("sends the three data operations and optional video ID without a user ID in the body", async () => {
    const params = { accountId: ACCOUNT_ID, periodDays: PERIOD, windowEnd: WINDOW_END };
    fetchMock
      .mockResolvedValueOnce(answer(success({ metrics: [], has_data: false })))
      .mockResolvedValueOnce(answer(success({ rows: [], coverage: { first_day: null, last_day: null, days_returned: 0, days_missing: 30 } })))
      .mockResolvedValueOnce(answer(success({ rows: [], titles: "unavailable", has_more: false, next_start_index: null })));
    await gateway.summary({ ...params, videoId: VIDEO_ID });
    await gateway.daily(params);
    await gateway.topVideos(params);

    expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body))).toEqual([
      { operation: "summary", account_id: ACCOUNT_ID, period_days: PERIOD, window_end: WINDOW_END, video_id: VIDEO_ID },
      { operation: "daily", account_id: ACCOUNT_ID, period_days: PERIOD, window_end: WINDOW_END },
      { operation: "top_videos", account_id: ACCOUNT_ID, period_days: PERIOD, window_end: WINDOW_END },
    ]);
    expect(fetchMock.mock.calls.every((call) => !("user_id" in JSON.parse(call[1].body)))).toBe(true);
  });

  it("omits start_index on page one and sends it on later pages", async () => {
    const params = { accountId: ACCOUNT_ID, periodDays: PERIOD, windowEnd: WINDOW_END };
    fetchMock.mockImplementation(async () => answer(success(topVideosData())));
    await gateway.topVideos({ ...params, startIndex: 1 });
    await gateway.topVideos({ ...params, startIndex: 11 });
    expect(fetchMock.mock.calls.map((call) => JSON.parse(call[1].body))).toEqual([
      { operation: "top_videos", account_id: ACCOUNT_ID, period_days: PERIOD, window_end: WINDOW_END },
      { operation: "top_videos", account_id: ACCOUNT_ID, period_days: PERIOD, window_end: WINDOW_END, start_index: 11 },
    ]);
  });

  it("accepts negative net engagement metrics in a summary response", async () => {
    const metrics = [
      { key: "views", unit: "count", value: 59 },
      { key: "likes", unit: "count", value: -2 },
      { key: "comments", unit: "count", value: -1 },
      { key: "shares", unit: "count", value: -3 },
    ];
    fetchMock.mockResolvedValueOnce(answer(success({ metrics, has_data: true })));

    const result = await gateway.summary({ accountId: ACCOUNT_ID, periodDays: PERIOD, windowEnd: WINDOW_END });

    expect(result.data.metrics).toEqual(metrics);
  });

  it.each(Object.keys(YOUTUBE_ANALYTICS_ERRORS) as YouTubeAnalyticsErrorCode[])("maps %s with scope and response extras", async (code) => {
    const definition = YOUTUBE_ANALYTICS_ERRORS[code];
    fetchMock.mockResolvedValueOnce(answer({
      error: code,
      request_id: "req-error",
      connection_revision: REVISION,
      reporting_end_date: WINDOW_END,
      accepted_window_ends: [WINDOW_END, "2026-11-16"],
      consent: { state: "outdated", version: 0 },
      purpose_version: 1,
      retry_after_seconds: 120,
      detail: "grant_not_effective",
    }, definition.status));

    const promise = gateway.status(ACCOUNT_ID);
    await expect(promise).rejects.toMatchObject({
      name: "YouTubeAnalyticsClientError",
      code,
      scope: definition.scope,
      requestId: "req-error",
      connectionRevision: REVISION,
      reportingEndDate: WINDOW_END,
      acceptedWindowEnds: [WINDOW_END, "2026-11-16"],
      consent: { state: "outdated", version: 0 },
      purposeVersion: 1,
      retryAfterSeconds: 120,
      detail: "grant_not_effective",
    });
  });

  it("does not turn a malformed success into an empty report", async () => {
    fetchMock.mockResolvedValueOnce(answer({ data: {} }));
    await expect(gateway.summary({ accountId: ACCOUNT_ID, periodDays: PERIOD, windowEnd: WINDOW_END }))
      .rejects.toBeInstanceOf(YouTubeAnalyticsClientError);
  });

  it("maps a missing session to unauthorized without calling fetch", async () => {
    vi.mocked(supabase.auth.getSession).mockResolvedValueOnce({ data: { session: null } } as never);
    await expect(gateway.status(ACCOUNT_ID)).rejects.toMatchObject({ code: "unauthorized" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("query keys", () => {
  it("separates operations, video variants, revisions and windows", () => {
    const summary = youtubeAnalyticsQueryKey(USER_ID, ACCOUNT_ID, REVISION, "summary", WINDOW_END, PERIOD);
    const daily = youtubeAnalyticsQueryKey(USER_ID, ACCOUNT_ID, REVISION, "daily", WINDOW_END, PERIOD);
    const top = youtubeAnalyticsQueryKey(USER_ID, ACCOUNT_ID, REVISION, "top_videos", WINDOW_END, PERIOD);
    const video = youtubeAnalyticsQueryKey(USER_ID, ACCOUNT_ID, REVISION, "summary", WINDOW_END, PERIOD, VIDEO_ID);
    expect(new Set([summary, daily, top, video].map((key) => JSON.stringify(key))).size).toBe(4);
    expect(summary).toEqual(["youtube-analytics", USER_ID, ACCOUNT_ID, REVISION, "summary", WINDOW_END, PERIOD, null]);
    expect(video.at(-1)).toBe(VIDEO_ID);
    expect(youtubeAnalyticsQueryKey(USER_ID, ACCOUNT_ID, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "summary", WINDOW_END, PERIOD)).not.toEqual(summary);
  });
});
