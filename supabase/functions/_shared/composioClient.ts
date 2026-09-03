export const COMPOSIO_API_BASE_URL = "https://backend.composio.dev/api/v3.1";
export const COMPOSIO_API_KEY_HEADER = "x-api-key";
// Underscore, verified live 2026-09-03: the hyphenated path answers a Next.js
// 404 page with HTTP 200, so the only symptom is a JSON parse failure.
export const COMPOSIO_CONNECTED_ACCOUNTS_PATH = "/connected_accounts";
export const COMPOSIO_FILE_UPLOAD_REQUEST_PATH = "/files/upload/request";
/** Composio's docs show both spellings for the id it appends to the callback. */
export const COMPOSIO_CALLBACK_ACCOUNT_PARAMS = ["connectedAccountId", "connected_account_id"] as const;
export const COMPOSIO_CALLBACK_ACCOUNT_PARAM = COMPOSIO_CALLBACK_ACCOUNT_PARAMS[0];
export const COMPOSIO_CALLBACK_STATUS_PARAM = "status";
export const COMPOSIO_BODY_CAP = 64 * 1024;
export const COMPOSIO_REQUEST_TIMEOUT_MS = 5_000;
export const COMPOSIO_INITIATE_REQUEST_FORMAT = {
  authConfig: "auth_config",
  connection: "connection",
  id: "id",
  userId: "user_id",
  callbackUrl: "callback_url",
} as const;

export function redirectUrlFrom(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  if (typeof record.redirect_url === "string") return record.redirect_url;
  return typeof record.redirectUrl === "string" ? record.redirectUrl : null;
}

export function initiateConnectionBody(input: {
  workspaceId: string;
  authConfigId: string;
  callbackUrl: string;
}): Record<string, unknown> {
  return {
    [COMPOSIO_INITIATE_REQUEST_FORMAT.authConfig]: {
      [COMPOSIO_INITIATE_REQUEST_FORMAT.id]: input.authConfigId,
    },
    [COMPOSIO_INITIATE_REQUEST_FORMAT.connection]: {
      [COMPOSIO_INITIATE_REQUEST_FORMAT.userId]: input.workspaceId,
      [COMPOSIO_INITIATE_REQUEST_FORMAT.callbackUrl]: input.callbackUrl,
    },
  };
}

export class ComposioError extends Error {
  constructor(
    public readonly code:
      | "composio_unavailable"
      | "composio_rejected"
      | "composio_timeout",
    public readonly status?: number,
  ) {
    super(code);
    this.name = "ComposioError";
  }
}

export interface ComposioConnectedAccount {
  id: string;
  status: "ACTIVE" | "INITIATED" | "EXPIRED" | "FAILED" | "INACTIVE";
  userId: string;
  authConfigId: string;
  toolkit: string;
  createdAt: string;
  /** Composio's human alias for the account, when the provider supplied one. */
  alias: string | null;
  /** Composio's generated readable id (e.g. "googlesheets_talose-acyl"). */
  wordId: string | null;
  metadata: Record<string, unknown>;
}

export interface ComposioFileUploadTicket {
  /** The value a tool's file input takes as `s3key`. */
  key: string;
  /** Presigned PUT target; `Content-Type` is the only signed header. */
  presignedUrl: string;
}

export interface ComposioToolSchema {
  slug: string;
  description: string;
  inputParameters: Record<string, unknown>;
  version: string;
}

export interface ComposioClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ComposioError("composio_rejected");
  }
  return value as Record<string, unknown>;
}

function stringValue(
  record: Record<string, unknown>,
  ...keys: string[]
): string {
  for (const key of keys) {
    if (typeof record[key] === "string") return record[key];
  }
  return "";
}

/** `auth_config` and `toolkit` arrive as nested objects (live shape, 2026-09-03);
 *  the flat spellings are kept as fallbacks for older payloads. */
function nestedId(row: Record<string, unknown>, key: string, idKey: string, ...flat: string[]): string {
  const nested = row[key];
  if (nested && typeof nested === "object" && !Array.isArray(nested)) {
    const value = (nested as Record<string, unknown>)[idKey];
    if (typeof value === "string") return value;
  }
  return stringValue(row, ...flat);
}

function connectedAccountFrom(payload: unknown): ComposioConnectedAccount {
  const row = objectValue(payload);
  return {
    id: stringValue(row, "id"),
    status: stringValue(row, "status") as ComposioConnectedAccount["status"],
    userId: stringValue(row, "user_id", "userId"),
    authConfigId: nestedId(row, "auth_config", "id", "auth_config_id", "authConfigId"),
    toolkit: nestedId(row, "toolkit", "slug", "toolkit", "toolkit_slug"),
    createdAt: stringValue(row, "created_at", "createdAt"),
    alias: stringValue(row, "alias") || null,
    wordId: stringValue(row, "word_id", "wordId") || null,
    metadata: row.metadata && typeof row.metadata === "object"
      ? row.metadata as Record<string, unknown>
      : {},
  };
}

function itemsFrom(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  const record = objectValue(payload);
  for (const key of ["items", "data"]) {
    if (Array.isArray(record[key])) return record[key];
  }
  return [];
}

export function composioClientFromEnv(
  getEnv: (name: string) => string | undefined = (name) => Deno.env.get(name),
): ComposioClient | null {
  const apiKey = getEnv("COMPOSIO_API_KEY")?.trim();
  return apiKey ? new ComposioClient({ apiKey }) : null;
}

