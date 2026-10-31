// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  CloudApiTransport,
  createEvolutionTransport,
  supportsVoiceNote,
} from "./whatsappTransport.ts";
import type { WhatsAppAccountAccess } from "./whatsappWorkspaceAccess.ts";
import {
  sendWhatsAppVoice,
  WhatsAppVoiceSendError,
} from "./whatsappVoiceSend.ts";

const ACCOUNT = "acc-1";
const CALLER = "user-uuid";
const OWNER = "owner-1";

function access(overrides: Partial<WhatsAppAccountAccess> = {}): WhatsAppAccountAccess {
  return {
    accountId: ACCOUNT,
    ownerId: OWNER,
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

class FakeAdmin {
  inserts: Record<string, unknown>[] = [];
  upserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  signedUrls: Array<{ path: string; ttl: number }> = [];
  failInsert = false;

  from(table: string) {
    return new FakeQuery(this, table);
  }

  get storage() {
    return {
      from: () => {
        return {
          createSignedUrl: (path: string, ttl: number) => {
            this.signedUrls.push({ path, ttl });
            return Promise.resolve({
              data: { signedUrl: `http://kong:8000/storage/v1/object/sign/media/${path}` },
              error: null,
            });
          },
        };
      },
    };
  }
}

class FakeQuery {
  constructor(private readonly db: FakeAdmin, private readonly table: string) {}

  insert(row: Record<string, unknown>) {
    if (this.db.failInsert) return Promise.resolve({ data: null, error: { message: "insert failed" } });
    this.db.inserts.push(row);
    return Promise.resolve({ data: row, error: null });
  }

  upsert(row: Record<string, unknown>) {
    this.db.upserts.push({ table: this.table, row });
    return Promise.resolve({ data: row, error: null });
  }

  select() {
    return this;
  }

  eq() {
    return this;
  }

  maybeSingle() {
    return Promise.resolve({ data: null, error: null });
  }
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    recipient_phone: "1999",
    media_path: `${CALLER}/whatsapp/outbound/voice.webm`,
    duration_seconds: 7,
    mime_type: "audio/webm;codecs=opus",
    ...overrides,
  };
}

Deno.test("CloudApiTransport does not implement sendVoiceNote; EvolutionTransport does", () => {
  const cloud = new CloudApiTransport({
    id: ACCOUNT,
    platform_user_id: "1555",
    access_token: "tok",
    connection_mode: "cloud_api",
  });
  const evolution = createEvolutionTransport({
    sendWhatsAppAudio: async () => ({ messageId: "aud-1", raw: {} }),
  } as any, "inst");
  assertEquals(supportsVoiceNote(cloud), false);
  assertEquals(supportsVoiceNote(evolution), true);
  assertEquals("sendVoiceNote" in cloud, false);
});

Deno.test("rejects traversal, absolute URLs, and a foreign uid before any fetch", async () => {
  const cases = [
    "../etc/passwd",
    "https://evil.example/audio.ogg",
    "other-user/whatsapp/outbound/voice.webm",
    "/user-uuid/whatsapp/outbound/voice.webm",
  ];
  for (const media_path of cases) {
    let sent = false;
    const error = await assertRejects(
      () => sendWhatsAppVoice(new FakeAdmin(), access(), CALLER, request({ media_path }), {
        upsertOutboundConversation: async () => {},
        resolveTransport: async () => createEvolutionTransport({
          sendWhatsAppAudio: async () => {
            sent = true;
            return { messageId: "x", raw: {} };
          },
        } as any, "inst"),
      }),
      WhatsAppVoiceSendError,
    );
    assertEquals(error.error_type, "VALIDATION_ERROR");
    assertEquals(sent, false);
  }
});

Deno.test("unsupported transport is UNSUPPORTED_CAPABILITY, not a 5xx", async () => {
  const error = await assertRejects(
    () => sendWhatsAppVoice(new FakeAdmin(), access({ connectionMode: "cloud_api" }), CALLER, request(), {
      upsertOutboundConversation: async () => {},
      resolveTransport: async () => new CloudApiTransport({
        id: ACCOUNT,
        platform_user_id: "1555",
        access_token: "tok",
        connection_mode: "cloud_api",
      }),
    }),
    WhatsAppVoiceSendError,
  );
  assertEquals(error.error_type, "UNSUPPORTED_CAPABILITY");
});

// 2026-08-26: this asserted that the signed URL was handed to Evolution with encoding:true.
// Evolution 2.3.7's audio handler reads ONLY an uploaded file -- a url or base64 body throws
// "File or buffer is undefined" -- so the bytes are fetched here and posted as multipart. The
// URL is still minted, because that is how this function reads its own object out of a private
// bucket without letting a caller name an arbitrary URL to fetch.
Deno.test("uploads the recorded bytes and persists the storage path", async () => {
  const db = new FakeAdmin();
  const audioCalls: Array<{ number: string; audio: Uint8Array; fileName?: string }> = [];
  const upserts: Array<{ preview: string; social_account_id: string }> = [];
  const publicUrl = "https://api.postora.cloud/storage/v1/object/sign/media/user-uuid/whatsapp/outbound/voice.webm";

  const result = await sendWhatsAppVoice(db, access(), CALLER, request(), {
    now: () => new Date("2026-08-25T15:00:00.000Z"),
    fetchAudio: async (url) => {
      assertEquals(url, publicUrl);
      return new Response(new Uint8Array([9, 8, 7]));
    },
    signPath: async (_admin, path, ttl) => {
      assertEquals(path, `${CALLER}/whatsapp/outbound/voice.webm`);
      assertEquals(ttl > 0, true);
      return publicUrl;
    },
    resolveTransport: async () => createEvolutionTransport({
      sendWhatsAppAudio: async (_instance: string, input: { number: string; audio: Uint8Array; fileName?: string }) => {
        audioCalls.push(input);
        return { messageId: "3EB0VOICE", raw: { key: { id: "3EB0VOICE" } } };
      },
    } as any, "inst"),
    upsertOutboundConversation: async (_admin, params) => {
      upserts.push({ preview: params.preview, social_account_id: params.social_account_id });
    },
  });

  assertEquals(result, { success: true, message_id: "3EB0VOICE" });
  assertEquals(audioCalls.length, 1);
  assertEquals(audioCalls[0].number, "1999");
  assertEquals(audioCalls[0].audio, new Uint8Array([9, 8, 7]));
  assertEquals(audioCalls[0].fileName, "voice.webm");
  assertEquals(db.inserts.length, 1);
  const row = db.inserts[0];
  assertEquals(row.message_type, "audio");
  assertEquals(row.media_type, "audio");
  assertEquals(row.media_url, `${CALLER}/whatsapp/outbound/voice.webm`);
  assertEquals(row.message_text, "[Voice note]");
  assertEquals(row.direction, "outbound");
  assertEquals(row.media_metadata, {
    mime_type: "audio/webm;codecs=opus",
    duration_seconds: 7,
    ptt: true,
  });
  assertEquals(row.message_id, "3EB0VOICE");
  assertEquals(upserts, [{ preview: "[Voice note]", social_account_id: ACCOUNT }]);
});

Deno.test("rejects a duration past the cap", async () => {
  const error = await assertRejects(
    () => sendWhatsAppVoice(new FakeAdmin(), access(), CALLER, request({ duration_seconds: 301 }), {
      upsertOutboundConversation: async () => {},
      resolveTransport: async () => createEvolutionTransport({
        sendWhatsAppAudio: async () => {
          throw new Error("must not send");
        },
      } as any, "inst"),
    }),
    WhatsAppVoiceSendError,
  );
  assertEquals(error.error_type, "VALIDATION_ERROR");
});
