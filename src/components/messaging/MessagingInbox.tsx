import { useState } from "react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Facebook, Camera, MessageSquare, Loader2, Plus, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link } from "react-router-dom";
import { AccountSelector } from "./AccountSelector";
import { ConversationList } from "./ConversationList";
import { ConversationDetail } from "./ConversationDetail";
import { WhatsAppSetup } from "./WhatsAppSetup";
import { WhatsAppDiagnostics } from "./WhatsAppDiagnostics";
import { NewConversationDialog } from "./NewConversationDialog";
import { LabelFilter } from "./ConversationLabels";
import { useMessagingAccounts, useConversations } from "@/hooks/useMessaging";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { useWhatsAppLabels } from "@/hooks/useWhatsAppLabels";
import type { Conversation } from "@/hooks/useMessaging";

interface MessagingInboxProps {
  platform?: "facebook" | "instagram" | "whatsapp";
}

export function MessagingInbox({ platform }: MessagingInboxProps) {
  const { flags } = useFeatureFlags();
  const { accounts, isLoading: accountsLoading } = useMessagingAccounts();
  const defaultTab = platform || (flags.msgFacebook ? "facebook" : flags.msgInstagram ? "instagram" : flags.msgWhatsapp ? "whatsapp" : "facebook");
  const [platformTab, setPlatformTab] = useState<"facebook" | "instagram" | "whatsapp">(defaultTab as any);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);

  const [newConvOpen, setNewConvOpen] = useState(false);
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const { assignments } = useWhatsAppLabels();

  const messagingPlatform = platformTab === "facebook" ? "MESSENGER" : platformTab === "instagram" ? "INSTAGRAM" : "WHATSAPP";
  const { data: conversations = [], isLoading: convsLoading, error: convsError } = useConversations(selectedAccountId, messagingPlatform);
  const igMissingScope = platformTab === "instagram"
    && convsError instanceof Error
    && /instagram_manage_messages|MISSING_SCOPE|PERMISSION_ERROR/i.test(convsError.message);

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
  const pageId = selectedAccount?.platform_user_id || "";

  const handleAccountChange = (id: string) => {
    setSelectedAccountId(id);
    setSelectedConversation(null);
  };

  const handleTabChange = (tab: string) => {
    setPlatformTab(tab as "facebook" | "instagram" | "whatsapp");
    setSelectedAccountId(null);
    setSelectedConversation(null);
  };

  if (accountsLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const whatsappAccounts = accounts.filter(a => a.platform === "whatsapp");

  return (
    <div className="space-y-4">
      <Tabs value={platformTab} onValueChange={handleTabChange}>
        {!platform && (
          <TabsList>
            {flags.msgFacebook && (
              <TabsTrigger value="facebook" className="gap-1.5">
                <Facebook className="w-4 h-4" />
                Facebook Messenger
              </TabsTrigger>
            )}
            {flags.msgInstagram && (
              <TabsTrigger value="instagram" className="gap-1.5">
                <Camera className="w-4 h-4" />
                Instagram DMs
              </TabsTrigger>
            )}
            {flags.msgWhatsapp && (
              <TabsTrigger value="whatsapp" className="gap-1.5">
                <MessageSquare className="w-4 h-4" />
                WhatsApp Business
              </TabsTrigger>
            )}
          </TabsList>
        )}

        {/* WhatsApp Tab */}
        <TabsContent value="whatsapp" className="mt-4 space-y-4">
          <WhatsAppSetup connectedAccounts={accounts} />

          {whatsappAccounts.length > 0 && (
            <>
              <div className="flex items-center justify-between mb-3">
                <AccountSelector
                  accounts={accounts}
                  selectedId={selectedAccountId}
                  onSelect={handleAccountChange}
                  platformFilter="whatsapp"
                />
                <Button size="sm" onClick={() => setNewConvOpen(true)} className="gap-1.5">
                  <Plus className="h-4 w-4" />
                  New Conversation
                </Button>
              </div>
              {selectedAccountId && (
                <>
                  <NewConversationDialog
                    open={newConvOpen}
                    onOpenChange={setNewConvOpen}
                    socialAccountId={selectedAccountId}
                    onSelectContact={setSelectedConversation}
                  />
                  <div className="border rounded-lg overflow-hidden flex h-[600px]">
                    <div className="w-80 border-r shrink-0 flex flex-col">
                      {platformTab === "whatsapp" && <LabelFilter selectedLabelId={labelFilter} onSelect={setLabelFilter} />}
                      <div className="flex-1 overflow-hidden">
                        <ConversationList
                          conversations={labelFilter ? conversations.filter(c => assignments.some(a => a.conversation_id === c.id && a.label_id === labelFilter)) : conversations}
                          selectedId={selectedConversation?.id || null}
                          onSelect={setSelectedConversation}
                          isLoading={convsLoading}
                          showLabels={platformTab === "whatsapp"}
                        />
                      </div>
                    </div>
                    <div className="flex-1">
                      <ConversationDetail
                        conversation={selectedConversation}
                        socialAccountId={selectedAccountId}
                        pageId={pageId}
                        platform="whatsapp"
                      />
                    </div>
                  </div>
                  <WhatsAppDiagnostics
                    socialAccountId={selectedAccountId}
                    phoneNumberId={selectedAccount?.platform_user_id || ""}
                  />
                </>
              )}
            </>
          )}
        </TabsContent>

        {/* Facebook & Instagram Tabs */}
        <TabsContent value="facebook" className="mt-4 space-y-4">
          <AccountSelector
            accounts={accounts}
            selectedId={selectedAccountId}
            onSelect={handleAccountChange}
            platformFilter="facebook"
          />
          {selectedAccountId && (
            <div className="border rounded-lg overflow-hidden flex h-[600px]">
              <div className="w-80 border-r shrink-0">
                <ConversationList
                  conversations={conversations}
                  selectedId={selectedConversation?.id || null}
                  onSelect={setSelectedConversation}
                  isLoading={convsLoading}
                />
              </div>
              <div className="flex-1">
                <ConversationDetail
                  conversation={selectedConversation}
                  socialAccountId={selectedAccountId}
                  pageId={pageId}
                />
              </div>
            </div>
          )}
        </TabsContent>

        <TabsContent value="instagram" className="mt-4 space-y-4">
          <AccountSelector
            accounts={accounts}
            selectedId={selectedAccountId}
            onSelect={handleAccountChange}
            platformFilter="instagram"
          />
          {igMissingScope && (
            <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
              <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-600 dark:text-amber-400 shrink-0" />
              <div className="flex-1">
                <p className="font-medium text-amber-700 dark:text-amber-300">Instagram DMs need an extra permission</p>
                <p className="text-amber-700/80 dark:text-amber-300/80 mt-0.5">
                  Reconnect your Instagram account and approve <code className="font-mono text-xs">instagram_manage_messages</code> so we can load your inbox.
                </p>
              </div>
              <Button asChild size="sm" variant="outline" className="border-amber-500/50">
                <Link to="/profiles">Reconnect</Link>
              </Button>
            </div>
          )}
          {selectedAccountId && (
            <div className="border rounded-lg overflow-hidden flex h-[600px]">
              <div className="w-80 border-r shrink-0">
                <ConversationList
                  conversations={conversations}
                  selectedId={selectedConversation?.id || null}
                  onSelect={setSelectedConversation}
                  isLoading={convsLoading}
                />
              </div>
              <div className="flex-1">
                <ConversationDetail
                  conversation={selectedConversation}
                  socialAccountId={selectedAccountId}
                  pageId={pageId}
                />
              </div>
            </div>
          )}
        </TabsContent>
      </Tabs>
    </div>
  );
}
