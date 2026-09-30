// Public WooCommerce receiver. Nothing in this module sends a message.
// A verified delivery is stored only when that account's procedure config
// enables the flow, including the consent timestamp cod and review require.
import { rateLimitExceededResponse } from "../_shared/rate-limiter.ts";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { classifyWooDelivery, ignoredDeliveryReason, isWooPing, verifyWooSignature, type WaitlistMatch } from "../_shared/wooWebhook.ts";
import { enabledProcedures, readProcedureConfig, reviewDelayDays } from "../_shared/procedures/config.ts";

const BODY_CAP = 262144;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface StoreBinding {
  id: string;
  user_id: string;
  social_account_id: string;
  connector_id: string;
}

/** A waitlist row plus the two columns that decide which binding may draft it. */
export interface ScopedWaitlistRow extends WaitlistMatch {
  connector_id: string;
  social_account_id: string;
}

/**
 * Waitlist rows that belong to this binding. The connector is shared across
 * WhatsApp accounts, so a connector match alone would draft another account's
 * customers into this account's events.
 */
export function waitlistForBinding(
  rows: readonly ScopedWaitlistRow[],
  binding: Pick<StoreBinding, "connector_id" | "social_account_id">,
): WaitlistMatch[] {
  return rows
    .filter((row) => row.connector_id === binding.connector_id && row.social_account_id === binding.social_account_id)
    .map((row) => ({
      id: row.id,
      product_id: row.product_id,
      parent_id: row.parent_id,
      phone: row.phone,
    }));
}

export interface StoreWebhookDeps {
  limitIp(req: Request): Promise<{ allowed: boolean; retryAfter?: number }>;
  limitConnector(connectorId: string): Promise<{ allowed: boolean; retryAfter?: number }>;
  loadBinding(id: string): Promise<StoreBinding | null>;
  loadSecrets(bindingId: string): Promise<{ current: string; previous: string | null; rotatedAt: string | null } | null>;
  loadProcedures(socialAccountId: string): Promise<unknown>;
  /** Defaults to enabledStoreFlows. */
  flowsFrom?(procedures: unknown): ReadonlySet<string>;
  /** Only rows whose product or parent is one of productIds (validated positive integers). */
  loadWaitlist(binding: StoreBinding, productIds: number[]): Promise<ScopedWaitlistRow[]>;
  insertEvents(rows: Array<Record<string, unknown>>): Promise<{ ok: true; stored: number } | { ok: false }>;
  /** Best-effort record of a delivery that could have started a flow but did not. */
  logIgnored(entry: { binding: StoreBinding; topic: string | null; reason: string; externalId: string | null }): Promise<void>;
  now(): Date;
}

/** Flows a stored config may start. Invalid event settings are dropped by the lenient read. */
export function enabledStoreFlows(procedures: unknown): Set<string> {
  return new Set(enabledProcedures(readProcedureConfig(procedures)));
}

