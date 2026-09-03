export const COMPOSIO_API_BASE_URL = "https://backend.composio.dev/api/v3.1";
export const COMPOSIO_API_KEY_HEADER = "x-api-key";
export const COMPOSIO_CONNECTED_ACCOUNTS_PATH = "/connected-accounts";
export const COMPOSIO_CALLBACK_ACCOUNT_PARAM = "connectedAccountId";
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
  metadata: Record<string, unknown>;
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

function connectedAccountFrom(payload: unknown): ComposioConnectedAccount {
  const row = objectValue(payload);
  return {
    id: stringValue(row, "id"),
    status: stringValue(row, "status") as ComposioConnectedAccount["status"],
    userId: stringValue(row, "user_id", "userId"),
    authConfigId: stringValue(row, "auth_config_id", "authConfigId"),
    toolkit: stringValue(row, "toolkit", "toolkit_slug"),
    createdAt: stringValue(row, "created_at", "createdAt"),
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
