import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { importEvolutionHistory, syncEvolutionHistory } from "./whatsappSyncEngine.ts";

const ACCOUNT = {
  id: "acc-1",
  user_id: "user-1",
  workspace_id: "ws-1",
  platform_user_id: "96597950350",
};

interface Write {
  table: string;
  rows: any[];
}

// Stands in for the Supabase client. The database is a system boundary, so the assertions
// below are on the rows the sweep would write, not on how the client was called.
function fakeAdmin(options: { anchors?: Record<string, string> } = {}) {
  const writes: Write[] = [];
  const anchors = options.anchors ?? {};
  return {
    writes,
    rpc: (fn: string, args: { p_rows: any[] }) => {
      writes.push({ table: fn, rows: args.p_rows });
      return Promise.resolve({ data: args.p_rows.length, error: null });
    },
    // Models the two shapes the sweep uses on the client:
    //   .from("whatsapp_messages").select(...).eq(...).in("message_id", ids).limit(1)
    //   .from("whatsapp_evolution_instances").update(values).eq(...)
    // `anchors` maps a message id to the conversation the live webhook stored it under.
    from: (table: string) => {
      let ids: string[] = [];
      const chain: any = {
        select: () => chain,
        eq: () => chain,
        in: (_column: string, values: string[]) => {
          ids = values;
          return chain;
        },
        limit: () => {
          const hit = ids.map((id) => anchors[id]).find(Boolean);
          return Promise.resolve({ data: hit ? [{ conversation_id: hit }] : [], error: null });
        },
        update: (values: Record<string, unknown>) => ({
          eq: () => {
            writes.push({ table, rows: [values] });
            return Promise.resolve({ error: null });
          },
        }),
      };
      return chain;
    },
  };
}

function lidMessage(id: string, remoteJid: string, text: string) {
  return {
    key: { id, remoteJid, fromMe: false },
    message: { conversation: text },
    messageTimestamp: 1787268633,
    pushName: "Lid Person",
  };
}

function chat(remoteJid: string, extra: Record<string, unknown> = {}) {
  return {
    remoteJid,
    pushName: null,
    profilePicUrl: null,
    unreadCount: 0,
    lastMessage: { message: { conversation: "latest" }, messageTimestamp: 1787268633 },
    ...extra,
  };
}

function fakeApi(options: {
  chats?: any[];
  contacts?: any[];
  messages?: Record<string, any[]>;
  failOn?: string;
} = {}) {
  return {
    findChats: () => Promise.resolve(options.chats ?? []),
    findContacts: () => Promise.resolve(options.contacts ?? []),
    findMessages: (_instance: string, remoteJid: string) => {
      if (options.failOn === remoteJid) return Promise.reject(new Error("evolution unreachable"));
      // findMessages now returns { records, complete }: the flag is what stops a
      // deadline- or ceiling-truncated chat being recorded as a finished sweep.
      return Promise.resolve({ records: options.messages?.[remoteJid] ?? [], complete: true });
    },
  } as any;
}

function rowsFor(admin: { writes: Write[] }, table: string): any[] {
  return admin.writes.filter((write) => write.table === table).flatMap((write) => write.rows);
}

Deno.test("only chats that can be replied to are imported", async () => {
  // A group has no subscriber number, so its digits would collide inside the
  // wa_<owner>_<number> id and the conversation could not be answered. A LID chat is a real
  // one-to-one conversation that is merely unaddressable, and is counted apart from it.
  const admin = fakeAdmin();
  const outcome = await syncEvolutionHistory({
    admin,
    api: fakeApi({
      chats: [
        chat("96555683677@s.whatsapp.net"),
        chat("120363301653814403@g.us"),
        chat("166095025660123@lid"),
      ],
    }),
    account: ACCOUNT,
    instanceName: "postora_acc-1",
  });

  assertEquals(outcome.chatsDiscovered, 3);
  assertEquals(outcome.chatsImported, 1);
  assertEquals(outcome.chatsSkipped, 1);
  assertEquals(outcome.chatsAwaitingLid, 1);
  assertEquals(rowsFor(admin, "import_whatsapp_conversations")[0].conversation_id, "wa_96597950350_96555683677");
});

