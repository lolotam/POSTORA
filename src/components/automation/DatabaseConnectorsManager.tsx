import { useState, useMemo, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import type { TFunction } from "i18next";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Database,
  Globe,
  Loader2,
  Pencil,
  Plus,
  ShieldCheck,
  Trash2,
  ShoppingBag,
  Calculator,
  Server,
  Sparkles,
  Search,
  Lock,
  Clock,
  CreditCard,
  Check,
  Copy,
  CheckCircle2,
  Zap,
  Unlink,
  Link2,
  Radio,
  ExternalLink,
  Share2,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAuth } from "@/hooks/useAuth";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import { supabase } from "@/integrations/supabase/client";
import { HIGGSFIELD_CALLBACK_PATH } from "@/lib/higgsfieldOAuthReturn";
import {
  useAiAgentTools,
  useAiToolAccountLinks,
  type AiAgentTool,
  type AiAgentToolInput,
  type ConnectorType,
  type ToolAccountLink,
} from "@/hooks/useAiAgentTools";
import type { AiAgentPlatform } from "@/hooks/useAiAgentConfig";
import { callEdgeApi } from "@/lib/messagingApi";
import {
  CONNECTOR_CATEGORY_LABELS,
  CONNECTOR_TYPES,
  connectorDefinition,
  hasGuardedWrites,
  isComposioType,
  shouldUseAdapter,
  type ConnectorCategory,
  type Field,
} from "@/lib/connectorRegistry";
import { CATEGORY_TABS, useConnectorWorkspace } from "@/features/connectors";
import { ComposioConnectCard } from "@/components/automation/connectors/ComposioConnectCard";
import { ConnectionPicker } from "@/components/automation/connectors/ConnectionPicker";
import { ConnectorUsageLine, ToolUsageLine } from "@/components/automation/connectors/ConnectorUsageLine";
import { SupabaseSchemaPicker } from "@/components/automation/SupabaseSchemaPicker";
import {
  accountLabel,
  agentAccounts,
  effectiveToolAccountIds,
  nextToolSharing,
  type SharingAccount,
} from "@/lib/accountSharing";
import { PlatformIcon } from "@/components/PlatformIcon";
import type { Platform } from "@/lib/types";
import { validateAiToolName, validateAiToolUrl } from "@/lib/aiTools";
import { cn } from "@/lib/utils";

/**
 * Authentic high-definition vector brand logos for connectors
 */
export function ConnectorBrandLogo({ id, className = "w-8 h-8" }: { id: ConnectorType; className?: string }) {
  switch (id) {
    case "shopify":
      return (
        <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
          <path
            d="M83.5 24.8c-.3-.8-1-1.3-1.8-1.4l-14.8-1.5c-.2-.6-.4-1.2-.7-1.8-3.4-6.8-9.4-11.2-16.7-11.2-7.3 0-13.3 4.4-16.7 11.2-.3.6-.5 1.2-.7 1.8l-14.8 1.5c-.8.1-1.5.6-1.8 1.4L.6 94.4c-.2.6 0 1.3.4 1.8.4.5 1 .8 1.6.8h94.8c.6 0 1.2-.3 1.6-.8.4-.5.6-1.2.4-1.8L83.5 24.8z"
            fill="#95BF47"
          />
          <path
            d="M49.5 14.9c5.2 0 9.7 3.5 12.3 8.8l-24.6 2.5c2.6-5.3 7.1-11.3 12.3-11.3z"
            fill="#5E8E3E"
          />
          <path
            d="M48.2 38.5c-9.1 0-13.5 5.5-13.5 11.4 0 11.5 17.6 13.2 17.6 21.2 0 4.1-3.6 6.5-8.4 6.5-6.2 0-10.4-3.3-10.4-3.3l-2.4 8.7s4.9 3.5 12.9 3.5c10.5 0 16.9-5.9 16.9-13.2 0-12.8-17.7-13.9-17.7-21.2 0-3.3 2.7-5.3 7.1-5.3 5.1 0 8.5 2.5 8.5 2.5l2.4-8.2s-4.6-2.6-13-2.6z"
            fill="#FFFFFF"
          />
        </svg>
      );

    case "woocommerce":
      return (
        <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
          <rect width="100" height="100" rx="24" fill="#7F54B3" />
          <path
            d="M84.2 34.8c-2.4-8.8-11.6-14-20.4-11.6l-37 10c-8.8 2.4-14 11.6-11.6 20.4l4.5 16.6c2.4 8.8 11.6 14 20.4 11.6l37-10c8.8-2.4 14-11.6 11.6-20.4l-4.5-16.6z"
            fill="#96588A"
          />
          <path
            d="M32.5 44.5c.8-1.5 2.8-2.1 4.3-1.3 1.5.8 2.1 2.8 1.3 4.3l-4.8 9.5 6.2-11.8c.8-1.5 2.8-2.1 4.3-1.3 1.5.8 2.1 2.8 1.3 4.3l-6.4 12.2 7.2-13.7c.8-1.5 2.8-2.1 4.3-1.3 1.5.8 2.1 2.8 1.3 4.3l-8.5 16.2c-.8 1.5-2.8 2.1-4.3 1.3-1.1-.6-1.7-1.8-1.5-3l5.1-9.7-6.2 11.8c-.8 1.5-2.8 2.1-4.3 1.3-1.1-.6-1.7-1.8-1.5-3l5.1-9.7-8.8 16.8c-.8 1.5-2.8 2.1-4.3 1.3-1.5-.8-2.1-2.8-1.3-4.3l10.8-20.5z"
            fill="#FFFFFF"
          />
        </svg>
      );

    case "salla":
      return (
        <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
          <rect width="100" height="100" rx="24" fill="#004D5A" />
          <path
            d="M50 20L76 35V65L50 80L24 65V35L50 20Z"
            stroke="#22C55E"
            strokeWidth="8"
            strokeLinejoin="round"
          />
          <circle cx="50" cy="50" r="12" fill="#22C55E" />
        </svg>
      );

    case "zid":
      return (
        <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
          <rect width="100" height="100" rx="24" fill="#7635DC" />
          <path
            d="M28 32H72L42 68H72"
            stroke="#FFFFFF"
            strokeWidth="10"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          <circle cx="48" cy="22" r="5" fill="#FFC72C" />
        </svg>
      );

    case "myfatoorah":
      return (
        <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
          <rect width="100" height="100" rx="24" fill="#1BA3B6" />
          <rect x="22" y="32" width="56" height="36" rx="8" stroke="#FFFFFF" strokeWidth="6" />
          <path d="M22 44H78" stroke="#FFFFFF" strokeWidth="5" />
          <circle cx="34" cy="56" r="4" fill="#FFD700" />
          <circle cx="44" cy="56" r="4" fill="#FF6B6B" />
        </svg>
      );

    case "stripe":
      return (
        <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
          <rect width="100" height="100" rx="24" fill="#635BFF" />
          <path
            d="M48.5 35.2c-5.8 0-9.6 3.1-9.6 7.8 0 8.8 12.8 7.4 12.8 11.2 0 1.8-1.6 2.4-3.8 2.4-3.8 0-8.6-1.6-8.6-1.6l-1.8 8.9s4.2 1.9 10 1.9c6.4 0 10.4-3.1 10.4-8 0-9.2-12.8-7.7-12.8-11.4 0-1.5 1.3-2.2 3.4-2.2 3.2 0 7.4 1.3 7.4 1.3l1.8-8.6s-3.7-1.7-9.2-1.7z"
            fill="#FFFFFF"
          />
        </svg>
      );

    case "higgsfield":
      return (
        <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
          <rect width="100" height="100" rx="24" fill="#1A1028" />
          <path
            d="M26 24V76L50 88L74 76V24L50 12L26 24Z"
            stroke="url(#higgs-grad)"
            strokeWidth="7"
            strokeLinejoin="round"
          />
          <path d="M50 12V88M26 24L74 76M74 24L26 76" stroke="url(#higgs-grad)" strokeWidth="5" strokeLinecap="round" />
          <circle cx="50" cy="50" r="10" fill="#F43F5E" />
          <defs>
            <linearGradient id="higgs-grad" x1="26" y1="12" x2="74" y2="88" gradientUnits="userSpaceOnUse">
              <stop stopColor="#F43F5E" />
              <stop offset="1" stopColor="#8B5CF6" />
            </linearGradient>
          </defs>
        </svg>
      );

    case "supabase":
      return (
        <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
          <rect width="100" height="100" rx="24" fill="#1C1C1C" />
          <path
            d="M54.5 18L26 53.5H48L44.5 82L73 46.5H51L54.5 18Z"
            fill="url(#supabase-grad)"
          />
          <defs>
            <linearGradient id="supabase-grad" x1="26" y1="18" x2="73" y2="82" gradientUnits="userSpaceOnUse">
              <stop stopColor="#3ECF8E" />
              <stop offset="1" stopColor="#249361" />
            </linearGradient>
          </defs>
        </svg>
      );

    case "mysql_postgres":
      return (
        <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
          <rect width="100" height="100" rx="24" fill="#336791" />
          <ellipse cx="50" cy="30" rx="26" ry="10" fill="#FFFFFF" fillOpacity="0.9" />
          <path
            d="M24 30v18c0 5.5 11.6 10 26 10s26-4.5 26-10V30"
            stroke="#FFFFFF"
            strokeWidth="6"
            fill="none"
          />
          <path
            d="M24 48v18c0 5.5 11.6 10 26 10s26-4.5 26-10V48"
            stroke="#FFFFFF"
            strokeWidth="6"
            fill="none"
          />
        </svg>
      );

    case "formula":
      return (
        <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
          <rect width="100" height="100" rx="24" fill="#F59E0B" />
          <path
            d="M32 30h36M32 50h36M32 70h36M50 22v56"
            stroke="#FFFFFF"
            strokeWidth="8"
            strokeLinecap="round"
          />
        </svg>
      );

    case "custom_rest":
      return (
        <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
          <rect width="100" height="100" rx="24" fill="#EA4B71" />
          <circle cx="35" cy="50" r="10" stroke="#FFFFFF" strokeWidth="6" />
          <circle cx="65" cy="35" r="10" stroke="#FFFFFF" strokeWidth="6" />
          <circle cx="65" cy="65" r="10" stroke="#FFFFFF" strokeWidth="6" />
          <path d="M45 46L55 39M45 54L55 61" stroke="#FFFFFF" strokeWidth="6" strokeLinecap="round" />
        </svg>
      );

    case "mcp_custom":
    default:
      return (
        <svg viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg" className={className}>
          <rect width="100" height="100" rx="24" fill="#8B5CF6" />
          <path
            d="M28 50L50 28L72 50L50 72L28 50Z"
            stroke="#FFFFFF"
            strokeWidth="8"
            strokeLinejoin="round"
          />
          <circle cx="50" cy="50" r="8" fill="#FFFFFF" />
        </svg>
      );
  }
}

export interface ConnectorDirectoryItem {
  id: ConnectorType;
  name: string;
  title: string;
  shortDesc: string;
  description: string;
  defaultUrl: string;
  suggestedPrompt: string;
  brandColor: string;
  iconBg: string;
  supportsMcp: boolean;
  isOAuth?: boolean;
  mcpServerName?: string;
  defaultPermissions: {
    searchProducts: boolean;
    checkStock: boolean;
    lookupOrders: boolean;
  };
}

