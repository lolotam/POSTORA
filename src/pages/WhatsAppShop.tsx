import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { Navigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ShoppingBag, Plus, Package, DollarSign, Eye, Edit, Trash2 } from "lucide-react";
import { toast } from "@/hooks/use-toast";
import { Icon3D, GradientHeading, GradientRingCard, GradientDivider, Reveal } from "@/components/fx";
import type { GradientKey } from "@/components/fx";

interface Product {
  id: string;
  name: string;
  description: string;
  price: string;
  currency: string;
  imageUrl: string;
  status: "active" | "draft";
}

export default function WhatsAppShop() {
  const { t } = useTranslation("whatsapp");
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  const [products, setProducts] = useState<Product[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [newProduct, setNewProduct] = useState({ name: "", description: "", price: "", imageUrl: "" });

  // Kept above the feature-flag redirect: a hook after an early return is skipped
  // whenever that branch is taken, so the hook order changes when the flag flips
  // and React throws "rendered fewer hooks than expected".
  const stats = useMemo(() => ({
    total: products.length,
    active: products.filter((p) => p.status === "active").length,
    draft: products.filter((p) => p.status === "draft").length,
  }), [products]);

  if (!flagsLoading && !flags.whatsappShop) {
    return <Navigate to="/dashboard" replace />;
  }

  const handleCreate = () => {
    if (!newProduct.name || !newProduct.price) return;
    const product: Product = {
      id: crypto.randomUUID(),
      name: newProduct.name,
      description: newProduct.description,
      price: newProduct.price,
      currency: "USD",
      imageUrl: newProduct.imageUrl,
      status: "draft",
    };
    setProducts((prev) => [product, ...prev]);
    setCreateOpen(false);
    setNewProduct({ name: "", description: "", price: "", imageUrl: "" });
    toast({ title: t("shop.productAdded", "Product added"), description: t("shop.productAddedDesc", "Product saved as draft. Connect WhatsApp Commerce API to sync.") });
  };

  const handleDelete = (id: string) => {
    setProducts((prev) => prev.filter((p) => p.id !== id));
    toast({ title: t("shop.productRemoved", "Product removed") });
  };

  const handleToggleStatus = (id: string) => {
    setProducts((prev) =>
      prev.map((p) => (p.id === id ? { ...p, status: p.status === "active" ? "draft" : "active" } : p))
    );
  };

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto space-y-6">
        {/* Header */}
        <Reveal>
          <div className="flex items-center justify-between flex-wrap gap-4">
            <div className="group flex items-center gap-4 min-w-0">
              <Icon3D icon={ShoppingBag} variant="emerald" size="md" />
              <div className="flex-1 min-w-0">
                <GradientHeading preset="emerald-cyan-sky" size="lg" as="h1">{t("shop.title", "WhatsApp Shop")}</GradientHeading>
                <p className="text-sm text-muted-foreground mt-1">{t("shop.subtitle", "Manage your product catalog for WhatsApp Commerce")}</p>
              </div>
            </div>
          <Dialog open={createOpen} onOpenChange={setCreateOpen}>
            <DialogTrigger asChild>
              <Button size="sm" className="bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 text-white hover:opacity-90">
                <Plus className="h-4 w-4 mr-1" /> {t("shop.addProduct", "Add Product")}
              </Button>
            </DialogTrigger>
            <DialogContent className="bg-card/85 backdrop-blur-xl border-border/50">
              <DialogHeader>
                <DialogTitle className="flex items-center gap-3">
                  <span className="group inline-flex"><Icon3D icon={Package} variant="emerald" size="sm" /></span>
                  {t("shop.addProduct", "Add Product")}
                </DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                <div className="space-y-1.5">
                  <Label>{t("shop.name", "Product Name")}</Label>
                  <Input value={newProduct.name} onChange={(e) => setNewProduct({ ...newProduct, name: e.target.value })} placeholder={t("shop.namePlaceholder", "Product name")} />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("shop.description", "Description")}</Label>
                  <Textarea value={newProduct.description} onChange={(e) => setNewProduct({ ...newProduct, description: e.target.value })} placeholder={t("shop.descriptionPlaceholder", "Product description...")} />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("shop.priceUsd", "Price (USD)")}</Label>
                  <Input type="number" value={newProduct.price} onChange={(e) => setNewProduct({ ...newProduct, price: e.target.value })} placeholder="9.99" />
                </div>
                <div className="space-y-1.5">
                  <Label>{t("shop.imageUrl", "Image URL")}</Label>
                  <Input value={newProduct.imageUrl} onChange={(e) => setNewProduct({ ...newProduct, imageUrl: e.target.value })} placeholder="https://..." />
                </div>
                <Button onClick={handleCreate} disabled={!newProduct.name || !newProduct.price} className="w-full bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 text-white hover:opacity-90">
                  {t("shop.addProduct", "Add Product")}
                </Button>
              </div>
            </DialogContent>
          </Dialog>
          </div>
        </Reveal>
        <GradientDivider tone="emerald" />

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4">
          {([
            { id: "total", label: t("shop.totalProducts", "Total Products"), value: stats.total, icon: Package, variant: "emerald" as GradientKey },
            { id: "active", label: t("shop.active", "Active"), value: stats.active, icon: Eye, variant: "sky" as GradientKey },
            { id: "draft", label: t("shop.draft", "Draft"), value: stats.draft, icon: Edit, variant: "amber" as GradientKey },
          ]).map((s, i) => (
            <Reveal key={s.id} delay={i * 60}>
              <div className="group rounded-2xl border border-border/40 bg-card/60 backdrop-blur-md p-4 flex items-center gap-3 transition-transform hover:-translate-y-0.5">
                <Icon3D icon={s.icon} variant={s.variant} size="sm" />
                <div>
                  <p className="text-xs text-muted-foreground">{s.label}</p>
                  <p className="text-lg font-semibold">{s.value}</p>
                </div>
              </div>
            </Reveal>
          ))}
        </div>

        {/* Products table */}
        <Reveal delay={120}>
        <GradientRingCard variant="emerald" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="overflow-hidden">
          <div className="p-6 pb-3">
            <div className="flex items-center gap-2 text-base font-semibold">
              <Package className="h-4 w-4 text-emerald-500" />
              {t("shop.productCatalog", "Product Catalog")}
            </div>
            <p className="text-sm text-muted-foreground mt-1">{t("shop.productCatalogHint", "Products will sync to WhatsApp Commerce when connected.")}</p>
          </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("shop.product", "Product")}</TableHead>
                  <TableHead>{t("shop.price", "Price")}</TableHead>
                  <TableHead>{t("shop.status", "Status")}</TableHead>
                  <TableHead className="text-right">{t("shop.actions", "Actions")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {products.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-muted-foreground py-12">
                      <div className="group inline-flex mb-3"><Icon3D icon={ShoppingBag} variant="emerald" size="lg" /></div>
                      <p className="font-medium mt-2">{t("shop.empty", "No products yet")}</p>
                      <p className="text-sm mt-1">{t("shop.emptyHint", "Add products to your WhatsApp catalog.")}</p>
                    </TableCell>
                  </TableRow>
                ) : (
                  products.map((p) => (
                    <TableRow key={p.id}>
                      <TableCell>
                        <div className="flex items-center gap-3">
                          {p.imageUrl && (
                            <img src={p.imageUrl} alt={p.name} className="w-10 h-10 rounded object-cover" />
                          )}
                          <div>
                            <p className="font-medium text-sm">{p.name}</p>
                            {p.description && <p className="text-xs text-muted-foreground truncate max-w-[200px]">{p.description}</p>}
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className="tabular-nums">${parseFloat(p.price).toFixed(2)}</TableCell>
                      <TableCell>
                        <Badge
                          variant={p.status === "active" ? "default" : "secondary"}
                          className={p.status === "active"
                            ? "cursor-pointer bg-gradient-to-r from-emerald-500 to-teal-500 text-white border-0 hover:opacity-90"
                            : "cursor-pointer bg-card/60 backdrop-blur border border-border/40"}
                          onClick={() => handleToggleStatus(p.id)}
                        >
                          {p.status === "active" ? t("shop.statusActive", "active") : t("shop.statusDraft", "draft")}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <Button size="icon" variant="ghost" className="h-8 w-8 text-rose-500 hover:bg-rose-500/10" onClick={() => handleDelete(p.id)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
        </GradientRingCard>
        </Reveal>

        <Reveal delay={180}>
          <GradientRingCard variant="emerald" hoverLift={false} ringIntensity="subtle">
            <div className="flex items-start gap-3">
              <span className="group inline-flex shrink-0"><Icon3D icon={DollarSign} variant="emerald" size="sm" /></span>
              <div>
                <h3 className="text-sm font-semibold">{t("shop.commerceTitle", "WhatsApp Commerce Integration")}</h3>
                <p className="text-sm text-muted-foreground mt-1">
                  {t("shop.commerceHint", "To fully sync products with WhatsApp, you'll need to connect a Facebook Commerce catalog via the Meta Business Suite. Products added here will be synced once the Commerce API is connected.")}
                </p>
              </div>
            </div>
          </GradientRingCard>
        </Reveal>
      </div>
    </DashboardLayout>
  );
}
