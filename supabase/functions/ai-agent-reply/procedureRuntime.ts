// Procedure tools for one reply turn (Spec A, D1–D7, D12, and the debate verdicts in the plan).
// End actions go through ports so the sandbox can simulate writes and tests need no database.
import {
  type ProcedureState, claimHeldByOther, isPendingOpener, nextField, startProcedure, submitFields,
} from "../_shared/procedures/engine.ts";
import { type ProcedureConfig, enabledProcedures } from "../_shared/procedures/config.ts";
import {
  type ProcedureField, type ProcedureKey, type ProcedureOrigin, PROCEDURE_KEYS, isEventProcedureKey, productFinderFields, TEMPLATES,
} from "../_shared/procedures/templates.ts";
import { parseCustomerPhone } from "../_shared/phone.ts";
import { sanitizeFieldValue } from "./logic.ts";
import type { ToolResult } from "./tools.ts";

/** The store_events row a business-started flow is bound to. Ids come from this row only. */
export interface StoreEventRow {
  id: string;
  user_id: string;
  social_account_id: string;
  connector_id: string;
  flow: string;
  payload: Record<string, string>;
}

export type UpdateOrderResult =
  | { changed: true; status: string }
  | { changed: false; status: string }
  | { error: "store_write_denied" | "missing" };

export interface ProcedurePorts {
  /** True only when this turn's compare-and-set replaced the stored state with `claimed`. */
  claim(claimed: ProcedureState): Promise<boolean>;
  /** Upserts on meta_lead_id; true only when this call created the row. */
  saveLead(row: { meta_lead_id: string; lead_data: Record<string, string> }): Promise<boolean>;
  /** Number of admins the alert reached (0 = none configured or all sends failed). */
  notifyAdmin(message: string): Promise<number>;
  escalate(reason: string, summary: string): Promise<ToolResult>;
  /** Runs a typed store capability on the account's store connector; null when none is connected. */
  storeLookup(capability: "lookup_orders" | "search_products", parameters: Record<string, string>): Promise<ToolResult | null>;
  hasStoreCapability(capability: "lookup_orders" | "search_products"): boolean;
  logFailure(message: string, metadata: Record<string, string>): Promise<void>;
  /** store_events row whose id is the procedure run id, or null when there is none. A read error throws. */
  eventFor(runId: string): Promise<StoreEventRow | null>;
  /** update_order on the event's connector. The runtime has already checked read-only is the adapter's job. */
  updateOrder(input: {
    connectorId: string;
    orderId: string;
    note: string;
    status?: "cancelled";
    expectedStatuses: string[];
  }): Promise<UpdateOrderResult>;
  /** get_product on the event's connector. */
  getProduct(input: { connectorId: string; productId: string; parentId?: string }): Promise<
    { ok: true; name: string; price: string; permalink: string } | { ok: false }
  >;
}

export interface ProcedureTurnInput {
  state: ProcedureState | null;
  config: ProcedureConfig;
  ports: ProcedurePorts;
  dryRun: boolean;
  now: () => Date;
  /** Deterministic per inbound message when an outbox row exists (debate verdict 2). */
  runId: string;
  /** The account owner. Event end actions require the store_events row to name this user. */
  userId: string;
  /**
   * Phone of the customer on this turn. For WhatsApp this is recipient_phone.
   * Event end actions refuse when it does not match the event payload phone.
   */
  customerPhone: string;
  leadContext: { platform: string; socialAccountId: string | null; conversationId: string };
}

export interface ProcedureTurn {
  handle(name: string, args: Record<string, unknown>): Promise<ToolResult>;
  start(key: ProcedureKey, origin: ProcedureOrigin): boolean;
  /** Ends the flow for a handoff; later procedure tool calls in the turn are refused. */
  endForHandoff(): void;
  readonly state: ProcedureState | null;
  readonly progressed: boolean;
  readonly completed: ProcedureKey | null;
  /** Another turn owns this flow's end action; this turn's reply must not be delivered. */
  readonly claimConflict: boolean;
  /** A store-event opener awaits the worker: the turn offers no procedure tools and changes nothing. */
  readonly inert: boolean;
}

