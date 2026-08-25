// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  getWhatsAppConversationState,
  setWhatsAppMessageFlag,
} from "./whatsappConversationState.ts";
import type { WhatsAppAccountAccess } from "./whatsappWorkspaceAccess.ts";

const ACCOUNT = "acc-1";
const CONV = "wa_1555_1999";
const OWNER = "owner-1";
const VIEWER_A = "viewer-a";
const VIEWER_B = "viewer-b";

function access(overrides: Partial<WhatsAppAccountAccess> = {}): WhatsAppAccountAccess {
  return {
    accountId: ACCOUNT,
    ownerId: OWNER,
    workspaceId: "ws-1",
    role: "viewer",
    platformUserId: "1555",
    platformUsername: "Shop",
    accessToken: "tok",
    connectionMode: "evolution_qr",
    accountMetadata: {},
    ...overrides,
  };
}

interface MessageRow {
  id: string;
  social_account_id: string;
  conversation_id: string;
  message_text?: string | null;
  timestamp?: string | null;
  media_type?: string | null;
  revoked_at?: string | null;
  revoked_by?: string | null;
  status?: string | null;
  media_understanding?: string | null;
  [key: string]: unknown;
}

interface FlagRow {
  user_id: string;
  message_row_id: string;
  pinned_at: string | null;
  hidden_at: string | null;
  [key: string]: unknown;
}

function message(overrides: Partial<MessageRow> = {}): MessageRow {
  return {
    id: "row-1",
    social_account_id: ACCOUNT,
    conversation_id: CONV,
    message_text: "hello from the other side",
    timestamp: "2026-08-25T12:00:00.000Z",
    media_type: null,
    revoked_at: null,
    revoked_by: null,
    status: "delivered",
    media_understanding: null,
    ...overrides,
  };
}

class FakeAdmin {
  messages: MessageRow[];
  flags: FlagRow[];
  upserts: Record<string, unknown>[] = [];

  constructor(opts: { messages?: MessageRow[]; flags?: FlagRow[] } = {}) {
    this.messages = opts.messages ?? [];
    this.flags = opts.flags ?? [];
  }

  from(table: string) {
    return new FakeQuery(this, table);
  }
}

class FakeQuery {
  private filters: Array<[string, string, unknown]> = [];
  private inFilters: Array<[string, unknown[]]> = [];
  private notNull: string[] = [];
  private patch: Record<string, unknown> | null = null;
  private returning = false;

  constructor(private readonly db: FakeAdmin, private readonly table: string) {}

  select(_columns: string) {
    this.returning = true;
    return this;
  }

  eq(column: string, value: unknown) {
    this.filters.push(["eq", column, value]);
    return this;
  }

  in(column: string, values: unknown[]) {
    this.inFilters.push([column, values]);
    return this;
  }

  not(column: string, op: string, value: unknown) {
    if (op === "is" && value === null) this.notNull.push(column);
    return this;
  }

