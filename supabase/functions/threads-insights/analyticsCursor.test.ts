import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { closedAnalyticsPeriods } from "../_shared/analyticsCalendar.ts";
import { AnalyticsCursorError, analyticsCursorScope, decodeAnalyticsCursor, encodeAnalyticsCursor } from "./analyticsCursor.ts";

Deno.test("signed continuation binds owner/account/calendar and stops cycles and the eighth page", async () => {
  const owner = "9f010000-0000-4000-8000-000000000001";
  const account = "9f020000-0000-4000-8000-000000000001";
  const period = closedAnalyticsPeriods({ now: "2026-11-01T04:00:00Z", days: 7, timezone: "America/Los_Angeles" }).current.period;
  const scope = analyticsCursorScope(owner, account, period);
  const secret = "fixture-signing-key";
  let position = await decodeAnalyticsCursor(null, scope, secret);
  let firstCursor = "";
  for (let page = 1; page <= 7; page++) {
    const encoded = await encodeAnalyticsCursor({ after: `page-${page}`, position, scope, secret });
    assertEquals(encoded.exhausted, false);
    if (page === 1) firstCursor = encoded.cursor!;
    position = await decodeAnalyticsCursor(encoded.cursor, scope, secret);
    assertEquals(position.after, `page-${page}`);
  }
  assertEquals(await encodeAnalyticsCursor({ after: "page-8", position, scope, secret }), { cursor: null, exhausted: true, repeated: false });
  assertEquals(await encodeAnalyticsCursor({ after: "page-1", position, scope, secret }), { cursor: null, exhausted: false, repeated: true });
  for (const changed of [{ ...scope, ownerId: account }, { ...scope, accountId: owner },
    { ...scope, days: 14 as const }, { ...scope, until: "2026-11-01T07:00:00.000Z" }]) {
    await assertRejects(() => decodeAnalyticsCursor(firstCursor, changed, secret), AnalyticsCursorError);
  }
  for (const cursor of [firstCursor + "tampered", "malformed", "A".repeat(16385)]) {
    await assertRejects(() => decodeAnalyticsCursor(cursor, scope, secret), AnalyticsCursorError);
  }
  await assertRejects(() => decodeAnalyticsCursor(firstCursor, scope, "different-signing-key"), AnalyticsCursorError);
});