export const PROCEDURE_TOOL_NAMES: ReadonlySet<string> = new Set(["start_procedure", "procedure_submit", "procedure_cancel"]);

export function fieldsFor(key: ProcedureKey, config: ProcedureConfig): ProcedureField[] {
  return key === "product_finder"
    ? productFinderFields(config.product_finder?.questions?.length ?? 0)
    : TEMPLATES[key].fields;
}

/** What to ask next, with the business's wording, questions and services. */
export function stepGuidance(state: ProcedureState, config: ProcedureConfig): string {
  const fields = fieldsFor(state.key, config);
  const next = nextField(state, fields);
  if (!next) return "";
  const settings = config[state.key];
  const wording = state.key === "product_finder"
    ? settings?.questions?.[fields.indexOf(next)] ?? ""
    : settings?.prompts[next.name] ?? "";
  const services = state.key === "booking" && next.name === "service" && settings?.services?.length
    ? ` Offer only these services: ${settings.services.join(", ")}.`
    : "";
  const accept = next.hint ? ` (accept: ${next.hint})` : "";
  return `Needed now: ${next.name}${accept}.${wording ? ` Ask it this way, in the customer's language: ${wording}` : ""}${services}`;
}

export function procedureToolDefinitions(enabled: ProcedureKey[], activeKey: ProcedureKey | null = null) {
  if (!enabled.length) return [];
  // Event flows are started by the worker. Offering them here would let the model open one.
  const startable = enabled.filter((key) => !isEventProcedureKey(key));
  return [
    ...(startable.length ? [{
      type: "function",
      function: {
        name: "start_procedure",
        description:
          "Start a guided procedure when the customer's request matches one. Only one runs at a time. You may call procedure_submit in the same response if the message already contains a field.",
        parameters: { type: "object", properties: { key: { type: "string", enum: startable } }, required: ["key"] },
      },
    }] : []),
    {
      type: "function",
      function: {
        name: "procedure_submit",
        description: "Record field values the customer actually stated for the active procedure.",
        parameters: {
          type: "object",
          properties: { fields: { type: "object", additionalProperties: { type: "string" } } },
          required: ["fields"],
        },
      },
    },
    // On a COD confirmation "cancel" is the customer's decision, not a way out of the flow:
    // it must reach the order through procedure_submit (PR #214 review).
    ...(activeKey === "cod_confirm" ? [] : [{
      type: "function",
      function: {
        name: "procedure_cancel",
        description: "End the active procedure when the customer asks to stop or clearly changes topic.",
        parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
      },
    }]),
  ];
}

const TEAM_FOLLOW_UP = "Tell the customer the team will follow up. Do not say the order was changed.";
const COD_EXPECTED = ["pending", "on-hold", "processing"];
const CONFIRM_NOTE = "Confirmed by the customer on WhatsApp (Postora)";
const CANCEL_NOTE = "Customer asked to cancel on WhatsApp (Postora)";

/** International digits, or the digit run when the number is already bare. */
function canonicalCustomerPhone(raw: string | undefined): string | null {
  if (!raw || raw.toLowerCase().includes("@")) return null;
  return parseCustomerPhone(raw, null) ?? customerPhoneForWaitlist(raw);
}

function sameCustomer(eventPhone: string | undefined, turnPhone: string): boolean {
  const eventDigits = canonicalCustomerPhone(eventPhone);
  const turnDigits = canonicalCustomerPhone(turnPhone);
  return eventDigits !== null && eventDigits === turnDigits;
}

/** A non-digit order id is not an order. COD requires one; other flows refuse a bad one when it is present. */
function eventOrderIdOk(event: StoreEventRow): boolean {
  const orderId = event.payload.order_id;
  if (orderId !== undefined && !/^\d+$/.test(orderId)) return false;
  if (event.flow === "cod_confirm") return /^\d+$/.test(orderId ?? "");
  return true;
}

export interface StoreEventLookup {
  id: string;
  userId: string;
  socialAccountId: string;
}

const RUN_ID_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Null when this turn has no uuid account to bind the service-role read to. */
export function storeEventReadScope(
  runId: string,
  userId: string,
  socialAccountId: string | null,
): StoreEventLookup | null {
  if (!RUN_ID_UUID.test(runId) || !socialAccountId) return null;
  return { id: runId, userId, socialAccountId };
}

