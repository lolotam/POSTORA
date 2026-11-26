import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createYouTubeAnalyticsAudit, sanitiseYouTubeAnalyticsOperation, type AuditInsertRow } from "./audit.ts";
import type { YouTubeAnalyticsRpcRunner } from "./decision.ts";

const USER_ID = "0ee00001-0000-4000-8000-000000000001";
const ACCOUNT_ID = "0ee20001-0000-4000-8000-000000000021";

function sharedAuditHarness() {
  const counters = new Map<string, number>();
  const rows: AuditInsertRow[] = [];
  let counterCalls = 0;
  let failInsert = false;
  const rpc: YouTubeAnalyticsRpcRunner = (_fn, args) => {
    counterCalls += 1;
    const key = String(args.p_endpoint);
    const count = (counters.get(key) ?? 0) + 1;
    counters.set(key, count);
    return Promise.resolve({
      data: {
        allowed: count <= Number(args.p_max_requests),
        count,
        retry_after: 60,
      },
      error: null,
    });
  };
  const warnings: Array<Record<string, unknown>> = [];
  const insert = (row: AuditInsertRow) => {
    if (failInsert) return Promise.resolve({ error: { code: "XX000" } });
    rows.push(row);
    return Promise.resolve();
  };
  const first = createYouTubeAnalyticsAudit({ rpc, insert, nowMs: () => 1000, consoleWarn: (row) => warnings.push(row) });
  const second = createYouTubeAnalyticsAudit({ rpc, insert, nowMs: () => 1000, consoleWarn: (row) => warnings.push(row) });
  return {
    first,
    second,
    rows,
    warnings,
    get counterCalls() {
      return counterCalls;
    },
    set failInsert(value: boolean) {
      failInsert = value;
    },
    admission: () => rpc("check_rate_limit", {
      p_endpoint: `youtube-analytics:admit:${USER_ID}`,
      p_identifier: USER_ID,
      p_max_requests: 120,
      p_window_seconds: 60,
    }),
    resetCounters: () => counters.clear(),
  };
}

function entry(code: "invalid_request" | "rate_limited" = "invalid_request") {
  return {
    operation: "summary" as const,
    code,
    requestId: "request",
    userId: USER_ID,
    accountId: ACCOUNT_ID,
  };
}

Deno.test("operation audit labels are restricted to known names", () => {
  assertEquals(sanitiseYouTubeAnalyticsOperation({ operation: "summary" }), "summary");
  assertEquals(sanitiseYouTubeAnalyticsOperation({ operation: "provider text" }), "unknown");
  assertEquals(sanitiseYouTubeAnalyticsOperation(null), "unknown");
});

Deno.test("two workers sharing buckets write at most 20 standard refusal rows and carry suppression count", async () => {
  const h = sharedAuditHarness();
  for (let index = 0; index < 30; index += 1) {
    await (index % 2 === 0 ? h.first : h.second).refusal(entry(), "standard");
  }
  assertEquals(h.rows.length, 20);
  h.resetCounters();
  await h.first.refusal(entry(), "standard");
  assertEquals(h.rows.length, 21);
  const lastMetadata = h.rows.at(-1)?.metadata as Record<string, unknown>;
  assertEquals(lastMetadata.suppressed, 5);
  assertEquals(h.rows.every((row) => row.source === "youtube-analytics" && row.category === "edge"), true);
  assertEquals(h.rows.every((row) => row.user_id === USER_ID), true);
  assertEquals(JSON.stringify(h.rows).includes("provider text"), false);
});

Deno.test("500 admission refusals cost 1,000 counter calls, one row and one console line per worker", async () => {
  const h = sharedAuditHarness();
  for (let index = 0; index < 500; index += 1) {
    await h.admission();
    await (index % 2 === 0 ? h.first : h.second).refusal(entry("rate_limited"), "admission");
  }
  assertEquals(h.counterCalls, 1000);
  assertEquals(h.rows.length, 1);
  assertEquals(h.warnings.length, 2);
});

Deno.test("anonymous codes write nothing and a failed insert never escapes", async () => {
  const h = sharedAuditHarness();
  await h.first.refusal({ ...entry(), code: "unauthorized" }, "standard");
  await h.first.refusal({ ...entry(), code: "method_not_allowed" }, "standard");
  assertEquals(h.rows.length, 0);
  h.failInsert = true;
  await h.first.success({ ...entry(), code: "ok" });
  assertEquals(h.rows.length, 0);
});

Deno.test("success writes one info row with no token, provider text or analytics numbers", async () => {
  const h = sharedAuditHarness();
  await h.first.success({ ...entry(), code: "ok" });
  assertEquals(h.rows.length, 1);
  assertEquals(h.rows[0].level, "info");
  assertEquals(h.rows[0].metadata, {
    operation: "summary",
    code: "ok",
    request_id: "request",
    account_id: ACCOUNT_ID,
  });
  const serialized = JSON.stringify(h.rows[0]);
  for (const forbidden of ["access_token", "refresh_token", "provider text", "views", "watch_time"]) {
    assertEquals(serialized.includes(forbidden), false);
  }
});
