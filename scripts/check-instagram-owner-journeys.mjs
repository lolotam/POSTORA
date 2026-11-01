import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_OWNER_JOURNEYS = [
  "real login, persisted report pagination, isolated chart points and durable sync",
  "account reads show loading, a safe failure and retry without claiming no connection",
  "actual Auth identities enforce identical foreign and nonexistent report refusals",
  "Arabic RTL keeps unavailable reach explicit and period controls work with the keyboard",
  "signing out and switching real identities never reuses the previous owner's report",
  "direct report, authenticated public API and MCP preserve the complete stored report",
  "a credential generation changed during the provider response fences all history writes",
  ...["facebook", "threads"].flatMap((platform) => [
    `${platform} saved browser selects accounts and periods, paginates without duplicates and recovers revision conflicts`,
    `${platform} actual worker refresh preserves saved data and exposes permission and credential failures`,
    `${platform} real identity switch and direct requests cannot reuse another owner history or cursor`,
  ]),
];

export function assertOwnerJourneyResults(report) {
  const specs = [];
  function visit(suite) {
    specs.push(...(suite.specs ?? []));
    for (const child of suite.suites ?? []) visit(child);
  }
  for (const suite of report.suites ?? []) visit(suite);
  if (report.errors?.length || !specs.length || report.stats?.skipped !== 0 || report.stats?.unexpected !== 0 || report.stats?.flaky !== 0) {
    throw new Error("Owner journeys require nonzero passing tests and zero errors, skips, failures or flaky results");
  }
  for (const title of REQUIRED_OWNER_JOURNEYS) {
    if (specs.filter((spec) => spec.title === title).length !== 1) throw new Error(`Missing or duplicated required owner journey: ${title}`);
  }
  for (const spec of specs) {
    if (!spec.ok || spec.tests?.length !== 1) throw new Error(`Owner journey did not execute exactly once: ${spec.title}`);
    const test = spec.tests[0];
    if (test.projectName !== "chromium" || test.expectedStatus !== "passed" || test.status !== "expected" ||
        test.results?.length !== 1 || test.results[0].status !== "passed" || test.results[0].errors?.length) {
      throw new Error(`Owner journey did not pass without retries or skips: ${spec.title}`);
    }
  }
  if (report.stats.expected !== specs.length) throw new Error("Owner journey totals do not match executed results");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: check-instagram-owner-journeys.mjs <playwright.json>");
    assertOwnerJourneyResults(JSON.parse(readFileSync(process.argv[2], "utf8")));
    console.log("All required isolated owner journeys passed. Canonical G-X remains not evaluated.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