export interface StoreEventEq {
  eq(column: "id" | "user_id" | "social_account_id", value: string): StoreEventEq;
}

/** id, user_id, and social_account_id. eventMatches is the second check, not the only one. */
export function scopeStoreEventRead(query: StoreEventEq, lookup: StoreEventLookup): StoreEventEq {
  return query.eq("id", lookup.id).eq("user_id", lookup.userId).eq("social_account_id", lookup.socialAccountId);
}

function eventMatches(event: StoreEventRow | null, input: ProcedureTurnInput, flow: string): event is StoreEventRow {
  return !!event
    && event.user_id === input.userId
    && event.social_account_id === input.leadContext.socialAccountId
    && event.flow === flow
    && event.connector_id.length > 0
    && sameCustomer(event.payload.phone, input.customerPhone)
    && eventOrderIdOk(event);
}

/** Mismatch is terminal for this turn: the customer hears the follow-up, and nothing is written to the store. */
async function refuseEvent(input: ProcedureTurnInput, done: ProcedureState): Promise<ToolResult> {
  await input.ports.logFailure("Store event does not match this turn", { procedure: done.key, run_id: done.run_id });
  await input.ports.notifyAdmin(`A ${done.key} reply was refused because the stored event does not match this conversation.`);
  return { output: TEAM_FOLLOW_UP };
}

async function loadEvent(
  input: ProcedureTurnInput,
  done: ProcedureState,
): Promise<{ ok: true; event: StoreEventRow } | { ok: false; result: ToolResult }> {
  if (input.dryRun) {
    return { ok: false, result: { output: `Procedure complete: ${done.key} would finish now (test mode, nothing written).` } };
  }
  const event = await input.ports.eventFor(done.run_id);
  if (!eventMatches(event, input, done.key)) return { ok: false, result: await refuseEvent(input, done) };
  return { ok: true, event };
}

async function finishCod(input: ProcedureTurnInput, done: ProcedureState): Promise<ToolResult> {
  const loaded = await loadEvent(input, done);
  if (!loaded.ok) return loaded.result;
  const orderId = loaded.event.payload.order_id ?? "";
  if (!/^\d+$/.test(orderId)) return refuseEvent(input, done);
  const cancel = done.fields.decision === "cancel";
  const result = await input.ports.updateOrder({
    connectorId: loaded.event.connector_id,
    orderId,
    note: cancel ? CANCEL_NOTE : CONFIRM_NOTE,
    ...(cancel ? { status: "cancelled" as const } : {}),
    expectedStatuses: COD_EXPECTED,
  });
  if ("error" in result) {
    await input.ports.logFailure("Store write was denied", { procedure: done.key, run_id: done.run_id, order_id: orderId });
    await input.ports.notifyAdmin(`COD order ${orderId} could not be updated because the store refused the write.`);
    return { output: TEAM_FOLLOW_UP };
  }
  if (!result.changed) {
    await input.ports.logFailure("Order status changed before the write", { procedure: done.key, run_id: done.run_id, order_id: orderId, status: result.status });
    await input.ports.notifyAdmin(`COD order ${orderId} was not changed because its status is now ${result.status}.`);
    return { output: TEAM_FOLLOW_UP };
  }
  if (cancel) {
    await input.ports.notifyAdmin(`COD order ${orderId} was cancelled at the customer's request on WhatsApp.`);
    return { output: `The order ${orderId} is cancelled. Tell the customer their order was cancelled.` };
  }
  return { output: `The order ${orderId} is confirmed. Tell the customer their cash-on-delivery order is confirmed. Do not say it was cancelled.` };
}

async function finishReview(input: ProcedureTurnInput, done: ProcedureState): Promise<ToolResult> {
  const loaded = await loadEvent(input, done);
  if (!loaded.ok) return loaded.result;
  const rating = Number(done.fields.rating);
  if (rating >= 4) {
    const url = input.config.review_request?.review_url;
    if (!url) return refuseEvent(input, done);
    return { output: `Send the customer this review link: ${url}` };
  }
  const summary = `Rating ${done.fields.rating}. Problem: ${sanitizeFieldValue(done.fields.problem ?? "")}.`;
  return await input.ports.escalate("Low review rating", summary);
}

