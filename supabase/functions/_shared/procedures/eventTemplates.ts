// Cloud API templates for store-event openers (spec §8.13).
// Graph is a port: tests pass a fake, the card and the worker pass fetch.
import { COD_BUTTONS, OPENER_BODIES, openerValues, type OpenerLanguage } from "./openers.ts";
import { isEventProcedureKey, type EventProcedureKey } from "./templates.ts";

export type { EventProcedureKey };
export type TemplateCategory = "UTILITY" | "MARKETING";
export type TemplateStatus = "approved" | "pending" | "rejected" | "missing";

export interface EventTemplateDefinition {
  name: string;
  flow: EventProcedureKey;
  version: 1 | 2;
  category: TemplateCategory;
  language: OpenerLanguage;
  body: string;
  examples: string[];
  buttons?: readonly string[];
}

const CATEGORY: Record<EventProcedureKey, TemplateCategory> = {
  cod_confirm: "UTILITY",
  review_request: "UTILITY",
  back_in_stock: "MARKETING",
};

const EXAMPLES: Record<EventProcedureKey, Record<OpenerLanguage, string[]>> = {
  cod_confirm: {
    ar: ["سارة", "1042", "12.500 KWD"],
    en: ["Sara", "1042", "12.500 KWD"],
  },
  review_request: {
    ar: ["سارة", "1042"],
    en: ["Sara", "1042"],
  },
  back_in_stock: {
    ar: ["سارة", "زيت الورد"],
    en: ["Sara", "Rose oil"],
  },
};

export function eventTemplateName(flow: EventProcedureKey, version: 1 | 2): string {
  return `postora_${flow}_v${version}`;
}

export function eventTemplateDefinition(
  flow: EventProcedureKey,
  language: OpenerLanguage,
  version: 1 | 2 = 1,
): EventTemplateDefinition {
  return {
    name: eventTemplateName(flow, version),
    flow,
    version,
    category: CATEGORY[flow],
    language,
    body: OPENER_BODIES[flow][language],
    examples: EXAMPLES[flow][language],
    ...(flow === "cod_confirm" ? { buttons: COD_BUTTONS[language] } : {}),
  };
}

export function isEventFlow(value: unknown): value is EventProcedureKey {
  return typeof value === "string" && isEventProcedureKey(value);
}

/** Quick-reply payloads are set on the send, not stored in the template. */
export function templateSendComponents(
  flow: EventProcedureKey,
  language: OpenerLanguage,
  payload: Record<string, string>,
  eventId: string,
): unknown[] {
  const components: unknown[] = [{
    type: "body",
    parameters: openerValues(flow, language, payload).map((text) => ({ type: "text", text })),
  }];
  if (flow === "cod_confirm") {
    components.push(
      { type: "button", sub_type: "quick_reply", index: "0", parameters: [{ type: "payload", payload: `cod:${eventId}:confirm` }] },
      { type: "button", sub_type: "quick_reply", index: "1", parameters: [{ type: "payload", payload: `cod:${eventId}:cancel` }] },
    );
  }
  return components;
}

export interface GraphTemplate {
  name?: string;
  status?: string;
  category?: string;
  language?: string;
}

export interface TemplateGraph {
  list(name: string): Promise<GraphTemplate[]>;
  create(body: Record<string, unknown>): Promise<{ id?: string; error?: { message?: string; code?: number; error_subcode?: number } }>;
}

export interface TemplateResolution {
  status: TemplateStatus;
  name: string;
  language: OpenerLanguage;
  category: string;
}

function languageMatches(reported: string | undefined, wanted: OpenerLanguage): boolean {
  if (!reported) return false;
  const value = reported.toLowerCase();
  return value === wanted || value.startsWith(`${wanted}_`);
}

function sameTemplate(row: GraphTemplate, definition: EventTemplateDefinition): boolean {
  return row.name === definition.name
    && languageMatches(row.language, definition.language)
    && (row.category ?? "").toUpperCase() === definition.category;
}

function reportedStatus(row: GraphTemplate | undefined): TemplateStatus {
  switch ((row?.status ?? "").toUpperCase()) {
    case "APPROVED":
      return "approved";
    case "PENDING":
      return "pending";
    case "REJECTED":
      return "rejected";
    default:
      return "missing";
  }
}

