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
    return `${base}/wp-json/wc/v3/products?${productSearchQuery(parameters, categoryId)}`;
  }
  if (capability === "check_stock") {
    const sku = requiredString(parameters, "sku") ?? requiredString(parameters, "query") ?? "";
    return `${base}/wp-json/wc/v3/products?sku=${encodeURIComponent(sku)}&per_page=20`;
  }

  const orderId = requiredString(parameters, "order_id");
  if (orderId) {
    return `${base}/wp-json/wc/v3/orders/${encodeURIComponent(orderId)}`;
  }
  const query = requiredString(parameters, "query") ?? "";
  return `${base}/wp-json/wc/v3/orders?search=${encodeURIComponent(query)}&per_page=20`;
}

// A WooCommerce product carries its full HTML descriptions, image list,
// attributes and meta_data -- several kilobytes each. The caller serialises
// this payload into the model's message list under a 2000-character budget
// (connectorExecution.ts), so passing the vendor object through meant the
// model received a fraction of ONE product, cut off mid-JSON. Only the fields
// an answer is built from survive.
const PRODUCT_FIELDS = [
  "id",
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
  const url = `${base}/wp-json/wc/v3/products/categories?search=${
    encodeURIComponent(name)
  }&per_page=10`;
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
      capabilities: [...CAPABILITIES],
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
