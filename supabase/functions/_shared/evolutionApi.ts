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

export interface EvolutionSendResult {
  messageId: string | null;
  raw: unknown;
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
  findMessages(instanceName: string, remoteJid: string): Promise<any[]>;
  logout(instanceName: string): Promise<unknown>;
  deleteInstance(instanceName: string): Promise<unknown>;
  sendText(instanceName: string, input: { number: string; text: string }): Promise<EvolutionSendResult>;
  sendMedia(instanceName: string, input: EvolutionMediaInput): Promise<EvolutionSendResult>;
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
            ...(init.body ? { "Content-Type": "application/json" } : {}),
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
        throw new Error(`Evolution API request failed with status ${response.status}`);
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
    // Unlike the other two this answers with a paged envelope, and it ignores `limit` --
    // measured against v2.3.7, a 110-message chat came back as 3 pages of ~40. Only the
    // newest page is imported, so the records are taken straight off the first response.
    findMessages: async (instanceName, remoteJid) => {
      const payload: any = await request(`/chat/findMessages/${encodeURIComponent(instanceName)}`, {
        method: "POST",
        body: JSON.stringify({ where: { key: { remoteJid } } }),
      });
      const records = payload?.messages?.records;
      return Array.isArray(records) ? records : [];
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
