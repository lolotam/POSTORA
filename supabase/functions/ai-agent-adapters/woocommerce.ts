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

function buildUrl(invocation: ConnectorInvocation, capability?: Capability): string | null {
  const storeUrl = requiredString(invocation.tool.settings, "store_url");
  if (!storeUrl) return null;
  const base = storeUrl.replace(/\/+$/, "");
  const parameters = invocation.request.parameters;

  if (!capability) return `${base}/wp-json/wc/v3/products?per_page=1`;
  if (capability === "search_products") {
    const query = requiredString(parameters, "query") ?? "";
    return `${base}/wp-json/wc/v3/products?search=${encodeURIComponent(query)}&per_page=20`;
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

async function callWooCommerce(
  invocation: ConnectorInvocation,
  dependencies: AdapterDependencies,
  capability?: Capability,
): Promise<ConnectorResult> {
  const consumerKey = requiredString(invocation.credentials, "consumer_key");
  const consumerSecret = requiredString(invocation.credentials, "consumer_secret");
  const url = buildUrl(invocation, capability);
  if (!consumerKey || !consumerSecret || !url) {
    return wooFailure("woocommerce_configuration_invalid", "WooCommerce is not fully configured.");
  }

  const response = await safeVendorFetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Basic ${btoa(`${consumerKey}:${consumerSecret}`)}`,
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
  return { ok: true, vendor: "woocommerce", action: "execute", capability, data: payload };
}

export const wooCommerceAdapter: ConnectorAdapter = {
  id: "woocommerce",
  capabilities: [...CAPABILITIES],
  execute: (invocation, dependencies) =>
    callWooCommerce(invocation, dependencies, invocation.request.capability),
  testConnection: (invocation, dependencies) =>
    callWooCommerce(invocation, dependencies),
};
