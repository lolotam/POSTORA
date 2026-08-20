import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { syncEvolutionAccountConnection } from "./evolutionQrAccount.ts";

interface RecordedUpdate {
  table: string;
  values: Record<string, unknown>;
  id: unknown;
}

// Stands in for the Supabase client -- the database is a system boundary, and the
// assertions below are on the rows it would write, not on how it was called.
function recordingAdmin(): { updates: RecordedUpdate[]; from: (table: string) => unknown } {
  const updates: RecordedUpdate[] = [];
  return {
    updates,
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => ({
        eq: (_column: string, id: unknown) => {
          updates.push({ table, values, id });
          return Promise.resolve({ error: null });
        },
      }),
    }),
  };
}

const PENDING = { id: "acc-1", platform_user_id: "pending_acc-1" };

Deno.test("a linked session names the account from whichever identity source reported it", async (t) => {
  // fetchInstances (the poller path) and connection.update (the webhook path) carry the
  // same linked number under different keys; both must produce the same stored value or
  // the two paths would split one chat across two conversation ids.
  const sources: Array<[string, unknown]> = [
    ["fetchInstances", { ownerJid: "96597950350@s.whatsapp.net", profileName: "Xsellpoint", connectionStatus: "open" }],
    ["connection.update", { wuid: "96597950350@s.whatsapp.net", profileName: "Xsellpoint", state: "open" }],
  ];

  for (const [label, identity] of sources) {
    await t.step(label, async () => {
      const admin = recordingAdmin();
      await syncEvolutionAccountConnection(admin, PENDING, "open", identity);
      assertEquals(admin.updates.length, 1);
      assertEquals(admin.updates[0].table, "social_accounts");
      assertEquals(admin.updates[0].id, "acc-1");
      assertEquals(admin.updates[0].values, {
        is_active: true,
        platform_user_id: "96597950350@s.whatsapp.net",
        platform_username: "Xsellpoint",
      });
    });
  }
});

Deno.test("an already-identified account keeps its number when it reconnects", async () => {
  // The poller re-runs every 2s, so activation must never overwrite a resolved number.
  const admin = recordingAdmin();
  const connected = { id: "acc-2", platform_user_id: "96597950350@s.whatsapp.net" };
  await syncEvolutionAccountConnection(admin, connected, "open", { ownerJid: "99999999@s.whatsapp.net" });
  assertEquals(admin.updates[0].values, { is_active: true });
});

Deno.test("a linked session with no identity payload still activates the account", async () => {
  const admin = recordingAdmin();
  await syncEvolutionAccountConnection(admin, PENDING, "open", null);
  assertEquals(admin.updates[0].values, { is_active: true });
});

Deno.test("a closed session deactivates the account without touching its identity", async () => {
  const admin = recordingAdmin();
  await syncEvolutionAccountConnection(admin, PENDING, "close", null);
  assertEquals(admin.updates.length, 1);
  assertEquals(admin.updates[0].values, { is_active: false });
});

Deno.test("a session still pairing writes nothing at all", async () => {
  const admin = recordingAdmin();
  await syncEvolutionAccountConnection(admin, PENDING, "connecting", null);
  assertEquals(admin.updates, []);
});
