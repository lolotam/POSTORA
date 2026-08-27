import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { MessageSquare, MessagesSquare, User, Clock, Gauge } from "lucide-react";
import { ThreadsThreadPicker } from "./ThreadsThreadPicker";
import { ThreadsReplyList } from "./ThreadsReplyList";
import { ThreadsConversationTimeline } from "./ThreadsConversationTimeline";
import { ThreadsReplyComposerDialog } from "./ThreadsReplyComposerDialog";
import { ThreadsReplyQuotaCard } from "./ThreadsReplyQuotaCard";
import { ThreadsRepliesPermissionAlert } from "./ThreadsRepliesPermissionAlert";
import { ThreadsRepliesGroupedByPost } from "./ThreadsRepliesGroupedByPost";
import { ThreadsAuthorAvatarProvider } from "@/components/messaging/threads/ThreadsAuthorAvatarContext";
import {
  ThreadsRepliesFilterBar,
  applyReplyFilters,
  defaultReplyFilters,
  type ReplyFilters,
} from "./ThreadsRepliesFilterBar";
import {
  useThreadReplies,
  useThreadConversation,
  useUserReplies,
  usePendingReplies,
  useReplyCapability,
  useClearRepliesOnSignout,
  type ThreadSummary,
  type ThreadsReply,
} from "@/hooks/useThreadsReplies";

interface Props {
  accountId: string | null;
}

