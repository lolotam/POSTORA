// Procedure tools for one reply turn (Spec A, D1–D7, D12, and the debate verdicts in the plan).
// End actions go through ports so the sandbox can simulate writes and tests need no database.
import { type ProcedureState, claimHeldByOther, nextField, startProcedure, submitFields } from "../_shared/procedures/engine.ts";
import { type ProcedureConfig, enabledProcedures } from "../_shared/procedures/config.ts";
import {
  type ProcedureField, type ProcedureKey, type ProcedureOrigin, PROCEDURE_KEYS, productFinderFields, TEMPLATES,
} from "../_shared/procedures/templates.ts";
import { sanitizeFieldValue } from "./logic.ts";
import type { ToolResult } from "./tools.ts";

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
}

export interface ProcedureTurnInput {
  state: ProcedureState | null;
  config: ProcedureConfig;
  ports: ProcedurePorts;
  dryRun: boolean;
  now: () => Date;
  /** Deterministic per inbound message when an outbox row exists (debate verdict 2). */
  runId: string;
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

export function procedureToolDefinitions(enabled: ProcedureKey[]) {
  if (!enabled.length) return [];
  return [
    {
      type: "function",
      function: {
        name: "start_procedure",
        description:
          "Start a guided procedure when the customer's request matches one. Only one runs at a time. You may call procedure_submit in the same response if the message already contains a field.",
        parameters: { type: "object", properties: { key: { type: "string", enum: enabled } }, required: ["key"] },
      },
    },
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
    {
      type: "function",
      function: {
        name: "procedure_cancel",
        description: "End the active procedure when the customer asks to stop or clearly changes topic.",
        parameters: { type: "object", properties: { reason: { type: "string" } }, required: ["reason"] },
      },
    },
  ];
}

export function createProcedureTurn(input: ProcedureTurnInput): ProcedureTurn {
  const enabled = new Set(enabledProcedures(input.config));
  // Verdict 9: the stored flow is judged by its own toggle, not by "some flow is on".
  let state = input.state && enabled.has(input.state.key) && fieldsFor(input.state.key, input.config).length
    ? input.state
    : null;
  let progressed = false;
  let handedOff = false;
  let completed: ProcedureKey | null = null;
  let claimConflict = false;

  const canStart = (key: ProcedureKey): boolean => {
    const capability = TEMPLATES[key].needsCapability;
    return enabled.has(key) && (!capability || input.ports.hasStoreCapability(capability));
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
    if (name === "start_procedure") {
      const key = String(args.key ?? "") as ProcedureKey;
      if (!(PROCEDURE_KEYS as readonly string[]).includes(key) || !enabled.has(key)) {
        return { output: `Procedure ${key} is not enabled for this account.` };
      }
      if (state) return { output: `Procedure ${state.key} is already active. ${stepGuidance(state, input.config)}` };
      if (!start(key, "model")) return { output: `Procedure ${key} cannot start: the store connector it needs is not connected.` };
      return { output: `Procedure ${key} started. ${stepGuidance(state!, input.config)}` };
    }
    if (name === "procedure_cancel") {
      if (!state) return { output: "No procedure is active." };
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
  };
}
