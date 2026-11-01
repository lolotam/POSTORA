import assert from "node:assert/strict";
import { test } from "node:test";
import { assertOwnerJourneyResults, REQUIRED_OWNER_JOURNEYS } from "./check-instagram-owner-journeys.mjs";

function reportFixture() {
  return {
    errors: [], stats: { expected: REQUIRED_OWNER_JOURNEYS.length, unexpected: 0, flaky: 0, skipped: 0 },
    suites: [{ suites: [{ specs: REQUIRED_OWNER_JOURNEYS.map((title) => ({
      title, ok: true, tests: [{ projectName: "chromium", expectedStatus: "passed", status: "expected", results: [{ status: "passed", errors: [] }] }],
    })) }] }],
  };
}

test("accepts complete nested Playwright results", () => assert.doesNotThrow(() => assertOwnerJourneyResults(reportFixture())));

for (const [scenario, change] of [
  ["zero tests", (report) => { report.suites = []; report.stats.expected = 0; }],
  ["missing required journey", (report) => { report.suites[0].suites[0].specs.pop(); report.stats.expected--; }],
  ["skipped assertion", (report) => { report.suites[0].suites[0].specs[0].tests[0].results[0].status = "skipped"; }],
  ["expected failure", (report) => { report.suites[0].suites[0].specs[0].tests[0].expectedStatus = "failed"; }],
  ["retried pass", (report) => { report.suites[0].suites[0].specs[0].tests[0].results.unshift({ status: "failed" }); }],
  ["flaky result", (report) => { report.stats.flaky = 1; }],
  ["global error", (report) => { report.errors.push({ message: "setup failed" }); }],
  ["wrong project", (report) => { report.suites[0].suites[0].specs[0].tests[0].projectName = "other"; }],
  ["incorrect totals", (report) => { report.stats.expected++; }],
]) {
  test(`rejects ${scenario}`, () => {
    const report = reportFixture();
    change(report);
    assert.throws(() => assertOwnerJourneyResults(report));
  });
}
