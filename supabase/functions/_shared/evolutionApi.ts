export type EvolutionEvent =
  | "MESSAGES_UPSERT"
  | "CONNECTION_UPDATE"
  | "QRCODE_UPDATED";

export interface EvolutionWebhookConfig {
  url: string;
  headers: { jwt_key: string };
  events: EvolutionEvent[];
}

export interface EvolutionCreateInstanceInput {
  instanceName: string;
  webhook: EvolutionWebhookConfig;
}

export interface EvolutionMediaInput {
  number: string;
  mediaType: "image" | "video" | "document" | "audio";
  media: string;
  caption?: string;
  fileName?: string;
}

export interface EvolutionAudioInput {
  number: string;
  /** Raw bytes. Evolution 2.3.7 ignores a url/base64 body on this route -- see sendWhatsAppAudio. */
  audio: Uint8Array;
  fileName?: string;
  mimeType?: string;
  delay?: number;
}

export interface EvolutionSendResult {
  messageId: string | null;
  raw: unknown;
}

export interface EvolutionRevokeKey {
  id: string;
  remoteJid: string;
  fromMe: boolean;
}

export class EvolutionApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: unknown,
  ) {
    super(message);
    this.name = "EvolutionApiError";
  }
}

export interface FindMessagesOptions {
  /** Epoch ms. Checked between pages so one chat cannot burn the whole sweep budget. */
  deadlineAt?: number;
}

export interface FindMessagesResult {
  records: any[];
  /** false when the walk stopped early (deadline or page ceiling) rather than reaching
   *  the end of the chat. The caller must not record such a sweep as complete. */
  complete: boolean;
}

/** WhatsApp JIDs are phone numbers. Logs keep only enough to correlate a chat across
 *  lines -- the last four digits -- so a support trace never carries a full number. */
function maskJid(remoteJid: string): string {
  const local = remoteJid.split("@")[0].split(":")[0];
  return local.length <= 4 ? "***" : `***${local.slice(-4)}`;
}

