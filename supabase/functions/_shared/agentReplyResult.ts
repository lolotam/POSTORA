// What an ai-agent-reply response actually means.
//
// The one thing every caller must not do is classify on HTTP status: jsonResponse in
// _shared/cors.ts defaults to 200, so the agent's error path returns 200 carrying
// {ok:false}, and a caller reading `response.ok` would settle every generation failure as a
// delivered reply. The body is the contract. Shared by the webhooks and the recovery job so
// the two cannot drift on which outcomes count as done.

export type AgentReplyOutcome =
  /** The agent generated and the provider accepted a reply. */
  | { kind: "sent" }
  /** Stored text from an earlier attempt was delivered; nothing was regenerated. */
  | { kind: "redelivered" }
  /** The agent deliberately said nothing (gate closed, no reply generated). Terminal. */
  | { kind: "skipped"; detail: string }
  /**
   * Every model failed, but the outage floor already escalated the conversation, notified a
   * human and (for a DM) sent the customer an apology. Terminal: retrying would escalate a
   * conversation that is already escalated and apologise to someone who has an apology.
   */
  | { kind: "outage_handled"; detail: string }
  /** A failure with no side effect behind it. Safe to try again later. */
  | { kind: "retryable"; detail: string }
  /** The request itself is wrong and will be wrong on every attempt. Terminal. */
  | { kind: "permanent"; detail: string };

interface AgentReplyBody {
  ok?: unknown;
  reply?: unknown;
  redelivered?: unknown;
  skipped?: unknown;
  escalated?: unknown;
  apology_sent?: unknown;
  error?: unknown;
}

function asBody(body: unknown): AgentReplyBody | null {
  if (!body || typeof body !== "object") return null;
  const candidate = body as AgentReplyBody;
  return typeof candidate.ok === "boolean" ? candidate : null;
}

export function parseAgentReplyResult(status: number, body: unknown): AgentReplyOutcome {
  // The HTTP layer only ever means something when it is NOT the default: a 4xx is the
  // gateway or the auth guard refusing the request outright, a 5xx is the platform.
  if (status >= 400 && status < 500) return { kind: "permanent", detail: `HTTP ${status}` };
  if (status >= 500) return { kind: "retryable", detail: `HTTP ${status}` };

  const parsed = asBody(body);
  // Cloudflare can replace a body wholesale. Something we cannot read is never "sent".
  if (!parsed) return { kind: "retryable", detail: "unreadable response body" };

  if (parsed.ok === true) {
    if (parsed.redelivered === true) return { kind: "redelivered" };
    if (typeof parsed.skipped === "string") return { kind: "skipped", detail: parsed.skipped };
    return { kind: "sent" };
  }

  const detail = typeof parsed.error === "string" ? parsed.error : "unknown error";
  // The ModelChainExhaustedError path: escalated=true means deliverModelOutageFloor ran to
  // completion and something external happened. escalated=false is
  // model_exhaustion_unhandled -- nothing sent, nothing assigned, nothing to protect.
  if (parsed.escalated === true) return { kind: "outage_handled", detail };
  return { kind: "retryable", detail };
}
