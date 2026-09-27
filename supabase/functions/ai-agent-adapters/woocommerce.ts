import { cacheKey, type ConnectorCache } from "./cache.ts";
import { readJson, safeVendorFetch } from "./http.ts";
import type {
  AdapterDependencies,
  Capability,
  ConnectorAdapter,
  ConnectorFailure,
  ConnectorInvocation,
  ConnectorResult,
} from "./types.ts";
import { CAPABILITIES } from "./types.ts";
import { requiredString } from "./validation.ts";

function wooFailure(
  code: string,
  message: string,
  vendorStatus?: number,
): ConnectorFailure {
  return {
    ok: false,
    vendor: "woocommerce",
    error: {
      code,
      message,
      ...(vendorStatus === undefined ? {} : { vendor_status: vendorStatus }),
    },
  };
}

// WooCommerce's `orderby` accepts a fixed vocabulary. The model supplies this
// value, so it is matched against a whitelist rather than interpolated: an
// unrecognised word is dropped, never forwarded into the query string.
const SORT_KEYS: Record<string, string> = {
  price: "price",
  date: "date",
  popularity: "popularity",
  rating: "rating",
};

const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 20;

// A category id is stable for the store's lifetime in
// practice, so it is cached for a day; a product search only for 120 s, the
// staleness the tool description admits to the model. check_stock and
// lookup_orders are never cached.
const CATEGORY_CACHE_TTL_SECONDS = 86_400;
const SEARCH_CACHE_TTL_SECONDS = 120;

/** A cache read failure is a miss, never a failed connector call. */
async function cacheRead(cache: ConnectorCache, key: string): Promise<unknown | null> {
  try {
    return await cache.get(key);
  } catch {
    return null;
  }
}

/** A cache write failure is dropped; the live result is still returned. */
async function cacheWrite(
  cache: ConnectorCache,
  key: string,
  toolId: string,
  value: unknown,
  ttlSeconds: number,
): Promise<void> {
  try {
    await cache.set(key, toolId, value, ttlSeconds);
  } catch {
    // Fall through: caching is an optimisation, not part of the answer.
  }
}

/**
 * How many products to return. Defaults low on purpose: the result is
 * serialised into the model's message list under a 2000-character budget, so
 * asking for twenty products is asking for nineteen of them to be cut off
 * mid-object.
 */
function searchLimit(raw: string | null): number {
  const parsed = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(parsed)) return DEFAULT_SEARCH_LIMIT;
  return Math.min(Math.max(parsed, 1), MAX_SEARCH_LIMIT);
}

function productSearchQuery(parameters: Record<string, unknown>, categoryId: string | null): string {
  const search = new URLSearchParams();
  const query = requiredString(parameters, "query");
  if (query) search.set("search", query);
  if (categoryId) search.set("category", categoryId);

  const sortBy = SORT_KEYS[(requiredString(parameters, "sort_by") ?? "").toLowerCase()];
  if (sortBy) {
    search.set("orderby", sortBy);
    // Superlatives are the reason sorting exists ("the most expensive"), so
    // desc is the default and asc has to be asked for.
    search.set("order", requiredString(parameters, "order")?.toLowerCase() === "asc" ? "asc" : "desc");
  }
  search.set("per_page", String(searchLimit(requiredString(parameters, "limit"))));
  return search.toString();
}

function withFields(url: string, fields: readonly string[]): string {
  const joiner = url.includes("?") ? "&" : "?";
  return `${url}${joiner}_fields=${fields.join(",")}`;
}

