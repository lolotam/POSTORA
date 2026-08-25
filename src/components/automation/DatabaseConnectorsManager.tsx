import { useState, useMemo, useEffect, useCallback } from "react";
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
import { supabase } from "@/integrations/supabase/client";
import { HIGGSFIELD_CALLBACK_PATH } from "@/lib/higgsfieldOAuthReturn";
import { useAiAgentTools, type AiAgentTool, type AiAgentToolInput, type ConnectorType } from "@/hooks/useAiAgentTools";
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
  category: "ecommerce" | "payments" | "database" | "automation" | "formula";
  categoryLabel: string;
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
    category: "ecommerce",
    categoryLabel: "E-Commerce",
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
    category: "ecommerce",
    categoryLabel: "E-Commerce",
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
    category: "ecommerce",
    categoryLabel: "E-Commerce",
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
    category: "ecommerce",
    categoryLabel: "E-Commerce",
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
    category: "payments",
    categoryLabel: "Payments",
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
    category: "payments",
    categoryLabel: "Payments",
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
    category: "automation",
    categoryLabel: "AI Generation",
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
    category: "database",
    categoryLabel: "Database",
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
    category: "database",
    categoryLabel: "Database",
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
    category: "formula",
    categoryLabel: "Formulas",
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
    category: "automation",
    categoryLabel: "Automation",
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
    category: "automation",
    categoryLabel: "MCP Native",
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
  secret: "",
  is_enabled: true,
  admin_only: false,
  connector_type: "shopify" as ConnectorType,
  permission_search_products: true,
  permission_check_stock: true,
  permission_lookup_orders: false,
  read_only_mode: true,
  enable_cache: true,
};

type CategoryFilter = "all" | "ecommerce" | "payments" | "database" | "automation" | "formula" | "mcp";

function useSafeProfile() {
  try {
    const auth = useAuth();
    return auth?.profile || null;
  } catch {
    return null;
  }
}

