import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Send, Loader2, Heart, CornerDownRight } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { CommentActions } from "@/components/comments/CommentActions";
import { descendantCount, type CommentNode } from "@/components/comments/commentTree";
import { depthIndent, depthStyle } from "@/components/comments/commentDepth";

/** Lifted so only one composer is open at a time across the whole thread. */
export interface ReplyComposer {
  activeId: string | null;
  text: string;
  isPending: boolean;
  onToggle: (commentId: string) => void;
  onChange: (text: string) => void;
  onSubmit: (commentId: string) => void;
}

interface CommentRowProps {
  node: CommentNode;
  socialAccountId: string;
  composer: ReplyComposer;
}

function CommentHeader({ node }: { node: CommentNode }) {
  const { entry: comment, depth } = node;
  const style = depthStyle(depth);

  return (
    <div className="mb-1 flex flex-wrap items-center gap-2">
      {depth > 0 && <CornerDownRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />}
      <span className={cn("text-sm font-medium", style.name)}>{comment.author_name}</span>
      <span className="text-xs text-muted-foreground">
        {formatDistanceToNow(new Date(comment.created_time), { addSuffix: true })}
      </span>
      {comment.is_hidden && <Badge variant="secondary" className="text-xs">Hidden</Badge>}
      {comment.like_count != null && (
        <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
          <Heart className="h-3 w-3" />
          {comment.like_count}
        </span>
      )}
    </div>
  );
}

function ReplyBox({ authorName, composer, commentId }: {
  authorName: string;
  composer: ReplyComposer;
  commentId: string;
}) {
  return (
    <div className="mt-2 flex gap-2">
      <Textarea
        placeholder={`Reply to ${authorName}...`}
        value={composer.text}
        onChange={(e) => composer.onChange(e.target.value)}
        className="min-h-[60px] text-sm"
      />
      <Button
        size="icon"
        className="shrink-0"
        aria-label="Send reply"
        disabled={!composer.text.trim() || composer.isPending}
        onClick={() => composer.onSubmit(commentId)}
      >
        {composer.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
      </Button>
    </div>
  );
}

export function CommentRow({ node, socialAccountId, composer }: CommentRowProps) {
  const { entry: comment, depth } = node;
  const style = depthStyle(depth);

  return (
    <div style={{ marginInlineStart: depthIndent(depth) }}>
      <div
        className={cn(
          "flex gap-2 rounded-md",
          depth > 0 && ["ps-1.5", style.tint],
          comment.is_hidden && "opacity-60",
        )}
      >
        {depth > 0 && <span className={cn("w-1 shrink-0 rounded-full", style.rail)} aria-hidden />}

        <div className="min-w-0 flex-1 py-1.5">
          <div className="flex items-start justify-between gap-2">
            <div className="flex min-w-0 flex-1 items-start gap-2.5">
              <Avatar className="h-8 w-8 shrink-0">
                <AvatarImage src={comment.author_avatar || undefined} alt={comment.author_name} />
                <AvatarFallback className="bg-primary/10 text-xs font-semibold text-primary">
                  {comment.author_name?.charAt(0)?.toUpperCase() || "?"}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <CommentHeader node={node} />
                <p className="text-sm">{comment.message}</p>
              </div>
            </div>

            <CommentActions
              comment={comment}
              socialAccountId={socialAccountId}
              replyCount={descendantCount(node)}
              onReply={() => composer.onToggle(comment.id)}
            />
          </div>

          {composer.activeId === comment.id && (
            <ReplyBox authorName={comment.author_name} composer={composer} commentId={comment.id} />
          )}
        </div>
      </div>
    </div>
  );
}
