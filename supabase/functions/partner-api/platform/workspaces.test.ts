// deno-lint-ignore-file no-import-prefix
import { assertEquals, assertMatch } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { hashPartnerKey } from "../../_shared/partnerApiKeys.ts";
import { decodeCursor, encodeCursor } from "../v1/pagination.ts";
import { createWorkspace, getWorkspace, listWorkspaces } from "./workspaces.ts";

const ID = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000002";
const AUTHED = {
  record: { id: "platform-key", principalId: "principal", keyPrefix: "pl_live_", scopes: [], rateLimitPerMin: 30, expiresAt: null, revokedAt: null },
  requestId: "workspace-test", rateHeaders: {},
};
const BODY = {
  name: "Tenant A", connection_name: "Support", external_ref: "tenant-a",
  risk_consent: { accepted: true, accepted_by: "Tenant admin", accepted_at: "2026-09-10T00:00:00Z", accepted_ip: "192.0.2.1" },
  consent_version: "direct-qr-v1",
};
function request(body: unknown = BODY) {
  return new Request("https://x/v1/platform/workspaces", { method: "POST", body: JSON.stringify(body) });
}

interface Options {
  rpcError?: boolean; rpcThrows?: boolean; committed?: boolean; readError?: boolean;
  ownerError?: boolean; cleanupError?: boolean; reserveError?: boolean; settleError?: boolean;
  quota?: number; quotaError?: boolean; prior?: boolean;
  attemptReadError?: boolean; collision?: boolean;
}

// Models only the external Auth/PostgREST boundary. Records writes and read
// predicates so recovery cannot pass by deleting first or dropping the owner.
function stub(opts: Options = {}) {
  const events: string[] = [];
  const writes: Record<string, unknown>[] = [];
  const filters: [string, unknown][] = [];
  let attempt: Record<string, unknown> | null = opts.prior ? { id: ID, state: "pending" } : null;
  let persisted: Record<string, unknown> = {};
  let ownerInput: Record<string, unknown> = {};
  const admin = {
    auth: { admin: {
      createUser(input: Record<string, unknown>) {
        events.push("auth.create"); ownerInput = input;
        assertEquals(attempt?.state, "pending", "reservation must precede Auth");
        assertEquals(input.email, `svc+${attempt?.id}@partner.postora.cloud`);
        return Promise.resolve({ data: opts.ownerError ? null : { user: { id: OWNER } }, error: opts.ownerError ? {} : null });
      },
      deleteUser(id: string) { events.push("auth.delete"); assertEquals(id, OWNER); return Promise.resolve({ error: opts.cleanupError ? {} : null }); },
    } },
    rpc(name: string, args: Record<string, unknown>) {
      events.push(name); persisted = args;
      if (opts.rpcThrows) return Promise.reject(new Error("lost response"));
      return Promise.resolve({ data: opts.rpcError ? null : { workspace_id: ID, account_id: ID, key_id: ID }, error: opts.rpcError ? {} : null });
    },
    from(table: string) {
      let patch: Record<string, unknown> | null = null;
      return {
        select() { return this; },
        eq(column: string, value: unknown) { filters.push([column, value]); return this; },
        insert(row: Record<string, unknown>) {
          events.push("reserve"); writes.push(row);
          if (opts.collision) {
            attempt = { id: ID, state: "pending" };
            return Promise.resolve({ error: { code: "23505" } });
          }
          if (!opts.reserveError) attempt = { ...row };
          return Promise.resolve({ error: opts.reserveError ? {} : null });
        },
        update(row: Record<string, unknown>) { patch = row; writes.push(row); return this; },
        maybeSingle() {
          if (table === "partner_provisioning_attempts") {
            if (!patch && opts.attemptReadError) return Promise.resolve({ data: attempt, error: {} });
            if (patch) {
              events.push(patch.state ? "settle" : "link-owner");
              if (opts.settleError && patch.state) return Promise.resolve({ data: null, error: {} });
              attempt = { ...attempt, ...patch };
            }
            return Promise.resolve({ data: attempt, error: null });
          }
          if (table === "user_quotas") return Promise.resolve({ data: { max_social_accounts: opts.quota ?? 3 }, error: opts.quotaError ? {} : null });
          assertEquals(table, "partner_provisioned_workspaces");
          events.push("readback");
          return Promise.resolve({ data: opts.committed ? { workspace_id: ID, external_ref: "tenant-a", created_at: "2026-09-10T00:00:00Z" } : null, error: opts.readError ? {} : null });
        },
      };
    },
  };
  return { admin, events, writes, filters, attempt: () => attempt, persisted: () => persisted, ownerInput: () => ownerInput };
}

