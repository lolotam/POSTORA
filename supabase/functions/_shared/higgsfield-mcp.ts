/**
 * Minimal MCP (Model Context Protocol) client over Streamable HTTP.
 *
 * Higgsfield's OAuth tokens authorize exactly one resource — the MCP endpoint
 * at https://mcp.higgsfield.ai/mcp — so all generation goes through JSON-RPC
 * `tools/call` rather than a REST API.
 *
 * Deliberately dependency-free: importing the official SDK into a Deno edge
 * function is more weight than three request shapes justify.
 */

import { getValidAccessToken, HiggsfieldAuthError } from "./higgsfield-oauth.ts";
import { extractToolPayload } from "./higgsfield-job-payload.ts";

const MCP_ENDPOINT = "https://mcp.higgsfield.ai/mcp";
const MCP_PROTOCOL_VERSION = "2025-06-18";

/**
 * Ceiling on any single MCP request. Without it a stalled provider holds the
 * edge invocation open until the platform kills it, which loses the job record.
 */
const MCP_REQUEST_TIMEOUT_MS = 30_000;

export class McpError extends Error {
  constructor(
    message: string,
    public readonly data?: unknown,
  ) {
    super(message);
    this.name = "McpError";
  }
}

/** Raised on HTTP 401 so the caller can refresh once and retry. */
class McpUnauthorizedError extends Error {}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number | string | null;
  result?: any;
  error?: { code: number; message: string; data?: unknown };
}

/**
 * Pull the JSON-RPC message matching `id` out of a Streamable HTTP response,
 * which may be either a plain JSON body or an SSE stream.
 */
async function readRpcResponse(res: Response, id: number): Promise<JsonRpcResponse | null> {
  const contentType = res.headers.get("content-type") || "";

  if (!contentType.includes("text/event-stream")) {
    const text = await res.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text) as JsonRpcResponse;
    } catch {
      throw new McpError(`Higgsfield returned invalid JSON: ${text.slice(0, 300)}`);
    }
  }

  const raw = await res.text();
  let fallback: JsonRpcResponse | null = null;

  for (const block of raw.split(/\r?\n\r?\n/)) {
    const payload = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim())
      .join("");

    if (!payload || payload === "[DONE]") continue;

    let message: JsonRpcResponse;
    try {
      message = JSON.parse(payload) as JsonRpcResponse;
    } catch {
      continue;
    }

    if (message.id === id) return message;
    // Keep any terminal message in case the server does not echo the id.
    if (message.result !== undefined || message.error !== undefined) fallback = message;
  }

  return fallback;
}

export class HiggsfieldMcpClient {
  private sessionId: string | null = null;
  private initialized = false;
  private nextId = 1;

  private constructor(
    private accessToken: string,
    private readonly supabase: { from: (t: string) => any },
    private readonly source?: "byo" | "platform",
    private readonly refreshCredential?: () => Promise<string>,
  ) {}

  /**
   * Build a client from the PLATFORM connection, refreshing if needed.
   *
   * Only correct when the caller has already decided that the platform token is
   * the right credential. Anything user-scoped must go through
   * {@link fromCredential} — resolving the platform token for a user who owns a
   * BYO connection would bill the admin's Higgsfield account for their work, and
   * would silently defeat "a BYO job never falls back to the platform token".
   */
  static async create(supabase: { from: (t: string) => any }): Promise<HiggsfieldMcpClient> {
    const token = await getValidAccessToken(supabase);
    return new HiggsfieldMcpClient(token, supabase);
  }

  /**
   * Build a client from an already-resolved credential.
   *
   * `resolveHiggsfieldCredential()` decides BYO-vs-platform once, and this keeps
   * that decision authoritative: the token travels with its `source`, so no code
   * path downstream can re-resolve and land on a different account than the one
   * the job was created against and metered for.
   */
  static fromCredential(
    credential: {
      accessToken: string;
      source: "byo" | "platform";
      /** Re-resolves THIS connection's token on a mid-session 401. Required for BYO. */
      refresh?: () => Promise<string>;
    },
    supabase: { from: (t: string) => any },
  ): HiggsfieldMcpClient {
    return new HiggsfieldMcpClient(
      credential.accessToken,
      supabase,
      credential.source,
      credential.refresh,
    );
  }