Deno.test("a LID chat with a live anchor is imported under the anchored number", async () => {
  // Evolution stores this chat's history under the LID only. One of its message ids was
  // already ingested live (the webhook is phone-normalised), which pins it to a number.
  const admin = fakeAdmin({ anchors: { LIVE1: "wa_96597950350_96555683677" } });
  const outcome = await syncEvolutionHistory({
    admin,
    api: fakeApi({
      chats: [chat("166095025660123@lid")],
      messages: {
        "166095025660123@lid": [
          lidMessage("LIVE1", "166095025660123@lid", "hello"),
          lidMessage("OLD1", "166095025660123@lid", "older"),
        ],
      },
    }),
    account: ACCOUNT,
    instanceName: "postora_acc-1",
  });
  assertEquals(outcome.chatsLidResolved, 1);
  assertEquals(outcome.chatsAwaitingLid, 0);
  assertEquals(outcome.chatsImported, 1);
  const conversations = rowsFor(admin, "import_whatsapp_conversations");
  assertEquals(conversations[0].conversation_id, "wa_96597950350_96555683677");
  const messages = rowsFor(admin, "import_whatsapp_messages");
  assertEquals(messages.length, 2);
  assertEquals(messages.every((row) => row.conversation_id === "wa_96597950350_96555683677"), true);
});

Deno.test("a LID chat with no anchor is counted as waiting, not imported", async () => {
  const admin = fakeAdmin();
  const outcome = await syncEvolutionHistory({
    admin,
    api: fakeApi({
      chats: [chat("166095025660123@lid")],
      messages: { "166095025660123@lid": [lidMessage("X1", "166095025660123@lid", "hi")] },
    }),
    account: ACCOUNT,
    instanceName: "postora_acc-1",
  });
  assertEquals(outcome.chatsAwaitingLid, 1);
  assertEquals(outcome.chatsLidResolved, 0);
  assertEquals(rowsFor(admin, "import_whatsapp_conversations").length, 0);
});

Deno.test("a LID chat is imported under the number its own history reveals", async () => {
  // 2026-08-28: WhatsApp's LID migration left 255 of one account's 258 one-to-one chats
  // addressed as "<id>@lid". Evolution files their history under the LID and repeats the
  // subscriber number on only some keys, so the chat's address has to carry the rest.
  const admin = fakeAdmin();
  const lidJid = "40557493641315@lid";
  const outcome = await syncEvolutionHistory({
    admin,
    api: fakeApi({
      chats: [chat(lidJid, {
        lastMessage: {
          key: { id: "LIVE", remoteJid: lidJid, remoteJidAlt: "96569983891@s.whatsapp.net" },
          message: { conversation: "latest" },
          messageTimestamp: 1787910520,
        },
      })],
      messages: {
        [lidJid]: [
          { key: { id: "OLD", fromMe: false, remoteJid: lidJid }, message: { conversation: "older" }, messageTimestamp: 1787843630 },
          {
            key: { id: "LIVE", fromMe: false, remoteJid: lidJid, remoteJidAlt: "96569983891@s.whatsapp.net" },
            message: { conversation: "latest" },
            messageTimestamp: 1787910520,
          },
        ],
      },
    }),
    account: ACCOUNT,
    instanceName: "postora_acc-1",
  });

  assertEquals(outcome.chatsImported, 1);
  assertEquals(outcome.chatsAwaitingLid, 0);
  // Both messages land in the phone-addressed conversation the live webhook writes to --
  // the sibling without the alternate included.
  assertEquals(
    rowsFor(admin, "import_whatsapp_messages").map((r) => r.conversation_id).sort(),
    ["wa_96597950350_96569983891", "wa_96597950350_96569983891"],
  );
  assertEquals(rowsFor(admin, "import_whatsapp_messages").map((r) => r.from_phone)[0], "96569983891");
});

