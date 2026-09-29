// Procedure ports for one reply. The handler stays the adapter; these methods are the
// database and connector boundary the procedure runtime calls.
import { modelBudgetRemaining, procedureStoreTool } from "./logic.ts";
import {
  connectorCallFailed,
  executeProcedureStoreCall,
  executeRoutedCustomTool,
} from "./connectorExecution.ts";
import { executeTool, notifyAdmins, type CustomTool, type ToolContext, type ToolResult } from "./tools.ts";
import { persistProcedureState, type ProcedureStateDb } from "./procedureState.ts";
import {
  scopeStoreEventRead,
  storeEventReadScope,
  type ProcedurePorts,
  type StoreEventEq,
  type StoreEventRow,
  type UpdateOrderResult,
} from "./procedureRuntime.ts";

export interface ProcedureStateSlot {
  current: unknown;
}

interface ProcedureFailureLog {
  insert(row: Record<string, unknown>): PromiseLike<{ error: { message: string } | null }>;
}

interface ProcedureLeadWrite {
  upsert(
    row: Record<string, unknown>,
    options: { onConflict: string; ignoreDuplicates: boolean },
  ): {
    select(columns: "id"): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
  };
}

interface ProcedureEventRead {
  select(columns: string): unknown;
}

/**
 * The service client. persistProcedureState already names the thread writer.
 * Leads, logs and store events use the same client; their builders are named
 * at the call because one from() overload cannot list every table.
 */
export type ProcedurePortsDb = ProcedureStateDb;

function leadsOf(admin: ProcedurePortsDb): ProcedureLeadWrite {
  return (admin as unknown as { from(table: "leads"): ProcedureLeadWrite }).from("leads");
}

function failureLogsOf(admin: ProcedurePortsDb): ProcedureFailureLog {
  return (admin as unknown as { from(table: "system_logs"): ProcedureFailureLog }).from("system_logs");
}

function storeEventsOf(admin: ProcedurePortsDb): ProcedureEventRead {
  return (admin as unknown as { from(table: "store_events"): ProcedureEventRead }).from("store_events");
}

export interface ProcedurePortsInput {
  admin: ProcedurePortsDb;
  threadId: string;
  /** Shared with the handler's final compare-and-set. claim writes the winner here. */
  durableState: ProcedureStateSlot;
  userId: string;
  platform: string;
  toolContext: ToolContext;
  customTools: CustomTool[];
  startedAt: number;
  /** Same flag the procedure turn receives. Sandbox replies are dry runs. */
  dryRun: boolean;
  executeRoutedCustomTool: typeof executeRoutedCustomTool;
  executeProcedureStoreCall: typeof executeProcedureStoreCall;
}

function budgetLeft(input: ProcedurePortsInput): number {
  return modelBudgetRemaining(input.startedAt, Date.now());
}

function storeTool(input: ProcedurePortsInput, capability: "lookup_orders" | "search_products"): CustomTool | null {
  return procedureStoreTool(input.customTools, capability);
}

function wooTool(input: ProcedurePortsInput, connectorId: string): CustomTool | null {
  return input.customTools.find((tool) => tool.id === connectorId && tool.connector_type === "woocommerce") ?? null;
}

/**
 * Connector failures arrive as text. A denied write is a result the runtime can say;
 * every other failure stays on the final step so the turn can retry.
 */
function storePayloadFromConnector(found: ToolResult): Record<string, unknown> {
  if (connectorCallFailed(found)) {
    if (found.output.includes("[store_write_denied]") || found.output.includes("[read_only_violation]")) {
      return { error: "store_write_denied" };
    }
    throw new Error("store_lookup_failed");
  }
  const marker = "returned: ";
  const at = found.output.indexOf(marker);
  if (at < 0) throw new Error("store_lookup_failed");
  const parsed = JSON.parse(found.output.slice(at + marker.length));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("store_lookup_failed");
  return parsed as Record<string, unknown>;
}

async function claimProcedure(input: ProcedurePortsInput, claimed: Parameters<ProcedurePorts["claim"]>[0]): Promise<boolean> {
  const won = await persistProcedureState(input.admin, input.threadId, input.durableState.current, claimed);
  if (won) input.durableState.current = claimed;
  return won;
}

async function saveProcedureLead(
  input: ProcedurePortsInput,
  row: Parameters<ProcedurePorts["saveLead"]>[0],
): Promise<boolean> {
  const { data, error } = await leadsOf(input.admin).upsert(
    { user_id: input.userId, form_id: null, status: "new", ...row },
    { onConflict: "meta_lead_id", ignoreDuplicates: true },
  ).select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length > 0;
}

async function logProcedureFailure(
  input: ProcedurePortsInput,
  message: string,
  metadata: Record<string, string>,
): Promise<void> {
  // system_logs is the admin incident feed. A sandbox failure is the test itself.
  if (input.dryRun) {
    console.warn("[ai-agent-reply] Procedure failure skipped for sandbox:", message);
    return;
  }
  const { error } = await failureLogsOf(input.admin).insert({
    source: "ai-agent-reply",
    category: "ai",
    level: "warn",
    message,
    user_id: input.userId,
    metadata: { platform: input.platform, ...metadata },
  });
  if (error) console.error("[ai-agent-reply] Procedure failure log rejected:", error.message);
}

