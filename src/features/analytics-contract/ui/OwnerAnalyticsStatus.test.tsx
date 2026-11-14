import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import i18n from "@/i18n";
import { OwnerAnalyticsStatus } from "./OwnerAnalyticsStatus";
import type { OwnerAnalyticsReadiness } from "../../../../supabase/functions/_shared/ownerAnalyticsReadiness";

function readiness(reason: "collection_not_eligible" | "queued" = "collection_not_eligible"): OwnerAnalyticsReadiness {
  return { collection: { contract_version: 2, state: reason === "queued" ? "syncing" : "not_enabled", reason_code: reason,
    reason_source: "rollout_policy", observed_at: "2026-11-14T09:00:00Z", next_action: "contact_support", reconnect_can_help: false,
    retry_at: null, support_correlation_id: "fixture-correlation" }, connection: { state: "unverified", reason_code: "bootstrap_required" },
    permission: { state: "unknown", observed_at: null, missing_scopes: [] },
    last_attempt: { state: "retry", reason_code: "capability_missing", observed_at: "2026-11-05T09:00:00Z" } };
}

describe("owner analytics readiness", () => {
  it.each(["en", "ar"])("explains exclusion separately from empty data and historical attempts in %s", async (language) => {
    await i18n.changeLanguage(language);
    const { container } = render(<OwnerAnalyticsStatus report={{ ...readiness(), data: { state: "empty", observation_count: 0, coverage: "unknown", last_successful_capture: null } }} />);
    expect(container).toHaveTextContent(language === "ar" ? "جمع التحليلات لم يُفعّل" : "Analytics collection is not enabled");
    expect(container).toHaveTextContent(language === "ar" ? "لم تتم المزامنة" : "Never synced");
    expect(container).not.toHaveTextContent(/Reconnect|permissions are missing|Partially synced|48 hours/i);
    await i18n.changeLanguage("en");
  });


});
