import { useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { useWhatsAppBroadcasts } from "@/hooks/useWhatsAppBroadcasts";
import { BroadcastStatus } from "./BroadcastStatus";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useMessagingAccounts } from "@/hooks/useMessaging";
import { Plus, Send, Trash2, Loader2, Radio, Users, AlertTriangle } from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

interface Contact {
  id: string;
  phone_number: string;
  name: string | null;
}

function broadcastStatusLabel(status: string, t: (key: string, fallback: string) => string) {
  switch (status) {
    case "pending":
      return t("status.pending", "pending");
    case "sending":
      return t("status.sending", "sending");
    case "completed":
      return t("status.completed", "completed");
    case "failed":
      return t("status.failed", "failed");
    default:
      return status;
  }
}

export function BroadcastManager() {
  const { t } = useTranslation("whatsapp");
  const { broadcasts, isLoading, createBroadcast, sendBroadcast, deleteBroadcast } = useWhatsAppBroadcasts();
  const { accounts } = useMessagingAccounts();
  const waAccount = accounts.find((a) => a.platform === "whatsapp");
  const [createOpen, setCreateOpen] = useState(false);
  const [confirmSendId, setConfirmSendId] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState("");
  const [templateName, setTemplateName] = useState("");
  const [selectedContacts, setSelectedContacts] = useState<Set<string>>(new Set());
  const [filterGroup, setFilterGroup] = useState<string>("all");

  // Fetch contacts
  const { data: contacts = [] } = useQuery({
    queryKey: ["whatsapp-contacts-broadcast"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("whatsapp_contacts" as any)
        .select("id, phone_number, name")
        .order("name", { ascending: true });
      if (error) throw error;
      return (data || []) as unknown as Contact[];
    },
  });

  // Fetch templates
  const { data: templates = [] } = useQuery({
    queryKey: ["whatsapp-templates-broadcast", waAccount?.id],
    queryFn: async () => {
      if (!waAccount) return [];
      const { data, error } = await supabase
        .from("whatsapp_message_templates" as any)
        .select("*")
        .eq("status", "APPROVED");
      if (error) throw error;
      return (data || []) as any[];
    },
    enabled: !!waAccount,
  });

  // Fetch groups
  const { data: groups = [] } = useQuery({
    queryKey: ["whatsapp-groups-broadcast"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("whatsapp_contact_groups" as any)
        .select("id, name");
      if (error) throw error;
      return (data || []) as any[];
    },
  });

  // Fetch group members when group filter selected
  const { data: groupMembers = [] } = useQuery({
    queryKey: ["whatsapp-group-members", filterGroup],
    queryFn: async () => {
      if (filterGroup === "all") return [];
      const { data, error } = await supabase
        .from("whatsapp_contact_group_members" as any)
        .select("contact_id")
        .eq("group_id", filterGroup);
      if (error) throw error;
      return (data || []).map((m: any) => m.contact_id as string);
    },
    enabled: filterGroup !== "all",
  });

  const filteredContacts = filterGroup === "all"
    ? contacts
    : contacts.filter((c) => groupMembers.includes(c.id));

  const toggleContact = (id: string) => {
    const next = new Set(selectedContacts);
    if (next.has(id)) next.delete(id); else next.add(id);
    setSelectedContacts(next);
  };

  const selectAll = () => {
    if (selectedContacts.size === filteredContacts.length) {
      setSelectedContacts(new Set());
    } else {
      setSelectedContacts(new Set(filteredContacts.map((c) => c.id)));
    }
  };

  const handleCreate = () => {
    const contactList = filteredContacts
      .filter((c) => selectedContacts.has(c.id))
      .map((c) => ({ id: c.id, phone: c.phone_number }));

    createBroadcast.mutate(
      {
        name,
        template_name: templateName,
        template_components: { language: "en_US" },
        contact_ids: contactList,
      },
      {
        onSuccess: () => {
          setCreateOpen(false);
          setName("");
          setTemplateName("");
          setSelectedContacts(new Set());
          setFilterGroup("all");
        },
      }
    );
  };

  if (!waAccount) {
    return (
      <div className="py-12 text-center text-muted-foreground">
        <Radio className="h-12 w-12 mx-auto mb-4 opacity-50" />
        <p>{t("empty.noAccount", "No WhatsApp Business account connected.")}</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{t("broadcast.hint", "Send approved templates to multiple contacts at once")}</p>
        <Dialog open={createOpen} onOpenChange={setCreateOpen}>
          <DialogTrigger asChild>
            <Button><Plus className="h-4 w-4 me-2" />{t("broadcast.new", "New Broadcast")}</Button>
          </DialogTrigger>
          <DialogContent className="max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
            <DialogHeader>
              <DialogTitle>{t("broadcast.createTitle", "Create Broadcast")}</DialogTitle>
              <DialogDescription>{t("broadcast.createDesc", "Send an approved template to selected contacts")}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4 flex-1 overflow-y-auto pe-1">
              <div>
                <Label>{t("broadcast.campaignName", "Campaign Name")}</Label>
                <Input placeholder={t("broadcast.namePlaceholder", "e.g. January Promo")} value={name} onChange={(e) => setName(e.target.value)} />
              </div>

              <div>
                <Label>{t("broadcast.template", "Template")}</Label>
                <Select value={templateName} onValueChange={setTemplateName}>
                  <SelectTrigger><SelectValue placeholder={t("broadcast.templatePlaceholder", "Select approved template")} /></SelectTrigger>
                  <SelectContent>
                    {templates.map((tmpl: any) => (
                      <SelectItem key={tmpl.id || tmpl.name} value={tmpl.name}>{tmpl.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {templates.length === 0 && (
                  <p className="text-xs text-muted-foreground mt-1">{t("broadcast.noApprovedTemplates", "No approved templates. Sync templates first.")}</p>
                )}
              </div>

              <div>
                <Label>{t("broadcast.filterGroup", "Filter by Group")}</Label>
                <Select value={filterGroup} onValueChange={(v) => { setFilterGroup(v); setSelectedContacts(new Set()); }}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t("broadcast.allContacts", "All Contacts")}</SelectItem>
                    {groups.map((g: any) => (
                      <SelectItem key={g.id} value={g.id}>{g.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <div className="flex items-center justify-between mb-2">
                  <Label>{t("broadcast.recipients", "Recipients ({{count}} selected)", { count: selectedContacts.size })}</Label>
                  <Button variant="ghost" size="sm" onClick={selectAll}>
                    {selectedContacts.size === filteredContacts.length ? t("broadcast.deselectAll", "Deselect All") : t("broadcast.selectAll", "Select All")}
                  </Button>
                </div>
                {selectedContacts.size > 1000 && (
                  <div className="flex items-center gap-2 p-2 rounded-md bg-destructive/10 text-destructive text-sm mb-2">
                    <AlertTriangle className="h-4 w-4 shrink-0" />
                    {t("broadcast.maxRecipients", "Max 1000 recipients per broadcast")}
                  </div>
                )}
                <ScrollArea className="h-[200px] rounded-md border p-2">
                  {filteredContacts.length === 0 ? (
                    <p className="text-sm text-muted-foreground text-center py-4">{t("broadcast.noContacts", "No contacts found")}</p>
                  ) : (
                    <div className="space-y-1">
                      {filteredContacts.map((c) => (
                        <label
                          key={c.id}
                          className="flex items-center gap-3 p-2 rounded-md hover:bg-secondary/50 cursor-pointer"
                        >
                          <Checkbox
                            checked={selectedContacts.has(c.id)}
                            onCheckedChange={() => toggleContact(c.id)}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium truncate">{c.name || c.phone_number}</p>
                            {c.name && <p className="text-xs text-muted-foreground font-mono">{c.phone_number}</p>}
                          </div>
                        </label>
                      ))}
                    </div>
                  )}
                </ScrollArea>
              </div>
            </div>
            <DialogFooter className="pt-4">
              <Button
                onClick={handleCreate}
                disabled={!name || !templateName || selectedContacts.size === 0 || selectedContacts.size > 1000 || createBroadcast.isPending}
                className="w-full"
              >
                {createBroadcast.isPending ? <Loader2 className="h-4 w-4 me-2 animate-spin" /> : <Users className="h-4 w-4 me-2" />}
                {t("broadcast.createCount", "Create Broadcast ({{count}} recipients)", { count: selectedContacts.size })}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {/* Confirm send dialog */}
      <Dialog open={!!confirmSendId} onOpenChange={(open) => !open && setConfirmSendId(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("broadcast.sendConfirm", "Send Broadcast?")}</DialogTitle>
            <DialogDescription>
              {t("broadcast.sendConfirmDesc", "This will send the template to all recipients. This action cannot be undone.")}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmSendId(null)}>{t("common:cancel", "Cancel")}</Button>
            <Button
              onClick={() => {
                if (confirmSendId) {
                  sendBroadcast.mutate(confirmSendId);
                  setConfirmSendId(null);
                }
              }}
              disabled={sendBroadcast.isPending}
            >
              {sendBroadcast.isPending ? <Loader2 className="h-4 w-4 me-2 animate-spin" /> : <Send className="h-4 w-4 me-2" />}
              {t("broadcast.confirmSend", "Confirm Send")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : broadcasts.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Radio className="h-8 w-8 mx-auto mb-2 opacity-50" />
            <p>{t("broadcast.empty", "No broadcasts yet. Create one to send templates to multiple contacts.")}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {broadcasts.map((b) => (
            <div key={b.id}>
              {expandedId === b.id ? (
                <div className="space-y-2">
                  <BroadcastStatus broadcast={b} />
                  <Button variant="ghost" size="sm" onClick={() => setExpandedId(null)}>{t("broadcast.collapse", "Collapse")}</Button>
                </div>
              ) : (
                <Card className="cursor-pointer hover:border-primary/30 transition-colors" onClick={() => setExpandedId(b.id)}>
                  <CardContent className="flex items-center justify-between py-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <Radio className="h-5 w-5 text-muted-foreground shrink-0" />
                      <div className="min-w-0">
                        <p className="font-medium truncate">{b.name}</p>
                        <p className="text-xs text-muted-foreground">
                          {t("broadcast.subtitle", "{{template}} · {{count}} recipients · {{date}}", { template: b.template_name, count: b.recipient_count, date: new Date(b.created_at).toLocaleDateString() })}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0" onClick={(e) => e.stopPropagation()}>
                      <Badge variant={
                        b.status === "completed" ? "default" :
                        b.status === "sending" ? "secondary" :
                        b.status === "failed" ? "destructive" : "outline"
                      }>
                        {broadcastStatusLabel(b.status, t)}
                      </Badge>
                      {b.status === "pending" && (
                        <>
                          <Button size="sm" onClick={() => setConfirmSendId(b.id)} disabled={sendBroadcast.isPending}>
                            <Send className="h-3 w-3 me-1" />{t("broadcast.send", "Send")}
                          </Button>
                          <Button size="sm" variant="ghost" onClick={() => deleteBroadcast.mutate(b.id)}>
                            <Trash2 className="h-3 w-3" />
                          </Button>
                        </>
                      )}
                    </div>
                  </CardContent>
                </Card>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