  upsert(row: Record<string, unknown>) {
    this.patch = row;
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

  private matchesMessage(row: MessageRow): boolean {
    for (const [, column, value] of this.filters) {
      if ((row as Record<string, unknown>)[column] !== value) return false;
    }
    for (const [column, values] of this.inFilters) {
      if (!values.includes((row as Record<string, unknown>)[column])) return false;
    }
    return true;
  }

  private matchesFlag(row: FlagRow): boolean {
    for (const [, column, value] of this.filters) {
      if ((row as Record<string, unknown>)[column] !== value) return false;
    }
    for (const [column, values] of this.inFilters) {
      if (!values.includes((row as Record<string, unknown>)[column])) return false;
    }
    for (const column of this.notNull) {
      if ((row as Record<string, unknown>)[column] == null) return false;
    }
    return true;
  }

  private execute(): Promise<{ data: unknown; error: null }> {
    if (this.patch && this.table === "whatsapp_message_flags") {
      this.db.upserts.push(this.patch);
      const userId = String(this.patch.user_id);
      const messageRowId = String(this.patch.message_row_id);
      const next: FlagRow = {
        user_id: userId,
        message_row_id: messageRowId,
        pinned_at: (this.patch.pinned_at as string | null) ?? null,
        hidden_at: (this.patch.hidden_at as string | null) ?? null,
      };
      const index = this.db.flags.findIndex((row) =>
        row.user_id === userId && row.message_row_id === messageRowId
      );
      if (index >= 0) this.db.flags[index] = next;
      else this.db.flags.push(next);
      return Promise.resolve({ data: next, error: null });
    }
    if (this.table === "whatsapp_messages") {
      return Promise.resolve({ data: this.db.messages.filter((row) => this.matchesMessage(row)), error: null });
    }
    if (this.table === "whatsapp_message_flags") {
      return Promise.resolve({ data: this.db.flags.filter((row) => this.matchesFlag(row)), error: null });
    }
    return Promise.resolve({ data: [], error: null });
  }
}

Deno.test("conversation state returns only the acting viewer's flags, scoped to the conversation", async () => {
  const db = new FakeAdmin({
    messages: [
      message({ id: "in-conv" }),
      message({ id: "other-conv", conversation_id: "wa_1555_other" }),
    ],
    flags: [
      { user_id: VIEWER_A, message_row_id: "in-conv", pinned_at: "2026-08-25T12:01:00.000Z", hidden_at: null },
      { user_id: VIEWER_B, message_row_id: "in-conv", pinned_at: null, hidden_at: "2026-08-25T12:02:00.000Z" },
      { user_id: VIEWER_A, message_row_id: "other-conv", pinned_at: "2026-08-25T12:03:00.000Z", hidden_at: null },
    ],
  });

  const state = await getWhatsAppConversationState(db, access(), VIEWER_A, {
    conversationId: CONV,
    messageRowIds: ["in-conv", "other-conv"],
  });

  assertEquals(state.flags, [{
    message_row_id: "in-conv",
    pinned_at: "2026-08-25T12:01:00.000Z",
    hidden_at: null,
  }]);
  assertEquals(state.pinned.map((row) => row.message_row_id), ["in-conv"]);
  assertEquals(state.mutable.map((row) => row.message_row_id), ["in-conv"]);
});

Deno.test("a teammate sees their own flags but the same mutable overlay", async () => {
  const db = new FakeAdmin({
    messages: [message({
      id: "row-1",
      revoked_at: "2026-08-25T13:00:00.000Z",
      revoked_by: VIEWER_A,
      status: "read",
      media_understanding: "a cat on a sofa",
    })],
    flags: [
      { user_id: VIEWER_A, message_row_id: "row-1", pinned_at: "2026-08-25T12:01:00.000Z", hidden_at: null },
    ],
  });

  const forA = await getWhatsAppConversationState(db, access(), VIEWER_A, {
    conversationId: CONV,
    messageRowIds: ["row-1"],
  });
  const forB = await getWhatsAppConversationState(db, access(), VIEWER_B, {
    conversationId: CONV,
    messageRowIds: ["row-1"],
  });

  assertEquals(forA.flags[0]?.pinned_at, "2026-08-25T12:01:00.000Z");
  assertEquals(forB.flags, []);
  assertEquals(forB.pinned, []);
  assertEquals(forA.mutable, forB.mutable);
  assertEquals(forB.mutable[0], {
    message_row_id: "row-1",
    revoked_at: "2026-08-25T13:00:00.000Z",
    revoked_by: VIEWER_A,
    status: "read",
    media_understanding: "a cat on a sofa",
  });
});

Deno.test("pinned carries a preview so the bar can render without that message's page", async () => {
  const db = new FakeAdmin({
    messages: [message({
      id: "old-pin",
      message_text: "this is a long enough caption to prove the bar does not need the body",
      timestamp: "2026-08-24T09:00:00.000Z",
    })],
    flags: [
      { user_id: VIEWER_A, message_row_id: "old-pin", pinned_at: "2026-08-25T08:00:00.000Z", hidden_at: null },
    ],
  });

  const state = await getWhatsAppConversationState(db, access(), VIEWER_A, {
    conversationId: CONV,
    messageRowIds: [],
  });

  assertEquals(state.flags, []);
  assertEquals(state.mutable, []);
  assertEquals(state.pinned, [{
    message_row_id: "old-pin",
    preview: "this is a long enough caption to prove the bar does not need the body",
    timestamp: "2026-08-24T09:00:00.000Z",
  }]);
});

Deno.test("mutable reflects a teammate revoke, a webhook status, and a late AI description", async () => {
  const db = new FakeAdmin({
    messages: [message({
      id: "row-1",
      revoked_at: "2026-08-25T13:00:00.000Z",
      revoked_by: VIEWER_B,
      status: "played",
      media_understanding: "written by inboundMediaPipeline",
    })],
  });

  const state = await getWhatsAppConversationState(db, access(), VIEWER_A, {
    conversationId: CONV,
    messageRowIds: ["row-1"],
  });
  assertEquals(state.mutable[0]?.revoked_by, VIEWER_B);
  assertEquals(state.mutable[0]?.status, "played");
  assertEquals(state.mutable[0]?.media_understanding, "written by inboundMediaPipeline");
});

Deno.test("setMessageFlag upserts for the session user and ignores a body user_id", async () => {
  const db = new FakeAdmin({ messages: [message()] });
  const result = await setWhatsAppMessageFlag(db, access(), VIEWER_A, {
    conversationId: CONV,
    messageRowId: "row-1",
    pinned: true,
  });

  assertEquals(result.flag.message_row_id, "row-1");
  assertEquals(typeof result.flag.pinned_at, "string");
  assertEquals(db.upserts[0]?.user_id, VIEWER_A);
  assertEquals(Object.prototype.hasOwnProperty.call(db.upserts[0], "user_id"), true);
  assertEquals(db.flags[0]?.user_id, VIEWER_A);
});

Deno.test("setMessageFlag cannot target another account's row", async () => {
  const db = new FakeAdmin({
    messages: [message({ social_account_id: "someone-else" })],
  });
  let threw = false;
  try {
    await setWhatsAppMessageFlag(db, access(), VIEWER_A, {
      conversationId: CONV,
      messageRowId: "row-1",
      hidden: true,
    });
  } catch (error) {
    threw = error instanceof Error && error.message === "Message not found";
  }
  assertEquals(threw, true);
  assertEquals(db.upserts.length, 0);
});

Deno.test("hiding a pinned message also unpins it", async () => {
  const db = new FakeAdmin({
    messages: [message()],
    flags: [{
      user_id: VIEWER_A,
      message_row_id: "row-1",
      pinned_at: "2026-08-25T12:00:00.000Z",
      hidden_at: null,
    }],
  });
  const result = await setWhatsAppMessageFlag(db, access(), VIEWER_A, {
    conversationId: CONV,
    messageRowId: "row-1",
    hidden: true,
  });
  assertEquals(result.flag.pinned_at, null);
  assertEquals(typeof result.flag.hidden_at, "string");
});
