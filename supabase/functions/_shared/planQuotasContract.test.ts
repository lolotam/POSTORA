import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { walk } from "https://deno.land/std@0.208.0/fs/walk.ts";

// Task 10 contract: edge functions must never write concrete plan quota
// numbers. Limits live on subscription_plans and resolve through
// effective_user_quotas(); a resurrected PLAN_QUOTAS table in an edge
// function would convert subscribers into permanent overrides at the plan
// values of that moment. Test files are excluded only so this guard does not
// match its own assertion string.
const FUNCTIONS_DIR = new URL("../../", import.meta.url);

Deno.test("edge functions: no hardcoded PLAN_QUOTAS table survives anywhere under supabase/functions", async () => {
  const offenders: string[] = [];

  for await (const entry of walk(FUNCTIONS_DIR, { exts: ["ts"], skip: [/\.test\.ts$/] })) {
    if (!entry.isFile) continue;
    const content = await Deno.readTextFile(entry.path);
    if (content.includes("PLAN_QUOTAS")) {
      offenders.push(entry.path);
    }
  }

  assertEquals(
    offenders,
    [],
    `these edge-function files still hardcode PLAN_QUOTAS: ${offenders.join(", ")}`,
  );
});