export function ThreadsRepliesTab({ accountId }: Props) {
  useClearRepliesOnSignout();
  const [selectedThread, setSelectedThread] = useState<ThreadSummary | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [replyTarget, setReplyTarget] = useState<ThreadsReply | null>(null);
  const [myReplyFilters, setMyReplyFilters] = useState<ReplyFilters>(defaultReplyFilters);

  const capability = useReplyCapability(accountId);

  const mediaId = selectedThread?.id ?? null;

  const topLevel = useThreadReplies(accountId, mediaId);
  const conversation = useThreadConversation(accountId, mediaId);
  const myReplies = useUserReplies(accountId);
  const pending = usePendingReplies(accountId);

  const filteredMyReplies = useMemo(
    () => applyReplyFilters(myReplies.data || [], myReplyFilters),
    [myReplies.data, myReplyFilters],
  );

  const handleReplyClick = (reply: ThreadsReply) => {
    setReplyTarget(reply);
    setComposerOpen(true);
  };

  const handleReplyToThread = () => {
    if (!selectedThread) return;
    setReplyTarget({
      id: selectedThread.id,
      text: selectedThread.text,
      username: null,
    } as ThreadsReply);
    setComposerOpen(true);
  };

  // Capability gate
  if (capability.data && !capability.data.ok && capability.data.needsReconnect) {
    return <ThreadsRepliesPermissionAlert reason={capability.data.reason} />;
  }

  return (
    <ThreadsAuthorAvatarProvider accountId={accountId}>
    <div className="space-y-4">
      {/* Thread picker */}
      <Card>
        <CardContent className="p-4 flex flex-wrap items-center gap-3">
          <ThreadsThreadPicker
            accountId={accountId}
            value={selectedThread}
            onChange={setSelectedThread}
          />
          {selectedThread && (
            <button
              type="button"
              onClick={handleReplyToThread}
              className="text-sm text-primary hover:underline"
            >
              Reply to this thread
            </button>
          )}
        </CardContent>
      </Card>

      <Tabs defaultValue="top-level" className="w-full">
        <TabsList className="grid grid-cols-2 sm:grid-cols-5 w-full">
          <TabsTrigger value="top-level">
            <MessageSquare className="h-3.5 w-3.5 mr-1.5" />
            Top-level
          </TabsTrigger>
          <TabsTrigger value="conversation">
            <MessagesSquare className="h-3.5 w-3.5 mr-1.5" />
            Conversation
          </TabsTrigger>
          <TabsTrigger value="mine">
            <User className="h-3.5 w-3.5 mr-1.5" />
            My Replies
          </TabsTrigger>
          <TabsTrigger value="pending">
            <Clock className="h-3.5 w-3.5 mr-1.5" />
            Pending
          </TabsTrigger>
          <TabsTrigger value="quota">
            <Gauge className="h-3.5 w-3.5 mr-1.5" />
            Quota
          </TabsTrigger>
        </TabsList>

        <TabsContent value="top-level" className="mt-4">
          {!selectedThread ? (
            <Card>
              <CardContent className="p-8 text-center text-sm text-muted-foreground">
                Pick a thread above to see its replies.
              </CardContent>
            </Card>
          ) : (
            <ThreadsReplyList
              accountId={accountId}
              replies={topLevel.data || []}
              isLoading={topLevel.isLoading}
              error={topLevel.error}
              onRetry={() => topLevel.refetch()}
              onReplyClick={handleReplyClick}
              emptyTitle="No replies yet"
              emptyDescription="Be the first to reply on this thread."
            />
          )}
        </TabsContent>

        <TabsContent value="conversation" className="mt-4">
          {!selectedThread ? (
            <Card>
              <CardContent className="p-8 text-center text-sm text-muted-foreground">
                Pick a thread above to see the full conversation.
              </CardContent>
            </Card>
          ) : conversation.isLoading ? (
            <ThreadsReplyList
              accountId={accountId}
              replies={[]}
              isLoading={true}
            />
          ) : conversation.error ? (
            <ThreadsReplyList
              accountId={accountId}
              replies={[]}
              isLoading={false}
              error={conversation.error}
              onRetry={() => conversation.refetch()}
            />
          ) : (
            <ThreadsConversationTimeline
              accountId={accountId}
              replies={conversation.data || []}
              onReplyClick={handleReplyClick}
            />
          )}
        </TabsContent>

        <TabsContent value="mine" className="mt-4">
          <div className="space-y-3">
            <ThreadsRepliesFilterBar
              filters={myReplyFilters}
              onChange={setMyReplyFilters}
              total={myReplies.data?.length ?? 0}
              shown={filteredMyReplies.length}
            />
            {myReplies.isLoading || myReplies.error || filteredMyReplies.length === 0 ? (
              <ThreadsReplyList
                accountId={accountId}
                replies={filteredMyReplies}
                isLoading={myReplies.isLoading}
                error={myReplies.error}
                onRetry={() => myReplies.refetch()}
                onReplyClick={handleReplyClick}
                emptyTitle={
                  (myReplies.data?.length ?? 0) === 0
                    ? "You haven't replied to any threads yet"
                    : "No replies match your filters"
                }
                emptyDescription={
                  (myReplies.data?.length ?? 0) === 0
                    ? "Once you reply on a thread, it will appear here grouped by the original post."
                    : "Try adjusting or resetting the filters above."
                }
              />
            ) : (
              <ThreadsRepliesGroupedByPost
                accountId={accountId}
                replies={filteredMyReplies}
                onReplyClick={handleReplyClick}
              />
            )}
          </div>
        </TabsContent>

        <TabsContent value="pending" className="mt-4">
          <ThreadsReplyList
            accountId={accountId}
            replies={pending.data || []}
            isLoading={pending.isLoading}
            error={pending.error}
            onRetry={() => pending.refetch()}
            showApproval
            emptyTitle="No pending replies"
            emptyDescription="Replies awaiting your approval will appear here."
          />
        </TabsContent>

        <TabsContent value="quota" className="mt-4">
          <ThreadsReplyQuotaCard accountId={accountId} />
        </TabsContent>
      </Tabs>

      <ThreadsReplyComposerDialog
        accountId={accountId}
        open={composerOpen}
        onOpenChange={setComposerOpen}
        replyToId={replyTarget?.id ?? null}
        replyToPreview={replyTarget?.text ?? null}
        replyToUsername={replyTarget?.username ?? null}
      />
    </div>
    </ThreadsAuthorAvatarProvider>
  );
}