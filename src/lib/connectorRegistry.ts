// Deliberate browser mirror of supabase/functions/_shared/connectorRegistry.ts.
// Deno and the browser cannot share that runtime module; the contract test keeps both copies aligned.

export interface Field {
  key: string;
  label: string;
  kind: "text" | "secret" | "url" | "hidden";
  required: boolean;
  help: string;
}

export interface UsageGuide {
  whenToUse: string;
  requestExamples: string[];
  limits: string;
}

export type AuthStrategy = "manual_credentials" | "composio_oauth";
export type ConnectorCategory = "ecommerce_payments" | "productivity_crm" | "databases" | "automation";

export interface ComposioBinding {
  toolkit: string;
  tools: readonly string[];
  mutating: readonly string[];
  toolkitVersion: string;
}

export const CONNECTOR_CATEGORY_LABELS: Record<ConnectorCategory, string> = {
  ecommerce_payments: "E-Commerce & Payments",
  productivity_crm: "Productivity & Apps",
  databases: "Databases",
  automation: "Automation",
};

// Pinned per toolkit from the live spike of 2026-09-03 (spec §1): under "latest" a
// cached schema and an execution could silently disagree after Composio bumps a toolkit.
// Bump deliberately, with the callback re-run so tool_schema_cache follows.

export const CONNECTOR_CAPABILITY_NAMES = [
  "search_products",
  "check_stock",
  "lookup_orders",
  "get_product",
  "update_order",
] as const;

/** Capabilities the model may choose. get_product and update_order are procedure-only. */
export const MODEL_CONNECTOR_CAPABILITIES = [
  "search_products",
  "check_stock",
  "lookup_orders",
] as const;

export type ConnectorCapability = (typeof CONNECTOR_CAPABILITY_NAMES)[number];

export interface ConnectorParameterSchema {
  type: "object";
  properties: Record<string, {
    type: "string" | "object";
    description: string;
    additionalProperties?: { type: readonly ("string" | "number" | "boolean")[] };
  }>;
  required?: string[];
  additionalProperties: boolean;
}

export interface ConnectorCapabilityDefinition {
  name: ConnectorCapability;
  description: string;
  parameters: ConnectorParameterSchema;
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
  "google_sheets",
  "slack",
  "google_calendar",
  "hubspot",
  "notion",
  "airtable",
  "youtube",
] as const;

export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

// Mirror of the Deno copy's staging seam; empty for the same reason it is there.
export const PENDING_DB_CONNECTOR_TYPES: readonly ConnectorType[] = [];

export interface ConnectorDefinition {
  type: ConnectorType;
  label: string;
  auth_strategy: AuthStrategy;
  category: ConnectorCategory;
  credentials: Field[];
  usageGuide?: UsageGuide;
  /** Present only when a live ai-agent-adapters implementation exists. */
  capabilities?: readonly ConnectorCapabilityDefinition[];
  composio?: ComposioBinding;
}

const SUPABASE_PARAMETERS: ConnectorParameterSchema = {
  type: "object",
  properties: {
    table: {
      type: "string",
      description: "Allowed PostgREST table to query. Omit to use the connector's first allowed table.",
    },
    select: {
      type: "string",
      description: "Comma-separated columns to return. Omit to return all allowed columns.",
    },
    filters: {
      type: "object",
      description: "Exact-match column filters using string, number, or boolean values.",
      additionalProperties: { type: ["string", "number", "boolean"] },
    },
    offset: {
      type: "string",
      description:
        "Row offset to start from. When a result says has_more, call again with offset set to its next_offset value to read the following page.",
    },
    mode: {
      type: "string",
      description:
        "Use \"count\" to return only how many rows match, without reading them. Defaults to \"rows\".",
    },
  },
  additionalProperties: false,
};

