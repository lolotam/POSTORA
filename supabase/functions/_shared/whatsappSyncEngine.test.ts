import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { syncEvolutionHistory } from "./whatsappSyncEngine.ts";

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
function fakeAdmin(seed: Record<string, any[]> = {}) {
  const writes: Write[] = [];
  const from = (table: string) => {
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      then: (resolve: (value: unknown) => void) => resolve({ data: seed[table] ?? [], error: null }),
      upsert: (rows: any[]) => {
        writes.push({ table, rows });
        return Promise.resolve({ error: null });
      },
      update: () => chain,
    };
    return chain;
  };
  return { writes, from };
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
      return Promise.resolve(options.messages?.[remoteJid] ?? []);
    },
  } as any;
}

function rowsFor(admin: { writes: Write[] }, table: string): any[] {
  return admin.writes.filter((write) => write.table === table).flatMap((write) => write.rows);
}

Deno.test("only chats that can be replied to are imported", async () => {
  // Group and privacy JIDs carry no phone number, so their digits would collide inside the
  // wa_<owner>_<number> id and the conversation could not be answered.
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
  assertEquals(outcome.chatsSkipped, 2);
  assertEquals(rowsFor(admin, "messaging_cache")[0].conversation_id, "wa_96597950350_96555683677");
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

  const cache = rowsFor(admin, "messaging_cache");
  assertEquals(cache.find((r) => r.conversation_id.endsWith("96560000096")).participant_name, "Abu Tork");
  assertEquals(cache.find((r) => r.conversation_id.endsWith("96555683677")).participant_name, "96555683677");
  // Only the genuinely named contact is worth writing to the CRM.
  assertEquals(rowsFor(admin, "whatsapp_contacts").map((r) => r.display_name), ["Abu Tork"]);
});

Deno.test("a sweep never clears unread messages that arrived after linking", async () => {
  // Evolution reports unreadCount 0 for every chat, so adopting its value on a
  // conversation Postora already tracks would wipe real unread state.
  const admin = fakeAdmin({
    messaging_cache: [{
      conversation_id: "wa_96597950350_96555683677",
      unread_count: 4,
      last_message_at: "2020-01-01T00:00:00.000Z",
      participant_name: "Abu Tork",
    }],
  });
  await syncEvolutionHistory({
    admin,
    api: fakeApi({ chats: [chat("96555683677@s.whatsapp.net")] }),
    account: ACCOUNT,
    instanceName: "postora_acc-1",
  });

  assertEquals(rowsFor(admin, "messaging_cache")[0].unread_count, 4);
});

Deno.test("older history does not overwrite what the live webhook already wrote", async () => {
  const admin = fakeAdmin({
    messaging_cache: [{
      conversation_id: "wa_96597950350_96555683677",
      unread_count: 1,
      last_message_at: "2099-01-01T00:00:00.000Z",
      participant_name: "Abu Tork",
    }],
  });
  await syncEvolutionHistory({
    admin,
    api: fakeApi({ chats: [chat("96555683677@s.whatsapp.net")] }),
    account: ACCOUNT,
    instanceName: "postora_acc-1",
  });

  assertEquals(rowsFor(admin, "messaging_cache"), []);
});

Deno.test("a name the user edited in the CRM outranks the one WhatsApp reports", async () => {
  const admin = fakeAdmin({
    whatsapp_contacts: [{ phone_number: "96560000096", display_name: "Best Customer" }],
  });
  await syncEvolutionHistory({
    admin,
    api: fakeApi({
      chats: [chat("96560000096@s.whatsapp.net")],
      contacts: [{ remoteJid: "96560000096@s.whatsapp.net", pushName: "Abu Tork" }],
    }),
    account: ACCOUNT,
    instanceName: "postora_acc-1",
  });

  assertEquals(rowsFor(admin, "whatsapp_contacts"), []);
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

  const message = rowsFor(admin, "whatsapp_messages")[0];
  assertEquals(message.from_phone, "96597950350");
  assertEquals(message.to_phone, "96555683677");
  assertEquals(message.direction, "outbound");
  assertEquals(message.conversation_id, "wa_96597950350_96555683677");
});
