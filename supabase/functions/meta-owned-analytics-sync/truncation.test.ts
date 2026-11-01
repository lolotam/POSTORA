import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createOwnedAnalyticsSyncHandler } from "./handler.ts";

Deno.test("bounded inventory finishes without success and releases later collection dates", async (test) => {
  for (const platform of ["facebook", "threads"] as const) for (const bound of ["500_ids", "100_pages", "unfinished_captures"] as const) {
    await test.step(`${platform}: ${bound}`, async () => {
      const originalNow = Date.now;
      const started = originalNow();
      const ids = Array.from({ length: bound === "500_ids" ? 500 : 1 }, (_, index) => platform === "facebook" ? `772001_${9001 + index}` : String(7739001 + index));
      const keys = await Promise.all(ids.map(async (id) => "post:" + Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id))), (byte) => byte.toString(16).padStart(2, "0")).join("")));
      const authority = platform === "facebook" ? { platform_user_id: "772001", connection_version: 1, credential_id: "c5000000-0000-4000-8000-000000000001", credential_revision: 1, provider_user_id: "771001", token_expires_at: null }
        : { platform_user_id: "773001", credential_generation: 1, token_expires_at: null };
      const job = (later: boolean) => ({ job_id: later ? "c2000000-0000-4000-8000-000000000002" : "c2000000-0000-4000-8000-000000000001",
        user_id: "c1000000-0000-4000-8000-000000000001", account_id: "c3000000-0000-4000-8000-000000000001", platform,
        job_generation: 1, claim_token: "c4000000-0000-4000-8000-000000000001", lease_until: "2026-11-01T20:00:00Z", authority,
        due_on: later ? "2026-11-01" : "2026-10-31", due_at: later ? "2026-11-01T07:00:00Z" : "2026-10-31T07:00:00Z", next_due_at: later ? "2026-11-02T08:00:00Z" : "2026-11-01T07:00:00Z" });
      let earlierFinished = false, laterFinished = false, providerCalls = 0;
      const outcomes: { job: unknown; outcome: unknown; reason: unknown }[] = [];
      const route = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), app: () => ({ id: "770001", secret: "fixture-app" }), audit: async () => true,
        fetch: async () => { providerCalls++; throw new Error("Already captured inventory must not be fetched again"); },
        rpc: async (name, args) => {
          const later = args.p_job_id === job(true).job_id;
          const active = job(later);
          let data: unknown;
          if (name === "next_meta_analytics_dispatch_target") data = { state: "not_started" };
          else if (name === "claim_meta_analytics_collection_job") data = laterFinished ? null : job(earlierFinished);
          else if (name.endsWith("_analytics_collection_credential")) data = { job_id: active.job_id, job_generation: 1, authority, access_token: "fixture-token" };
          else if (name.endsWith("_analytics_worker_state")) {
            const dates = later ? ["2026-10-31", "2026-10-30"] : ["2026-10-30", "2026-10-29"];
            const operationKeys = [...dates.map((date) => `account_day:${date}`), ...(platform === "threads" ? ["profile"] : []), ...(later ? [] : keys)];
            if (bound === "unfinished_captures") Date.now = () => started + 21_000;
            data = { checkpoint: { cursor: null, post_ids: later ? [] : ids, pages_fetched: bound === "100_pages" ? 100 : 1, inventory_complete: later, inventory_truncated: !later },
              operations: bound === "unfinished_captures" ? [] : operationKeys.map((key) => ({ operation_key: key, kind: key.startsWith("post:") ? "post" : key === "profile" ? "profile" : "account_day", state: "success", reason: null, last_requested_at: null })) };
          } else if (name.endsWith("_analytics_collection_job")) {
            outcomes.push({ job: active.job_id, outcome: args.p_outcome, reason: args.p_reason });
            if (later) laterFinished = args.p_outcome === "success";
            else earlierFinished = args.p_outcome === "failed";
            data = { job_id: active.job_id, job_generation: 1, state: args.p_outcome, on_time: false, due_at: active.due_at, next_due_at: active.next_due_at };
          } else throw new Error(`Unexpected database operation: ${name}`);
          return { data, error: null };
        } });
      try {
        const response = await route(new Request("https://analytics.invalid", { method: "POST", body: JSON.stringify({ action: "drain", platform }) }));
        const receipt = await response.json();
        assertEquals(response.status, 200, JSON.stringify(receipt));
        assertEquals(providerCalls, 0);
        if (bound === "unfinished_captures") {
          assertEquals(outcomes, [{ job: job(false).job_id, outcome: "partial", reason: "inventory_truncated" }]);
          assertEquals(earlierFinished, false);
        } else {
          // A worker may yield its platform after partial work; the next
          // invocation must still be able to claim the later due date.
          const resumed = await route(new Request("https://analytics.invalid", { method: "POST", body: JSON.stringify({ action: "drain", platform }) }));
          const nextReceipt = await resumed.json();
          assertEquals(resumed.status, 200);
          assertEquals(outcomes, [{ job: job(false).job_id, outcome: "failed", reason: "inventory_truncated" }, { job: job(true).job_id, outcome: "success", reason: null }]);
          assertEquals(receipt.counts.collected + nextReceipt.counts.collected, 1);
          assertEquals(receipt.counts.partial + nextReceipt.counts.partial, 1);
        }
      } finally { Date.now = originalNow; }
    });
  }
});