function buildUrl(
  invocation: ConnectorInvocation,
  capability?: Capability,
  categoryId: string | null = null,
): string | null {
  const storeUrl = requiredString(invocation.tool.settings, "store_url");
  if (!storeUrl) return null;
  const base = storeUrl.replace(/\/+$/, "");
  const parameters = invocation.request.parameters;

  if (!capability) return `${base}/wp-json/wc/v3/products?per_page=1`;
  if (capability === "search_products") {
    return withFields(
      `${base}/wp-json/wc/v3/products?${productSearchQuery(parameters, categoryId)}`,
      PRODUCT_REQUEST_FIELDS,
    );
  }
  if (capability === "check_stock") {
    const sku = requiredString(parameters, "sku") ?? requiredString(parameters, "query") ?? "";
    return withFields(
      `${base}/wp-json/wc/v3/products?sku=${encodeURIComponent(sku)}&per_page=20`,
      PRODUCT_REQUEST_FIELDS,
    );
  }

  const orderId = requiredString(parameters, "order_id");
  if (orderId) {
    return withFields(
      `${base}/wp-json/wc/v3/orders/${encodeURIComponent(orderId)}`,
      ORDER_REQUEST_FIELDS,
    );
  }
  const query = requiredString(parameters, "query") ?? "";
  return withFields(
    `${base}/wp-json/wc/v3/orders?search=${encodeURIComponent(query)}&per_page=20`,
    ORDER_REQUEST_FIELDS,
  );
}

// A WooCommerce product carries its full HTML descriptions, image list,
// attributes and meta_data -- several kilobytes each. The caller serialises
// this payload into the model's message list under a 2000-character budget
// (connectorExecution.ts), so passing the vendor object through meant the
// model received a fraction of ONE product, cut off mid-JSON. Only the fields
// an answer is built from survive.
const PRODUCT_FIELDS = [
  "id",
  "parent_id",
  "name",
  "sku",
  "price",
  "regular_price",
  "sale_price",
  "on_sale",
  "stock_status",
  "stock_quantity",
  "permalink",
] as const;

const ORDER_FIELDS = [
  "id",
  "number",
  "status",
  "total",
  "currency",
  "date_created",
] as const;

// What WooCommerce is asked to build: the projected fields plus the nested ones the
// projection reads (category names, order line items). Anything else is never used.
const PRODUCT_REQUEST_FIELDS = [...PRODUCT_FIELDS, "categories"];
const ORDER_REQUEST_FIELDS = [...ORDER_FIELDS, "line_items"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pick(source: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (key in source) picked[key] = source[key];
  }
  return picked;
}

function categoryNames(product: Record<string, unknown>): string[] {
  if (!Array.isArray(product.categories)) return [];
  return product.categories
    .map((entry) => (isRecord(entry) && typeof entry.name === "string" ? entry.name : null))
    .filter((name): name is string => name !== null);
}

function projectProduct(product: Record<string, unknown>): Record<string, unknown> {
  const projected = pick(product, PRODUCT_FIELDS);
  const categories = categoryNames(product);
  if (categories.length) projected.categories = categories;
  return projected;
}

function projectOrder(order: Record<string, unknown>): Record<string, unknown> {
  const projected = pick(order, ORDER_FIELDS);
  if (Array.isArray(order.line_items)) {
    projected.line_items = order.line_items
      .filter(isRecord)
      .map((item) => pick(item, ["name", "quantity", "total"]));
  }
  return projected;
}

/**
 * Trims the vendor payload to what an answer needs. An unrecognised shape is
 * returned untouched rather than emptied -- a projection that silently drops
 * everything would read to the model as "the store has no such product".
 */
const GET_PRODUCT_FIELDS = ["id", "parent_id", "name", "price", "stock_status", "permalink"] as const;

function projectGetProduct(product: Record<string, unknown>, parentId: string | null): Record<string, unknown> {
  const projected = pick(product, GET_PRODUCT_FIELDS);
  if (parentId && projected.parent_id == null) projected.parent_id = Number(parentId);
  return projected;
}

function projectPayload(capability: Capability, payload: unknown): unknown {
  const project = capability === "lookup_orders" ? projectOrder : projectProduct;
  if (Array.isArray(payload)) {
    return payload.map((entry) => (isRecord(entry) ? project(entry) : entry));
  }
  return isRecord(payload) ? project(payload) : payload;
}

/**
 * The WooCommerce id for a category NAME, because `?category=` takes an id
 * while a customer says "men's perfumes". Costs one extra request, and only
 * when the model actually names a category.
 */