  /** Which credential this client is running on. `undefined` means platform via {@link create}. */
  get credentialSource(): "byo" | "platform" {
    return this.source ?? "platform";
  }

  private headers(): HeadersInit {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
    };
    if (this.sessionId) headers["Mcp-Session-Id"] = this.sessionId;
    return headers;
  }

  private async post(body: unknown): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(MCP_ENDPOINT, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(MCP_REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "TimeoutError") {
        throw new McpError(`Higgsfield did not respond within ${MCP_REQUEST_TIMEOUT_MS / 1000}s`);
      }
      throw err;
    }

    if (res.status === 401) {
      await res.body?.cancel();
      throw new McpUnauthorizedError("Higgsfield rejected the access token");
    }

    // The session id is issued on initialize and echoed thereafter.
    const session = res.headers.get("mcp-session-id");
    if (session) this.sessionId = session;

    return res;
  }

  private async rpc(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: "2.0", id, method, params });

    if (!res.ok) {
      const detail = (await res.text()).slice(0, 300);
      throw new McpError(`Higgsfield MCP ${method} failed (${res.status}): ${detail}`);
    }

    const message = await readRpcResponse(res, id);
    if (!message) {
      throw new McpError(`Higgsfield MCP ${method} returned no response`);
    }
    if (message.error) {
      throw new McpError(`Higgsfield MCP ${method}: ${message.error.message}`, message.error.data);
    }
    return message.result;
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.rpc("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "postora", version: "1.0.0" },
    });

    // Notification: no id, no response body expected.
    const res = await this.post({ jsonrpc: "2.0", method: "notifications/initialized" });
    await res.body?.cancel();

    this.initialized = true;
  }

  /**
   * Call an MCP tool, transparently refreshing the token once on a 401.
   */
  async callTool(name: string, args: Record<string, unknown>): Promise<any> {
    try {
      return await this.callToolOnce(name, args);
    } catch (err) {
      if (!(err instanceof McpUnauthorizedError)) throw err;

      // Token died mid-session: refresh, reset the session, retry exactly once.
      //
      // The refresh MUST target the same connection the client was built from.
      // Refreshing the platform token for a BYO client would hand the retry to
      // the admin's Higgsfield account — the user's work would be billed to the
      // platform and attributed to the wrong account, which is exactly the
      // fallback the design forbids. A BYO client without a refresher fails
      // closed and asks the user to reconnect.
      this.sessionId = null;
      this.initialized = false;
      try {
        if (this.source === "byo") {
          if (!this.refreshCredential) {
            throw new HiggsfieldAuthError(
              "HIGGSFIELD_REAUTH_REQUIRED",
              "Your Higgsfield connection expired. Reconnect Higgsfield in Settings.",
            );
          }
          this.accessToken = await this.refreshCredential();
        } else {
          this.accessToken = await getValidAccessToken(this.supabase);
        }
      } catch (refreshErr) {
        throw refreshErr instanceof HiggsfieldAuthError
          ? refreshErr
          : new McpError("Higgsfield authorization failed and could not be refreshed");
      }

      try {
        return await this.callToolOnce(name, args);
      } catch (retryErr) {
        if (retryErr instanceof McpUnauthorizedError) {
          throw new HiggsfieldAuthError(
            "HIGGSFIELD_REAUTH_REQUIRED",
            "Higgsfield rejected the refreshed token. Reconnect Higgsfield.",
          );
        }
        throw retryErr;
      }
    }
  }

  private async callToolOnce(name: string, args: Record<string, unknown>): Promise<any> {
    await this.initialize();
    const result = await this.rpc("tools/call", { name, arguments: args });

    if (result?.isError) {
      throw new McpError(`Higgsfield tool "${name}" reported an error`, extractToolPayload(result));
    }
    return extractToolPayload(result);
  }
}

// Payload parsing lives in a dependency-free module so it can be unit tested —
// this file needs OAuth and cannot run under the app's test runner. Re-exported
// here because callers have always imported these from the client module.
export {
  extractToolPayload,
  findJobId,
  findOutputUrl,
  readJobSnapshot,
} from "./higgsfield-job-payload.ts";
export type { JobSnapshot, JobState } from "./higgsfield-job-payload.ts";
