import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { AccountSelector } from "@/components/messaging/AccountSelector";
import { LabelFilter } from "@/components/messaging/ConversationLabels";
import { ConversationList } from "@/components/messaging/ConversationList";
import { NewConversationDialog } from "@/components/messaging/NewConversationDialog";
import { Button } from "@/components/ui/button";
import { useWhatsAppChrome } from "@/components/whatsapp/WhatsAppChromeContext";
import { useConversations, useMessagingAccounts, type Conversation } from "@/hooks/useMessaging";
import { useWhatsAppLabels } from "@/hooks/useWhatsAppLabels";
import { cn } from "@/lib/utils";
import { parseInboxRoute, withInboxRoute } from "@/lib/whatsappInboxRoute";
import { WhatsAppMediaScope } from "../application/useWhatsAppMedia";
import { createWhatsAppInboxApi } from "../infrastructure/whatsappInboxApi";
import { WhatsAppConnectionStatusChip } from "./WhatsAppConnectionStatusChip";
import { WhatsAppConversationPane } from "./WhatsAppConversationPane";
import { WhatsAppInboxApiProvider } from "./WhatsAppInboxApiProvider";

export function WhatsAppInboxScreen(): JSX.Element {
  const api = useMemo(() => createWhatsAppInboxApi(), []);
  const { accounts, isLoading: accountsLoading } = useMessagingAccounts();
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const ignoredRouteChatIdRef = useRef<string | null>(null);
  const { assignments } = useWhatsAppLabels();
  const { setCompact } = useWhatsAppChrome();
  const { data: conversations = [], isLoading: conversationsLoading } = useConversations(
    selectedAccountId,
    "WHATSAPP",
  );

  const whatsappAccounts = useMemo(
    () => accounts.filter((account) => account.platform === "whatsapp"),
    [accounts],
  );
  const selectedAccount = accounts.find((account) => account.id === selectedAccountId);
  const pageId = selectedAccount?.platform_user_id || "";

  useEffect(() => {
    if (whatsappAccounts.length === 0) return;
    const stillValid = selectedAccountId && whatsappAccounts.some((account) => account.id === selectedAccountId);
    if (!stillValid) {
      setSelectedAccountId(whatsappAccounts[0].id);
      setSelectedConversation(null);
    }
  }, [selectedAccountId, whatsappAccounts]);

  // Deep links carry messaging_cache.id (`chat`), which is stable, rather than the
  // external conversation string. An unknown or stale id deliberately selects NOTHING
  // rather than falling back to a neighbouring conversation and showing the wrong chat.
  const routeSelection = parseInboxRoute(searchParams);
  const routeChatId = routeSelection.conversationCacheId;

  useEffect(() => {
    if (!routeChatId) return;
    if (ignoredRouteChatIdRef.current === routeChatId) return;
    if (selectedConversation?.cache_id === routeChatId) return;
    const target = conversations.find((conversation) => conversation.cache_id === routeChatId);
    if (target) setSelectedConversation(target);
  }, [conversations, routeChatId, selectedConversation]);

  const selectConversation = (conversation: Conversation | null) => {
    // React Router and local state settle in separate renders. Ignore the old URL selection
    // during an explicit deselection so mobile Back cannot reopen the chat it just closed.
    ignoredRouteChatIdRef.current = conversation ? null : routeChatId ?? null;
    setSelectedConversation(conversation);
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

  if (accountsLoading) {
    return (
      <WhatsAppInboxApiProvider api={api}>
        <div className="flex h-full min-h-0 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      </WhatsAppInboxApiProvider>
    );
  }

  const filteredConversations = labelFilter
    ? conversations.filter((conversation) => assignments.some(
        (assignment) => assignment.conversation_id === conversation.id && assignment.label_id === labelFilter,
      ))
    : conversations;

  return (
    <WhatsAppInboxApiProvider api={api}>
      <WhatsAppMediaScope
        key={`${selectedAccountId ?? "none"}:${selectedConversation?.id ?? ""}`}
        socialAccountId={selectedAccountId}
      >
        <div data-testid="wa-inbox-shell" className="flex h-full min-h-0 flex-col overflow-hidden">
          <WhatsAppConnectionStatusChip
            connectedAccounts={accounts}
            selectedAccountId={selectedAccountId}
          />

          {whatsappAccounts.length > 0 && (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex min-h-0 shrink-0 items-center justify-between gap-3 border-b p-3">
                <AccountSelector
                  accounts={accounts}
                  selectedId={selectedAccountId}
                  onSelect={handleAccountChange}
                  platformFilter="whatsapp"
                />
                <Button size="sm" onClick={() => setNewConversationOpen(true)} className="shrink-0 gap-1.5">
                  <Plus className="h-4 w-4" />
                  New Conversation
                </Button>
              </div>

              {selectedAccountId && (
                <>
                  <NewConversationDialog
                    open={newConversationOpen}
                    onOpenChange={setNewConversationOpen}
                    socialAccountId={selectedAccountId}
                    onSelectContact={selectConversation}
                  />
                  <div className="flex min-h-0 flex-1 overflow-hidden">
                    <aside
                      data-testid="wa-conversation-list"
                      className={cn(
                        "min-h-0 w-full shrink-0 flex-col border-r lg:w-80",
                        selectedConversation ? "hidden lg:flex" : "flex",
                      )}
                    >
                      <div className="min-h-0 shrink-0 pt-2">
                        <LabelFilter selectedLabelId={labelFilter} onSelect={setLabelFilter} />
                      </div>
                      <div className="min-h-0 flex-1 overflow-hidden">
                        <ConversationList
                          conversations={filteredConversations}
                          selectedId={selectedConversation?.id || null}
                          onSelect={selectConversation}
                          isLoading={conversationsLoading}
                          showLabels
                        />
                      </div>
                    </aside>

                    <section
                      className={cn(
                        "min-h-0 min-w-0 flex-1 flex-col",
                        selectedConversation ? "flex" : "hidden lg:flex",
                      )}
                    >
                      <WhatsAppConversationPane
                        conversation={selectedConversation}
                        socialAccountId={selectedAccountId}
                        pageId={pageId}
                        connectionMode={selectedAccount?.connection_mode ?? null}
                        onScrollStateChange={setCompact}
                        onBack={() => selectConversation(null)}
                      />
                    </section>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </WhatsAppMediaScope>
    </WhatsAppInboxApiProvider>
  );
}