async function procedureEventFor(input: ProcedurePortsInput, runId: string): Promise<StoreEventRow | null> {
  const scope = storeEventReadScope(runId, input.userId, input.toolContext.socialAccountId);
  if (!scope) return null;
  // The generated filter builder is too deep to pass through a generic.
  // The cast keeps the three equality filters on the real query.
  const scoped = scopeStoreEventRead(
    storeEventsOf(input.admin).select("id, user_id, social_account_id, connector_id, flow, payload") as unknown as StoreEventEq,
    scope,
  ) as unknown as {
    maybeSingle(): Promise<{
      data: {
        id: unknown;
        user_id: unknown;
        social_account_id: unknown;
        connector_id: unknown;
        flow: unknown;
        payload: unknown;
      } | null;
      error: { message: string } | null;
    }>;
  };
  const { data, error } = await scoped.maybeSingle();
  if (error) throw new Error("store_event_read_failed");
  if (!data || typeof data.user_id !== "string" || typeof data.social_account_id !== "string" || typeof data.connector_id !== "string" || typeof data.flow !== "string") {
    return null;
  }
  const payload: Record<string, string> = {};
  if (data.payload && typeof data.payload === "object" && !Array.isArray(data.payload)) {
    for (const [key, value] of Object.entries(data.payload as Record<string, unknown>)) {
      if (typeof value === "string") payload[key] = value;
      else if (typeof value === "number" && Number.isFinite(value)) payload[key] = String(value);
    }
  }
  return {
    id: String(data.id),
    user_id: data.user_id,
    social_account_id: data.social_account_id,
    connector_id: data.connector_id,
    flow: data.flow,
    payload,
  };
}

async function lookupStore(
  input: ProcedurePortsInput,
  capability: "lookup_orders" | "search_products",
  parameters: Record<string, string>,
): Promise<ToolResult | null> {
  const tool = storeTool(input, capability);
  if (!tool) return null;
  const found = await input.executeRoutedCustomTool(
    input.toolContext,
    tool,
    { capability, parameters },
    {},
    budgetLeft(input),
  );
  if (connectorCallFailed(found)) throw new Error("store_lookup_failed");
  return found;
}

async function updateProcedureOrder(
  input: ProcedurePortsInput,
  order: Parameters<ProcedurePorts["updateOrder"]>[0],
): Promise<UpdateOrderResult> {
  const tool = wooTool(input, order.connectorId);
  if (!tool) return { error: "missing" };
  const found = await input.executeProcedureStoreCall(input.toolContext, tool, {
    capability: "update_order",
    method: "POST",
    parameters: {
      order_id: order.orderId,
      note: order.note,
      expected_statuses: order.expectedStatuses,
      ...(order.status ? { status: order.status } : {}),
    },
  }, budgetLeft(input));
  const data = storePayloadFromConnector(found);
  if (data.error === "store_write_denied") return { error: "store_write_denied" };
  if (data.changed === true && typeof data.status === "string") return { changed: true, status: data.status };
  if (data.changed === false && typeof data.status === "string") return { changed: false, status: data.status };
  throw new Error("store_lookup_failed");
}

async function readProcedureProduct(
  input: ProcedurePortsInput,
  product: Parameters<ProcedurePorts["getProduct"]>[0],
): Promise<{ ok: true; name: string; price: string; permalink: string } | { ok: false }> {
  const tool = wooTool(input, product.connectorId);
  if (!tool) return { ok: false };
  const found = await input.executeProcedureStoreCall(input.toolContext, tool, {
    capability: "get_product",
    method: "GET",
    parameters: {
      product_id: product.productId,
      ...(product.parentId ? { parent_id: product.parentId } : {}),
    },
  }, budgetLeft(input));
  const data = storePayloadFromConnector(found);
  if (data.error === "store_write_denied") return { ok: false };
  return {
    ok: true,
    name: typeof data.name === "string" ? data.name : "",
    price: typeof data.price === "number" || typeof data.price === "string" ? String(data.price) : "",
    permalink: typeof data.permalink === "string" ? data.permalink : "",
  };
}

export function createProcedurePorts(input: ProcedurePortsInput): ProcedurePorts {
  return {
    claim: (claimed) => claimProcedure(input, claimed),
    saveLead: (row) => saveProcedureLead(input, row),
    notifyAdmin: (message) => notifyAdmins(input.toolContext, message),
    escalate: (reason, summary) => executeTool(input.toolContext, "escalate_to_human", { reason, summary }),
    hasStoreCapability: (capability) => storeTool(input, capability) !== null,
    storeLookup: (capability, parameters) => lookupStore(input, capability, parameters),
    logFailure: (message, metadata) => logProcedureFailure(input, message, metadata),
    eventFor: (runId) => procedureEventFor(input, runId),
    updateOrder: (order) => updateProcedureOrder(input, order),
    getProduct: (product) => readProcedureProduct(input, product),
  };
}
