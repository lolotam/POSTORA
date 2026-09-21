import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useWhatsAppWebhooks, WhatsAppWebhook } from "@/hooks/useWhatsAppWebhooks";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";
import { Plus, Trash2, TestTube, Globe, Clock, AlertTriangle, Loader2, Pencil } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

export function WebhookManager() {
  const { t } = useTranslation("inbox");
  const { webhooks, isLoading, createWebhook, updateWebhook, deleteWebhook, testWebhook } = useWhatsAppWebhooks();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingWebhook, setEditingWebhook] = useState<WhatsAppWebhook | null>(null);
  const [form, setForm] = useState({ name: "", url: "", secret: "" });

  const resetForm = () => {
    setForm({ name: "", url: "", secret: "" });
    setEditingWebhook(null);
  };

  const handleSubmit = () => {
    if (!form.name || !form.url) return;
    if (editingWebhook) {
      updateWebhook.mutate({ id: editingWebhook.id, name: form.name, url: form.url, secret: form.secret || null } as any, {
        onSuccess: () => { setDialogOpen(false); resetForm(); },
      });
    } else {
      createWebhook.mutate(form, {
        onSuccess: () => { setDialogOpen(false); resetForm(); },
      });
    }
  };

  const openEdit = (wh: WhatsAppWebhook) => {
    setEditingWebhook(wh);
    setForm({ name: wh.name, url: wh.url, secret: wh.secret || "" });
    setDialogOpen(true);
  };

  if (isLoading) {
    return <div className="flex justify-center py-12"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>;
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-semibold">{t("webhook.title", "External Webhooks")}</h3>
          <p className="text-sm text-muted-foreground">{t("webhook.subtitle", "Forward inbound messages to Zapier, Make, HubSpot, or any URL")}</p>
        </div>
        <Dialog open={dialogOpen} onOpenChange={(o) => { setDialogOpen(o); if (!o) resetForm(); }}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-1.5"><Plus className="w-4 h-4" />{t("webhook.add", "Add Webhook")}</Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{editingWebhook ? t("webhook.edit", "Edit Webhook") : t("webhook.add", "Add Webhook")}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>{t("webhook.name", "Name")}</Label>
                <Input placeholder={t("webhook.namePlaceholder", "e.g. Zapier - New Lead")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>{t("webhook.url", "Webhook URL")}</Label>
                <Input placeholder={t("webhook.urlPlaceholder", "https://hooks.zapier.com/...")} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
              </div>
              <div className="space-y-2">
                <Label>{t("webhook.secret", "Signing Secret")} <span className="text-muted-foreground">{t("webhook.optional", "(optional)")}</span></Label>
                <Input placeholder={t("webhook.secretPlaceholder", "HMAC-SHA256 secret for payload verification")} value={form.secret} onChange={(e) => setForm({ ...form, secret: e.target.value })} />
                <p className="text-xs text-muted-foreground">{t("webhook.secretHint", "If set, payloads are signed with X-Webhook-Signature header")}</p>
              </div>
              <Button onClick={handleSubmit} disabled={!form.name || !form.url || createWebhook.isPending || updateWebhook.isPending} className="w-full">
                {(createWebhook.isPending || updateWebhook.isPending) && <Loader2 className="w-4 h-4 mr-2 animate-spin" />}
                {editingWebhook ? t("common:saveChanges", "Save Changes") : t("webhook.create", "Create Webhook")}
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {webhooks.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Globe className="w-12 h-12 text-muted-foreground mb-3" />
            <h4 className="font-medium">{t("webhook.empty", "No webhooks configured")}</h4>
            <p className="text-sm text-muted-foreground mt-1">{t("webhook.emptyHint", "Add a webhook to forward inbound messages to external services")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {webhooks.map((wh) => (
            <Card key={wh.id}>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <CardTitle className="text-base">{wh.name}</CardTitle>
                    <Badge variant={wh.is_active ? "default" : "secondary"}>
                      {wh.is_active ? t("common:active", "Active") : t("common:disabled", "Disabled")}
                    </Badge>
                    {wh.failure_count >= 5 && (
                      <Badge variant="destructive" className="gap-1">
                        <AlertTriangle className="w-3 h-3" />{t("webhook.failures", "{{count}} failures", { count: wh.failure_count })}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Switch checked={wh.is_active} onCheckedChange={(checked) => updateWebhook.mutate({ id: wh.id, is_active: checked } as any)} />
                  </div>
                </div>
                <CardDescription className="font-mono text-xs truncate">{wh.url}</CardDescription>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4 text-xs text-muted-foreground">
                    {wh.last_triggered_at && (
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        {t("webhook.lastTriggered", "Last triggered {{time}}", { time: formatDistanceToNow(new Date(wh.last_triggered_at), { addSuffix: true }) })}
                      </span>
                    )}
                    {wh.last_status_code && (
                      <Badge variant={wh.last_status_code < 300 ? "outline" : "destructive"} className="text-xs">
                        HTTP {wh.last_status_code}
                      </Badge>
                    )}
                    {wh.secret && <Badge variant="outline" className="text-xs">{t("webhook.hmac", "HMAC signed")}</Badge>}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" onClick={() => testWebhook.mutate(wh)} disabled={testWebhook.isPending}>
                      <TestTube className="w-4 h-4 mr-1" />{t("webhook.test", "Test")}
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => openEdit(wh)}>
                      <Pencil className="w-4 h-4" />
                    </Button>
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button variant="ghost" size="sm"><Trash2 className="w-4 h-4 text-destructive" /></Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>{t("webhook.deleteConfirm", "Delete webhook?")}</AlertDialogTitle>
                          <AlertDialogDescription>{t("webhook.deleteDesc", "This will permanently remove \"{{name}}\" and stop forwarding messages.", { name: wh.name })}</AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t("common:cancel", "Cancel")}</AlertDialogCancel>
                          <AlertDialogAction onClick={() => deleteWebhook.mutate(wh.id)}>{t("common:delete", "Delete")}</AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