async function resolveCategoryId(
  base: string,
  authorization: string,
  name: string,
  dependencies: AdapterDependencies,
): Promise<string | null> {
  const url = withFields(
    `${base}/wp-json/wc/v3/products/categories?search=${encodeURIComponent(name)}&per_page=10`,
    ["id", "name"],
  );
  const response = await safeVendorFetch(url, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: authorization },
  }, dependencies);
  if (!response.ok) return null;
  const payload = await readJson(response);
  if (!Array.isArray(payload)) return null;
  const wanted = name.trim().toLowerCase();
  const matches = payload.filter(isRecord);
  // An exact name wins over the first fuzzy hit: WooCommerce's search matches
  // on substrings, so "perfume" can rank a "Perfume Samples" child above the
  // category the customer meant.
  const exact = matches.find((entry) =>
    typeof entry.name === "string" && entry.name.trim().toLowerCase() === wanted
  );
  const chosen = exact ?? matches[0];
  return chosen && chosen.id !== undefined ? String(chosen.id) : null;
}

/**
 * resolveCategoryId costs one extra request per category name. The id is
 * stable, so the answer is cached for a day keyed by tool, store and name. A
 * not-found null is never cached: it is a failure, and the store may add the
 * category any minute.
 */
async function resolveCachedCategoryId(
  toolId: string,
  storeUrl: string,
  authorization: string,
  name: string,
  dependencies: AdapterDependencies,
): Promise<{ id: string | null; cached: boolean }> {
  const cache = dependencies.cache;
  if (!cache) {
    return { id: await resolveCategoryId(storeUrl.replace(/\/+$/, ""), authorization, name, dependencies), cached: false };
  }
  const key = await cacheKey(["cat", toolId, storeUrl, name]);
  const cached = await cacheRead(cache, key);
  if (typeof cached === "string") return { id: cached, cached: true };
  const resolved = await resolveCategoryId(storeUrl.replace(/\/+$/, ""), authorization, name, dependencies);
  if (resolved !== null) {
    await cacheWrite(cache, key, toolId, resolved, CATEGORY_CACHE_TTL_SECONDS);
  }
  return { id: resolved, cached: false };
}

function positiveId(parameters: Record<string, unknown>, key: string): string | null {
  const value = requiredString(parameters, key);
  if (!value || value === "0" || !/^\d+$/.test(value)) return null;
  return value;
}

function orderStatus(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.status !== "string" || !payload.status) return null;
  return payload.status;
}

async function wooSend(
  url: string,
  method: "GET" | "POST" | "PUT",
  authorization: string,
  dependencies: AdapterDependencies,
  body?: unknown,
): Promise<{ ok: true; payload: unknown } | { ok: false; failure: ConnectorFailure }> {
  let response: Response;
  try {
    response = await safeVendorFetch(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: authorization,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, dependencies);
  } catch {
    return { ok: false, failure: wooFailure("woocommerce_http_error", "WooCommerce rejected the request.") };
  }
  if (response.status === 401 || response.status === 403) {
    return { ok: false, failure: wooFailure("store_write_denied", "WooCommerce refused the write.", response.status) };
  }
  if (!response.ok) {
    return { ok: false, failure: wooFailure("woocommerce_http_error", "WooCommerce rejected the request.", response.status) };
  }
  try {
    return { ok: true, payload: await readJson(response) };
  } catch {
    return { ok: false, failure: wooFailure("woocommerce_response_invalid", "WooCommerce returned an invalid response.", response.status) };
  }
}

function latestNoteText(payload: unknown): string | null {
  if (!Array.isArray(payload)) return null;
  let bestId = -1;
  let best: string | null = null;
  for (const entry of payload) {
    if (!isRecord(entry) || typeof entry.note !== "string") continue;
    const id = typeof entry.id === "number" ? entry.id : -1;
    if (id >= bestId) {
      bestId = id;
      best = entry.note;
    }
  }
  return best;
}

/**
 * The only WooCommerce write. Note first, then a second read, then status.
 * WooCommerce has no conditional update, so a status that left the expected
 * set between the two reads is left untouched.
 */
