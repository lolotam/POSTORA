import { assertEquals, assertMatch } from "https://deno.land/std@0.208.0/assert/mod.ts";

// Text assertions follow partnerPlatformTierMigration.test.ts so the ordinary
// Edge suite checks rollout compatibility without requiring Postgres.
const migrationUrl = new URL(
  "../../migrations/20260910140000_human_agent_tenancy.sql",
  import.meta.url,
);

async function migrationSql(): Promise<string> {
  return await Deno.readTextFile(migrationUrl);
}

Deno.test("human-agent expansion keeps both workspace columns nullable", async () => {
  const sql = await migrationSql();
  assertMatch(sql, /alter table public\.whatsapp_assignment_history\s+add column if not exists workspace_id uuid\s+references public\.workspaces\(id\) on delete cascade;/i);
  assertEquals(/not\s+null/i.test(sql), false);
});

Deno.test("history attribution prefers to-agent, from-agent, then actor personal workspace", async () => {
  const sql = await migrationSql();
  const coalesce = sql.match(/set workspace_id = coalesce\(([\s\S]*?)\)\s*where history\.workspace_id is null;/i);
  assertEquals(Boolean(coalesce), true, "the history backfill is not a coalesce over the three sources");
  const branches = coalesce![1];
  // Order is the attribution rule, so assert the positions rather than presence.
  const order = ["history.to_agent_id", "history.from_agent_id", "history.performed_by"].map((term) => branches.indexOf(term));
  assertEquals(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1])), true, branches);
  assertMatch(sql, /where history\.workspace_id is null;/i);
});

Deno.test("the personal-workspace fallback cannot abort the migration on a duplicate", async () => {
  const sql = await migrationSql();
  // Nothing constrains a user to one personal workspace, and a scalar subquery
  // returning two rows raises rather than resolving -- taking the whole
  // deployment down for data the notice above is content to leave unresolved.
  assertMatch(sql, /personal\.is_personal\s+order by personal\.id limit 1\)/i);
});

Deno.test("assignment backfill never rewrites an already resolved workspace", async () => {
  const sql = await migrationSql();
  assertMatch(sql, /update public\.whatsapp_conversation_assignments as assignment\s+set workspace_id = agent\.workspace_id\s+from public\.whatsapp_agents as agent\s+where assignment\.workspace_id is null\s+and assignment\.agent_id = agent\.id;/i);
});

Deno.test("unattributable history is counted without blocking deployment and indexed for tenant reads", async () => {
  const sql = await migrationSql();
  assertMatch(sql, /select count\(\*\) into unresolved_count\s+from public\.whatsapp_assignment_history\s+where workspace_id is null;/i);
  assertMatch(sql, /raise notice '[^']*', unresolved_count;/i);
  assertEquals(/raise\s+exception/i.test(sql), false);
  assertMatch(sql, /create index if not exists \w+\s+on public\.whatsapp_assignment_history \(workspace_id, conversation_id\);/i);
});