Deno.test("provisioning reserves first, binds the owner, and returns a secret whose digest alone reaches SQL", async () => {
  const s = stub();
  const res = await createWorkspace(request(), { ...AUTHED, admin: s.admin }, {});
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.workspace_id, ID);
  assertEquals(body.account_id, ID);
  assertMatch(body.key, /^pk_live_/);
  assertEquals(s.ownerInput().email_confirm, false);
  assertEquals("password" in s.ownerInput(), false);
  assertEquals(s.persisted().p_key_hash, await hashPartnerKey(body.key));
  assertEquals(s.persisted().p_principal_id, "principal");
  assertEquals(s.persisted().p_platform_key_id, "platform-key");
  assertEquals(s.persisted().p_request_id, "workspace-test");
  assertEquals(s.persisted().p_risk_consent_accepted_by, BODY.risk_consent.accepted_by);
  assertEquals(s.persisted().p_consent_version, BODY.consent_version);
  assertEquals(JSON.stringify([s.writes, s.persisted()]).includes(body.key), false);
  assertEquals(s.attempt()?.state, "provisioned");
  assertEquals(s.attempt()?.workspace_id, ID);
  assertEquals(s.events, ["reserve", "auth.create", "link-owner", "provision_partner_tenant", "settle"]);
  assertEquals(res.headers.get("Cache-Control"), "no-store");
});

for (const [label, options, status, code, deleted, state, reason] of [
  ["rollback", { rpcError: true }, 500, "internal_error", true, "failed", "rolled_back"],
  ["committed lost response", { rpcError: true, committed: true }, 409, "idempotency_indeterminate", false, "provisioned", "response_lost"],
  ["thrown lost response", { rpcThrows: true, committed: true }, 409, "idempotency_indeterminate", false, "provisioned", "response_lost"],
  ["failed read-back", { rpcError: true, readError: true, committed: true }, 500, "internal_error", false, "failed", "outcome_unknown"],
  ["cleanup failure", { rpcError: true, cleanupError: true }, 500, "internal_error", true, "failed", "compensation_failed"],
  ["Auth failure", { ownerError: true }, 500, "internal_error", false, "failed", "owner_creation_failed"],
  ["zero quota", { quota: 0 }, 429, "quota_exceeded", true, "failed", "rolled_back"],
  ["quota read failure", { quotaError: true }, 500, "internal_error", true, "failed", "rolled_back"],
] as const) {
  Deno.test(`provisioning ${label} settles recovery without deleting a committed owner`, async () => {
    const s = stub(options);
    const res = await createWorkspace(request(), { ...AUTHED, admin: s.admin }, {});
    assertEquals(res.status, status);
    assertEquals((await res.json()).error.code, code);
    assertEquals(s.events.includes("auth.delete"), deleted);
    if (deleted) assertEquals(s.events.indexOf("readback") < s.events.indexOf("auth.delete"), true);
    if (s.events.includes("readback")) assertEquals(s.filters.some(([key, value]) => key === "owner_user_id" && value === OWNER), true);
    assertEquals(s.attempt()?.state, state);
    assertEquals(s.attempt()?.error, reason);
  });
}

Deno.test("a failed reservation creates no Auth identity", async () => {
  const s = stub({ reserveError: true });
  const res = await createWorkspace(request(), { ...AUTHED, admin: s.admin }, {});
  assertEquals(res.status, 500);
  assertEquals(s.events, ["reserve"]);
});

for (const [label, options, status] of [
  ["attempt read failure", { attemptReadError: true }, 500],
  ["estate read failure", { prior: true, readError: true, committed: true }, 500],
  ["concurrent reservation", { collision: true }, 409],
] as const) {
  Deno.test(`external_ref ${label} never creates another owner`, async () => {
    const s = stub(options);
    const res = await createWorkspace(request(), { ...AUTHED, admin: s.admin }, {});
    assertEquals(res.status, status);
    assertEquals(s.events.includes("auth.create"), false);
  });
}

Deno.test("a failed settlement never returns a secret or deletes the committed owner", async () => {
  const s = stub({ settleError: true });
  const res = await createWorkspace(request(), { ...AUTHED, admin: s.admin }, {});
  assertEquals(res.status, 500);
  assertEquals("key" in await res.json(), false);
  assertEquals(s.events.includes("auth.delete"), false);
});

