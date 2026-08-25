import { useState } from "react";
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
  ArrowRight,
  Lock,
  Clock,
  ShieldAlert,
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useAiAgentTools, type AiAgentTool, type AiAgentToolInput, type ConnectorType } from "@/hooks/useAiAgentTools";
import { validateAiToolName, validateAiToolUrl } from "@/lib/aiTools";
import { cn } from "@/lib/utils";

interface ConnectorPreset {
  id: ConnectorType;
  name: string;
  category: "database" | "ecommerce" | "formula" | "webhook";
  title: string;
  description: string;
  defaultUrl: string;
  suggestedPrompt: string;
  icon: typeof Database;
  defaultPermissions: {
    searchProducts: boolean;
    checkStock: boolean;
    lookupOrders: boolean;
  };
}

const CONNECTOR_PRESETS: ConnectorPreset[] = [
  {
    id: "supabase",
    name: "supabase_product_catalog",
    category: "database",
    title: "Supabase (Self-Hosted / Cloud)",
    description: "Direct REST / RPC connection to your Supabase product catalog and inventory tables.",
    defaultUrl: "https://api.postora.cloud/rest/v1/products",
    suggestedPrompt: "Query store database for products matching customer query, including name, price, stock status, and product URLs.",
    icon: Database,
    defaultPermissions: { searchProducts: true, checkStock: true, lookupOrders: false },
  },
  {
    id: "woocommerce",
    name: "woocommerce_store",
    category: "ecommerce",
    title: "WooCommerce Store",
    description: "Official WooCommerce REST API integration to fetch live products, variations, prices, and orders.",
    defaultUrl: "https://your-store.com/wp-json/wc/v3/products",
    suggestedPrompt: "Search WooCommerce catalog for products, fetch prices, check live stock, and look up customer orders.",
    icon: ShoppingBag,
    defaultPermissions: { searchProducts: true, checkStock: true, lookupOrders: true },
  },
  {
    id: "shopify",
    name: "shopify_storefront",
    category: "ecommerce",
    title: "Shopify Storefront / Admin",
    description: "Connect to Shopify Storefront API to query collections, products, stock levels, and order tracking.",
    defaultUrl: "https://your-shop.myshopify.com/api/2024-01/graphql.json",
    suggestedPrompt: "Query Shopify products, check available inventory, and retrieve order fulfillment status.",
    icon: ShoppingBag,
    defaultPermissions: { searchProducts: true, checkStock: true, lookupOrders: true },
  },
  {
    id: "salla",
    name: "salla_merchant_api",
    category: "ecommerce",
    title: "Salla (سلة)",
    description: "Connect to Salla Merchant API for Middle East e-commerce product and order synchronization.",
    defaultUrl: "https://api.salla.dev/admin/v2/products",
    suggestedPrompt: "Search Salla store products, check quantities, and check order shipping status.",
    icon: ShoppingBag,
    defaultPermissions: { searchProducts: true, checkStock: true, lookupOrders: true },
  },
  {
    id: "zid",
    name: "zid_merchant_api",
    category: "ecommerce",
    title: "Zid (زد)",
    description: "Connect to Zid API for product catalog search, inventory inquiry, and order fulfillment.",
    defaultUrl: "https://api.zid.sa/v1/managers/store/products",
    suggestedPrompt: "Search Zid store products, stock levels, and customer order updates.",
    icon: ShoppingBag,
    defaultPermissions: { searchProducts: true, checkStock: true, lookupOrders: true },
  },
  {
    id: "formula",
    name: "pricing_calculator",
    category: "formula",
    title: "Formulas & Price Calculator",
    description: "Computes custom quotes, shipping costs, bulk discounts, or taxes based on user input.",
    defaultUrl: "https://n8n.yourdomain.com/webhook/quote-calculator",
    suggestedPrompt: "Compute pricing quotes, delivery estimates, or discounts based on product quantity and dimensions.",
    icon: Calculator,
    defaultPermissions: { searchProducts: false, checkStock: false, lookupOrders: false },
  },
  {
    id: "mysql_postgres",
    name: "sql_database_api",
    category: "database",
    title: "PostgreSQL / MySQL REST API",
    description: "Connect to custom SQL databases through Prisma, Hasura, Directus, or PostgREST.",
    defaultUrl: "https://api.yourdomain.com/sql/products",
    suggestedPrompt: "Query relational database tables for product attributes, stock status, and pricing.",
    icon: Server,
    defaultPermissions: { searchProducts: true, checkStock: true, lookupOrders: false },
  },
  {
    id: "custom_rest",
    name: "custom_rest_webhook",
    category: "webhook",
    title: "Custom REST API / n8n Workflow",
    description: "Connects to any external REST endpoint or n8n automation workflow to fetch live business data.",
    defaultUrl: "https://n8n.yourdomain.com/webhook/ai-agent-tool",
    suggestedPrompt: "Call custom internal workflow to perform actions or lookup specific records.",
    icon: Globe,
    defaultPermissions: { searchProducts: true, checkStock: false, lookupOrders: false },
  },
];