export function DatabaseConnectorsManager() {
  const profile = useSafeProfile();
  const { tools, isLoading, upsertTool, deleteTool } = useAiAgentTools();
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
      if (error || !data?.url) throw error ?? new Error(data?.error || "Could not retrieve authorization URL");
      window.location.assign(data.url);
    } catch (e: any) {
      toast.error(e.message || "Failed to initiate Higgsfield connection");
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
      toast.success("Higgsfield account disconnected");
      setDialogOpen(false);
    } catch (e: any) {
      toast.error(e.message || "Failed to disconnect Higgsfield");
    } finally {
      setHiggsfieldBusy(false);
    }
  };

  const queryClient = useQueryClient();

  // Inbound OAuth Authorized Applications query (e.g. n8n, Zapier, Make)
  const { data: oauthClients = [] } = useQuery({
    queryKey: ["oauth-authorized-clients"],
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
        toast.success(`Revoked access for ${clientName}`);
        queryClient.invalidateQueries({ queryKey: ["oauth-authorized-clients"] });
      }
    } catch {
      toast.error("Failed to revoke OAuth access");
    }
  };

  const apiKey = profile?.api_key || "YOUR_POSTORA_API_KEY";

  // Map configured tools by connector_type
  const configuredToolsMap = useMemo(() => {
    const map = new Map<ConnectorType, AiAgentTool>();
    for (const tool of tools) {
      map.set(tool.connector_type, tool);
    }
    return map;
  }, [tools]);

  // Filtered directory items
  const filteredDirectory = useMemo(() => {
    return CONNECTOR_DIRECTORY.filter((item) => {
      const matchesSearch =
        searchQuery.trim() === "" ||
        item.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.shortDesc.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.categoryLabel.toLowerCase().includes(searchQuery.toLowerCase());

      if (!matchesSearch) return false;

      if (activeCategory === "all") return true;
      if (activeCategory === "mcp") return item.supportsMcp;
      return item.category === activeCategory;
    });
  }, [searchQuery, activeCategory]);

  const handleCardClick = (preset: ConnectorDirectoryItem) => {
    if (preset.id === "higgsfield" && !higgsfieldConnected) {
      // Direct 1-click connect flow for Higgsfield
      setSelectedPreset(preset);
      setDialogOpen(true);
      return;
    }

    const existingTool = configuredToolsMap.get(preset.id);
    setSelectedPreset(preset);
    setFormError(null);

    if (existingTool) {
      setEditingTool(existingTool);
      setForm({
        name: existingTool.name,
        description: existingTool.description,
        url: existingTool.url || "",
        secret: "",
        is_enabled: existingTool.is_enabled,
        admin_only: existingTool.admin_only,
        connector_type: existingTool.connector_type,
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
        secret: "",
        is_enabled: true,
        admin_only: false,
        connector_type: preset.id,
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
    const error =
      validateAiToolName(form.name) ||
      validateAiToolUrl(form.url) ||
      (form.description.trim() ? null : "Description is required — the AI uses it to decide when to call the tool.");
    if (error) {
      setFormError(error);
      return;
    }

    const payload: AiAgentToolInput = {
      name: form.name,
      description: form.description,
      url: form.url,
      is_enabled: form.is_enabled,
      admin_only: form.admin_only,
      connector_type: form.connector_type,
      permissions: {
        search_products: form.permission_search_products,
        check_stock: form.permission_check_stock,
        lookup_orders: form.permission_lookup_orders,
      },
      read_only_mode: form.read_only_mode,
      enable_cache: form.enable_cache,
    };

    if (form.secret.trim() !== "") {
      payload.secret = form.secret.trim();
    } else if (editingTool && editingHasSecret && clearSecret) {
      payload.clear_secret = true;
    }

    upsertTool.mutate(payload, {
      onSuccess: () => {
        toast.success(editingTool ? "Connector updated successfully" : "Connector connected to Postora AI runtime");
        setDialogOpen(false);
      },
      onError: (mutationError) => setFormError(mutationError.message),
    });
  };

  const handleMcpInstantActivate = () => {
    if (!selectedPreset) return;
    setForm((prev) => ({
      ...prev,
      name: selectedPreset.name,
      description: selectedPreset.suggestedPrompt,
      url: selectedPreset.defaultUrl,
      is_enabled: true,
      connector_type: selectedPreset.id,
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
    toast.success("MCP configuration copied to clipboard");
    setTimeout(() => setCopiedMcp(false), 2000);
  };

  // Connected count
  const connectedCount = tools.length + (higgsfieldConnected ? 1 : 0) + (oauthClients?.length || 0);

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
              <h3 className="text-xl font-bold text-foreground">Integrations & Connectors Directory</h3>
              <Badge variant="outline" className="border-primary/30 text-primary bg-primary/10 text-xs gap-1">
                <Sparkles className="w-3 h-3" /> Auto-Approved & MCP Ready
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Connect your e-commerce stores, payment gateways, databases, and AI generation servers with authentic brand tools.
            </p>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Button
              size="sm"
              onClick={() => {
                setSelectedPreset(CONNECTOR_DIRECTORY[0]);
                setEditingTool(null);
                setForm(emptyForm);
                setDialogOpen(true);
              }}
              className="gap-1.5"
            >
              <Plus className="h-4 w-4" />
              <span>Custom Webhook</span>
            </Button>
          </div>
        </div>

        {/* Filter and Search Bar */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-1">
          {/* Category Pills */}
          <div className="flex items-center gap-1.5 overflow-x-auto w-full sm:w-auto pb-1 sm:pb-0 scrollbar-none">
            {(
              [
                { id: "all", label: "All Connectors" },
                { id: "ecommerce", label: "E-Commerce" },
                { id: "payments", label: "Payments" },
                { id: "database", label: "Databases" },
                { id: "automation", label: "Automation" },
                { id: "mcp", label: "⚡ MCP Ready" },
              ] as const
            ).map((cat) => {
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
            <Search className="w-4 h-4 text-muted-foreground absolute left-3 top-1/2 -translate-y-1/2" />
            <Input
              placeholder="Search connectors..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-9 h-9 text-xs rounded-xl bg-card/60"
            />
          </div>
        </div>

        {/* Connectors Grid (3D Brand Cards with Logo on Left and Text on Right) */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filteredDirectory.map((preset) => {
            const isHiggs = preset.id === "higgsfield";
            const isConnected = isHiggs ? higgsfieldConnected : configuredToolsMap.has(preset.id);
            const tool = configuredToolsMap.get(preset.id);

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
                  "relative group flex flex-col justify-between p-5 rounded-2xl border transition-all duration-300 ease-out text-left cursor-pointer backdrop-blur-xl overflow-hidden",
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
                      <div className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-emerald-500 text-white flex items-center justify-center shadow-md shadow-emerald-500/40 ring-2 ring-background animate-in zoom-in-50 duration-200">
                        <Check className="w-3 h-3 stroke-[3]" />
                      </div>
                    )}
                  </div>

                  {/* Content on Right of Logo */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between gap-1.5">
                      <h4 className="font-bold text-sm sm:text-base text-foreground tracking-tight group-hover:text-primary transition-colors truncate">
                        {preset.title}
                      </h4>

                      {preset.supportsMcp && (
                        <Badge variant="outline" className="bg-violet-500/10 text-violet-400 border-violet-500/30 text-[9px] py-0 h-4.5 shrink-0">
                          ⚡ MCP
                        </Badge>
                      )}
                    </div>

                    <div className="flex items-center gap-1.5 mt-0.5 mb-1.5">
                      <span className="text-[11px] font-medium text-muted-foreground">
                        {preset.categoryLabel}
                      </span>
                      {isConnected && (
                        <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[9px] gap-1 py-0 h-4 shrink-0">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          Connected
                        </Badge>
                      )}
                    </div>

                    <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                      {preset.shortDesc}
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
                          ? `Connected (${higgsfieldAccount?.split("@")[0] || "Active"})`
                          : tool?.is_enabled
                          ? "Active in AI Agent"
                          : "Configured (Disabled)"
                        : "Ready to Connect"}
                    </span>
                  </div>

                  {/* Big Clean Connect Button */}
                  <Button
                    size="sm"
                    variant={isConnected ? "outline" : "default"}
                    className={cn(
                      "h-8.5 px-4 text-xs font-semibold rounded-xl shadow-sm transition-all duration-200 pointer-events-none group-hover:shadow-md",
                      !isConnected && "bg-primary text-primary-foreground hover:bg-primary/90 shadow-primary/25"
                    )}
                  >
                    {isConnected ? (
                      <>
                        <Pencil className="w-3.5 h-3.5 mr-1" /> Configure
                      </>
                    ) : (
                      <>
                        <Plus className="w-3.5 h-3.5 mr-1" /> Connect
                      </>
                    )}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Connected Integrations & Active Servers Section (Below Directory) */}
      <div className="pt-6 border-t border-border/50 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <h4 className="text-lg font-bold text-foreground">Connected Integrations & Active Servers</h4>
            <Badge variant="outline" className="bg-emerald-500/10 text-emerald-400 border-emerald-500/30 text-xs gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
              {connectedCount} Connected
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground">
            Active integrations automatically attach live tool capabilities to your AI agents
          </p>
        </div>

        {connectedCount === 0 ? (
          <Card className="border-dashed border-border/60 bg-card/30">
            <CardContent className="flex flex-col items-center justify-center py-10 text-center space-y-3">
              <div className="h-12 w-12 rounded-2xl bg-muted/60 flex items-center justify-center text-muted-foreground">
                <Database className="h-6 w-6" />
              </div>
              <div className="max-w-md space-y-1">
                <h5 className="font-semibold text-sm text-foreground">No servers connected yet</h5>
                <p className="text-xs text-muted-foreground">
                  Select any card above (Shopify, WooCommerce, Salla, MyFatoorah, Supabase, or Higgsfield) and click "Connect" to activate live store tools.
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
                        <CardTitle className="text-sm font-bold text-foreground">Higgsfield AI Studio</CardTitle>
                        <CardDescription className="text-xs truncate max-w-[180px]">
                          {higgsfieldAccount || "BYO Generation Connected"}
                        </CardDescription>
                      </div>
                    </div>

                    <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px] gap-1 py-0 h-5">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      Connected
                    </Badge>
                  </div>
                </CardHeader>

                <CardContent className="p-4 pt-0 space-y-3">
                  <div className="p-2.5 rounded-xl bg-muted/40 text-[11px] text-muted-foreground flex items-center justify-between">
                    <span>Quota: BYO Direct Billing</span>
                    <span className="font-medium text-emerald-400">Zero Postora Credits</span>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-border/40">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs font-semibold text-emerald-500 border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 gap-1.5"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>Connected</span>
                    </Button>

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={disconnectHiggsfield}
                      disabled={higgsfieldBusy}
                      className="h-8 text-xs text-rose-500 hover:text-rose-600 hover:bg-rose-500/10"
                    >
                      <Unlink className="w-3.5 h-3.5 mr-1" /> Disconnect
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {/* Configured Database & E-Commerce Tools Cards */}
            {tools.map((tool) => {
              const preset = CONNECTOR_DIRECTORY.find((p) => p.id === tool.connector_type) || CONNECTOR_DIRECTORY[0];

              return (
                <Card key={tool.id} className="border-emerald-500/30 bg-gradient-to-b from-emerald-500/10 via-card/85 to-card/60 backdrop-blur-xl shadow-sm">
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
                            {preset.title}
                          </CardDescription>
                        </div>
                      </div>

                      <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px] gap-1 py-0 h-5">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        Connected
                      </Badge>
                    </div>
                  </CardHeader>

                  <CardContent className="p-4 pt-0 space-y-3">
                    <div className="p-2.5 rounded-xl bg-muted/40 text-[11px] text-muted-foreground flex items-center justify-between">
                      <span className="font-mono truncate max-w-[160px]">{tool.url || "API Endpoint"}</span>
                      <span className="font-medium text-emerald-400">{tool.is_enabled ? "Active Tool" : "Disabled"}</span>
                    </div>

                    <div className="flex items-center justify-between pt-2 border-t border-border/40">
                      {/* Green Connected Mark & Button */}
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleCardClick(preset)}
                        className="h-8 text-xs font-semibold text-emerald-500 border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 gap-1.5 cursor-pointer"
                      >
                        <Check className="w-3.5 h-3.5 stroke-[3]" />
                        <span>Connected</span>
                      </Button>

                      <div className="flex items-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => handleCardClick(preset)}
                          className="h-8 text-xs text-muted-foreground hover:text-foreground"
                        >
                          <Pencil className="w-3 h-3 mr-1" /> Edit
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-rose-500 hover:text-rose-600 hover:bg-rose-500/10"
                          onClick={() => {
                            if (confirm(`Are you sure you want to disconnect '${tool.name}'?`)) {
                              deleteTool.mutate(tool.id, {
                                onSuccess: () => toast.success(`Connector '${tool.name}' disconnected`),
                              });
                            }
                          }}
                        >
                          <Trash2 className="h-3.5 h-3.5" />
                        </Button>
                      </div>
                    </div>
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
                          Authorized OAuth App
                        </CardDescription>
                      </div>
                    </div>

                    <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px] gap-1 py-0 h-5">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      Authorized
                    </Badge>
                  </div>
                </CardHeader>

                <CardContent className="p-4 pt-0 space-y-3">
                  <div className="p-2.5 rounded-xl bg-muted/40 text-[11px] text-muted-foreground flex items-center justify-between">
                    <span>Scopes: {client.scopes?.join(", ") || "Full Access"}</span>
                    <span className="font-medium text-emerald-400">Active Token</span>
                  </div>

                  <div className="flex items-center justify-between pt-2 border-t border-border/40">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-8 text-xs font-semibold text-emerald-500 border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 gap-1.5"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>Connected</span>
                    </Button>

                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (confirm(`Are you sure you want to revoke access for ${client.name}?`)) {
                          handleRevokeOAuth(client.id, client.name);
                        }
                      }}
                      className="h-8 text-xs text-rose-500 hover:text-rose-600 hover:bg-rose-500/10"
                    >
                      <Unlink className="w-3.5 h-3.5 mr-1" /> Revoke
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
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <div className="flex items-center gap-3.5">
              {selectedPreset && (
                <div className="relative shrink-0 w-14 h-14 rounded-2xl bg-secondary/80 backdrop-blur-sm flex items-center justify-center border border-border/50 shadow-md">
                  <ConnectorBrandLogo id={selectedPreset.id} className="w-8 h-8 drop-shadow-sm" />
                </div>
              )}
              <div>
                <DialogTitle className="text-lg flex items-center gap-2">
                  <span>{selectedPreset?.title || "Connector Configuration"}</span>
                  {(editingTool || (selectedPreset?.id === "higgsfield" && higgsfieldConnected)) && (
                    <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px]">
                      Connected
                    </Badge>
                  )}
                  {selectedPreset?.supportsMcp && (
                    <Badge variant="outline" className="bg-violet-500/10 text-violet-400 border-violet-500/30 text-[10px]">
                      ⚡ MCP Enabled
                    </Badge>
                  )}
                </DialogTitle>
                <DialogDescription className="text-xs mt-0.5">
                  {selectedPreset?.description || "Configure credentials and tool calling parameters."}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          {/* Special OAuth UI for Higgsfield */}
          {selectedPreset?.id === "higgsfield" ? (
            <div className="space-y-4 pt-3">
              <div className="p-4 rounded-xl border border-border/60 bg-muted/20 space-y-3">
                <div className="flex items-center justify-between">
                  <div>
                    <h4 className="font-semibold text-sm text-foreground">Direct Higgsfield OAuth Authentication</h4>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Connect your personal Higgsfield account with 1-click. All generation is billed to Higgsfield and does not consume Postora quota.
                    </p>
                  </div>
                  {higgsfieldConnected && (
                    <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-xs">
                      Active
                    </Badge>
                  )}
                </div>

                {higgsfieldConnected && higgsfieldAccount && (
                  <p className="text-xs font-mono text-emerald-400 bg-emerald-500/10 p-2 rounded-lg border border-emerald-500/20">
                    Connected Account: {higgsfieldAccount}
                  </p>
                )}
              </div>

              <div className="flex items-center justify-between pt-4 border-t border-border/40">
                <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)} className="text-xs h-8">
                  Cancel
                </Button>

                {higgsfieldConnected ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={disconnectHiggsfield}
                    disabled={higgsfieldBusy}
                    className="text-xs h-8 text-rose-500 border-rose-500/30 hover:bg-rose-500/10"
                  >
                    {higgsfieldBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin mr-1" /> : <Unlink className="w-3.5 h-3.5 mr-1" />}
                    <span>Disconnect Account</span>
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={connectHiggsfield}
                    disabled={higgsfieldBusy}
                    className="text-xs h-8 gap-1.5 bg-rose-600 hover:bg-rose-700 text-white"
                  >
                    {higgsfieldBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
                    <span>Connect with Higgsfield</span>
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <>
              {/* Modal Tabs */}
              <Tabs value={modalTab} onValueChange={(v: any) => setModalTab(v)} className="w-full mt-2">
                <TabsList className="grid grid-cols-3 w-full bg-muted/60 h-9 p-1">
                  <TabsTrigger value="credentials" className="text-xs">
                    Credentials & API
                  </TabsTrigger>
                  <TabsTrigger value="mcp" disabled={!selectedPreset?.supportsMcp} className="text-xs">
                    Model Context Protocol (MCP)
                  </TabsTrigger>
                  <TabsTrigger value="overview" className="text-xs">
                    Security & Isolation
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
                      <Label className="text-xs">Tool Name (Unique Identifier)</Label>
                      <Input
                        value={form.name}
                        onChange={(e) => setForm({ ...form, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") })}
                        placeholder="e.g. shopify_store"
                        className="font-mono text-xs h-9"
                      />
                    </div>

                    <div className="space-y-1.5">
                      <Label className="text-xs">Connector Type</Label>
                      <Select
                        value={form.connector_type}
                        onValueChange={(val) => setForm({ ...form, connector_type: val as ConnectorType })}
                      >
                        <SelectTrigger className="h-9 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CONNECTOR_DIRECTORY.map((d) => (
                            <SelectItem key={d.id} value={d.id} className="text-xs">
                              {d.title}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs">API Endpoint / Webhook URL</Label>
                    <Input
                      value={form.url}
                      onChange={(e) => setForm({ ...form, url: e.target.value })}
                      placeholder="https://your-store.com/api/..."
                      className="font-mono text-xs h-9"
                    />
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs">
                      API Key / Secret Token {editingHasSecret && "(Stored securely)"}
                    </Label>
                    <Input
                      type="password"
                      value={form.secret}
                      onChange={(e) => {
                        setForm({ ...form, secret: e.target.value });
                        if (clearSecret) setClearSecret(false);
                      }}
                      placeholder={editingHasSecret ? "•••••••••••••••• (Leave blank to keep existing secret)" : "Enter API Key or Secret"}
                      className="text-xs h-9"
                    />
                    {editingHasSecret && (
                      <div className="flex items-center gap-2 pt-1">
                        <Checkbox
                          id="clear-secret-chk"
                          checked={clearSecret}
                          onCheckedChange={(c) => setClearSecret(Boolean(c))}
                        />
                        <Label htmlFor="clear-secret-chk" className="text-xs text-muted-foreground cursor-pointer">
                          Remove stored secret from database
                        </Label>
                      </div>
                    )}
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs">AI Tool Prompt & Trigger Instructions</Label>
                    <Textarea
                      rows={2}
                      value={form.description}
                      onChange={(e) => setForm({ ...form, description: e.target.value })}
                      placeholder="Explain when the AI agent should call this tool..."
                      className="text-xs leading-relaxed resize-none"
                    />
                  </div>

                  {/* Capability Permissions */}
                  <div className="p-3 rounded-xl border border-border/60 bg-muted/20 space-y-2.5">
                    <Label className="text-xs font-semibold text-foreground">Capability Permissions</Label>
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="perm-search"
                          checked={form.permission_search_products}
                          onCheckedChange={(c) => setForm({ ...form, permission_search_products: Boolean(c) })}
                        />
                        <Label htmlFor="perm-search" className="text-xs cursor-pointer">
                          Search Products
                        </Label>
                      </div>

                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="perm-stock"
                          checked={form.permission_check_stock}
                          onCheckedChange={(c) => setForm({ ...form, permission_check_stock: Boolean(c) })}
                        />
                        <Label htmlFor="perm-stock" className="text-xs cursor-pointer">
                          Check Stock
                        </Label>
                      </div>

                      <div className="flex items-center gap-2">
                        <Checkbox
                          id="perm-orders"
                          checked={form.permission_lookup_orders}
                          onCheckedChange={(c) => setForm({ ...form, permission_lookup_orders: Boolean(c) })}
                        />
                        <Label htmlFor="perm-orders" className="text-xs cursor-pointer">
                          Lookup Orders
                        </Label>
                      </div>
                    </div>
                  </div>

                  {/* Toggles */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                    <div className="flex items-center justify-between p-2.5 rounded-xl border border-border/60 bg-muted/10">
                      <div className="space-y-0.5">
                        <Label className="text-xs font-medium">Read-Only Guard</Label>
                        <p className="text-[10px] text-muted-foreground">Disallows any write operations</p>
                      </div>
                      <Switch
                        checked={form.read_only_mode}
                        onCheckedChange={(c) => setForm({ ...form, read_only_mode: c })}
                      />
                    </div>

                    <div className="flex items-center justify-between p-2.5 rounded-xl border border-border/60 bg-muted/10">
                      <div className="space-y-0.5">
                        <Label className="text-xs font-medium">Smart Cache</Label>
                        <p className="text-[10px] text-muted-foreground">Caches repeated product queries</p>
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
                  <h4 className="font-semibold text-xs text-foreground">Auto-Approved MCP Connection</h4>
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  This connector supports the official Model Context Protocol. You can connect it directly to Claude Desktop, Cursor, Windsurf, or Antigravity agents without needing admin review.
                </p>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs">MCP Server Configuration JSON</Label>
                  <Button variant="ghost" size="sm" onClick={copyMcpConfig} className="h-7 text-xs gap-1">
                    {copiedMcp ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedMcp ? "Copied" : "Copy JSON"}</span>
                  </Button>
                </div>
                <pre className="p-3 rounded-xl bg-muted/60 border border-border/60 text-[11px] font-mono overflow-x-auto text-foreground">
                  {mcpConfigSnippet}
                </pre>
              </div>

              <div className="pt-2">
                <Button onClick={handleMcpInstantActivate} className="w-full gap-2 text-xs bg-violet-600 hover:bg-violet-700">
                  <Zap className="w-4 h-4" />
                  <span>Activate & Connect with MCP Auto-Auth</span>
                </Button>
              </div>
            </TabsContent>

            {/* TAB 3: Security & Multi-Tenant Isolation */}
            <TabsContent value="overview" className="space-y-3 pt-3">
              <div className="p-3.5 rounded-xl border border-border/60 bg-muted/20 space-y-3 text-xs">
                <div className="flex items-start gap-2.5">
                  <ShieldCheck className="w-4 h-4 text-emerald-400 shrink-0 mt-0.5" />
                  <div>
                    <h5 className="font-semibold text-foreground">Multi-Tenant Store Isolation</h5>
                    <p className="text-muted-foreground mt-0.5">
                      Your store credentials, API keys, and cache records are strictly isolated under your user identifier (<code className="font-mono text-[10px] bg-background px-1 py-0.5 rounded">{profile?.id || "uid"}</code>).
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-2.5">
                  <Lock className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
                  <div>
                    <h5 className="font-semibold text-foreground">Read-Only Guardrails</h5>
                    <p className="text-muted-foreground mt-0.5">
                      By default, AI agent tool calling is locked in read-only mode to prevent unintended stock or order modifications.
                    </p>
                  </div>
                </div>

                <div className="flex items-start gap-2.5">
                  <Clock className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                  <div>
                    <h5 className="font-semibold text-foreground">Automated Quota Billing</h5>
                    <p className="text-muted-foreground mt-0.5">
                      Tool requests execute directly under your account subscription quota with zero manual admin approval delays.
                    </p>
                  </div>
                </div>
              </div>
            </TabsContent>
          </Tabs>

          {/* Modal Footer */}
          <div className="flex items-center justify-between pt-4 border-t border-border/40 mt-2">
            <div>
              {editingTool && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    if (confirm(`Are you sure you want to disconnect '${editingTool.name}'?`)) {
                      deleteTool.mutate(editingTool.id, {
                        onSuccess: () => {
                          toast.success("Connector removed");
                          setDialogOpen(false);
                        },
                      });
                    }
                  }}
                  className="text-rose-500 hover:text-rose-600 hover:bg-rose-500/10 text-xs h-8"
                >
                  <Trash2 className="w-3.5 h-3.5 mr-1" /> Disconnect
                </Button>
              )}
            </div>

            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setDialogOpen(false)} className="text-xs h-8">
                Cancel
              </Button>
              <Button size="sm" onClick={handleSave} disabled={upsertTool.isPending} className="text-xs h-8 gap-1.5">
                {upsertTool.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                <span>{editingTool ? "Save Changes" : "Save & Connect"}</span>
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
