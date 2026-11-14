import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import i18n from "@/i18n";
import { OwnerAnalyticsStatus } from "./OwnerAnalyticsStatus";
import { parseOwnerAnalyticsReadiness, type OwnerAnalyticsReadiness } from "../../../../supabase/functions/_shared/ownerAnalyticsReadiness";

function readiness(reason: "collection_not_eligible" | "queued" = "collection_not_eligible"): OwnerAnalyticsReadiness {
  return { collection: { contract_version: 2, state: reason === "queued" ? "syncing" : "not_enabled", reason_code: reason,
    reason_source: "rollout_policy", observed_at: "2026-11-14T09:00:00Z", next_action: "contact_support", reconnect_can_help: false,
    retry_at: null, support_correlation_id: "fixture-correlation" }, connection: { state: "unverified", reason_code: "bootstrap_required" },
    permission: { state: "unknown", observed_at: null, missing_scopes: [] },
    last_attempt: { state: "retry", reason_code: "capability_missing", observed_at: "2026-11-05T09:00:00Z" } };
}

describe("owner analytics readiness", () => {
  it("reads v2 snapshots and requires v3 for the precise direct diagnosis and allowlisted path", () => {
    const legacy = readiness();
    expect(parseOwnerAnalyticsReadiness(legacy).collection.contract_version).toBe(2);
    const report = { ...legacy, collection: { ...legacy.collection, contract_version: 3, state: "needs_reconnect",
      reason_code: "direct_verification_unsupported", reason_source: "connection", next_action: "reconnect", reconnect_can_help: true },
      connection: { state: "unverified", reason_code: "direct_verification_unsupported", reconnect_path: "/profiles" } };
    expect(parseOwnerAnalyticsReadiness(report).connection.reconnect_path).toBe("/profiles");
    for (const invalid of [
      { ...report, collection: { ...report.collection, contract_version: 2 } },
      { ...report, connection: { ...report.connection, reconnect_path: "https://example.invalid" } },
      { ...report, connection: { ...report.connection, state: "verified" } },
      { ...report, collection: { ...report.collection, state: "ready" } },
    ]) expect(() => parseOwnerAnalyticsReadiness(invalid)).toThrow();
  });

  it.each([
    ["linked_page_missing", "has no verified linked Facebook Page"],
    ["linked_page_unavailable", "linked Facebook Page connection is unavailable"],
  ] as const)("explains %s without merging accounts or promising reconnect", (_reason, message) => {
    const report = readiness();
    report.collection = { ...report.collection, contract_version: 3, state: "needs_review", reason_code: _reason, reason_source: "connection" };
    report.connection = { state: "unverified", reason_code: _reason, reconnect_path: null };
    const { container, queryByRole } = render(<OwnerAnalyticsStatus report={report} />);
    expect(container).toHaveTextContent(message);
    expect(queryByRole("link")).toBeNull();
  });

  it.each(["en", "ar"])("gives legacy direct accounts one supported Instagram Login reconnect in %s", async (language) => {
    await i18n.changeLanguage(language);
    const report = readiness();
    report.collection = { ...report.collection, contract_version: 3, state: "needs_reconnect", reason_code: "direct_verification_unsupported",
      reason_source: "connection", next_action: "reconnect", reconnect_can_help: true };
    report.connection = { state: "unverified", reason_code: "direct_verification_unsupported", reconnect_path: "/profiles" };
    const { container, getByRole } = render(<OwnerAnalyticsStatus report={report} />);
    expect(container).toHaveTextContent(language === "ar" ? "اتصال Instagram Login القديم" : "older Instagram Login connection");
    expect(getByRole("link")).toHaveAttribute("href", "/profiles");
    expect(container).not.toHaveTextContent(/Contact support|identity_mismatch/i);
    await i18n.changeLanguage("en");
  });

  it("keeps rollout exclusion while exposing the independent direct reconnect diagnosis", () => {
    const report = readiness();
    report.collection.contract_version = 3;
    report.connection = { state: "unverified", reason_code: "direct_verification_unsupported", reconnect_path: null };
    const { container, queryByRole } = render(<OwnerAnalyticsStatus report={report} />);
    expect(container).toHaveTextContent("Analytics collection is not enabled");
    expect(container).toHaveTextContent("older Instagram Login connection");
    expect(queryByRole("link")).toBeNull();
  });

  it.each(["en", "ar"])("explains exclusion separately from empty data and historical attempts in %s", async (language) => {
    await i18n.changeLanguage(language);
    const { container } = render(<OwnerAnalyticsStatus report={{ ...readiness(), data: { state: "empty", observation_count: 0, coverage: "unknown", last_successful_capture: null } }} />);
    expect(container).toHaveTextContent(language === "ar" ? "جمع التحليلات لم يُفعّل" : "Analytics collection is not enabled");
    expect(container).toHaveTextContent(language === "ar" ? "لم تتم المزامنة" : "Never synced");
    expect(container).not.toHaveTextContent(/Reconnect|permissions are missing|Partially synced|48 hours/i);
    await i18n.changeLanguage("en");
  });


});
