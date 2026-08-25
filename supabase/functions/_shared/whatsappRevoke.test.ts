// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { EvolutionApiError } from "./evolutionApi.ts";
import {
  CloudApiTransport,
  createEvolutionTransport,
  supportsMessageRevoke,
} from "./whatsappTransport.ts";
import type { WhatsAppAccountAccess } from "./whatsappWorkspaceAccess.ts";
import {
  canRevokeRow,
  isAlreadyRevokedProviderResponse,
  isRevokeSuccessBody,
  remoteJidForRow,
  remoteNumberFromConversationId,
  revokeWhatsAppMessage,
  WhatsAppRevokeError,
} from "./whatsappRevoke.ts";

const ACCOUNT = "acc-1";
const VIEWER = "viewer-1";

function access(overrides: Partial<WhatsAppAccountAccess> = {}): WhatsAppAccountAccess {
  return {
    accountId: ACCOUNT,
    ownerId: "owner-1",
    workspaceId: "ws-1",
    role: "agent",
    platformUserId: "1555",
    platformUsername: "Shop",
    accessToken: "tok",
    connectionMode: "evolution_qr",
    accountMetadata: {},
    ...overrides,
  };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "row-1",
    social_account_id: ACCOUNT,
    conversation_id: "wa_1555_1999",
    message_id: "3EB0ABC",
    direction: "outbound",
    to_phone: "1999",
    from_phone: "1555",
    revoked_at: null,
    revoked_by: null,
    ...overrides,
  };
}

class FakeAdmin {
  rows: Record<string, unknown>[];
  updates: Record<string, unknown>[] = [];
  failUpdate = false;

  constructor(rows: Record<string, unknown>[] = [row()]) {
    this.rows = rows;
  }

  from(table: string) {
    return new FakeQuery(this, table);
  }
}

class FakeQuery {
  private filters: Array<[string, unknown]> = [];
  private patch: Record<string, unknown> | null = null;

  constructor(private readonly db: FakeAdmin, private readonly table: string) {}

  select(_columns: string) {
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push([column, value]);
    return this;
  }

  update(patch: Record<string, unknown>) {
    this.patch = patch;
    return this;
  }

  maybeSingle() {
    return this.execute().then(({ data }) => ({
      data: Array.isArray(data) ? data[0] ?? null : data,
      error: null,
    }));
  }

  then<T>(resolve: (value: { data: unknown; error: unknown }) => T, reject?: (reason: unknown) => T) {
    return this.execute().then(resolve, reject);
  }

  private execute() {
    if (this.patch) {
      if (this.db.failUpdate) return Promise.resolve({ data: null, error: { message: "update failed" } });
      this.db.updates.push(this.patch);
      const id = this.filters.find(([column]) => column === "id")?.[1];
      const target = this.db.rows.find((item) => item.id === id);
      if (target) Object.assign(target, this.patch);
      return Promise.resolve({ data: null, error: null });
    }
    if (this.table !== "whatsapp_messages") return Promise.resolve({ data: [], error: null });
    const matches = this.db.rows.filter((item) =>
      this.filters.every(([column, value]) => item[column] === value)
    );
    return Promise.resolve({ data: matches, error: null });
  }
}

Deno.test("remoteJid is rebuilt from to_phone, conversation_id, plus prefix, and multi-device", () => {
  assertEquals(
    remoteJidForRow({ to_phone: "1999", conversation_id: "wa_1555_1999" }),
    "1999@s.whatsapp.net",
  );
  assertEquals(
    remoteJidForRow({ to_phone: null, conversation_id: "wa_1555_1999" }),
    "1999@s.whatsapp.net",
  );
  assertEquals(
    remoteJidForRow({ to_phone: "+1999", conversation_id: "wa_1555_+1999" }),
    "1999@s.whatsapp.net",
  );
  assertEquals(
    remoteJidForRow({ to_phone: "1999:12@s.whatsapp.net", conversation_id: "wa_1555_1999" }),
    "1999@s.whatsapp.net",
  );
  assertEquals(remoteNumberFromConversationId("wa_1555_+1999"), "1999");
});

