import { Trans, useTranslation } from "react-i18next";
import "@/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useWhatsAppCatalog, CatalogProduct } from "@/hooks/useWhatsAppCatalog";
import { Loader2, ShoppingBag, ExternalLink, Package, AlertTriangle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";

async function callMessagingApi(action: string, body: Record<string, unknown>) {
  let { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    const { data: refreshed } = await supabase.auth.refreshSession();
    session = refreshed.session;
    if (!session?.access_token) throw new Error("Not authenticated");
  }
  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  const url = `${supabaseUrl}/functions/v1/messaging-api`;
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}`, apikey: anonKey },
    body: JSON.stringify({ action, ...body }),
  };
  let res: Response | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(url, init);
      if (res.status !== 502 && res.status !== 503 && res.status !== 504) break;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  if (!res) throw (lastErr instanceof Error ? lastErr : new Error("Network error"));
  const data = await res.json().catch(() => ({ error: res!.statusText }));
  if (data.error_type) throw new Error(data.error);
  if (!res.ok) throw new Error(data.error || `API error ${res.status}`);
  return data;
}

export function WhatsAppCatalogContent() {
  const { t } = useTranslation("whatsapp");
  const { catalog, products, isLoading, error, waAccount } = useWhatsAppCatalog();
  const [sendingProduct, setSendingProduct] = useState<string | null>(null);

  if (!waAccount) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <ShoppingBag className="h-12 w-12 mx-auto mb-4 opacity-50" />
        <p>{t("empty.noAccount", "No WhatsApp Business account connected.")}</p>
      </div>
    );
  }

  if (isLoading) {
    return <div className="flex justify-center py-12"><Loader2 className="h-8 w-8 animate-spin text-muted-foreground" /></div>;
  }

  if (error) {
    const msg = (error as Error).message || "";
    const isSmbLimitation = /SMB business type|\(#10\)/i.test(msg);

    if (isSmbLimitation) {
      return (
        <Card className="border-amber-500/40 bg-amber-500/5">
          <CardContent className="py-8 px-6 text-center space-y-4">
            <div className="mx-auto w-12 h-12 rounded-full bg-amber-500/10 flex items-center justify-center">
              <AlertTriangle className="h-6 w-6 text-amber-600" />
            </div>
            <div className="space-y-2">
              <h3 className="text-lg font-semibold">{t("catalog.smbTitle", "Catalog not available for this account type")}</h3>
              <p className="text-sm text-muted-foreground max-w-md mx-auto">
                <Trans ns="whatsapp" i18nKey="catalog.smbBody" components={{ strong: <strong /> }}>
                  Your WhatsApp Business Account is registered as an{" "}
                  <strong>SMB (Small Business)</strong> account. Meta does not allow the
                  Catalog / Commerce API on SMB accounts — it's only available on{" "}
                  <strong>Enterprise</strong> WhatsApp Business Accounts linked to a
                  Commerce Catalog in Meta Business Manager.
                </Trans>
              </p>
            </div>
            <div className="text-xs text-muted-foreground bg-background/60 border border-border rounded-md p-3 max-w-md mx-auto text-start space-y-1">
              <p className="font-medium text-foreground">{t("catalog.enableHow", "How to enable catalog access:")}</p>
              <ol className="list-decimal list-inside space-y-1">
                <li>{t("catalog.enableStep1", "Open Meta Business Manager and convert / migrate your WABA to a regular Business account.")}</li>
                <li>{t("catalog.enableStep2", "Create a Commerce Catalog in Commerce Manager.")}</li>
                <li>{t("catalog.enableStep3", "Link the catalog to your WhatsApp Business Account.")}</li>
                <li>{t("catalog.enableStep4", "Reconnect WhatsApp here from the Profile tab.")}</li>
              </ol>
            </div>
            <Button variant="outline" size="sm" asChild>
              <a
                href="https://business.facebook.com/commerce"
                target="_blank"
                rel="noopener noreferrer"
              >
                {t("catalog.openCommerce", "Open Commerce Manager")}
                <ExternalLink className="h-3.5 w-3.5 ms-1.5" />
              </a>
            </Button>
          </CardContent>
        </Card>
      );
    }

    return (
      <div className="py-12 text-center text-muted-foreground">
        <ShoppingBag className="h-12 w-12 mx-auto mb-4 opacity-50" />
        <p>{t("catalog.loadFailed", "Could not load catalog. Make sure your WhatsApp Business Account has a catalog configured.")}</p>
        <p className="text-xs mt-2">{msg}</p>
      </div>
    );
  }

  if (!catalog?.catalog_id) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <ShoppingBag className="h-12 w-12 mx-auto mb-4 opacity-50" />
        <p>{t("catalog.noCatalog", "No catalog found for this WhatsApp Business Account.")}</p>
        <p className="text-sm mt-2">{t("catalog.noCatalogHint", "Set up a catalog in Meta Business Suite to get started.")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">{t("catalog.title", "Product Catalog")}</h3>
          <p className="text-sm text-muted-foreground">
            {products.length === 1
              ? t("catalog.countOne", "{{count}} product • Catalog ID: {{id}}", { count: products.length, id: catalog.catalog_id })
              : t("catalog.countMany", "{{count}} products • Catalog ID: {{id}}", { count: products.length, id: catalog.catalog_id })}
          </p>
        </div>
      </div>

      {products.length === 0 ? (
        <div className="py-12 text-center text-muted-foreground">
          <Package className="h-12 w-12 mx-auto mb-4 opacity-50" />
          <p>{t("catalog.empty", "No products in this catalog yet.")}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {products.map((product: CatalogProduct) => (
            <Card key={product.id} className="overflow-hidden">
              {product.image_url && (
                <div className="aspect-square bg-muted overflow-hidden">
                  <img
                    src={product.image_url}
                    alt={product.name}
                    className="w-full h-full object-cover"
                    loading="lazy"
                  />
                </div>
              )}
              <CardContent className="p-4 space-y-2">
                <h4 className="font-medium text-sm line-clamp-2">{product.name}</h4>
                {product.description && (
                  <p className="text-xs text-muted-foreground line-clamp-2">{product.description}</p>
                )}
                {product.price && (
                  <p className="text-sm font-bold">
                    {product.currency || ""} {product.price}
                  </p>
                )}
                <div className="flex gap-2 pt-1">
                  {product.url && (
                    <Button variant="ghost" size="sm" asChild>
                      <a href={product.url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-3 w-3 me-1" />
                        {t("common:view", "View")}
                      </a>
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
