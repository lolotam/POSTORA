import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createOwnedAnalyticsSyncHandler } from "./handler.ts";

Deno.test("retention shares target and physical deletion budgets across both platforms", async (test) => {
  for (const scenario of ["target_cap", "physical_cap", "dry_run", "unknown_write"] as const) {
    await test.step(scenario, async () => {
      let writes = 0;
      const handler = createOwnedAnalyticsSyncHandler({ authorize: () => ({ ok: true }), app: () => null, audit: async () => true,
        rpc: (name, args) => {
          if (name === "list_meta_analytics_retention_targets") return Promise.resolve({ error: null, data: { state: "enabled", targets: Array.from({ length: 30 }, (_unused, index) => ({
            account_id: `${args.p_platform === "facebook" ? "c1" : "c2"}000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`, last_visited_at: null })) } });
          assertEquals(name, "cleanup_meta_analytics_target");
          writes++;
          if (scenario === "unknown_write") return Promise.resolve({ data: null, error: { code: "57014" } });
          const deleted = scenario === "target_cap" ? 0 : writes === 1 ? 300 : 200;
          assertEquals(args.p_limit, writes === 1 || scenario === "target_cap" ? 500 : 200);
          return Promise.resolve({ error: null, data: { deleted, visible_deleted: deleted, skipped: false,
            dry_run: args.p_dry_run, report_revision: 1, floor: args.p_floor } });
        } });
      const response = await handler(new Request("https://owned-analytics.invalid", { method: "POST", body: JSON.stringify({ action: "retention", platform: "all", dryRun: scenario === "dry_run" }) }));
      const receipt = await response.json();
      assertEquals(response.status, scenario === "unknown_write" ? 503 : 200);
      assertEquals(writes, scenario === "target_cap" ? 50 : scenario === "unknown_write" ? 1 : 2);
      assertEquals(receipt.counts.deleted, scenario === "physical_cap" ? 500 : 0);
      assertEquals(receipt.counts.wouldDelete, scenario === "dry_run" ? 500 : 0);
      assertEquals(receipt.status, scenario === "unknown_write" ? "unavailable" : "partial");
    });
  }
});
