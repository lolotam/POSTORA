import { expect } from "@playwright/test";
import type { OwnerAnalyticsReadiness } from "../../supabase/functions/_shared/ownerAnalyticsReadiness";

/** Readiness is observed and audited per request; saved evidence must still match. */
export function readinessParity<T extends Partial<OwnerAnalyticsReadiness> & { generatedAt: string }>(report: T): T {
  if (!report.collection) return report;
  const observed = Date.parse(report.collection.observed_at);
  // The request process and SQL VM may have slightly different clocks.
  expect(observed).toBeGreaterThanOrEqual(Date.parse(report.generatedAt) - 1_000);
  expect(observed).toBeLessThanOrEqual(Date.now() + 1_000);
  expect(report.collection.support_correlation_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  return { ...report, collection: { ...report.collection, observed_at: "request-clock", support_correlation_id: "request-correlation" } };
}