export const CONNECTOR_DIRECTORY: ConnectorDirectoryItem[] = [
  {
    id: "shopify",
    name: "shopify_storefront",
    title: "Shopify Storefront",
    shortDesc: "Query products, live inventory, and customer orders via Storefront API.",
    description: "Official Shopify integration for automated product catalog lookups, collection browsing, stock verification, and order fulfillment status.",
    defaultUrl: "https://your-shop.myshopify.com/api/2024-01/graphql.json",
    suggestedPrompt: "Search Shopify product catalog, check live inventory, and look up customer order fulfillment status.",
    brandColor: "text-emerald-500",
    iconBg: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
    supportsMcp: true,
    mcpServerName: "shopify-mcp-server",
    defaultPermissions: { searchProducts: true, checkStock: true, lookupOrders: true },
  },
  {
    id: "woocommerce",
    name: "woocommerce_store",
    title: "WooCommerce Store",
    shortDesc: "Connect WordPress WooCommerce REST API for live products and orders.",
    description: "Official WooCommerce REST API connector to query products, variations, live prices, stock levels, and order history directly in customer chats.",
    defaultUrl: "https://your-store.com/wp-json/wc/v3/products",
    suggestedPrompt: "Search WooCommerce catalog for products, check prices, verify stock availability, and check order statuses.",
    brandColor: "text-purple-500",
    iconBg: "bg-purple-500/10 border-purple-500/20 text-purple-400",
    supportsMcp: true,
    mcpServerName: "woocommerce-mcp-server",
    defaultPermissions: { searchProducts: true, checkStock: true, lookupOrders: true },
  },
  {
    id: "salla",
    name: "salla_merchant_api",
    title: "Salla (سلة)",
    shortDesc: "Connect Salla Merchant API for Middle East e-commerce stores.",
    description: "Seamless integration with Salla Merchant API for Saudi & Middle East e-commerce stores to query products, prices, and shipping status.",
    defaultUrl: "https://api.salla.dev/admin/v2/products",
    suggestedPrompt: "Search Salla store products, check quantities, and check order shipping status.",
    brandColor: "text-amber-500",
    iconBg: "bg-amber-500/10 border-amber-500/20 text-amber-400",
    supportsMcp: false,
    defaultPermissions: { searchProducts: true, checkStock: true, lookupOrders: true },
  },
  {
    id: "zid",
    name: "zid_merchant_api",
    title: "Zid (زد)",
    shortDesc: "Connect Zid Merchant API for product search and order tracking.",
    description: "Direct integration with Zid Store Manager API for product catalog inquiries, inventory levels, and customer order management.",
    defaultUrl: "https://api.zid.sa/v1/managers/store/products",
    suggestedPrompt: "Search Zid store products, stock levels, and customer order updates.",
    brandColor: "text-violet-500",
    iconBg: "bg-violet-500/10 border-violet-500/20 text-violet-400",
    supportsMcp: false,
    defaultPermissions: { searchProducts: true, checkStock: true, lookupOrders: true },
  },
  {
    id: "myfatoorah",
    name: "myfatoorah_gateway",
    title: "MyFatoorah",
    shortDesc: "Payment gateway status, invoice queries, and payment link generator.",
    description: "MyFatoorah payment gateway integration to check payment status, lookup customer invoices, and generate instant checkout payment links.",
    defaultUrl: "https://api.myfatoorah.com/v2/GetPaymentStatus",
    suggestedPrompt: "Check payment invoice status, query transaction reference numbers, and generate payment links.",
    brandColor: "text-sky-500",
    iconBg: "bg-sky-500/10 border-sky-500/20 text-sky-400",
    supportsMcp: true,
    mcpServerName: "myfatoorah-mcp-server",
    defaultPermissions: { searchProducts: false, checkStock: false, lookupOrders: true },
  },
  {
    id: "stripe",
    name: "stripe_billing",
    title: "Stripe Payments",
    shortDesc: "Query customer invoices, payment intents, and subscription status.",
    description: "Connect to Stripe API to look up customer payment status, invoice details, and active subscriptions in customer support chats.",
    defaultUrl: "https://api.stripe.com/v1/payment_intents",
    suggestedPrompt: "Check Stripe payment intent status and customer subscription records.",
    brandColor: "text-indigo-500",
    iconBg: "bg-indigo-500/10 border-indigo-500/20 text-indigo-400",
    supportsMcp: false,
    defaultPermissions: { searchProducts: false, checkStock: false, lookupOrders: true },
  },
  {
    id: "higgsfield",
    name: "higgsfield_ai_studio",
    title: "Higgsfield AI Studio",
    shortDesc: "BYO generation for AI video, character sheets, and image creation.",
    description: "Connect your personal Higgsfield account. BYO generation bills Higgsfield directly and does not consume your Postora plan quota.",
    defaultUrl: "https://api.higgsfield.ai/v1",
    suggestedPrompt: "Generate custom AI video scenes, character portraits, and cinematic UGC content.",
    brandColor: "text-rose-500",
    iconBg: "bg-rose-500/10 border-rose-500/20 text-rose-400",
    supportsMcp: true,
    isOAuth: true,
    mcpServerName: "higgsfield-mcp-server",
    defaultPermissions: { searchProducts: false, checkStock: false, lookupOrders: false },
  },
  {
    id: "supabase",
    name: "supabase_product_catalog",
    title: "Supabase (PostgreSQL)",
    shortDesc: "Direct REST / RPC connection to your Supabase PostgreSQL tables.",
    description: "Direct REST / PostgREST connection to query your Supabase database tables for products, inventory, customer records, and custom RPC functions.",
    defaultUrl: "https://api.postora.cloud/rest/v1/products",
    suggestedPrompt: "Query store database for products matching customer query, including name, price, stock status, and product URLs.",
    brandColor: "text-emerald-400",
    iconBg: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
    supportsMcp: true,
    mcpServerName: "supabase-mcp-server",
    defaultPermissions: { searchProducts: true, checkStock: true, lookupOrders: false },
  },
  {
    id: "mysql_postgres",
    name: "sql_database_api",
    title: "PostgreSQL / MySQL API",
    shortDesc: "Query custom SQL databases via Prisma, Hasura, or PostgREST.",
    description: "Connect to custom SQL databases through Prisma, Hasura, Directus, or PostgREST for structured schema queries.",
    defaultUrl: "https://api.yourdomain.com/sql/products",
    suggestedPrompt: "Query relational database tables for product attributes, stock status, and pricing.",
    brandColor: "text-blue-500",
    iconBg: "bg-blue-500/10 border-blue-500/20 text-blue-400",
    supportsMcp: false,
    defaultPermissions: { searchProducts: true, checkStock: true, lookupOrders: false },
  },
  {
    id: "formula",
    name: "pricing_calculator",
    title: "Formulas & Price Calculator",
    shortDesc: "Compute custom quotes, shipping costs, and volume discounts.",
    description: "Computes custom quotes, delivery fees, bulk tier discounts, or VAT calculations based on customer conversation parameters.",
    defaultUrl: "https://n8n.yourdomain.com/webhook/quote-calculator",
    suggestedPrompt: "Compute pricing quotes, delivery estimates, or discounts based on product quantity and dimensions.",
    brandColor: "text-amber-400",
    iconBg: "bg-amber-500/10 border-amber-500/20 text-amber-400",
    supportsMcp: false,
    defaultPermissions: { searchProducts: false, checkStock: false, lookupOrders: false },
  },
  {
    id: "custom_rest",
    name: "custom_rest_webhook",
    title: "Custom REST / n8n Webhook",
    shortDesc: "Connect any external REST endpoint or n8n automation workflow.",
    description: "Connects to any external REST endpoint or n8n workflow to trigger background business logic and return live data.",
    defaultUrl: "https://n8n.yourdomain.com/webhook/ai-agent-tool",
    suggestedPrompt: "Call custom internal workflow to perform actions or lookup specific records.",
    brandColor: "text-cyan-400",
    iconBg: "bg-cyan-500/10 border-cyan-500/20 text-cyan-400",
    supportsMcp: false,
    defaultPermissions: { searchProducts: true, checkStock: false, lookupOrders: false },
  },
  {
    id: "mcp_custom",
    name: "custom_mcp_service",
    title: "Custom MCP Server",
    shortDesc: "Model Context Protocol tools and external agent integrations.",
    description: "Connect any external Model Context Protocol (MCP) server directly into the Postora AI runtime with zero admin approval.",
    defaultUrl: "https://mcp.yourdomain.com/sse",
    suggestedPrompt: "Call Model Context Protocol tools to query real-time enterprise tools and context.",
    brandColor: "text-violet-400",
    iconBg: "bg-violet-500/10 border-violet-500/20 text-violet-400",
    supportsMcp: true,
    mcpServerName: "custom-mcp-server",
    defaultPermissions: { searchProducts: true, checkStock: true, lookupOrders: true },
  },
];

const emptyForm = {
  name: "",
  description: "",
  url: "",
  // Registry-driven credential values keyed by registry field name. Secret
  // fields only ever hold freshly typed text — a stored secret value never
  // enters this state, which is what keeps "blank = keep existing" honest.
  credentials: {} as Record<string, string>,
  is_enabled: true,
  admin_only: false,
  connector_type: "shopify" as ConnectorType,
  // The Composio connection an OAuth-backed tool runs as; null for every
  // manual-credential type (spec §9.1).
  connection_id: null as string | null,
  permission_search_products: true,
  permission_check_stock: true,
  permission_lookup_orders: false,
  read_only_mode: true,
  enable_cache: true,
};

type CategoryFilter = "all" | ConnectorCategory | "mcp";

/** The OAuth-backed types, which have connection cards instead of a directory
 *  entry — their credentials live at Composio, not in this form. */
const COMPOSIO_TYPES = CONNECTOR_TYPES.filter((type) => isComposioType(type));

/** Enough of a directory item to drive the existing tool form for a Composio
 *  type. Everything shown comes from the registry — there is no second
 *  catalogue to keep in step. */
function composioPreset(type: ConnectorType): ConnectorDirectoryItem {
  const definition = connectorDefinition(type);
  const guide = definition.usageGuide?.whenToUse ?? `${definition.label} tools for the AI agent.`;
  return {
    id: type,
    name: `${type}_tools`,
    title: definition.label,
    shortDesc: guide,
    description: guide,
    // No endpoint: a Composio tool executes through its connection, and the
    // server records null for it (toolWrites.ts).
    defaultUrl: "",
    suggestedPrompt: guide,
    brandColor: "text-primary",
    iconBg: "bg-primary/10 border-primary/20 text-primary",
    supportsMcp: false,
    defaultPermissions: { searchProducts: false, checkStock: false, lookupOrders: false },
  };
}

/** The registry's credential fields for a type, or [] should a row predate
 *  the registry — a legacy row must not crash the form, it must simply show
 *  the generic endpoint input like before. */
function safeCredentialFields(type: ConnectorType): Field[] {
  try {
    return connectorDefinition(type).credentials;
  } catch {
    return [];
  }
}

function safeConnectorLabel(type: ConnectorType): string {
  try {
    return connectorDefinition(type).label;
  } catch {
    return type;
  }
}

/** The registry url field whose value also becomes the tool row's url column
 *  (the server still requires one); undefined means the form keeps the
 *  generic "API Endpoint / Webhook URL" input. No type has two url fields
 *  today; the first wins if one ever does. */
function urlCredentialField(type: ConnectorType): Field | undefined {
  return safeCredentialFields(type).find((field) => field.kind === "url");
}

/** Repopulates a non-secret field from `settings`. Arrays (a
 *  table_allow_list can be stored either way) render joined; a url field on a
 *  legacy row falls back to the row url column, which held it before the
 *  settings split existed. */
function settingsValueFor(field: Field, tool: AiAgentTool): string {
  const value = tool.settings?.[field.key];
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string").join(", ");
  }
  if (field.kind === "url" && tool.url) return tool.url;
  return "";
}

/** The first required field with no value, or null. A required secret that is
 *  already stored never counts as missing: blank means "keep existing" on an
 *  existing connector, exactly like the old single-secret form. */
function missingRequiredCredentialField(
  fields: readonly Field[],
  values: Record<string, string>,
  editingTool: AiAgentTool | null,
): Field | null {
  const configuredSecretFields = new Set(editingTool?.configured_secret_fields ?? []);
  for (const field of fields) {
    if (!field.required) continue;
    if ((values[field.key] ?? "").trim() !== "") continue;
    if (field.kind === "secret" && editingTool && configuredSecretFields.has(field.key)) continue;
    return field;
  }
  return null;
}

/** One rendered test-connection outcome: either just probed (live) or the
 *  row's stored last_test_* state. Never carries a credential value. */
interface ConnectionTestView {
  ok: boolean;
  live: boolean;
  text: string;
}

function liveTestView(result: unknown, t: TFunction): ConnectionTestView {
  const record = (result ?? {}) as Record<string, unknown>;
  if (record.ok === true) {
    const capabilities = Array.isArray(record.capabilities) ? record.capabilities.map(String) : [];
    const readOnly = record.read_only !== false;
    const list = capabilities.join(", ");
    if (readOnly && capabilities.length > 0) {
      return { ok: true, live: true, text: t("connectors.test.okReadOnlyCaps", "Connection OK — read-only; capabilities: {{list}}", { list }) };
    }
    if (readOnly) {
      return { ok: true, live: true, text: t("connectors.test.okReadOnly", "Connection OK — read-only") };
    }
    if (capabilities.length > 0) {
      return { ok: true, live: true, text: t("connectors.test.okWriteCaps", "Connection OK — write enabled; capabilities: {{list}}", { list }) };
    }
    return { ok: true, live: true, text: t("connectors.test.okWrite", "Connection OK — write enabled") };
  }
  const error = record.error as { message?: unknown; vendor_status?: unknown } | undefined;
  const message = typeof error?.message === "string" ? error.message : t("errors.connectionTestFailed", "The connection test failed.");
  if (typeof error?.vendor_status === "number") {
    return { ok: false, live: true, text: t("connectors.test.failedVendor", "Test failed — {{message}} (vendor status {{status}})", { message, status: error.vendor_status }) };
  }
  return { ok: false, live: true, text: t("connectors.test.failed", "Test failed — {{message}}", { message }) };
}

function storedTestView(tool: AiAgentTool, t: TFunction): ConnectionTestView | null {
  if (tool.last_test_ok === null || tool.last_test_ok === undefined) return null;
  return tool.last_test_ok
    ? { ok: true, live: false, text: t("connectors.test.lastPassed", "Last test passed") }
    : {
        ok: false,
        live: false,
        text: t("connectors.test.lastFailed", "Last test failed — {{error}}", { error: tool.last_test_error ?? t("errors.unknownError", "unknown error") }),
      };
}

