export interface Field {
  key: string;
  label: string;
  kind: "text" | "secret" | "url";
  required: boolean;
  help: string;
}

export interface UsageGuide {
  whenToUse: string;
  requestExamples: string[];
  limits: string;
}

export const CONNECTOR_TYPES = [
  "supabase",
  "mysql_postgres",
  "woocommerce",
  "shopify",
  "salla",
  "zid",
  "formula",
  "custom_rest",
  "myfatoorah",
  "stripe",
  "higgsfield",
  "mcp_custom",
] as const;

export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

// Emptied by PR-3's Migration A (20260831130000_connector_scope_and_sharing.sql),
// which rebuilt the DB connector_type CHECK with all twelve registry types.
// Until that migration was applied, the four types listed here existed in the
// registry and the browser picker while the CHECK rejected them, so the write
// path held them back and messaging-api silently rewrote saves of them to
// custom_rest. Kept as a staging seam rather than deleted: a future type that
// lands in the registry before its own migration is applied is listed here
// again, and the contract test re-arms itself the same way it did for these.
const PENDING_DB_CONNECTOR_TYPES: readonly ConnectorType[] = [];

// The write allow-list ai_upsert_tool validates against. Equal to the full
// registry since Migration A; derived (not inlined) so the staging seam above
// stays the single place a pending type is held back. Order matters if this
// ever becomes non-empty again: the widened list must not reach a deployed
// messaging-api before the migration that admits the types is live.
export const SERVER_CONNECTOR_TYPES = CONNECTOR_TYPES.filter(
  (type) => !PENDING_DB_CONNECTOR_TYPES.includes(type),
);

export interface ConnectorDefinition {
  type: ConnectorType;
  label: string;
  credentials: Field[];
  usageGuide?: UsageGuide;
}