export async function handleStoreWebhook(req: Request, deps: StoreWebhookDeps): Promise<Response> {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const ipLimit = await deps.limitIp(req);
  if (!ipLimit.allowed) return limited(ipLimit.retryAfter);
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > BODY_CAP) return json({ error: "payload_too_large" }, 413);
  const body = await readCapped(req, BODY_CAP);
  if (!body.ok) return json({ error: "payload_too_large" }, 413);
  if (isWooPing(req.headers.get("content-type"), body.text)) return json({ ok: true });

  const bindingId = bindingFromPath(req.url);
  if (!bindingId) return json({ error: "not_found" }, 404);
  let binding: StoreBinding | null;
  try {
    binding = await deps.loadBinding(bindingId);
  } catch {
    return json({ error: "store_failed" }, 500);
  }
  if (!binding) return json({ error: "not_found" }, 404);

  let secrets: { current: string; previous: string | null; rotatedAt: string | null } | null;
  try {
    secrets = await deps.loadSecrets(binding.id);
  } catch {
    return json({ error: "store_failed" }, 500);
  }
  if (!secrets?.current) return json({ error: "unauthorized" }, 401);
  const verified = await verifyWooSignature(body.text, req.headers.get("x-wc-webhook-signature"), {
    current: secrets.current,
    previous: secrets.previous,
    rotatedAt: secrets.rotatedAt ? new Date(secrets.rotatedAt) : null,
  }, deps.now());
  if (!verified) return json({ error: "unauthorized" }, 401);

  const connectorLimit = await deps.limitConnector(binding.connector_id);
  if (!connectorLimit.allowed) return limited(connectorLimit.retryAfter);

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return json({ error: "invalid_json" }, 400);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return json({ error: "invalid_json" }, 400);

  const topic = req.headers.get("x-wc-webhook-topic");
  let procedures: unknown;
  let waitlist: WaitlistMatch[] = [];
  try {
    procedures = await deps.loadProcedures(binding.social_account_id);
    // Only a product update can match the waitlist; orders never need it.
    const product = parsed as { id?: unknown; parent_id?: unknown };
    // Ids come from the signed body; the integer check keeps them safe inside the PostgREST filter.
    const productIds = topic === "product.updated"
      ? [product.id, product.parent_id].map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)
      : [];
    if (productIds.length && Number.isSafeInteger(Number(product.id))) {
      waitlist = waitlistForBinding(await deps.loadWaitlist(binding, productIds), binding);
    }
  } catch {
    return json({ error: "store_failed" }, 500);
  }
  const classifyInput = {
    topic,
    body: parsed,
    now: deps.now(),
    enabled: (deps.flowsFrom ?? enabledStoreFlows)(procedures),
    reviewDelayDays: reviewDelayDays(procedures),
    country: null,
    waitlist,
  };
  const drafts = classifyWooDelivery(classifyInput);
  if (!drafts.length) {
    // An ignored order used to leave no trace at all. The reason also goes back
    // in the response body, which WooCommerce shows in its webhook delivery log.
    const reason = ignoredDeliveryReason(classifyInput);
    if (!reason) return json({ ok: true, stored: 0 });
    const id = (parsed as { id?: unknown }).id;
    try {
      await deps.logIgnored({ binding, topic, reason, externalId: id == null ? null : String(id) });
    } catch {
      console.error("[store-webhook] ignored-delivery log failed");
    }
    return json({ ok: true, stored: 0, ignored: reason });
  }
  const deliveryId = req.headers.get("x-wc-webhook-delivery-id");
  const rows = drafts.map((draft) => ({
    user_id: binding.user_id,
    social_account_id: binding.social_account_id,
    connector_id: binding.connector_id,
    binding_id: binding.id,
    flow: draft.flow,
    external_id: draft.external_id,
    payload: draft.payload,
    status: "pending",
    due_at: draft.due_at.toISOString(),
    ...(deliveryId ? { delivery_id: deliveryId } : {}),
  }));
  const inserted = await deps.insertEvents(rows);
  if (!inserted.ok) return json({ error: "store_failed" }, 500);
  return json({ ok: true, stored: inserted.stored });
}

function limited(retryAfter: number | undefined): Response {
  return rateLimitExceededResponse(
    { allowed: false, count: 0, remaining: 0, retryAfter: retryAfter ?? 60 },
    corsHeaders,
  );
}

function json(data: unknown, status = 200): Response {
  return jsonResponse(data, status);
}

function bindingFromPath(url: string): string | null {
  const parts = new URL(url).pathname.split("/").filter(Boolean);
  const id = parts.at(-1) ?? "";
  if (parts.at(-2) !== "store-webhook" || !UUID.test(id)) return null;
  return id;
}

async function readCapped(req: Request, cap: number): Promise<{ ok: true; text: string } | { ok: false }> {
  const reader = req.body?.getReader();
  if (!reader) return { ok: true, text: "" };
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel();
      return { ok: false };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(bytes) };
}