Deno.test("capability truth table across modes and directions", () => {
  const outbound = { direction: "outbound" as const, message_id: "3EB0ABC" };
  const inbound = { direction: "inbound" as const, message_id: "3EB0ABC" };
  const synthetic = { direction: "outbound" as const, message_id: "sched_1" };
  const missing = { direction: "outbound" as const, message_id: null };

  assertEquals(canRevokeRow("evolution_qr", outbound).ok, true);
  assertEquals(canRevokeRow("evolution_qr", inbound).ok, false);
  assertEquals(canRevokeRow("evolution_qr", synthetic).ok, false);
  assertEquals(canRevokeRow("evolution_qr", missing).ok, false);
  assertEquals(canRevokeRow("cloud_api", outbound).ok, false);
  assertEquals(canRevokeRow("coexistence", outbound).ok, false);
  assertEquals(canRevokeRow(null, outbound).ok, false);
});

Deno.test("Evolution already-revoked is a 201 REVOKE body, not a 500", () => {
  // Measured against EvolutionAPI v2.3.x deleteMessage: when the local Message
  // row is already gone it still `return response` from sendMessage({ delete }),
  // which is HTTP 201 with protocolMessage.type === "REVOKE". A 500
  // "Error while deleting message for everyone" + SessionError is a genuine
  // failure and is indistinguishable from other 500s — we do not guess.
  const alreadyGone = {
    key: { remoteJid: "1999@s.whatsapp.net", fromMe: true, id: "BAE5NEW" },
    message: {
      protocolMessage: {
        key: { remoteJid: "1999@s.whatsapp.net", fromMe: true, id: "3EB0ABC" },
        type: "REVOKE",
      },
    },
    messageTimestamp: "1718108455",
    status: "PENDING",
  };
  assertEquals(isRevokeSuccessBody(alreadyGone), true);

  const sessionFailure = new EvolutionApiError(
    "Evolution API request failed with status 500",
    500,
    {
      status: 500,
      error: "Internal Server Error",
      response: { message: ["Error while deleting message for everyone", "SessionError: No sessions"] },
    },
  );
  assertEquals(isAlreadyRevokedProviderResponse(sessionFailure), false);

  const messageMissing = new EvolutionApiError(
    "Evolution API request failed with status 404",
    404,
    { status: 404, error: "Not Found", message: "Message not found" },
  );
  assertEquals(isAlreadyRevokedProviderResponse(messageMissing), true);

  const instanceMissing = new EvolutionApiError(
    "Evolution API request failed with status 404",
    404,
    { status: 404, error: "Not Found", message: "Instance postora_acc-1 not found" },
  );
  assertEquals(isAlreadyRevokedProviderResponse(instanceMissing), false);
});

Deno.test("revoke rejects cloud_api, coexistence, inbound, and synthetic ids", async () => {
  const cases: Array<[Partial<WhatsAppAccountAccess>, Record<string, unknown>]> = [
    [{ connectionMode: "cloud_api" }, {}],
    [{ connectionMode: "coexistence" }, {}],
    [{}, { direction: "inbound" }],
    [{}, { message_id: null }],
    [{}, { message_id: "sched_abc" }],
  ];
  for (const [accessOverrides, rowOverrides] of cases) {
    const error = await assertRejects(
      () => revokeWhatsAppMessage(new FakeAdmin([row(rowOverrides)]), access(accessOverrides), VIEWER, {
        messageRowId: "row-1",
      }, { resolveTransport: async () => createEvolutionTransport({
        deleteMessageForEveryone: async () => {
          throw new Error("must not call provider");
        },
      } as any, "inst") }),
      WhatsAppRevokeError,
    );
    assertEquals(error.error_type, "UNSUPPORTED_CAPABILITY");
  }
});

