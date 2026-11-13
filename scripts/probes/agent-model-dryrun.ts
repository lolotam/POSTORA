import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "npm:zod@3.23.8";
import {
  sandboxConversationId,
  threadReplyLanguage,
  type LanguageMode,
  type ReplyLanguage,
} from "../../supabase/functions/ai-agent-reply/logic.ts";

import { CatalogEvidenceSchema, catalogGrounded, type CatalogEvidence } from "../../supabase/functions/ai-agent-reply/catalogEvidence.ts";

const REPORT_PATH = "docs/superpowers/reports/2026-11-12-curemed-model-dryrun.md";
const REPORT_URL = new URL(`../../${REPORT_PATH}`, import.meta.url);
/**
 * The owner's copy: the same comparison with the conversation id and the reply
 * excerpts in it. The repository's .gitignore ignores every `*.local` path, so it
 * never reaches a commit -- and it must not.
 */
const DETAILED_REPORT_PATH = `${REPORT_PATH}.local`;
const DETAILED_REPORT_URL = new URL(`../../${DETAILED_REPORT_PATH}`, import.meta.url);
const REQUEST_TIMEOUT_MS = 120_000;

const SandboxResponseSchema = z.object({
  ok: z.boolean().optional(),
  // REQUIRED, and that is the whole point of it. The sandbox answers a turn it
  // could not serve with an HTTP 200 body that carries NO reply: `{ ok: true,
  // skipped: ... }` when a gate closed, `{ ok: false, error: ... }` when the turn
  // failed. A schema that accepts those records a MISS for a model that never
  // answered, and lets the turn join the sandbox's window as if it had.
  reply: z.string(),
  catalog_evidence: z.array(CatalogEvidenceSchema).max(100).optional(),
  tool_calls: z.array(z.object({
    name: z.string(),
    arguments: z.record(z.unknown()).optional(),
  })).optional(),
});

/**
 * One tool call as the sandbox reports it: the name and the arguments the model
 * passed. The rows the tool RETURNED are not in it -- the sandbox keeps those in
 * its own tool loop and never hands them to a caller.
 */
export interface SandboxToolCall {
  name: string;
  arguments?: Record<string, unknown>;
}

/**
 * What the sandbox answered for one turn.
 *
 * "answered": the sandbox replied, so a model ran and the turn is in the thread.
 * "no_reply": the body carries no reply at all -- a skip or an error envelope.
 * "malformed": the body is not the shape the sandbox writes, so the probe cannot
 * trust what it says.
 */
export type SandboxReply =
  | { kind: "answered"; reply: string; toolCalls: SandboxToolCall[]; catalogEvidence: CatalogEvidence[] | null }
  | { kind: "failed"; reason: "no_reply" | "malformed" };