async function finishStock(input: ProcedureTurnInput, done: ProcedureState): Promise<ToolResult> {
  const loaded = await loadEvent(input, done);
  if (!loaded.ok) return loaded.result;
  if (done.fields.interest !== "yes") {
    return { output: "Procedure complete. The customer does not want the product link." };
  }
  const productId = loaded.event.payload.product_id ?? "";
  if (!/^\d+$/.test(productId)) return refuseEvent(input, done);
  const parentId = loaded.event.payload.parent_id;
  const product = await input.ports.getProduct({
    connectorId: loaded.event.connector_id,
    productId,
    ...(parentId && /^\d+$/.test(parentId) && parentId !== "0" ? { parentId } : {}),
  });
  if (!product.ok) throw new Error("product_unavailable");
  return { output: `Send the customer this product link and price. Name: ${product.name}. Price: ${product.price}. Link: ${product.permalink}.` };
}

export interface StockSighting {
  connectorId: string;
  productId: string;
  parentId: string | null;
  name: string;
  stockStatus: string;
}

export function stockSightingsFromData(connectorId: string, data: unknown): StockSighting[] {
  if (!Array.isArray(data)) return [];
  const sightings: StockSighting[] = [];
  for (const row of data) {
    if (typeof row !== "object" || row === null) continue;
    const record = row as Record<string, unknown>;
    const productId = typeof record.id === "number" || typeof record.id === "string" ? String(record.id) : "";
    if (!/^\d+$/.test(productId)) continue;
    const parentText = typeof record.parent_id === "number" || typeof record.parent_id === "string" ? String(record.parent_id) : "";
    sightings.push({
      connectorId,
      productId,
      parentId: /^\d+$/.test(parentText) && parentText !== "0" ? parentText : null,
      name: typeof record.name === "string" ? record.name.slice(0, 200) : "",
      stockStatus: typeof record.stock_status === "string" ? record.stock_status : "",
    });
  }
  return sightings;
}

