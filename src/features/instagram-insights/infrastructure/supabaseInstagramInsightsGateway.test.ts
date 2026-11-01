import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { decodeOwnerReportCursor as parseCursor } from "../../../../supabase/functions/instagram-insights-report/contracts";
import { reportFixture } from "../tests/reportFixture";
import { SupabaseInstagramInsightsGateway } from "./supabaseInstagramInsightsGateway";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke: vi.fn() } },
}));

describe("Instagram report gateway contract", () => {
  beforeEach(() => vi.clearAllMocks());

  it("explicit canonical negotiation preserves a calendar refusal without requesting a legacy report", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: null, error: Object.assign(new Error("non-2xx status code"), {
      context: Response.json({ ok: false, reason: "window_mismatch" }, { status: 409 }),
    }) });
    await expect(new SupabaseInstagramInsightsGateway().getAnalyticsReport({ socialAccountId: "acc-123", periodDays: 7 })).rejects.toThrow("window_mismatch");
    expect(supabase.functions.invoke).toHaveBeenCalledTimes(1);
    expect(supabase.functions.invoke).toHaveBeenCalledWith("instagram-insights-report", { body: {
      social_account_id: "acc-123", period_days: 7, analyticsContractVersion: 1, cursor: null,
    } });
  });

  it("sends a cursor that the actual report handler can decode", async () => {
    const report = reportFixture();
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: report, error: null });
    const cursor = { publishedAt: "2026-10-26T12:00:00.123456Z", mediaId: "media-999" };

    const received = await new SupabaseInstagramInsightsGateway().getReport({
      socialAccountId: "acc-123", periodDays: 30, cursor,
    });

    const body = vi.mocked(supabase.functions.invoke).mock.calls[0][1]?.body as { cursor: unknown };
    expect(parseCursor(body.cursor)).toEqual(cursor);
    expect(received).toEqual(report);
  });

  it.each([
    { publishedAt: "2026-10-26T12:00:00.123456Z", mediaId: "media-999" },
    JSON.stringify({ publishedAt: "2026-10-26T12:00:00.123456Z", mediaId: "media-999" }),
    btoa(JSON.stringify({ publishedAt: "2026-10-26T12:00:00.123456Z", mediaId: "media-999" })),
  ])("preserves microseconds in supported HTTP cursor encoding: %j", (cursor) => {
    expect(parseCursor(cursor)).toEqual({ publishedAt: "2026-10-26T12:00:00.123456Z", mediaId: "media-999" });
  });
});