const CONNECTOR_DEFINITIONS: Record<ConnectorType, ConnectorDefinition> = {
  supabase: {
    type: "supabase",
    label: "Supabase",
    auth_strategy: "manual_credentials",
    category: "databases",
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
      {
        key: "select_columns",
        label: "Columns to read (optional)",
        kind: "text",
        required: false,
        help: "Comma-separated columns the AI agent reads, e.g. type_name, price. Leave empty to return every column. Fewer columns means smaller prompts and cheaper replies.",
      },
      {
        key: "column_map",
        label: "Columns per table (optional)",
        kind: "text",
        required: false,
        help:
          "JSON mapping EVERY allowed table to the columns the agent may read, e.g. {\"products\":[\"id\",\"price\"],\"orders\":\"*\"}. Once set it replaces the single list above. Use \"*\" for a table you do not want to narrow: a table this map omits is refused, and a table mapped to an empty list is refused too. The picker below fills this in for you.",
      },
      {
        key: "column_catalog",
        label: "Column catalog",
        kind: "hidden",
        required: false,
        help:
          "The tables and columns the picker last read from the project, kept so an edit can show every column with the saved ones ticked before the key is re-entered. Written by the picker; never read by the adapter.",
      },
      {
        key: "order_by",
        label: "Order by column",
        kind: "text",
        required: false,
        help:
          "The column to order by, required to read more than one page. It must be unique, or paging can repeat and skip rows: add a unique tie-breaker as a second column if it is not, e.g. \"status,id\".",
      },
      {
        key: "max_rows",
        label: "Maximum rows per answer",
        kind: "text",
        required: false,
        help:
          "How many rows one lookup may return. Defaults to 25, up to 1000. Only rows this connector's key is allowed to see are returned.",
      },
      {
        key: "page_size",
        label: "Rows per request (optional)",
        kind: "text",
        required: false,
        help: "How many rows to fetch per database request while paging. Defaults to 200.",
      },
    ],
    usageGuide: {
      whenToUse: "Live rows exposed by this Supabase project's PostgREST API. Prefer it when the answer depends on current database state.",
      requestExamples: ["find the current booking for this phone number", "look up this product's availability"],
      limits: "Anon-key access only, so only rows this connector's key may see are returned; the target project's RLS and the configured schema and table allow-list constrain results. Large tables come back in pages: when a result says has_more, call again with offset set to its next_offset value. To answer how many rows match, pass mode \"count\" instead of reading them.",
    },
    capabilities: CONNECTOR_CAPABILITY_NAMES.map((name) => ({
      name,
      description: name === "search_products"
        ? "Search current rows relevant to a product request."
        : name === "check_stock"
          ? "Check current stock data in an allowed table."
          : "Look up current order data in an allowed table.",
      parameters: SUPABASE_PARAMETERS,
    })),
  },
  mysql_postgres: {
    type: "mysql_postgres",
    label: "PostgreSQL / MySQL",
    auth_strategy: "manual_credentials",
    category: "databases",
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
    auth_strategy: "manual_credentials",
    category: "ecommerce_payments",
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
    capabilities: [
      {
        name: "search_products",
        description:
          "Search or browse WooCommerce products. Sort by price to answer superlatives such as the most expensive or cheapest item. Stock and prices may be up to 2 minutes old.",
        parameters: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "Product name, description, or search phrase. Omit it to browse the whole catalogue.",
            },
            category: {
              type: "string",
              description: "Product category NAME to restrict the search to, e.g. men's perfumes. Omit for all categories.",
            },
            sort_by: {
              type: "string",
              description: "One of price, date, popularity, rating. Omit for the store's own relevance order.",
            },
            order: {
              type: "string",
              description: "asc or desc. Defaults to desc, so sort_by=price returns the most expensive first.",
            },
            limit: {
              type: "string",
              description: "How many products to return, 1 to 20. Defaults to 5.",
            },
          },
          additionalProperties: false,
        },
      },
      {
        name: "check_stock",
        description: "Check live WooCommerce stock by SKU.",
        parameters: {
          type: "object",
          properties: {
            sku: { type: "string", description: "Exact product SKU." },
          },
          required: ["sku"],
          additionalProperties: false,
        },
      },
      {
        name: "lookup_orders",
        description: "Look up a WooCommerce order by id or search phrase.",
        parameters: {
          type: "object",
          properties: {
            order_id: { type: "string", description: "Exact WooCommerce order id, when known." },
            query: { type: "string", description: "Order search phrase when the exact id is unknown." },
          },
          additionalProperties: false,
        },
      },
      {
        name: "get_product",
        description: "Read one WooCommerce product or variation by id. Used by store procedures, not offered to the model.",
        parameters: {
          type: "object",
          properties: {
            product_id: { type: "string", description: "WooCommerce product or variation id." },
            parent_id: { type: "string", description: "Parent product id when product_id is a variation." },
          },
          required: ["product_id"],
          additionalProperties: false,
        },
      },
      {
        name: "update_order",
        description: "Add an order note and, when asked, cancel the order. Used by store procedures, not offered to the model.",
        parameters: {
          type: "object",
          properties: {
            order_id: { type: "string", description: "WooCommerce order id." },
            note: { type: "string", description: "Private order note." },
            status: { type: "string", description: "Only cancelled, and only when the order is still in an expected status." },
          },
          required: ["order_id", "note"],
          additionalProperties: false,
        },
      },
    ],
  },
  shopify: {
    type: "shopify",
    label: "Shopify",
    auth_strategy: "manual_credentials",
    category: "ecommerce_payments",
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
    auth_strategy: "manual_credentials",
    category: "ecommerce_payments",
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
    auth_strategy: "manual_credentials",
    category: "ecommerce_payments",
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
    auth_strategy: "manual_credentials",
    category: "automation",
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
    auth_strategy: "manual_credentials",
    category: "automation",
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
    auth_strategy: "manual_credentials",
    category: "ecommerce_payments",
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
    auth_strategy: "manual_credentials",
    category: "ecommerce_payments",
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
    auth_strategy: "manual_credentials",
    category: "automation",
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
    auth_strategy: "manual_credentials",
    category: "automation",
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
  google_sheets: {
    type: "google_sheets", label: "Google Sheets", auth_strategy: "composio_oauth", category: "productivity_crm", credentials: [],
    composio: {
      toolkit: "googlesheets", toolkitVersion: "20260902_00",
      tools: ["GOOGLESHEETS_BATCH_GET", "GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW", "GOOGLESHEETS_GET_SPREADSHEET_INFO", "GOOGLESHEETS_BATCH_UPDATE", "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND"],
      mutating: ["GOOGLESHEETS_BATCH_UPDATE", "GOOGLESHEETS_SPREADSHEETS_VALUES_APPEND"],
    },
    usageGuide: {
      whenToUse: "Rows in the connected Google Sheets spreadsheet — stock lists, bookings, price tables the business keeps in a sheet.",
      requestExamples: ["is item 42 in the stock sheet", "what price does the sheet list for the large size"],
      limits: "Reads the connected account\'s sheets only. Writing rows changes the customer\'s data and is off unless the connector allows writes.",
    },
  },
  slack: {
    type: "slack", label: "Slack", auth_strategy: "composio_oauth", category: "productivity_crm", credentials: [],
    composio: { toolkit: "slack", toolkitVersion: "20260826_00", tools: ["SLACK_SEARCH_MESSAGES", "SLACK_LIST_CONVERSATIONS", "SLACK_SEND_MESSAGE"], mutating: ["SLACK_SEND_MESSAGE"] },
    usageGuide: {
      whenToUse: "Messages and channels in the connected Slack workspace.",
      requestExamples: ["find the latest message about order 10432", "which channel discussed the launch"],
      limits: "Sending a message changes the customer\'s workspace and is off unless the connector allows writes.",
    },
  },
  google_calendar: {
    type: "google_calendar", label: "Google Calendar", auth_strategy: "composio_oauth", category: "productivity_crm", credentials: [],
    composio: { toolkit: "googlecalendar", toolkitVersion: "20260902_00", tools: ["GOOGLECALENDAR_EVENTS_LIST", "GOOGLECALENDAR_FIND_FREE_SLOTS", "GOOGLECALENDAR_CREATE_EVENT"], mutating: ["GOOGLECALENDAR_CREATE_EVENT"] },
    usageGuide: {
      whenToUse: "Events and availability in the connected Google Calendar.",
      requestExamples: ["what appointments are tomorrow", "find a free slot next Tuesday"],
      limits: "Creating an event changes the customer\'s calendar and is off unless the connector allows writes.",
    },
  },
  hubspot: {
    type: "hubspot", label: "HubSpot", auth_strategy: "composio_oauth", category: "productivity_crm", credentials: [],
    composio: { toolkit: "hubspot", toolkitVersion: "20260826_00", tools: ["HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA", "HUBSPOT_READ_CONTACT", "HUBSPOT_CREATE_CONTACT"], mutating: ["HUBSPOT_CREATE_CONTACT"] },
    usageGuide: {
      whenToUse: "Contacts and customer records in the connected HubSpot account.",
      requestExamples: ["find the contact for this email", "show the CRM record for this customer"],
      limits: "Creating a contact changes the customer\'s CRM and is off unless the connector allows writes.",
    },
  },
  notion: {
    type: "notion", label: "Notion", auth_strategy: "composio_oauth", category: "productivity_crm", credentials: [],
    composio: { toolkit: "notion", toolkitVersion: "20260819_00", tools: ["NOTION_SEARCH_NOTION_PAGE", "NOTION_FETCH_DATA", "NOTION_QUERY_DATABASE"], mutating: [] },
    usageGuide: {
      whenToUse: "Pages and database records shared with the connected Notion integration.",
      requestExamples: ["find the returns policy page", "look up this item in the product database"],
      limits: "Reads only pages and databases granted to the integration.",
    },
  },
  airtable: {
    type: "airtable", label: "Airtable", auth_strategy: "composio_oauth", category: "productivity_crm", credentials: [],
    composio: { toolkit: "airtable", toolkitVersion: "20260902_00", tools: ["AIRTABLE_LIST_RECORDS", "AIRTABLE_GET_RECORD", "AIRTABLE_CREATE_RECORD"], mutating: ["AIRTABLE_CREATE_RECORD"] },
    usageGuide: {
      whenToUse: "Records in the connected Airtable bases.",
      requestExamples: ["list open bookings", "find the record for customer 402"],
      limits: "Creating a record changes the customer\'s base and is off unless the connector allows writes.",
    },
  },
  youtube: {
    type: "youtube", label: "YouTube", auth_strategy: "composio_oauth", category: "automation", credentials: [],
    composio: {
      toolkit: "youtube",
      toolkitVersion: "20260721_00",
      tools: [
        "YOUTUBE_LIST_CHANNELS",
        "YOUTUBE_MULTIPART_UPLOAD_VIDEO",
        "YOUTUBE_UPDATE_THUMBNAIL",
        "YOUTUBE_LIST_COMMENT_THREADS",
        "YOUTUBE_LIST_COMMENTS",
        "YOUTUBE_CREATE_COMMENT_REPLY",
        "YOUTUBE_SET_COMMENT_MODERATION_STATUS",
        "YOUTUBE_DELETE_COMMENT",
        "YOUTUBE_GET_VIDEO_DETAILS_BATCH",
        "YOUTUBE_LIST_PLAYLIST_ITEMS",
      ],
      mutating: [
        "YOUTUBE_MULTIPART_UPLOAD_VIDEO",
        "YOUTUBE_UPDATE_THUMBNAIL",
        "YOUTUBE_CREATE_COMMENT_REPLY",
        "YOUTUBE_SET_COMMENT_MODERATION_STATUS",
        "YOUTUBE_DELETE_COMMENT",
      ],
    },
    usageGuide: {
      whenToUse: "The connected YouTube channel: publishing, and the comments on its videos. Use it to list comment threads and their replies, reply to a comment, hide or unhide a comment, or delete one of the channel's own comments.",
      requestExamples: ["list the connected channels", "upload this approved video", "show the latest comment threads on this video", "reply to this comment", "hide this comment", "unhide this comment", "delete our own comment"],
      limits: "Uploads, thumbnail updates, comment replies, moderation changes and comment deletion change the channel and are off unless the connector allows writes. A reply always attaches to the thread's top-level comment. Hiding is reversible (unhide restores it); deletion only works on comments the channel wrote — hide anyone else's instead.",
    },
  },
};