function directoryTitle(id: string, fallback: string, t: TFunction): string {
  switch (id) {
    case "shopify": return t("directory.shopify.title", "Shopify Storefront");
    case "woocommerce": return t("directory.woocommerce.title", "WooCommerce Store");
    case "salla": return t("directory.salla.title", "Salla (سلة)");
    case "zid": return t("directory.zid.title", "Zid (زد)");
    case "myfatoorah": return t("directory.myfatoorah.title", "MyFatoorah");
    case "stripe": return t("directory.stripe.title", "Stripe Payments");
    case "higgsfield": return t("directory.higgsfield.title", "Higgsfield AI Studio");
    case "supabase": return t("directory.supabase.title", "Supabase (PostgreSQL)");
    case "mysql_postgres": return t("directory.mysql.title", "PostgreSQL / MySQL API");
    case "formula": return t("directory.formula.title", "Formulas & Price Calculator");
    case "custom_rest": return t("directory.customRest.title", "Custom REST / n8n Webhook");
    case "mcp_custom": return t("directory.mcp.title", "Custom MCP Server");
    default: return fallback;
  }
}

function directoryShortDesc(id: string, fallback: string, t: TFunction): string {
  switch (id) {
    case "shopify": return t("directory.shopify.shortDesc", "Query products, live inventory, and customer orders via Storefront API.");
    case "woocommerce": return t("directory.woocommerce.shortDesc", "Connect WordPress WooCommerce REST API for live products and orders.");
    case "salla": return t("directory.salla.shortDesc", "Connect Salla Merchant API for Middle East e-commerce stores.");
    case "zid": return t("directory.zid.shortDesc", "Connect Zid Merchant API for product search and order tracking.");
    case "myfatoorah": return t("directory.myfatoorah.shortDesc", "Payment gateway status, invoice queries, and payment link generator.");
    case "stripe": return t("directory.stripe.shortDesc", "Query customer invoices, payment intents, and subscription status.");
    case "higgsfield": return t("directory.higgsfield.shortDesc", "BYO generation for AI video, character sheets, and image creation.");
    case "supabase": return t("directory.supabase.shortDesc", "Direct REST / RPC connection to your Supabase PostgreSQL tables.");
    case "mysql_postgres": return t("directory.mysql.shortDesc", "Query custom SQL databases via Prisma, Hasura, or PostgREST.");
    case "formula": return t("directory.formula.shortDesc", "Compute custom quotes, shipping costs, and volume discounts.");
    case "custom_rest": return t("directory.customRest.shortDesc", "Connect any external REST endpoint or n8n automation workflow.");
    case "mcp_custom": return t("directory.mcp.shortDesc", "Model Context Protocol tools and external agent integrations.");
    default: return fallback;
  }
}

function directoryDescription(id: string, fallback: string, t: TFunction): string {
  switch (id) {
    case "shopify": return t("directory.shopify.description", "Official Shopify integration for automated product catalog lookups, collection browsing, stock verification, and order fulfillment status.");
    case "woocommerce": return t("directory.woocommerce.description", "Official WooCommerce REST API connector to query products, variations, live prices, stock levels, and order history directly in customer chats.");
    case "salla": return t("directory.salla.description", "Seamless integration with Salla Merchant API for Saudi & Middle East e-commerce stores to query products, prices, and shipping status.");
    case "zid": return t("directory.zid.description", "Direct integration with Zid Store Manager API for product catalog inquiries, inventory levels, and customer order management.");
    case "myfatoorah": return t("directory.myfatoorah.description", "MyFatoorah payment gateway integration to check payment status, lookup customer invoices, and generate instant checkout payment links.");
    case "stripe": return t("directory.stripe.description", "Connect to Stripe API to look up customer payment status, invoice details, and active subscriptions in customer support chats.");
    case "higgsfield": return t("directory.higgsfield.description", "Connect your personal Higgsfield account. BYO generation bills Higgsfield directly and does not consume your Postora plan quota.");
    case "supabase": return t("directory.supabase.description", "Direct REST / PostgREST connection to query your Supabase database tables for products, inventory, customer records, and custom RPC functions.");
    case "mysql_postgres": return t("directory.mysql.description", "Connect to custom SQL databases through Prisma, Hasura, Directus, or PostgREST for structured schema queries.");
    case "formula": return t("directory.formula.description", "Computes custom quotes, delivery fees, bulk tier discounts, or VAT calculations based on customer conversation parameters.");
    case "custom_rest": return t("directory.customRest.description", "Connects to any external REST endpoint or n8n workflow to trigger background business logic and return live data.");
    case "mcp_custom": return t("directory.mcp.description", "Connect any external Model Context Protocol (MCP) server directly into the Postora AI runtime with zero admin approval.");
    default: return fallback;
  }
}

function categoryLabel(key: string, fallback: string, t: TFunction): string {
  switch (key) {
    case "ecommerce_payments": return t("category.ecommerce", "E-Commerce & Payments");
    case "productivity_crm": return t("category.productivity", "Productivity & Apps");
    case "databases": return t("category.databases", "Databases");
    case "automation": return t("category.automation", "Automation");
    default: return fallback;
  }
}

function useSafeProfile() {
  try {
    const auth = useAuth();
    return auth?.profile || null;
  } catch {
    return null;
  }
}

function ConnectorCredentialState({ tool }: { tool: AiAgentTool }) {
  const { t } = useTranslation("automation");
  const secretFields = connectorDefinition(tool.connector_type).credentials.filter(
    (field) => field.kind === "secret",
  );
  if (secretFields.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
      {secretFields.map((field) => {
        const configured = (tool.configured_secret_fields ?? []).includes(field.key);
        return (
          <span key={field.key} className="rounded-md border border-border/60 px-2 py-1">
            {configured
              ? t("connectors.secret.set", "{{field}} ✓ set", { field: field.label })
              : t("connectors.secret.notSet", "{{field}} not set", { field: field.label })}
          </span>
        );
      })}
    </div>
  );
}

/** Per-card Test connection control. The button exists only for types with a
 *  live adapter (derived from the registry, never a hardcoded type list);
 *  types without one get a calm indicator instead of a dead button. In-flight
 *  state is per tool id, so testing one connector never freezes another. */
function ConnectorTestState({
  tool,
  testing,
  view,
  onTest,
}: {
  tool: AiAgentTool;
  testing: boolean;
  view: ConnectionTestView | null;
  onTest: () => void;
}) {
  const { t } = useTranslation("automation");
  const hasAdapter = shouldUseAdapter(tool);
  return (
    <div className="space-y-2 border-t border-border/40 pt-3">
      {hasAdapter ? (
        <Button
          size="sm"
          variant="outline"
          data-testid={`test-connection-${tool.id}`}
          onClick={onTest}
          disabled={testing}
          className="h-8 text-xs gap-1.5 cursor-pointer"
        >
          {testing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Radio className="w-3.5 h-3.5" />}
          {t("actions.testConnection", "Test connection")}
        </Button>
      ) : (
        <p className="text-[11px] text-muted-foreground" data-testid={`no-adapter-${tool.id}`}>
          {t("connectors.noAdapter", "{{label}} — no adapter yet", { label: safeConnectorLabel(tool.connector_type) })}
        </p>
      )}
      {view && (
        <div
          data-testid={`test-result-${view.ok ? "ok" : "error"}-${tool.id}`}
          className={cn(
            "rounded-lg border px-2.5 py-2 text-[11px]",
            view.ok
              ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-400"
              : "border-destructive/30 bg-destructive/10 text-destructive",
          )}
        >
          {view.text}
        </div>
      )}
    </div>
  );
}