function createAdminClient(supabaseUrl: string, serviceRoleKey: string) {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

type AdminClient = ReturnType<typeof createAdminClient>;

/**
 * How a reply's language compared with the language the sandbox would have used.
 *
 * "indeterminate" is a real answer: the sandbox's own state could not be established,
 * so the reply is neither right nor wrong. Scoring it either way would put a number in
 * the report that says nothing about the model.
 */
export type LanguageScore = "correct" | "incorrect" | "indeterminate";

export interface ResultRow {
  model: string;
  turn: number;
  latencyMs: number;
  languageScore: LanguageScore;
  catalogQuery: boolean;
  catalogGrounded: boolean | null;
  /** Whether the reply carried a URL at all. Not a product-link measurement; see hasUrl. */
  urlPresent: boolean;
  excerpt: string;
  /**
   * How long the reply was.
   *
   * The excerpt column is the first 120 characters, so its length is the length of the
   * EXCERPT and not of the reply: a reply of any length over 120 reported as 120. The
   * report quotes this number instead, so the comparison says what the reply actually
   * was.
   */
  replyLength: number;
  /** Set when the turn failed. The probe records it and carries on with the next turn. */
  failure?: string;
}

interface ReplaySource {
  platform: string;
  socialAccountId: string;
  customerTurns: string[];
}

/**
 * The state the sandbox's own thread carries at a turn.
 *
 * `customerLanguage` is ai_threads.customer_language, read from the sandbox's thread
 * rather than guessed from the replayed turns: the sandbox writes it after every reply,
 * so it holds exactly the language the sandbox itself would use at the next turn.
 *
 * `processedTurns` are the customer turns the sandbox actually processed, and only
 * the ones it ANSWERED: a turn whose request failed might still be written by a
 * sandbox that outlived the request, so the replay stops there rather than count it
 * as processed. A turn in neither the window nor the language is a turn the sandbox
 * never stored, and a later letterless turn scored against it would be judged
 * against language the sandbox never wrote.
 */
export interface SandboxState {
  /** The language the sandbox's thread carries, or null when it carries none. */
  customerLanguage: ReplyLanguage | null;
  /** The customer turns the sandbox processed, oldest first. */
  processedTurns: string[];
  /** False when the sandbox's state could not be read at all. */
  known: boolean;
}

/**
 * The language a replayed turn is expected to be answered in.
 *
 * THE MEASUREMENT TARGET: the language the SANDBOX would answer in at that
 * turn. The replay builds its own thread, and that thread starts empty -- so the
 * language it carries at a turn is the one the turns replayed before it left
 * behind, not the source thread's final language, which belongs to a different
 * conversation and includes turns this replay has not reached yet. The probe
 * therefore tracks that per-turn state and passes it as the thread's language.
 *
 * The thread's stored customer language counts, exactly as it does in production:
 * ai-agent-reply reads ai_threads.customer_language when a turn shows no language of
 * its own. A caption-less photo, a rating, an emoji -- none of them say what language
 * the customer speaks -- so without the thread's language an Arabic thread was scored
 * as English and every Arabic reply counted as a wrong answer.
 *
 * `earlierTurns` is the replayed prefix in CHRONOLOGICAL order, the order the chat
 * model sees the window in. threadReplyLanguage reads it newest-first itself, so
 * reversing it here would make the fallback consult the OLDEST turn instead of the
 * newest one.
 *
 * `languageMode` is the account's CONFIGURED mode, which the sandbox obeys: a mode
 * forced to Arabic or English decides the answer before the customer's own words are
 * read. Scoring against "auto" instead would judge every forced-mode reply as a miss.
 */
export function expectedReplayLanguage(
  inboundText: string,
  customerLanguage: ReplyLanguage | null,
  earlierTurns: string[],
  languageMode: LanguageMode = "auto",
): ReplyLanguage {
  return threadReplyLanguage({
    inboundText,
    languageMode,
    hint: null,
    eventFlow: null,
    customerLanguage,
    storedTurns: [],
    windowTurns: earlierTurns.map((content) => ({ role: "user", content })),
  });
}

/**
 * The language the sandbox would answer a turn in, or null when it cannot be
 * established.
 *
 * Null means INDETERMINATE: the sandbox's thread state or its configured language mode
 * could not be read, so the turn is not judged at all.
 */
export function expectedSandboxLanguage(
  state: SandboxState,
  inboundText: string,
  languageMode: LanguageMode | null,
): ReplyLanguage | null {
  if (!state.known || languageMode === null) return null;
  return expectedReplayLanguage(inboundText, state.customerLanguage, state.processedTurns, languageMode);
}

/**
 * What the probe knows about a turn's outcome in the sandbox.
 *
 * "answered": the sandbox replied. The turn is in the thread, and the thread's
 * state is the one the probe measured against.
 *
 * "unknown": the request failed. The sandbox may still be running -- a client
 * timeout does not stop the function -- and the turn it writes when it finishes
 * lands in the thread. The probe cannot tell which turns the sandbox wrote, so a
 * thread whose last turn is unknown is not replayed into again.
 */
export type TurnOutcome = "answered" | "unknown";

/**
 * The state the sandbox carries after a turn.
 *
 * Only a turn the sandbox ANSWERED is known to be in the window. An unknown
 * outcome might be in it, and the replay stops there rather than score a later
 * turn against a window the probe cannot vouch for.
 */
export function sandboxStateAfterTurn(
  state: SandboxState,
  turn: { text: string; outcome: TurnOutcome },
): SandboxState {
  if (turn.outcome !== "answered") return state;
  return { ...state, processedTurns: [...state.processedTurns, turn.text] };
}

function requiredEnv(name: string): string {
  const environmentValue = Deno.env.get(name)?.trim();
  if (!environmentValue) throw new Error(`Missing required environment variable: ${name}`);
  return environmentValue;
}

function argument(flagName: string): string | null {
  const index = Deno.args.indexOf(`--${flagName}`);
  if (index >= 0) return Deno.args[index + 1]?.trim() || null;
  const inline = Deno.args.find((argumentValue) => argumentValue.startsWith(`--${flagName}=`));
  return inline?.slice(flagName.length + 3).trim() || null;
}

function isRecord(candidate: unknown): candidate is Record<string, unknown> {
  return typeof candidate === "object" && candidate !== null && !Array.isArray(candidate);
}

/**
 * The sandbox's answer to one turn.
 *
 * A body without a reply is NOT a model run. The sandbox answers a turn it could
 * not serve with an HTTP 200 body that carries no reply, so a reply-less body is
 * a turn that produced no answer -- not an answer that happens to be empty. The
 * probe records it as a failure, so no model is scored on a turn it never ran.
 */
export function parseSandboxReply(body: unknown): SandboxReply {
  const parsed = SandboxResponseSchema.safeParse(body);
  if (parsed.success) {
    // An empty reply is not an answer either: the sandbox routes an empty model
    // reply to its no-reply path, so it never answers with one.
    if (parsed.data.reply.trim().length === 0) return { kind: "failed", reason: "no_reply" };
    return {
      kind: "answered",
      reply: parsed.data.reply,
      toolCalls: parsed.data.tool_calls ?? [],
      catalogEvidence: parsed.data.catalog_evidence ?? null,
    };
  }
  // No reply at all: the skip and error envelopes.
  if (isRecord(body) && typeof body.reply !== "string") return { kind: "failed", reason: "no_reply" };
  // A reply is there, but the body around it is not the shape the sandbox
  // writes, so the probe cannot trust what it says.
  return { kind: "failed", reason: "malformed" };
}

function catalogCalledWithQuery(toolCalls: readonly SandboxToolCall[]): boolean {
  return toolCalls.some((call) => {
    const callArguments = call.arguments ?? {};
    if (callArguments.capability !== "search_products") return false;
    const parameters = isRecord(callArguments.parameters) ? callArguments.parameters : callArguments;
    return typeof parameters.query === "string" && parameters.query.trim().length > 0;
  });
}

/** Whether the reply carried any URL; the separate grounding column matches product identity. */
export function hasUrl(reply: string): boolean {
  return /https?:\/\/[^\s)]+/i.test(reply);
}