async function updateOrder(
  invocation: ConnectorInvocation,
  dependencies: AdapterDependencies,
  authorization: string,
  base: string,
): Promise<ConnectorResult> {
  if (invocation.tool.read_only_mode !== false) {
    return wooFailure("read_only_violation", "Read-only mode refused the order update.");
  }
  const parameters = invocation.request.parameters;
  const orderId = positiveId(parameters, "order_id");
  const note = requiredString(parameters, "note");
  const requestedStatus = requiredString(parameters, "status");
  const expected = parameters.expected_statuses;
  const expectedOk = Array.isArray(expected)
    && expected.length > 0
    && expected.length <= 8
    && expected.every((status) => typeof status === "string" && /^[a-z0-9_-]{1,32}$/.test(status));
  if (!orderId || !note || note.length > 500 || (requestedStatus !== null && requestedStatus !== "cancelled") || !expectedOk) {
    return wooFailure("woocommerce_configuration_invalid", "WooCommerce is not fully configured.");
  }
  const orderUrl = `${base}/wp-json/wc/v3/orders/${encodeURIComponent(orderId)}`;
  const current = await wooSend(withFields(orderUrl, ["id", "status"]), "GET", authorization, dependencies);
  if (!current.ok) return current.failure;
  const status = orderStatus(current.payload);
  if (!status) return wooFailure("woocommerce_response_invalid", "WooCommerce returned an invalid response.");
  const allowed = new Set(expected as string[]);
  if (!allowed.has(status)) {
    if (status === "cancelled" && requestedStatus === "cancelled") {
      const notes = await wooSend(`${orderUrl}/notes`, "GET", authorization, dependencies);
      if (!notes.ok) return notes.failure;
      if (latestNoteText(notes.payload)?.trim() === note.trim()) {
        return { ok: true, vendor: "woocommerce", action: "execute", capability: "update_order", data: { changed: true, status } };
      }
    }
    return { ok: true, vendor: "woocommerce", action: "execute", capability: "update_order", data: { changed: false, status } };
  }
  const noted = await wooSend(`${orderUrl}/notes`, "POST", authorization, dependencies, { note, customer_note: false });
  if (!noted.ok) return noted.failure;
  const again = await wooSend(withFields(orderUrl, ["id", "status"]), "GET", authorization, dependencies);
  if (!again.ok) return again.failure;
  const afterNote = orderStatus(again.payload);
  if (!afterNote) return wooFailure("woocommerce_response_invalid", "WooCommerce returned an invalid response.");
  if (!allowed.has(afterNote)) {
    return { ok: true, vendor: "woocommerce", action: "execute", capability: "update_order", data: { changed: false, status: afterNote } };
  }
  if (requestedStatus) {
    const written = await wooSend(orderUrl, "PUT", authorization, dependencies, { status: requestedStatus });
    if (!written.ok) return written.failure;
    return {
      ok: true, vendor: "woocommerce", action: "execute", capability: "update_order",
      data: { changed: true, status: requestedStatus },
    };
  }
  return { ok: true, vendor: "woocommerce", action: "execute", capability: "update_order", data: { changed: true, status: afterNote } };
}

const PROCEDURE_ORDER_FIELDS = ["id", "status", "payment_method", "date_created", "billing"] as const;

/**
 * Order re-read for a store-event opener. Returns the eligibility fields only:
 * payment method, status, created time, and the billing phone. The rest of
 * billing (email, address) is not copied out.
 */
