import { describe, expect, it } from "vitest";
import { summarizeDailyMetricValues } from "../index";
import { duplicateDayInput, metricValueCases } from "../../../../supabase/functions/_shared/analyticsContractTestSupport";

describe("shared daily metric values", () => {
  it.each(metricValueCases)("preserves $name", ({ input, expected }) => {
    expect(summarizeDailyMetricValues(input)).toEqual(expected);
  });

  it("refuses unresolved duplicate buckets instead of counting retries as additional coverage", () => {
    expect(() => summarizeDailyMetricValues(duplicateDayInput))
      .toThrow("Resolve duplicate metric dates before aggregation");
  });
});