Deno.test("a second revoke is a no-op success and does not call the provider", async () => {
  let called = false;
  const db = new FakeAdmin([row({ revoked_at: "2026-08-25T13:00:00.000Z", revoked_by: VIEWER })]);
  const result = await revokeWhatsAppMessage(db, access(), VIEWER, { messageRowId: "row-1" }, {
    resolveTransport: async () => createEvolutionTransport({
      deleteMessageForEveryone: async () => {
        called = true;
      },
    } as any, "inst"),
  });
  assertEquals(result, { success: true, revoked_at: "2026-08-25T13:00:00.000Z" });
  assertEquals(called, false);
  assertEquals(db.updates.length, 0);
});

Deno.test("an already-revoked provider 404 becomes a local tombstone rather than an error", async () => {
  const db = new FakeAdmin([row()]);
  const result = await revokeWhatsAppMessage(db, access(), VIEWER, { messageRowId: "row-1" }, {
    now: () => new Date("2026-08-25T14:00:00.000Z"),
    resolveTransport: async () => createEvolutionTransport({
      deleteMessageForEveryone: async () => {
        throw new EvolutionApiError("Evolution API request failed with status 404", 404, {
          status: 404,
          error: "Not Found",
          message: "Message not found",
        });
      },
    } as any, "inst"),
  });
  assertEquals(result.success, true);
  assertEquals(result.revoked_at, "2026-08-25T14:00:00.000Z");
  assertEquals(db.updates[0], { revoked_at: "2026-08-25T14:00:00.000Z", revoked_by: VIEWER });
});

Deno.test("a 201 REVOKE response stamps the tombstone (the actual already-gone Evolution shape)", async () => {
  const db = new FakeAdmin([row()]);
  const result = await revokeWhatsAppMessage(db, access(), VIEWER, { messageRowId: "row-1" }, {
    now: () => new Date("2026-08-25T14:00:00.000Z"),
    resolveTransport: async () => createEvolutionTransport({
      deleteMessageForEveryone: async () => ({
        message: { protocolMessage: { type: "REVOKE" } },
        status: "PENDING",
      }),
    } as any, "inst"),
  });
  assertEquals(result.revoked_at, "2026-08-25T14:00:00.000Z");
  assertEquals(db.updates.length, 1);
});

Deno.test("a SessionError 500 is a typed refusal, not a tombstone", async () => {
  const db = new FakeAdmin([row()]);
  const error = await assertRejects(
    () => revokeWhatsAppMessage(db, access(), VIEWER, { messageRowId: "row-1" }, {
      resolveTransport: async () => createEvolutionTransport({
        deleteMessageForEveryone: async () => {
          throw new EvolutionApiError("Evolution API request failed with status 500", 500, {
            status: 500,
            error: "Internal Server Error",
            response: { message: ["Error while deleting message for everyone", "SessionError: No sessions"] },
          });
        },
      } as any, "inst"),
    }),
    WhatsAppRevokeError,
  );
  assertEquals(error.error_type, "PROVIDER_REFUSED");
  assertEquals(db.updates.length, 0);
});

Deno.test("wrong-account rows are refused before the provider is called", async () => {
  let called = false;
  const db = new FakeAdmin([row({ social_account_id: "other-account" })]);
  await assertRejects(
    () => revokeWhatsAppMessage(db, access(), VIEWER, { messageRowId: "row-1" }, {
      resolveTransport: async () => createEvolutionTransport({
        deleteMessageForEveryone: async () => {
          called = true;
        },
      } as any, "inst"),
    }),
    Error,
    "Message not found",
  );
  assertEquals(called, false);
});

Deno.test("CloudApiTransport does not implement revoke; EvolutionTransport does", () => {
  const cloud = new CloudApiTransport({
    id: ACCOUNT,
    platform_user_id: "1555",
    access_token: "tok",
    connection_mode: "cloud_api",
  });
  const evolution = createEvolutionTransport({
    deleteMessageForEveryone: async () => ({}),
  } as any, "inst");
  assertEquals(supportsMessageRevoke(cloud), false);
  assertEquals(supportsMessageRevoke(evolution), true);
  assertEquals("revokeMessage" in cloud, false);
});