function DatabaseConnectorsOverview({
  tools,
  isLoading,
}: Pick<ReturnType<typeof useAiAgentTools>, "tools" | "isLoading">) {
  const { t } = useTranslation("automation");
  const { links, linksReady, linksError } = useAiToolAccountLinks();
  const {
    data: socialAccounts = [],
    isSuccess: accountsReady,
    error: accountsError,
  } = useSocialAccounts();
  const shareAccounts = useMemo(() => agentAccounts(socialAccounts), [socialAccounts]);
  const accountsById = useMemo(
    () => new Map(socialAccounts.map((account) => [account.id, account])),
    [socialAccounts],
  );
  const groupedTools = useMemo(() => {
    const groups = new Map<string, AiAgentTool[]>();
    for (const tool of tools) {
      const key = tool.social_account_id ?? "all";
      groups.set(key, [...(groups.get(key) ?? []), tool]);
    }
    return [...groups.entries()];
  }, [tools]);
  // Connections are workspace-level, and this surface has no account
  // selection, so they belong to the signed-in user's personal workspace.
  const { workspaceId } = useConnectorWorkspace(null);

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div>
        <h3 className="text-xl font-bold text-foreground">{t("header.overview", "Connector overview")}</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("connectors.overviewHint", "Every connector by owning account. Open its agent Tools tab to change configuration or sharing.")}
        </p>
      </div>

      {(accountsError || linksError) && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          {t("errors.sharingUnknown", "Connector sharing could not be loaded, so account access is shown as unknown. Refresh to try again.")}
        </p>
      )}

      {/* Connections are the credential, so they live here — one card per
          OAuth-backed app, grouped by the registry's categories (spec §9.1).
          readOnly hides the tool form, never the connection controls. */}
      {CATEGORY_TABS.filter((tab) => COMPOSIO_TYPES.some((type) => connectorDefinition(type).category === tab.key)).map((tab) => (
        <section key={tab.key} className="space-y-3">
          <h4 className="font-semibold">{categoryLabel(tab.key, tab.label, t)}</h4>
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            {COMPOSIO_TYPES.filter((type) => connectorDefinition(type).category === tab.key).map((type) => (
              <ComposioConnectCard key={type} connectorType={type} workspaceId={workspaceId} />
            ))}
          </div>
        </section>
      ))}

      {groupedTools.length === 0 ? (
        <Card className="border-dashed">
          <CardContent className="py-10 text-center text-sm text-muted-foreground">
            {t("empty.noConnectors", "No connectors configured yet.")}
          </CardContent>
        </Card>
      ) : (
        groupedTools.map(([ownerId, accountTools]) => {
          const owner = ownerId === "all" ? null : accountsById.get(ownerId);
          return (
            <section
              key={ownerId}
              data-testid={`overview-account-${ownerId}`}
              className="space-y-3 rounded-2xl border border-border/60 bg-card/40 p-4"
            >
              <div className="flex items-center gap-2">
                {owner && <PlatformIcon platform={owner.platform} size="sm" />}
                <h4 className="font-semibold">
                  {owner ? accountLabel(owner) : t("connectors.allAccountsLegacy", "All accounts (legacy)")}
                </h4>
              </div>
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
                {accountTools.map((tool) => {
                  const usableIds =
                    linksReady && accountsReady
                      ? effectiveToolAccountIds(tool, shareAccounts, links)
                      : null;
                  return (
                    <Card key={tool.id} data-testid={`tool-card-${tool.id}`}>
                      <CardHeader className="pb-3">
                        <div className="flex items-start justify-between gap-3">
                          <div>
                            <CardTitle className="font-mono text-sm">{tool.name}</CardTitle>
                            <CardDescription>{connectorDefinition(tool.connector_type).label}</CardDescription>
                          </div>
                          <Badge variant="outline">
                            {tool.scope === "all_accounts" ? t("connectors.scopeAll", "All accounts") : t("connectors.scopeShares", "Account + shares")}
                          </Badge>
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-3">
                        <p className="text-xs text-muted-foreground">
                          {t("connectors.agentsThatCanUse", "Agents that can use this: {{list}}", {
                            list: usableIds === null
                              ? t("common:unknown", "Unknown")
                              : usableIds
                                  .flatMap((id) => {
                                    const account = accountsById.get(id);
                                    return account ? [accountLabel(account)] : [];
                                  })
                                  .join(", ") || t("common:none", "None"),
                          })}
                        </p>
                        <ConnectorCredentialState tool={tool} />
                        <ToolUsageLine accountId={tool.social_account_id} toolId={tool.id} />
                        {owner && (
                          <Link
                            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
                            to={`/automation/agents?platform=${owner.platform}&tab=tools&account=${owner.id}`}
                          >
                            {t("common:edit", "Edit")} <ExternalLink className="h-3.5 w-3.5" />
                          </Link>
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            </section>
          );
        })
      )}
    </div>
  );
}

interface DatabaseConnectorsManagerProps {
  /** Platform of the agent tab this manager sits in. Drives the account
   *  dropdown exactly like AiAgentManager's own selector. */
  platform?: AiAgentPlatform;
  /** Controlled account selection (the agent tab's shared selection). */
  accountId?: string | null;
  onAccountIdChange?: (accountId: string) => void;
  /** §14: Settings is an overview, not an account-less write surface. */
  readOnly?: boolean;
}

export function DatabaseConnectorsManager(props: DatabaseConnectorsManagerProps = {}) {
  const toolState = useAiAgentTools();
  if (props.readOnly) return <DatabaseConnectorsOverview {...toolState} />;

  // The two historical directory tests supply the old, unscoped row shape and
  // no AuthProvider. Keeping that read-only compatibility render separate means
  // the real scoped surface never catches auth errors or fabricates link data.
  const hasScopedContext =
    props.platform !== undefined ||
    props.accountId !== undefined ||
    toolState.tools.some((tool) => "social_account_id" in tool && "scope" in tool);
  if (!hasScopedContext) {
    return (
      <DatabaseConnectorsEditor
        {...props}
        toolState={toolState}
        linkState={{ links: [], linksReady: false, linksError: null }}
        accountState={{ socialAccounts: [], accountsReady: true, accountsError: null }}
      />
    );
  }
  return <ScopedDatabaseConnectorsEditor {...props} toolState={toolState} />;
}

function ScopedDatabaseConnectorsEditor({
  toolState,
  ...props
}: Omit<DatabaseConnectorsManagerProps, "readOnly"> & {
  toolState: ReturnType<typeof useAiAgentTools>;
}) {
  const linkState = useAiToolAccountLinks();
  const accountQuery = useSocialAccounts();
  return (
    <DatabaseConnectorsEditor
      {...props}
      toolState={toolState}
      linkState={linkState}
      accountState={{
        socialAccounts: accountQuery.data ?? [],
        accountsReady: accountQuery.isSuccess,
        accountsError: accountQuery.error,
      }}
    />
  );
}

function DatabaseConnectorsEditor({
  platform,
  accountId: accountIdProp,
  onAccountIdChange,
  toolState,
  linkState,
  accountState,
}: Omit<DatabaseConnectorsManagerProps, "readOnly"> & {
  toolState: ReturnType<typeof useAiAgentTools>;
  linkState: {
    links: ToolAccountLink[];
    linksReady: boolean;
    linksError: unknown;
    setToolAccounts?: ReturnType<typeof useAiToolAccountLinks>["setToolAccounts"];
  };
  accountState: {
    socialAccounts: Array<SharingAccount & { is_active?: boolean }>;
    accountsReady: boolean;
    accountsError: unknown;
  };
}) {
  const { t } = useTranslation("automation");
  const profile = useSafeProfile();
  const { tools, isLoading, upsertTool, deleteTool } = toolState;
  const { links, linksReady, linksError, setToolAccounts } = linkState;
  const { socialAccounts, accountsReady, accountsError } = accountState;
  const [dialogOpen, setDialogOpen] = useState(false);
  const [selectedPreset, setSelectedPreset] = useState<ConnectorDirectoryItem | null>(null);
  const [editingTool, setEditingTool] = useState<AiAgentTool | null>(null);
  const [editingHasSecret, setEditingHasSecret] = useState(false);
  const [clearSecret, setClearSecret] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeCategory, setActiveCategory] = useState<CategoryFilter>("all");
  const [modalTab, setModalTab] = useState<"credentials" | "mcp" | "overview">("credentials");
  const [copiedMcp, setCopiedMcp] = useState(false);
  // Which connector a write is in flight for, so only its own strip disables.
  const [sharingToolIds, setSharingToolIds] = useState<readonly string[]>([]);
  // Per-connector test_connection state: in-flight ids and the latest probe
  // outcome shown on the card. Stored last_test_* covers cards before their
  // first click; these cover everything after.
  const [testingToolIds, setTestingToolIds] = useState<readonly string[]>([]);
  const [testResultViews, setTestResultViews] = useState<Record<string, ConnectionTestView>>({});

  // Every connected account that can actually run an agent — the checkbox
  // strip is cross-platform on purpose: sharing a WhatsApp-owned catalogue
  // with an Instagram page is the whole point (spec §12).
  const shareAccounts = useMemo(() => agentAccounts(socialAccounts), [socialAccounts]);
  // The dropdown offers the platform's active accounts (or every agent
  // account when no platform is named) — same rule as the agent settings tab.
  const selectableAccounts = useMemo(
    () =>
      platform
        ? socialAccounts.filter(
            (account) => account.platform === platform && account.is_active,
          )
        : shareAccounts,
    [socialAccounts, platform, shareAccounts],
  );
  // Same selection pattern as AiAgentManager: a remembered choice until the
  // user changes it, never an id that is not in the list (a disconnected
  // account must deselect itself, not linger). Controlled when the agent tab
  // passes its own selection down.
  const [ownSelectedAccountId, setOwnSelectedAccountId] = useState<string | null>(null);
  const accountId = useMemo(() => {
    if (accountIdProp !== undefined) {
      // Controlled: honour the agent tab's selection. An id that vanished
      // from the list becomes null — a save must refuse, not guess an owner.
      return selectableAccounts.some((account) => account.id === accountIdProp)
        ? accountIdProp
        : null;
    }
    const remembered = ownSelectedAccountId;
    if (remembered && selectableAccounts.some((account) => account.id === remembered)) {
      return remembered;
    }
    return selectableAccounts[0]?.id ?? null;
  }, [accountIdProp, ownSelectedAccountId, selectableAccounts]);
  // Every connector THIS account's agent can use, not only the ones it owns.
  //
  // The sharing model already said so on both sides — the checkbox strip
  // writes ai_agent_tool_accounts rows, and ai-agent-reply resolves them
  // through resolveToolsForAccount — but this list filtered on ownership
  // alone, so a connector shared from WhatsApp to a Facebook page stayed
  // invisible on Facebook's Tools tab while its agent was already calling it.
  // effectiveToolAccountIds is the same helper the strip renders from, so the
  // list and the ticks can no longer disagree.
  //
  // Until the links and accounts have actually arrived, fall back to owned
  // only. An empty link set from an unsettled read is indistinguishable from
  // "shared with nobody"; the knowledge panel shows everything while it waits,
  // but here "everything" would be other accounts' connectors, so this waits
  // on today's behaviour instead and widens once the links land.
  const accountTools = useMemo(() => {
    if (!accountId) {
      return tools.filter(
        (tool) => tool.social_account_id === null || tool.social_account_id === undefined,
      );
    }
    if (!linksReady || !accountsReady) {
      return tools.filter((tool) => tool.social_account_id === accountId);
    }
    return tools.filter((tool) =>
      effectiveToolAccountIds(tool, shareAccounts, links).includes(accountId),
    );
  }, [tools, accountId, linksReady, accountsReady, shareAccounts, links]);

  // Composio connections and usage are workspace-level; the workspace is the
  // selected account's, so switching accounts switches both.
  const { workspaceId, isLoading: workspaceLoading } = useConnectorWorkspace(accountId);

  // Higgsfield OAuth State
  const [higgsfieldConnected, setHiggsfieldConnected] = useState(false);
  const [higgsfieldAccount, setHiggsfieldAccount] = useState<string | null>(null);
  const [higgsfieldBusy, setHiggsfieldBusy] = useState(false);

  const checkHiggsfieldStatus = useCallback(async () => {
    try {
      const { data, error } = await supabase.functions.invoke("higgsfield-oauth", {
        body: { action: "status", scope_kind: "user" },
      });
      if (!error && data) {
        const user = data?.user ?? data;
        setHiggsfieldConnected(!!(data?.connected ?? user?.connected));
        setHiggsfieldAccount(user?.account_email ?? data?.account_id ?? null);
      }
    } catch {
      setHiggsfieldConnected(false);
      setHiggsfieldAccount(null);
    }
  }, []);

  useEffect(() => {
    void checkHiggsfieldStatus();
  }, [checkHiggsfieldStatus]);

  const connectHiggsfield = async () => {
    setHiggsfieldBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke("higgsfield-oauth", {
        body: {
          action: "authorize_url",
          scope_kind: "user",
          redirect_uri: `${window.location.origin}${HIGGSFIELD_CALLBACK_PATH}`,
          return_to: "/settings?tab=integrations",
        },
      });
      if (error || !data?.url) throw error ?? new Error(data?.error || t("errors.authUrl", "Could not retrieve authorization URL"));
      window.location.assign(data.url);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : t("toast.higgsfieldStartFailed", "Failed to initiate Higgsfield connection"));
      setHiggsfieldBusy(false);
    }
  };

  const disconnectHiggsfield = async () => {
    setHiggsfieldBusy(true);
    try {
      await supabase.functions.invoke("higgsfield-oauth", {
        body: { action: "disconnect", scope_kind: "user" },
      });
      setHiggsfieldConnected(false);
      setHiggsfieldAccount(null);
      toast.success(t("toast.higgsfieldDisconnected", "Higgsfield account disconnected"));
      setDialogOpen(false);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : t("toast.higgsfieldDisconnectFailed", "Failed to disconnect Higgsfield"));
    } finally {
      setHiggsfieldBusy(false);
    }
  };

  const queryClient = useQueryClient();

  // Inbound OAuth Authorized Applications query (e.g. n8n, Zapier, Make)
  const { data: oauthClients = [] } = useQuery({
    queryKey: ["oauth-authorized-clients"],
    enabled: true,
    queryFn: async () => {
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const accessToken = sessionData?.session?.access_token;
        if (!accessToken) return [];

        const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
        const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

        const res = await fetch(`${SUPABASE_URL}/auth/v1/oauth/authorized-clients`, {
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${accessToken}`,
          },
        });

        if (!res.ok) return [];
        return (await res.json()) as Array<{
          id: string;
          name: string;
          icon?: string;
          scopes?: string[];
          created_at?: string;
          authorized_at?: string;
        }>;
      } catch {
        return [];
      }
    },
  });

  const handleRevokeOAuth = async (clientId: string, clientName: string) => {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      if (!accessToken) return;

      const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
      const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

      const res = await fetch(`${SUPABASE_URL}/auth/v1/oauth/authorized-clients/${clientId}`, {
        method: "DELETE",
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${accessToken}`,
        },
      });

      if (res.ok) {
        toast.success(t("toast.revokedAccess", "Revoked access for {{name}}", { name: clientName }));
        queryClient.invalidateQueries({ queryKey: ["oauth-authorized-clients"] });
      }
    } catch {
      toast.error(t("toast.revokeFailed", "Failed to revoke OAuth access"));
    }
  };

  const apiKey = profile?.api_key || "YOUR_POSTORA_API_KEY";

  // Rows are identified by tool id. Connector type is not unique once one
  // account owns two WooCommerce stores (spec §9.1 item 3).
  const configuredToolsMap = useMemo(() => {
    const map = new Map<string, AiAgentTool>();
    for (const tool of tools) {
      map.set(tool.id, tool);
    }
    return map;
  }, [tools]);

  const accountsById = useMemo(
    () => new Map(socialAccounts.map((account) => [account.id, account])),
    [socialAccounts],
  );

  /**
   * Whether the selected account OWNS this connector, as opposed to merely
   * being allowed to use it.
   *
   * Ownership is what decides who may edit: upsertAccountScopedTool matches an
   * existing row by (user_id, social_account_id, name), so saving a shared
   * connector under the viewing account would INSERT a second row and trip the
   * legacy UNIQUE (user_id, name); for a Composio-backed connector it would
   * also 403 `connection_forbidden`, because the connection lives in the
   * owner's workspace, not this one. A legacy scope='all_accounts' row owns
   * nothing at all (social_account_id is null) and is never editable here.
   */
  const isOwnedHere = useCallback(
    (tool: AiAgentTool) =>
      tool.scope !== "all_accounts" &&
      !!tool.social_account_id &&
      tool.social_account_id === accountId,
    [accountId],
  );

  // Two lookups, because "this account can use one" and "this account can edit
  // one" are different questions once a connector can be shared in.
  //
  // The directory tile asks the first: a Supabase connector shared from
  // WhatsApp makes Facebook's Supabase tile Connected, which is the whole
  // point of sharing it. The edit form asks the second, and an owned row wins
  // over a shared one of the same type — opening a shared row's form here
  // would list the WRONG workspace's Composio connections, since the picker
  // reads the selected account's workspace and the connection lives in the
  // owner's.
  const ownedByType = useCallback(
    (connectorType: string) =>
      accountTools.find(
        (candidate) => candidate.connector_type === connectorType && isOwnedHere(candidate),
      ),
    [accountTools, isOwnedHere],
  );
  const usableByType = useCallback(
    (connectorType: string) =>
      ownedByType(connectorType)
      ?? accountTools.find((candidate) => candidate.connector_type === connectorType),
    [accountTools, ownedByType],
  );

  const sharedByTool = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const tool of accountTools) {
      map.set(tool.id, effectiveToolAccountIds(tool, shareAccounts, links));
    }
    return map;
  }, [accountTools, shareAccounts, links]);

  // Filtered directory items
  const filteredDirectory = useMemo(() => {
    return CONNECTOR_DIRECTORY.filter((item) => {
      const matchesSearch =
        searchQuery.trim() === "" ||
        item.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.shortDesc.toLowerCase().includes(searchQuery.toLowerCase()) ||
        CONNECTOR_CATEGORY_LABELS[connectorDefinition(item.id).category]
          .toLowerCase()
          .includes(searchQuery.toLowerCase());

      if (!matchesSearch) return false;

      if (activeCategory === "all") return true;
      if (activeCategory === "mcp") return item.supportsMcp;
      return connectorDefinition(item.id).category === activeCategory;
    });
  }, [searchQuery, activeCategory]);

  // The OAuth-backed apps sit beside the directory under the same search and
  // category filter. They have no directory entry: there is nothing to
  // configure until a connection exists.
  const filteredComposioTypes = useMemo(() => {
    const query = searchQuery.trim().toLowerCase();
    return COMPOSIO_TYPES.filter((type) => {
      const definition = connectorDefinition(type);
      const matchesSearch =
        query === "" ||
        definition.label.toLowerCase().includes(query) ||
        CONNECTOR_CATEGORY_LABELS[definition.category].toLowerCase().includes(query);
      if (!matchesSearch) return false;
      if (activeCategory === "all") return true;
      if (activeCategory === "mcp") return false;
      return definition.category === activeCategory;
    });
  }, [searchQuery, activeCategory]);

  const handleCardClick = (preset: ConnectorDirectoryItem, tool?: AiAgentTool) => {
    if (preset.id === "higgsfield" && !higgsfieldConnected) {
      // Direct 1-click connect flow for Higgsfield
      setSelectedPreset(preset);
      setDialogOpen(true);
      return;
    }

    const existingTool = tool ?? ownedByType(preset.id);
    setSelectedPreset(preset);
    setFormError(null);

    if (existingTool) {
      setEditingTool(existingTool);
      const fields = safeCredentialFields(existingTool.connector_type);
      const credentials: Record<string, string> = {};
      for (const field of fields) {
        // Secret inputs start blank: the server never returns a stored value,
        // and blank means "keep existing". Non-secret values repopulate from
        // settings (with the legacy url fallback).
        if (field.kind !== "secret") {
          credentials[field.key] = settingsValueFor(field, existingTool);
        }
      }
      setForm({
        name: existingTool.name,
        description: existingTool.description,
        url: existingTool.url || "",
        credentials,
        is_enabled: existingTool.is_enabled,
        admin_only: existingTool.admin_only,
        connector_type: existingTool.connector_type,
        connection_id: existingTool.connection_id ?? null,
        permission_search_products: existingTool.permissions?.search_products ?? false,
        permission_check_stock: existingTool.permissions?.check_stock ?? false,
        permission_lookup_orders: existingTool.permissions?.lookup_orders ?? false,
        read_only_mode: existingTool.read_only_mode,
        enable_cache: existingTool.enable_cache,
      });
      setEditingHasSecret(existingTool.has_secret);
    } else {
      setEditingTool(null);
      setForm({
        name: preset.name,
        description: preset.suggestedPrompt,
        url: preset.defaultUrl,
        credentials: {},
        is_enabled: true,
        admin_only: false,
        connector_type: preset.id,
        connection_id: null,
        permission_search_products: preset.defaultPermissions.searchProducts,
        permission_check_stock: preset.defaultPermissions.checkStock,
        permission_lookup_orders: preset.defaultPermissions.lookupOrders,
        read_only_mode: true,
        enable_cache: true,
      });
      setEditingHasSecret(false);
    }

    setClearSecret(false);
    setModalTab("credentials");
    setDialogOpen(true);
  };

  const handleSave = () => {
    if (!accountId) {
      setFormError(t("errors.selectAccountFirst", "Select an account before connecting this tool."));
      return;
    }
    const fields = safeCredentialFields(form.connector_type);
    const composio = isComposioType(form.connector_type);
    // A Composio tool has no credentials to check; what it needs is a live
    // connection, and the server refuses the write without one
    // (`connection_required`). Say so here rather than letting a URL error
    // stand in for it.
    if (composio && !form.connection_id) {
      setFormError(t("errors.chooseConnectedAccount", "Choose a connected {{label}} account before saving this tool.", { label: safeConnectorLabel(form.connector_type) }));
      return;
    }
    // When the registry declares a url credential field it IS the endpoint
    // (one source of truth); otherwise the generic endpoint input supplies it.
    // A Composio tool has none — the server ignores the field and stores null.
    const rowUrlField = urlCredentialField(form.connector_type);
    const rowUrl = (composio
      ? ""
      : rowUrlField
      ? form.credentials[rowUrlField.key] ?? ""
      : form.url).trim();

    // Required-field check first, so a blank registry field names itself
    // ("Store URL is required.") instead of the derived url failing a generic
    // format check.
    const missingField = missingRequiredCredentialField(
      safeCredentialFields(form.connector_type),
      form.credentials,
      editingTool,
    );
    if (missingField) {
      setFormError(t("errors.fieldRequired", "{{field}} is required.", { field: missingField.label }));
      return;
    }

    const error =
      validateAiToolName(form.name) ||
      (composio ? null : validateAiToolUrl(rowUrl)) ||
      (form.description.trim() ? null : t("errors.descriptionRequired", "Description is required — the AI uses it to decide when to call the tool."));
    if (error) {
      setFormError(error);
      return;
    }

    // Only non-blank values are submitted: an omitted key keeps whatever the
    // server already holds, for both the settings merge and the Vault merge.
    //
    // That merge makes clearing a field impossible on its own, because a blank
    // value is simply dropped and the old one survives. Two Supabase settings
    // need a real "off": a stale max_rows keeps returning more rows than the
    // operator now wants, and a stale column_map keeps restricting tables they
    // meant to release. Both have a value that means "unset", so a cleared
    // field is submitted as that rather than omitted.
    const CLEARED_SENTINELS: Record<string, string> = {
      max_rows: "0",
      page_size: "0",
      column_map: "{}",
      // "-" cannot be a column name, so it unambiguously means "no ordering".
      order_by: "-",
    };
    const credentials: Record<string, string> = {};
    for (const field of fields) {
      const value = (form.credentials[field.key] ?? "").trim();
      if (value !== "") {
        credentials[field.key] = value;
      } else if (field.key in CLEARED_SENTINELS && editingTool) {
        credentials[field.key] = CLEARED_SENTINELS[field.key];
      }
    }

    const payload: AiAgentToolInput = {
      name: form.name,
      description: form.description,
      url: rowUrl,
      // The row's OWN owner when editing, the selected account only when
      // creating. The server matches an existing row by (user_id,
      // social_account_id, name), so naming any other account turns an update
      // into a second row; an edit must never reparent a connector.
      social_account_id: editingTool?.social_account_id ?? accountId,
      is_enabled: form.is_enabled,
      admin_only: form.admin_only,
      connector_type: form.connector_type,
      connection_id: composio ? form.connection_id : null,
      credentials,
      permissions: {
        search_products: form.permission_search_products,
        check_stock: form.permission_check_stock,
        lookup_orders: form.permission_lookup_orders,
      },
      read_only_mode: form.read_only_mode,
      enable_cache: form.enable_cache,
    };

    // Only the legacy-column removal remains of the old secret path: setting
    // and replacing secrets now travels inside `credentials`, and the server
    // dual-writes the custom_rest secret column itself.
    if (editingTool && editingHasSecret && clearSecret) {
      payload.clear_secret = true;
    }

    upsertTool.mutate(payload, {
      onSuccess: () => {
        toast.success(editingTool ? t("toast.connectorUpdated", "Connector updated successfully") : t("toast.connectorConnected", "Connector connected to Postora AI runtime"));
        setDialogOpen(false);
      },
      onError: (mutationError) => setFormError(mutationError.message),
    });
  };

  const runConnectionTest = async (tool: AiAgentTool) => {
    if (testingToolIds.includes(tool.id)) return;
    setTestingToolIds((current) => [...current, tool.id]);
    try {
      const result = await callEdgeApi("ai-agent-adapters", "test_connection", {
        tool_id: tool.id,
      });
      setTestResultViews((current) => ({ ...current, [tool.id]: liveTestView(result, t) }));
      // The adapter persists last_test_* on the row; a refetch keeps every
      // other surface (the Settings overview included) agreeing with the card.
      void queryClient.invalidateQueries({ queryKey: ["ai-agent-tools"] });
    } catch (error) {
      setTestResultViews((current) => ({
        ...current,
        [tool.id]: {
          ok: false,
          live: true,
          text: t("connectors.test.failed", "Test failed — {{message}}", { message: error instanceof Error ? error.message : t("errors.connectionTestFailed", "The connection test failed.") }),
        },
      }));
    } finally {
      setTestingToolIds((current) => current.filter((id) => id !== tool.id));
    }
  };

  const toggleToolShare = async (
    tool: AiAgentTool,
    target: SharingAccount,
    checked: boolean,
  ) => {
    if (!setToolAccounts) {
      toast.error(t("toast.sharingUnavailable", "Connector sharing is unavailable until account data has loaded."));
      return;
    }
    const socialAccountIds = nextToolSharing({
      tool,
      accounts: shareAccounts,
      links,
      accountId: target.id,
      checked,
    });
    setSharingToolIds((current) => [...current, tool.id]);
    try {
      await setToolAccounts.mutateAsync({ toolId: tool.id, socialAccountIds });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("toast.sharingChangeFailed", "Connector sharing could not be changed"));
    } finally {
      setSharingToolIds((current) => current.filter((id) => id !== tool.id));
    }
  };

  const handleMcpInstantActivate = () => {
    if (!selectedPreset) return;
    const urlField = urlCredentialField(selectedPreset.id);
    setForm((prev) => ({
      ...prev,
      name: selectedPreset.name,
      description: selectedPreset.suggestedPrompt,
      url: selectedPreset.defaultUrl,
      is_enabled: true,
      connector_type: selectedPreset.id,
      // Prefill the registry's url field so the form shows the endpoint the
      // old single-url flow used to seed; required secrets still block the
      // save until they are provided.
      credentials: urlField && (prev.credentials[urlField.key] ?? "").trim() === ""
        ? { ...prev.credentials, [urlField.key]: selectedPreset.defaultUrl }
        : prev.credentials,
    }));

    handleSave();
  };

  const mcpConfigSnippet = useMemo(() => {
    if (!selectedPreset) return "";
    const serverName = selectedPreset.mcpServerName || `${selectedPreset.id}-mcp-server`;
    return JSON.stringify(
      {
        mcpServers: {
          [serverName]: {
            url: selectedPreset.defaultUrl,
            transport: "sse",
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "X-Postora-Tenant": profile?.id || "user",
            },
          },
        },
      },
      null,
      2
    );
  }, [selectedPreset, apiKey, profile]);

  const copyMcpConfig = () => {
    navigator.clipboard.writeText(mcpConfigSnippet);
    setCopiedMcp(true);
    toast.success(t("toast.mcpCopied", "MCP configuration copied to clipboard"));
    setTimeout(() => setCopiedMcp(false), 2000);
  };

  // Connected count
  const connectedCount = accountTools.length + (higgsfieldConnected ? 1 : 0) + (oauthClients?.length || 0);

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Directory Section */}
      <div className="space-y-6">
        {/* Header & Description */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <h3 className="text-xl font-bold text-foreground">{t("header.directory", "Integrations & Connectors Directory")}</h3>
              <Badge variant="outline" className="border-primary/30 text-primary bg-primary/10 text-xs gap-1">
                <Sparkles className="w-3 h-3" /> {t("connectors.mcpReadyBadge", "Auto-Approved & MCP Ready")}
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              {t("connectors.directoryHint", "Connect your e-commerce stores, payment gateways, databases, and AI generation servers with authentic brand tools.")}
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              onClick={() => {
                const mcpPreset = CONNECTOR_DIRECTORY.find((p) => p.id === "mcp_custom");
                if (mcpPreset) handleCardClick(mcpPreset);
              }}
              className="gap-1.5"
            >
              <Plus className="h-4 w-4" />
              <span>{t("actions.customWebhook", "Custom Webhook")}</span>
            </Button>
          </div>
        </div>

        {accountsError ? (
          <p className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {t("errors.loadAccounts", "Could not load your connected accounts. Connector configuration is unavailable until the list reloads.")}
          </p>
        ) : (
          accountsReady && selectableAccounts.length > 0 && (
            <div className="max-w-xs space-y-1.5">
              <Label className="text-xs">{t("form.connectorAccount", "Connector account")}</Label>
              <Select
                value={accountId ?? ""}
                onValueChange={(nextAccountId) => {
                  setOwnSelectedAccountId(nextAccountId);
                  onAccountIdChange?.(nextAccountId);
                }}
              >
                <SelectTrigger data-testid="connector-account">
                  <SelectValue placeholder={t("form.selectAccount", "Select account")} />
                </SelectTrigger>
                <SelectContent>
                  {selectableAccounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {accountLabel(account)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )
        )}

        {/* Filter and Search Bar */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-1">
          {/* Category Pills */}
          <div
            data-testid="connector-category-tabs"
            className="flex items-center gap-1.5 overflow-x-auto w-full sm:w-auto pb-1 sm:pb-0 scrollbar-none"
          >
            {([
              { id: "all" as CategoryFilter, label: t("connectors.allConnectors", "All Connectors") },
              ...CATEGORY_TABS.map((tab) => ({ id: tab.key as CategoryFilter, label: categoryLabel(tab.key, tab.label, t) })),
              { id: "mcp" as CategoryFilter, label: t("connectors.mcpReady", "⚡ MCP Ready") },
            ]).map((cat) => {
              const isActive = activeCategory === cat.id;
              return (
                <button
                  key={cat.id}
                  type="button"
                  onClick={() => setActiveCategory(cat.id)}
                  className={cn(
                    "px-3.5 py-1.5 rounded-xl text-xs font-medium transition-all shrink-0 cursor-pointer border",
                    isActive
                      ? "bg-primary text-primary-foreground border-primary shadow-sm"
                      : "bg-muted/40 hover:bg-muted text-muted-foreground hover:text-foreground border-border/50"
                  )}
                >
                  {cat.label}
                </button>
              );
            })}
          </div>

          {/* Search Bar */}
          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 text-muted-foreground absolute start-3 top-1/2 -translate-y-1/2" />
            <Input
              placeholder={t("form.searchConnectors", "Search connectors...")}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="ps-9 h-9 text-xs rounded-xl bg-card/60"
            />
          </div>
        </div>

        {/* Connectors Grid (3D Brand Cards with Logo on Left and Text on Right) */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filteredDirectory.map((preset) => {
            const isHiggs = preset.id === "higgsfield";
            const tool = usableByType(preset.id);
            const isConnected = isHiggs ? higgsfieldConnected : Boolean(tool);

            return (
              <div
                key={preset.id}
                role="button"
                tabIndex={0}
                onClick={() => handleCardClick(preset)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    handleCardClick(preset);
                  }
                }}
                className={cn(
                  "relative group flex flex-col justify-between p-5 rounded-2xl border transition-all duration-300 ease-out text-start cursor-pointer backdrop-blur-xl overflow-hidden",
                  // 3D Glassmorphism, specular top highlight and multi-layered depth
                  "before:absolute before:inset-x-0 before:top-0 before:h-1/2 before:rounded-t-2xl before:bg-gradient-to-b before:from-white/30 before:via-white/5 before:to-transparent before:pointer-events-none",
                  isConnected
                    ? "bg-gradient-to-b from-primary/15 via-card/90 to-card/60 border-primary/50 shadow-[0_16px_36px_-8px_rgba(var(--primary-rgb,59,130,246),0.3),inset_0_1.5px_2px_rgba(255,255,255,0.7),inset_0_-2px_4px_rgba(0,0,0,0.2)] hover:-translate-y-1.5 hover:shadow-[0_22px_48px_-8px_rgba(var(--primary-rgb,59,130,246),0.45)] hover:border-primary"
                    : "bg-gradient-to-b from-card/95 via-card/80 to-card/60 border-border/70 shadow-[0_12px_28px_-6px_rgba(0,0,0,0.3),0_4px_10px_-2px_rgba(0,0,0,0.15),inset_0_1.5px_2px_rgba(255,255,255,0.6),inset_0_-2px_4px_rgba(0,0,0,0.2)] hover:-translate-y-1.5 hover:scale-[1.015] hover:border-primary/50 hover:shadow-[0_20px_42px_-8px_rgba(0,0,0,0.45),inset_0_2px_3px_rgba(255,255,255,0.85)]"
                )}
              >
                {/* Top Row: Logo on Left + Text & Badges on Right */}
                <div className="flex items-start gap-4">
                  {/* 3D Brand Logo Container on Left */}
                  <div
                    className={cn(
                      "relative shrink-0 w-14 h-14 sm:w-16 sm:h-16 rounded-2xl bg-secondary/80 backdrop-blur-sm flex items-center justify-center border border-border/50 shadow-md transition-all duration-300 group-hover:scale-110 group-hover:-translate-y-0.5 group-hover:shadow-lg group-hover:border-primary/40",
                      "before:absolute before:inset-x-0 before:top-0 before:h-1/2 before:rounded-t-2xl before:bg-gradient-to-b before:from-white/35 before:via-white/10 before:to-transparent before:pointer-events-none",
                      isConnected && "border-primary/40 shadow-primary/20"
                    )}
                  >
                    <div className="transition-transform duration-300 group-hover:scale-105 group-hover:rotate-1">
                      <ConnectorBrandLogo id={preset.id} className="w-8 h-8 sm:w-9 sm:h-9 drop-shadow-sm" />
                    </div>
                    {isConnected && (
                      <div className="absolute -top-1.5 -end-1.5 w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center shadow-md shadow-emerald-500/40 ring-2 ring-background animate-in zoom-in-50 duration-200">
                        <Check className="w-3 h-3 stroke-[3]" />
                      </div>
                    )}
                  </div>

                  {/* Content on Right of Logo */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1.5">
                      <h4 className="font-bold text-sm sm:text-base text-foreground tracking-tight group-hover:text-primary transition-colors truncate">
                        {directoryTitle(preset.id, preset.title, t)}
                      </h4>

                      {preset.supportsMcp && (
                        <Badge variant="outline" className="bg-violet-500/10 text-violet-400 border-violet-500/30 text-[9px] py-0 h-4.5 shrink-0">
                          ⚡ MCP
                        </Badge>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 mt-0.5 mb-1.5">
                      <span className="text-[11px] font-medium text-muted-foreground">
                        {categoryLabel(connectorDefinition(preset.id).category, CONNECTOR_CATEGORY_LABELS[connectorDefinition(preset.id).category], t)}
                      </span>
                      {isConnected && (
                        <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[9px] gap-1 py-0 h-4 shrink-0">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          {t("status.connected", "Connected")}
                        </Badge>
                      )}
                    </div>

                    <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                      {directoryShortDesc(preset.id, preset.shortDesc, t)}
                    </p>
                  </div>
                </div>

                {/* Bottom Row: Status Indicator & Clean Prominent Connect Button */}
                <div className="mt-4 pt-3.5 border-t border-border/40 flex items-center justify-between text-xs">
                  <div className="flex items-center gap-1.5 text-muted-foreground text-[11px]">
                    <span
                      className={cn(
                        "w-2 h-2 rounded-full",
                        isConnected && (!tool || tool.is_enabled)
                          ? "bg-emerald-400 animate-pulse shadow-sm shadow-emerald-400/50"
                          : isConnected
                          ? "bg-amber-400"
                          : "bg-muted-foreground/30"
                      )}
                    />
                    <span>
                      {isConnected
                        ? isHiggs
                          ? t("status.connectedAccount", "Connected ({{account}})", { account: higgsfieldAccount?.split("@")[0] || t("status.active", "Active") })
                          : tool?.is_enabled
                          ? t("status.activeInAgent", "Active in AI Agent")
                          : t("status.configuredDisabled", "Configured (Disabled)")
                        : t("status.readyToConnect", "Ready to Connect")}
                    </span>
                  </div>

                  {/* Prominent High-Contrast Connect Button */}
                  <Button
                    variant={isConnected ? "outline" : "default"}
                    className={cn(
                      "h-10 px-5 text-xs sm:text-sm font-bold rounded-xl shadow-sm transition-all duration-200 pointer-events-none group-hover:shadow-md group-hover:scale-[1.02]",
                      !isConnected && "bg-primary text-primary-foreground hover:bg-primary/90 shadow-primary/25"
                    )}
                  >
                    {isConnected ? (
                      <>
                        <Pencil className="w-3.5 h-3.5 me-1.5" /> {t("common:configure", "Configure")}
                      </>
                    ) : (
                      <>
                        <Plus className="w-4 h-4 me-1.5 stroke-[2.5]" /> {t("common:connect", "Connect")}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>

        {/* OAuth-backed apps: connect once per workspace, then expose the
            connection to this account's agent as a tool (spec §9.1). */}
        {filteredComposioTypes.length > 0 && (
          <div className="grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
            {filteredComposioTypes.map((type) => (
              <ComposioConnectCard
                key={type}
                connectorType={type}
                workspaceId={workspaceId}
                onConfigureTool={(connectorType) => handleCardClick(composioPreset(connectorType))}
              />
            ))}
          </div>
        )}
      </div>

      {/* Connected Integrations & Active Servers Section (Below Directory) */}
      <div className="pt-6 border-t border-border/50 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <h4 className="text-lg font-bold text-foreground">{t("header.connectedIntegrations", "Connected Integrations & Active Servers")}</h4>
            <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30 text-xs gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              {t("connectors.connectedCount", "{{count}} Connected", { count: connectedCount })}
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            {t("connectors.activeAttachHint", "Active integrations automatically attach live tool capabilities to your AI agents")}
          </p>
        </div>

        {/* Said once, above the list, not only inside cards: when the link
            read fails the list falls back to owned connectors, and an account
            that only RECEIVES shares then has no card to carry the message.
            It would see "No servers connected yet" and reconnect a live one. */}
        {(linksError || accountsError) && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
          >
            {t("errors.sharingNotListed", "Connector sharing could not be loaded, so connectors shared from other accounts are not listed here. Refresh to try again.")}
          </p>
        )}

        {connectedCount === 0 && !linksError && !accountsError ? (
          <Card className="border-dashed border-border/60 bg-card/30">
            <CardContent className="flex flex-col items-center justify-center py-10 text-center space-y-3">
              <div className="h-12 w-12 rounded-2xl bg-muted/60 flex items-center justify-center text-muted-foreground">
                <Database className="h-6 w-6" />
              </div>
              <div className="max-w-md space-y-1">
                <h5 className="font-semibold text-sm text-foreground">{t("empty.noServers", "No servers connected yet")}</h5>
                <p className="text-xs text-muted-foreground">
                  {t("empty.noServersHint", "Select any card above (Shopify, WooCommerce, Salla, MyFatoorah, Supabase, or Higgsfield) and click \"Connect\" to activate live store tools.")}
                </p>
              </div>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {/* Higgsfield Connected Card */}
            {higgsfieldConnected && (
              <Card className="border-emerald-500/30 bg-gradient-to-b from-emerald-500/10 via-card/85 to-card/60 backdrop-blur-xl shadow-sm">
                <CardHeader className="p-4 pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-xl bg-secondary/80 flex items-center justify-center border border-border/50 shadow-sm shrink-0">
                        <ConnectorBrandLogo id="higgsfield" className="w-7 h-7" />
                      </div>
                      <div>
                        <CardTitle className="text-sm font-bold text-foreground">{t("directory.higgsfield.title", "Higgsfield AI Studio")}</CardTitle>
                        <CardDescription className="text-xs truncate max-w-[180px]">
                          {higgsfieldAccount || t("connectors.byoConnected", "BYO Generation Connected")}
                        </CardDescription>
                      </div>
                    </div>

                    <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px] gap-1 py-0 h-5">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      {t("status.connected", "Connected")}
                    </Badge>
                  </div>
                </CardHeader>

                <CardContent className="p-4 pt-0 space-y-3">
                  <div className="p-2.5 rounded-xl bg-muted/40 text-[11px] text-muted-foreground flex items-center justify-between">
                    <span>{t("connectors.quotaByo", "Quota: BYO Direct Billing")}</span>
                    <span className="font-medium text-emerald-400">{t("connectors.zeroCredits", "Zero Postora Credits")}</span>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-border/40">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs font-semibold text-emerald-500 border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 gap-1.5"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>{t("status.connected", "Connected")}</span>
                    </Button>

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={disconnectHiggsfield}
                      disabled={higgsfieldBusy}
                      className="h-8 text-xs text-rose-500 hover:text-rose-600 hover:bg-rose-500/10"
                    >
                      <Unlink className="w-3.5 h-3.5 me-1" /> {t("common:disconnect", "Disconnect")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Configured Database & E-Commerce Tools Cards */}
            {accountTools.map((toolRow) => {
              const tool = configuredToolsMap.get(toolRow.id) ?? toolRow;
              // A Composio type has no directory entry; falling through to
              // CONNECTOR_DIRECTORY[0] would label the card Shopify and open
              // Shopify's form.
              const preset = CONNECTOR_DIRECTORY.find((p) => p.id === tool.connector_type)
                ?? (isComposioType(tool.connector_type) ? composioPreset(tool.connector_type) : CONNECTOR_DIRECTORY[0]);
              // Owned here, shared in from another account, or a legacy
              // all_accounts row. Only the first may be edited from this tab;
              // the other two say where they come from instead.
              const owned = isOwnedHere(tool);
              const legacyGlobal = tool.scope === "all_accounts";
              const ownerAccount = tool.social_account_id
                ? accountsById.get(tool.social_account_id) ?? null
                : null;

              return (
                <Card
                  key={tool.id}
                  data-testid={`tool-card-${tool.id}`}
                  className="border-emerald-500/30 bg-gradient-to-b from-emerald-500/10 via-card/85 to-card/60 backdrop-blur-xl shadow-sm"
                >
                  <CardHeader className="p-4 pb-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-center gap-3">
                        <div className="w-12 h-12 rounded-xl bg-secondary/80 flex items-center justify-center border border-border/50 shadow-sm shrink-0">
                          <ConnectorBrandLogo id={tool.connector_type} className="w-7 h-7" />
                        </div>
                        <div>
                          <CardTitle className="text-sm font-bold text-foreground font-mono truncate max-w-[150px]">
                            {tool.name}
                          </CardTitle>
                          <CardDescription className="text-xs truncate max-w-[180px]">
                            {directoryTitle(preset.id, preset.title, t)}
                          </CardDescription>
                        </div>
                      </div>

                      <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px] gap-1 py-0 h-5">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        {t("status.connected", "Connected")}
                      </Badge>
                    </div>

                    {/* Where a card that this account does not own comes from.
                        Without it a shared connector is indistinguishable from
                        one connected here, and its missing Edit button reads
                        as a bug rather than as someone else's connector. */}
                    {!owned && (
                      <p
                        data-testid={`tool-origin-${tool.id}`}
                        className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground"
                      >
                        <Share2 className="h-3 w-3 shrink-0" />
                        {legacyGlobal ? (
                          <span>{t("connectors.legacyAllAccounts", "Available to all accounts (legacy connector)")}</span>
                        ) : (
                          <>
                            <span>{t("connectors.sharedFrom", "Shared from")}</span>
                            {ownerAccount && (
                              <PlatformIcon platform={ownerAccount.platform as Platform} size="xs" />
                            )}
                            <span className="font-medium text-foreground/80">
                              {ownerAccount ? accountLabel(ownerAccount) : t("connectors.anotherAccount", "another account")}
                            </span>
                          </>
                        )}
                      </p>
                    )}
                  </CardHeader>

                  <CardContent className="p-4 pt-0 space-y-3">
                    <div className="p-2.5 rounded-xl bg-muted/40 text-[11px] text-muted-foreground flex items-center justify-between">
                      <span className="font-mono truncate max-w-[160px]">{tool.url || t("connectors.apiEndpoint", "API Endpoint")}</span>
                      <span className="font-medium text-emerald-400">{tool.is_enabled ? t("status.activeTool", "Active Tool") : t("status.disabled", "Disabled")}</span>
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-border/40">
                      {/* Green Connected Mark & Button */}
                      {/* This button opens the settings form, so it belongs to
                          the owning account alone. The header badge already
                          says Connected, so a non-owner loses nothing — where
                          to change it is on the origin line above. */}
                      {owned && (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => handleCardClick(preset, tool)}
                          className="h-8 text-xs font-semibold text-emerald-500 border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 gap-1.5 cursor-pointer"
                        >
                          <Check className="w-3.5 h-3.5 stroke-[3]" />
                          <span>{t("status.connected", "Connected")}</span>
                        </Button>
                      )}

                      <div className="ms-auto flex items-center gap-1">
                        {/* Edit belongs to the owning account only. Saving from
                            anywhere else cannot update the row — the server
                            matches on (user, account, name) — so an Edit button
                            here would promise a write that becomes a duplicate. */}
                        {owned && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => handleCardClick(preset, tool)}
                            className="h-8 text-xs text-muted-foreground hover:text-foreground"
                          >
                            <Pencil className="w-3 h-3 me-1" /> {t("common:edit", "Edit")}
                          </Button>
                        )}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-rose-500 hover:text-rose-600 hover:bg-rose-500/10"
                          aria-label={t("actions.disconnectNamed", "Disconnect {{name}}", { name: tool.name })}
                          onClick={() => {
                            // Deleting is not un-sharing: the row is gone for
                            // every account it reaches, including the one that
                            // connected it. Say so on a card this account does
                            // not own — untick the box below to just drop it.
                            const question = owned
                              ? t("dialog.disconnectNamed", "Are you sure you want to disconnect '{{name}}'?", { name: tool.name })
                              : t("dialog.disconnectShared", "'{{name}}' is shared from another account. Disconnecting deletes it for every account. Continue?", { name: tool.name });
                            if (confirm(question)) {
                              deleteTool.mutate(tool.id, {
                                onSuccess: () => toast.success(t("toast.connectorDisconnected", "Connector '{{name}}' disconnected", { name: tool.name })),
                              });
                            }
                          }}
                        >
                          <Trash2 className="h-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
                    <ConnectorCredentialState tool={tool} />
                    {/* Usage is workspace-level and `workspaceId` is the
                        SELECTED account's. For a connector shared in from
                        another account the calls are recorded in the owner's
                        workspace, so a line here would read zero and mean
                        nothing. It stays on the owner's card. */}
                    {owned && <ConnectorUsageLine workspaceId={workspaceId} toolId={tool.id} />}
                    <ConnectorTestState
                      tool={tool}
                      testing={testingToolIds.includes(tool.id)}
                      view={testResultViews[tool.id] ?? storedTestView(tool, t)}
                      onTest={() => void runConnectionTest(tool)}
                    />
                    {accountsError ? (
                      <p className="border-t pt-3 text-xs text-destructive">
                        {t("errors.accountsSharing", "Connected accounts could not be loaded, so sharing cannot be changed here.")}
                      </p>
                    ) : linksError ? (
                      <p className="border-t pt-3 text-xs text-destructive">
                        {t("errors.sharingRefresh", "Connector sharing could not be loaded. Refresh to try again.")}
                      </p>
                    ) : legacyGlobal ? (
                      // A scope='all_accounts' row reaches every agent through
                      // its scope, not through link rows, so a strip here would
                      // draw ticks that no toggle can change (nextToolSharing
                      // only ever edits links).
                      <p className="border-t pt-3 text-xs text-muted-foreground">
                        {t("connectors.everyAgent", "Every agent can use this connector. Reconnect it on one account to choose which agents it reaches.")}
                      </p>
                    ) : (
                      linksReady && accountsReady && shareAccounts.length > 0 && (
                        <div className="border-t pt-3">
                          <p className="mb-2 text-xs font-medium text-muted-foreground">
                            {t("connectors.agentsCanUse", "Agents that can use this")}
                          </p>
                          <div className="flex flex-wrap gap-x-4 gap-y-2">
                            {shareAccounts.map((account) => {
                              const isOwner = account.id === tool.social_account_id;
                              return (
                                <label
                                  key={account.id}
                                  title={isOwner ? t("connectors.ownerTickHint", "This account owns the connector; unticking it would change the owner, not sharing.") : undefined}
                                  className={cn(
                                    "flex items-center gap-2 text-sm",
                                    isOwner ? "cursor-not-allowed" : "cursor-pointer",
                                  )}
                                >
                                  <Checkbox
                                    checked={(sharedByTool.get(tool.id) ?? []).includes(account.id)}
                                    disabled={isOwner || sharingToolIds.includes(tool.id)}
                                    onCheckedChange={(value) =>
                                      toggleToolShare(tool, account, value === true)
                                    }
                                    aria-label={t("actions.shareWith", "Share {{name}} with {{account}}", { name: tool.name, account: accountLabel(account) })}
                                  />
                                  <PlatformIcon platform={account.platform as Platform} size="xs" />
                                  <span>{accountLabel(account)}</span>
                                </label>
                              );
                            })}
                          </div>
                        </div>
                      )
                    )}
                  </CardContent>
                </Card>
              );
            })}

            {/* Inbound Authorized OAuth Applications (e.g. n8n, Zapier) */}
            {oauthClients.map((client) => (
              <Card key={client.id} className="border-emerald-500/30 bg-gradient-to-b from-emerald-500/10 via-card/85 to-card/60 backdrop-blur-xl shadow-sm">
                <CardHeader className="p-4 pb-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-xl bg-secondary/80 flex items-center justify-center border border-border/50 shadow-sm shrink-0">
                        {client.icon ? (
                          <img src={client.icon} alt={client.name} className="h-7 w-7 rounded-lg" />
                        ) : (
                          <Globe className="h-6 w-6 text-primary" />
                        )}
                      </div>
                      <div>
                        <CardTitle className="text-sm font-bold text-foreground truncate max-w-[150px]">
                          {client.name}
                        </CardTitle>
                        <CardDescription className="text-xs truncate max-w-[180px]">
                          {t("connectors.authorizedOauth", "Authorized OAuth App")}
                        </CardDescription>
                      </div>
                    </div>

                    <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px] gap-1 py-0 h-5">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      {t("status.authorized", "Authorized")}
                    </Badge>
                  </div>
                </CardHeader>

                <CardContent className="p-4 pt-0 space-y-3">
                  <div className="p-2.5 rounded-xl bg-muted/40 text-[11px] text-muted-foreground flex items-center justify-between">
                    <span>{t("connectors.scopes", "Scopes: {{scopes}}", { scopes: client.scopes?.join(", ") || t("connectors.fullAccess", "Full Access") })}</span>
                    <span className="font-medium text-emerald-400">{t("connectors.activeToken", "Active Token")}</span>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-border/40">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs font-semibold text-emerald-500 border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 gap-1.5"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>{t("status.connected", "Connected")}</span>
                    </Button>

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (confirm(t("dialog.revokeAccess", "Are you sure you want to revoke access for {{name}}?", { name: client.name }))) {
                          handleRevokeOAuth(client.id, client.name);
                        }
                      }}
                      className="h-8 text-xs text-rose-500 hover:text-rose-600 hover:bg-rose-500/10"
                    >
                      <Unlink className="w-3.5 h-3.5 me-1" /> {t("actions.revoke", "Revoke")}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Interactive Detail & Connection Modal */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="flex max-h-[90vh] max-w-2xl flex-col overflow-hidden">
          <DialogHeader className="shrink-0">
            <div className="flex items-center gap-3.5">
              {selectedPreset && (
                <div className="relative shrink-0 w-14 h-14 rounded-2xl bg-secondary/80 backdrop-blur-sm flex items-center justify-center border border-border/50 shadow-md">
                  <ConnectorBrandLogo id={selectedPreset.id} className="w-8 h-8 drop-shadow-sm" />
                </div>
              )}
              <div>
                <DialogTitle className="text-lg flex items-center gap-2">
                  <span>{selectedPreset ? directoryTitle(selectedPreset.id, selectedPreset.title, t) : t("dialog.connectorConfig", "Connector Configuration")}</span>
                  {(editingTool || (selectedPreset?.id === "higgsfield" && higgsfieldConnected)) && (
                    <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px]">
                      {t("status.connected", "Connected")}
                    </Badge>
                  )}
                  {selectedPreset?.supportsMcp && (
                    <Badge variant="outline" className="bg-violet-500/10 text-violet-400 border-violet-500/30 text-[10px]">
                      {t("connectors.mcpEnabled", "⚡ MCP Enabled")}
                    </Badge>
                  )}
                </DialogTitle>
                <DialogDescription className="text-xs mt-0.5">
                  {selectedPreset ? directoryDescription(selectedPreset.id, selectedPreset.description, t) : t("dialog.configureCredentials", "Configure credentials and tool calling parameters.")}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {/* Special OAuth UI for Higgsfield */}
          {selectedPreset?.id === "higgsfield" ? (
            <>
              {/* min-h-0 lets this flex child shrink so overflow-y-auto can
                  engage; without it the dialog grows past the viewport. */}
              <div className="min-h-0 overflow-y-auto">
            <div className="space-y-4 pt-3">
              <div className="p-4 rounded-xl border border-border/60 bg-muted/20 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="font-semibold text-sm text-foreground">{t("dialog.higgsfieldOauth", "Direct Higgsfield OAuth Authentication")}</h4>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {t("dialog.higgsfieldOauthHint", "Connect your personal Higgsfield account with 1-click. All generation is billed to Higgsfield and does not consume Postora quota.")}
                    </p>
                  </div>
                  {higgsfieldConnected && (
                    <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-xs">
                      {t("status.active", "Active")}
                    </Badge>
                  )}
                </div>

                {higgsfieldConnected && higgsfieldAccount && (
                  <p className="text-xs font-mono text-emerald-400 bg-emerald-500/10 p-2 rounded-lg border border-emerald-500/20">
                    {t("connectors.connectedAccountNamed", "Connected Account: {{account}}", { account: higgsfieldAccount })}
                  </p>
                )}
              </div>
            </div>
              </div>

              <div className="flex shrink-0 items-center justify-between border-t border-border/40 pt-4">
                <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)} className="text-xs h-8">
                  {t("common:cancel", "Cancel")}
                </Button>

                {higgsfieldConnected ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={disconnectHiggsfield}
                    disabled={higgsfieldBusy}
                    className="text-xs h-8 text-rose-500 border-rose-500/30 hover:bg-rose-500/10"
                  >
                    {higgsfieldBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin me-1" /> : <Unlink className="w-3.5 h-3.5 me-1" />}
                    <span>{t("actions.disconnectAccount", "Disconnect Account")}</span>
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={connectHiggsfield}
                    disabled={higgsfieldBusy}
                    className="text-xs h-8 gap-1.5 bg-rose-600 hover:bg-rose-700 text-white"
                  >
                    {higgsfieldBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
                    <span>{t("actions.connectHiggsfield", "Connect with Higgsfield")}</span>
                  </Button>
                )}
              </div>
            </>
          ) : (
            <>
              {/* min-h-0 lets this flex child shrink so overflow-y-auto can
                  engage; without it the dialog grows past the viewport. */}
              <div className="min-h-0 overflow-y-auto">
              {/* Modal Tabs */}
              <Tabs
                value={modalTab}
                onValueChange={(value) => setModalTab(value as typeof modalTab)}
                className="w-full mt-2"
              >
                <TabsList className="grid grid-cols-3 w-full bg-muted/60 h-9 p-1">
                  <TabsTrigger value="credentials" className="text-xs">
                    {t("form.tabCredentials", "Credentials & API")}
                  </TabsTrigger>
                  <TabsTrigger value="mcp" disabled={!selectedPreset?.supportsMcp} className="text-xs">
                    {t("form.tabMcp", "Model Context Protocol (MCP)")}
                  </TabsTrigger>
                  <TabsTrigger value="overview" className="text-xs">
                    {t("form.tabSecurity", "Security & Isolation")}
                  </TabsTrigger>
                </TabsList>

                {/* TAB 1: Credentials & API */}
                <TabsContent value="credentials" className="space-y-4 pt-3">
                  {formError && (
                    <div className="p-3 text-xs bg-destructive/10 border border-destructive/30 text-destructive rounded-xl">
                      {formError}
                    </div>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="connector-tool-name" className="text-xs">
                        {t("form.toolName", "Tool Name (Unique Identifier)")}
                      </Label>
                      <Input
                        id="connector-tool-name"
                        value={form.name}
                        onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })}
                        placeholder="e.g. shopify_store"
                        className="font-mono text-xs h-9"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <Label className="text-xs">{t("form.connectorType", "Connector Type")}</Label>
                        <span className="text-[10px] text-muted-foreground flex items-center gap-1 font-normal">
                          <Lock className="w-3 h-3" /> {t("form.fixedToPreset", "Fixed to preset")}
                        </span>
                      </div>
                      <div className="h-9 px-3 rounded-md border border-input bg-muted/50 flex items-center justify-between gap-2 text-xs font-medium text-foreground cursor-not-allowed select-none">
                        <div className="flex items-center gap-2 truncate">
                          <ConnectorBrandLogo id={form.connector_type} className="w-4 h-4 shrink-0" />
                          <span className="truncate">
                            {directoryTitle(form.connector_type, CONNECTOR_DIRECTORY.find((d) => d.id === form.connector_type)?.title || form.connector_type, t)}
                          </span>
                        </div>
                        {/* Mirrors the Read-Only Guard switch below; it used to say Read-Only whatever the guard was.
                            Only types whose runtime has a guarded write path can be Read & Write: read-only
                            adapters never write, and Composio writes are gated by settings.allow_writes. */}
                        <Badge variant="secondary" className="text-[9px] py-0 h-4 shrink-0 font-normal">
                          {form.read_only_mode || !hasGuardedWrites(form.connector_type)
                            ? t("form.readOnly", "Read-Only")
                            : t("form.readWrite", "Read & Write")}
                        </Badge>
                      </div>
                    </div>
                  </div>

                  {/* Registry-driven credential fields: exactly what
                      connectorDefinition(type).credentials declares, so a new
                      registry type is configurable here with no form change. */}
                  {/* A hidden field is state the picker keeps (the column catalog):
                      it rides in `credentials` like any setting but is never
                      typed by hand. */}
                  {safeCredentialFields(form.connector_type).filter((field) => field.kind !== "hidden").map((field) => {
                    const inputId = `connector-credential-${field.key}`;
                    const isStoredSecret =
                      field.kind === "secret" &&
                      editingTool !== null &&
                      (editingTool.configured_secret_fields ?? []).includes(field.key);
                    return (
                      <div className="space-y-1.5" key={field.key}>
                        <div className="flex items-center justify-between gap-2">
                          <Label htmlFor={inputId} className="text-xs">
                            {field.label}
                          </Label>
                          <span className="text-[10px] text-muted-foreground">
                            {isStoredSecret ? t("form.storedKeep", "Stored — leave blank to keep") : field.required ? t("form.required", "Required") : null}
                          </span>
                        </div>
                        <Input
                          id={inputId}
                          name={field.key}
                          type={field.kind === "secret" ? "password" : field.kind === "url" ? "url" : "text"}
                          value={form.credentials[field.key] ?? ""}
                          onChange={(e) => {
                            setForm((prev) => ({
                              ...prev,
                              credentials: { ...prev.credentials, [field.key]: e.target.value },
                            }));
                            if (field.kind === "secret" && clearSecret) setClearSecret(false);
                          }}
                          placeholder={
                            field.kind === "secret"
                              ? isStoredSecret
                                ? "••••••••••••••••"
                                : t("form.enterField", "Enter {{field}}", { field: field.label })
                              : field.help
                          }
                          className={cn("h-9", field.kind === "url" && "font-mono text-xs")}
                        />
                        <p className="text-[10px] text-muted-foreground">{field.help}</p>
                      </div>
                    );
                  })}

                  {/* Dropdown upgrade for Supabase: offers the project's own
                      tables and columns, writing back into the same registry
                      fields above. Free text keeps working when it cannot run. */}
                  {form.connector_type === "supabase" && (
                    <SupabaseSchemaPicker
                      projectUrl={form.credentials.project_url ?? ""}
                      anonKey={form.credentials.anon_key ?? ""}
                      schema={form.credentials.schema ?? "public"}
                      tableAllowList={form.credentials.table_allow_list ?? ""}
                      selectColumns={form.credentials.select_columns ?? ""}
                      columnMap={form.credentials.column_map ?? ""}
                      columnCatalog={form.credentials.column_catalog ?? ""}
                      onPatch={(patch) =>
                        setForm((prev) => ({
                          ...prev,
                          credentials: { ...prev.credentials, ...patch },
                        }))}
                    />
                  )}

                  {/* An OAuth-backed type has no credentials here at all: the
                      credential is the connection, held at Composio and
                      chosen by id (spec §9.1). */}
                  {isComposioType(form.connector_type) && (
                    <ConnectionPicker
                      connectorType={form.connector_type}
                      workspaceId={workspaceId}
                      isWorkspaceLoading={workspaceLoading}
                      value={form.connection_id}
                      onChange={(connectionId) => setForm((prev) => ({ ...prev, connection_id: connectionId }))}
                    />
                  )}

                  {/* Generic endpoint input only for types whose registry
                      declares no url credential field, and never for a
                      Composio type whose endpoint is Composio's own. */}
                  {!urlCredentialField(form.connector_type) && !isComposioType(form.connector_type) && (
                    <div className="space-y-1.5">
                      <Label htmlFor="connector-endpoint-url" className="text-xs">
                        {t("form.endpointUrl", "API Endpoint / Webhook URL")}
                      </Label>
                      <Input
                        id="connector-endpoint-url"
                        value={form.url}
                        onChange={(e) => setForm({ ...form, url: e.target.value })}
                        placeholder="https://your-store.com/api/..."
                        className="font-mono text-xs h-9"
                      />
                    </div>
                  )}

                  {/* Removal of the legacy webhook-secret column, unchanged
                      from the old form: setting/replacing secrets now travels
                      inside `credentials`; this only clears the stored column. */}
                  {editingHasSecret && (
                    <div className="flex items-center gap-2">
                      <Checkbox
                        id="clear-secret-chk"
                        checked={clearSecret}
                        onCheckedChange={(c) => setClearSecret(Boolean(c))}
                      />
                      <Label htmlFor="clear-secret-chk" className="text-xs text-muted-foreground cursor-pointer">
                        {t("form.removeSecret", "Remove stored secret from database")}
                      </Label>
                    </div>
                  )}

                  <div className="space-y-1.5">
                    <Label className="text-xs">{t("form.toolPrompt", "AI Tool Prompt & Trigger Instructions")}</Label>
                    <Textarea
                      rows={2}
                      value={form.description}
                      onChange={(e) => setForm({ ...form, description: e.target.value })}
                      placeholder={t("form.toolPromptPlaceholder", "Explain when the AI agent should call this tool...")}
                      className="text-xs leading-relaxed resize-none"
                    />
                  </div>

                  {/* Capability Permissions */}
                  <div className="p-3 rounded-xl border border-border/60 bg-muted/20 space-y-2.5">
                    <Label className="text-xs font-semibold text-foreground">{t("form.capabilityPermissions", "Capability Permissions")}</Label>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="perm-search"
                          checked={form.permission_search_products}
                          onCheckedChange={(c) => setForm({ ...form, permission_search_products: Boolean(c) })}
                        />
                        <Label htmlFor="perm-search" className="text-xs cursor-pointer">
                          {t("form.searchProducts", "Search Products")}
                        </Label>
                      </div>

                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="perm-stock"
                          checked={form.permission_check_stock}
                          onCheckedChange={(c) => setForm({ ...form, permission_check_stock: Boolean(c) })}
                        />
                        <Label htmlFor="perm-stock" className="text-xs cursor-pointer">
                          {t("form.checkStock", "Check Stock")}
                        </Label>
                      </div>

                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="perm-orders"
                          checked={form.permission_lookup_orders}
                          onCheckedChange={(c) => setForm({ ...form, permission_lookup_orders: Boolean(c) })}
                        />
                        <Label htmlFor="perm-orders" className="text-xs cursor-pointer">
                          {t("form.lookupOrders", "Lookup Orders")}
                        </Label>
                      </div>
                    </div>
                  </div>

                  {/* Toggles */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                    <div className="flex items-center justify-between p-2.5 rounded-xl border border-border/60 bg-muted/10">
                      <div className="space-y-0.5">
                        <Label className="text-xs font-medium">{t("form.readOnlyGuard", "Read-Only Guard")}</Label>
                        <p className="text-[10px] text-muted-foreground">{t("form.readOnlyGuardHint", "Disallows any write operations")}</p>
                        {form.connector_type === "woocommerce" && form.read_only_mode && (
                          <p className="text-[10px] text-amber-600 dark:text-amber-400">
                            {t("form.readOnlyGuardWooHint", "Turn this off to let COD confirmation update orders.")}
                          </p>
                        )}
                      </div>
                      <Switch
                        checked={form.read_only_mode}
                        onCheckedChange={(c) => setForm({ ...form, read_only_mode: c })}
                      />
                    </div>

                    <div className="flex items-center justify-between p-2.5 rounded-xl border border-border/60 bg-muted/10">
                      <div className="space-y-0.5">
                        <Label className="text-xs font-medium">{t("form.smartCache", "Smart Cache")}</Label>
                        <p className="text-[10px] text-muted-foreground">{t("form.smartCacheHint", "Caches repeated product queries")}</p>
                      </div>
                      <Switch
                        checked={form.enable_cache}
                        onCheckedChange={(c) => setForm({ ...form, enable_cache: c })}
                      />
                    </div>
                  </div>
                </TabsContent>

                {/* TAB 2: Model Context Protocol (MCP) */}
                <TabsContent value="mcp" className="space-y-4 pt-3">
                  <div className="p-3.5 rounded-xl bg-violet-500/10 border border-violet-500/30 space-y-2">
                    <div className="flex items-center gap-2">
                  <Zap className="w-4 h-4 text-violet-400" />
                  <h4 className="font-semibold text-xs text-foreground">{t("form.mcpAutoApproved", "Auto-Approved MCP Connection")}</h4>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {t("form.mcpAutoApprovedHint", "This connector supports the official Model Context Protocol. You can connect it directly to Claude Desktop, Cursor, Windsurf, or Antigravity agents without needing admin review.")}
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">{t("form.mcpJson", "MCP Server Configuration JSON")}</Label>
                  <Button variant="ghost" size="sm" onClick={copyMcpConfig} className="h-7 text-xs gap-1">
                    {copiedMcp ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedMcp ? t("common:copied", "Copied") : t("actions.copyJson", "Copy JSON")}</span>
                  </Button>
                </div>
                <pre className="p-3 rounded-xl bg-muted/60 border border-border/60 text-[11px] font-mono overflow-x-auto text-foreground">
                  {mcpConfigSnippet}
                </pre>
              </div>

              <div className="pt-2">
                <Button onClick={handleMcpInstantActivate} className="w-full gap-2 text-xs bg-violet-600 hover:bg-violet-700">
                  <Zap className="w-4 h-4" />
                  <span>{t("actions.activateMcp", "Activate & Connect with MCP Auto-Auth")}</span>
                </Button>
              </div>
            </TabsContent>

            {/* TAB 3: Security & Multi-Tenant Isolation */}
            <TabsContent value="overview" className="space-y-3 pt-3">
              <div className="p-3.5 rounded-xl border border-border/60 bg-muted/20 space-y-3 text-xs">
                <div className="flex items-start gap-2.5">
                  <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <div>
                    <h5 className="font-semibold text-foreground">{t("form.isolationTitle", "Multi-Tenant Store Isolation")}</h5>
                    <p className="text-muted-foreground mt-0.5">
                      {t("form.isolationHint", "Your store credentials, API keys, and cache records are strictly isolated under your user identifier ({{id}}).", { id: profile?.id || "uid" })}
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-2.5">
                  <Lock className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
                  <div>
                    <h5 className="font-semibold text-foreground">{t("form.guardrailsTitle", "Read-Only Guardrails")}</h5>
                    <p className="text-muted-foreground mt-0.5">
                      {t("form.guardrailsHint", "By default, AI agent tool calling is locked in read-only mode to prevent unintended stock or order modifications.")}
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-2.5">
                  <Clock className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <h5 className="font-semibold text-foreground">{t("form.quotaTitle", "Automated Quota Billing")}</h5>
                    <p className="text-muted-foreground mt-0.5">
                      {t("form.quotaHint", "Tool requests execute directly under your account subscription quota with zero manual admin approval delays.")}
                    </p>
                  </div>
                </div>
              </div>
            </TabsContent>
          </Tabs>
              </div>

          {/* Modal Footer */}
          <div className="mt-2 flex shrink-0 items-center justify-between border-t border-border/40 pt-4">
            <div>
              {editingTool && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (confirm(t("dialog.disconnectNamed", "Are you sure you want to disconnect '{{name}}'?", { name: editingTool.name }))) {
                      deleteTool.mutate(editingTool.id, {
                        onSuccess: () => {
                          toast.success(t("toast.connectorRemoved", "Connector removed"));
                          setDialogOpen(false);
                        },
                      });
                    }
                  }}
                  className="text-rose-500 hover:text-rose-600 hover:bg-rose-500/10 text-xs h-8"
                >
                  <Trash2 className="w-3.5 h-3.5 me-1" /> {t("common:disconnect", "Disconnect")}
                </Button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)} className="text-xs h-8">
                {t("common:cancel", "Cancel")}
              </Button>
              <Button size="sm" onClick={handleSave} disabled={upsertTool.isPending} className="text-xs h-8 gap-1.5">
                {upsertTool.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                <span>{editingTool ? t("common:saveChanges", "Save Changes") : t("actions.saveAndConnect", "Save & Connect")}</span>
              </Button>
            </div>
          </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
