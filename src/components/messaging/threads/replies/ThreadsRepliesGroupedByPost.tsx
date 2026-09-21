import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FileText, Loader2, ExternalLink, AlertCircle } from "lucide-react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ThreadsConversationTimeline } from "./ThreadsConversationTimeline";
import { ThreadsPostDetailsDialog } from "./ThreadsPostDetailsDialog";
import {
  useConversationsForMedia,
  useThreadPost,
  type ThreadsReply,
} from "@/hooks/useThreadsReplies";

interface Props {
  accountId: string | null;
  replies: ThreadsReply[];
  onReplyClick?: (reply: ThreadsReply) => void;
}

// 6 distinct semantic-token color frames; selected deterministically per postId.
const FRAME_STYLES = [
  "border-l-primary bg-primary/5",
  "border-l-accent bg-accent/10",
  "border-l-secondary bg-secondary/30",
  "border-l-destructive bg-destructive/5",
  "border-l-[hsl(var(--chart-2))] bg-[hsl(var(--chart-2))]/10",
  "border-l-[hsl(var(--chart-4))] bg-[hsl(var(--chart-4))]/10",
];

function hashIndex(key: string, mod: number) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return h % mod;
}

function discoverPostIds(replies: ThreadsReply[]) {
  const order: string[] = [];
  const seen = new Set<string>();
  const myByPost = new Map<string, ThreadsReply[]>();
  for (const r of replies) {
    const postId = r.root_post?.id || r.replied_to?.id || r.id;
    if (!seen.has(postId)) {
      seen.add(postId);
      order.push(postId);
    }
    const arr = myByPost.get(postId) || [];
    arr.push(r);
    myByPost.set(postId, arr);
  }
  return { postIds: order, myByPost };
}

export function ThreadsRepliesGroupedByPost({ accountId, replies, onReplyClick }: Props) {
  const { t } = useTranslation("threads");
  const { postIds, myByPost } = useMemo(() => discoverPostIds(replies), [replies]);
  const { byMediaId, errorsByMediaId, loadingByMediaId, refetch } =
    useConversationsForMedia(accountId, postIds);
  const [dialogPostId, setDialogPostId] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      {postIds.map((postId) => {
        const frame = FRAME_STYLES[hashIndex(postId, FRAME_STYLES.length)];
        const conversation = byMediaId[postId] || [];
        const isLoading = loadingByMediaId[postId];
        const error = errorsByMediaId[postId];
        const fallback = myByPost.get(postId) || [];
        return (
          <section
            key={postId}
            className={cn("rounded-lg border border-l-4 p-3 space-y-3", frame)}
          >
            <PostHeader
              accountId={accountId}
              postId={postId}
              totalCount={conversation.length}
              myCount={fallback.length}
              onDetails={() => setDialogPostId(postId)}
            />

            {isLoading ? (
              <div className="flex items-center gap-2 text-xs text-muted-foreground py-4">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("empty.loadingConversation", "Loading conversation…")}
              </div>
            ) : error ? (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5" />
                  {t("errors.conversationUnavailable", "Conversation unavailable. Showing your replies only.")}
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs ml-auto"
                    onClick={() => refetch(postId)}
                  >
                    {t("common:retry", "Retry")}
                  </Button>
                </div>
                <ThreadsConversationTimeline
                  accountId={accountId}
                  replies={fallback}
                  onReplyClick={onReplyClick}
                />
              </div>
            ) : (
              <ThreadsConversationTimeline
                accountId={accountId}
                replies={conversation}
                onReplyClick={onReplyClick}
              />
            )}
          </section>
        );
      })}

      <ThreadsPostDetailsDialog
        accountId={accountId}
        postId={dialogPostId}
        open={!!dialogPostId}
        onOpenChange={(o) => !o && setDialogPostId(null)}
      />
    </div>
  );
}

interface PostHeaderProps {
  accountId: string | null;
  postId: string;
  totalCount: number;
  myCount: number;
  onDetails: () => void;
}

function PostHeader({ accountId, postId, totalCount, myCount, onDetails }: PostHeaderProps) {
  const { t } = useTranslation("threads");
  const { data: post } = useThreadPost(accountId, postId);
  const snippet = post?.text?.trim();
  const ts = post?.timestamp ? new Date(post.timestamp) : null;

  return (
    <header className="space-y-2">
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium line-clamp-2">
            {snippet || <span className="text-muted-foreground italic">{t("header.untitledPost", "Untitled post")}</span>}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-1 text-xs text-muted-foreground">
            {post?.username && <span>@{post.username}</span>}
            {ts && <span>{format(ts, "PPp")}</span>}
            <span>
              {totalCount === 1
                ? t("count.reply", "{{count}} reply", { count: totalCount })
                : t("count.replies", "{{count}} replies", { count: totalCount })}
              {myCount > 0 && (
                <> · {t("header.fromYou", "{{count}} from you", { count: myCount })}</>
              )}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {post?.permalink && (
            <Button asChild variant="ghost" size="sm" className="h-7 px-2 text-xs">
              <a href={post.permalink} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                {t("common:open", "Open")}
              </a>
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-7 px-2 text-xs"
            onClick={onDetails}
          >
            <FileText className="h-3.5 w-3.5 mr-1.5" />
            {t("actions.details", "Details")}
          </Button>
        </div>
      </div>
    </header>
  );
}