function excerpt(text: string): string {
  const singleLine = text.replaceAll("|", "\\|").replaceAll(/\s+/g, " ").trim();
  return Array.from(singleLine).slice(0, 120).join("");
}

function markdownCell(text: string): string {
  return text.replaceAll("\n", " ").trim();
}

/**
 * The table, the limitation and the selection card.
 *
 * The columns are the ones the plan settled on and they measure what they say:
 * the URL column says "any URL present" and the grounding column uses catalog identity evidence.
 */
function renderReportBody(
  resultRows: readonly ResultRow[],
  excerptCell: (row: ResultRow) => string,
): string[] {
  return [
    "## Results",
    "",
    "| Model | Turn | Latency ms | Reply language correct | Catalog tool called with non-empty query | Any URL present | Catalog grounded (identity match) | Reply excerpt (120 chars) | Status |",
    "|---|---:|---:|---|---|---|---|---|---|",
    ...resultRows.map((row) =>
      `| ${markdownCell(row.model)} | ${row.turn} | ${row.latencyMs} | ${languageCell(row.languageScore)} | ${row.catalogQuery ? "yes" : "no"} | ${row.urlPresent ? "yes" : "no"} | ${row.catalogGrounded === null ? "not measured" : row.catalogGrounded ? "yes" : "no"} | ${excerptCell(row)} | ${row.failure ? `failed: ${markdownCell(row.failure)}` : "ok"} |`
    ),
    "",
    "## Grounding score",
    "",
    "Catalog grounded compares the answer with product identifiers, names and URLs",
    "returned by the catalog during this sandbox turn. A yes means at least one exact",
    "identity match, not verification of every price or medical claim. A no means no",
    "returned product was identified. Older sandbox builds that expose no evidence",
    "are reported as not measured. Review the owner copy before selecting a model.",
    "",
    "## Model selection",
    "",
    "- Primary: results pending owner review.",
    "- Fallback: results pending owner review.",
    "",
  ];
}

/**
 * The report the repository tracks.
 *
 * It carries NO customer data: the conversation id is redacted and the reply text
 * is not written at all -- the excerpt column reports how long the reply was and
 * nothing else. A conversation id can be phone-like and a reply can repeat the
 * customer's own details, so a committed report that carried either would put
 * customer data into the repository's history for good.
 */
export function renderReport(resultRows: readonly ResultRow[]): string {
  const lines = [
    "# CureMed model dry-run comparison",
    "",
    "Source conversation: (redacted -- this file carries no customer data)",
    "Generated by the owner-run sandbox probe. No reply was sent to the customer.",
    "",
    "The reply text is not recorded here: the excerpt column reports how long the",
    "reply was and nothing else, and the conversation id is redacted, so this file can",
    "be committed. The unredacted detail is written beside it in the `.local` file, which",
    "git ignores -- keep that file out of every commit.",
    "",
    ...renderReportBody(resultRows, (row) => (row.excerpt ? `(redacted, ${row.replyLength} chars)` : "(no reply)")),
  ];
  return lines.join("\n");
}

