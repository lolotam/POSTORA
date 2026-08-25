import { useState, useMemo } from "react";
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
  Radio,
  Layers,
  Plug,
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
import { useAiAgentTools, type AiAgentTool, type AiAgentToolInput, type ConnectorType } from "@/hooks/useAiAgentTools";
import { validateAiToolName, validateAiToolUrl } from "@/lib/aiTools";
import { cn } from "@/lib/utils";

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
  icon: typeof Database;
  brandColor: string;
  iconBg: string;
  supportsMcp: boolean;
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
    icon: ShoppingBag,
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
    icon: ShoppingBag,
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
    icon: ShoppingBag,
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
    icon: ShoppingBag,
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
    icon: CreditCard,
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
    icon: CreditCard,
    brandColor: "text-indigo-500",
    iconBg: "bg-indigo-500/10 border-indigo-500/20 text-indigo-400",
    supportsMcp: false,
    defaultPermissions: { searchProducts: false, checkStock: false, lookupOrders: true },
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
    icon: Database,
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
    icon: Server,
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
    icon: Calculator,
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
    icon: Globe,
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
    icon: Zap,
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
    setModalTab(preset.supportsMcp ? "credentials" : "credentials");
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

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
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
            Connect your e-commerce stores, payment gateways, databases, and MCP servers. All tools are auto-authenticated using your account quotas.
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
                  "px-3 py-1.5 rounded-xl text-xs font-medium transition-all shrink-0 cursor-pointer border",
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

      {/* Connectors Grid (ChatGPT / Claude / Perplexity Style) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {filteredDirectory.map((preset) => {
          const Icon = preset.icon;
          const isConnected = configuredToolsMap.has(preset.id);
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
                "relative group flex flex-col justify-between p-4 rounded-2xl border transition-all duration-200 text-left cursor-pointer",
                isConnected
                  ? "bg-card/90 border-primary/40 shadow-md shadow-primary/5 hover:border-primary hover:shadow-lg"
                  : "bg-card/40 border-border/60 hover:bg-card/80 hover:border-border hover:shadow-sm"
              )}
            >
              <div>
                {/* Card Header: Icon & Status Badge */}
                <div className="flex items-start justify-between gap-2 mb-3">
                  <div
                    className={cn(
                      "w-11 h-11 rounded-xl flex items-center justify-center border transition-transform duration-200 group-hover:scale-105 shadow-sm",
                      preset.iconBg
                    )}
                  >
                    <Icon className="w-5 h-5" />
                  </div>

                  <div className="flex flex-col items-end gap-1">
                    {isConnected ? (
                      <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30 text-[10px] gap-1 py-0 h-5">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                        Connected
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-[10px] text-muted-foreground border-border/50 py-0 h-5">
                        {preset.categoryLabel}
                      </Badge>
                    )}

                    {preset.supportsMcp && (
                      <Badge variant="outline" className="bg-violet-500/10 text-violet-400 border-violet-500/30 text-[9px] py-0 h-4">
                        ⚡ MCP
                      </Badge>
                    )}
                  </div>
                </div>

                {/* Card Title & Description */}
                <h4 className="font-semibold text-sm text-foreground tracking-tight group-hover:text-primary transition-colors">
                  {preset.title}
                </h4>
                <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
                  {preset.shortDesc}
                </p>
              </div>

              {/* Card Footer: Action */}
              <div className="mt-4 pt-3 border-t border-border/40 flex items-center justify-between text-xs">
                <span className="text-[11px] text-muted-foreground">
                  {isConnected && tool?.is_enabled ? "Active AI Tool" : isConnected ? "Disabled" : "Available"}
                </span>

                <Button
                  size="sm"
                  variant={isConnected ? "outline" : "default"}
                  className="h-7 text-xs px-2.5 rounded-lg gap-1 pointer-events-none"
                >
                  {isConnected ? (
                    <>
                      <Pencil className="w-3 h-3" /> Configure
                    </>
                  ) : (
                    <>
                      <Plus className="w-3 h-3" /> Connect
                    </>
                  )}
                </Button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Interactive Detail & Connection Modal */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <div className="flex items-center gap-3">
              {selectedPreset && (
                <div className={cn("w-12 h-12 rounded-2xl flex items-center justify-center border shadow-sm", selectedPreset.iconBg)}>
                  <selectedPreset.icon className="w-6 h-6" />
                </div>
              )}
              <div>
                <DialogTitle className="text-lg flex items-center gap-2">
                  <span>{selectedPreset?.title || "Connector Configuration"}</span>
                  {editingTool && (
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
        </DialogContent>
      </Dialog>
    </div>
  );
}