function isDuplicateName(error: { message?: string; code?: number; error_subcode?: number } | undefined): boolean {
  const message = (error?.message ?? "").toLowerCase();
  return message.includes("duplicate") || message.includes("already exists") || error?.error_subcode === 2388026;
}

function createBody(definition: EventTemplateDefinition): Record<string, unknown> {
  const components: Record<string, unknown>[] = [{
    type: "BODY",
    text: definition.body,
    example: { body_text: [definition.examples] },
  }];
  if (definition.buttons) {
    components.push({
      type: "BUTTONS",
      buttons: definition.buttons.map((text) => ({ type: "QUICK_REPLY", text })),
    });
  }
  return {
    name: definition.name,
    category: definition.category,
    language: definition.language,
    components,
  };
}

function resolution(definition: EventTemplateDefinition, status: TemplateStatus, category: string = definition.category): TemplateResolution {
  return { status, name: definition.name, language: definition.language, category };
}

async function resolveVersion(
  graph: TemplateGraph,
  flow: EventProcedureKey,
  language: OpenerLanguage,
  version: 1 | 2,
  create: boolean,
): Promise<{ resolution: TemplateResolution; rejected: boolean }> {
  const definition = eventTemplateDefinition(flow, language, version);
  const listed = await graph.list(definition.name);
  const match = listed.find((row) => sameTemplate(row, definition));
  const status = reportedStatus(match);
  if (match && status === "approved") return { resolution: resolution(definition, "approved", (match.category ?? definition.category).toUpperCase()), rejected: false };
  if (match && status === "pending") return { resolution: resolution(definition, "pending", (match.category ?? definition.category).toUpperCase()), rejected: false };
  if (match && status === "rejected") return { resolution: resolution(definition, "rejected", (match.category ?? definition.category).toUpperCase()), rejected: true };
  if (!create) return { resolution: resolution(definition, "missing"), rejected: false };
  const created = await graph.create(createBody(definition));
  if (created.error && isDuplicateName(created.error)) {
    const again = await graph.list(definition.name);
    const existing = again.find((row) => row.name === definition.name && languageMatches(row.language, language));
    const existingStatus = reportedStatus(existing);
    return {
      resolution: resolution(
        definition,
        existingStatus === "missing" ? "pending" : existingStatus,
        (existing?.category ?? definition.category).toUpperCase(),
      ),
      rejected: existingStatus === "rejected",
    };
  }
  if (created.error) throw new Error("template_create_failed");
  return { resolution: resolution(definition, "pending"), rejected: false };
}

/**
 * List `message_templates?name=`, match name + language + category.
 * APPROVED is reused. PENDING is reported. A missing template is created only
 * when `create` is set. REJECTED `_v1` tries `_v2`. A duplicate-name error
 * means the template already exists.
 */
export async function ensureEventTemplate(
  graph: TemplateGraph,
  flow: EventProcedureKey,
  language: OpenerLanguage,
  options: { create?: boolean } = {},
): Promise<TemplateResolution> {
  const create = options.create === true;
  const first = await resolveVersion(graph, flow, language, 1, create);
  if (!first.rejected) return first.resolution;
  const second = await resolveVersion(graph, flow, language, 2, create);
  if (second.resolution.status === "missing") return first.resolution;
  return second.resolution;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Graph client for one WABA. The token stays on the Authorization header. */
export function eventTemplateGraph(wabaId: string, token: string, fetcher: Fetcher = fetch): TemplateGraph {
  const base = `https://graph.facebook.com/v22.0/${wabaId}/message_templates`;
  return {
    async list(name) {
      const response = await fetcher(`${base}?name=${encodeURIComponent(name)}&fields=name,status,category,language&limit=20`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.error) throw new Error("template_list_failed");
      return Array.isArray(body?.data) ? body.data as GraphTemplate[] : [];
    },
    async create(payload) {
      const response = await fetcher(base, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body?.error) return { error: body?.error ?? { message: "create_failed" } };
      return { id: typeof body?.id === "string" ? body.id : undefined };
    },
  };
}