// Evolution registers webhook subscriptions under SCREAMING_SNAKE event names but sends
// the dot-lowercase form ("connection.update") in the delivered body, so every consumer
// has to normalize before matching.
export function normalizeEvolutionEvent(event: unknown): string {
  return String(event ?? "").replace(/[.-]/g, "_").toUpperCase();
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface EvolutionApiOptions {
  baseUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export interface EvolutionApi {
  createInstance(input: EvolutionCreateInstanceInput): Promise<unknown>;
  connect(instanceName: string): Promise<unknown>;
  connectionState(instanceName: string): Promise<unknown>;
  fetchInstance(instanceName: string): Promise<unknown>;
  findChats(instanceName: string): Promise<any[]>;
  findContacts(instanceName: string): Promise<any[]>;
  findMessages(instanceName: string, remoteJid: string, options?: FindMessagesOptions): Promise<FindMessagesResult>;
  logout(instanceName: string): Promise<unknown>;
  deleteInstance(instanceName: string): Promise<unknown>;
  sendText(instanceName: string, input: { number: string; text: string }): Promise<EvolutionSendResult>;
  sendMedia(instanceName: string, input: EvolutionMediaInput): Promise<EvolutionSendResult>;
  sendWhatsAppAudio(instanceName: string, input: EvolutionAudioInput): Promise<EvolutionSendResult>;
  deleteMessageForEveryone(instanceName: string, key: EvolutionRevokeKey): Promise<unknown>;
  setWebhook(instanceName: string, webhook: EvolutionWebhookConfig): Promise<unknown>;
}

function requiredSetting(name: string, value: string | undefined): string {
  if (!value?.trim()) throw new Error(`${name} is not configured`);
  return value.replace(/\/$/, "");
}

function createRequestBody(input: EvolutionCreateInstanceInput): Record<string, unknown> {
  return {
    instanceName: input.instanceName,
    integration: "WHATSAPP-BAILEYS",
    qrcode: true,
    webhook: {
      enabled: true,
      url: input.webhook.url,
      webhookByEvents: false,
      webhookBase64: false,
      headers: input.webhook.headers,
      events: input.webhook.events,
    },
  };
}

function sendResult(raw: any): EvolutionSendResult {
  return { messageId: raw?.key?.id || raw?.messages?.[0]?.id || null, raw };
}

export function createEvolutionApi(fetcher: Fetcher = fetch, options: EvolutionApiOptions = {}): EvolutionApi {
  const baseUrl = requiredSetting("EVOLUTION_API_URL", options.baseUrl ?? Deno.env.get("EVOLUTION_API_URL"));
  const apiKey = requiredSetting("EVOLUTION_API_KEY", options.apiKey ?? Deno.env.get("EVOLUTION_API_KEY"));
  const timeoutMs = options.timeoutMs ?? 10_000;

  async function request(path: string, init: RequestInit = {}): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await Promise.race([
        fetcher(`${baseUrl}${path}`, {
          ...init,
          headers: {
            apikey: apiKey,
            Accept: "application/json",
            // FormData must set its own Content-Type: the multipart boundary is generated with
            // the body, and forcing application/json here makes the server parse the parts as
            // JSON and see no file at all.
            ...(init.body && !(init.body instanceof FormData)
              ? { "Content-Type": "application/json" }
              : {}),
            ...(init.headers || {}),
          },
          signal: controller.signal,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Evolution API request timed out")), timeoutMs)
        ),
      ]);
      const body = await Promise.race([
        response.json().catch(() => ({})),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Evolution API request timed out")), timeoutMs)
        ),
      ]);
      if (!response.ok) {
        throw new EvolutionApiError(
          `Evolution API request failed with status ${response.status}`,
          response.status,
          body,
        );
      }
      return body;
    } catch (error) {
      if (error instanceof Error && /timed out|aborted/i.test(error.message)) {
        throw new Error("Evolution API request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    createInstance: (input) => request("/instance/create", {
      method: "POST",
      body: JSON.stringify(createRequestBody(input)),
    }),
    connect: (instanceName) => request(`/instance/connect/${encodeURIComponent(instanceName)}`),
    connectionState: (instanceName) => request(`/instance/connectionState/${encodeURIComponent(instanceName)}`),
    // connectionState reports only the state, so the linked number and profile name
    // have to come from here. The route always answers with a list.
    fetchInstance: async (instanceName) => {
      const payload = await request(`/instance/fetchInstances?instanceName=${encodeURIComponent(instanceName)}`);
      return Array.isArray(payload) ? payload[0] ?? null : payload;
    },
    // Evolution keeps the chat and contact history Baileys pulled off the phone at link
    // time. Nothing is pushed for it, so importing past conversations means reading it.
    findChats: async (instanceName) => {
      const payload = await request(`/chat/findChats/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      return Array.isArray(payload) ? payload : [];
    },
    // findChats reports no participant names at all, so this is the only source for them.
    // The route lives under /chat, not /contact -- the latter answers 404 on v2.3.7.
    findContacts: async (instanceName) => {
      const payload = await request(`/chat/findContacts/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      return Array.isArray(payload) ? payload : [];
    },
    // Unlike the other two this answers with a paged envelope, and it caps a page at its
    // own size rather than the `offset` asked for -- measured against v2.3.7, a
    // 110-message chat came back as 3 pages of ~40 against offset 50. `messages.pages` is
    // therefore the terminator, NOT a short page: stopping on `length < offset` would end
    // every chat at page one and silently restore the single-page behaviour this replaces.
    // All pages accumulate into one array so the caller's single-batch message-id dedup
    // still covers duplicates that straddle a page boundary. `complete: false` marks a
    // deadline or ceiling exit so the caller can refuse to record the sweep as finished.
    findMessages: async (instanceName, remoteJid, options) => {
      const offset = 50;
      const pageCeiling = 20;
      const records: any[] = [];
      for (let page = 1; page <= pageCeiling; page++) {
        const payload: any = await request(`/chat/findMessages/${encodeURIComponent(instanceName)}`, {
          method: "POST",
          body: JSON.stringify({ page, offset, where: { key: { remoteJid } } }),
        });
        // Some deployments ignore `page` and answer with the bare array the chat and
        // contact routes use. That response is everything the server will ever send for
        // this filter -- re-requesting it as pages 2..20 would accumulate the same rows
        // nineteen times over.
        if (Array.isArray(payload)) {
          records.push(...payload);
          return { records, complete: true };
        }
        const pageRecords = payload?.messages?.records;
        if (!Array.isArray(pageRecords)) return { records, complete: true };
        records.push(...pageRecords);

        // `pages` is the authority, and it has to be, because this route caps a page at
        // its own size regardless of the `offset` asked for: measured on v2.3.7 a page
        // comes back with ~40 rows against offset 50. Treating a short page as the last
        // one would therefore stop every chat after page one and quietly reinstate the
        // single-page behaviour this function exists to replace. `pages` is trusted only
        // as a finite positive number, since a garbage value could loop a server that
        // answers every page with the same batch.
        const pages = Number(payload?.messages?.pages);
        if (Number.isFinite(pages) && pages > 0) {
          if (page >= pages) return { records, complete: true };
        } else if (pageRecords.length === 0) {
          // No usable page count: an empty page is the only safe stop signal, because a
          // short-but-non-empty page may still be followed by more.
          return { records, complete: true };
        }

        if (options?.deadlineAt !== undefined && Date.now() >= options.deadlineAt) {
          console.log(
            `[evolution-api] findMessages ${instanceName} ${maskJid(remoteJid)}: out of time after page ${page}`,
          );
          return { records, complete: false };
        }
      }
      console.log(
        `[evolution-api] findMessages ${instanceName} ${maskJid(remoteJid)}: stopped at the ${pageCeiling}-page ceiling`,
      );
      return { records, complete: false };
    },
    logout: (instanceName) => request(`/instance/logout/${encodeURIComponent(instanceName)}`, { method: "DELETE" }),
    deleteInstance: (instanceName) => request(`/instance/delete/${encodeURIComponent(instanceName)}`, { method: "DELETE" }),
    sendText: async (instanceName, input) => sendResult(await request(`/message/sendText/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: JSON.stringify(input),
    })),
    sendMedia: async (instanceName, input) => sendResult(await request(`/message/sendMedia/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: JSON.stringify({
        number: input.number,
        mediatype: input.mediaType,
        media: input.media,
        ...(input.caption ? { caption: input.caption } : {}),
        ...(input.fileName ? { fileName: input.fileName } : {}),
      }),
    })),
    // Multipart, not JSON, and that is not a style choice.
    //
    // Evolution 2.3.7's controller accepts a URL or base64 for this route, but the handler it
    // forwards to reads ONLY the uploaded file:
    //
    //   async audioWhatsapp(e, t) {
    //     if (t?.buffer) i.audio = t.buffer.toString("base64");
    //     else throw new Error("File or buffer is undefined.");
    //
    // so a JSON body always fails however valid its url/base64 looks. Uploading the bytes is
    // the only path that reaches the conversion, and the conversion is what sets ptt: true --
    // without it the recipient gets a file attachment (a paperclip) rather than a voice note.
    sendWhatsAppAudio: async (instanceName, input) => {
      const form = new FormData();
      form.append("number", input.number);
      if (input.delay != null) form.append("delay", String(input.delay));
      form.append(
        "file",
        new File([input.audio as BlobPart], input.fileName ?? "voice-note.ogg", {
          type: input.mimeType ?? "audio/ogg",
        }),
      );
      return sendResult(await request(
        `/message/sendWhatsAppAudio/${encodeURIComponent(instanceName)}`,
        { method: "POST", body: form },
      ));
    },
    deleteMessageForEveryone: (instanceName, key) => request(
      `/chat/deleteMessageForEveryone/${encodeURIComponent(instanceName)}`,
      {
        method: "DELETE",
        body: JSON.stringify(key),
      },
    ),
    setWebhook: (instanceName, webhook) => request(`/webhook/set/${encodeURIComponent(instanceName)}`, {
      method: "POST",
      body: JSON.stringify({
        webhook: {
          enabled: true,
          url: webhook.url,
          webhookByEvents: false,
          webhookBase64: false,
          headers: webhook.headers,
          events: webhook.events,
        },
      }),
    }),
  };
}
