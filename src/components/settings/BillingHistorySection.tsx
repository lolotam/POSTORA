import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useSubscription } from "@/hooks/useSubscription";
import { supabase } from "@/integrations/supabase/client";
import { format } from "date-fns";
import {
  Receipt,
  Download,
  ExternalLink,
  FileText,
  Loader2,
  AlertCircle,
} from "lucide-react";

interface Invoice {
  id: string;
  number: string | null;
  amount_paid: number;
  currency: string;
  status: string | null;
  created: string;
  invoice_pdf: string | null;
  hosted_invoice_url: string | null;
}

export function BillingHistorySection() {
  const { t } = useTranslation("accounts");
  const { subscription } = useSubscription();
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (subscription?.stripe_customer_id) {
      fetchInvoices();
    } else {
      setIsLoading(false);
    }
  }, [subscription?.stripe_customer_id]);

  const fetchInvoices = async () => {
    if (!subscription?.stripe_customer_id) return;

    setIsLoading(true);
    setError(null);

    try {
      const { data, error: funcError } = await supabase.functions.invoke(
        "stripe-manage-subscription",
        {
          body: {
            action: "invoices",
            customer_id: subscription.stripe_customer_id,
          },
        }
      );

      if (funcError) throw funcError;

      if (data?.invoices) {
        setInvoices(data.invoices);
      }
    } catch (err) {
      console.error("Error fetching invoices:", err);
      setError(err instanceof Error ? err.message : t("billing.errors.loadFailed", "Failed to load invoices"));
    } finally {
      setIsLoading(false);
    }
  };

  const getStatusBadge = (status: string | null) => {
    switch (status) {
      case "paid":
        return (
          <Badge className="bg-green-500/10 text-green-600 border-green-500/30">
            {t("billing.status.paid", "Paid")}
          </Badge>
        );
      case "open":
        return (
          <Badge variant="outline" className="text-amber-600 border-amber-500/30">
            {t("billing.status.open", "Open")}
          </Badge>
        );
      case "void":
        return <Badge variant="secondary">{t("billing.status.void", "Void")}</Badge>;
      case "uncollectible":
        return <Badge variant="destructive">{t("billing.status.uncollectible", "Uncollectible")}</Badge>;
      default:
        return <Badge variant="secondary">{status || t("common:unknown", "Unknown")}</Badge>;
    }
  };

  if (!subscription) {
    return (
      <div className="rounded-xl border border-border bg-card/50 p-6">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-lg bg-muted flex items-center justify-center">
            <Receipt className="w-5 h-5 text-muted-foreground" />
          </div>
          <div>
            <h2 className="font-semibold">{t("billing.header.title", "Billing History")}</h2>
            <p className="text-sm text-muted-foreground">{t("billing.header.subtitle", "View past invoices and payments")}</p>
          </div>
        </div>
        <p className="text-muted-foreground text-sm">
          {t("billing.empty.subscribe", "Subscribe to a plan to view your billing history.")}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-card/50 p-6">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
            <Receipt className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="font-semibold">{t("billing.header.title", "Billing History")}</h2>
            <p className="text-sm text-muted-foreground">{t("billing.header.subtitle", "View past invoices and payments")}</p>
          </div>
        </div>
        <Button variant="ghost" size="sm" onClick={fetchInvoices} disabled={isLoading}>
          {isLoading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            t("common:refresh", "Refresh")
          )}
        </Button>
      </div>

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center justify-between p-3 rounded-lg bg-muted/50">
              <div className="flex items-center gap-3">
                <Skeleton className="w-8 h-8 rounded" />
                <div className="space-y-1">
                  <Skeleton className="h-4 w-32" />
                  <Skeleton className="h-3 w-24" />
                </div>
              </div>
              <Skeleton className="h-8 w-20" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-destructive/10 text-destructive">
          <AlertCircle className="w-5 h-5" />
          <p className="text-sm">{error}</p>
        </div>
      ) : invoices.length === 0 ? (
        <div className="text-center py-8">
          <FileText className="w-12 h-12 mx-auto text-muted-foreground mb-3" />
          <p className="text-muted-foreground">{t("billing.empty.none", "No invoices yet")}</p>
          <p className="text-sm text-muted-foreground">
            {t("billing.empty.hint", "Your invoices will appear here after your first payment.")}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {invoices.map((invoice) => (
            <div
              key={invoice.id}
              className="flex items-center justify-between p-3 rounded-lg bg-muted/30 hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-lg bg-background flex items-center justify-center">
                  <FileText className="w-5 h-5 text-muted-foreground" />
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium">
                      {invoice.number || t("billing.invoice", "Invoice")}
                    </span>
                    {getStatusBadge(invoice.status)}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {format(new Date(invoice.created), "MMMM d, yyyy")} •{" "}
                    <span className="font-medium">
                      ${invoice.amount_paid.toFixed(2)} {invoice.currency.toUpperCase()}
                    </span>
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                {invoice.invoice_pdf && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => window.open(invoice.invoice_pdf!, "_blank")}
                    className="gap-1"
                  >
                    <Download className="w-4 h-4" />
                    <span className="hidden sm:inline">{t("billing.actions.pdf", "PDF")}</span>
                  </Button>
                )}
                {invoice.hosted_invoice_url && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => window.open(invoice.hosted_invoice_url!, "_blank")}
                    className="gap-1"
                  >
                    <ExternalLink className="w-4 h-4" />
                    <span className="hidden sm:inline">{t("common:view", "View")}</span>
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