/**
 * The same comparison WITH the material that must not be committed.
 *
 * It carries the conversation id and the reply excerpts, so it is written beside
 * the tracked report under a `.local` name the repository's .gitignore ignores. It
 * is the owner's copy to read, and it never goes into a commit.
 */
export function renderDetailedReport(resultRows: readonly ResultRow[], conversation: string): string {
  const lines = [
    "# CureMed model dry-run comparison -- owner copy, not for the repository",
    "",
    `Source conversation: \`${markdownCell(conversation)}\``,
    "Generated by the owner-run sandbox probe. No reply was sent to the customer.",
    "",
    "This file carries the conversation id and the reply excerpts. The tracked report",
    "beside it is redacted; keep this one out of every commit.",
    "",
    ...renderReportBody(resultRows, (row) => row.excerpt || "(no reply)"),
  ];
  return lines.join("\n");
}

/**
 * The language score as the report shows it.
 *
 * "indeterminate" is not a miss: the sandbox's own state could not be established, so
 * the turn says nothing about the model.
 */
function languageCell(score: LanguageScore): string {
  if (score === "correct") return "yes";
  if (score === "incorrect") return "no";
  return "indeterminate";
}

async function assertSandboxGuards(): Promise<void> {
  const source = await Deno.readTextFile(
    new URL("../../supabase/functions/ai-agent-reply/index.ts", import.meta.url),
  );
  const requiredGuards = [
    "replySender = dryRun ? null : await buildReplySender(admin, request);",
    "if (!dryRun && replySender) {",
    "request.platform === \"whatsapp\" && !dryRun",
  ];
  const gateStart = source.indexOf("if (!dryRun) {", source.indexOf("Sandbox runs bypass"));
  const gateEnd = source.indexOf("replySender =", gateStart);
  const handoffClaimGuarded = gateStart >= 0 && gateEnd > gateStart &&
    source.slice(gateStart, gateEnd).includes("claimHumanModeAck");
  if (!handoffClaimGuarded || requiredGuards.some((guard) => !source.includes(guard))) {
    throw new Error("A sandbox no-send/handoff guard changed; inspect ai-agent-reply before running this probe");
  }
}

/**
 * The agent log row that owns a conversation.
 */
export interface ConversationOwnerRow {
  user_id: string | null;
  platform: string | null;
  social_account_id: string | null;
}

/**
 * The slice of the service-role client the owner lookup uses.
 *
 * A structural seam over the Supabase builder, in the register of
 * ai-agent-reply/accountScope.ts: only the surface this lookup touches, so the
 * lookup can be exercised against a fake client at the database boundary.
 */
export interface ConversationOwnerQuery {
  select(columns: string): ConversationOwnerQuery;
  eq(column: string, value: unknown): ConversationOwnerQuery;
  not(column: string, operator: string, value: unknown): ConversationOwnerQuery;
  order(column: string, options: { ascending: boolean }): ConversationOwnerQuery;
  limit(count: number): ConversationOwnerQuery;
  maybeSingle(): Promise<{ data: ConversationOwnerRow | null; error: { message: string } | null }>;
}

export interface ConversationOwnerClient {
  from(table: string): { select(columns: string): ConversationOwnerQuery };
}

/**
 * The conversation's owner: the user, the platform and the account whose agent
 * log holds the conversation's turns.
 */
export interface ConversationOwner {
  userId: string;
  platform: string;
  socialAccountId: string;
}

/**
 * The owner of a conversation.
 *
 * The lookup is scoped to the AUTHENTICATED owner. Conversation ids are not
 * unique across tenants: another account's agent log can carry the same id, and
 * a lookup that took the newest matching row across every tenant returned THAT
 * account's row whenever it had used the id more recently -- so the owner check
 * then refused a probe whose owner's turns do exist. The platform cannot be
 * part of the scope: the platform is what the lookup is trying to find.
 */