for (const committed of [true, false]) {
  Deno.test(`external_ref retry ${committed ? "recovers metadata without a secret" : "reserves an unresolved attempt"}`, async () => {
    const s = stub({ prior: true, committed });
    const res = await createWorkspace(request(), { ...AUTHED, admin: s.admin }, {});
    assertEquals(res.status, committed ? 200 : 409);
    const body = await res.json();
    assertEquals("key" in body, false);
    assertEquals(s.events.includes("auth.create"), false);
    assertEquals(s.filters.some(([k, v]) => k === "principal_id" && v === "principal"), true);
    if (committed) assertEquals(body.workspace_id, ID);
  });
}

for (const body of [null, [], { ...BODY, connection_name: "" }, { ...BODY, risk_consent: { accepted: true } }]) {
  Deno.test(`invalid provisioning body ${JSON.stringify(body)} has no side effects`, async () => {
    const res = await createWorkspace(request(body), { ...AUTHED, admin: {} }, {});
    assertEquals(res.status, 400);
  });
}

Deno.test("estate pagination uses both boundary columns in ONE disjunction and principal ownership survives key rotation", async () => {
  const timestamp = "2026-09-10T00:00:00Z";
  const ids = [3, 2, 1].map((n) => ID.slice(0, -1) + n);
  const rows = ids.map((id) => ({ workspace_id: id, external_ref: null, created_at: timestamp }));
  let pageIndex = 0;
  const conditions: string[] = [];
  const orders: string[] = [];
  const principals: unknown[] = [];
  const admin = { from(table: string) {
    assertEquals(table, "partner_provisioned_workspaces");
    return {
      select() { return this; },
      eq(column: string, value: unknown) { assertEquals(column, "principal_id"); principals.push(value); return this; },
      order(column: string, options: unknown) { orders.push(column); assertEquals(options, { ascending: false }); return this; },
      limit(n: number) { assertEquals(n, 3); return this; },
      or(condition: string) { conditions.push(condition); return this; },
      then(resolve: (result: unknown) => unknown) { return Promise.resolve({ data: pageIndex++ === 0 ? rows : rows.slice(2), error: null }).then(resolve); },
    };
  } };
  const first = await listWorkspaces(new Request("https://x?limit=2"), { ...AUTHED, admin }, {});
  const page = await first.json();
  assertEquals(page.data.map((r: { workspace_id: string }) => r.workspace_id), ids.slice(0, 2));
  assertEquals(decodeCursor(page.next_cursor), { timestamp, id: ids[1] });
  const second = await listWorkspaces(new Request(`https://x?limit=2&cursor=${page.next_cursor}`), {
    ...AUTHED, record: { ...AUTHED.record, id: "rotated-platform-key" }, admin,
  }, {});
  assertEquals((await second.json()).next_cursor, null);
  assertEquals(conditions, [`created_at.lt.${timestamp},and(created_at.eq.${timestamp},workspace_id.lt.${ids[1]})`]);
  assertEquals(orders, ["created_at", "workspace_id", "created_at", "workspace_id"]);
  assertEquals(principals, ["principal", "principal"]);
});

for (const [label, row, error, status] of [
  ["outside estate", null, null, 404],
  ["read failed", { workspace_id: ID }, {}, 500],
  ["owned", { workspace_id: ID }, null, 200],
] as const) {
  Deno.test(`get workspace ${label} uses principal and workspace predicates`, async () => {
    const filters: [string, unknown][] = [];
    const admin = { from() { return { select() { return this; }, eq(k: string, v: unknown) { filters.push([k, v]); return this; }, maybeSingle: () => Promise.resolve({ data: row, error }) }; } };
    const res = await getWorkspace(request(), { ...AUTHED, admin }, { id: ID });
    assertEquals(res.status, status);
    assertEquals(filters, [["principal_id", "principal"], ["workspace_id", ID]]);
  });
}

Deno.test("malformed cursor is refused before estate access", async () => {
  const cursor = encodeCursor({ timestamp: "bad", id: ID });
  const res = await listWorkspaces(new Request(`https://x?cursor=${cursor}`), { ...AUTHED, admin: {} }, {});
  assertEquals(res.status, 400);
});

Deno.test("a failed estate listing is an error, never an empty page", async () => {
  const admin = { from() { return {
    select() { return this; }, eq() { return this; }, order() { return this; }, limit() { return this; },
    then(resolve: (result: unknown) => unknown) { return Promise.resolve({ data: [], error: { code: "57014" } }).then(resolve); },
  }; } };
  const res = await listWorkspaces(new Request("https://x"), { ...AUTHED, admin }, {});
  assertEquals(res.status, 500);
  assertEquals((await res.json()).error.code, "internal_error");
});