async function readProcedureOrder(
  invocation: ConnectorInvocation,
  dependencies: AdapterDependencies,
  authorization: string,
  base: string,
): Promise<ConnectorResult> {
  const orderId = positiveId(invocation.request.parameters, "order_id");
  if (!orderId) return wooFailure("woocommerce_configuration_invalid", "WooCommerce is not fully configured.");
  const sent = await wooSend(
    withFields(`${base}/wp-json/wc/v3/orders/${encodeURIComponent(orderId)}`, PROCEDURE_ORDER_FIELDS),
    "GET",
    authorization,
    dependencies,
  );
  if (!sent.ok) {
    return sent.failure.error.code === "store_write_denied"
      ? wooFailure("woocommerce_http_error", "WooCommerce rejected the request.", sent.failure.error.vendor_status)
      : sent.failure;
  }
  if (!isRecord(sent.payload)) {
    return wooFailure("woocommerce_response_invalid", "WooCommerce returned an invalid response.");
  }
  const billing = isRecord(sent.payload.billing) ? sent.payload.billing : {};
  return {
    ok: true,
    vendor: "woocommerce",
    action: "execute",
    capability: "lookup_orders",
    data: {
      status: typeof sent.payload.status === "string" ? sent.payload.status : "",
      payment_method: typeof sent.payload.payment_method === "string" ? sent.payload.payment_method : "",
      date_created: typeof sent.payload.date_created === "string" ? sent.payload.date_created : "",
      phone: typeof billing.phone === "string" ? billing.phone : "",
      country: typeof billing.country === "string" ? billing.country : "",
    },
  };
}

async function getProduct(
  invocation: ConnectorInvocation,
  dependencies: AdapterDependencies,
  authorization: string,
  base: string,
): Promise<ConnectorResult> {
  const productId = positiveId(invocation.request.parameters, "product_id");
  if (!productId) return wooFailure("woocommerce_configuration_invalid", "WooCommerce is not fully configured.");
  const parentId = positiveId(invocation.request.parameters, "parent_id");
  const path = parentId
    ? `/products/${encodeURIComponent(parentId)}/variations/${encodeURIComponent(productId)}`
    : `/products/${encodeURIComponent(productId)}`;
  const sent = await wooSend(
    withFields(`${base}/wp-json/wc/v3${path}`, GET_PRODUCT_FIELDS),
    "GET",
    authorization,
    dependencies,
  );
  if (!sent.ok) {
    // A read is not a refused write. Keep the existing HTTP error code.
    return sent.failure.error.code === "store_write_denied"
      ? wooFailure("woocommerce_http_error", "WooCommerce rejected the request.", sent.failure.error.vendor_status)
      : sent.failure;
  }
  if (!isRecord(sent.payload)) {
    return wooFailure("woocommerce_response_invalid", "WooCommerce returned an invalid response.");
  }
  return {
    ok: true,
    vendor: "woocommerce",
    action: "execute",
    capability: "get_product",
    data: projectGetProduct(sent.payload, parentId),
  };
}