export async function findConversationOwner(
  admin: ConversationOwnerClient,
  conversation: string,
  userId: string,
): Promise<ConversationOwner> {
  const { data: owner, error: ownerError } = await admin
    .from("ai_agent_logs")
    .select("user_id, platform, social_account_id")
    .eq("conversation_id", conversation)
    .eq("user_id", userId)
    .not("social_account_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (ownerError) throw new Error("Could not identify the conversation owner");
  if (!owner?.user_id || !owner.platform || !owner.social_account_id) {
    throw new Error("No account-scoped agent log exists for this conversation");
  }
  // Defence in depth: the lookup above already filters by the authenticated
  // owner, so this cannot fire for the owner's own row -- and it must not reject
  // it either. A lookup that loses its scope has to fail here rather than
  // replay another account's conversation.
  if (owner.user_id !== userId) throw new Error("SUPABASE_USER_JWT does not belong to the conversation owner");
  return { userId: owner.user_id, platform: owner.platform, socialAccountId: owner.social_account_id };
}

async function loadReplaySource(
  admin: AdminClient,
  conversation: string,
  userId: string,
): Promise<ReplaySource> {
  const owner = await findConversationOwner(
    admin as unknown as ConversationOwnerClient,
    conversation,
    userId,
  );

  const { data: thread, error: threadError } = await admin
    .from("ai_threads")
    .select("id")
    .eq("user_id", owner.userId)
    .eq("platform", owner.platform)
    .eq("conversation_id", conversation)
    .maybeSingle();
  if (threadError || !thread) throw new Error("Could not read the source thread");

  const { data: storedTurns, error: turnsError } = await admin
    .from("ai_thread_messages")
    .select("content, created_at")
    .eq("thread_id", thread.id)
    .eq("role", "user")
    .order("created_at", { ascending: true });
  if (turnsError) throw new Error("Could not read the source customer turns");
  const customerTurns = (storedTurns ?? [])
    .map((turn) => turn.content)
    .filter((content): content is string => typeof content === "string" && content.trim().length > 0);
  if (customerTurns.length === 0) throw new Error("The source thread has no customer turns to replay");

  // The source thread's own customer_language is deliberately NOT read: it holds the
  // language of the conversation's LAST turn, which the replay has not reached at an
  // earlier turn. The sandbox's thread starts empty, so the probe tracks the language
  // the replayed turns leave behind instead (see expectedReplayLanguage).
  return { platform: owner.platform, socialAccountId: owner.socialAccountId, customerTurns };
}

/**
 * One turn's request to the sandbox.
 */
export interface ReplayTurnInput {
  supabaseUrl: string;
  anonKey: string;
  userJwt: string;
  model: string;
  testCaseKey: string;
  platform: string;
  socialAccountId: string;
  inboundText: string;
  /** The language the sandbox would answer in, or null when it cannot be established. */
  expectedLanguage: ReplyLanguage | null;
}

/**
 * The one call the probe makes to the sandbox. A seam, so the probe's own
 * handling of a sandbox answer can be exercised without a network.
 */
export type SandboxFetch = (url: string, init: RequestInit) => Promise<Response>;

export async function replayTurn(
  input: ReplayTurnInput,
  fetchImpl: SandboxFetch = fetch,
): Promise<Omit<ResultRow, "model" | "turn">> {
  const startedAt = Date.now();
  const response = await fetchImpl(`${input.supabaseUrl}/functions/v1/ai-agent-reply`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: input.anonKey,
      Authorization: `Bearer ${input.userJwt}`,
    },
    body: JSON.stringify({
      platform: input.platform,
      social_account_id: input.socialAccountId,
      inbound_text: input.inboundText,
      test_case_key: input.testCaseKey,
      model_override: input.model,
    }),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const latencyMs = Date.now() - startedAt;
  if (!response.ok) throw new Error(`Sandbox refused ${input.model} with HTTP ${response.status}`);
  const parsedReply = parseSandboxReply(await response.json());
  if (parsedReply.kind === "failed") {
    throw new Error(
      parsedReply.reason === "no_reply"
        ? `The sandbox returned no reply for ${input.model}`
        : `The sandbox returned an unexpected response for ${input.model}`,
    );
  }

  return {
    latencyMs,
    languageScore: scoreLanguage(parsedReply.reply, input.expectedLanguage),
    catalogQuery: catalogCalledWithQuery(parsedReply.toolCalls),
    catalogGrounded: parsedReply.catalogEvidence === null ? null : catalogGrounded(parsedReply.reply, parsedReply.catalogEvidence),
    urlPresent: hasUrl(parsedReply.reply),
    excerpt: excerpt(parsedReply.reply),
    replyLength: parsedReply.reply.length,
  };
}

/**
 * Runs one turn and measures the answer.
 */
export type ReplayTurnRunner = (input: ReplayTurnInput) => Promise<Omit<ResultRow, "model" | "turn">>;

/**
 * Reads the language the sandbox's own thread carries.
 */
export type ThreadLanguageReader = (
  scope: { userId: string; platform: string; conversationId: string },
) => Promise<ReplyLanguage | null | undefined>;

export interface ReplayModelOptions {
  model: string;
  turns: readonly string[];
  languageMode: LanguageMode | null;
  scope: { userId: string; platform: string; conversationId: string };
  /** The request fields every turn of this model shares. */
  request: Omit<ReplayTurnInput, "model" | "inboundText" | "expectedLanguage">;
  runTurn: ReplayTurnRunner;
  readThreadLanguage: ThreadLanguageReader;
  onRow: (row: ResultRow) => void | Promise<void>;
}

/**
 * Replays one model's turns into ONE sandbox thread.
 *
 * The replay STOPS at the first turn whose outcome the probe cannot establish. A
 * failed request may still be running in the sandbox -- a client timeout does not
 * stop the function -- and the turn it writes when it finishes changes the thread
 * the next turn would be measured against: the window it reads and the language it
 * carries are then not the ones the probe measured. The probe cannot tell which
 * turns the sandbox wrote, so it stops instead of guessing.
 *
 * A fresh thread is no escape either: the thread carries the conversation's
 * language, and a thread that starts empty expects the default language for the
 * turns the real conversation answered in Arabic.
 */
export async function replayModelTurns(options: ReplayModelOptions): Promise<{ rows: ResultRow[]; stopped: boolean }> {
  const rows: ResultRow[] = [];
  let state: SandboxState = { customerLanguage: null, processedTurns: [], known: true };
  for (const [index, inboundText] of options.turns.entries()) {
    // The state the sandbox's OWN thread carries at this turn: the language it
    // persisted, and the turns it processed. Read from the sandbox rather than
    // guessed from the replayed words -- a turn the sandbox never saw changed
    // nothing, and scoring against it would judge a later turn against language the
    // sandbox never stored.
    const persisted = await options.readThreadLanguage(options.scope);
    state = { ...state, customerLanguage: persisted ?? null, known: persisted !== undefined };
    const expectedLanguage = expectedSandboxLanguage(state, inboundText, options.languageMode);
    const startedAt = Date.now();
    let measurement: Omit<ResultRow, "model" | "turn">;
    let outcome: TurnOutcome;
    try {
      measurement = await options.runTurn({
        ...options.request,
        model: options.model,
        inboundText,
        expectedLanguage,
      });
      outcome = "answered";
    } catch (error) {
      // The turn failed, and the probe cannot tell whether the sandbox wrote it.
      outcome = "unknown";
      measurement = {
        latencyMs: Date.now() - startedAt,
        languageScore: "indeterminate",
        catalogQuery: false,
        catalogGrounded: null,
        urlPresent: false,
        excerpt: "",
        replyLength: 0,
        failure: error instanceof Error ? error.message : String(error),
      };
    }
    const row: ResultRow = { model: options.model, turn: index + 1, ...measurement };
    rows.push(row);
    // Only a turn the sandbox ANSWERED joins its window and its language.
    state = sandboxStateAfterTurn(state, { text: inboundText, outcome });
    await options.onRow(row);
    // The thread's state is no longer the probe's to trust, so it is not replayed
    // into again: the next model replays into its own thread.
    if (outcome === "unknown") return { rows, stopped: true };
  }
  return { rows, stopped: false };
}

/**
 * The English words that mark a Latin fragment as English PROSE.
 *
 * Function words only, deliberately. "Product:" and "Brand:" are labels an Arabic
 * answer carries, and a content word such as "price" would read the English
 * product description an Arabic answer quotes as an English answer.
 */
const ENGLISH_FUNCTION_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "could",
  "did", "do", "does", "for", "from", "had", "has", "have", "he", "her", "him",
  "his", "how", "i", "if", "in", "is", "it", "its", "me", "my", "no", "not", "of",
  "on", "or", "our", "out", "she", "should", "so", "than", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "those", "to", "too", "up",
  "us", "was", "we", "were", "what", "when", "where", "which", "who", "why",
  "will", "with", "would", "you", "your",
]);