export function connectorDefinition(type: string): ConnectorDefinition {
  if (!Object.prototype.hasOwnProperty.call(CONNECTOR_DEFINITIONS, type)) {
    throw new Error(`Unknown connector type: ${type}`);
  }

  return CONNECTOR_DEFINITIONS[type as ConnectorType];
}

export function isComposioType(type: string | null | undefined): boolean {
  return Boolean(type && Object.prototype.hasOwnProperty.call(CONNECTOR_DEFINITIONS, type) &&
    CONNECTOR_DEFINITIONS[type as ConnectorType].auth_strategy === "composio_oauth");
}

export function composioBinding(type: string | null | undefined): ComposioBinding | undefined {
  if (!isComposioType(type)) return undefined;
  return CONNECTOR_DEFINITIONS[type as ConnectorType].composio;
}

/** The typed capabilities backed by a live adapter, or undefined for legacy rows. */
export function connectorCapabilities(
  type: string | null | undefined,
): readonly ConnectorCapabilityDefinition[] | undefined {
  if (!type || !Object.prototype.hasOwnProperty.call(CONNECTOR_DEFINITIONS, type)) return undefined;
  return CONNECTOR_DEFINITIONS[type as ConnectorType].capabilities;
}

/** Pure routing decision: does this connector type have a live adapter (and
 *  therefore a Test connection button)? Never a hardcoded type list — it is
 *  derived from the registry's capabilities, exactly like the shared copy. */
export function shouldUseAdapter(
  tool: { connector_type?: string | null },
): boolean {
  return (connectorCapabilities(tool.connector_type)?.length ?? 0) > 0;
}