async function callWooCommerce(
  invocation: ConnectorInvocation,
  dependencies: AdapterDependencies,
  capability?: Capability,
): Promise<ConnectorResult> {
  if (invocation.request.action !== "execute") capability = undefined;
  const consumerKey = requiredString(invocation.credentials, "consumer_key");
  const consumerSecret = requiredString(invocation.credentials, "consumer_secret");
  const storeUrl = requiredString(invocation.tool.settings, "store_url");
  if (!consumerKey || !consumerSecret || !storeUrl) {
    return wooFailure("woocommerce_configuration_invalid", "WooCommerce is not fully configured.");
  }
  const authorization = `Basic ${btoa(`${consumerKey}:${consumerSecret}`)}`;
  const base = storeUrl.replace(/\/+$/, "");
  if (invocation.request.action === "execute" && capability === "update_order") {
    return updateOrder(invocation, dependencies, authorization, base);
  }
  if (invocation.request.action === "execute" && capability === "get_product") {
    return getProduct(invocation, dependencies, authorization, base);
  }
  if (
    invocation.request.action === "execute"
    && capability === "lookup_orders"
    && invocation.request.internalProcedure === true
    && positiveId(invocation.request.parameters, "order_id")
  ) {
    return readProcedureOrder(invocation, dependencies, authorization, base);
  }

  // A cached search answer skips the category resolution too — a hit means the
  // whole call is answered without touching the store. Failures are never
  // cached, so the hit is always a projected success payload.
  let searchCacheKey: string | null = null;
  if (invocation.request.action === "execute" && capability === "search_products" && dependencies.cache) {
    searchCacheKey = await cacheKey(["search", invocation.tool.id, storeUrl, invocation.request.parameters]);
    const cachedSearch = await cacheRead(dependencies.cache, searchCacheKey);
    if (cachedSearch !== null) {
      return {
        ok: true,
        vendor: "woocommerce",
        action: "execute",
        capability,
        data: cachedSearch,
      };
    }
  }

  let categoryId: string | null = null;
  let categoryWasCached = false;
  const categoryName = capability === "search_products"
    ? requiredString(invocation.request.parameters, "category")
    : null;
  if (categoryName) {
    const category = await resolveCachedCategoryId(
      invocation.tool.id,
      storeUrl,
      authorization,
      categoryName,
      dependencies,
    );
    categoryId = category.id;
    categoryWasCached = category.cached;
    if (!categoryId) {
      // Said out loud rather than silently searching every category: an answer
      // drawn from the whole store would be wrong for the question asked.
      return wooFailure(
        "woocommerce_category_not_found",
        `No product category matches "${categoryName.slice(0, 60)}".`,
      );
    }
  }

  const url = buildUrl(invocation, capability, categoryId);
  if (!url) {
    return wooFailure("woocommerce_configuration_invalid", "WooCommerce is not fully configured.");
  }

  let response = await safeVendorFetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: authorization,
    },
  }, dependencies);
  if (!response.ok) {
    return wooFailure("woocommerce_http_error", "WooCommerce rejected the request.", response.status);
  }
  let payload = await readJson(response);
  if (categoryWasCached && categoryName && Array.isArray(payload) && payload.length === 0) {
    const liveId = await resolveCategoryId(storeUrl.replace(/\/+$/, ""), authorization, categoryName, dependencies);
    if (liveId !== null && liveId !== categoryId) {
      if (dependencies.cache) {
        const key = await cacheKey(["cat", invocation.tool.id, storeUrl, categoryName]);
        await cacheWrite(dependencies.cache, key, invocation.tool.id, liveId, CATEGORY_CACHE_TTL_SECONDS);
      }
      // One retry only, even if the refreshed category also contains no matches.
      response = await safeVendorFetch(buildUrl(invocation, capability, liveId)!, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: authorization },
      }, dependencies);
      if (!response.ok) {
        return wooFailure("woocommerce_http_error", "WooCommerce rejected the request.", response.status);
      }
      payload = await readJson(response);
    }
  }
  if (
    payload !== null && typeof payload === "object" && !Array.isArray(payload) &&
    typeof (payload as Record<string, unknown>).code === "string" &&
    typeof (payload as Record<string, unknown>).message === "string"
  ) {
    return wooFailure("woocommerce_api_error", "WooCommerce returned an API error.", response.status);
  }
  const expectsCollection = !capability || capability !== "lookup_orders";
  if ((expectsCollection && !Array.isArray(payload)) || payload === null || typeof payload !== "object") {
    return wooFailure("woocommerce_response_invalid", "WooCommerce returned an invalid response.", response.status);
  }

  if (!capability) {
    return {
      ok: true,
      vendor: "woocommerce",
      action: "test_connection",
      capabilities: CAPABILITIES.filter((name) => name !== "get_product" && name !== "update_order"),
      read_only: true,
    };
  }
  const projected = projectPayload(capability, payload);
  if (searchCacheKey !== null && dependencies.cache) {
    await cacheWrite(
      dependencies.cache,
      searchCacheKey,
      invocation.tool.id,
      projected,
      SEARCH_CACHE_TTL_SECONDS,
    );
  }
  return {
    ok: true,
    vendor: "woocommerce",
    action: "execute",
    capability,
    data: projected,
  };
}

export const wooCommerceAdapter: ConnectorAdapter = {
  id: "woocommerce",
  capabilities: [...CAPABILITIES],
  execute: (invocation, dependencies) =>
    callWooCommerce(invocation, dependencies, invocation.request.capability),
  testConnection: (invocation, dependencies) =>
    callWooCommerce(invocation, dependencies),
};