const URL_RE = /https?:\/\/\S+/gi;
const WWW_URL_RE = /\bwww\.\S+/gi;
const LATIN_WORD_RE = /[A-Za-z]+/g;
const LATIN_LETTER_RE = /[A-Za-z]/g;
/**
 * The Arabic LETTERS, and nothing else.
 *
 * The Arabic block also holds its digits (Arabic-Indic 0-9), its punctuation
 * (comma, semicolon, question mark) and its tashkeel. A reply such as
 * "Price: ١٢٣ KWD" is English, but its Arabic-Indic digits read as Arabic
 * letters, so the English answer was counted as Arabic prose. The letter class
 * is what the language of the answer is made of.
 */
const ARABIC_LETTER_RE = /(?=\p{Script=Arabic})\p{L}/gu;
const SENTENCE_BREAK_RE = /[\n.!?؟]+/;

/**
 * A quoted span: a name the answer quotes, not prose it is written in.
 *
 * A product name carries words that are English function words ("Vitamins for
 * Men"), so a quoted name read as English prose made an Arabic answer read as
 * English. The double quotes and the guillemets are the quotes a reply uses.
 */
const QUOTED_SPAN_RE = /"[^"]*"|“[^”]*”|«[^»]*»/g;

/**
 * Whether a fragment carries an English function word.
 *
 * The words are read as whole words, so "there" is not a match for "the" and a
 * product name such as "Dentek" is not a match for anything.
 */
