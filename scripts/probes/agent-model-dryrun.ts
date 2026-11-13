import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { z } from "npm:zod@3.23.8";
import {
  sandboxConversationId,
  threadReplyLanguage,
  type LanguageMode,
  type ReplyLanguage,
} from "../../supabase/functions/ai-agent-reply/logic.ts";

const REPORT_PATH = "docs/superpowers/reports/2026-11-12-curemed-model-dryrun.md";
const REPORT_URL = new URL(`../../${REPORT_PATH}`, import.meta.url);
const REQUEST_TIMEOUT_MS = 120_000;

const SandboxResponseSchema = z.object({
  ok: z.boolean().optional(),
  reply: z.string().optional(),
  tool_calls: z.array(z.object({
    name: z.string(),
    arguments: z.record(z.unknown()).optional(),
  })).optional(),
});

type SandboxResponse = z.infer<typeof SandboxResponseSchema>;

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
  /** Whether the reply carried a URL at all. Not a product-link measurement; see hasUrl. */
  urlPresent: boolean;
  excerpt: string;
  /** Set when the turn failed. The probe records it and carries on with the next turn. */
  failure?: string;
}

interface ReplaySource {
  platform: string;
  socialAccountId: string;
  customerTurns: string[];
}

interface ReplayTurnInput {
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
 * The state the sandbox's own thread carries at a turn.
 *
 * `customerLanguage` is ai_threads.customer_language, read from the sandbox's thread
 * rather than guessed from the replayed turns: the sandbox writes it after every reply,
 * so it holds exactly the language the sandbox itself would use at the next turn.
 *
 * `processedTurns` are the customer turns the sandbox actually processed. A turn whose
 * request FAILED never reached the thread, so it is in neither the window nor the
 * language -- and a later letterless turn scored against it would be judged against
 * language the sandbox never stored.
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
 * The state the sandbox carries after a turn.
 *
 * A turn that never reached the sandbox changed nothing: its text is in neither the
 * window nor the thread's language. A turn that did reach it joins the window.
 */
export function sandboxStateAfterTurn(
  state: SandboxState,
  turn: { text: string; reachedTheSandbox: boolean },
): SandboxState {
  if (!turn.reachedTheSandbox) return state;
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

function catalogCalledWithQuery(sandboxResponse: SandboxResponse): boolean {
  return (sandboxResponse.tool_calls ?? []).some((call) => {
    const callArguments = call.arguments ?? {};
    if (callArguments.capability !== "search_products") return false;
    const parameters = isRecord(callArguments.parameters) ? callArguments.parameters : callArguments;
    return typeof parameters.query === "string" && parameters.query.trim().length > 0;
  });
}

/**
 * Whether the reply carried a URL at all.
 *
 * This is NOT a product-link measurement, and the report column says so. The
 * sandbox hands the probe the tool calls it made -- name and arguments -- and
 * never the catalog rows the tool returned, so the probe cannot tell the
 * catalog's product_url from a homepage, a support link or a tracking URL. A
 * column labelled "product link present" called a model product-link capable
 * when it had omitted the product page; "any URL present" is what the probe can
 * actually see, and the catalog column next to it says whether the catalog was
 * searched at all.
 */
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

export function renderReport(resultRows: readonly ResultRow[], conversation: string): string {
  const lines = [
    "# CureMed model dry-run comparison",
    "",
    `Source conversation: \`${markdownCell(conversation)}\``,
    "Generated by the owner-run sandbox probe. No reply was sent to the customer.",
    "",
    "## Results",
    "",
    "| Model | Turn | Latency ms | Reply language correct | Catalog tool called with non-empty query | Any URL present | Reply excerpt (120 chars) | Status |",
    "|---|---:|---:|---|---|---|---|---|",
    ...resultRows.map((row) =>
      `| ${markdownCell(row.model)} | ${row.turn} | ${row.latencyMs} | ${languageCell(row.languageScore)} | ${row.catalogQuery ? "yes" : "no"} | ${row.urlPresent ? "yes" : "no"} | ${row.excerpt || "(no reply)"} | ${row.failure ? `failed: ${markdownCell(row.failure)}` : "ok"} |`
    ),
    "",
    "## Model selection",
    "",
    "- Primary: results pending owner review.",
    "- Fallback: results pending owner review.",
    "",
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

async function replayTurn(input: ReplayTurnInput): Promise<Omit<ResultRow, "model" | "turn">> {
  const startedAt = Date.now();
  const response = await fetch(`${input.supabaseUrl}/functions/v1/ai-agent-reply`, {
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
  const parsedResponse = SandboxResponseSchema.safeParse(await response.json());
  if (!parsedResponse.success) throw new Error(`Sandbox returned an unexpected response for ${input.model}`);
  const sandboxResponse = parsedResponse.data;
  const reply = sandboxResponse.reply ?? "";

  return {
    latencyMs,
    languageScore: scoreLanguage(reply, input.expectedLanguage),
    catalogQuery: catalogCalledWithQuery(sandboxResponse),
    urlPresent: hasUrl(reply),
    excerpt: excerpt(reply),
  };
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
const ARABIC_LETTER_RE = /[\u0600-\u06FF]/g;
const SENTENCE_BREAK_RE = /[\n.!?؟]+/;

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
 */
export function dominantReplyLanguage(reply: string): ReplyLanguage {
  const text = reply.replace(URL_RE, " ").replace(WWW_URL_RE, " ");
  let arabicProse = 0;
  let latinProse = 0;
  let arabicLetters = 0;
  let latinLetters = 0;
  for (const segment of text.split(SENTENCE_BREAK_RE)) {
    const arabic = (segment.match(ARABIC_LETTER_RE) ?? []).length;
    const latin = (segment.match(LATIN_LETTER_RE) ?? []).length;
    arabicLetters += arabic;
    latinLetters += latin;
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
    let state: SandboxState = { customerLanguage: null, processedTurns: [], known: true };
    for (const [index, inboundText] of replaySource.customerTurns.entries()) {
      // The state the sandbox's OWN thread carries at this turn: the language it
      // persisted, and the turns it processed. Read from the sandbox rather than
      // guessed from the replayed words -- a turn the sandbox never saw changed
      // nothing, and scoring against it would judge a later turn against language the
      // sandbox never stored.
      const persisted = await readSandboxThreadLanguage(admin, {
        userId: user.id,
        platform: replaySource.platform,
        conversationId: sandboxThread.conversationId,
      });
      state = { ...state, customerLanguage: persisted ?? null, known: persisted !== undefined };
      const expectedLanguage = expectedSandboxLanguage(state, inboundText, languageMode);
      const startedAt = Date.now();
      let measurement: Omit<ResultRow, "model" | "turn">;
      let reachedTheSandbox = false;
      try {
        measurement = await replayTurn({
          supabaseUrl,
          anonKey,
          userJwt,
          model,
          testCaseKey,
          platform: replaySource.platform,
          socialAccountId: replaySource.socialAccountId,
          inboundText,
          expectedLanguage,
        });
        reachedTheSandbox = true;
      } catch (error) {
        // One model or turn failing must not end the comparison: the report says
        // which one failed, and the remaining models and turns still run.
        failures += 1;
        measurement = {
          latencyMs: Date.now() - startedAt,
          languageScore: "indeterminate",
          catalogQuery: false,
          urlPresent: false,
          excerpt: "",
          failure: error instanceof Error ? error.message : String(error),
        };
      }
      resultRows.push({ model, turn: index + 1, ...measurement });
      // Only a turn the sandbox processed joins its window and its language.
      state = sandboxStateAfterTurn(state, { text: inboundText, reachedTheSandbox });
      await Deno.writeTextFile(REPORT_URL, renderReport(resultRows, conversation));
      console.log(`Completed ${model} turn ${index + 1}/${replaySource.customerTurns.length}`);
    }
  }
  console.log(`Report written: ${REPORT_PATH}`);
  if (failures > 0) console.log(`${failures} turn(s) failed; see the Status column in the report`);
}

if (import.meta.main) {
  await main();
}