Deno.test("participant names come from the contact book, not the chat list", async () => {
  // findChats reports no names at all against a live instance; findContacts is the only
  // source. A contact whose name is just their own number is treated as unnamed.
  const admin = fakeAdmin();
  await syncEvolutionHistory({
    admin,
    api: fakeApi({
      chats: [chat("96560000096@s.whatsapp.net"), chat("96555683677@s.whatsapp.net")],
      contacts: [
        { remoteJid: "96560000096@s.whatsapp.net", pushName: "Abu Tork" },
        { remoteJid: "96555683677@s.whatsapp.net", pushName: "96555683677" },
      ],
    }),
    account: ACCOUNT,
    instanceName: "postora_acc-1",
  });

  const cache = rowsFor(admin, "import_whatsapp_conversations");
  assertEquals(cache.find((r) => r.conversation_id.endsWith("96560000096")).participant_name, "Abu Tork");
  assertEquals(cache.find((r) => r.conversation_id.endsWith("96555683677")).participant_name, "96555683677");
  // Only the genuinely named contact is worth writing to the CRM.
  assertEquals(rowsFor(admin, "import_whatsapp_contacts").map((r) => r.display_name), ["Abu Tork"]);
});

Deno.test("one unreachable chat does not abandon the rest of the sweep", async () => {
  const admin = fakeAdmin();
  const outcome = await syncEvolutionHistory({
    admin,
    api: fakeApi({
      chats: [chat("96555683677@s.whatsapp.net"), chat("96560000096@s.whatsapp.net")],
      failOn: "96555683677@s.whatsapp.net",
      messages: {
        "96560000096@s.whatsapp.net": [{
          key: { id: "m1", fromMe: false, remoteJid: "96560000096@s.whatsapp.net" },
          message: { conversation: "hello" },
          messageTimestamp: 1787268633,
        }],
      },
    }),
    account: ACCOUNT,
    instanceName: "postora_acc-1",
  });

  assertEquals(outcome.chatFailures, 1);
  assertEquals(outcome.messagesWritten, 1);
});

Deno.test("imported messages carry the same shape the live webhook writes", async () => {
  // History and live traffic must be indistinguishable once stored, or one conversation
  // renders differently depending on which path delivered each message.
  const admin = fakeAdmin();
  await syncEvolutionHistory({
    admin,
    api: fakeApi({
      chats: [chat("96555683677@s.whatsapp.net")],
      messages: {
        "96555683677@s.whatsapp.net": [{
          key: { id: "OWNED1", fromMe: true, remoteJid: "96555683677@s.whatsapp.net" },
          message: { conversation: "our reply" },
          messageTimestamp: 1787268633,
        }],
      },
    }),
    account: ACCOUNT,
    instanceName: "postora_acc-1",
  });

  const message = rowsFor(admin, "import_whatsapp_messages")[0];
  assertEquals(message.from_phone, "96597950350");
  assertEquals(message.to_phone, "96555683677");
  assertEquals(message.direction, "outbound");
  assertEquals(message.conversation_id, "wa_96597950350_96555683677");
});

Deno.test("a page that repeats a message id is written once", async () => {
  // 2026-08-21 incident: Evolution returned duplicate ids within a single page and Postgres
  // rejected the whole batch with SQLSTATE 21000 ("ON CONFLICT DO UPDATE command cannot
  // affect row a second time"), which cost 247 of 307 chats their messages.
  const admin = fakeAdmin();
  const duplicated = {
    key: { id: "SAME", fromMe: false, remoteJid: "96555683677@s.whatsapp.net" },
    message: { conversation: "hello" },
    messageTimestamp: 1787268633,
  };
  const outcome = await syncEvolutionHistory({
    admin,
    api: fakeApi({
      chats: [chat("96555683677@s.whatsapp.net")],
      messages: { "96555683677@s.whatsapp.net": [duplicated, duplicated, { ...duplicated, key: { ...duplicated.key, id: "OTHER" } }] },
    }),
    account: ACCOUNT,
    instanceName: "postora_acc-1",
  });

  assertEquals(outcome.messagesWritten, 2);
  assertEquals(rowsFor(admin, "import_whatsapp_messages").map((r) => r.message_id).sort(), ["OTHER", "SAME"]);
});