function carriesEnglishFunctionWord(fragment: string): boolean {
  const words = fragment.match(LATIN_WORD_RE) ?? [];
  return words.some((word) => ENGLISH_FUNCTION_WORDS.has(word.toLowerCase()));
}

/**
 * The language a reply is written in, decided by the script that owns its PROSE.
 *
 * The reply is read in its own language -- the "auto" the old detection call used,
 * with no mode forced on it -- because the mode belongs to the account's config and
 * is read on the EXPECTED side (readConfiguredLanguageMode).
 *
 * The old judgement counted every Latin character in the reply, and a CureMed
 * answer in Arabic carries the product's English name and the catalog's
 * product_url. Those ASCII characters can outnumber the Arabic prose, so an
 * Arabic reply was read as English and a correct Arabic model was rejected in
 * favour of another one.
 *
 * So the links go first -- a link is a link, not prose -- and what is left is
 * read segment by segment. A segment with Arabic letters is Arabic prose. A
 * Latin segment is prose only when it carries English function words: a product
 * name, a brand or a label is data the answer quotes, not the language the
 * answer is written in. A reply with no prose in it at all (only names, digits
 * and punctuation) is decided by its letters, as it was before.
 *
 * Two things are data rather than prose, and both are read out before the prose
 * is counted: a link, and a quoted name. A quoted product name carries English
 * function words of its own ("Vitamins for Men"), and an Arabic answer quoting
 * one is not an English answer. The letters of the data still count, so a reply
 * that is nothing but a name is decided by its letters, as it was before.
 */
export function dominantReplyLanguage(reply: string): ReplyLanguage {
  const text = reply.replace(URL_RE, " ").replace(WWW_URL_RE, " ");
  // A quoted name is data the answer quotes, not prose it is written in.
  const prose = text.replace(QUOTED_SPAN_RE, " ");
  const arabicLetters = (text.match(ARABIC_LETTER_RE) ?? []).length;
  const latinLetters = (text.match(LATIN_LETTER_RE) ?? []).length;
  let arabicProse = 0;
  let latinProse = 0;
  for (const segment of prose.split(SENTENCE_BREAK_RE)) {
    const arabic = (segment.match(ARABIC_LETTER_RE) ?? []).length;
    const latin = (segment.match(LATIN_LETTER_RE) ?? []).length;
    arabicProse += arabic;
    if (carriesEnglishFunctionWord(segment)) latinProse += latin;
  }
  if (arabicProse > 0 || latinProse > 0) {
    if (arabicProse > latinProse) return "ar";
    if (latinProse > arabicProse) return "en";
    // Two scripts carry the same prose: the old tie-break answers English.
    return "en";
  }
  // No prose anywhere: the letters decide, as they did before.
  return arabicLetters > latinLetters ? "ar" : "en";
}

/**
 * How the reply's language compares with the language the sandbox would have used.
 *
 * Without a language to compare against the turn is INDETERMINATE: the sandbox's own
 * state could not be established, so the reply says nothing about the model.
 */
export function scoreLanguage(reply: string, expectedLanguage: ReplyLanguage | null): LanguageScore {
  if (expectedLanguage === null) return "indeterminate";
  if (reply.length === 0) return "incorrect";
  return dominantReplyLanguage(reply) === expectedLanguage ? "correct" : "incorrect";
}

/**
 * The language the account's config forces, or null when it cannot be established.
 *
 * The sandbox answers in this mode, whatever the customer writes: a mode forced to
 * Arabic makes an English customer Arabic. A probe that scored against "auto" would
 * call every such reply a miss.
 */
export async function readConfiguredLanguageMode(
  admin: AdminClient,
  userId: string,
  socialAccountId: string,
): Promise<LanguageMode | null> {
  const { data, error } = await admin
    .from("ai_agent_configs")
    .select("language_mode")
    .eq("user_id", userId)
    .eq("social_account_id", socialAccountId)
    .maybeSingle();
  if (error) {
    console.error(`[probe] the configured language mode could not be read: ${error.message}`);
    return null;
  }
  const mode = (data as { language_mode?: string | null } | null)?.language_mode;
  if (mode === "ar" || mode === "en") return mode;
  // A config with no mode set answers in the customer's own language, and so does a
  // mode that reads as anything else.
  return "auto";
}

