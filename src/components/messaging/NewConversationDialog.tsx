import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { useAuth } from "@/hooks/useAuth";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Search, MessageSquare, User, Loader2 } from "lucide-react";
import type { Conversation } from "@/hooks/useMessaging";

interface NewConversationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  socialAccountId: string;
  onSelectContact: (conversation: Conversation) => void;
}

export function NewConversationDialog({ open, onOpenChange, socialAccountId, onSelectContact }: NewConversationDialogProps) {
  const { t } = useTranslation("inbox");
  const { session } = useAuth();
  const [search, setSearch] = useState("");

  const { data: contacts = [], isLoading } = useQuery({
    queryKey: ["whatsapp-contacts", session?.user?.id],
    queryFn: async () => {
      const { data, error } = await supabase.from("whatsapp_contacts").select("*").order("display_name", { ascending: true });
      if (error) throw error;
      return data || [];
    },
    enabled: !!session?.user?.id && open,
  });

  const filtered = contacts.filter((c: any) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return c.display_name?.toLowerCase().includes(s) || c.phone_number.includes(s) || c.email?.toLowerCase().includes(s);
  });

  const handleSelect = (contact: any) => {
    const conversationId = `wa_${socialAccountId}_${contact.phone_number}`;
    const conversation: Conversation = {
      id: conversationId,
      participant_name: contact.display_name || contact.phone_number,
      participant_id: contact.phone_number,
      participant_avatar: contact.avatar_url ?? null,
      last_message: "",
      last_message_time: new Date().toISOString(),
      last_message_from: "",
      unread_count: 0,
      updated_time: new Date().toISOString(),
    };

    onSelectContact(conversation);
    onOpenChange(false);
    setSearch("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <MessageSquare className="h-5 w-5 text-green-600" />
            {t("newConversation.title", "New Conversation")}
          </DialogTitle>
        </DialogHeader>
        <div className="relative">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder={t("conversation.searchContacts", "Search contacts by name or phone...")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="ps-9"
            autoFocus
          />
        </div>
        <ScrollArea className="h-[300px]">
          {isLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
            </div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <User className="h-8 w-8 mx-auto mb-2 opacity-50" />
              <p className="text-sm">{t("newConversation.noContacts", "No contacts found")}</p>
              <p className="text-xs mt-1">{t("newConversation.addInContacts", "Add contacts in the Contacts tab first")}</p>
            </div>
          ) : (
            <div className="divide-y">
              {filtered.map((contact: any) => (
                <button
                  key={contact.id}
                  onClick={() => handleSelect(contact)}
                  className="w-full flex items-center gap-3 px-3 py-3 hover:bg-muted/50 transition-colors text-start"
                >
                  <div className="h-9 w-9 rounded-full bg-green-500/10 flex items-center justify-center shrink-0">
                    <User className="h-4 w-4 text-green-600" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{contact.display_name || contact.phone_number}</p>
                    <p className="text-xs text-muted-foreground font-mono">{contact.phone_number}</p>
                  </div>
                  {contact.company && (
                    <span className="text-xs text-muted-foreground truncate max-w-[100px]">{contact.company}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
