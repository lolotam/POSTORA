import { assertRejects, assertStrictEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { readReportQuery, ReportHistoryUnavailableError } from "./readHistory.ts";

Deno.test("report deadlines refuse aborted reads even when a boundary resolves successfully", async (test) => {
  for (const timing of ["before", "during"] as const) {
    await test.step(timing, async () => {
      const controller = new AbortController();
      if (timing === "before") controller.abort();
      const query = Promise.resolve().then(() => {
        controller.abort();
        return { data: [] };
      });
      await assertRejects(() => readReportQuery(query, controller.signal), ReportHistoryUnavailableError);
    });
  }
});

Deno.test("unexpected report boundary failures retain their original error", async () => {
  const unexpected = new Error("synthetic unexpected boundary failure");
  const caught = await assertRejects(() => readReportQuery(Promise.reject(unexpected), new AbortController().signal));
  assertStrictEquals(caught, unexpected);
});
