import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { CheckSquare, Download, Loader2, Plus, X } from "lucide-react";
import { useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { WhatsAppExportDialog } from "./WhatsAppExportDialog";
import { WhatsAppInboxApiProvider } from "./WhatsAppInboxApiProvider";

export function WhatsAppInboxScreen(): JSX.Element {
  const api = useMemo(() => createWhatsAppInboxApi(), []);
  const { accounts, isLoading: accountsLoading } = useMessagingAccounts();
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [selectedConversation, setSelectedConversation] = useState<Conversation | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [newConversationOpen, setNewConversationOpen] = useState(false);
  const [labelFilter, setLabelFilter] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [exportOpen, setExportOpen] = useState(false);
  const [visibleConversations, setVisibleConversations] = useState<Conversation[]>([]);
  const ignoredRouteChatIdRef = useRef<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState(false);
  const queryClient = useQueryClient();
  const { assignments } = useWhatsAppLabels();
  const { setCompact } = useWhatsAppChrome();
  // The list search is server-side (name or phone digits); typing is debounced so a
  // ten-character query costs one request rather than ten.
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  const { data: conversations = [], isLoading: conversationsLoading } = useConversations(
    selectedAccountId,
    "WHATSAPP",
    { search: debouncedSearch },
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

  const confirmDelete = async () => {
    if (!deleteTarget || !selectedAccountId) return;
    setDeleting(true);
    try {
      await api.deleteConversation({ social_account_id: selectedAccountId, conversation_id: deleteTarget.id });
      if (selectedConversation?.id === deleteTarget.id) selectConversation(null);
      await queryClient.invalidateQueries({ queryKey: ["messaging-conversations", selectedAccountId] });
      toast.success("Chat deleted");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not delete chat");
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
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

  // Forward targets are the chats the list already knows about, one entry per number.
  const forwardTargets = useMemo(() => {
    const byPhone = new Map<string, { phone: string; label: string }>();
    for (const conversation of conversations) {
      if (!byPhone.has(conversation.participant_id)) {
        byPhone.set(conversation.participant_id, {
          phone: conversation.participant_id,
          label: conversation.participant_name,
        });
      }
    }
    return [...byPhone.values()];
  }, [conversations]);

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
                <div className="flex shrink-0 items-center gap-2">
                  {selectionMode ? (
                    <>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setSelectedIds(new Set(visibleConversations.map((c) => c.id)))}
                        className="gap-1.5"
                      >
                        <CheckSquare className="h-4 w-4" />
                        Select all
                      </Button>
                      <Button
                        size="sm"
                        onClick={() => setExportOpen(true)}
                        disabled={selectedIds.size === 0}
                        className="gap-1.5"
                      >
                        <Download className="h-4 w-4" />
                        Export{selectedIds.size > 0 ? ` (${selectedIds.size})` : ""}
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        aria-label="Leave selection mode"
                        onClick={() => { setSelectionMode(false); setSelectedIds(new Set()); }}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button size="sm" variant="outline" onClick={() => setSelectionMode(true)} className="gap-1.5">
                        <CheckSquare className="h-4 w-4" />
                        Select
                      </Button>
                      <Button size="sm" onClick={() => setNewConversationOpen(true)} className="gap-1.5">
                        <Plus className="h-4 w-4" />
                        New Conversation
                      </Button>
                    </>
                  )}
                </div>
              </div>

              {selectedAccountId && (
                <>
                  <WhatsAppExportDialog
                    open={exportOpen}
                    onOpenChange={setExportOpen}
                    socialAccountId={selectedAccountId}
                    accountLabel={selectedAccount?.platform_username || selectedAccount?.platform_user_id || "WhatsApp"}
                    chats={conversations
                      .filter((conv) => selectedIds.has(conv.id))
                      .map((conv) => ({
                        conversationId: conv.id,
                        participantName: conv.participant_name,
                        participantPhone: conv.participant_id,
                      }))}
                  />
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
                          search={search}
                          onSearchChange={setSearch}
                          onDelete={setDeleteTarget}
                          absoluteTimes
                          showLabels
                          selectionMode={selectionMode}
                          selectedIds={selectedIds}
                          onToggleSelect={(conv) => setSelectedIds((prev) => {
                            const next = new Set(prev);
                            if (next.has(conv.id)) next.delete(conv.id);
                            else next.add(conv.id);
                            return next;
                          })}
                          onFilteredChange={setVisibleConversations}
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
                        forwardTargets={forwardTargets}
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

        <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => !open && !deleting && setDeleteTarget(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this chat?</AlertDialogTitle>
              <AlertDialogDescription>
                All messages in this chat are removed from Postora. Nothing is sent to WhatsApp and the
                contact is kept.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={deleting}
                onClick={(event) => {
                  event.preventDefault();
                  void confirmDelete();
                }}
              >
                Delete
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </WhatsAppMediaScope>
    </WhatsAppInboxApiProvider>
  );
}
