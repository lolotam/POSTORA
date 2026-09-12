import {
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";

// Text assertions for 20260910130000_partner_connection_events.sql.
//
// The migration widens the partner_webhooks_events_certified CHECK to permit
// three connection-lifecycle event types while keeping every existing one.
// Asserted against the migration TEXT rather than a live database, matching
// the precedent (partnerPlatformTierMigration.test.ts), so the check runs in
// the ordinary edge-function suite with no Postgres available.

const migrationUrl = new URL(
  "../../migrations/20260910130000_partner_connection_events.sql",
  import.meta.url,
);

/** The eight event types certified before this migration. None may be lost. */
const PRE_EXISTING_EVENTS = [
  "webhook.test",
  "message.received",
  "message.accepted",
  "message.delivered",
  "message.read",
  "message.failed",
  "account.reauthorization_required",
  "post.scheduled",
] as const;

/** The three event types this migration certifies. Nothing more. */
const NEW_EVENTS = [
  "whatsapp_number.connected",
  "whatsapp_number.disconnected",
  "history_sync.completed",
] as const;

async function migrationSql(): Promise<string> {
  return await Deno.readTextFile(migrationUrl);
}

Deno.test("C1: the migration asserts the constraint exists before dropping it", async () => {
  const sql = await migrationSql();

  // A mis-ordered run must fail loudly instead of silently creating a
  // constraint that permits everything.
  assertMatch(
    sql,
    /IF v_def IS NULL THEN\s+RAISE EXCEPTION 'partner_webhooks_events_certified is missing/i,
    "must raise a clear exception when partner_webhooks_events_certified is absent",
  );
  assertStringIncludes(
    sql,
    "DROP CONSTRAINT partner_webhooks_events_certified",
    "must drop the existing certified-events constraint before re-adding it",
  );
});

Deno.test("C2: the re-added predicate still requires a non-empty events array", async () => {
  const sql = await migrationSql();

  // Dropping this clause while widening the array would let a subscription
  // hold no events at all -- a subscription that can never fire and never
  // errors.
  assertMatch(
    sql,
    /ADD CONSTRAINT partner_webhooks_events_certified[\s\S]*?cardinality\(events\) > 0/i,
    "the re-added CHECK must keep cardinality(events) > 0",
  );
});

Deno.test("C3: all eight pre-existing event names are present", async () => {
  const sql = await migrationSql();

  // An omitted entry NARROWS the constraint and breaks every live
  // subscription holding that event.
  for (const event of PRE_EXISTING_EVENTS) {
    assertStringIncludes(
      sql,
      `'${event}'`,
      `pre-existing event ${event} must be carried across the widening`,
    );
  }
});

Deno.test("C4: the three new connection event names are present", async () => {
  const sql = await migrationSql();

  for (const event of NEW_EVENTS) {
    assertStringIncludes(
      sql,
      `'${event}'`,
      `new event ${event} must be added by this migration`,
    );
  }
});

Deno.test("C5: whatsapp_number.pairing_expired is absent (it has no producer)", async () => {
  const sql = await migrationSql();

  // QR expiry is observed by a poll and recorded as no transition anywhere,
  // so nothing would produce this event. Certifying it would publish a
  // promise that is never kept.
  assertEquals(
    sql.includes("whatsapp_number.pairing_expired"),
    false,
    "whatsapp_number.pairing_expired must NOT be certified -- it has no producer",
  );
});

Deno.test("C6: the statement targets public.partner_webhooks", async () => {
  const sql = await migrationSql();

  assertMatch(
    sql,
    /ALTER TABLE public\.partner_webhooks/i,
    "the constraint widening must target public.partner_webhooks",
  );
});
