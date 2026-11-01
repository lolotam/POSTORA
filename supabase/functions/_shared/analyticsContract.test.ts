import assert from "node:assert/strict";
import { summarizeDailyMetricValues } from "./analyticsContract.ts";
import { duplicateDayInput, metricValueCases } from "./analyticsContractTestSupport.ts";

for (const { name, input, expected } of metricValueCases) {
  Deno.test(`metric values preserve ${name}`, () => {
    assert.deepEqual(summarizeDailyMetricValues(input), expected);
  });
}

Deno.test("metric values refuse unresolved duplicate provider-day buckets", () => {
  assert.throws(() => summarizeDailyMetricValues(duplicateDayInput), RangeError, "Resolve duplicate metric dates before aggregation");
});