const CONNECTOR_DEFINITIONS: Record<ConnectorType, ConnectorDefinition> = {
  supabase: {
    type: "supabase",
    label: "Supabase",
    credentials: [
      {
        key: "project_url",
        label: "Project URL",
        kind: "url",
        required: true,
        help: "The Supabase project URL used for PostgREST requests.",
      },
      {
        key: "anon_key",
        label: "Anon key",
        kind: "secret",
        required: true,
        help: "Use the anon key only; the target project's RLS remains the security boundary.",
      },
      {
        key: "schema",
        label: "Schema",
        kind: "text",
        required: true,
        help: "The Postgres schema exposed through PostgREST.",
      },
      {
        key: "table_allow_list",
        label: "Table allow-list",
        kind: "text",
        required: true,
        help: "The tables this connector may query, subject to the target project's RLS.",
      },
    ],
    usageGuide: {
      whenToUse: "Live rows exposed by this Supabase project's PostgREST API. Prefer it when the answer depends on current database state.",
      requestExamples: ["find the current booking for this phone number", "look up this product's availability"],
      limits: "Anon-key access only. The target project's RLS and configured schema and table allow-list constrain results.",
    },
  },
  mysql_postgres: {
    type: "mysql_postgres",
    label: "PostgreSQL / MySQL",
    credentials: [
      {
        key: "gateway_url",
        label: "Gateway URL",
        kind: "url",
        required: true,
        help: "An HTTPS REST gateway such as Prisma, Hasura, Directus, or PostgREST; not a raw database connection.",
      },
      {
        key: "auth_header",
        label: "Auth header",
        kind: "secret",
        required: true,
        help: "The authorization header sent to the REST gateway.",
      },
      {
        key: "table_resource",
        label: "Table/resource",
        kind: "text",
        required: true,
        help: "The gateway table or resource this connector may query.",
      },
    ],
    usageGuide: {
      whenToUse: "Current business data exposed through this database's HTTPS REST gateway.",
      requestExamples: ["find the order for customer 402", "check the current inventory for SKU ABC-12"],
      limits: "Uses an HTTPS REST gateway only, not a raw PostgreSQL or MySQL driver, and is limited to the configured resource.",
    },
  },
  woocommerce: {
    type: "woocommerce",
    label: "WooCommerce",
    credentials: [
      {
        key: "store_url",
        label: "Store URL",
        kind: "url",
        required: true,
        help: "The public URL of the WooCommerce store.",
      },
      {
        key: "consumer_key",
        label: "Consumer key",
        kind: "secret",
        required: true,
        help: "The WooCommerce REST API consumer key used as the Basic Auth username.",
      },
      {
        key: "consumer_secret",
        label: "Consumer secret",
        kind: "secret",
        required: true,
        help: "The WooCommerce REST API consumer secret used as the Basic Auth password.",
      },
    ],
    usageGuide: {
      whenToUse: "Live product, stock and order data for this store. Prefer it over indexed knowledge for price and availability, which change.",
      requestExamples: ["stock level for SKU ABC-12", "status of order 10432"],
      limits: "Reads only. Cannot place, refund or modify an order.",
    },
  },
  shopify: {
    type: "shopify",
    label: "Shopify",
    credentials: [
      {
        key: "shop_domain",
        label: "Shop domain",
        kind: "text",
        required: true,
        help: "The store's Shopify domain.",
      },
      {
        key: "api_version",
        label: "API version",
        kind: "text",
        required: true,
        help: "The Shopify Admin API version to call.",
      },
      {
        key: "client_id",
        label: "Client ID",
        kind: "text",
        required: false,
        help: "The app client ID; provide it with the client secret instead of an existing admin-app access token.",
      },
      {
        key: "client_secret",
        label: "Client secret",
        kind: "secret",
        required: false,
        help: "The app client secret; provide it with the client ID instead of an existing admin-app access token.",
      },
      {
        key: "admin_app_access_token",
        label: "Admin-app access token",
        kind: "secret",
        required: false,
        help: "An existing admin-created custom app access token, used instead of the client ID and client secret pair.",
      },
    ],
    usageGuide: {
      whenToUse: "Live Shopify product, inventory, customer and order data for this shop.",
      requestExamples: ["is the blue medium shirt in stock", "what is the status of order 10432"],
      limits: "Uses the configured Admin API version and the permissions granted to the Shopify app or access token.",
    },
  },
  salla: {
    type: "salla",
    label: "Salla",
    credentials: [
      {
        key: "client_id",
        label: "Client ID",
        kind: "text",
        required: true,
        help: "The Salla OAuth client ID.",
      },
      {
        key: "client_secret",
        label: "Client secret",
        kind: "secret",
        required: true,
        help: "The Salla OAuth client secret.",
      },
      {
        key: "access_token",
        label: "Access token",
        kind: "secret",
        required: true,
        help: "The Salla OAuth bearer access token.",
      },
      {
        key: "refresh_token",
        label: "Refresh token",
        kind: "secret",
        required: true,
        help: "The Salla OAuth refresh token.",
      },
      {
        key: "expiry",
        label: "Expiry",
        kind: "text",
        required: true,
        help: "The access token expiry used to schedule serialized refreshes.",
      },
    ],
    usageGuide: {
      whenToUse: "Live products, stock, customers and orders from this Salla store.",
      requestExamples: ["check availability of product 814", "track Salla order 10432"],
      limits: "Limited to the scopes granted by the merchant. Access tokens expire and require serialized refresh.",
    },
  },
  zid: {
    type: "zid",
    label: "Zid",
    credentials: [
      {
        key: "client_id",
        label: "Client ID",
        kind: "text",
        required: true,
        help: "The Zid OAuth client ID.",
      },
      {
        key: "client_secret",
        label: "Client secret",
        kind: "secret",
        required: true,
        help: "The Zid OAuth client secret.",
      },
      {
        key: "authorization_token",
        label: "Authorization token",
        kind: "secret",
        required: true,
        help: "The Zid authorization token sent with API requests.",
      },
      {
        key: "x_manager_token",
        label: "X-Manager-Token",
        kind: "secret",
        required: true,
        help: "The Zid manager token required alongside the authorization token.",
      },
    ],
    usageGuide: {
      whenToUse: "Live products, inventory, customers and orders from this Zid store.",
      requestExamples: ["find this customer's latest order", "is product 814 available now"],
      limits: "Limited to the granted Zid scopes and requires both authorization and X-Manager-Token headers.",
    },
  },
  formula: {
    type: "formula",
    label: "Formula",
    credentials: [],
    usageGuide: {
      whenToUse: "Deterministic local calculations using the formula configured for this tool.",
      requestExamples: ["calculate the quote total", "convert this measurement using the configured formula"],
      limits: "Local computation only. It cannot retrieve live or external data.",
    },
  },
  custom_rest: {
    type: "custom_rest",
    label: "Custom REST",
    credentials: [
      {
        key: "url",
        label: "URL",
        kind: "url",
        required: true,
        help: "The HTTPS endpoint called by this custom connector.",
      },
      {
        key: "header_name",
        label: "Header name",
        kind: "text",
        required: true,
        help: "The request header used to send the connector secret.",
      },
      {
        key: "secret",
        label: "Secret",
        kind: "secret",
        required: true,
        help: "The secret value sent in the configured request header.",
      },
    ],
  },
  myfatoorah: {
    type: "myfatoorah",
    label: "MyFatoorah",
    credentials: [
      {
        key: "api_token",
        label: "API token",
        kind: "secret",
        required: true,
        help: "The MyFatoorah bearer API token.",
      },
      {
        key: "environment",
        label: "Environment",
        kind: "text",
        required: true,
        help: "The MyFatoorah test or live environment.",
      },
    ],
    usageGuide: {
      whenToUse: "Current MyFatoorah invoice and payment status for customer support questions.",
      requestExamples: ["has invoice 100238 been paid", "check the status of this payment"],
      limits: "Limited to the configured environment and API token permissions. Do not treat an unpaid invoice as a completed payment.",
    },
  },
  stripe: {
    type: "stripe",
    label: "Stripe",
    credentials: [
      {
        key: "restricted_api_key",
        label: "Restricted API key",
        kind: "secret",
        required: true,
        help: "A Stripe restricted key (rk_live_… or rk_test_…) with only the required resource permissions.",
      },
    ],
    usageGuide: {
      whenToUse: "Current Stripe customer, payment, invoice or subscription status.",
      requestExamples: ["did this payment succeed", "when does this customer's subscription renew"],
      limits: "The restricted key's per-resource permissions apply. Prefer read-only permissions and do not expose payment credentials.",
    },
  },
  higgsfield: {
    type: "higgsfield",
    label: "Higgsfield",
    credentials: [],
    usageGuide: {
      whenToUse: "Generate or inspect Higgsfield media jobs when the configured tool exposes that capability.",
      requestExamples: ["generate a product video from this image", "check whether the media job has finished"],
      limits: "Available operations, models and generation limits depend on the configured Higgsfield integration.",
    },
  },
  mcp_custom: {
    type: "mcp_custom",
    label: "Generic MCP",
    credentials: [
      {
        key: "server_url",
        label: "Server URL",
        kind: "url",
        required: true,
        help: "The HTTPS URL of the MCP server.",
      },
      {
        key: "auth_header",
        label: "Auth header",
        kind: "secret",
        required: true,
        help: "The authorization header required by the MCP server.",
      },
    ],
    usageGuide: {
      whenToUse: "Capabilities exposed by this configured MCP server when no vendor-specific connector applies.",
      requestExamples: ["search the connected system for this customer", "run the server's configured lookup tool"],
      limits: "Capabilities and limits are defined by the MCP server. Use only tools the server advertises.",
    },
  },
};

export function connectorDefinition(type: string): ConnectorDefinition {
  if (!Object.prototype.hasOwnProperty.call(CONNECTOR_DEFINITIONS, type)) {
    throw new Error(`Unknown connector type: ${type}`);
  }

  return CONNECTOR_DEFINITIONS[type as ConnectorType];
}

/**
 * The usage guide for a connector type, or undefined when there is none.
 *
 * Deliberately non-throwing, unlike connectorDefinition. This is called while
 * assembling a reply to a customer, and a description is decoration: failing a
 * live conversation over a lookup that only prettifies a prompt would be a far
 * worse outcome than an unadorned tool. custom_rest legitimately has no guide,
 * and so does any row whose type predates the registry.
 */
export function connectorUsageGuide(type: string | null | undefined): UsageGuide | undefined {
  if (!type) return undefined;
  return Object.prototype.hasOwnProperty.call(CONNECTOR_DEFINITIONS, type)
    ? CONNECTOR_DEFINITIONS[type as ConnectorType].usageGuide
    : undefined;
}
