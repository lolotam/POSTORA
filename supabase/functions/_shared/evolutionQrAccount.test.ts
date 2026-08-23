import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  findOwnedEvolutionAccount,
  mergeDisplayName,
  normalizeConnectionName,
  syncEvolutionAccountConnection,
} from "./evolutionQrAccount.ts";

interface RecordedUpdate {
  table: string;
  values: Record<string, unknown>;
  id: unknown;
}

interface RecordedRpc {
  name: string;
  args: Record<string, unknown>;
}

// Stands in for the Supabase client -- the database is a system boundary, and the
// assertions below are on the rows it would write, not on how it was called. The
// optional metadata is what a select of account_metadata would return. Claiming the owner
// number goes through an RPC, so the stub answers it with the number it was asked for,
// which is what activate_evolution_qr_account returns once the merge resolves.
function recordingAdmin(
  metadata: Record<string, unknown> | null = null,
  overrides: { updateError?: unknown; rpcError?: unknown } = {},
) {
  const updates: RecordedUpdate[] = [];
  const rpcs: RecordedRpc[] = [];
  return {
    updates,
    rpcs,
    rpc: (name: string, args: Record<string, unknown>) => {
      rpcs.push({ name, args });
      return Promise.resolve(
        overrides.rpcError
          ? { data: null, error: overrides.rpcError }
          : { data: args.p_owner_number as string, error: null },
      );
    },
    from: (table: string) => ({
      update: (values: Record<string, unknown>) => ({
        eq: (_column: string, id: unknown) => {
          updates.push({ table, values, id });
          return Promise.resolve({ error: overrides.updateError ?? null });
        },
      }),
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: metadata === null ? null : { account_metadata: metadata },
              error: null,
            }),
        }),
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
      // The number is no longer part of this update: claiming it can collide with an
      // earlier connection for the same phone, so it goes through the RPC that merges them.
      assertEquals(admin.updates[0].values, {
        is_active: true,
        platform_username: "Xsellpoint",
      });
      assertEquals(admin.rpcs, [{
        name: "activate_evolution_qr_account",
        args: { p_account_id: "acc-1", p_owner_number: "96597950350" },
      }]);
    });
  }
});

Deno.test("the linked JID is stored as the bare number the inbox expects", async (t) => {
  // 2026-08-21 incident: storing the raw JID broke participantPhone() in messaging-api,
  // so replies from the conversation dialog were addressed to the whole conversation id.
  // Every other connection mode stores digits, and the inbox reads that form back.
  const cases: Array<[string, string, string | undefined]> = [
    ["plain jid", "96597950350@s.whatsapp.net", "96597950350"],
    ["device-suffixed jid", "96597950350:12@s.whatsapp.net", "96597950350"],
    ["bare number", "96597950350", "96597950350"],
    ["group jid", "120363301653814403@g.us", "120363301653814403"],
    ["non-numeric jid", "not-a-number@s.whatsapp.net", undefined],
    ["empty local part", "@s.whatsapp.net", undefined],
  ];

  for (const [label, ownerJid, expected] of cases) {
    await t.step(label, async () => {
      const admin = recordingAdmin();
      await syncEvolutionAccountConnection(admin, PENDING, "open", { ownerJid });
      assertEquals(admin.rpcs[0]?.args.p_owner_number, expected);
    });
  }
});

Deno.test("an already-identified account keeps its number when the same phone reconnects", async () => {
  // The poller re-runs every 2s, so activation must never overwrite a resolved number.
  const admin = recordingAdmin();
  const connected = { id: "acc-2", platform_user_id: "96597950350" };
  await syncEvolutionAccountConnection(admin, connected, "open", { ownerJid: "96597950350@s.whatsapp.net" });
  assertEquals(admin.updates[0].values, { is_active: true });
});

Deno.test("a reconnect from a DIFFERENT number keeps the stored id but flags the mismatch", async () => {
  // This case used to be indistinguishable from the one above, which is the hazard: the
  // stored platform_user_id stays put (conversation ids are built from it), so a rename
  // could quietly present someone else's phone as the same account. Migrating the
  // identity is out of scope; detecting it is not.
  const admin = recordingAdmin();
  const connected = { id: "acc-2", platform_user_id: "96597950350" };
  await syncEvolutionAccountConnection(admin, connected, "open", { ownerJid: "99999999@s.whatsapp.net" });
  assertEquals(admin.updates[0].values, {
    is_active: true,
    account_metadata: { number_mismatch: true },
  });
  // The number itself is deliberately NOT changed, so no identity claim is attempted.
  assertEquals(admin.updates[0].values.platform_user_id, undefined);
  assertEquals(admin.rpcs, []);
});

Deno.test("a rejected write is surfaced instead of being swallowed", async (t) => {
  // 2026-08-23 incident: neither update looked at its result. Claiming a number that another
  // connection of the same user already held raised 23505 against
  // social_accounts_user_id_platform_platform_user_id_key, and the connection stayed inactive
  // on its pending_ id with nothing logged anywhere -- the QR screen simply never finished.
  const states: Array<[string, string, unknown]> = [
    ["activating", "open", { ownerJid: "96597950350@s.whatsapp.net" }],
    ["deactivating", "close", null],
  ];

  for (const [label, state, identity] of states) {
    await t.step(label, async () => {
      const admin = recordingAdmin(null, { updateError: { code: "23505", message: "duplicate key" } });
      await assertRejects(() => syncEvolutionAccountConnection(admin, PENDING, state, identity));
      // The identity claim is never attempted once the row itself could not be written.
      assertEquals(admin.rpcs, []);
    });
  }
});

Deno.test("a rejected identity claim is surfaced instead of being swallowed", async () => {
  // The claim is the statement that can collide, so its error is the one that must not be
  // lost: swallowing it is what left a paired session stuck on its placeholder id.
  const admin = recordingAdmin(null, { rpcError: { code: "23505", message: "duplicate key" } });
  await assertRejects(
    () => syncEvolutionAccountConnection(admin, PENDING, "open", { ownerJid: "96597950350@s.whatsapp.net" }),
  );
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

Deno.test("activation reports the number it stored so callers stop using the placeholder", async (t) => {
  // 2026-08-21 review finding: the caller passes an account loaded before activation, so on
  // the first "open" its platform_user_id is still pending_<uuid>. The history sweep builds
  // conversation ids from that value, and importing under the placeholder writes every chat
  // under an id no reply path can parse -- then marks the sweep complete.
  const cases: Array<[string, { id: string; platform_user_id: string }, string, unknown, string]> = [
    ["newly linked", PENDING, "open", { ownerJid: "96597950350@s.whatsapp.net" }, "96597950350"],
    ["already identified", { id: "acc-2", platform_user_id: "96597950350" }, "open", { ownerJid: "999@s.whatsapp.net" }, "96597950350"],
    ["no identity payload", PENDING, "open", null, "pending_acc-1"],
    ["closing session", PENDING, "close", null, "pending_acc-1"],
    ["still pairing", PENDING, "connecting", null, "pending_acc-1"],
  ];

  for (const [label, account, state, identity, expected] of cases) {
    await t.step(label, async () => {
      const admin = recordingAdmin();
      assertEquals(await syncEvolutionAccountConnection(admin, account, state, identity), expected);
    });
  }
});
