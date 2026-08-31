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

async function callWooCommerce(
  invocation: ConnectorInvocation,
  dependencies: AdapterDependencies,
  capability?: Capability,
): Promise<ConnectorResult> {
  const consumerKey = requiredString(invocation.credentials, "consumer_key");
  const consumerSecret = requiredString(invocation.credentials, "consumer_secret");
  const storeUrl = requiredString(invocation.tool.settings, "store_url");
  if (!consumerKey || !consumerSecret || !storeUrl) {
    return wooFailure("woocommerce_configuration_invalid", "WooCommerce is not fully configured.");
  }
  const authorization = `Basic ${btoa(`${consumerKey}:${consumerSecret}`)}`;

  let categoryId: string | null = null;
  const categoryName = capability === "search_products"
    ? requiredString(invocation.request.parameters, "category")
    : null;
  if (categoryName) {
    categoryId = await resolveCategoryId(
      storeUrl.replace(/\/+$/, ""),
      authorization,
      categoryName,
      dependencies,
    );
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

  const response = await safeVendorFetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: authorization,
    },
  }, dependencies);
  if (!response.ok) {
    return wooFailure("woocommerce_http_error", "WooCommerce rejected the request.", response.status);
  }
  const payload = await readJson(response);
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
  return {
    ok: true,
    vendor: "woocommerce",
    action: "execute",
    capability,
    data: projectPayload(capability, payload),
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
