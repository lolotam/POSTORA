import { assertEquals, assertRejects, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ReconnectError,
  reconnectSocialAccountInPlace,
  resolveReconnectIdentity,
} from "./socialAccountReconnect.ts";

type Row = Record<string, unknown>;

interface Update {
  filters: Record<string, unknown>;
  values: Row;
}

/**
 * Stands in for the Supabase client. Reads resolve against `rows` with the
 * equality/inequality filters the helper applied; updates are recorded so a
 * test can assert what landed on which row. The database is a boundary, so
 * nothing here checks how the builder was chained beyond those filters.
 */
function fakeAdmin(rows: Row[]) {
  const updates: Update[] = [];
  const matches = (row: Row, eq: Record<string, unknown>, neq: Record<string, unknown>) =>
    Object.entries(eq).every(([column, value]) => row[column] === value) &&
    Object.entries(neq).every(([column, value]) => row[column] !== value);

  // deno-lint-ignore no-explicit-any
  const builder = (state: { eq: Row; neq: Row; values?: Row }): any => ({
    select: () => builder(state),
    update: (values: Row) => builder({ ...state, values }),
    eq: (column: string, value: unknown) => builder({ ...state, eq: { ...state.eq, [column]: value } }),
    neq: (column: string, value: unknown) => builder({ ...state, neq: { ...state.neq, [column]: value } }),
    maybeSingle: () => {
      const match = rows.find((row) => matches(row, state.eq, state.neq));
      return Promise.resolve({ data: match ?? null, error: null });
    },
    then: (resolve: (v: { error: null }) => void) => {
      // Awaiting the builder after `.update()` executes it.
      if (state.values) {
        updates.push({ filters: state.eq, values: state.values });
        for (const row of rows) {
          if (matches(row, state.eq, state.neq)) Object.assign(row, state.values);
        }
      }
      resolve({ error: null });
    },
  });
  return { updates, from: () => builder({ eq: {}, neq: {} }) };
}

const OWNER = "user-1";
const TARGET = {
  id: "acct-old",
  user_id: OWNER,
  platform: "threads",
  platform_user_id: "277",
  platform_username: "eltamlawy_chicks",
  account_metadata: { granted_scopes: ["threads_basic"], keep: true },
};
const IDENTITY = { platformUserId: "367", platformUsername: "eltamlawy_chicks" };
const PATCH = { access_token: "new-token", token_expires_at: "2026-11-04T00:00:00.000Z" };

Deno.test("resolveReconnectIdentity: same id is the same account under every policy", () => {
  const row = { platform_user_id: "277", platform_username: "x" };
  assertEquals(resolveReconnectIdentity(row, { platformUserId: "277", platformUsername: "y" }, "platform_user_id"), "same_id");
  assertEquals(resolveReconnectIdentity(row, { platformUserId: "277", platformUsername: "y" }, "username"), "same_id");
});

Deno.test("resolveReconnectIdentity: a changed id is rejected under the strict policy", () => {
  const row = { platform_user_id: "277", platform_username: "same" };
  const err = assertThrows(
    () => resolveReconnectIdentity(row, { platformUserId: "367", platformUsername: "same" }, "platform_user_id"),
    ReconnectError,
  );
  assertEquals(err.code, "RECONNECT_ACCOUNT_MISMATCH");
});

Deno.test("resolveReconnectIdentity: username policy accepts a new app-scoped id for the same handle", () => {
  // Threads ids are app-scoped: the same account gets a new id after a Meta app
  // change. The handle is the identity that survives that.
  const row = { platform_user_id: "277", platform_username: "Eltamlawy_Chicks" };
  assertEquals(resolveReconnectIdentity(row, { platformUserId: "367", platformUsername: "eltamlawy_chicks" }, "username"), "id_changed");
});

Deno.test("resolveReconnectIdentity: username policy still rejects a different handle", () => {
  const row = { platform_user_id: "277", platform_username: "brand_a" };
  const err = assertThrows(
    () => resolveReconnectIdentity(row, { platformUserId: "367", platformUsername: "brand_b" }, "username"),
    ReconnectError,
  );
  assertEquals(err.code, "RECONNECT_ACCOUNT_MISMATCH");
});