const emptyForm = {
  name: "",
  description: "",
  url: "",
  secret: "",
  is_enabled: true,
  admin_only: false,
  connector_type: "supabase" as ConnectorType,
  permission_search_products: true,
  permission_check_stock: true,
  permission_lookup_orders: false,
  read_only_mode: true,
  enable_cache: true,
};

export function DatabaseConnectorsManager() {
  const { tools, isLoading, upsertTool, deleteTool } = useAiAgentTools();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editingHasSecret, setEditingHasSecret] = useState(false);
  const [clearSecret, setClearSecret] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState<string | null>(null);

  const openCreate = () => {
    setForm(emptyForm);
    setEditingName(null);
    setEditingHasSecret(false);
    setClearSecret(false);
    setFormError(null);
    setDialogOpen(true);
  };

  const applyPreset = (preset: ConnectorPreset) => {
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
    setEditingName(null);
    setEditingHasSecret(false);
    setClearSecret(false);
    setFormError(null);
    setPresetDialogOpen(false);
    setDialogOpen(true);
  };

  const openEdit = (tool: AiAgentTool) => {
    setForm({
      name: tool.name,
      description: tool.description,
      url: tool.url || "",
      // Never pre-fill a stored secret; the placeholder tells the user one exists.
      secret: "",
      is_enabled: tool.is_enabled,
      admin_only: tool.admin_only,
      connector_type: tool.connector_type,
      permission_search_products: tool.permissions?.search_products ?? false,
      permission_check_stock: tool.permissions?.check_stock ?? false,
      permission_lookup_orders: tool.permissions?.lookup_orders ?? false,
      read_only_mode: tool.read_only_mode,
      enable_cache: tool.enable_cache,
    });
    setEditingName(tool.name);
    setEditingHasSecret(tool.has_secret);
    setClearSecret(false);
    setFormError(null);
    setDialogOpen(true);
  };

  const save = () => {
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
    // Omitting `secret` keeps the stored value server-side; a non-empty value
    // replaces it, and clear_secret explicitly removes it.
    if (form.secret.trim() !== "") {
      payload.secret = form.secret.trim();
    } else if (editingName && editingHasSecret && clearSecret) {
      payload.clear_secret = true;
    }

    upsertTool.mutate(payload, {
      onSuccess: () => {
        toast.success(editingName ? "Connector updated successfully" : "Database connector connected to AI agent");
        setDialogOpen(false);
      },
      onError: (mutationError) => setFormError(mutationError.message),
    });
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
      {/* Header & Quick Action */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h3 className="text-lg font-bold text-foreground">Database & E-Commerce Connectors</h3>
            <Badge variant="outline" className="border-primary/30 text-primary bg-primary/10 text-xs">
              Live AI Data Tools
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground mt-1">
            Connect Supabase, SQL databases, WooCommerce, Shopify, or formulas. Attached tools are shared across messaging inboxes and comments automation.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setPresetDialogOpen(true)}
            className="gap-1.5 border-border/60 hover:bg-muted/50"
          >
            <Sparkles className="h-4 w-4 text-primary" />
            <span>Preset Integrations</span>
          </Button>

          <Button size="sm" onClick={openCreate} className="gap-1.5">
            <Plus className="h-4 w-4" />
            <span>New Connector</span>
          </Button>
        </div>
      </div>

      {/* Live Tool Calling Chat Indicator Preview */}
      <div className="bg-gradient-to-r from-primary/10 via-primary/5 to-transparent border border-primary/20 rounded-2xl p-4 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="h-9 w-9 rounded-xl bg-primary/20 flex items-center justify-center text-primary shrink-0">
            <Search className="h-4 w-4 animate-pulse" />
          </div>
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">Live Chat UX Indicator</p>
            <p className="text-sm text-foreground">
              When a customer asks for live store data, the chat displays: <span className="font-semibold italic text-primary">"🔍 AI Assistant is searching the database..."</span>
            </p>
          </div>
        </div>
        <Badge variant="secondary" className="hidden sm:inline-flex text-xs">
          Automatic Tool Calling
        </Badge>
      </div>

      {/* Connectors List */}
      {tools.length === 0 ? (
        <Card className="border-dashed border-border/60 bg-card/40">
          <CardContent className="flex flex-col items-center justify-center py-12 text-center space-y-4">
            <div className="h-12 w-12 rounded-2xl bg-muted flex items-center justify-center text-muted-foreground">
              <Database className="h-6 w-6" />
            </div>
            <div className="max-w-md space-y-1">
              <h4 className="font-semibold text-foreground">No Database Connectors configured yet</h4>
              <p className="text-sm text-muted-foreground">
                Connect your Supabase product tables, WooCommerce / Shopify store APIs, or custom calculation formulas so your AI agent can answer customers with live pricing and stock.
              </p>
            </div>
            <div className="flex gap-2 pt-2">
              <Button size="sm" onClick={() => setPresetDialogOpen(true)} variant="outline" className="gap-1.5">
                <Sparkles className="h-4 w-4 text-primary" />
                <span>Browse Presets</span>
              </Button>
              <Button size="sm" onClick={openCreate} className="gap-1.5">
                <Plus className="h-4 w-4" />
                <span>Add Connector</span>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {tools.map((tool) => (
            <Card key={tool.id} className="border-border/50 bg-card/60 backdrop-blur-sm shadow-sm hover:border-primary/40 transition-all duration-200">
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary">
                      <Database className="h-4 w-4" />
                    </div>
                    <div>
                      <CardTitle className="text-base font-bold font-mono">{tool.name}</CardTitle>
                      <CardDescription className="text-xs truncate max-w-[220px]">
                        {tool.url || "Webhook endpoint"}
                      </CardDescription>
                    </div>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <Badge variant="outline" className="text-[10px]">
                      {CONNECTOR_PRESETS.find((p) => p.id === tool.connector_type)?.title || "Custom REST"}
                    </Badge>
                    <Badge variant={tool.is_enabled ? "default" : "secondary"} className="text-[10px]">
                      {tool.is_enabled ? "Active Tool" : "Disabled"}
                    </Badge>
                    {tool.admin_only && (
                      <Badge variant="outline" className="text-[10px] border-amber-500/40 text-amber-400">
                        Admin Only
                      </Badge>
                    )}
                  </div>
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-xs text-muted-foreground line-clamp-2 leading-relaxed">
                  {tool.description}
                </p>

                <div className="flex items-center justify-between pt-2 border-t border-border/40 text-xs">
                  <span className="text-muted-foreground font-mono truncate max-w-[180px]">
                    {tool.has_secret ? "🔒 Protected Webhook" : "🔓 Public Endpoint"}
                  </span>

                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="icon" className="h-8 w-8 text-muted-foreground hover:text-foreground" onClick={() => openEdit(tool)}>
                      <Pencil className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-rose-500 hover:text-rose-600 hover:bg-rose-500/10"
                      onClick={() => {
                        if (confirm(`Are you sure you want to delete the connector '${tool.name}'? This action cannot be undone.`)) {
                          deleteTool.mutate(tool.id, {
                            onSuccess: () => toast.success(`Connector '${tool.name}' removed`),
                          });
                        }
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Preset Picker Dialog */}
      <Dialog open={presetDialogOpen} onOpenChange={setPresetDialogOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-primary" />
              <span>Choose a Connector Integration</span>
            </DialogTitle>
            <DialogDescription>
              Select your store platform or database engine to pre-fill configuration settings and AI tool schemas.
            </DialogDescription>
          </DialogHeader>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2">
            {CONNECTOR_PRESETS.map((preset) => {
              const Icon = preset.icon;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => applyPreset(preset)}
                  className="p-4 rounded-xl border border-border/60 bg-card/60 hover:bg-primary/5 hover:border-primary/50 text-left cursor-pointer transition-all duration-200 space-y-2 group w-full"
                >
                  <div className="flex items-center justify-between">
                    <div className="h-8 w-8 rounded-lg bg-primary/10 flex items-center justify-center text-primary group-hover:scale-105 transition-transform">
                      <Icon className="h-4 w-4" />
                    </div>
                    <ArrowRight className="h-4 w-4 text-muted-foreground group-hover:text-primary group-hover:translate-x-0.5 transition-all" />
                  </div>
                  <div>
                    <h4 className="font-semibold text-sm text-foreground">{preset.title}</h4>
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                      {preset.description}
                    </p>
                  </div>
                </button>
              );
            })}
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit / Create Connector Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Database className="h-5 w-5 text-primary" />
              <span>{editingName ? `Edit '${editingName}'` : "Connect Store / Database Tool"}</span>
            </DialogTitle>
            <DialogDescription>
              Configure database query endpoints, store APIs, or custom formulas for the AI Agent.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4 pt-2">
            {/* Store / DB Type Selector */}
            <div className="space-y-1.5">
              <Label>Store / Database Engine</Label>
              <Select
                value={form.connector_type}
                onValueChange={(val) => setForm((c) => ({ ...c, connector_type: val as ConnectorType }))}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select platform" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="supabase">Supabase (Self-Hosted / Cloud)</SelectItem>
                  <SelectItem value="woocommerce">WooCommerce REST API</SelectItem>
                  <SelectItem value="shopify">Shopify Storefront / Admin</SelectItem>
                  <SelectItem value="salla">Salla (سلة)</SelectItem>
                  <SelectItem value="zid">Zid (زد)</SelectItem>
                  <SelectItem value="mysql_postgres">PostgreSQL / MySQL REST API</SelectItem>
                  <SelectItem value="formula">Pricing & Formula Engine</SelectItem>
                  <SelectItem value="custom_rest">Custom REST API / n8n</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tool-name">
                Tool Identifier <span className="text-rose-500">*</span>
              </Label>
              <Input
                id="tool-name"
                value={form.name}
                onChange={(e) => setForm((c) => ({ ...c, name: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, "_") }))}
                placeholder="e.g. search_products"
                disabled={!!editingName}
                className="font-mono text-sm"
              />
              <p className="text-[11px] text-muted-foreground">
                Lowercase letters, numbers, and underscores only. The AI refers to this identifier during tool execution.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tool-description">
                AI Tool Prompt & Instructions <span className="text-rose-500">*</span>
              </Label>
              <Textarea
                id="tool-description"
                value={form.description}
                onChange={(e) => setForm((c) => ({ ...c, description: e.target.value }))}
                placeholder="Explain clearly what data this connector retrieves so the AI knows when to trigger it..."
                rows={3}
                className="text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tool-url">
                API Endpoint URL / Webhook <span className="text-rose-500">*</span>
              </Label>
              <Input
                id="tool-url"
                value={form.url || ""}
                onChange={(e) => setForm((c) => ({ ...c, url: e.target.value }))}
                placeholder="https://api.yourdomain.com/products or n8n webhook URL"
                className="font-mono text-xs"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="tool-secret">Secret Token (Passed in X-Webhook-Secret header)</Label>
              <Input
                id="tool-secret"
                type="password"
                value={form.secret || ""}
                onChange={(e) => setForm((c) => ({ ...c, secret: e.target.value }))}
                placeholder={editingName && editingHasSecret
                  ? "A secret is saved — leave blank to keep it"
                  : "Optional shared secret for verification"}
                className="font-mono text-xs"
              />
              {editingName && editingHasSecret && (
                <label className="flex items-center gap-2 text-xs text-muted-foreground cursor-pointer">
                  <Checkbox
                    checked={clearSecret}
                    onCheckedChange={(checked) => setClearSecret(!!checked)}
                    aria-label="Remove the saved secret"
                  />
                  <span>Remove the saved secret</span>
                </label>
              )}
            </div>

            {/* Permissions Checklist */}
            <div className="space-y-2 pt-2 border-t border-border/40">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Access Permissions & Capabilities
              </Label>
              <div className="grid grid-cols-1 gap-2 text-xs">
                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={form.permission_search_products}
                    onCheckedChange={(checked) => setForm((c) => ({ ...c, permission_search_products: !!checked }))}
                  />
                  <span>Search Products, Specifications, and Pricing (البحث عن المنتجات والأسعار)</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={form.permission_check_stock}
                    onCheckedChange={(checked) => setForm((c) => ({ ...c, permission_check_stock: !!checked }))}
                  />
                  <span>Check Live Stock & Inventory Availability (فحص المخزون والتوفر)</span>
                </label>

                <label className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={form.permission_lookup_orders}
                    onCheckedChange={(checked) => setForm((c) => ({ ...c, permission_lookup_orders: !!checked }))}
                  />
                  <span>Order Status, Tracking, and Fulfillment (الاستعلام عن حالة الطلب والشحن)</span>
                </label>
              </div>
            </div>

            {/* Security & Best Practices */}
            <div className="space-y-2 pt-2 border-t border-border/40">
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Security & Optimization
              </Label>
              <div className="grid grid-cols-1 gap-2 text-xs text-muted-foreground">
                <div className="flex items-center justify-between p-2 rounded-lg bg-muted/40 border border-border/40">
                  <div className="flex items-center gap-2">
                    <Lock className="w-3.5 h-3.5 text-primary" />
                    <span>Read-Only Mode & Multi-Tenant Isolation</span>
                  </div>
                  <Switch
                    checked={form.read_only_mode}
                    onCheckedChange={(checked) => setForm((c) => ({ ...c, read_only_mode: checked }))}
                    aria-label="Read-only mode"
                  />
                </div>

                <div className="flex items-center justify-between p-2 rounded-lg bg-muted/40 border border-border/40">
                  <div className="flex items-center gap-2">
                    <Clock className="w-3.5 h-3.5 text-primary" />
                    <span>In-Memory Cache (TTL: 5m)</span>
                  </div>
                  <Switch
                    checked={form.enable_cache}
                    onCheckedChange={(checked) => setForm((c) => ({ ...c, enable_cache: checked }))}
                  />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-border/40">
              <div className="space-y-0.5">
                <Label htmlFor="tool-enabled" className="text-sm font-medium">Enable Tool</Label>
                <p className="text-xs text-muted-foreground">Attach to AI agent across all channels</p>
              </div>
              <Switch
                id="tool-enabled"
                checked={form.is_enabled}
                onCheckedChange={(checked) => setForm((c) => ({ ...c, is_enabled: checked }))}
              />
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-border/40">
              <div className="space-y-0.5">
                <Label htmlFor="tool-admin-only" className="text-sm font-medium">Admin Only</Label>
                <p className="text-xs text-muted-foreground">Restrict tool execution to workspace admins</p>
              </div>
              <Switch
                id="tool-admin-only"
                checked={form.admin_only}
                onCheckedChange={(checked) => setForm((c) => ({ ...c, admin_only: checked }))}
              />
            </div>

            {formError && (
              <div className="p-3 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-400 text-xs">
                {formError}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-4 border-t border-border/40">
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={save} disabled={upsertTool.isPending} className="gap-1.5">
                {upsertTool.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                <span>{editingName ? "Update Connector" : "Connect to AI Agent"}</span>
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
