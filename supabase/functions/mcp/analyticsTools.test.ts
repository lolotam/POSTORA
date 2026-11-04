import { assertEquals } from "jsr:@std/assert@1";
import { z } from "npm:zod@4.1.12";
import { accountAnalyticsSchema, analyticsSyncSchema, listCompetitorsSchema, trackCompetitorSchema,
  untrackCompetitorSchema, competitorReportSchema, analyzeBrandSchema } from "../_shared/analyticsToolSchemas.ts";
import { toolAllowed } from "./connectionMode.ts";
import { missingScope } from "./toolScopes.ts";

const ACCOUNT = "6ec0bd7f-11c0-43da-975e-2a8ad9ebae0b";
const definitions = [
  ["get_account_analytics", accountAnalyticsSchema, { social_account_id: ACCOUNT, period_days: "all" }, { social_account_id: ACCOUNT, period_days: 2 }],
  ["trigger_analytics_sync", analyticsSyncSchema, { social_account_id: ACCOUNT }, { social_account_id: ACCOUNT, force: true }],
  ["list_competitors", listCompetitorsSchema, { state: "removed", limit: 50 }, { limit: 51 }],
  ["track_competitor", trackCompetitorSchema, { username: " @@Brand.Name " }, { username: "bad..name" }],
  ["untrack_competitor", untrackCompetitorSchema, { watchlist_id: ACCOUNT }, { watchlist_id: "bad" }],
  ["get_competitor_report", competitorReportSchema, { watchlist_id: ACCOUNT, period_days: 7 }, { watchlist_id: ACCOUNT, period_days: 90 }],
  ["analyze_brand", analyzeBrandSchema, { platform: "instagram", handle: "@brand", media_type: "reel", sort: "views" }, { platform: "tiktok", handle: "brand" }],
] as const;

Deno.test("analytics tools register strict, serializable schemas and reject invalid and injected owner arguments", async () => {
  const source = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  const registered = [...source.matchAll(/register\("([a-z0-9_]+)"/g)].map((match) => match[1]);
  for (const [name, schema, valid, invalid] of definitions) {
    assertEquals(registered.includes(name), true, name);
    assertEquals(schema.safeParse(valid).success, true, name);
    assertEquals(schema.safeParse(invalid).success, false, name);
    assertEquals(schema.safeParse({ ...valid, user_id: ACCOUNT }).success, false, name);
    assertEquals(z.toJSONSchema(schema).additionalProperties, false, name);
    assertEquals(missingScope({ kind: "all" }, name), null, name);
    assertEquals(missingScope({ kind: "granted", scopes: new Set() }, name) !== null, true, name);
  }
});

Deno.test("third-party analysis stays separated from tools that write or request collection", () => {
  for (const name of ["get_competitor_report", "analyze_brand"]) {
    assertEquals(toolAllowed("read", name), true);
    assertEquals(toolAllowed("full", name), false);
  }
  assertEquals(toolAllowed("full", "list_competitors"), true);
  assertEquals(toolAllowed("read", "list_competitors"), true);
  for (const name of ["track_competitor", "untrack_competitor", "trigger_analytics_sync"]) {
    assertEquals(toolAllowed("full", name), true);
    assertEquals(toolAllowed("read", name), false);
  }
});