/** Pulls projected products out of the model-facing connector text. A truncated payload is ignored. */
export function stockSightingsFromToolOutput(connectorId: string, output: string): StockSighting[] {
  const marker = "returned: ";
  const at = output.indexOf(marker);
  if (at < 0) return [];
  try {
    return stockSightingsFromData(connectorId, JSON.parse(output.slice(at + marker.length).replace(/ …\[output truncated:.*$/, "")));
  } catch {
    return [];
  }
}

/** Digits already resolved for this customer. An @lid id is not a phone. */
export function customerPhoneForWaitlist(raw: string): string | null {
  if (raw.toLowerCase().includes("@")) return null;
  const digits = raw.replace(/\D/g, "");
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

export interface WaitlistJoinRow {
  user_id: string;
  social_account_id: string;
  connector_id: string;
  conversation_id: string;
  phone: string;
  product_id: number;
  parent_id: number | null;
  product_name: string;
  consent_source: "chat_optin";
  consented_at: string;
  /** Renewed on every join, including a conflict update. Matches the column default of 60 days. */
  expires_at: string;
}

const WAITLIST_KEEP_MS = 60 * 24 * 60 * 60 * 1000;

/** stock_waitlist_account_connector_phone_product_key. Two accounts may wait on one store product. */
export const STOCK_WAITLIST_ON_CONFLICT = "social_account_id,connector_id,phone,product_id";

export type WaitlistPlan =
  | { action: "refuse"; output: string }
  | { action: "dry_run"; output: string }
  | { action: "upsert"; row: WaitlistJoinRow; onConflict: typeof STOCK_WAITLIST_ON_CONFLICT; output: string };

/**
 * The product id selects which earlier check_stock row to copy. Name, parent
 * and connector come from that row, never from the model's other text.
 */
export function planWaitlistJoin(input: {
  productId: string;
  sightings: StockSighting[];
  platform: string;
  phone: string | null;
  dryRun: boolean;
  userId: string;
  socialAccountId: string | null;
  conversationId: string;
  now: string;
}): WaitlistPlan {
  if (input.platform !== "whatsapp") return { action: "refuse", output: "Waitlist join is only available on WhatsApp." };
  const matches = input.sightings.filter((sighting) => sighting.productId === input.productId);
  if (!matches.length) return { action: "refuse", output: "Refused: no stock check in this turn found that product." };
  const outOfStock = matches.filter((sighting) => sighting.stockStatus !== "instock");
  if (!outOfStock.length) return { action: "refuse", output: "Refused: that product is in stock." };
  const connectors = new Set(outOfStock.map((sighting) => sighting.connectorId));
  if (connectors.size > 1) {
    return {
      action: "refuse",
      output: "Refused: that product id was returned by more than one store. Ask the customer which product they mean.",
    };
  }
  const source = outOfStock[0];
  const phone = input.phone ? customerPhoneForWaitlist(input.phone) : null;
  if (!phone || !input.socialAccountId) return { action: "refuse", output: "Refused: this chat has no customer phone." };
  const productId = Number(source.productId);
  if (!Number.isSafeInteger(productId)) return { action: "refuse", output: "Refused: no stock check in this turn found that product." };
  if (input.dryRun) return { action: "dry_run", output: "(test mode, nothing written) The customer would be added to the waitlist." };
  return {
    action: "upsert",
    onConflict: STOCK_WAITLIST_ON_CONFLICT,
    output: `Saved. Tell the customer we will WhatsApp them when ${source.name || "the product"} is back in stock.`,
    row: {
      user_id: input.userId,
      social_account_id: input.socialAccountId,
      connector_id: source.connectorId,
      conversation_id: input.conversationId,
      phone,
      product_id: productId,
      parent_id: source.parentId ? Number(source.parentId) : null,
      product_name: source.name,
      consent_source: "chat_optin",
      consented_at: input.now,
      expires_at: new Date(Date.parse(input.now) + WAITLIST_KEEP_MS).toISOString(),
    },
  };
}

/** Offered only once this turn has seen the product out of stock. */
export function stockWaitlistToolDefinition(sightings: StockSighting[]) {
  const ids = [...new Set(sightings.filter((sighting) => sighting.stockStatus !== "instock").map((sighting) => sighting.productId))];
  if (!ids.length) return null;
  return {
    type: "function" as const,
    function: {
      name: "stock_waitlist_join",
      description:
        "Save this WhatsApp customer for a message when an out-of-stock product returns. Use only a product id that check_stock just showed as not in stock.",
      parameters: {
        type: "object",
        properties: {
          product_id: { type: "string", enum: ids, description: "Product id copied from this turn's check_stock result." },
        },
        required: ["product_id"],
      },
    },
  };
}

/** True when this connector has a store_webhook_bindings row for the chat's social account. */
export interface StoreBindingPort {
  hasStoreBinding(connectorId: string): Promise<boolean>;
}

export const WAITLIST_BINDING_REFUSAL =
  "Refused: stock notifications are not set up for this store. Do not tell the customer they will be notified.";

export const WAITLIST_NOTIFICATIONS_NOT_SET_UP =
  "Stock notifications are not set up for this store. Do not tell the customer they will be messaged when the product is back.";

/** True only when this turn's tool list actually contained stock_waitlist_join. */
export function stockWaitlistJoinOffered(
  waitlistOn: boolean,
  offeredTools: ReadonlyArray<{ function?: { name?: string } }>,
): boolean {
  return waitlistOn && offeredTools.some((tool) => tool.function?.name === "stock_waitlist_join");
}

/** Join when it was offered. Otherwise the usual unknown-tool line, and `join` is not called. */
export async function executeOfferedWaitlistJoin(
  offered: boolean,
  join: () => Promise<ToolResult>,
): Promise<ToolResult> {
  if (!offered) return { output: "Unknown tool: stock_waitlist_join" };
  return await join();
}

/** Tool for this round, plus the line the model hears when nothing can be offered. */
export function waitlistRound(sightings: StockSighting[], offered: StockSighting[]): {
  tool: ReturnType<typeof stockWaitlistToolDefinition>;
  gap: string | null;
} {
  const tool = stockWaitlistToolDefinition(offered);
  const gap = !tool && sightings.some((sighting) => sighting.stockStatus !== "instock")
    ? WAITLIST_NOTIFICATIONS_NOT_SET_UP
    : null;
  return { tool, gap };
}

const WAITLIST_FOLLOW_UP = "The waitlist could not be saved. Tell the customer the team will follow up.";

/** Out-of-stock sightings whose connector can actually deliver a later WhatsApp. */
export async function boundWaitlistSightings(
  sightings: StockSighting[],
  port: StoreBindingPort,
): Promise<StockSighting[]> {
  const cached = new Map<string, boolean>();
  const bound = async (connectorId: string) => {
    const known = cached.get(connectorId);
    if (known !== undefined) return known;
    const answer = await port.hasStoreBinding(connectorId);
    cached.set(connectorId, answer);
    return answer;
  };
  const offered: StockSighting[] = [];
  for (const sighting of sightings) {
    if (sighting.stockStatus === "instock") continue;
    if (await bound(sighting.connectorId)) offered.push(sighting);
  }
  return offered;
}

export async function planBoundWaitlistJoin(
  input: Parameters<typeof planWaitlistJoin>[0],
  port: StoreBindingPort,
): Promise<WaitlistPlan> {
  const plan = planWaitlistJoin(input);
  if (plan.action === "refuse") return plan;
  const connectorId = plan.action === "upsert"
    ? plan.row.connector_id
    : input.sightings.find((sighting) => sighting.productId === input.productId && sighting.stockStatus !== "instock")?.connectorId;
  if (!connectorId || !(await port.hasStoreBinding(connectorId))) {
    return { action: "refuse", output: WAITLIST_BINDING_REFUSAL };
  }
  return plan;
}

export interface WaitlistEnrollmentLog {
  source: "ai-agent-reply";
  category: "ai";
  level: "warn";
  message: "Waitlist enrollment failed";
  user_id: string;
  metadata: {
    social_account_id: string;
    connector_id: string;
    product_id: string;
    error_code: string;
  };
}

export interface WaitlistLogPort {
  insert(entry: WaitlistEnrollmentLog): Promise<{ error: { message?: string } | null }>;
}

export function waitlistErrorCode(error: { code?: unknown }): string {
  const code = typeof error.code === "string" ? error.code.trim() : "";
  return /^[A-Za-z0-9]{1,10}$/.test(code) ? code : "upsert_failed";
}

function consoleSafe(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? "log_failed");
  return text.replace(/\+?\d[\d\s-]{5,}\d/g, "[redacted]").slice(0, 200);
}

export async function recordWaitlistEnrollmentFailure(
  port: WaitlistLogPort,
  input: {
    userId: string;
    socialAccountId: string;
    connectorId: string;
    productId: string;
    errorCode: string;
  },
): Promise<void> {
  const entry: WaitlistEnrollmentLog = {
    source: "ai-agent-reply",
    category: "ai",
    level: "warn",
    message: "Waitlist enrollment failed",
    user_id: input.userId,
    metadata: {
      social_account_id: input.socialAccountId,
      connector_id: input.connectorId,
      product_id: input.productId,
      error_code: input.errorCode,
    },
  };
  try {
    const { error } = await port.insert(entry);
    if (error) console.error("[ai-agent-reply] waitlist failure log rejected:", consoleSafe(error.message));
  } catch (error) {
    console.error("[ai-agent-reply] waitlist failure log rejected:", consoleSafe(error));
  }
}

/** Upserts only an already-accepted plan. A failed write is logged, then the follow-up text is returned. */
export async function enrollWaitlist(
  plan: WaitlistPlan,
  ports: {
    upsert(row: WaitlistJoinRow, onConflict: string): Promise<{ error: { code?: unknown; message?: string } | null }>;
    log: WaitlistLogPort;
  },
): Promise<string> {
  if (plan.action !== "upsert") return plan.output;
  let failure: { code?: unknown; message?: string } | null = null;
  try {
    const result = await ports.upsert(plan.row, plan.onConflict);
    failure = result.error;
  } catch {
    failure = { code: "upsert_failed" };
  }
  if (!failure) return plan.output;
  await recordWaitlistEnrollmentFailure(ports.log, {
    userId: plan.row.user_id,
    socialAccountId: plan.row.social_account_id,
    connectorId: plan.row.connector_id,
    productId: String(plan.row.product_id),
    errorCode: waitlistErrorCode(failure),
  });
  return WAITLIST_FOLLOW_UP;
}

export function createProcedureTurn(input: ProcedureTurnInput): ProcedureTurn {
  const enabled = new Set(enabledProcedures(input.config));
  const inert = isPendingOpener(input.state);
  // Verdict 9: the stored flow is judged by its own toggle, not by "some flow is on".
  let state = !inert && input.state && enabled.has(input.state.key) && fieldsFor(input.state.key, input.config).length
    ? input.state
    : null;
  let progressed = false;
  let handedOff = false;
  let completed: ProcedureKey | null = null;
  let claimConflict = false;

  const canStart = (key: ProcedureKey): boolean => {
    const capability = TEMPLATES[key].needsCapability;
    return !inert && !isEventProcedureKey(key) && enabled.has(key) && (!capability || input.ports.hasStoreCapability(capability));
  };

  const start = (key: ProcedureKey, origin: ProcedureOrigin): boolean => {
    // One flow per turn: a second run would share this turn's run id and its save would be dropped.
    if (state || handedOff || completed || !canStart(key)) return false;
    state = startProcedure(null, key, origin, input.now(), input.runId).state;
    progressed = true;
    return true;
  };

  const alertLines = (fields: Record<string, string>) =>
    Object.entries(fields).map(([name, value]) => `${name}: ${sanitizeFieldValue(value)}`);

  const customerFollowUp =
    "Tell the customer the team will contact them soon. Do not say an order was placed or that a booking is confirmed.";

  const saveAndAlert = async (done: ProcedureState, kind: "lead" | "booking"): Promise<ToolResult> => {
    if (input.dryRun) {
      return { output: `Procedure complete: the ${kind} would be saved (test mode, nothing written). ${customerFollowUp}` };
    }
    const created = await input.ports.saveLead({
      meta_lead_id: `ai:${done.run_id}`,
      lead_data: {
        kind, source: "ai_agent", platform: input.leadContext.platform,
        social_account_id: input.leadContext.socialAccountId ?? "",
        conversation_id: input.leadContext.conversationId, ...done.fields,
      },
    });
    // Verdict 2: only the call that created the row alerts, so a retried turn never alerts twice.
    if (created) {
      const reached = await input.ports.notifyAdmin([`New ${kind} from the AI agent`, ...alertLines(done.fields)].join("\n"));
      if (reached === 0) {
        await input.ports.logFailure(`Procedure ${kind} saved but no admin alert was delivered`, { run_id: done.run_id });
      }
    }
    return { output: `Procedure complete: the ${kind} is saved. ${customerFollowUp}` };
  };

  const finish = async (done: ProcedureState): Promise<ToolResult> => {
    const closing = input.config[done.key]?.closing;
    const withClosing = (result: ToolResult): ToolResult =>
      closing ? { ...result, output: `${result.output}\nClose with this message, in the customer's language: ${closing}` } : result;
    switch (TEMPLATES[done.key].endAction) {
      case "order_lookup": {
        const found = await input.ports.storeLookup("lookup_orders", { order_id: done.fields.order_number });
        if (!found) throw new Error("store connector missing");
        return withClosing({ output: `Store result:\n${found.output}\nReply with order number, status, date, items and total. If no order matched, say so and offer a human.` });
      }
      case "product_search": {
        const found = await input.ports.storeLookup("search_products", { query: Object.values(done.fields).join(" ") });
        if (!found) throw new Error("store connector missing");
        return withClosing({ output: `Store result:\n${found.output}\nShow the top 3 products.` });
      }
      case "save_lead":
        return withClosing(await saveAndAlert(done, "lead"));
      case "save_booking":
        return withClosing(await saveAndAlert(done, "booking"));
      case "handoff": {
        const summary = `Order ${done.fields.order_number}. Problem: ${sanitizeFieldValue(done.fields.problem)}.`;
        handedOff = true;
        return await input.ports.escalate("Complaint or return", summary); // verdict 6: flags kept
      }
      case "cod_update":
        return withClosing(await finishCod(input, done));
      case "review_route":
        return withClosing(await finishReview(input, done));
      case "stock_offer":
        return withClosing(await finishStock(input, done));
    }
  };

  const retryOutput =
    "The last step could not be completed. Apologise and offer a human; if the customer wants to try again, call procedure_submit with no fields to retry.";

  const complete = async (done: ProcedureState): Promise<ToolResult> => {
    try {
      // Claim first. A compare-and-set of the stored value onto itself would let two
      // concurrent retries both pass, so claimed_by makes the next value different.
      // A live claim by another run is not overwritten: that run may be mid end action.
      if (!input.dryRun) {
        const now = input.now();
        const claimed = { ...done, claimed_by: input.runId, claimed_at: now.toISOString() };
        if (claimHeldByOther(done, input.runId, now) || !(await input.ports.claim(claimed))) {
          claimConflict = true;
          await input.ports.logFailure("Procedure claim lost", { procedure: done.key, run_id: done.run_id });
          return { output: retryOutput };
        }
      }
      const output = await finish(done);
      completed = done.key;
      state = null;
      return output;
    } catch (error) {
      await input.ports.logFailure("Procedure end action failed", {
        procedure: done.key, run_id: done.run_id, error: error instanceof Error ? error.name : "Error",
      });
      return { output: retryOutput };
    }
  };

  const submit = async (args: Record<string, unknown>): Promise<ToolResult> => {
    if (!state) return { output: "No procedure is active; start one first." };
    const fields = fieldsFor(state.key, input.config);
    // A state kept after a failed end action already holds every field: retry the action
    // rather than waiting for a field the customer has already given (PR #209 review).
    if (!nextField(state, fields)) {
      progressed = true;
      return await complete(state);
    }
    const raw = (typeof args.fields === "object" && args.fields !== null ? args.fields : {}) as Record<string, unknown>;
    const result = submitFields(state, fields, raw, input.now());
    const rejected = result.rejected.map((r) => `${r.field} (${r.reason})`).join(", ");
    if (!result.accepted.length) {
      return { output: `Nothing recorded. Rejected: ${rejected || "no fields"}. ${stepGuidance(state, input.config)}` };
    }
    progressed = true;
    state = result.state;
    if (!result.complete) {
      return { output: `Recorded ${result.accepted.join(", ")}.${rejected ? ` Rejected: ${rejected}.` : ""} ${stepGuidance(state, input.config)}` };
    }
    return await complete(state);
  };

  const handle = async (name: string, args: Record<string, unknown>): Promise<ToolResult> => {
    if (handedOff) return { output: "The conversation was handed to a human; the procedure has ended." };
    if (inert) return { output: "No procedure is available right now." };
    if (name === "start_procedure") {
      const key = String(args.key ?? "") as ProcedureKey;
      if (!(PROCEDURE_KEYS as readonly string[]).includes(key) || isEventProcedureKey(key) || !enabled.has(key)) {
        return { output: `Procedure ${key} is not enabled for this account.` };
      }
      if (state) return { output: `Procedure ${state.key} is already active. ${stepGuidance(state, input.config)}` };
      if (!start(key, "model")) return { output: `Procedure ${key} cannot start: the store connector it needs is not connected.` };
      return { output: `Procedure ${key} started. ${stepGuidance(state!, input.config)}` };
    }
    if (name === "procedure_cancel") {
      if (!state) return { output: "No procedure is active." };
      if (state.key === "cod_confirm") {
        return { output: 'This order confirmation cannot be ended here. If the customer wants to cancel the order, call procedure_submit with {"decision": "cancel"}.' };
      }
      state = null;
      progressed = true;
      return { output: "Procedure ended. Continue the conversation normally." };
    }
    if (name === "procedure_submit") return await submit(args);
    return { output: `Unknown tool: ${name}` };
  };

  return {
    handle,
    start,
    endForHandoff() {
      handedOff = true;
      state = null;
    },
    get state() { return state; },
    get progressed() { return progressed; },
    get completed() { return completed; },
    get claimConflict() { return claimConflict; },
    get inert() { return inert; },
  };
}