Deno.test("reconnect updates the target row in place and adopts the new id", async () => {
  const rows = [structuredClone(TARGET)];
  const admin = fakeAdmin(rows);

  const result = await reconnectSocialAccountInPlace(admin, {
    socialAccountId: "acct-old",
    userId: OWNER,
    platform: "threads",
    identity: IDENTITY,
    identityPolicy: "username",
    patch: { ...PATCH, account_metadata: { granted_scopes: ["threads_basic", "threads_delete"] } },
  });

  assertEquals(result, { previousPlatformUserId: "277", platformUserId: "367", retiredSiblingId: null });
  assertEquals(admin.updates.length, 1);
  const update = admin.updates[0];
  // Ownership travels with the write, not only with the read.
  assertEquals(update.filters, { id: "acct-old", user_id: OWNER });
  assertEquals(update.values.platform_user_id, "367");
  assertEquals(update.values.access_token, "new-token");
  assertEquals(update.values.needs_reauth, false);
  assertEquals(update.values.failure_count, 0);
  assertEquals(update.values.last_refresh_error, null);
  assertEquals(update.values.is_active, true);
  // Metadata merges over the stored blob rather than replacing it.
  assertEquals(update.values.account_metadata, { keep: true, granted_scopes: ["threads_basic", "threads_delete"] });
  // The row keeps its identity: no new connected_at, no id change.
  assertEquals("connected_at" in update.values, false);
  assertEquals("id" in update.values, false);
});

Deno.test("reconnect retires a sibling already holding the new id before adopting it", async () => {
  // lolotam2's state: an earlier connect inserted a second row under the new
  // app-scoped id. Adopting that id on the target would collide with the
  // unique (user_id, platform, platform_user_id) index, so the sibling is
  // retired first -- hidden (is_active=false) and its id freed, never deleted,
  // because twenty tables cascade on social_accounts.id.
  const rows = [
    structuredClone(TARGET),
    { id: "acct-dup", user_id: OWNER, platform: "threads", platform_user_id: "367", platform_username: "eltamlawy_chicks", is_active: true },
  ];
  const admin = fakeAdmin(rows);

  const result = await reconnectSocialAccountInPlace(admin, {
    socialAccountId: "acct-old",
    userId: OWNER,
    platform: "threads",
    identity: IDENTITY,
    identityPolicy: "username",
    patch: PATCH,
  });

  assertEquals(result.retiredSiblingId, "acct-dup");
  const sibling = rows[1];
  assertEquals(sibling.platform_user_id, "retired_acct-dup");
  assertEquals(sibling.is_active, false);
  assertEquals(rows[0].platform_user_id, "367");
  // Sibling retired before the target adopted the id.
  assertEquals(admin.updates.map((u) => u.filters.id), ["acct-dup", "acct-old"]);
});

Deno.test("reconnect never retires the target itself when the id is unchanged", async () => {
  const rows = [structuredClone(TARGET)];
  const admin = fakeAdmin(rows);

  const result = await reconnectSocialAccountInPlace(admin, {
    socialAccountId: "acct-old",
    userId: OWNER,
    platform: "threads",
    identity: { platformUserId: "277", platformUsername: "eltamlawy_chicks" },
    identityPolicy: "platform_user_id",
    patch: PATCH,
  });

  assertEquals(result.retiredSiblingId, null);
  assertEquals(admin.updates.length, 1);
  assertEquals(admin.updates[0].filters.id, "acct-old");
});

Deno.test("reconnect rejects a row the caller does not own", async () => {
  const admin = fakeAdmin([{ ...structuredClone(TARGET), user_id: "someone-else" }]);
  const err = await assertRejects(
    () =>
      reconnectSocialAccountInPlace(admin, {
        socialAccountId: "acct-old",
        userId: OWNER,
        platform: "threads",
        identity: IDENTITY,
        identityPolicy: "username",
        patch: PATCH,
      }),
    ReconnectError,
  );
  assertEquals(err.code, "RECONNECT_FORBIDDEN");
  assertEquals(admin.updates.length, 0);
});

Deno.test("reconnect rejects a missing row and a platform mismatch", async () => {
  const missing = await assertRejects(
    () =>
      reconnectSocialAccountInPlace(fakeAdmin([]), {
        socialAccountId: "acct-old",
        userId: OWNER,
        platform: "threads",
        identity: IDENTITY,
        identityPolicy: "username",
        patch: PATCH,
      }),
    ReconnectError,
  );
  assertEquals(missing.code, "RECONNECT_ACCOUNT_NOT_FOUND");

  const wrongPlatform = await assertRejects(
    () =>
      reconnectSocialAccountInPlace(fakeAdmin([structuredClone(TARGET)]), {
        socialAccountId: "acct-old",
        userId: OWNER,
        platform: "pinterest",
        identity: IDENTITY,
        identityPolicy: "username",
        patch: PATCH,
      }),
    ReconnectError,
  );
  assertEquals(wrongPlatform.code, "RECONNECT_PLATFORM_MISMATCH");
});