Deno.test("importEvolutionHistory records the outcome with the lease release", async () => {
  const admin = fakeAdmin();
  const baseRpc = admin.rpc;
  (admin as any).rpc = (fn: string, args: any) => {
    if (fn === "claim_whatsapp_history_sync") return Promise.resolve({ data: true, error: null });
    return baseRpc(fn, args);
  };
  await importEvolutionHistory({
    admin,
    api: fakeApi({
      chats: [chat("96555683677@s.whatsapp.net")],
      messages: { "96555683677@s.whatsapp.net": [lidMessage("M1", "96555683677@s.whatsapp.net", "hi")] },
    }),
    account: ACCOUNT,
    instanceName: "postora_acc-1",
  });
  const completion = rowsFor(admin, "whatsapp_evolution_instances")[0];
  assertEquals(completion.sync_started_at, null);
  assertEquals(typeof completion.last_sync_at, "string");
  assertEquals(completion.last_sync_outcome.chatsImported, 1);
  assertEquals(completion.last_sync_outcome.messagesWritten, 1);
  assertEquals(typeof completion.last_sync_outcome.finished_at, "string");
});

Deno.test("a sweep that throws still records the error for the setup page", async () => {
  const admin = fakeAdmin();
  const baseRpc = admin.rpc;
  (admin as any).rpc = (fn: string, args: any) => {
    if (fn === "claim_whatsapp_history_sync") return Promise.resolve({ data: true, error: null });
    return baseRpc(fn, args);
  };
  const api = fakeApi();
  api.findChats = () => Promise.reject(new Error("evolution unreachable"));
  let thrown: unknown = null;
  try {
    await importEvolutionHistory({ admin, api, account: ACCOUNT, instanceName: "postora_acc-1" });
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown instanceof Error, true);
  const completion = rowsFor(admin, "whatsapp_evolution_instances")[0];
  assertEquals(completion.sync_started_at, null);
  assertEquals(completion.last_sync_outcome.error, "evolution unreachable");
  assertEquals("last_sync_at" in completion, false);
});

Deno.test("a sweep is not marked complete until history is actually available", async (t) => {
  // 2026-08-21 review finding: Baileys can publish the chat list before it has loaded any
  // messages. Recording completion on chats alone permanently disabled the retry a warming
  // session depends on. A placeholder owner id must not be imported under at all.
  const cases: Array<[string, string, Record<string, any[]>, boolean]> = [
    ["chats but no messages yet", "96597950350", {}, false],
    ["chats and messages", "96597950350", {
      "96555683677@s.whatsapp.net": [{
        key: { id: "m1", fromMe: false, remoteJid: "96555683677@s.whatsapp.net" },
        message: { conversation: "hello" },
        messageTimestamp: 1787268633,
      }],
    }, true],
    ["owner number not resolved yet", "pending_acc-1", {}, false],
  ];

  for (const [label, platformUserId, messages, expectComplete] of cases) {
    await t.step(label, async () => {
      const updates: Record<string, unknown>[] = [];
      const admin = {
        writes: [] as any[],
        rpc: (fn: string, args: any) => {
          if (fn === "claim_whatsapp_history_sync") return Promise.resolve({ data: true, error: null });
          (admin.writes as any[]).push({ table: fn, rows: args.p_rows });
          return Promise.resolve({ data: args.p_rows.length, error: null });
        },
        from: () => ({
          update: (values: Record<string, unknown>) => ({
            eq: () => {
              updates.push(values);
              return Promise.resolve({ error: null });
            },
          }),
        }),
      };
      await importEvolutionHistory({
        admin,
        api: fakeApi({ chats: [chat("96555683677@s.whatsapp.net")], messages }),
        account: { ...ACCOUNT, platform_user_id: platformUserId },
        instanceName: "postora_acc-1",
      });
      const completion = updates[updates.length - 1];
      assertEquals(Boolean(completion && "last_sync_at" in completion), expectComplete);
    });
  }
});
