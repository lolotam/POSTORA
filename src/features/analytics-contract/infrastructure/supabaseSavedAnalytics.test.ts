import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { analyticsReportFixture } from "../../../../supabase/functions/_shared/analyticsContractTestSupport.ts";
import { supabaseSavedAnalytics } from "./supabaseSavedAnalytics";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: vi.fn() } } }));

describe("saved analytics HTTP boundary", () => {
  beforeEach(() => vi.clearAllMocks());
  it.each(["facebook", "threads"] as const)("reads persisted %s data and preserves an opaque cursor", async (platform) => {
    const report = analyticsReportFixture(platform);
    report.source = "persisted";
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: report, error: null });
    expect(await supabaseSavedAnalytics.report({ platform, accountId: report.accountId, periodDays: 7, cursor: "signed-fixture" })).toEqual(report);
    expect(supabase.functions.invoke).toHaveBeenCalledWith("meta-owned-analytics-report", { body: {
      platform, accountId: report.accountId, periodDays: 7, analyticsContractVersion: 1, cursor: "signed-fixture",
    } });
  });
  it.each(["wrong_scope", "live_response", "invalid_response", "window_mismatch"])("refuses %s without a legacy fallback or zero DTO", async (scenario) => {
    const report = analyticsReportFixture("facebook"); report.source = "persisted";
    if (scenario === "wrong_scope") report.accountId = "d0000000-0000-4000-8000-000000000001";
    if (scenario === "live_response") report.source = "live";
    vi.mocked(supabase.functions.invoke).mockResolvedValue(scenario === "window_mismatch"
      ? { data: null, error: Object.assign(new Error("Edge Function returned a non-2xx status code"), { context: Response.json({ reason: "window_mismatch" }, { status: 409 }) }) }
      : { data: scenario === "invalid_response" ? {} : report, error: null });
    await expect(supabaseSavedAnalytics.report({ platform: "facebook", accountId: analyticsReportFixture().accountId, periodDays: 7, cursor: null })).rejects.toThrow(scenario === "window_mismatch" ? "window_mismatch" : "invalid_contract");
    expect(supabase.functions.invoke).toHaveBeenCalledTimes(1);
  });
});