/**
 * The language the sandbox's thread carries, or undefined when it cannot be read.
 *
 * Read from the sandbox's OWN thread, not derived from the replayed turns: the thread
 * is what the sandbox answered from, so it holds the language the sandbox really used.
 */
export async function readSandboxThreadLanguage(
  admin: AdminClient,
  scope: { userId: string; platform: string; conversationId: string },
): Promise<ReplyLanguage | null | undefined> {
  const { data, error } = await admin
    .from("ai_threads")
    .select("customer_language")
    .eq("user_id", scope.userId)
    .eq("platform", scope.platform)
    .eq("conversation_id", scope.conversationId)
    .maybeSingle();
  if (error) {
    console.error(`[probe] the sandbox thread's language could not be read: ${error.message}`);
    return undefined;
  }
  const language = (data as { customer_language?: string | null } | null)?.customer_language;
  return language === "ar" || language === "en" ? language : null;
}

async function main(): Promise<void> {
  const conversation = argument("conversation");
  const models = [...new Set((argument("models") ?? "").split(",").map((model) => model.trim()).filter(Boolean))];
  if (!conversation || models.length === 0) {
    throw new Error("Usage: deno run --allow-env --allow-read --allow-write --allow-net scripts/probes/agent-model-dryrun.ts --conversation <id> --models <a,b,c>");
  }

  const supabaseUrl = requiredEnv("SUPABASE_URL").replace(/\/$/, "");
  const serviceRoleKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  const userJwt = requiredEnv("SUPABASE_USER_JWT");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY")?.trim() || requiredEnv("SUPABASE_PUBLISHABLE_KEY");
  await assertSandboxGuards();

  const admin = createAdminClient(supabaseUrl, serviceRoleKey);
  const { data: { user }, error: userError } = await admin.auth.getUser(userJwt);
  if (userError || !user) throw new Error("SUPABASE_USER_JWT is not a valid user session");
  const replaySource = await loadReplaySource(admin, conversation, user.id);

  const resultRows: ResultRow[] = [];
  let failures = 0;
  // The tracked report carries no customer data; the owner's copy beside it does.
  // Both are written after every turn, so an interrupted run still leaves a report.
  const writeReports = async (rows: readonly ResultRow[]) => {
    await Deno.writeTextFile(REPORT_URL, renderReport(rows));
    await Deno.writeTextFile(DETAILED_REPORT_URL, renderDetailedReport(rows, conversation));
  };
  // The account's CONFIGURED language mode, which the sandbox obeys. Read once: a mode
  // forced to Arabic or English decides the answer before the customer's words are read.
  const languageMode = await readConfiguredLanguageMode(admin, user.id, replaySource.socialAccountId);
  if (languageMode === null) {
    console.warn("[probe] the configured language mode could not be read; the language column is indeterminate");
  }
  for (const model of models) {
    const modelKey = model.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 24);
    const testCaseKey = `dryrun_${modelKey}_${Date.now()}`;
    // Each model replays into its own sandbox thread, so the state starts empty for
    // every model.
    const sandboxThread = sandboxConversationId(
      replaySource.platform,
      replaySource.socialAccountId,
      testCaseKey,
    );
    if (!sandboxThread.ok) throw new Error(`The sandbox thread id is unusable: ${sandboxThread.error}`);
    const { stopped } = await replayModelTurns({
      model,
      turns: replaySource.customerTurns,
      languageMode,
      scope: {
        userId: user.id,
        platform: replaySource.platform,
        conversationId: sandboxThread.conversationId,
      },
      request: {
        supabaseUrl,
        anonKey,
        userJwt,
        testCaseKey,
        platform: replaySource.platform,
        socialAccountId: replaySource.socialAccountId,
      },
      runTurn: (input) => replayTurn(input),
      readThreadLanguage: (scope) => readSandboxThreadLanguage(admin, scope),
      onRow: async (row) => {
        resultRows.push(row);
        if (row.failure) failures += 1;
        await writeReports(resultRows);
        console.log(`Completed ${model} turn ${row.turn}/${replaySource.customerTurns.length}`);
      },
    });
    if (stopped) {
      console.warn(
        `[probe] ${model}: the replay stopped at the turn whose outcome could not be established; that thread is not replayed into again, and the other models still run`,
      );
    }
  }
  console.log(`Report written: ${REPORT_PATH}`);
  console.log(`Owner copy (not for the repository): ${DETAILED_REPORT_PATH}`);
  if (failures > 0) console.log(`${failures} turn(s) failed; see the Status column in the report`);
}

if (import.meta.main) {
  await main();
}
