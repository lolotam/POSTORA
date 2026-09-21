import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Facebook, Camera, MessageSquare, Loader2, Plus, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Link, useSearchParams } from "react-router-dom";
import { AccountSelector } from "./AccountSelector";
import { ConversationList } from "./ConversationList";
import { ConversationDetail } from "./ConversationDetail";
import { WhatsAppSetup } from "./WhatsAppSetup";
import { NewConversationDialog } from "./NewConversationDialog";
import { LabelFilter } from "./ConversationLabels";
import { useMessagingAccounts, useConversations } from "@/hooks/useMessaging";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { useWhatsAppLabels } from "@/hooks/useWhatsAppLabels";
import type { Conversation } from "@/hooks/useMessaging";
import { parseInboxRoute, withInboxRoute } from "@/lib/whatsappInboxRoute";

export type MessagingInboxPlatform = "facebook" | "instagram";

interface MessagingInboxProps {
  platform?: MessagingInboxPlatform;
}

type InboxTab = MessagingInboxPlatform | "whatsapp";

export function MessagingInbox({ platform }: MessagingInboxProps) {
  const { t } = useTranslation("inbox");
  const { flags } = useFeatureFlags();
  const { accounts, isLoading: accountsLoading } = useMessagingAccounts();
  const defaultTab: InboxTab = platform || (flags.msgFacebook ? "facebook" : flags.msgInstagram ? "instagram" : flags.msgWhatsapp ? "whatsapp" : "facebook");
  const [platformTab, setPlatformTab] = useState<InboxTab>(defaultTab);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);

  const [searchParams, setSearchParams] = useSearchParams();
  const [newConvOpen, setNewConvOpen] = useState(false);
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const { assignments } = useWhatsAppLabels();

  const messagingPlatform = platformTab === "facebook" ? "MESSENGER" : platformTab === "instagram" ? "INSTAGRAM" : "WHATSAPP";
  const { data: conversations = [], isLoading: convsLoading, error: convsError } = useConversations(selectedAccountId, messagingPlatform);
  const igMissingScope = platformTab === "instagram"
    && convsError instanceof Error
    && /instagram_manage_messages|instagram_business_manage_messages|MISSING_SCOPE|PERMISSION_ERROR|TOKEN_EXPIRED/i.test(convsError.message);

  const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
  const pageId = selectedAccount?.platform_user_id || "";

  useEffect(() => {
    const platformAccounts = accounts.filter((account) => account.platform === platformTab);
    if (platformAccounts.length === 0) return;
    const stillValid = selectedAccountId && platformAccounts.some((account) => account.id === selectedAccountId);
    if (!stillValid) {
      setSelectedAccountId(platformAccounts[0].id);
      setSelectedConversation(null);
    }
  }, [accounts, platformTab, selectedAccountId]);

  // Deep links carry messaging_cache.id (`chat`), which is stable, rather than the
  // external conversation string. Restoring from the URL is WhatsApp-only and
  // additive: Facebook and Instagram never publish a cache_id, so they are
  // untouched. An unknown or stale id deliberately selects NOTHING rather than
  // falling back to a neighbouring conversation, which would silently show the
  // wrong chat.
  const routeSelection = parseInboxRoute(searchParams);
  const routeChatId = routeSelection.conversationCacheId;

  useEffect(() => {
    if (platformTab !== "whatsapp" || !routeChatId) return;
    if (selectedConversation?.cache_id === routeChatId) return;
    const target = conversations.find((conv) => conv.cache_id === routeChatId);
    if (target) setSelectedConversation(target);
  }, [conversations, platformTab, routeChatId, selectedConversation]);

  const selectConversation = (conversation: Conversation | null) => {
    setSelectedConversation(conversation);
    if (platformTab !== "whatsapp") return;
    setSearchParams(
      withInboxRoute(searchParams, {
        accountId: selectedAccountId ?? undefined,
        conversationCacheId: conversation?.cache_id,
      }),
      { replace: true },
    );
  };

  const handleAccountChange = (id: string) => {
    setSelectedAccountId(id);
    selectConversation(null);
  };

  const handleTabChange = (tab: string) => {
    setPlatformTab(tab as InboxTab);
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
                {t("inbox.facebookMessenger", "Facebook Messenger")}
              </TabsTrigger>
            )}
            {flags.msgInstagram && (
              <TabsTrigger value="instagram" className="gap-1.5">
                <Camera className="w-4 h-4" />
                {t("inbox.instagramDms", "Instagram DMs")}
              </TabsTrigger>
            )}
            {flags.msgWhatsapp && (
              <TabsTrigger value="whatsapp" className="gap-1.5">
                <MessageSquare className="w-4 h-4" />
                {t("inbox.whatsappBusiness", "WhatsApp Business")}
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
                  {t("inbox.newConversation", "New Conversation")}
                </Button>
              </div>
              {selectedAccountId && (
                <>
                  <NewConversationDialog
                    open={newConvOpen}
                    onOpenChange={setNewConvOpen}
                    socialAccountId={selectedAccountId}
                    onSelectContact={selectConversation}
                  />
                  <div className="border border-border bg-card rounded-2xl shadow-sm overflow-hidden flex h-[620px]">
                    <div className="w-80 border-r border-border bg-card shrink-0 flex flex-col">
                      {platformTab === "whatsapp" && <LabelFilter selectedLabelId={labelFilter} onSelect={setLabelFilter} />}
                      <div className="flex-1 overflow-hidden">
                        <ConversationList
                          conversations={labelFilter ? conversations.filter(c => assignments.some(a => a.conversation_id === c.id && a.label_id === labelFilter)) : conversations}
                          selectedId={selectedConversation?.id || null}
                          onSelect={selectConversation}
                          isLoading={convsLoading}
                          showLabels={platformTab === "whatsapp"}
                        />
                      </div>
                    </div>
                    <div className="flex-1 bg-background">
                      <ConversationDetail
                        conversation={selectedConversation}
                        socialAccountId={selectedAccountId}
                        pageId={pageId}
                        platform="whatsapp"
                      />
                    </div>
                  </div>
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
            <div className="border border-border bg-card rounded-2xl shadow-sm overflow-hidden flex h-[620px]">
              <div className="w-80 border-r border-border bg-card shrink-0">
                <ConversationList
                  conversations={conversations}
                  selectedId={selectedConversation?.id || null}
                  onSelect={selectConversation}
                  isLoading={convsLoading}
                />
              </div>
              <div className="flex-1 bg-background">
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
                <p className="font-medium text-amber-700 dark:text-amber-300">{t("inbox.igNeedPermission", "Instagram DMs need an extra permission")}</p>
                <p className="text-amber-700/80 dark:text-amber-300/80 mt-0.5">
                  {t("inbox.igReconnect", "Reconnect your Instagram account and approve messaging permissions so we can load your inbox.")}
                </p>
              </div>
              <Button asChild size="sm" variant="outline" className="border-amber-500/50">
                <Link to="/profiles">{t("common:reconnect", "Reconnect")}</Link>
              </Button>
            </div>
          )}
          {selectedAccountId && (
            <div className="border border-border bg-card rounded-2xl shadow-sm overflow-hidden flex h-[620px]">
              <div className="w-80 border-r border-border bg-card shrink-0">
                <ConversationList
                  conversations={conversations}
                  selectedId={selectedConversation?.id || null}
                  onSelect={selectConversation}
                  isLoading={convsLoading}
                />
              </div>
              <div className="flex-1 bg-background">
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