export class ComposioClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: ComposioClientOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = (options.baseUrl ?? COMPOSIO_API_BASE_URL).replace(
      /\/$/,
      "",
    );
    this.#fetch = options.fetch ?? fetch;
  }

  async initiateConnection(input: {
    workspaceId: string;
    authConfigId: string;
    callbackUrl: string;
  }): Promise<{ connectionRequestId: string; redirectUrl: string }> {
    const payload = objectValue(
      await this.#request(
        "POST",
        COMPOSIO_CONNECTED_ACCOUNTS_PATH,
        initiateConnectionBody(input),
      ),
    );
    const redirectUrl = redirectUrlFrom(payload);
    if (!redirectUrl) throw new ComposioError("composio_rejected");
    return {
      connectionRequestId: stringValue(
        payload,
        "id",
        "connection_request_id",
        "connectionRequestId",
      ),
      redirectUrl,
    };
  }

  async getConnectedAccount(id: string): Promise<ComposioConnectedAccount> {
    return connectedAccountFrom(
      await this.#request(
        "GET",
        `${COMPOSIO_CONNECTED_ACCOUNTS_PATH}/${encodeURIComponent(id)}`,
        undefined,
        undefined,
        true,
      ),
    );
  }

  async listConnectedAccounts(
    workspaceId: string,
  ): Promise<ComposioConnectedAccount[]> {
    const query = new URLSearchParams({ user_ids: workspaceId });
    const payload = await this.#request(
      "GET",
      `${COMPOSIO_CONNECTED_ACCOUNTS_PATH}?${query}`,
      undefined,
      undefined,
      true,
    );
    return itemsFrom(payload).map(connectedAccountFrom);
  }

  /**
   * A presigned upload slot for a tool's file input. `md5` is required by
   * Composio's validation (a request without it is a 400) though the presign
   * itself does not enforce it. The caller PUTs the bytes and then passes
   * `{ name, mimetype, s3key: key }` to the tool.
   */
  async requestFileUpload(input: {
    toolkit: string;
    tool: string;
    filename: string;
    mimetype: string;
    md5: string;
  }): Promise<ComposioFileUploadTicket> {
    const payload = objectValue(
      await this.#request("POST", COMPOSIO_FILE_UPLOAD_REQUEST_PATH, {
        toolkit_slug: input.toolkit,
        tool_slug: input.tool,
        filename: input.filename,
        mimetype: input.mimetype,
        md5: input.md5,
      }),
    );
    const key = stringValue(payload, "key");
    const presignedUrl = stringValue(payload, "new_presigned_url", "newPresignedUrl", "presigned_url");
    if (!key || !presignedUrl) throw new ComposioError("composio_rejected");
    return { key, presignedUrl };
  }

  async deleteConnectedAccount(id: string): Promise<void> {
    await this.#request(
      "DELETE",
      `${COMPOSIO_CONNECTED_ACCOUNTS_PATH}/${encodeURIComponent(id)}`,
    );
  }

  async listTools(
    toolkit: string,
    slugs: readonly string[],
    version: string,
  ): Promise<ComposioToolSchema[]> {
    const query = new URLSearchParams({
      toolkit_slug: toolkit,
      tool_slugs: slugs.join(","),
      version,
    });
    const payload = await this.#request(
      "GET",
      `/tools?${query}`,
      undefined,
      undefined,
      true,
    );
    return itemsFrom(payload).map((item) => {
      const row = objectValue(item);
      const input = row.input_parameters ?? row.inputParameters ??
        row.input_schema;
      return {
        slug: stringValue(row, "slug", "name"),
        description: stringValue(row, "description"),
        inputParameters: input && typeof input === "object"
          ? input as Record<string, unknown>
          : {},
        version: stringValue(row, "version") || version,
      };
    });
  }

  async executeTool(input: {
    slug: string;
    version: string;
    workspaceId: string;
    connectedAccountId: string;
    arguments: Record<string, unknown>;
    signal: AbortSignal;
  }): Promise<{ successful: boolean; data: unknown; error?: string }> {
    const payload = objectValue(
      await this.#request(
        "POST",
        `/tools/execute/${encodeURIComponent(input.slug)}`,
        {
          user_id: input.workspaceId,
          connected_account_id: input.connectedAccountId,
          arguments: input.arguments,
          version: input.version,
        },
        input.signal,
      ),
    );
    return {
      successful: payload.successful === true,
      data: payload.data,
      error: typeof payload.error === "string" ? payload.error : undefined,
    };
  }

  async #request(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    retry = false,
  ): Promise<unknown> {
    const attempts = retry ? 2 : 1;
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const response = await this.#fetch(`${this.#baseUrl}${path}`, {
          method,
          headers: {
            [COMPOSIO_API_KEY_HEADER]: this.#apiKey,
            ...(body === undefined
              ? {}
              : { "content-type": "application/json" }),
          },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: signal ?? AbortSignal.timeout(COMPOSIO_REQUEST_TIMEOUT_MS),
        });
        const retryableResponse = response.status >= 500;
        if (retryableResponse && attempt + 1 < attempts) continue;
        if (!response.ok) {
          throw new ComposioError(
            retryableResponse ? "composio_unavailable" : "composio_rejected",
            response.status,
          );
        }
        if (response.status === 204) return undefined;
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.byteLength > COMPOSIO_BODY_CAP) {
          throw new ComposioError("composio_rejected");
        }
        const text = new TextDecoder().decode(bytes);
        if (!text) return undefined;
        try {
          return JSON.parse(text);
        } catch {
          throw new ComposioError("composio_rejected");
        }
      } catch (error) {
        if (error instanceof ComposioError) throw error;
        if (
          error instanceof DOMException &&
          (error.name === "AbortError" || error.name === "TimeoutError")
        ) {
          throw new ComposioError("composio_timeout");
        }
        if (attempt + 1 < attempts) continue;
        throw new ComposioError("composio_unavailable");
      }
    }
    throw new ComposioError("composio_unavailable");
  }
}
